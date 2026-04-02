'use client'
import { useState } from 'react'
import { Search, Loader2, ChevronDown, ChevronRight, FileText, Link2, GitBranch } from 'lucide-react'
import { clsx } from 'clsx'

interface ContextSource {
  doc_name: string
  doc_type: string
  chunk_id: string
  score: number
  section?: string
  excerpt?: string
}

interface ContextResult {
  text: string
  score: number
  entity_type?: string
  entity_key?: string
  node_ids?: string[]
  lineage?: { from: string; to: string; edge: string; label: string }[]
}

interface QueryResponse {
  query: string
  results: ContextResult[]
  sources_cited: ContextSource[]
  search_method: string
}

const CONTEXT_GRAPH_URL = process.env.NEXT_PUBLIC_CONTEXT_GRAPH_URL || 'http://localhost:8008'

function SourceCard({ source }: { source: ContextSource }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border border-slate-100 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 bg-white hover:bg-slate-50 text-left"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
        <FileText className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
        <span className="text-sm text-slate-700 flex-1 truncate">{source.doc_name}</span>
        <span className="text-xs font-mono text-slate-400 flex-shrink-0">{source.doc_type}</span>
        <span className={clsx(
          'text-xs px-1.5 py-0.5 rounded font-semibold flex-shrink-0',
          source.score >= 0.7 ? 'bg-green-100 text-green-700' :
          source.score >= 0.4 ? 'bg-amber-100 text-amber-700' :
          'bg-slate-100 text-slate-500',
        )}>
          {Math.round(source.score * 100)}%
        </span>
      </button>
      {open && source.excerpt && (
        <div className="px-4 py-3 bg-slate-50 border-t border-slate-100">
          {source.section && <p className="text-xs text-blue-500 mb-1 font-medium">§ {source.section}</p>}
          <p className="text-xs text-slate-600 italic leading-relaxed">"{source.excerpt}"</p>
        </div>
      )}
    </div>
  )
}

export function ContextSearch({
  orgId,
  studyId,
  placeholder = 'Search the context graph…',
}: {
  orgId: string
  studyId?: string
  placeholder?: string
}) {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<QueryResponse | null>(null)
  const [includeLineage, setIncludeLineage] = useState(false)
  const [activeTab, setActiveTab] = useState<'context' | 'sources'>('context')

  const search = async () => {
    if (!query.trim()) return
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch(`${CONTEXT_GRAPH_URL}/context/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: query.trim(),
          org_id: orgId,
          study_id: studyId,
          top_k: 8,
          include_lineage: includeLineage,
        }),
      })
      if (!res.ok) throw new Error('Search failed')
      setResult(await res.json())
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Search bar */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && search()}
            placeholder={placeholder}
            className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeLineage}
            onChange={e => setIncludeLineage(e.target.checked)}
            className="rounded border-slate-300"
          />
          <GitBranch className="w-3 h-3" /> Lineage
        </label>
        <button
          onClick={search}
          disabled={loading || !query.trim()}
          className="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium rounded-lg disabled:opacity-50 flex items-center gap-2"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          Search
        </button>
      </div>

      {/* Results */}
      {result && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex gap-1">
              {(['context', 'sources'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={clsx(
                    'px-3 py-1.5 text-sm rounded-lg font-medium transition-colors',
                    activeTab === tab ? 'bg-brand-500 text-white' : 'text-slate-500 hover:bg-slate-100',
                  )}
                >
                  {tab === 'context' ? `Context (${result.results.length})` : `Sources (${result.sources_cited.length})`}
                </button>
              ))}
            </div>
            <span className="text-xs text-slate-400 flex items-center gap-1">
              <Link2 className="w-3 h-3" /> {result.search_method}
            </span>
          </div>

          {activeTab === 'context' && (
            <div className="space-y-2">
              {result.results.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-4">No context entries found</p>
              ) : (
                result.results.map((r, i) => (
                  <div key={i} className="p-3 bg-white border border-slate-200 rounded-lg">
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      {r.entity_type && (
                        <span className="text-[10px] px-2 py-0.5 bg-slate-100 text-slate-500 rounded-full uppercase tracking-wide font-medium flex-shrink-0">
                          {r.entity_type}
                        </span>
                      )}
                      <span className={clsx(
                        'text-xs px-1.5 py-0.5 rounded font-semibold ml-auto flex-shrink-0',
                        r.score >= 0.7 ? 'bg-green-100 text-green-700' :
                        r.score >= 0.4 ? 'bg-amber-100 text-amber-700' :
                        'bg-slate-100 text-slate-500',
                      )}>
                        {Math.round((r.score || 0) * 100)}%
                      </span>
                    </div>
                    <p className="text-sm text-slate-700 leading-relaxed">{r.text}</p>
                    {r.lineage && r.lineage.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-slate-100">
                        <p className="text-[10px] text-slate-400 font-medium mb-1">Lineage</p>
                        <div className="flex flex-wrap gap-1">
                          {r.lineage.slice(0, 3).map((l, li) => (
                            <span key={li} className="text-[10px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">
                              {l.label} ↔ {l.edge}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {activeTab === 'sources' && (
            <div className="space-y-1.5">
              {result.sources_cited.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-4">No sources cited</p>
              ) : (
                result.sources_cited.map((s, i) => <SourceCard key={i} source={s} />)
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
