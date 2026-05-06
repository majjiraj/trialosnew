'use client'
import { BrainCircuit, Search, RefreshCw, Clock, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'

type MemoryTab = 'episodic' | 'semantic' | 'procedural' | 'learnings'
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

interface Memory {
  id: string
  episode_type?: string
  learning_type?: string
  task_type?: string
  scope?: string
  description?: string
  evidence?: any
  content: any
  importance?: number
  confidence?: number
  created_at: string
  access_count?: number
  is_active?: boolean
  subject?: string
  predicate?: string
  object?: string
}

const EPISODE_COLORS: Record<string, string> = {
  success: 'bg-green-100 text-green-700',
  failure: 'bg-red-100 text-red-700',
  partial: 'bg-yellow-100 text-yellow-700',
  hitl_correction: 'bg-purple-100 text-purple-700',
  novel_situation: 'bg-blue-100 text-blue-700',
}

const LEARNING_COLORS: Record<string, string> = {
  gold_pattern: 'bg-yellow-100 text-yellow-700',
  anti_pattern: 'bg-red-100 text-red-700',
  calibration: 'bg-blue-100 text-blue-700',
  edge_case: 'bg-orange-100 text-orange-700',
  preference: 'bg-purple-100 text-purple-700',
}

export default function MemoryPage() {
  const [tab, setTab] = useState<MemoryTab>('learnings')
  const [memories, setMemories] = useState<Memory[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [recallResults, setRecallResults] = useState<Memory[]>([])
  const [recalling, setRecalling] = useState(false)

  const baseUrl = process.env.NEXT_PUBLIC_MEMORY_ENGINE_URL || 'http://localhost:8014'

  const orgCandidates = () => {
    const localOrg = typeof window !== 'undefined' ? (localStorage.getItem('org_id') || '') : ''
    return Array.from(new Set([localOrg, NIL_UUID].filter(Boolean)))
  }

  const tabUrl = (currentTab: MemoryTab, orgId: string) => {
    if (currentTab === 'episodic') return `${baseUrl}/memory/episodic/all?org_id=${orgId}&limit=50`
    if (currentTab === 'semantic') return `${baseUrl}/memory/semantic/search?org_id=${orgId}&q=&top_k=50`
    if (currentTab === 'procedural') return `${baseUrl}/memory/procedural/all?org_id=${orgId}`
    return `${baseUrl}/learnings/search?q=&org_id=${orgId}&top_k=100`
  }

  const fetchMemories = async (currentTab: MemoryTab) => {
    try {
      setLoading(true)
      const all: Memory[] = []
      for (const orgId of orgCandidates()) {
        const res = await fetch(tabUrl(currentTab, orgId))
        if (!res.ok) continue
        const data = await res.json()
        const rows = (data.memories || data.learnings || data.results || data.procedures || []) as Memory[]
        all.push(...rows)
      }
      const deduped = Array.from(new Map(all.map(r => [r.id, r])).values())
      setMemories(deduped)
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }

  useEffect(() => { fetchMemories(tab) }, [tab])

  const recall = async () => {
    if (!query.trim()) return
    try {
      setRecalling(true)
      const orgId = typeof window !== 'undefined' ? (localStorage.getItem('org_id') || NIL_UUID) : NIL_UUID
      const res = await fetch(`${baseUrl}/recall/${encodeURIComponent(query)}?org_id=${orgId}&top_k=10`)
      if (res.ok) {
        const data = await res.json()
        setRecallResults(data.results || [])
      }
    } catch (e) { console.error(e) } finally { setRecalling(false) }
  }

  const TABS: { id: MemoryTab; label: string }[] = [
    { id: 'episodic', label: 'Episodic' },
    { id: 'semantic', label: 'Semantic' },
    { id: 'procedural', label: 'Procedural' },
    { id: 'learnings', label: 'Learnings' },
  ]

  const formatContent = (m: Memory) => {
    if (m.description) return m.description
    if (m.subject) return `${m.subject} → ${m.predicate} → ${m.object}`
    if (typeof m.content === 'string') return m.content.slice(0, 150)
    if (typeof m.content === 'object') {
      return Object.entries(m.content || {}).slice(0, 3).map(([k, v]) => `${k}: ${String(v).slice(0, 50)}`).join(' · ')
    }
    return '—'
  }

  const activeLearning = tab === 'learnings' ? memories[0] : null

  const renderLearningGraph = (m: Memory) => {
    const evidence = m.evidence || {}
    const hitl = evidence.hitl_feedback || {}
    const sections = Array.isArray(evidence.usdm_sections_used) ? evidence.usdm_sections_used.slice(0, 8) : []
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-4 mb-6">
        <p className="text-sm font-semibold text-slate-800 mb-3">Learning Graph (Protocol → USDM)</p>
        <div className="overflow-x-auto">
          <svg viewBox="0 0 980 220" className="w-full min-w-[760px] h-[220px]">
            <defs>
              <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <polygon points="0 0, 8 4, 0 8" fill="#94a3b8" />
              </marker>
            </defs>
            <line x1="130" y1="80" x2="300" y2="80" stroke="#94a3b8" strokeWidth="2" markerEnd="url(#arrow)" />
            <line x1="370" y1="80" x2="540" y2="80" stroke="#94a3b8" strokeWidth="2" markerEnd="url(#arrow)" />
            <line x1="610" y1="80" x2="780" y2="80" stroke="#94a3b8" strokeWidth="2" markerEnd="url(#arrow)" />
            <line x1="780" y1="110" x2="780" y2="170" stroke="#94a3b8" strokeWidth="2" markerEnd="url(#arrow)" />

            <rect x="20" y="46" width="110" height="68" rx="10" fill="#eff6ff" stroke="#bfdbfe" />
            <text x="75" y="70" textAnchor="middle" fontSize="12" fill="#1e3a8a">Tenant</text>
            <text x="75" y="90" textAnchor="middle" fontSize="11" fill="#334155">{String(evidence.tenant_id || 'N/A').slice(0, 12)}…</text>

            <rect x="300" y="46" width="110" height="68" rx="10" fill="#f0fdf4" stroke="#bbf7d0" />
            <text x="355" y="70" textAnchor="middle" fontSize="12" fill="#14532d">Study</text>
            <text x="355" y="90" textAnchor="middle" fontSize="11" fill="#334155">{String(evidence.study_name || evidence.study_id || 'N/A').slice(0, 16)}</text>

            <rect x="540" y="30" width="120" height="100" rx="10" fill="#fffbeb" stroke="#fde68a" />
            <text x="600" y="53" textAnchor="middle" fontSize="12" fill="#92400e">Protocol</text>
            <text x="600" y="71" textAnchor="middle" fontSize="11" fill="#334155">Date: {String(evidence.protocol_date || 'N/A').slice(0, 12)}</text>
            <text x="600" y="88" textAnchor="middle" fontSize="11" fill="#334155">Phase: {String(evidence.phase || 'N/A')}</text>
            <text x="600" y="105" textAnchor="middle" fontSize="11" fill="#334155">TA: {String(evidence.therapeutic_area || 'N/A')}</text>

            <rect x="780" y="46" width="140" height="68" rx="10" fill="#f5f3ff" stroke="#ddd6fe" />
            <text x="850" y="70" textAnchor="middle" fontSize="12" fill="#5b21b6">USDM Mapping</text>
            <text x="850" y="90" textAnchor="middle" fontSize="11" fill="#334155">sections: {sections.length || 'N/A'}</text>

            <rect x="710" y="170" width="210" height="40" rx="10" fill="#fff1f2" stroke="#fecdd3" />
            <text x="815" y="195" textAnchor="middle" fontSize="12" fill="#9f1239">HITL: {String(hitl.decision_status || 'approved')}</text>
          </svg>
        </div>

        <div className="mt-3 text-xs text-slate-600 grid grid-cols-1 md:grid-cols-2 gap-2">
          <p><span className="font-semibold">Protocol Source:</span> {evidence.protocol_file || 'N/A'}</p>
          <p><span className="font-semibold">Feedback Actor:</span> {hitl.decided_by || 'N/A'}</p>
          <p><span className="font-semibold">Corrections:</span> {Array.isArray(hitl.corrections) ? hitl.corrections.length : 0}</p>
          <p><span className="font-semibold">Conversion:</span> {evidence.protocol_to_usdm_mapping?.conversion_id || 'N/A'}</p>
        </div>

        {sections.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {sections.map((s: string, i: number) => (
              <span key={`${s}-${i}`} className="px-2 py-1 text-xs rounded-full bg-slate-100 text-slate-700">{s}</span>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <BrainCircuit className="w-6 h-6 text-brand-600" />
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Memory Explorer</h1>
          <p className="text-sm text-slate-500">Agent episodic, semantic, procedural memories and learnings</p>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4 mb-6">
        <p className="text-sm font-medium text-slate-700 mb-2">Semantic Recall</p>
        <div className="flex gap-3">
          <input
            className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            placeholder='e.g. "SDTM mapping errors", "AE severity validation"'
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && recall()}
          />
          <button
            onClick={recall}
            disabled={recalling}
            className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white text-sm rounded-lg hover:bg-brand-700 disabled:opacity-50"
          >
            {recalling ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            Recall
          </button>
        </div>
        {recallResults.length > 0 && (
          <div className="mt-3 space-y-2">
            {recallResults.slice(0, 5).map((r, i) => (
              <div key={i} className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg">
                <ChevronRight className="w-4 h-4 text-brand-500 mt-0.5 shrink-0" />
                <div className="flex-1">
                  <p className="text-sm text-slate-800">{formatContent(r)}</p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {r.confidence ? `confidence: ${(r.confidence * 100).toFixed(0)}%` : ''}
                    {r.importance ? ` · importance: ${r.importance.toFixed(2)}` : ''}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex gap-1 mb-5 bg-slate-100 rounded-xl p-1 w-fit">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm rounded-lg font-medium transition-colors ${tab === t.id ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-600 hover:text-slate-800'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><RefreshCw className="w-6 h-6 animate-spin text-brand-500" /></div>
      ) : (
        <div className="space-y-3">
          {tab === 'learnings' && activeLearning && renderLearningGraph(activeLearning)}
          {memories.length === 0 ? (
            <div className="text-center py-12 text-slate-400">No {tab} memories found</div>
          ) : memories.map(m => (
            <div key={m.id} className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3">
                  {(m.episode_type || m.learning_type) && (
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${EPISODE_COLORS[m.episode_type || ''] || LEARNING_COLORS[m.learning_type || ''] || 'bg-slate-100 text-slate-600'}`}>
                      {m.episode_type || m.learning_type || m.task_type}
                    </span>
                  )}
                  <p className="text-sm text-slate-700">{formatContent(m)}</p>
                </div>
                <div className="flex items-center gap-3 text-xs text-slate-400 shrink-0 ml-4">
                  {m.importance !== undefined && <span>imp: {m.importance.toFixed(2)}</span>}
                  {m.confidence !== undefined && <span>conf: {(m.confidence * 100).toFixed(0)}%</span>}
                  {m.access_count !== undefined && <span>{m.access_count} accesses</span>}
                  <span>{new Date(m.created_at).toLocaleDateString()}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
