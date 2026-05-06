'use client'
import { Search, RefreshCw, CheckCircle, XCircle, ArrowRight, BookOpen, FlaskConical, Map } from 'lucide-react'
import { useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'

interface Codelist {
  id: string
  codelist_code: string
  codelist_name?: string
  name?: string
  version: string
  is_extensible: boolean
  terms: unknown
}

interface BiomedicalConceptMapping {
  concept_name: string
  codelist_code: string | null
  codelist_name: string | null
  version: string
  source: string
  is_auto: boolean
  metadata?: Record<string, unknown>
}

interface SectionMapping {
  section_id: string
  protocol_section: string
  usdm_ig_section: string
  ich_m11_section: string
  ct_codelists: string[]
  required_usdm_fields: string[]
  chunks_available: number
  status: 'ready' | 'no_chunks'
}

interface StandardsMappingResponse {
  protocol_doc_id: string
  total_chunks: number
  mapping: SectionMapping[]
}

type TermRow = { code: string; decode?: string; decoded_value?: string; preferred_term?: string }

function normalizeTerms(raw: unknown): TermRow[] {
  if (Array.isArray(raw)) return raw as TermRow[]
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as TermRow[]) : []
    } catch { return [] }
  }
  return []
}

type Tab = 'codelists' | 'biomedical' | 'section-mappings'

function TerminologyPageInner() {
  const searchParams = useSearchParams()
  const router = useRouter()

  const [activeTab, setActiveTab] = useState<Tab>(() =>
    searchParams.get('protocol_doc_id') ? 'section-mappings' : 'codelists'
  )
  const [codelists, setCodelists] = useState<Codelist[]>([])
  const [bcMappings, setBcMappings] = useState<BiomedicalConceptMapping[]>([])
  const [selected, setSelected] = useState<Codelist | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [bcInput, setBcInput] = useState('SALTScore')
  const [validateValue, setValidateValue] = useState('')
  const [validateResult, setValidateResult] = useState<{ valid: boolean; message: string } | null>(null)
  const [importing, setImporting] = useState(false)
  const [mappingBusy, setMappingBusy] = useState(false)

  // Section mappings tab state
  const [protocolDocId, setProtocolDocId] = useState(searchParams.get('protocol_doc_id') || '')
  const [mappingData, setMappingData] = useState<StandardsMappingResponse | null>(null)
  const [mappingLoading, setMappingLoading] = useState(false)
  const [mappingError, setMappingError] = useState('')

  const baseUrl = process.env.NEXT_PUBLIC_STANDARDS_REGISTRY_URL || 'http://localhost:8012'
  const agentRuntimeUrl = process.env.NEXT_PUBLIC_AGENT_RUNTIME_URL || 'http://localhost:8004'

  useEffect(() => {
    fetchCodelists()
    fetchBiomedicalMappings()
  }, [])

  useEffect(() => {
    const docId = searchParams.get('protocol_doc_id')
    if (docId) {
      setProtocolDocId(docId)
      setActiveTab('section-mappings')
      loadSectionMapping(docId)
    }
  }, [searchParams])

  const fetchCodelists = async () => {
    try {
      setLoading(true)
      const pageSize = 500
      let offset = 0
      let total = Number.POSITIVE_INFINITY
      const all: Codelist[] = []
      while (offset < total) {
        const res = await fetch(`${baseUrl}/terminology/codelists?limit=${pageSize}&offset=${offset}`)
        if (!res.ok) break
        const data = await res.json()
        const page = (data.codelists || []) as Codelist[]
        total = Number(data.total || page.length)
        all.push(...page)
        if (page.length === 0) break
        offset += page.length
      }
      setCodelists(all)
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }

  const fetchBiomedicalMappings = async () => {
    try {
      const res = await fetch(`${baseUrl}/terminology/biomedical-concepts?limit=500&offset=0`)
      if (!res.ok) return
      const data = await res.json()
      setBcMappings((data.mappings || []) as BiomedicalConceptMapping[])
    } catch (e) { console.error(e) }
  }

  const loadSectionMapping = async (docId: string) => {
    if (!docId.trim()) return
    setMappingLoading(true)
    setMappingError('')
    try {
      const res = await fetch(`${agentRuntimeUrl}/usdm/standards-mapping?protocol_doc_id=${encodeURIComponent(docId)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setMappingData(data as StandardsMappingResponse)
    } catch (e) {
      setMappingError(String(e))
    } finally {
      setMappingLoading(false)
    }
  }

  const resolveBiomedicalMappings = async () => {
    const conceptNames = bcInput.split(/[\n,]/).map(v => v.trim()).filter(Boolean)
    if (conceptNames.length === 0) return
    try {
      setMappingBusy(true)
      const res = await fetch(`${baseUrl}/terminology/biomedical-concepts/map`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ concepts: conceptNames.map(name => ({ concept_name: name })), persist: true }),
      })
      if (res.ok) await fetchBiomedicalMappings()
    } catch (e) { console.error(e) } finally { setMappingBusy(false) }
  }

  const validateTerm = async () => {
    if (!selected || !validateValue) return
    try {
      const res = await fetch(`${baseUrl}/terminology/codelists/${selected.codelist_code}/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: validateValue }),
      })
      const data = await res.json()
      setValidateResult({
        valid: data.valid,
        message: data.valid ? 'Valid term' : `Invalid. Valid values: ${(data.valid_values || []).slice(0, 5).join(', ')}`,
      })
    } catch (e) { console.error(e) }
  }

  const selectCodelist = async (codelistCode: string) => {
    try {
      const res = await fetch(`${baseUrl}/terminology/codelists/${codelistCode}`)
      if (res.ok) {
        const data = await res.json()
        setSelected(data)
        setValidateResult(null)
      }
    } catch (e) { console.error(e) }
  }

  const importLatestSdtm = async () => {
    try {
      setImporting(true)
      const res = await fetch(`${baseUrl}/terminology/import/sdtm`, { method: 'POST' })
      if (res.ok) await fetchCodelists()
    } catch (e) { console.error(e) } finally { setImporting(false) }
  }

  const filtered = codelists.filter(c =>
    search === '' ||
    c.codelist_code?.toLowerCase().includes(search.toLowerCase()) ||
    (c.codelist_name || c.name || '').toLowerCase().includes(search.toLowerCase())
  )

  const selectedTerms = normalizeTerms(selected?.terms)

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'codelists', label: 'Codelists', icon: <BookOpen className="w-4 h-4" /> },
    { id: 'biomedical', label: 'Biomedical Concepts', icon: <FlaskConical className="w-4 h-4" /> },
    { id: 'section-mappings', label: 'Protocol Section Mappings', icon: <Map className="w-4 h-4" /> },
  ]

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Controlled Terminology &amp; Standards</h1>
          <p className="text-sm text-slate-500">CDISC CT codelists, biomedical concepts, and protocol-to-standard section mappings</p>
        </div>
        {activeTab === 'codelists' && (
          <button
            onClick={importLatestSdtm}
            disabled={importing}
            className="ml-auto px-4 py-2 bg-brand-600 text-white text-sm rounded-lg hover:bg-brand-700 disabled:opacity-60 flex items-center gap-2"
          >
            {importing && <RefreshCw className="w-4 h-4 animate-spin" />}
            Import Latest SDTM Terminology
          </button>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 mb-6 bg-slate-100 p-1 rounded-xl w-fit">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Codelists tab */}
      {activeTab === 'codelists' && (
        <div className="grid grid-cols-3 gap-6">
          <div className="col-span-1">
            <div className="mb-3 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                placeholder="Search codelists..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            {loading ? (
              <div className="flex justify-center py-8"><RefreshCw className="w-5 h-5 animate-spin text-brand-500" /></div>
            ) : (
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden max-h-[600px] overflow-y-auto">
                {filtered.map(cl => (
                  <button
                    key={cl.id}
                    onClick={() => selectCodelist(cl.codelist_code)}
                    className={`w-full text-left px-4 py-3 border-b border-slate-100 hover:bg-slate-50 transition-colors ${selected?.id === cl.id ? 'bg-brand-50' : ''}`}
                  >
                    <p className="font-mono font-semibold text-brand-700 text-sm">{cl.codelist_code}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{cl.codelist_name || cl.name} · {cl.is_extensible ? 'Extensible' : 'Non-extensible'}</p>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="col-span-2">
            {selected ? (
              <div className="bg-white border border-slate-200 rounded-xl p-5">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">{selected.codelist_code}</h2>
                    <p className="text-sm text-slate-500">{selected.codelist_name || selected.name} · Version {selected.version}</p>
                  </div>
                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${selected.is_extensible ? 'bg-yellow-100 text-yellow-700' : 'bg-green-100 text-green-700'}`}>
                    {selected.is_extensible ? 'Extensible' : 'Non-extensible'}
                  </span>
                </div>
                <div className="mb-4 flex gap-2">
                  <input
                    className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                    placeholder="Validate a value..."
                    value={validateValue}
                    onChange={e => { setValidateValue(e.target.value); setValidateResult(null) }}
                  />
                  <button onClick={validateTerm} className="px-4 py-2 bg-brand-600 text-white text-sm rounded-lg hover:bg-brand-700">
                    Validate
                  </button>
                </div>
                {validateResult && (
                  <div className={`flex items-center gap-2 p-3 rounded-lg mb-4 text-sm ${validateResult.valid ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                    {validateResult.valid ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                    {validateResult.message}
                  </div>
                )}
                <table className="w-full text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-slate-600">Code</th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600">Decode</th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600">Preferred Term</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedTerms.map((t, i) => (
                      <tr key={i} className="border-t border-slate-100">
                        <td className="px-3 py-2 font-mono text-brand-700">{t.code}</td>
                        <td className="px-3 py-2 text-slate-800">{t.decode || t.decoded_value || '—'}</td>
                        <td className="px-3 py-2 text-slate-500">{t.preferred_term || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex items-center justify-center h-64 bg-slate-50 border border-slate-200 rounded-xl">
                <p className="text-slate-400">Select a codelist to explore terms</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Biomedical Concepts tab */}
      {activeTab === 'biomedical' && (
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Biomedical Concept Codelist Mapping</h2>
              <p className="text-sm text-slate-500">Canonical mapping from biomedical concept to CDISC CT codelist.</p>
            </div>
            <button
              onClick={resolveBiomedicalMappings}
              disabled={mappingBusy}
              className="px-4 py-2 bg-brand-600 text-white text-sm rounded-lg hover:bg-brand-700 disabled:opacity-60 flex items-center gap-2"
            >
              {mappingBusy && <RefreshCw className="w-4 h-4 animate-spin" />}
              Resolve from CDISC CT
            </button>
          </div>
          <textarea
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 mb-4"
            rows={3}
            placeholder="Enter biomedical concept names, comma or newline separated"
            value={bcInput}
            onChange={e => setBcInput(e.target.value)}
          />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Biomedical Concept</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">CDISC Codelist</th>
                  <th className="px-3 py-2 text-left font-medium text-slate-600">Source</th>
                </tr>
              </thead>
              <tbody>
                {bcMappings.map((row, i) => (
                  <tr key={`${row.concept_name}-${i}`} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-slate-800">{row.concept_name}</td>
                    <td className="px-3 py-2">
                      {row.codelist_code ? (
                        <button
                          onClick={() => { selectCodelist(row.codelist_code || ''); setActiveTab('codelists') }}
                          className="font-mono text-brand-700 hover:underline"
                        >
                          {row.codelist_code}
                        </button>
                      ) : (
                        <span className="text-slate-400">Unresolved</span>
                      )}
                      {row.codelist_name && <span className="ml-2 text-xs text-slate-500">{row.codelist_name}</span>}
                    </td>
                    <td className="px-3 py-2 text-slate-500">{row.source || 'cdisc_ct'}</td>
                  </tr>
                ))}
                {bcMappings.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-3 py-4 text-center text-slate-400">No biomedical concept mappings yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Protocol Section Mappings tab */}
      {activeTab === 'section-mappings' && (
        <div>
          <div className="bg-white border border-slate-200 rounded-xl p-5 mb-6">
            <h2 className="text-base font-semibold text-slate-900 mb-3">Pre-flight Standards Mapping</h2>
            <p className="text-sm text-slate-500 mb-4">
              Enter a Protocol Document ID to see how each section maps to the USDM IG, ICH M11, and CDISC CT codelists
              before starting a USDM conversion. All 13 sections must show <span className="text-green-600 font-medium">Ready</span> for a complete conversion.
            </p>
            <div className="flex gap-3">
              <input
                className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 font-mono"
                placeholder="Protocol Document ID (UUID)"
                value={protocolDocId}
                onChange={e => setProtocolDocId(e.target.value)}
              />
              <button
                onClick={() => loadSectionMapping(protocolDocId)}
                disabled={mappingLoading || !protocolDocId.trim()}
                className="px-4 py-2 bg-brand-600 text-white text-sm rounded-lg hover:bg-brand-700 disabled:opacity-60 flex items-center gap-2"
              >
                {mappingLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                Load Mapping
              </button>
            </div>
            {mappingError && (
              <p className="mt-3 text-sm text-red-600 flex items-center gap-2">
                <XCircle className="w-4 h-4" /> {mappingError}
              </p>
            )}
          </div>

          {mappingData && (
            <>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <p className="text-sm text-slate-600">
                    Protocol: <span className="font-mono text-slate-800">{mappingData.protocol_doc_id}</span>
                    <span className="ml-3 text-slate-400">·</span>
                    <span className="ml-3">{mappingData.total_chunks.toLocaleString()} total chunks</span>
                    <span className="ml-3 text-slate-400">·</span>
                    <span className={`ml-3 font-medium ${mappingData.mapping.every(m => m.status === 'ready') ? 'text-green-600' : 'text-amber-600'}`}>
                      {mappingData.mapping.filter(m => m.status === 'ready').length}/{mappingData.mapping.length} sections ready
                    </span>
                  </p>
                </div>
                <button
                  onClick={() => router.push(`/usdm/new?protocol_doc_id=${encodeURIComponent(mappingData.protocol_doc_id)}`)}
                  className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white text-sm rounded-lg hover:bg-brand-700"
                >
                  Start USDM Conversion <ArrowRight className="w-4 h-4" />
                </button>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium text-slate-600 w-[22%]">Protocol Section</th>
                      <th className="px-4 py-3 text-left font-medium text-slate-600 w-[18%]">USDM IG</th>
                      <th className="px-4 py-3 text-left font-medium text-slate-600 w-[18%]">ICH M11</th>
                      <th className="px-4 py-3 text-left font-medium text-slate-600 w-[18%]">CT Codelists</th>
                      <th className="px-4 py-3 text-left font-medium text-slate-600 w-[12%]">Chunks</th>
                      <th className="px-4 py-3 text-left font-medium text-slate-600 w-[12%]">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mappingData.mapping.map((row, i) => (
                      <tr key={row.section_id} className={`border-t border-slate-100 ${i % 2 === 0 ? '' : 'bg-slate-50/40'}`}>
                        <td className="px-4 py-3">
                          <p className="font-medium text-slate-800 leading-tight">{row.protocol_section}</p>
                          <p className="text-xs text-slate-400 mt-0.5 font-mono">{row.section_id}</p>
                        </td>
                        <td className="px-4 py-3 text-slate-600 text-xs leading-snug">{row.usdm_ig_section}</td>
                        <td className="px-4 py-3 text-slate-600 text-xs leading-snug">{row.ich_m11_section}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {row.ct_codelists.map(cl => (
                              <button
                                key={cl}
                                onClick={() => { selectCodelist(cl); setActiveTab('codelists') }}
                                className="px-1.5 py-0.5 bg-brand-50 text-brand-700 rounded text-xs font-mono hover:bg-brand-100"
                              >
                                {cl}
                              </button>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-slate-700 font-medium tabular-nums">{row.chunks_available}</td>
                        <td className="px-4 py-3">
                          {row.status === 'ready' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-green-50 text-green-700 text-xs font-medium">
                              <CheckCircle className="w-3 h-3" /> Ready
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-50 text-amber-700 text-xs font-medium">
                              <XCircle className="w-3 h-3" /> No chunks
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 p-4 bg-slate-50 border border-slate-200 rounded-xl">
                <p className="text-sm font-medium text-slate-700 mb-2">Required USDM fields by section</p>
                <div className="grid grid-cols-2 gap-3">
                  {mappingData.mapping.filter(m => m.required_usdm_fields.length > 0).map(row => (
                    <div key={row.section_id} className="text-xs">
                      <span className="font-medium text-slate-600">{row.protocol_section}: </span>
                      <span className="text-slate-500">{row.required_usdm_fields.join(', ')}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default function TerminologyPage() {
  return (
    <Suspense fallback={<div className="p-6 flex justify-center"><RefreshCw className="w-5 h-5 animate-spin text-brand-500" /></div>}>
      <TerminologyPageInner />
    </Suspense>
  )
}
