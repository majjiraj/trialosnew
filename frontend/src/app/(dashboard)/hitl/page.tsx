'use client'
import { UserCheck, RefreshCw, Clock, CheckCircle, XCircle, AlertTriangle } from 'lucide-react'
import { useEffect, useState } from 'react'

interface ApprovalRequest {
  id: string
  run_id: string
  study_id?: string
  domain?: string
  status: string
  reviewer_type?: string
  trigger_category?: string
  assigned_reviewer_id?: string
  sla_deadline?: string
  created_at: string
  description?: string
  confidence?: number
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  escalated: 'bg-purple-100 text-purple-700',
}

export default function HITLPage() {
  const [requests, setRequests] = useState<ApprovalRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('pending')
  const [selected, setSelected] = useState<ApprovalRequest | null>(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [comment, setComment] = useState('')

  const runtimeUrl = process.env.NEXT_PUBLIC_AGENT_RUNTIME_URL || 'http://localhost:8004'

  const fetchRequests = async () => {
    try {
      setLoading(true)
      const orgId = typeof window !== 'undefined' ? (localStorage.getItem('org_id') || '00000000-0000-0000-0000-000000000000') : '00000000-0000-0000-0000-000000000000'
      const params = new URLSearchParams({ status: statusFilter })
      const res = await fetch(`${runtimeUrl}/approvals/org/${orgId}?${params}`)
      if (res.ok) {
        const data = await res.json()
        setRequests(data.approvals || [])
      }
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }

  useEffect(() => { fetchRequests() }, [statusFilter])

  const handleAction = async (action: 'approve' | 'reject') => {
    if (!selected) return
    try {
      setActionLoading(true)
      const userId = typeof window !== 'undefined' ? (localStorage.getItem('user_id') || 'reviewer') : 'reviewer'
      const params = new URLSearchParams({
        decision: action,
        decider_id: userId,
        note: comment,
      })
      const res = await fetch(`${runtimeUrl}/approvals/${selected.id}?${params}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
      })
      if (res.ok) {
        setSelected(null)
        setComment('')
        await fetchRequests()
      }
    } catch (e) { console.error(e) } finally { setActionLoading(false) }
  }

  const isSlaBreached = (req: ApprovalRequest) => {
    if (!req.sla_deadline) return false
    return new Date(req.sla_deadline) < new Date()
  }

  const pendingCount = requests.filter(r => r.status === 'pending').length
  const breachedCount = requests.filter(isSlaBreached).length

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <UserCheck className="w-6 h-6 text-brand-600" />
          <div>
            <h1 className="text-2xl font-bold text-slate-900">HITL Review Queue</h1>
            <p className="text-sm text-slate-500">Human-in-the-loop approval requests</p>
          </div>
        </div>
        <button onClick={fetchRequests} className="flex items-center gap-2 px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg hover:bg-slate-50">
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-5">
        {[
          { label: 'Pending Reviews', value: pendingCount, color: 'text-yellow-700' },
          { label: 'SLA Breaches', value: breachedCount, color: breachedCount > 0 ? 'text-red-700' : 'text-green-700' },
          { label: 'Total Shown', value: requests.length, color: 'text-slate-900' },
        ].map(m => (
          <div key={m.label} className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs text-slate-500">{m.label}</p>
            <p className={`text-2xl font-bold mt-1 ${m.color}`}>{m.value}</p>
          </div>
        ))}
      </div>

      <div className="flex gap-2 mb-5">
        {['pending', 'approved', 'rejected', 'all'].map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s === 'all' ? '' : s)}
            className={`px-3 py-1.5 text-sm rounded-lg capitalize ${(statusFilter === s || (s === 'all' && !statusFilter)) ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'}`}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-6">
        <div className="col-span-3">
          {loading ? (
            <div className="flex justify-center py-8"><RefreshCw className="w-5 h-5 animate-spin text-brand-500" /></div>
          ) : (
            <div className="space-y-3">
              {requests.length === 0 ? (
                <div className="text-center py-12 text-slate-400">No requests found</div>
              ) : requests.map(req => (
                <button
                  key={req.id}
                  onClick={() => setSelected(req)}
                  className={`w-full text-left p-4 bg-white border rounded-xl hover:shadow-sm transition-all ${selected?.id === req.id ? 'border-brand-300' : 'border-slate-200'} ${isSlaBreached(req) && req.status === 'pending' ? 'border-red-300 bg-red-50' : ''}`}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[req.status] || 'bg-slate-100 text-slate-600'}`}>
                          {req.status}
                        </span>
                        {req.domain && <span className="text-xs text-slate-500">{req.domain}</span>}
                        {req.reviewer_type && <span className="text-xs text-brand-600">{req.reviewer_type.replace('_', ' ')}</span>}
                        {isSlaBreached(req) && req.status === 'pending' && (
                          <span className="flex items-center gap-1 px-2 py-0.5 bg-red-100 text-red-700 text-xs rounded-full">
                            <AlertTriangle className="w-3 h-3" /> SLA Breached
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-slate-800 line-clamp-2">{req.description || `Run ${req.run_id?.slice(0, 12)} needs review`}</p>
                    </div>
                    <div className="text-right shrink-0 ml-4">
                      {req.confidence !== undefined && (
                        <p className="text-xs text-slate-500">conf: {(req.confidence * 100).toFixed(0)}%</p>
                      )}
                      <p className="text-xs text-slate-400 mt-1">
                        <Clock className="w-3 h-3 inline mr-1" />
                        {req.sla_deadline ? new Date(req.sla_deadline).toLocaleDateString() : new Date(req.created_at).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="col-span-2">
          {selected ? (
            <div className="bg-white border border-slate-200 rounded-xl p-5 sticky top-4">
              <h3 className="font-semibold text-slate-900 mb-3">Review Details</h3>
              <div className="space-y-2 text-sm mb-4">
                <div className="flex justify-between"><span className="text-slate-500">Run ID</span><span className="font-mono text-xs">{selected.run_id?.slice(0, 16)}...</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Domain</span><span>{selected.domain || '—'}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Trigger</span><span>{selected.trigger_category || '—'}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Reviewer Type</span><span>{selected.reviewer_type?.replace('_', ' ') || '—'}</span></div>
                {selected.sla_deadline && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">SLA Deadline</span>
                    <span className={isSlaBreached(selected) ? 'text-red-600 font-medium' : ''}>{new Date(selected.sla_deadline).toLocaleString()}</span>
                  </div>
                )}
              </div>

              {selected.description && (
                <div className="bg-slate-50 rounded-lg p-3 text-sm text-slate-700 mb-4 max-h-32 overflow-y-auto">
                  {selected.description}
                </div>
              )}

              {selected.status === 'pending' && (
                <>
                  <textarea
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm mb-3 resize-none focus:outline-none focus:ring-2 focus:ring-brand-500"
                    rows={3}
                    placeholder="Review comment or correction (optional)"
                    value={comment}
                    onChange={e => setComment(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleAction('approve')}
                      disabled={actionLoading}
                      className="flex-1 flex items-center justify-center gap-2 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 disabled:opacity-50"
                    >
                      <CheckCircle className="w-4 h-4" /> Approve
                    </button>
                    <button
                      onClick={() => handleAction('reject')}
                      disabled={actionLoading}
                      className="flex-1 flex items-center justify-center gap-2 py-2 bg-red-600 text-white text-sm rounded-lg hover:bg-red-700 disabled:opacity-50"
                    >
                      <XCircle className="w-4 h-4" /> Reject
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center h-48 bg-slate-50 border border-slate-200 rounded-xl">
              <p className="text-sm text-slate-400">Select a request to review</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
