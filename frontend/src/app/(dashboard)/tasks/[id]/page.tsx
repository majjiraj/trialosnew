'use client'
import { useState, useEffect, useRef, useCallback, Suspense } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  ArrowLeft, CheckCircle, AlertCircle, MessageSquare,
  Plus, Send, Loader2, X, Database,
} from 'lucide-react'
import { useAuth, useOrgId } from '@/components/layout/AuthContext'
import dynamic from 'next/dynamic'

const RichFormRenderer = dynamic(() => import('@/components/forms/RichFormRenderer'), { ssr: false })

// ── Types ────────────────────────────────────────────────────────────────────

interface WorkflowTask {
  id: string; instanceId: string; elementName: string
  formId?: string; assigneeId?: string; assigneeRole?: string
  status: string; dueDate?: string; variables?: unknown
}

interface HitlField {
  name: string; label: string; type: string
  editable?: boolean; required?: boolean; description?: string; options?: string[]
}

interface FormSchema {
  formId: string; title: string
  jsonSchema: Record<string, unknown>
  uiSchema?: Record<string, unknown>
}

interface PageComponent {
  id: string; type: string; label: string
  agentInstallationId?: string; agentName?: string
  placeholder?: string; contextHint?: string
}

interface Message {
  role: 'user' | 'assistant'; content: string; ts: string
}

interface Session {
  id: string; title: string; messages: Message[]; startedAt: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const getToken = () =>
  decodeURIComponent(document.cookie.match(/trialo_token=([^;]+)/)?.[1] ?? '')

async function gql(query: string, variables: Record<string, unknown> = {}) {
  const url = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ query, variables }),
  })
  const { data, errors } = await res.json()
  if (errors?.length) throw new Error(errors[0].message)
  return data
}

function getConvConfig(formSchema: FormSchema | null) {
  if (!formSchema) return null
  const pcs = (formSchema.uiSchema?.['ui:page_components'] as PageComponent[]) || []
  const conv = pcs.find(pc => pc.type === 'conversation' && pc.agentInstallationId)
  if (!conv) return null
  return {
    installationId: conv.agentInstallationId!,
    agentName: conv.agentName || 'SDTM Explorer',
    placeholder: conv.placeholder || 'Ask about your SDTM data...',
    contextHint: conv.contextHint,
  }
}

function loadSessions(taskId: string): Session[] {
  try {
    return JSON.parse(localStorage.getItem(`trialo_conv_${taskId}`) || '[]')
  } catch { return [] }
}

function saveSessions(taskId: string, sessions: Session[]) {
  localStorage.setItem(`trialo_conv_${taskId}`, JSON.stringify(sessions))
}

function newSession(): Session {
  return { id: crypto.randomUUID(), title: 'New conversation', messages: [], startedAt: new Date().toISOString() }
}

// ── ConversationTaskView ──────────────────────────────────────────────────────

function ConversationTaskView({
  task, orgId, studyId, installationId, agentName, placeholder, contextHint,
  onCloseTask, closing,
}: {
  task: WorkflowTask; orgId: string; studyId?: string
  installationId: string; agentName: string; placeholder: string; contextHint?: string
  onCloseTask: () => void; closing: boolean
}) {
  const [sessions, setSessions] = useState<Session[]>(() => loadSessions(task.id))
  const [currentId, setCurrentId] = useState<string>(() => {
    const saved = loadSessions(task.id)
    return saved.length > 0 ? saved[saved.length - 1].id : newSession().id
  })
  const [input, setInput] = useState('')
  const [polling, setPolling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const router = useRouter()

  // Ensure current session exists
  useEffect(() => {
    setSessions(prev => {
      if (prev.length === 0 || !prev.find(s => s.id === currentId)) {
        const s = newSession()
        const next = [...prev, s]
        setCurrentId(s.id)
        saveSessions(task.id, next)
        return next
      }
      return prev
    })
  }, [task.id, currentId])

  const currentSession = sessions.find(s => s.id === currentId) || sessions[sessions.length - 1]

  const scrollBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => { scrollBottom() }, [currentSession?.messages.length, scrollBottom])

  const updateSession = useCallback((id: string, updater: (s: Session) => Session) => {
    setSessions(prev => {
      const next = prev.map(s => s.id === id ? updater(s) : s)
      saveSessions(task.id, next)
      return next
    })
  }, [task.id])

  const handleSend = async () => {
    const text = input.trim()
    if (!text || polling || !currentSession) return
    setInput('')
    setError(null)

    const userMsg: Message = { role: 'user', content: text, ts: new Date().toISOString() }
    updateSession(currentSession.id, s => ({
      ...s,
      title: s.messages.length === 0 ? text.slice(0, 50) : s.title,
      messages: [...s.messages, userMsg],
    }))

    setPolling(true)
    try {
      const query = contextHint ? `${contextHint}\n\n${text}` : text
      const runData = await gql(`
        mutation($installationId: String!, $studyId: String!, $orgId: String!, $ctx: JSON) {
          startAgentRun(installationId: $installationId, studyId: $studyId, orgId: $orgId, inputContext: $ctx) {
            id status
          }
        }`, { installationId, studyId: studyId || '', orgId, ctx: { query } })

      const runId = runData.startAgentRun?.id
      if (!runId) throw new Error('Failed to start agent run')

      pollRef.current = setInterval(async () => {
        try {
          const pd = await gql(`
            query($runId: String!) { agentRunDetail(runId: $runId) { id status outputSummary errorMessage } }
          `, { runId })
          const run = pd.agentRunDetail
          if (!['running', 'pending'].includes(run.status)) {
            clearInterval(pollRef.current!)
            setPolling(false)
            const reply = run.status === 'completed'
              ? (run.outputSummary || 'Done.')
              : `Error: ${run.errorMessage || 'Agent run failed'}`
            updateSession(currentSession.id, s => ({
              ...s,
              messages: [...s.messages, { role: 'assistant', content: reply, ts: new Date().toISOString() }],
            }))
          }
        } catch (e) {
          clearInterval(pollRef.current!)
          setPolling(false)
          setError(e instanceof Error ? e.message : 'Poll error')
        }
      }, 2000)
    } catch (e) {
      setPolling(false)
      setError(e instanceof Error ? e.message : 'Send error')
    }
  }

  const handleNewChat = () => {
    const s = newSession()
    setSessions(prev => {
      const next = [...prev, s]
      saveSessions(task.id, next)
      return next
    })
    setCurrentId(s.id)
  }

  const formatDate = (iso: string) => {
    const d = new Date(iso)
    const today = new Date()
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
    if (d.toDateString() === today.toDateString()) return 'Today'
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
    return d.toLocaleDateString()
  }

  // Group sessions by date
  const grouped = sessions.reduce<Record<string, Session[]>>((acc, s) => {
    const label = formatDate(s.startedAt)
    if (!acc[label]) acc[label] = []
    acc[label].push(s)
    return acc
  }, {})

  return (
    <div className="flex h-screen flex-col" style={{ height: 'calc(100vh - 64px)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-white flex-shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={() => router.back()} className="text-slate-400 hover:text-slate-600">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-base font-bold text-slate-900">{task.elementName}</h1>
            {studyId && (
              <div className="flex items-center gap-1 text-xs text-slate-400">
                <Database className="w-3 h-3" />Study: {studyId}
              </div>
            )}
          </div>
        </div>
        <button
          onClick={onCloseTask}
          disabled={closing}
          className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
        >
          {closing ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
          {closing ? 'Closing...' : 'Close Task'}
        </button>
      </div>

      {error && (
        <div className="mx-4 mt-2 flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 flex-shrink-0">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />{error}
        </div>
      )}

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <div className="w-56 border-r border-slate-200 bg-slate-50 flex flex-col flex-shrink-0">
          <div className="p-3">
            <button
              onClick={handleNewChat}
              className="w-full flex items-center gap-2 px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors"
            >
              <Plus className="w-4 h-4" />New Chat
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-4">
            {Object.entries(grouped).reverse().map(([label, group]) => (
              <div key={label}>
                <p className="text-xs font-medium text-slate-400 px-2 mb-1">{label}</p>
                {[...group].reverse().map(s => (
                  <button
                    key={s.id}
                    onClick={() => setCurrentId(s.id)}
                    className={`w-full text-left px-2 py-1.5 rounded-lg text-xs truncate transition-colors ${
                      s.id === currentId
                        ? 'bg-violet-100 text-violet-800 font-medium'
                        : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    <MessageSquare className="w-3 h-3 inline mr-1.5 opacity-60" />
                    {s.title}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Chat area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {(!currentSession || currentSession.messages.length === 0) && (
              <div className="flex flex-col items-center justify-center h-full text-center py-16">
                <div className="w-12 h-12 rounded-full bg-violet-100 flex items-center justify-center mb-3">
                  <MessageSquare className="w-6 h-6 text-violet-600" />
                </div>
                <p className="text-sm font-semibold text-slate-700">{agentName}</p>
                <p className="text-xs text-slate-400 mt-1 max-w-xs">
                  Ask questions about your SDTM data.{studyId ? ` Scoped to study ${studyId}.` : ''}
                </p>
              </div>
            )}
            {currentSession?.messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {msg.role === 'assistant' && (
                  <div className="w-7 h-7 rounded-full bg-violet-600 flex items-center justify-center text-white text-xs font-bold mr-2 flex-shrink-0 mt-0.5">A</div>
                )}
                <div className={`max-w-[72%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'bg-slate-900 text-white rounded-br-md'
                    : 'bg-white border border-slate-200 text-slate-800 rounded-bl-md shadow-sm'
                }`}>
                  {msg.content}
                </div>
                {msg.role === 'user' && (
                  <div className="w-7 h-7 rounded-full bg-slate-300 flex items-center justify-center text-slate-600 text-xs font-bold ml-2 flex-shrink-0 mt-0.5">U</div>
                )}
              </div>
            ))}
            {polling && (
              <div className="flex justify-start">
                <div className="w-7 h-7 rounded-full bg-violet-600 flex items-center justify-center text-white text-xs font-bold mr-2 flex-shrink-0">A</div>
                <div className="px-4 py-3 bg-white border border-slate-200 rounded-2xl rounded-bl-md shadow-sm">
                  <div className="flex gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="p-4 border-t border-slate-200 bg-white flex-shrink-0">
            <div className="flex gap-2 items-end bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 focus-within:border-violet-400 focus-within:ring-2 focus-within:ring-violet-100 transition-all">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
                placeholder={placeholder}
                disabled={polling}
                rows={1}
                className="flex-1 bg-transparent resize-none text-sm text-slate-800 placeholder-slate-400 focus:outline-none disabled:opacity-50 min-h-[24px] max-h-32"
                style={{ overflowY: 'auto' }}
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || polling}
                className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {polling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-1.5 text-center">Press Enter to send · Shift+Enter for new line</p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main TaskDetailContent ────────────────────────────────────────────────────

function TaskDetailContent() {
  const { user } = useAuth()
  const orgId = useOrgId()
  const params = useParams()
  const router = useRouter()
  const taskId = params.id as string
  const userId = user?.id || ''

  const [task, setTask] = useState<WorkflowTask | null>(null)
  const [instanceStudyId, setInstanceStudyId] = useState<string | undefined>()
  const [formSchema, setFormSchema] = useState<FormSchema | null>(null)
  const [initialFormData, setInitialFormData] = useState<Record<string, unknown> | undefined>()
  const [agentRunId, setAgentRunId] = useState<string | undefined>()
  const [inlineFields, setInlineFields] = useState<HitlField[]>([])
  const [hitlDescription, setHitlDescription] = useState<string>('')
  const [inlineFormData, setInlineFormData] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)
  const [completing, setCompleting] = useState(false)
  const [formSubmitted, setFormSubmitted] = useState(false)
  const [completionData, setCompletionData] = useState<Record<string, unknown>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!taskId) return
    const feUrl = process.env.NEXT_PUBLIC_FORM_ENGINE_URL || 'http://localhost:8010'
    const wbUrl = process.env.NEXT_PUBLIC_WORKFLOW_BRIDGE_URL || 'http://localhost:8011'

    const load = async () => {
      try {
        const d = await gql(
          `query($id: ID!) { workflowTask(id: $id) { id instanceId elementName formId assigneeId assigneeRole status dueDate variables } }`,
          { id: taskId }
        )
        const t: WorkflowTask | null = d.workflowTask || null
        setTask(t)

        // Extract pre-populated form data and run_id for agent-run-created tasks
        if (t?.variables) {
          const vars = typeof t.variables === 'string' ? JSON.parse(t.variables) : t.variables as Record<string, unknown>
          if (vars._initial_form_data && Object.keys(vars._initial_form_data as object).length > 0) {
            const ifd = vars._initial_form_data as Record<string, unknown>
            setInitialFormData(ifd)
            setInlineFormData(ifd)
          }
          if (vars._run_id) setAgentRunId(vars._run_id as string)
          if (vars._hitl_fields && Array.isArray(vars._hitl_fields)) setInlineFields(vars._hitl_fields as HitlField[])
          if (vars._hitl_description) setHitlDescription(vars._hitl_description as string)
        }

        if (t?.instanceId) {
          try {
            const ir = await fetch(`${wbUrl}/instances/${t.instanceId}?org_id=${orgId}`)
            if (ir.ok) { const inst = await ir.json(); if (inst.study_id) setInstanceStudyId(inst.study_id) }
          } catch { /* ignore */ }
        }

        if (t?.formId) {
          try {
            const fr = await fetch(`${feUrl}/forms/${t.formId}/render`, {
              headers: { Authorization: `Bearer ${getToken()}` },
            })
            if (fr.ok) {
              const f = await fr.json()
              setFormSchema({ formId: f.form_id, title: f.title, jsonSchema: f.json_schema, uiSchema: f.ui_schema })
            }
          } catch { /* form-engine unavailable */ }
        }
      } catch (e) {
        console.error('Task load error:', e)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [taskId, orgId])

  const handleFormSubmit = async (data: Record<string, unknown>) => {
    if (!task?.formId) return
    setError(null)
    const feUrl = process.env.NEXT_PUBLIC_FORM_ENGINE_URL || 'http://localhost:8010'
    const wbUrl = process.env.NEXT_PUBLIC_WORKFLOW_BRIDGE_URL || 'http://localhost:8011'
    const cgUrl = process.env.NEXT_PUBLIC_CONTEXT_GRAPH_URL || 'http://localhost:8008'

    const resp = await fetch(`${feUrl}/forms/${task.formId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ data, workflow_task_id: task.id, instance_id: task.instanceId }),
    })
    if (!resp.ok) { setError('Form submission failed — please try again.'); return }

    if (data.study_id && task.instanceId) {
      try {
        await fetch(`${wbUrl}/instances/${task.instanceId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ study_id: data.study_id }),
        })
        setInstanceStudyId(data.study_id as string)

        // Trigger context graph build in the background
        fetch(`${cgUrl}/graph/build`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ org_id: orgId, study_id: data.study_id }),
        }).catch(() => { /* non-fatal */ })
      } catch { /* non-fatal */ }
    }

    setCompletionData(data)
    setFormSubmitted(true)
  }

  const handleComplete = async () => {
    setCompleting(true)
    setError(null)
    const _hasInlineForm = inlineFields.length > 0 && !formSchema
    try {
      // Merge inline form data into completion data if no registered form was used
      const finalData = _hasInlineForm ? inlineFormData : completionData
      const json = await gql(
        `mutation($taskId: ID!, $data: JSON) { completeTask(taskId: $taskId, completionData: $data) { id status } }`,
        { taskId, data: finalData }
      )
      if (!json.completeTask) throw new Error('Task completion failed')

      // Resume agent run if this task was created by an agent (has _run_id in variables)
      if (agentRunId) {
        const arUrl = process.env.NEXT_PUBLIC_AGENT_RUNTIME_URL || 'http://localhost:8004'
        await fetch(`${arUrl}/runs/${agentRunId}/resume-from-hitl`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ task_id: taskId, form_data: finalData, completed_by: userId }),
        }).catch(() => { /* non-fatal — run will stay in waiting_human_task but task is marked done */ })
      }

      router.push('/tasks')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete task')
    } finally {
      setCompleting(false)
    }
  }

  if (loading) return <div className="p-6 text-slate-400">Loading task...</div>
  if (!task) return <div className="p-6 text-slate-500">Task not found.</div>

  // Conversation task → full-screen chat UI
  const convConfig = getConvConfig(formSchema)
  if (convConfig) {
    return (
      <ConversationTaskView
        task={task}
        orgId={orgId}
        studyId={instanceStudyId}
        installationId={convConfig.installationId}
        agentName={convConfig.agentName}
        placeholder={convConfig.placeholder}
        contextHint={convConfig.contextHint}
        onCloseTask={handleComplete}
        closing={completing}
      />
    )
  }

  const hasInlineForm = inlineFields.length > 0 && !formSchema

  // Form/upload task → standard layout
  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {error && (
        <div className="flex items-center gap-2 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button onClick={() => router.back()} className="text-slate-400 hover:text-slate-600">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-slate-900">{task.elementName}</h1>
          {task.assigneeRole && <p className="text-xs text-slate-400">Assigned to: <span className="font-medium">{task.assigneeRole}</span></p>}
        </div>
        {agentRunId && (
          <a href={`/agents/runs/${agentRunId}`}
            className="text-xs text-brand-600 hover:underline">
            View agent run →
          </a>
        )}
      </div>

      {/* Instructions from HITL node */}
      {hitlDescription && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800">
          <p className="font-medium mb-1">Instructions</p>
          <p>{hitlDescription}</p>
        </div>
      )}

      {/* Registered form-engine form */}
      {formSchema && !formSubmitted && (
        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <h2 className="font-semibold text-slate-900 mb-4">{formSchema.title}</h2>
          <RichFormRenderer
            schema={formSchema}
            orgId={orgId}
            studyId={instanceStudyId}
            userId={userId}
            initialData={initialFormData}
            onSubmit={handleFormSubmit}
          />
        </div>
      )}

      {/* Inline dynamic form rendered from _hitl_fields (vibe-built agents without registered form_id) */}
      {hasInlineForm && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <h2 className="font-semibold text-slate-900 text-base">Review &amp; Complete</h2>
          {inlineFields.map((field) => (
            <div key={field.name} className="space-y-1.5">
              <label className="block text-sm font-medium text-slate-700">
                {field.label}
                {field.required && <span className="text-red-500 ml-1">*</span>}
              </label>
              {field.description && (
                <p className="text-xs text-slate-400">{field.description}</p>
              )}
              {!field.editable ? (
                <div className="text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                  {inlineFormData[field.name] != null
                    ? (typeof inlineFormData[field.name] === 'object'
                      ? <pre className="text-xs overflow-auto max-h-40">{JSON.stringify(inlineFormData[field.name], null, 2)}</pre>
                      : String(inlineFormData[field.name]))
                    : <span className="text-slate-400 italic">No data</span>}
                </div>
              ) : field.type === 'textarea' ? (
                <textarea
                  rows={4}
                  value={String(inlineFormData[field.name] ?? '')}
                  onChange={e => setInlineFormData(prev => ({ ...prev, [field.name]: e.target.value }))}
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
                />
              ) : field.type === 'boolean' ? (
                <div className="flex items-center gap-2">
                  <input type="checkbox"
                    checked={!!inlineFormData[field.name]}
                    onChange={e => setInlineFormData(prev => ({ ...prev, [field.name]: e.target.checked }))}
                    className="w-4 h-4 text-brand-600 rounded border-slate-300"
                  />
                  <span className="text-sm text-slate-600">Yes</span>
                </div>
              ) : field.type === 'select' && field.options ? (
                <select
                  value={String(inlineFormData[field.name] ?? '')}
                  onChange={e => setInlineFormData(prev => ({ ...prev, [field.name]: e.target.value }))}
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
                >
                  <option value="">— Select —</option>
                  {field.options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              ) : field.type === 'number' ? (
                <input type="number"
                  value={String(inlineFormData[field.name] ?? '')}
                  onChange={e => setInlineFormData(prev => ({ ...prev, [field.name]: e.target.value }))}
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              ) : (
                <input type="text"
                  value={String(inlineFormData[field.name] ?? '')}
                  onChange={e => setInlineFormData(prev => ({ ...prev, [field.name]: e.target.value }))}
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              )}
            </div>
          ))}
          <button
            onClick={() => {
              setCompletionData(inlineFormData)
              setFormSubmitted(true)
            }}
            className="w-full px-4 py-2.5 bg-brand-500 hover:bg-brand-600 text-white rounded-lg text-sm font-semibold transition-colors"
          >
            Submit Review
          </button>
        </div>
      )}

      {(formSubmitted || (!formSchema && !hasInlineForm)) && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          {formSubmitted && (
            <div className="flex items-center gap-2 text-green-600 text-sm">
              <CheckCircle className="w-4 h-4" />Review submitted — ready to complete
            </div>
          )}
          <button
            onClick={handleComplete}
            disabled={completing}
            className="w-full px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-semibold disabled:opacity-60 transition-colors"
          >
            {completing ? 'Completing...' : 'Complete Task & Resume Agent'}
          </button>
        </div>
      )}
    </div>
  )
}

export default function TaskDetailPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading...</div>}>
      <TaskDetailContent />
    </Suspense>
  )
}
