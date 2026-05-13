'use client'
import { ClipboardCheck, RefreshCw, CheckCircle, XCircle, AlertTriangle, Play } from 'lucide-react'
import { useState } from 'react'

interface ComplianceScore {
  category: string
  score: number
}

interface ComplianceFinding {
  type: string
  rule_id: string
  level: string
  category: string
  authority?: string
  message: string
}

const CATEGORY_COLORS: Record<string, string> = {
  traceability: 'bg-blue-500',
  audit_trail: 'bg-purple-500',
  submission: 'bg-orange-500',
  gcp: 'bg-green-500',
}

export default function CompliancePage() {
  const [scores, setScores] = useState<ComplianceScore[]>([])
  const [findings, setFindings] = useState<ComplianceFinding[]>([])
  const [overallScore, setOverallScore] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [studyId, setStudyId] = useState('')
  const [error, setError] = useState<string | null>(null)

  const runtimeUrl = process.env.NEXT_PUBLIC_AGENT_RUNTIME_URL || 'http://localhost:8004'

  const runCompliance = async () => {
    try {
      setLoading(true)
      setError(null)
      const orgId = typeof window !== 'undefined' ? (localStorage.getItem('org_id') || 'default-org') : 'default-org'
      const sid = studyId || (typeof window !== 'undefined' ? localStorage.getItem('study_id') : '') || ''
      const res = await fetch(`${runtimeUrl}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_slug: 'compliance',
          org_id: orgId,
          study_id: sid,
          input_context: { trigger_type: 'manual_compliance_check' },
        }),
      })
      if (res.ok) {
        const data = await res.json()
        const meta = data.output?.metadata || {}
        setOverallScore(meta.overall_score)
        setFindings(data.output?.findings || [])
        const byCategory = meta.scores_by_category || {}
        setScores(Object.entries(byCategory).map(([category, score]) => ({
          category,
          score: Number(score),
        })))
      } else {
        const err = await res.json()
        setError(err.detail || 'Compliance check failed')
      }
    } catch (e: any) { setError(e.message) } finally { setLoading(false) }
  }

  const scoreColor = (score: number) =>
    score >= 80 ? 'text-green-700' : score >= 60 ? 'text-yellow-700' : 'text-red-700'

  const scoreBg = (score: number) =>
    score >= 80 ? 'bg-green-100' : score >= 60 ? 'bg-yellow-100' : 'bg-red-100'

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <ClipboardCheck className="w-6 h-6 text-brand-600" />
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Compliance</h1>
          <p className="text-sm text-slate-500">FDA/EMA/ICH/GCP regulatory compliance scoring</p>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-5 mb-6 flex items-end gap-4">
        <div className="flex-1 max-w-sm">
          <label className="block text-sm font-medium text-slate-700 mb-1">Study ID (optional)</label>
          <input
            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            placeholder="study-id"
            value={studyId}
            onChange={e => setStudyId(e.target.value)}
          />
        </div>
        <button
          onClick={runCompliance}
          disabled={loading}
          className="flex items-center gap-2 px-5 py-2.5 bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50"
        >
          {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          {loading ? 'Checking...' : 'Run Compliance Check'}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>

      {overallScore !== null && (
        <>
          <div className="flex items-center gap-6 mb-6">
            <div className={`${scoreBg(overallScore)} rounded-xl p-6 text-center min-w-[140px]`}>
              <p className={`text-4xl font-bold ${scoreColor(overallScore)}`}>{overallScore.toFixed(1)}%</p>
              <p className="text-sm text-slate-600 mt-1">Overall Score</p>
            </div>
            <div className="flex-1 grid grid-cols-2 gap-3">
              {scores.map(s => (
                <div key={s.category} className="bg-white border border-slate-200 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-slate-700 capitalize">{s.category.replace('_', ' ')}</span>
                    <span className={`font-bold ${scoreColor(s.score)}`}>{s.score.toFixed(1)}%</span>
                  </div>
                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${CATEGORY_COLORS[s.category] || 'bg-brand-500'}`}
                      style={{ width: `${s.score}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {findings.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <h2 className="font-semibold text-slate-800 mb-3">Findings</h2>
              <div className="space-y-2">
                {findings.map((f, i) => (
                  <div key={i} className="flex items-start gap-3 p-3 rounded-lg border border-slate-100">
                    {f.level === 'error' ? (
                      <XCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                    ) : f.type?.includes('exception') ? (
                      <CheckCircle className="w-4 h-4 text-blue-500 mt-0.5 shrink-0" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-yellow-500 mt-0.5 shrink-0" />
                    )}
                    <div>
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-xs font-mono text-slate-500">{f.rule_id}</span>
                        {f.authority && <span className="text-xs text-brand-600">{f.authority}</span>}
                        {f.category && <span className="text-xs text-slate-400 capitalize">{f.category.replace('_', ' ')}</span>}
                      </div>
                      <p className="text-sm text-slate-700">{f.message}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {overallScore === null && !loading && (
        <div className="flex items-center justify-center h-48 bg-slate-50 border border-slate-200 rounded-xl">
          <p className="text-slate-400">Run a compliance check to see results</p>
        </div>
      )}
    </div>
  )
}
