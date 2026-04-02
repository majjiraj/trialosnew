'use client'
import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { FileQuestion, CheckCircle, ChevronDown, RefreshCw, Sparkles, Tag, X } from 'lucide-react'
import { clsx } from 'clsx'
import { useOrgId, useAuth } from '@/components/layout/AuthContext'

interface PendingClassification {
  id: string
  document_id: string
  file_name: string
  file_size_bytes: number
  suggested_type_codes: string[]
  confidence_scores: Record<string, number>
  llm_analysis: string
  metadata_extracted: Record<string, string>
  created_at: string
}

const KNOWN_TYPES = [
  { code: 'protocol',     label: 'Clinical Study Protocol' },
  { code: 'sap',          label: 'Statistical Analysis Plan' },
  { code: 'crf',          label: 'Case Report Form' },
  { code: 'csr',          label: 'Clinical Study Report' },
  { code: 'sdtm_ig',      label: 'SDTM Implementation Guide' },
  { code: 'adam_ig',      label: 'ADaM Implementation Guide' },
  { code: 'lab_manual',   label: 'Laboratory Manual' },
  { code: 'dmp',          label: 'Data Management Plan' },
  { code: 'icf',          label: 'Informed Consent Form' },
  { code: 'lab_report',   label: 'Lab Report' },
  { code: 'study_budget', label: 'Study Budget' },
  { code: 'other',        label: 'Other / Unclassified' },
]

const CONTEXT_GRAPH_URL = process.env.NEXT_PUBLIC_CONTEXT_GRAPH_URL || 'http://localhost:8008'

export default function ClassifyDocumentsPage() {
  const orgId = useOrgId()
  const { user } = useAuth()
  const [pending, setPending] = useState<PendingClassification[]>([])
  const [loading, setLoading] = useState(true)
  const [resolving, setResolving] = useState<Record<string, boolean>>({})
  const [selectedTypes, setSelectedTypes] = useState<Record<string, string>>({})
  const [newTypeForms, setNewTypeForms] = useState<Record<string, boolean>>({})
  const [newTypeData, setNewTypeData] = useState<Record<string, { typeCode: string; typeName: string; description: string }>>({})

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch(`${CONTEXT_GRAPH_URL}/classify/pending?org_id=${orgId}`)
      if (res.ok) {
        const data = await res.json()
        setPending(data.pending || [])
      }
    } catch {
      toast.error('Failed to load pending classifications')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const resolve = async (classificationId: string, docId: string) => {
    const resolvedType = selectedTypes[classificationId] || 'other'
    setResolving(r => ({ ...r, [classificationId]: true }))
    try {
      const res = await fetch(`${CONTEXT_GRAPH_URL}/classify/${classificationId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved_type: resolvedType, resolved_by: user?.id ?? '00000000-0000-0000-0000-000000000002' }),
      })
      if (!res.ok) throw new Error('Failed to resolve')
      toast.success(`Document mapped to: ${resolvedType}`)
      setPending(p => p.filter(x => x.id !== classificationId))
    } catch {
      toast.error('Failed to resolve classification')
    } finally {
      setResolving(r => ({ ...r, [classificationId]: false }))
    }
  }

  const createAndResolve = async (classificationId: string) => {
    const nd = newTypeData[classificationId]
    if (!nd?.typeCode || !nd?.typeName) {
      toast.error('Type code and name are required')
      return
    }
    setResolving(r => ({ ...r, [classificationId]: true }))
    try {
      // Create the new document type
      const createRes = await fetch(`${CONTEXT_GRAPH_URL}/document-types`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type_code: nd.typeCode,
          type_name: nd.typeName,
          description: nd.description || '',
          org_id: orgId,
        }),
      })
      if (!createRes.ok) throw new Error('Failed to create document type')

      // Resolve the classification with the new type
      const res = await fetch(`${CONTEXT_GRAPH_URL}/classify/${classificationId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved_type: nd.typeCode, resolved_by: user?.id ?? '00000000-0000-0000-0000-000000000002' }),
      })
      if (!res.ok) throw new Error('Failed to resolve')
      toast.success(`New document type "${nd.typeName}" created and document mapped`)
      setPending(p => p.filter(x => x.id !== classificationId))
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setResolving(r => ({ ...r, [classificationId]: false }))
    }
  }

  const dismiss = async (classificationId: string) => {
    // Map to 'other' and dismiss
    await fetch(`${CONTEXT_GRAPH_URL}/classify/${classificationId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved_type: 'other', resolved_by: user?.id ?? '00000000-0000-0000-0000-000000000002' }),
    })
    setPending(p => p.filter(x => x.id !== classificationId))
    toast.success('Dismissed')
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Document Classification</h1>
          <p className="text-sm text-slate-500 mt-1">
            {pending.length} document{pending.length !== 1 ? 's' : ''} awaiting type mapping
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 px-3 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50"
        >
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {loading ? (
        <div className="card p-8 text-center text-slate-400 text-sm">Loading…</div>
      ) : pending.length === 0 ? (
        <div className="card p-12 text-center">
          <CheckCircle className="w-10 h-10 text-green-400 mx-auto mb-3" />
          <p className="text-slate-600 font-medium">All documents classified</p>
          <p className="text-slate-400 text-sm mt-1">No pending type assignments</p>
        </div>
      ) : (
        <div className="space-y-4">
          {pending.map(pc => {
            const topSuggestion = pc.suggested_type_codes?.[0]
            const topConfidence = topSuggestion ? (pc.confidence_scores?.[topSuggestion] || 0) : 0
            const showNewTypeForm = newTypeForms[pc.id]

            return (
              <div key={pc.id} className="card p-5 space-y-4">
                {/* Header */}
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div className="w-9 h-9 rounded-lg bg-amber-50 flex items-center justify-center flex-shrink-0">
                      <FileQuestion className="w-5 h-5 text-amber-500" />
                    </div>
                    <div>
                      <p className="font-medium text-slate-900 text-sm">{pc.file_name}</p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {pc.file_size_bytes ? `${(pc.file_size_bytes / 1024).toFixed(1)} KB · ` : ''}
                        Uploaded {new Date(pc.created_at).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => dismiss(pc.id)}
                    className="text-slate-300 hover:text-slate-500 flex-shrink-0"
                    title="Dismiss"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* LLM Analysis */}
                {pc.llm_analysis && (
                  <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-100 rounded-lg">
                    <Sparkles className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-blue-700">{pc.llm_analysis}</p>
                  </div>
                )}

                {/* Extracted metadata */}
                {Object.keys(pc.metadata_extracted || {}).length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(pc.metadata_extracted)
                      .filter(([, v]) => v)
                      .slice(0, 6)
                      .map(([k, v]) => (
                        <span key={k} className="flex items-center gap-1 px-2 py-0.5 bg-slate-100 rounded text-xs text-slate-600">
                          <Tag className="w-3 h-3 text-slate-400" />
                          <span className="font-medium">{k}:</span> {String(v).slice(0, 40)}
                        </span>
                      ))}
                  </div>
                )}

                {/* Suggestions */}
                <div>
                  <p className="text-xs font-medium text-slate-600 mb-2">AI Suggestions</p>
                  <div className="flex flex-wrap gap-2">
                    {(pc.suggested_type_codes || []).slice(0, 4).map(code => {
                      const conf = pc.confidence_scores?.[code] || 0
                      const label = KNOWN_TYPES.find(t => t.code === code)?.label || code
                      return (
                        <button
                          key={code}
                          onClick={() => setSelectedTypes(s => ({ ...s, [pc.id]: code }))}
                          className={clsx(
                            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors',
                            selectedTypes[pc.id] === code
                              ? 'border-brand-500 bg-brand-50 text-brand-700'
                              : 'border-slate-200 text-slate-600 hover:border-slate-300',
                          )}
                        >
                          {label}
                          <span className={clsx(
                            'px-1.5 py-0.5 rounded text-[10px] font-semibold',
                            conf >= 0.7 ? 'bg-green-100 text-green-700' :
                            conf >= 0.4 ? 'bg-amber-100 text-amber-700' :
                            'bg-slate-100 text-slate-500',
                          )}>
                            {Math.round(conf * 100)}%
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* Manual type picker */}
                <div className="flex items-center gap-3">
                  <div className="relative flex-1">
                    <select
                      value={selectedTypes[pc.id] || topSuggestion || ''}
                      onChange={e => setSelectedTypes(s => ({ ...s, [pc.id]: e.target.value }))}
                      className="w-full appearance-none pl-3 pr-8 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                    >
                      <option value="">Select document type…</option>
                      {KNOWN_TYPES.map(t => (
                        <option key={t.code} value={t.code}>{t.label}</option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-2.5 top-2.5 w-4 h-4 text-slate-400 pointer-events-none" />
                  </div>

                  <button
                    onClick={() => resolve(pc.id, pc.document_id)}
                    disabled={resolving[pc.id] || !selectedTypes[pc.id]}
                    className="px-4 py-2 text-sm font-medium bg-brand-500 hover:bg-brand-600 text-white rounded-lg disabled:opacity-50 whitespace-nowrap"
                  >
                    {resolving[pc.id] ? 'Saving…' : 'Map to Type'}
                  </button>

                  <button
                    onClick={() => setNewTypeForms(f => ({ ...f, [pc.id]: !showNewTypeForm }))}
                    className="px-3 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 whitespace-nowrap"
                  >
                    + New Type
                  </button>
                </div>

                {/* New type form */}
                {showNewTypeForm && (
                  <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-3">
                    <p className="text-xs font-semibold text-slate-700">Define New Document Type</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">Type Code *</label>
                        <input
                          type="text"
                          placeholder="e.g. investigator_brochure"
                          value={newTypeData[pc.id]?.typeCode || ''}
                          onChange={e => setNewTypeData(d => ({
                            ...d, [pc.id]: { ...(d[pc.id] || {}), typeCode: e.target.value, typeName: d[pc.id]?.typeName || '', description: d[pc.id]?.description || '' }
                          }))}
                          className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">Type Name *</label>
                        <input
                          type="text"
                          placeholder="e.g. Investigator Brochure"
                          value={newTypeData[pc.id]?.typeName || ''}
                          onChange={e => setNewTypeData(d => ({
                            ...d, [pc.id]: { ...(d[pc.id] || {}), typeCode: d[pc.id]?.typeCode || '', typeName: e.target.value, description: d[pc.id]?.description || '' }
                          }))}
                          className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Description</label>
                      <input
                        type="text"
                        placeholder="Brief description of this document type"
                        value={newTypeData[pc.id]?.description || ''}
                        onChange={e => setNewTypeData(d => ({
                          ...d, [pc.id]: { ...(d[pc.id] || {}), typeCode: d[pc.id]?.typeCode || '', typeName: d[pc.id]?.typeName || '', description: e.target.value }
                        }))}
                        className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                      />
                    </div>
                    <button
                      onClick={() => createAndResolve(pc.id)}
                      disabled={resolving[pc.id]}
                      className="px-4 py-2 text-sm font-medium bg-green-600 hover:bg-green-700 text-white rounded-lg disabled:opacity-50"
                    >
                      {resolving[pc.id] ? 'Creating…' : 'Create Type & Map Document'}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
