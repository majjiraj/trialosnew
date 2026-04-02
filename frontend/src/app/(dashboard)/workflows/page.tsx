'use client'
import { useState, useEffect, Suspense } from 'react'
import Link from 'next/link'
import { Play, Clock, CheckCircle, XCircle, AlertCircle } from 'lucide-react'
import { useOrgId } from '@/components/layout/AuthContext'

interface WorkflowInstance {
  id: string
  appId: string
  bpmnProcessId: string
  status: string
  startedAt: string
  completedAt?: string
  slaDeadline?: string
}

const STATUS_ICONS: Record<string, React.ReactNode> = {
  running: <Play className="w-4 h-4 text-blue-500" />,
  completed: <CheckCircle className="w-4 h-4 text-green-500" />,
  terminated: <XCircle className="w-4 h-4 text-red-500" />,
  incident: <AlertCircle className="w-4 h-4 text-orange-500" />,
}

function WorkflowsContent() {
  const orgId = useOrgId()
  const [instances, setInstances] = useState<WorkflowInstance[]>([])
  const [statusFilter, setStatusFilter] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!orgId) return
    const gqlUrl = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
    fetch(gqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query($orgId: String!, $status: String) {
          workflowInstances(orgId: $orgId, status: $status, limit: 100) {
            id appId bpmnProcessId status startedAt completedAt slaDeadline
          }
        }`,
        variables: { orgId, status: statusFilter || undefined },
      }),
    }).then(r => r.json()).then(d => setInstances(d.data?.workflowInstances || []))
      .catch(console.error).finally(() => setLoading(false))
  }, [orgId, statusFilter])

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Workflows</h1>
          <p className="text-slate-500 text-sm mt-1">Running and completed workflow instances</p>
        </div>
        <div className="flex gap-2">
          {['', 'running', 'completed', 'terminated'].map(s => (
            <button key={s} onClick={() => { setStatusFilter(s); setLoading(true) }}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${statusFilter === s ? 'bg-brand-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
              {s || 'All'}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-slate-400">Loading workflows...</div>
      ) : instances.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <Play className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">No workflow instances found</p>
          <p className="text-sm mt-1">Start a workflow from the App Console</p>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-3 text-slate-500 font-medium text-xs">Process</th>
                <th className="text-left px-4 py-3 text-slate-500 font-medium text-xs">Status</th>
                <th className="text-left px-4 py-3 text-slate-500 font-medium text-xs">Started</th>
                <th className="text-left px-4 py-3 text-slate-500 font-medium text-xs">SLA</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {instances.map(inst => (
                <tr key={inst.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-800">{inst.bpmnProcessId}</td>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-1.5">
                      {STATUS_ICONS[inst.status] || <Clock className="w-4 h-4 text-slate-400" />}
                      <span className="capitalize text-slate-700">{inst.status}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-500">{new Date(inst.startedAt).toLocaleString()}</td>
                  <td className="px-4 py-3">
                    {inst.slaDeadline ? (
                      <span className={`text-xs font-medium ${new Date(inst.slaDeadline) < new Date() ? 'text-red-600' : 'text-slate-500'}`}>
                        {new Date(inst.slaDeadline).toLocaleString()}
                      </span>
                    ) : <span className="text-slate-300 text-xs">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/workflows/${inst.id}`} className="text-brand-600 hover:underline text-xs">View</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function WorkflowsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <WorkflowsContent />
    </Suspense>
  )
}
