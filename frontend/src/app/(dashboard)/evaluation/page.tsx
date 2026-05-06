'use client'
import { TrendingUp, RefreshCw, AlertTriangle, CheckCircle, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'

interface EvalResult {
  id: string
  run_id: string
  evaluator_name?: string
  score: number
  weighted_score?: number
  verdict: string
  score_breakdown?: Record<string, number>
  acceptance_decision?: string
  false_confidence_detected?: boolean
  created_at: string
}

interface DriftSnapshot {
  evaluator_id: string
  avg_score: number
  drift_detected: boolean
  drift_magnitude: number
  period_start: string
}

const VERDICT_ICON: Record<string, React.ReactNode> = {
  pass: <CheckCircle className="w-4 h-4 text-green-500" />,
  fail: <XCircle className="w-4 h-4 text-red-500" />,
  partial: <AlertTriangle className="w-4 h-4 text-yellow-500" />,
  accepted: <CheckCircle className="w-4 h-4 text-green-500" />,
  rejected: <XCircle className="w-4 h-4 text-red-500" />,
  conditional: <AlertTriangle className="w-4 h-4 text-yellow-500" />,
}

const DIMENSIONS = ['accuracy', 'compliance', 'hallucination', 'readability', 'consistency', 'completeness']

export default function EvaluationPage() {
  const [results, setResults] = useState<EvalResult[]>([])
  const [driftSnapshots, setDriftSnapshots] = useState<DriftSnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedResult, setSelectedResult] = useState<EvalResult | null>(null)

  const runtimeUrl = process.env.NEXT_PUBLIC_AGENT_RUNTIME_URL || 'http://localhost:8004'

  useEffect(() => { fetchData() }, [])

  const fetchData = async () => {
    try {
      setLoading(true)
      const orgId = typeof window !== 'undefined' ? (localStorage.getItem('org_id') || 'default-org') : 'default-org'
      const [evalRes, driftRes] = await Promise.allSettled([
        fetch(`${runtimeUrl}/evaluations?org_id=${orgId}&limit=50`),
        fetch(`${runtimeUrl}/evaluation/drift-snapshots?org_id=${orgId}`),
      ])
      if (evalRes.status === 'fulfilled' && evalRes.value.ok) {
        const data = await evalRes.value.json()
        setResults(data.results || data.evaluations || [])
      }
      if (driftRes.status === 'fulfilled' && driftRes.value.ok) {
        const data = await driftRes.value.json()
        setDriftSnapshots(data.snapshots || [])
      }
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }

  const avgScore = results.length
    ? (results.reduce((s, r) => s + (r.weighted_score || r.score || 0), 0) / results.length)
    : 0

  const falseConfidenceCount = results.filter(r => r.false_confidence_detected).length
  const driftCount = driftSnapshots.filter(d => d.drift_detected).length

  function readabilityGrade(score: number | undefined): string {
    if (score == null) return '—'
    if (score >= 0.85) return 'A'
    if (score >= 0.70) return 'B'
    if (score >= 0.55) return 'C'
    return 'D'
  }

  const scoreBar = (score: number) => (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${score >= 0.7 ? 'bg-green-500' : score >= 0.5 ? 'bg-yellow-500' : 'bg-red-500'}`}
          style={{ width: `${(score * 100).toFixed(0)}%` }}
        />
      </div>
      <span className="text-xs font-medium text-slate-600 w-10 text-right">{(score * 100).toFixed(0)}%</span>
    </div>
  )

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <TrendingUp className="w-6 h-6 text-brand-600" />
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Evaluation Dashboard</h1>
            <p className="text-sm text-slate-500">Agent output quality scores, drift detection, false confidence alerts</p>
          </div>
        </div>
        <button onClick={fetchData} className="flex items-center gap-2 px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg hover:bg-slate-50">
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Avg Weighted Score', value: `${(avgScore * 100).toFixed(1)}%`, color: avgScore >= 0.7 ? 'text-green-700' : 'text-yellow-700' },
          { label: 'Total Evaluations', value: results.length.toString(), color: 'text-slate-900' },
          { label: 'False Confidence', value: falseConfidenceCount.toString(), color: falseConfidenceCount > 0 ? 'text-red-700' : 'text-green-700' },
          { label: 'Drift Detected', value: driftCount.toString(), color: driftCount > 0 ? 'text-orange-700' : 'text-green-700' },
        ].map(m => (
          <div key={m.label} className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs text-slate-500">{m.label}</p>
            <p className={`text-2xl font-bold mt-1 ${m.color}`}>{m.value}</p>
          </div>
        ))}
      </div>

      {driftSnapshots.filter(d => d.drift_detected).length > 0 && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 mb-5">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-orange-600" />
            <p className="font-semibold text-orange-800">Evaluation Drift Detected</p>
          </div>
          {driftSnapshots.filter(d => d.drift_detected).map((s, i) => (
            <p key={i} className="text-sm text-orange-700">
              Evaluator {s.evaluator_id?.slice(0, 8)}: drift magnitude {(s.drift_magnitude * 100).toFixed(1)}%, avg score {(s.avg_score * 100).toFixed(1)}%
            </p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-2">
          <h2 className="font-semibold text-slate-800 mb-3">Recent Evaluations</h2>
          {loading ? (
            <div className="flex justify-center py-8"><RefreshCw className="w-5 h-5 animate-spin text-brand-500" /></div>
          ) : (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    {['Run ID', 'Verdict', 'Weighted Score', 'False Conf', 'Readability', 'Date'].map(h => (
                      <th key={h} className="px-4 py-3 text-left font-medium text-slate-600 text-xs">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.length === 0 ? (
                    <tr><td colSpan={6} className="text-center py-8 text-slate-400">No evaluations yet</td></tr>
                  ) : results.map(r => {
                    const grade = readabilityGrade(r.score_breakdown?.readability)
                    const gradeCls = grade === 'A' ? 'bg-green-100 text-green-700' : grade === 'B' ? 'bg-blue-100 text-blue-700' : grade === 'C' ? 'bg-amber-100 text-amber-700' : grade === 'D' ? 'bg-red-100 text-red-700' : ''
                    return (
                    <tr
                      key={r.id}
                      onClick={() => setSelectedResult(r)}
                      className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer"
                    >
                      <td className="px-4 py-3 font-mono text-xs text-slate-600">{r.run_id?.slice(0, 12)}...</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          {VERDICT_ICON[r.acceptance_decision || r.verdict] || null}
                          <span className="capitalize text-xs">{r.acceptance_decision || r.verdict}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {scoreBar((r.weighted_score || r.score || 0))}
                      </td>
                      <td className="px-4 py-3">
                        {r.false_confidence_detected ? (
                          <span className="px-2 py-0.5 bg-red-100 text-red-700 text-xs rounded-full">Yes</span>
                        ) : (
                          <span className="text-slate-400 text-xs">No</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {grade === '—' ? (
                          <span className="text-slate-400 text-xs">—</span>
                        ) : (
                          <span className={`px-2 py-0.5 text-xs font-bold rounded-full ${gradeCls}`}>{grade}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400">{new Date(r.created_at).toLocaleDateString()}</td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="col-span-1">
          {selectedResult ? (
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <h3 className="font-semibold text-slate-800 mb-3">Score Breakdown</h3>
              <div className="space-y-3">
                {DIMENSIONS.map(dim => {
                  const score = selectedResult.score_breakdown?.[dim] ?? null
                  if (score === null) return null
                  return (
                    <div key={dim}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-slate-600 capitalize">{dim}</span>
                        <span className="text-xs text-slate-500">{(score * 100).toFixed(0)}%</span>
                      </div>
                      {scoreBar(score)}
                    </div>
                  )
                })}
              </div>
              {selectedResult.false_confidence_detected && (
                <div className="mt-4 p-3 bg-red-50 rounded-lg">
                  <p className="text-xs font-semibold text-red-700 flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" /> False Confidence Detected
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center h-48 bg-slate-50 border border-slate-200 rounded-xl">
              <p className="text-sm text-slate-400">Click a result for breakdown</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
