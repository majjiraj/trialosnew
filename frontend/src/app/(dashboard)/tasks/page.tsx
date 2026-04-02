'use client'
import { useState, useEffect, Suspense } from 'react'
import Link from 'next/link'
import { ListTodo, Clock, AlertCircle, User, Database, GitMerge, Upload } from 'lucide-react'
import { useAuth, useOrgId } from '@/components/layout/AuthContext'

interface WorkflowTask {
  id: string
  instanceId: string
  elementName: string
  formId?: string
  assigneeId?: string
  assigneeRole?: string
  status: string
  dueDate?: string
  isOverdue: boolean
  createdAt: string
  _type: 'workflow'
}

interface SdtmMappingTask {
  id: string
  runId: string
  orgId: string
  studyId?: string
  title: string
  description?: string
  status: string
  createdAt: string
  _type: 'sdtm_mapping'
}

interface UsdmMappingTask {
  id: string          // approval_id
  conversionId: string
  runId: string
  orgId: string
  studyId?: string
  name: string
  title: string
  description?: string
  status: string
  taskType?: string   // 'select_document' | 'review_mapping'
  createdAt: string
  _type: 'usdm_mapping'
}

type AnyTask = WorkflowTask | SdtmMappingTask | UsdmMappingTask

function SlaCountdown({ dueDate }: { dueDate: string }) {
  const due = new Date(dueDate)
  const now = new Date()
  const diffMs = due.getTime() - now.getTime()
  if (diffMs <= 0) return <span className="text-red-600 font-medium text-xs flex items-center gap-1"><AlertCircle className="w-3 h-3" />Overdue</span>
  const hours = Math.floor(diffMs / 3600000)
  const mins = Math.floor((diffMs % 3600000) / 60000)
  const urgent = hours < 2
  return (
    <span className={`text-xs flex items-center gap-1 ${urgent ? 'text-orange-600 font-medium' : 'text-slate-500'}`}>
      <Clock className={`w-3 h-3 ${urgent ? 'text-orange-500' : ''}`} />
      {hours > 0 ? `${hours}h ` : ''}{mins}m
    </span>
  )
}

const gqlUrl = () => process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
const getToken = () => decodeURIComponent(document.cookie.match(/trialo_token=([^;]+)/)?.[1] ?? '')

async function gqlFetch(query: string, variables: Record<string, unknown>) {
  const res = await fetch(gqlUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ query, variables }),
  })
  const { data } = await res.json()
  return data
}

function TasksContent() {
  const { user } = useAuth()
  const orgId = useOrgId()
  const [workflowTasks, setWorkflowTasks] = useState<WorkflowTask[]>([])
  const [sdtmTasks, setSdtmTasks] = useState<SdtmMappingTask[]>([])
  const [usdmTasks, setUsdmTasks] = useState<UsdmMappingTask[]>([])
  const [filter, setFilter] = useState<'my' | 'all'>('all')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!orgId || !user) return
    setLoading(true)

    const wfQuery = filter === 'my'
      ? `query($orgId: String!, $userId: String!) { myTasks(orgId: $orgId, userId: $userId) { id instanceId elementName formId assigneeId assigneeRole status dueDate isOverdue createdAt } }`
      : `query($orgId: String!) { workflowTasks(orgId: $orgId) { id instanceId elementName formId assigneeId assigneeRole status dueDate isOverdue createdAt } }`
    const sdtmQuery = `query($orgId: String!) { sdtmMappingTasks(orgId: $orgId) { id runId orgId studyId title description status createdAt } }`
    const usdmQuery = `query($orgId: String!) { usdmMappingTasks(orgId: $orgId) { id conversionId runId orgId studyId name title description status taskType createdAt } }`

    // Fetch independently so one failure doesn't block the other
    const fetchAll = async () => {
      const [wfData, sdtmData, usdmData] = await Promise.allSettled([
        gqlFetch(wfQuery, { orgId, userId: user.id }),
        gqlFetch(sdtmQuery, { orgId }),
        gqlFetch(usdmQuery, { orgId }),
      ])
      if (wfData.status === 'fulfilled') {
        const wf: WorkflowTask[] = ((wfData.value?.myTasks || wfData.value?.workflowTasks) ?? []).map((t: WorkflowTask) => ({ ...t, _type: 'workflow' as const }))
        setWorkflowTasks(wf)
      }
      if (sdtmData.status === 'fulfilled') {
        const sdtm: SdtmMappingTask[] = (sdtmData.value?.sdtmMappingTasks ?? []).map((t: SdtmMappingTask) => ({ ...t, _type: 'sdtm_mapping' as const }))
        setSdtmTasks(sdtm)
      }
      if (usdmData.status === 'fulfilled') {
        const usdm: UsdmMappingTask[] = (usdmData.value?.usdmMappingTasks ?? []).map((t: UsdmMappingTask) => ({ ...t, _type: 'usdm_mapping' as const }))
        setUsdmTasks(usdm)
      }
      setLoading(false)
    }
    fetchAll().catch(() => setLoading(false))
  }, [orgId, user, filter])

  const allTasks: AnyTask[] = [
    ...usdmTasks,
    ...sdtmTasks,
    ...workflowTasks,
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  const priorityBadge = (task: WorkflowTask) => {
    if (task.isOverdue) return <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">Overdue</span>
    if (task.dueDate) {
      const hoursLeft = (new Date(task.dueDate).getTime() - Date.now()) / 3600000
      if (hoursLeft < 2) return <span className="px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-700">Urgent</span>
    }
    return null
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Task Inbox</h1>
          <p className="text-slate-500 text-sm mt-1">Pending workflow tasks requiring your attention</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setFilter('my')} className={`px-3 py-1.5 rounded-lg text-sm font-medium ${filter === 'my' ? 'bg-brand-500 text-white' : 'bg-slate-100 text-slate-600'}`}>
            My Tasks
          </button>
          <button onClick={() => setFilter('all')} className={`px-3 py-1.5 rounded-lg text-sm font-medium ${filter === 'all' ? 'bg-brand-500 text-white' : 'bg-slate-100 text-slate-600'}`}>
            All Tasks
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-slate-400">Loading tasks...</div>
      ) : allTasks.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <ListTodo className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">No pending tasks</p>
          <p className="text-sm mt-1">You&apos;re all caught up!</p>
        </div>
      ) : (
        <div className="space-y-3">
          {allTasks.map(task => {
            if (task._type === 'usdm_mapping') {
              const t = task as UsdmMappingTask
              const isUpload = t.taskType === 'select_document'
              return (
                <Link key={`usdm-${t.id}`} href={`/usdm/${t.conversionId}`}
                  className={`block bg-white border rounded-xl p-5 hover:shadow-sm transition-all ${isUpload ? 'border-brand-200 hover:border-brand-400' : 'border-amber-200 hover:border-amber-400'}`}>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        {isUpload
                          ? <Upload className="w-4 h-4 text-brand-500" />
                          : <GitMerge className="w-4 h-4 text-amber-600" />}
                        <h3 className="font-semibold text-slate-900">{t.title}</h3>
                        {isUpload
                          ? <span className="px-2 py-0.5 rounded text-xs font-medium bg-brand-50 text-brand-700 border border-brand-200">Upload Document</span>
                          : <span className="px-2 py-0.5 rounded text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">USDM Review</span>}
                      </div>
                      {t.description && (
                        <p className="text-xs text-slate-500 mb-1">{t.description}</p>
                      )}
                      <div className="flex items-center gap-4 text-xs text-slate-400">
                        {t.studyId && <span>Study: {t.studyId}</span>}
                        {t.runId && <span>Run: {t.runId.slice(0, 8)}...</span>}
                        <span>{new Date(t.createdAt).toLocaleString()}</span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${isUpload ? 'bg-brand-50 text-brand-700 border border-brand-200' : 'bg-amber-50 text-amber-700 border border-amber-200'}`}>
                        {t.status}
                      </span>
                    </div>
                  </div>
                </Link>
              )
            }
            if (task._type === 'sdtm_mapping') {
              const t = task as SdtmMappingTask
              return (
                <Link key={`sdtm-${t.id}`} href={`/agents/mapping-review/${t.id}`}
                  className="block bg-white border border-brand-200 rounded-xl p-5 hover:border-brand-400 hover:shadow-sm transition-all">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <Database className="w-4 h-4 text-brand-500" />
                        <h3 className="font-semibold text-slate-900">{t.title}</h3>
                        <span className="px-2 py-0.5 rounded text-xs font-medium bg-brand-50 text-brand-700 border border-brand-200">SDTM Mapping Review</span>
                      </div>
                      {t.description && (
                        <p className="text-xs text-slate-500 mb-1">{t.description}</p>
                      )}
                      <div className="flex items-center gap-4 text-xs text-slate-400">
                        {t.studyId && <span>Study: {t.studyId}</span>}
                        <span>Run: {t.runId.slice(0, 8)}...</span>
                        <span>{new Date(t.createdAt).toLocaleString()}</span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
                        {t.status}
                      </span>
                    </div>
                  </div>
                </Link>
              )
            }
            const t = task as WorkflowTask
            return (
              <Link key={`wf-${t.id}`} href={`/tasks/${t.id}`}
                className="block bg-white border border-slate-200 rounded-xl p-5 hover:border-brand-200 hover:shadow-sm transition-all">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-semibold text-slate-900">{t.elementName || 'Task'}</h3>
                      {priorityBadge(t)}
                    </div>
                    <div className="flex items-center gap-4 text-xs text-slate-400">
                      {t.assigneeRole && (
                        <span className="flex items-center gap-1"><User className="w-3 h-3" />{t.assigneeRole}</span>
                      )}
                      {t.instanceId && <span>Workflow: {t.instanceId.slice(0, 8)}...</span>}
                      {t.formId && <span>Form: {t.formId}</span>}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${t.status === 'claimed' ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-slate-50 text-slate-600 border border-slate-200'}`}>
                      {t.status}
                    </span>
                    {t.dueDate && <SlaCountdown dueDate={t.dueDate} />}
                  </div>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function TasksPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <TasksContent />
    </Suspense>
  )
}
