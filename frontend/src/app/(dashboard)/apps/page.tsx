'use client'
import { useState, useEffect, Suspense } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Plus, Play, Package, Clock, X, AlertCircle } from 'lucide-react'
import { useAuth, useOrgId } from '@/components/layout/AuthContext'

interface AppInstallation {
  id: string
  appId: string
  installedVersion: string
  status: string
  installedAt: string
  app?: { name: string; description: string; category: string; slug: string; bpmnXml: string | null }
}

interface WorkflowInstance {
  id: string
  appId: string
  bpmnProcessId: string
  status: string
  startedAt: string
}

function StartWorkflowModal({
  inst,
  orgId,
  userId,
  onClose,
}: {
  inst: AppInstallation
  orgId: string
  userId: string
  onClose: () => void
}) {
  const router = useRouter()
  const [studyId, setStudyId] = useState('')
  const [notes, setNotes] = useState('')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')

  const handleStart = async () => {
    if (!studyId.trim()) { setError('Study ID is required'); return }
    setError('')
    setStarting(true)
    const gqlUrl = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
    const token = decodeURIComponent(document.cookie.match(/trialo_token=([^;]+)/)?.[1] ?? '')
    try {
      // Extract process ID from BPMN XML or fall back to slug
      let bpmnProcessId = inst.app?.slug || inst.appId
      if (inst.app?.bpmnXml) {
        const match = inst.app.bpmnXml.match(/process\s+id="([^"]+)"/)
        if (match) bpmnProcessId = match[1]
      }
      const res = await fetch(gqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          query: `mutation($input: StartWorkflowInput!) { startWorkflow(input: $input) { id } }`,
          variables: {
            input: {
              orgId, installationId: inst.id, appId: inst.appId,
              studyId: studyId.trim(), bpmnProcessId,
              inputVariables: { studyId: studyId.trim(), notes },
              startedBy: userId,
            },
          },
        }),
      })
      const json = await res.json()
      if (json.errors?.length) { setError(json.errors[0].message); return }
      const instanceId = json.data?.startWorkflow?.id
      if (instanceId) router.push(`/workflows/${instanceId}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start workflow')
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl mx-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-slate-900">Start Workflow</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>
        <p className="text-sm text-slate-500 mb-5">{inst.app?.name || inst.appId}</p>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Study ID *</label>
            <input value={studyId} onChange={e => setStudyId(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="STUDY-001" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
            <input value={notes} onChange={e => setNotes(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="Optional notes..." />
          </div>
          {error && (
            <p className="flex items-center gap-1.5 text-sm text-red-600">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
            </p>
          )}
        </div>
        <div className="flex gap-3 mt-6">
          <button onClick={onClose} className="flex-1 px-4 py-2 border border-slate-200 rounded-lg text-sm text-slate-700 hover:bg-slate-50">
            Cancel
          </button>
          <button onClick={handleStart} disabled={starting}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-green-500 text-white rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-60">
            <Play className="w-4 h-4" />{starting ? 'Starting...' : 'Start'}
          </button>
        </div>
      </div>
    </div>
  )
}

function AppConsoleContent() {
  const { user } = useAuth()
  const orgId = useOrgId()
  const [installations, setInstallations] = useState<AppInstallation[]>([])
  const [recentWorkflows, setRecentWorkflows] = useState<WorkflowInstance[]>([])
  const [loading, setLoading] = useState(true)
  const [startingInst, setStartingInst] = useState<AppInstallation | null>(null)

  useEffect(() => {
    if (!orgId) return
    const gqlUrl = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
    Promise.all([
      fetch(gqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `query($orgId: String!) {
            appInstallations(orgId: $orgId) {
              id appId installedVersion status installedAt
              app { name description category slug bpmnXml }
            }
          }`,
          variables: { orgId },
        }),
      }).then(r => r.json()),
      fetch(gqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `query($orgId: String!) {
            workflowInstances(orgId: $orgId, limit: 10) {
              id appId bpmnProcessId status startedAt
            }
          }`,
          variables: { orgId },
        }),
      }).then(r => r.json()),
    ]).then(([instData, wfData]) => {
      setInstallations(instData.data?.appInstallations || [])
      setRecentWorkflows(wfData.data?.workflowInstances || [])
    }).catch(console.error).finally(() => setLoading(false))
  }, [orgId])

  const statusBadge = (status: string) => {
    const colors: Record<string, string> = {
      active: 'bg-green-100 text-green-800',
      running: 'bg-blue-100 text-blue-800',
      completed: 'bg-slate-100 text-slate-800',
      terminated: 'bg-red-100 text-red-800',
      incident: 'bg-orange-100 text-orange-800',
    }
    return <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[status] || 'bg-slate-100 text-slate-600'}`}>{status}</span>
  }

  return (
    <div className="p-6 space-y-6">
      {startingInst && user && orgId && (
        <StartWorkflowModal
          inst={startingInst}
          orgId={orgId}
          userId={user.id}
          onClose={() => setStartingInst(null)}
        />
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">App Console</h1>
          <p className="text-slate-500 text-sm mt-1">Manage your installed clinical trial applications</p>
        </div>
        <div className="flex gap-3">
          <Link href="/apps/market" className="flex items-center gap-2 px-4 py-2 border border-slate-200 rounded-lg text-sm text-slate-700 hover:bg-slate-50">
            <Package className="w-4 h-4" />App Marketplace
          </Link>
          <Link href="/apps/build" className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600">
            <Plus className="w-4 h-4" />Build App
          </Link>
        </div>
      </div>

      {loading ? (
        <div className="text-slate-400 text-sm">Loading...</div>
      ) : (
        <>
          <div>
            <h2 className="text-lg font-semibold text-slate-800 mb-3">Installed Applications ({installations.length})</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {installations.length === 0 ? (
                <div className="col-span-3 text-center py-12 text-slate-400">
                  <Package className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p>No apps installed yet. <Link href="/apps/market" className="text-brand-600 hover:underline">Browse the marketplace</Link></p>
                </div>
              ) : installations.map(inst => (
                <div key={inst.id} className="bg-white border border-slate-200 rounded-xl p-5 hover:border-brand-200 transition-colors">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h3 className="font-semibold text-slate-900">{inst.app?.name || inst.appId}</h3>
                      <p className="text-xs text-slate-400 mt-0.5">v{inst.installedVersion} · {inst.app?.category}</p>
                    </div>
                    {statusBadge(inst.status)}
                  </div>
                  <p className="text-sm text-slate-600 mb-4 line-clamp-2">{inst.app?.description}</p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setStartingInst(inst)}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-500 text-white rounded-lg text-xs font-medium hover:bg-brand-600">
                      <Play className="w-3 h-3" />Start Workflow
                    </button>
                    <Link href={`/apps/${inst.appId}`} className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs text-slate-600 hover:bg-slate-50">
                      Details
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-slate-800">Recent Workflows</h2>
              <Link href="/workflows" className="text-sm text-brand-600 hover:underline">View all</Link>
            </div>
            {recentWorkflows.length === 0 ? (
              <div className="text-sm text-slate-400 py-4">No recent workflow runs.</div>
            ) : (
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="text-left px-4 py-2 text-slate-500 font-medium text-xs">Process</th>
                      <th className="text-left px-4 py-2 text-slate-500 font-medium text-xs">Status</th>
                      <th className="text-left px-4 py-2 text-slate-500 font-medium text-xs">Started</th>
                      <th className="px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentWorkflows.map(wf => (
                      <tr key={wf.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                        <td className="px-4 py-3 font-medium text-slate-800">{wf.bpmnProcessId}</td>
                        <td className="px-4 py-3">{statusBadge(wf.status)}</td>
                        <td className="px-4 py-3 text-slate-500 flex items-center gap-1.5">
                          <Clock className="w-3 h-3" />
                          {new Date(wf.startedAt).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3">
                          <Link href={`/workflows/${wf.id}`} className="text-brand-600 hover:underline text-xs">View</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default function AppsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <AppConsoleContent />
    </Suspense>
  )
}
