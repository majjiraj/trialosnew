'use client'
import { useState, useEffect } from 'react'
import { Search, FileText, Check } from 'lucide-react'

interface Document {
  id: string
  name: string
  document_type: string
  study_id?: string
  status: string
}

interface FileBrowseBlockProps {
  label: string
  orgId: string
  studyId?: string
  defaultStudyId?: string
}

const INGESTION_URL = process.env.NEXT_PUBLIC_INGESTION_URL || 'http://localhost:8003'

export default function FileBrowseBlock({ label, orgId, studyId, defaultStudyId }: FileBrowseBlockProps) {
  const [docs, setDocs] = useState<Document[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const effectiveStudyId = studyId || defaultStudyId

  useEffect(() => {
    const params = new URLSearchParams({ org_id: orgId })
    if (effectiveStudyId) params.set('study_id', effectiveStudyId)
    fetch(`${INGESTION_URL}/documents?${params}`)
      .then(r => r.json())
      .then(d => setDocs(Array.isArray(d) ? d : (d.documents || [])))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [orgId, effectiveStudyId])

  const filtered = docs.filter(d =>
    d.name?.toLowerCase().includes(search.toLowerCase()) ||
    d.document_type?.toLowerCase().includes(search.toLowerCase())
  )

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="border border-teal-200 rounded-xl p-4 bg-teal-50/30" style={{ borderLeftWidth: 4, borderLeftColor: '#14b8a6' }}>
      <h3 className="text-sm font-semibold text-teal-800 mb-3">{label}</h3>
      <p className="text-xs text-teal-600 mb-3">Browse and select study documents</p>

      <div className="relative mb-3">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search documents..."
          className="w-full pl-8 pr-3 py-1.5 border border-slate-200 rounded text-xs focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
        />
      </div>

      {loading ? (
        <div className="text-xs text-slate-400 py-4 text-center">Loading documents...</div>
      ) : filtered.length === 0 ? (
        <div className="text-xs text-slate-400 py-4 text-center">No documents found</div>
      ) : (
        <div className="max-h-48 overflow-y-auto space-y-1 mb-3">
          {filtered.map(doc => (
            <div
              key={doc.id}
              onClick={() => toggleSelect(doc.id)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer text-xs transition-colors ${
                selected.has(doc.id) ? 'bg-teal-100 border border-teal-300' : 'bg-white border border-slate-200 hover:border-teal-200'
              }`}
            >
              <div className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 ${selected.has(doc.id) ? 'bg-teal-500' : 'border border-slate-300'}`}>
                {selected.has(doc.id) && <Check className="w-3 h-3 text-white" />}
              </div>
              <FileText className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
              <span className="flex-1 truncate text-slate-700">{doc.name}</span>
              <span className="text-slate-400 flex-shrink-0">{doc.document_type}</span>
            </div>
          ))}
        </div>
      )}

      {selected.size > 0 && (
        <div className="flex flex-wrap gap-1">
          {Array.from(selected).map(id => {
            const doc = docs.find(d => d.id === id)
            return doc ? (
              <span key={id} className="flex items-center gap-1 px-2 py-0.5 bg-teal-100 text-teal-800 rounded-full text-xs">
                {doc.name}
                <button onClick={() => toggleSelect(id)} className="hover:text-teal-600 ml-0.5">×</button>
              </span>
            ) : null
          })}
        </div>
      )}
    </div>
  )
}
