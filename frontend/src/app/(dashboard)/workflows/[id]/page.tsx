'use client'
import { useState, useEffect, Suspense } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Play, CheckCircle, XCircle, Clock, User } from 'lucide-react'
import { useOrgId } from '@/components/layout/AuthContext'

interface WorkflowInstance {
  id: string
  bpmnProcessId: string
  status: string
  inputVariables: Record<string, unknown>
  outputVariables: Record<string, unknown>
  startedAt: string
  completedAt?: string
  slaDeadline?: string
}

interface WorkflowTask {
  id: string
  elementName: string
  assigneeRole: string
  status: string
  dueDate?: string
  isOverdue: boolean
  createdAt: string
}

const STATUS_COLORS: Record<string, string> = {
  running: 'text-blue-600 bg-blue-50 border-blue-200',
  completed: 'text-green-600 bg-green-50 border-green-200',
  terminated: 'text-red-600 bg-red-50 border-red-200',
  pending: 'text-slate-600 bg-slate-50 border-slate-200',
  claimed: 'text-amber-600 bg-amber-50 border-amber-200',
}

function WorkflowDetailContent() {
  const orgId = useOrgId()
  const params = useParams()
  const id = params.id as string
  const [instance, setInstance] = useState<WorkflowInstance | null>(null)
  const [tasks, setTasks] = useState<WorkflowTask[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!orgId || !id) return
    const gqlUrl = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
    Promise.all([
      fetch(gqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `query($id: ID!) {
            workflowInstance(id: $id) {
              id bpmnProcessId status inputVariables outputVariables startedAt completedAt slaDeadline
            }
          }`,
          variables: { id },
        }),
      }).then(r => r.json()),
      fetch(gqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `query($orgId: String!) {
            workflowTasks(orgId: $orgId) {
              id instanceId elementName assigneeRole status dueDate isOverdue createdAt
            }
          }`,
          variables: { orgId },
        }),
      }).then(r => r.json()),
    ]).then(([instData, taskData]) => {
      setInstance(instData.data?.workflowInstance || null)
      setTasks((taskData.data?.workflowTasks || []).filter((t: WorkflowTask & { instanceId?: string }) => t.instanceId === id))
    }).catch(console.error).finally(() => setLoading(false))
  }, [orgId, id])

  if (loading) return <div className="p-6 text-slate-400">Loading...</div>
  if (!instance) return <div className="p-6 text-slate-500">Workflow instance not found.</div>

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/workflows" className="text-slate-400 hover:text-slate-600">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <h1 className="text-xl font-bold text-slate-900">{instance.bpmnProcessId}</h1>
          <p className="text-slate-400 text-xs font-mono">{instance.id}</p>
        </div>
        <span className={`px-3 py-1 rounded-full text-xs font-medium border ${STATUS_COLORS[instance.status] || STATUS_COLORS.pending}`}>
          {instance.status}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs text-slate-400 mb-1">Started</p>
          <p className="font-medium text-slate-800 text-sm">{new Date(instance.startedAt).toLocaleString()}</p>
        </div>
        {instance.completedAt && (
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs text-slate-400 mb-1">Completed</p>
            <p className="font-medium text-slate-800 text-sm">{new Date(instance.completedAt).toLocaleString()}</p>
          </div>
        )}
        {instance.slaDeadline && (
          <div className={`bg-white border rounded-xl p-4 ${new Date(instance.slaDeadline) < new Date() ? 'border-red-200' : 'border-slate-200'}`}>
            <p className="text-xs text-slate-400 mb-1">SLA Deadline</p>
            <p className={`font-medium text-sm ${new Date(instance.slaDeadline) < new Date() ? 'text-red-600' : 'text-slate-800'}`}>
              {new Date(instance.slaDeadline).toLocaleString()}
            </p>
          </div>
        )}
      </div>

      {/* Process Variables */}
      {Object.keys(instance.inputVariables || {}).length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
            <Play className="w-4 h-4" />Input Variables
          </h2>
          <pre className="text-xs text-slate-600 bg-slate-50 rounded-lg p-3 overflow-auto max-h-40">
            {JSON.stringify(instance.inputVariables, null, 2)}
          </pre>
        </div>
      )}

      {/* Tasks Timeline */}
      <div>
        <h2 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
          <Clock className="w-4 h-4" />Workflow Tasks ({tasks.length})
        </h2>
        {tasks.length === 0 ? (
          <p className="text-slate-400 text-sm">No tasks yet.</p>
        ) : (
          <div className="space-y-3">
            {tasks.map(task => (
              <div key={task.id} className={`flex items-center gap-4 p-4 bg-white border rounded-xl ${task.isOverdue ? 'border-red-200' : 'border-slate-200'}`}>
                <div>
                  {task.status === 'completed' ? <CheckCircle className="w-5 h-5 text-green-500" /> :
                   task.status === 'cancelled' ? <XCircle className="w-5 h-5 text-red-500" /> :
                   task.isOverdue ? <Clock className="w-5 h-5 text-red-500" /> :
                   <Clock className="w-5 h-5 text-slate-300" />}
                </div>
                <div className="flex-1">
                  <p className="font-medium text-slate-800 text-sm">{task.elementName}</p>
                  <div className="flex items-center gap-3 mt-0.5">
                    <span className="flex items-center gap-1 text-xs text-slate-400"><User className="w-3 h-3" />{task.assigneeRole}</span>
                    {task.dueDate && <span className={`text-xs ${task.isOverdue ? 'text-red-500 font-medium' : 'text-slate-400'}`}>Due: {new Date(task.dueDate).toLocaleString()}</span>}
                  </div>
                </div>
                <span className={`px-2.5 py-1 rounded-full text-xs font-medium border ${STATUS_COLORS[task.status] || STATUS_COLORS.pending}`}>{task.status}</span>
                {task.status !== 'completed' && (
                  <Link href={`/tasks/${task.id}`} className="text-xs text-brand-600 hover:underline">Open</Link>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default function WorkflowDetailPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <WorkflowDetailContent />
    </Suspense>
  )
}
