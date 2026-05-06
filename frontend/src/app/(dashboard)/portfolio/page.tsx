'use client'
import { BarChart2, RefreshCw, AlertTriangle, TrendingUp } from 'lucide-react'
import { useEffect, useState } from 'react'

interface PortfolioAnalytics {
  total_studies: number
  studies_by_phase: Record<string, number>
  studies_by_status: Record<string, number>
  total_arms: number
  total_endpoints: number
  avg_eligibility_criteria: number
}

interface PortfolioRisk {
  study_id: string
  open_issues: number
  critical_issues: number
  risk_score: number
}

export default function PortfolioPage() {
  const [analytics, setAnalytics] = useState<PortfolioAnalytics | null>(null)
  const [risks, setRisks] = useState<PortfolioRisk[]>([])
  const [loading, setLoading] = useState(true)

  const studyGraphUrl = process.env.NEXT_PUBLIC_STUDY_GRAPH_URL || 'http://localhost:8013'

  const fetchData = async () => {
    try {
      setLoading(true)
      const orgId = typeof window !== 'undefined' ? (localStorage.getItem('org_id') || 'default-org') : 'default-org'
      const [analyticsRes, riskRes] = await Promise.allSettled([
        fetch(`${studyGraphUrl}/portfolio/analytics?org_id=${orgId}`),
        fetch(`${studyGraphUrl}/portfolio/risks?org_id=${orgId}`),
      ])
      if (analyticsRes.status === 'fulfilled' && analyticsRes.value.ok) {
        setAnalytics(await analyticsRes.value.json())
      }
      if (riskRes.status === 'fulfilled' && riskRes.value.ok) {
        const data = await riskRes.value.json()
        setRisks(data.risks || [])
      }
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }

  useEffect(() => { fetchData() }, [])

  const riskColor = (score: number) =>
    score >= 7 ? 'text-red-700 bg-red-50' : score >= 4 ? 'text-yellow-700 bg-yellow-50' : 'text-green-700 bg-green-50'

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <BarChart2 className="w-6 h-6 text-brand-600" />
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Portfolio Analytics</h1>
            <p className="text-sm text-slate-500">Cross-study analytics, risk roll-up, and trends</p>
          </div>
        </div>
        <button onClick={fetchData} className="flex items-center gap-2 px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg hover:bg-slate-50">
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><RefreshCw className="w-6 h-6 animate-spin text-brand-500" /></div>
      ) : analytics ? (
        <>
          <div className="grid grid-cols-4 gap-4 mb-6">
            {[
              { label: 'Total Studies', value: analytics.total_studies },
              { label: 'Total Arms', value: analytics.total_arms },
              { label: 'Total Endpoints', value: analytics.total_endpoints },
              { label: 'Avg Eligibility Criteria', value: analytics.avg_eligibility_criteria?.toFixed(1) || 0 },
            ].map(m => (
              <div key={m.label} className="bg-white border border-slate-200 rounded-xl p-4">
                <p className="text-xs text-slate-500">{m.label}</p>
                <p className="text-2xl font-bold text-slate-900 mt-1">{m.value}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-6 mb-6">
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <h2 className="font-semibold text-slate-800 mb-3">Studies by Phase</h2>
              <div className="space-y-2">
                {Object.entries(analytics.studies_by_phase || {}).map(([phase, count]) => (
                  <div key={phase} className="flex items-center gap-3">
                    <span className="text-sm text-slate-600 w-16">{phase}</span>
                    <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-brand-500 rounded-full"
                        style={{ width: `${Math.min((Number(count) / analytics.total_studies) * 100, 100)}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium text-slate-700 w-6 text-right">{count}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <h2 className="font-semibold text-slate-800 mb-3">Studies by Status</h2>
              <div className="space-y-2">
                {Object.entries(analytics.studies_by_status || {}).map(([status, count]) => (
                  <div key={status} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg">
                    <span className="text-sm capitalize text-slate-700">{status.replace('_', ' ')}</span>
                    <span className="font-semibold text-slate-900">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-8 text-center text-slate-400 mb-6">
          No portfolio analytics available
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-200 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-orange-500" />
          <h2 className="font-semibold text-slate-800">Risk Roll-up</h2>
        </div>
        {risks.length === 0 ? (
          <div className="text-center py-8 text-slate-400">No risk data available</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                {['Study ID', 'Open Issues', 'Critical', 'Risk Score'].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left font-medium text-slate-600 text-xs">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {risks.map(r => (
                <tr key={r.study_id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2.5">
                    <a href={`/study-graph?studyId=${r.study_id}`} className="font-mono text-brand-700 hover:underline text-xs">
                      {r.study_id.slice(0, 16)}...
                    </a>
                  </td>
                  <td className="px-4 py-2.5">{r.open_issues}</td>
                  <td className="px-4 py-2.5">
                    {r.critical_issues > 0 ? (
                      <span className="text-red-600 font-medium">{r.critical_issues}</span>
                    ) : '0'}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${riskColor(r.risk_score)}`}>
                      {r.risk_score.toFixed(1)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
