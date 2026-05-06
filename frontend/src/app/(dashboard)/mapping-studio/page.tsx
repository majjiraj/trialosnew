'use client'
import { Map, RefreshCw, CheckCircle, XCircle, AlertTriangle, Play } from 'lucide-react'
import { useState } from 'react'

interface MappingRow {
  source_column: string
  sdtm_variable: string
  domain: string
  ct_codelist: string | null
  ct_valid: boolean
  method: 'deterministic' | 'llm_fallback'
  confidence: number
  sample_values?: string[]
}

export default function MappingStudioPage() {
  const [sourceColumns, setSourceColumns] = useState('')
  const [mappings, setMappings] = useState<MappingRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [studyId, setStudyId] = useState('')

  const runtimeUrl = process.env.NEXT_PUBLIC_AGENT_RUNTIME_URL || 'http://localhost:8004'

  const runMapping = async () => {
    const cols = sourceColumns.split(/[\n,]+/).map(s => s.trim()).filter(Boolean)
    if (!cols.length) return
    try {
      setLoading(true)
      setError(null)
      const orgId = typeof window !== 'undefined' ? (localStorage.getItem('org_id') || 'default-org') : 'default-org'
      const sid = studyId || (typeof window !== 'undefined' ? localStorage.getItem('study_id') : '') || ''
      const res = await fetch(`${runtimeUrl}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_slug: 'standards-mapping',
          org_id: orgId,
          study_id: sid,
          input_context: { source_columns: cols, trigger_type: 'manual_mapping' },
        }),
      })
      if (res.ok) {
        const data = await res.json()
        const outputMappings = data.output?.metadata?.mapping_table || []
        setMappings(outputMappings)
      } else {
        const err = await res.json()
        setError(err.detail || 'Mapping failed')
      }
    } catch (e: any) { setError(e.message) } finally { setLoading(false) }
  }

  const confidenceBadge = (conf: number) => {
    const color = conf >= 0.90 ? 'bg-green-100 text-green-700' : conf >= 0.70 ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'
    return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>{(conf * 100).toFixed(0)}%</span>
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Map className="w-6 h-6 text-brand-600" />
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Mapping Studio</h1>
          <p className="text-sm text-slate-500">Map source EDC columns to SDTM variables with CT validation</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6 mb-6">
        <div className="col-span-2 bg-white border border-slate-200 rounded-xl p-5">
          <label className="block text-sm font-medium text-slate-700 mb-2">Source Columns</label>
          <textarea
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-brand-500"
            rows={6}
            placeholder="Enter column names (one per line or comma-separated)&#10;e.g.:&#10;AETERM&#10;AESEV&#10;SEX&#10;RACE"
            value={sourceColumns}
            onChange={e => setSourceColumns(e.target.value)}
          />
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <label className="block text-sm font-medium text-slate-700 mb-2">Study ID (optional)</label>
          <input
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 mb-4"
            placeholder="study-id"
            value={studyId}
            onChange={e => setStudyId(e.target.value)}
          />
          <button
            onClick={runMapping}
            disabled={loading || !sourceColumns.trim()}
            className="w-full flex items-center justify-center gap-2 py-3 bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {loading ? 'Mapping...' : 'Run Mapping'}
          </button>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          <div className="mt-4 space-y-2 text-xs text-slate-500">
            <p className="font-medium text-slate-700">How it works:</p>
            <p>1. Deterministic rules checked first</p>
            <p>2. LLM fallback for unmatched columns</p>
            <p>3. CT validation per mapped variable</p>
            <p>4. Gold patterns stored for future runs</p>
          </div>
        </div>
      </div>

      {mappings.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
            <h2 className="font-semibold text-slate-800">Mapping Results — {mappings.length} columns</h2>
            <div className="flex gap-3 text-xs text-slate-500">
              <span className="flex items-center gap-1"><div className="w-2 h-2 bg-green-500 rounded-full" /> Deterministic</span>
              <span className="flex items-center gap-1"><div className="w-2 h-2 bg-blue-500 rounded-full" /> LLM Fallback</span>
            </div>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                {['Source Column', 'SDTM Variable', 'Domain', 'CT Codelist', 'CT Valid', 'Method', 'Confidence', 'Sample Values'].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left font-medium text-slate-600 text-xs">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {mappings.map((m, i) => (
                <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-mono font-semibold text-slate-800">{m.source_column}</td>
                  <td className="px-4 py-2.5 font-mono text-brand-700">{m.sdtm_variable}</td>
                  <td className="px-4 py-2.5">
                    <span className="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs rounded">{m.domain}</span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">{m.ct_codelist || '—'}</td>
                  <td className="px-4 py-2.5">
                    {m.ct_codelist ? (
                      m.ct_valid ? (
                        <CheckCircle className="w-4 h-4 text-green-500" />
                      ) : (
                        <XCircle className="w-4 h-4 text-red-500" />
                      )
                    ) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${m.method === 'deterministic' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                      {m.method === 'deterministic' ? 'Det.' : 'LLM'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">{confidenceBadge(m.confidence)}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">{(m.sample_values || []).slice(0, 2).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
