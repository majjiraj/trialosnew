'use client'
import { Network, RefreshCw, Search, AlertTriangle } from 'lucide-react'
import { useEffect, useState } from 'react'

interface StudyDesign {
  study_id: string
  arms: any[]
  endpoints: any[]
  eligibility_criteria: any[]
  visits: any[]
  populations: any[]
  activities: any[]
}

interface StudyIssue {
  id: string
  issue_type: string
  severity: string
  status: string
  description: string
  created_at: string
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-100 text-red-700',
  major: 'bg-orange-100 text-orange-700',
  minor: 'bg-yellow-100 text-yellow-700',
  info: 'bg-blue-100 text-blue-700',
}

export default function StudyGraphPage() {
  const [studyId, setStudyId] = useState('')
  const [design, setDesign] = useState<StudyDesign | null>(null)
  const [issues, setIssues] = useState<StudyIssue[]>([])
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('arms')

  const studyGraphUrl = process.env.NEXT_PUBLIC_STUDY_GRAPH_URL || 'http://localhost:8013'

  const fetchDesign = async () => {
    if (!studyId.trim()) return
    try {
      setLoading(true)
      const [designRes, issuesRes] = await Promise.allSettled([
        fetch(`${studyGraphUrl}/study/${studyId}/design`),
        fetch(`${studyGraphUrl}/study/${studyId}/issues`),
      ])
      if (designRes.status === 'fulfilled' && designRes.value.ok) {
        setDesign(await designRes.value.json())
      }
      if (issuesRes.status === 'fulfilled' && issuesRes.value.ok) {
        const data = await issuesRes.value.json()
        setIssues(data.issues || [])
      }
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }

  useEffect(() => {
    const sid = typeof window !== 'undefined' ? localStorage.getItem('study_id') : ''
    if (sid) { setStudyId(sid); }
  }, [])

  const TABS = [
    { id: 'arms', label: 'Arms', data: design?.arms },
    { id: 'endpoints', label: 'Endpoints', data: design?.endpoints },
    { id: 'eligibility', label: 'Eligibility', data: design?.eligibility_criteria },
    { id: 'visits', label: 'Visits', data: design?.visits },
    { id: 'issues', label: `Issues (${issues.length})`, data: issues },
  ]

  const renderItem = (item: any, tab: string) => {
    if (!item) return null
    if (tab === 'issues') {
      return (
        <div key={item.id} className="flex items-start gap-3 p-3 bg-white border border-slate-200 rounded-lg">
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${SEVERITY_COLORS[item.severity] || 'bg-slate-100 text-slate-600'}`}>
            {item.severity}
          </span>
          <div>
            <p className="text-sm font-medium text-slate-800">{item.issue_type?.replace('_', ' ')}</p>
            <p className="text-xs text-slate-500 mt-0.5">{item.description}</p>
          </div>
          <span className={`ml-auto px-2 py-0.5 rounded text-xs ${item.status === 'open' ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-600'}`}>
            {item.status}
          </span>
        </div>
      )
    }
    const label = typeof item === 'string' ? item : (item.name || item.label || item.description || JSON.stringify(item).slice(0, 100))
    const type = typeof item === 'object' ? (item.type || item.element_type || item.classification || '') : ''
    return (
      <div key={label} className="p-3 bg-white border border-slate-200 rounded-lg">
        <p className="text-sm font-medium text-slate-800">{label}</p>
        {type && <p className="text-xs text-slate-500 mt-0.5">{type}</p>}
      </div>
    )
  }

  const activeTabData = TABS.find(t => t.id === activeTab)

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Network className="w-6 h-6 text-brand-600" />
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Study Design Graph</h1>
          <p className="text-sm text-slate-500">Explore arms, endpoints, eligibility, and protocol issues</p>
        </div>
      </div>

      <div className="flex gap-3 mb-6">
        <input
          className="flex-1 max-w-sm px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          placeholder="Study ID"
          value={studyId}
          onChange={e => setStudyId(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && fetchDesign()}
        />
        <button
          onClick={fetchDesign}
          disabled={loading || !studyId.trim()}
          className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50"
        >
          {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          Load Study
        </button>
        <a href="/portfolio" className="px-4 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 text-sm">
          Portfolio View
        </a>
      </div>

      {design ? (
        <>
          <div className="grid grid-cols-5 gap-3 mb-5">
            {[
              { label: 'Arms', count: design.arms?.length || 0 },
              { label: 'Endpoints', count: design.endpoints?.length || 0 },
              { label: 'Eligibility Criteria', count: design.eligibility_criteria?.length || 0 },
              { label: 'Visits', count: design.visits?.length || 0 },
              { label: 'Open Issues', count: issues.filter(i => i.status === 'open').length },
            ].map(m => (
              <div key={m.label} className="bg-white border border-slate-200 rounded-xl p-3 text-center">
                <p className="text-2xl font-bold text-slate-900">{m.count}</p>
                <p className="text-xs text-slate-500 mt-0.5">{m.label}</p>
              </div>
            ))}
          </div>

          <div className="flex gap-1 mb-4 bg-slate-100 rounded-xl p-1 w-fit">
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${activeTab === t.id ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-600 hover:text-slate-800'}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {(activeTabData?.data || []).slice(0, 20).map((item: any, i: number) => (
              <div key={i}>{renderItem(item, activeTab)}</div>
            ))}
            {(!activeTabData?.data || activeTabData.data.length === 0) && (
              <div className="col-span-2 text-center py-8 text-slate-400">
                No {activeTab} found for this study
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="flex items-center justify-center h-64 bg-slate-50 border border-slate-200 rounded-xl">
          <p className="text-slate-400">Enter a Study ID to explore the design graph</p>
        </div>
      )}
    </div>
  )
}
