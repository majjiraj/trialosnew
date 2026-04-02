'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  ArrowLeft, CheckCircle, Clock, AlertCircle, PauseCircle, Loader2,
  Download, ChevronDown, ChevronRight, X, XCircle, Copy, Eye, FolderOpen, FileCode, FileSpreadsheet,
  ThumbsUp, ThumbsDown, Shield, Brain, Database, BarChart2, Activity,
  User, Lock, HardDrive, Search, Cpu, UserCheck, FlaskConical, Share2,
  Hash, Link2, Filter, CheckCheck, Minus, Plus, GitCompare, AlertTriangle,
  Globe, Server, Info,
} from 'lucide-react'
import { clsx } from 'clsx'
import {
  RadialBarChart, RadialBar, PieChart, Pie, Cell as RechartsCell,
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { useAuth, useOrgId } from '@/components/layout/AuthContext'
import { AgentReasoningGraph } from '@/components/agent/AgentReasoningGraph'

const GRAPHQL_URL = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
const RUNTIME_URL = process.env.NEXT_PUBLIC_RUNTIME_URL || 'http://localhost:8004'

// ── Artifacts Panel ───────────────────────────────────────────────────────────

function ArtifactsPanel({ artifacts, runId, run }: { artifacts: any[]; runId: string; run: any }) {
  const [viewingIdx, setViewingIdx] = useState<number | null>(null)
  const [viewContent, setViewContent] = useState<string | null>(null)
  const [viewLoading, setViewLoading] = useState(false)

  const isText = (art: any) =>
    art.content_type?.startsWith('text/') ||
    art.name?.endsWith('.py') || art.name?.endsWith('.md') || art.name?.endsWith('.txt')

  const openView = async (i: number) => {
    setViewingIdx(i)
    setViewContent(null)
    setViewLoading(true)
    try {
      const res = await fetch(`${RUNTIME_URL}/runs/${runId}/artifacts/${i}/content`)
      setViewContent(await res.text())
    } catch { setViewContent('Failed to load content.') }
    setViewLoading(false)
  }

  // Folder breadcrumb from s3_key: org/study/artifacts/runId/filename
  const folderPath = (art: any) => {
    const parts = (art.s3_key || '').split('/')
    // Agent Output > Agent Name > Run ID
    return ['Agent Output', run?.agentName || 'Agent', runId.slice(0, 8) + '...']
  }

  const ArtIcon = ({ art }: { art: any }) => {
    if (art.type === 'excel' || art.name?.endsWith('.xlsx'))
      return <FileSpreadsheet className="w-5 h-5 text-green-600" />
    return <FileCode className="w-5 h-5 text-blue-600" />
  }

  if (artifacts.length === 0) {
    return <p className="text-slate-400 text-sm py-8 text-center">No artifacts yet.</p>
  }

  return (
    <div className="space-y-4">
      {/* Folder breadcrumb */}
      <div className="flex items-center gap-1.5 text-xs text-slate-400">
        <FolderOpen className="w-3.5 h-3.5" />
        <span>Agent Output</span>
        <ChevronRight className="w-3 h-3" />
        <span>{run?.agentName || 'Agent'}</span>
        <ChevronRight className="w-3 h-3" />
        <span className="font-mono">{runId.slice(0, 8)}…</span>
      </div>

      {/* File list */}
      <div className="space-y-2">
        {artifacts.map((art: any, i: number) => (
          <div key={i} className="flex items-center gap-3 p-4 bg-white rounded-xl border border-slate-100 hover:border-slate-200 transition-colors">
            <ArtIcon art={art} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-slate-800">{art.name}</p>
              <p className="text-xs text-slate-400 font-mono truncate">{folderPath(art).join(' › ')}</p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {isText(art) && (
                <button onClick={() => openView(i)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium rounded-lg transition-colors">
                  <Eye className="w-3.5 h-3.5" /> View
                </button>
              )}
              <a href={`${RUNTIME_URL}/runs/${runId}/artifacts/${i}/download`}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-500 hover:bg-brand-600 text-white text-xs font-medium rounded-lg transition-colors">
                <Download className="w-3.5 h-3.5" /> Download
              </a>
            </div>
          </div>
        ))}
      </div>

      {/* Inline viewer modal */}
      {viewingIdx !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <FileCode className="w-4 h-4 text-brand-500" />
                <span className="font-semibold text-slate-800 text-sm">{artifacts[viewingIdx]?.name}</span>
              </div>
              <div className="flex items-center gap-2">
                <a href={`${RUNTIME_URL}/runs/${runId}/artifacts/${viewingIdx}/download`}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-500 hover:bg-brand-600 text-white text-xs font-medium rounded-lg">
                  <Download className="w-3.5 h-3.5" /> Download
                </a>
                <button onClick={() => { setViewingIdx(null); setViewContent(null) }}
                  className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="overflow-auto flex-1 p-5">
              {viewLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-5 h-5 animate-spin text-brand-500" />
                </div>
              ) : (
                <pre className="text-xs font-mono text-slate-700 whitespace-pre-wrap leading-relaxed">{viewContent}</pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

async function gql(query: string, variables = {}) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ query, variables }),
  })
  const { data, errors } = await res.json()
  if (errors?.length) throw new Error(errors[0].message)
  return data
}

const ACTIVE_STATUSES = new Set(['running', 'pending', 'waiting_approval', 'waiting_human_task'])

const STATUS_BADGE: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
  pending:             { label: 'Pending',        cls: 'bg-slate-100 text-slate-600',   icon: <Clock className="w-3.5 h-3.5" /> },
  running:             { label: 'Running',        cls: 'bg-blue-50 text-blue-700',      icon: <Loader2 className="w-3.5 h-3.5 animate-spin" /> },
  waiting_approval:    { label: 'Needs Review',   cls: 'bg-amber-50 text-amber-700',    icon: <PauseCircle className="w-3.5 h-3.5" /> },
  waiting_human_task:  { label: 'Awaiting Human', cls: 'bg-purple-50 text-purple-700',  icon: <UserCheck className="w-3.5 h-3.5" /> },
  completed:           { label: 'Completed',      cls: 'bg-green-50 text-green-700',    icon: <CheckCircle className="w-3.5 h-3.5" /> },
  failed:              { label: 'Failed',          cls: 'bg-red-50 text-red-700',        icon: <AlertCircle className="w-3.5 h-3.5" /> },
  cancelled:           { label: 'Cancelled',       cls: 'bg-slate-100 text-slate-500',   icon: <X className="w-3.5 h-3.5" /> },
}

const STEP_ICONS: Record<string, React.ReactNode> = {
  completed: <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0" />,
  running:   <Loader2 className="w-5 h-5 text-blue-500 animate-spin flex-shrink-0" />,
  waiting:   <PauseCircle className="w-5 h-5 text-amber-500 flex-shrink-0" />,
  failed:    <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />,
  rejected:  <XCircle className="w-5 h-5 text-red-500 flex-shrink-0" />,
}

const TRACE_TYPE_CONFIG: Record<string, { label: string; cls: string }> = {
  tool_call:  { label: 'Retrieval',  cls: 'bg-blue-50 text-blue-700' },
  synthesis:  { label: 'Synthesis',  cls: 'bg-purple-50 text-purple-700' },
  reasoning:  { label: 'Reasoning',  cls: 'bg-amber-50 text-amber-700' },
  output:     { label: 'Output',     cls: 'bg-green-50 text-green-700' },
}

const MISTAKE_TYPE_CONFIG: Record<string, { label: string; cls: string }> = {
  hallucination:    { label: 'HALLUCINATION',   cls: 'bg-red-100 text-red-700 border border-red-300' },
  wrong_source:     { label: 'WRONG SOURCE',    cls: 'bg-orange-100 text-orange-700 border border-orange-300' },
  scope_violation:  { label: 'SCOPE VIOLATION', cls: 'bg-amber-100 text-amber-700 border border-amber-300' },
}

const VERDICT_CONFIG: Record<string, { cls: string; dotCls: string }> = {
  pass:    { cls: 'bg-green-100 text-green-700',  dotCls: 'bg-green-400' },
  partial: { cls: 'bg-amber-100 text-amber-700',  dotCls: 'bg-amber-400' },
  fail:    { cls: 'bg-red-100 text-red-700',      dotCls: 'bg-red-400' },
  unknown: { cls: 'bg-slate-100 text-slate-600',  dotCls: 'bg-slate-300' },
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100)
  const color = pct >= 80 ? 'bg-green-500' : pct >= 60 ? 'bg-amber-400' : 'bg-red-400'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className={clsx('h-full rounded-full', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-slate-500 flex-shrink-0">{pct}%</span>
    </div>
  )
}

function hasStagePayload(payload: any) {
  return !!payload && typeof payload === 'object' && Object.keys(payload).length > 0
}

function RetrievalPlanCard({ payload }: { payload: any }) {
  if (!hasStagePayload(payload)) return null
  const mode = payload.retrieval_mode || payload.retrieval_mode
  const isNoRetrieval = mode === 'no_retrieval_required'
  const isAutoGenerated = payload.auto_generated === true
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide mb-2">B. Retrieval Plan</p>
      {/* Auto-generated warning */}
      {isAutoGenerated && (
        <div className="flex items-center gap-1.5 text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-2">
          <span>⚠</span> Auto-generated retrieval plan — explicit plan not provided by trace emitter.
        </div>
      )}
      {/* No-retrieval banner */}
      {isNoRetrieval && !isAutoGenerated && (
        <div className="flex items-center gap-1.5 text-[10px] text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1 mb-2">
          <span>✓</span> No retrieval required — output consumed pre-approved evidence from prior phase.
        </div>
      )}
      {/* Key fields */}
      <div className="space-y-1 mb-2">
        {mode && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-slate-400 w-36 flex-shrink-0">Mode</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
              isNoRetrieval ? 'bg-green-50 text-green-700' :
              mode === 'hybrid' ? 'bg-purple-50 text-purple-700' :
              'bg-blue-50 text-blue-700'}`}>{mode.replace(/_/g, ' ')}</span>
          </div>
        )}
        {payload.retrieval_recipe && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-slate-400 w-36 flex-shrink-0">Recipe</span>
            <span className="text-[10px] text-slate-600 font-mono">{payload.retrieval_recipe}</span>
          </div>
        )}
        {payload.evidence_source && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-slate-400 w-36 flex-shrink-0">Evidence Source</span>
            <span className="text-[10px] text-slate-600">{payload.evidence_source.replace(/_/g, ' ')}</span>
          </div>
        )}
        {payload.selected_evidence_count != null && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-slate-400 w-36 flex-shrink-0">Evidence Selected</span>
            <span className="text-[10px] text-slate-600">{payload.selected_evidence_count} / {payload.candidate_sources_considered ?? '—'} candidates</span>
          </div>
        )}
      </div>
      {/* Retrieval rationale */}
      {payload.retrieval_rationale && (
        <div className="bg-white border border-slate-100 rounded px-2 py-1.5 mb-2">
          <p className="text-[9px] font-semibold text-slate-400 uppercase mb-0.5">Rationale</p>
          <p className="text-[10px] text-slate-600 leading-relaxed">{payload.retrieval_rationale}</p>
        </div>
      )}
      {/* Upstream phases relied on */}
      {Array.isArray(payload.upstream_phases_relied_on) && payload.upstream_phases_relied_on.length > 0 && (
        <div className="mb-2">
          <p className="text-[9px] font-semibold text-slate-400 uppercase mb-0.5">Upstream phases</p>
          <div className="flex flex-wrap gap-1">
            {payload.upstream_phases_relied_on.map((ph: string) => (
              <span key={ph} className="text-[9px] px-1.5 py-0.5 bg-indigo-50 text-indigo-600 rounded font-medium">
                {ph.replace(/_/g, ' ')}
              </span>
            ))}
          </div>
        </div>
      )}
      {/* Queries */}
      {Array.isArray(payload.retrieval_queries) && payload.retrieval_queries.length > 0 && (
        <div>
          <p className="text-[9px] font-semibold text-slate-400 uppercase mb-0.5">Queries</p>
          <div className="space-y-1">
            {payload.retrieval_queries.map((q: any, qi: number) => {
              if (typeof q === 'string') {
                return <p key={qi} className="text-[10px] text-slate-500 italic">"{q}"</p>
              }
              // Object form: { query, top_k, domain, purpose, query_type, anchor_vars, results_returned }
              return (
                <div key={qi} className="text-[10px] bg-white border border-slate-100 rounded px-2 py-1 space-y-0.5">
                  {q.query && <p className="text-slate-600 italic">"{q.query}"</p>}
                  <div className="flex flex-wrap gap-1">
                    {q.domain    && <span className="px-1 py-0.5 bg-indigo-50 text-indigo-600 rounded text-[9px] font-medium">{q.domain}</span>}
                    {q.query_type && <span className="px-1 py-0.5 bg-purple-50 text-purple-600 rounded text-[9px] font-medium">{q.query_type.replace(/_/g, ' ')}</span>}
                    {q.purpose   && <span className="px-1 py-0.5 bg-slate-100 text-slate-500 rounded text-[9px]">{q.purpose}</span>}
                    {q.top_k     != null && <span className="px-1 py-0.5 bg-slate-100 text-slate-500 rounded text-[9px]">top_k={q.top_k}</span>}
                    {q.results_returned != null && <span className="px-1 py-0.5 bg-green-50 text-green-700 rounded text-[9px]">{q.results_returned} results</span>}
                    {Array.isArray(q.anchor_vars) && q.anchor_vars.length > 0 && (
                      <span className="px-1 py-0.5 bg-amber-50 text-amber-700 rounded text-[9px] font-mono">{q.anchor_vars.join(', ')}</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function StagePayloadCard({ title, payload }: { title: string; payload: any }) {
  if (!hasStagePayload(payload)) return null
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide mb-1">{title}</p>
      <pre className="text-[11px] text-slate-700 whitespace-pre-wrap break-words font-mono">
        {JSON.stringify(payload, null, 2)}
      </pre>
    </div>
  )
}

function toTitleCase(value: string) {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function getTraceWhatLabel(trace: any, fallbackLabel: string, isDeterministic: boolean) {
  const ctx = trace.inputContext || {}
  const intent = trace.intentResolution?.inferred_intent
  const taskClass = trace.intentResolution?.inferred_task_class
  const outputSchema = trace.answerConstruction?.output_schema
  const retrievalMode = trace.retrievalPlan?.retrieval_mode
  const tools = Array.isArray(trace.executionMode?.tools_invoked) ? trace.executionMode.tools_invoked : []

  if (trace.traceType === 'tool_call') {
    const query = ctx.query || ctx.user_message || trace.intentResolution?.raw_user_query
    return query ? `Knowledge Retrieval - ${query}` : 'Knowledge Retrieval'
  }

  if (intent === 'protocol_to_usdm_conversion') {
    const filename = ctx.filename || ctx.protocol_filename
    return filename ? `Protocol to USDM Conversion - ${filename}` : 'Protocol to USDM Conversion'
  }

  if (intent === 'approval_and_publish') {
    return 'Approval and Artifact Publication'
  }

  if (trace.traceType === 'synthesis') {
    const model = [ctx.provider, ctx.model].filter(Boolean).join('/')
    return model ? `Answer Synthesis - ${model}` : 'Answer Synthesis'
  }

  if (isDeterministic) {
    return 'Deterministic Answer Generation'
  }

  if (intent || taskClass || outputSchema) {
    const parts = [intent ? toTitleCase(intent) : '', taskClass ? toTitleCase(taskClass) : '', outputSchema ? toTitleCase(outputSchema) : '']
      .filter(Boolean)
    if (parts.length > 0) return parts.join(' - ')
  }

  if (retrievalMode || tools.length > 0) {
    const parts = [retrievalMode ? toTitleCase(retrievalMode) : '', tools.length > 0 ? `${tools.length} Tool${tools.length === 1 ? '' : 's'}` : '']
      .filter(Boolean)
    if (parts.length > 0) return parts.join(' - ')
  }

  return fallbackLabel
}

function getTraceWhyLabel(trace: any, isDeterministic: boolean) {
  const intent = trace.intentResolution?.inferred_intent
  const retrievalMode = trace.retrievalPlan?.retrieval_mode
  const evidenceType = trace.evidenceAssembly?.evidence_type
  const tools = Array.isArray(trace.executionMode?.tools_invoked) ? trace.executionMode.tools_invoked : []
  const outputSchema = trace.answerConstruction?.output_schema

  if (intent === 'protocol_to_usdm_conversion') {
    return 'Transform the source protocol into a structured USDM v4 model using the implementation guide and prior approved examples.'
  }

  if (intent === 'approval_and_publish') {
    return 'Capture the approval decision and publish the approved artifact so the workflow completes with an auditable output.'
  }

  if (trace.traceType === 'tool_call') {
    return 'Retrieve relevant context to ground the answer in verified clinical data.'
  }

  if (trace.traceType === 'reasoning') {
    if (evidenceType) {
      return `Combine ${String(evidenceType).replaceAll('_', ' ')} evidence into a decision-ready intermediate result.`
    }
    if (retrievalMode === 'hybrid') {
      return 'Combine retrieved protocol context, implementation guide content, and prior examples into the workflow reasoning step.'
    }
    if (tools.length > 0) {
      return 'Advance the workflow by coordinating the required tools and intermediate evidence.'
    }
    return 'Interpret the available context and produce the next workflow reasoning state.'
  }

  if (trace.traceType === 'synthesis') {
    return 'Synthesize the collected evidence into a user-readable answer.'
  }

  if (isDeterministic) {
    return 'Use a deterministic path instead of an LLM when the workflow can be resolved from structured logic.'
  }

  if (outputSchema) {
    return `Produce the final ${String(outputSchema).replaceAll('_', ' ')} output for the workflow.`
  }

  if (trace.traceType === 'output') {
    return 'Deliver the final answer and record output artifacts.'
  }

  return 'Record why this workflow step occurred and what evidence supported it.'
}

function TraceFeedback({ traceId, orgId, userId }: { traceId: string; orgId: string; userId: string }) {
  const [state, setState] = useState<'idle' | 'correcting' | 'done'>('idle')
  const [correction, setCorrection] = useState('')
  const [busy, setBusy] = useState(false)

  const send = async (type: string, value: object) => {
    setBusy(true)
    try {
      await gql(
        `mutation($input: ContextFeedbackInput!) { submitContextFeedback(input: $input) }`,
        { input: { decisionTraceId: traceId, orgId, feedbackType: type, feedbackValue: value, submittedBy: userId } }
      )
      setState('done')
    } catch { /* silent */ } finally { setBusy(false) }
  }

  if (state === 'done') return (
    <p className="text-xs text-green-600 flex items-center gap-1">
      <CheckCircle className="w-3 h-3" /> Feedback recorded
    </p>
  )
  return (
    <div className="space-y-2">
      {state === 'idle' && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">Was this helpful?</span>
          <button disabled={busy} onClick={() => send('endorsement', { reason: 'helpful' })}
            className="flex items-center gap-1 px-2 py-1 text-xs text-green-600 bg-green-50 hover:bg-green-100 rounded-md disabled:opacity-50">
            <ThumbsUp className="w-3 h-3" /> Yes
          </button>
          <button disabled={busy} onClick={() => setState('correcting')}
            className="flex items-center gap-1 px-2 py-1 text-xs text-red-600 bg-red-50 hover:bg-red-100 rounded-md disabled:opacity-50">
            <ThumbsDown className="w-3 h-3" /> No / Correct it
          </button>
        </div>
      )}
      {state === 'correcting' && (
        <div className="space-y-2">
          <textarea value={correction} onChange={e => setCorrection(e.target.value)}
            placeholder="What should the correct answer be?"
            rows={2}
            className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-400 resize-none" />
          <div className="flex gap-2">
            <button onClick={() => send('correction', { corrected_text: correction, reason: 'user_correction' })}
              disabled={!correction.trim() || busy}
              className="px-3 py-1 text-xs bg-brand-500 text-white rounded-lg hover:bg-brand-600 disabled:opacity-40">
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Submit Correction'}
            </button>
            <button onClick={() => setState('idle')}
              className="px-3 py-1 text-xs border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function MetricCard({
  label, value, sub, colorCls,
}: { label: string; value: React.ReactNode; sub?: string; colorCls?: string }) {
  return (
    <div className="bg-white rounded-xl border border-slate-100 p-4">
      <p className="text-xs text-slate-400 mb-1">{label}</p>
      <p className={clsx('text-xl font-semibold', colorCls || 'text-slate-800')}>{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
    </div>
  )
}

function formatTs(ts: string) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' })
}

function formatDuration(start: string, end: string) {
  if (!start || !end) return null
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// ── Audit Log infrastructure ─────────────────────────────────────────────────

type AuditCategory =
  | 'identity_access'
  | 'data_lifecycle'
  | 'retrieval'
  | 'reasoning'
  | 'human_oversight'
  | 'validation'
  | 'output_distribution'

interface AuditCategoryMeta {
  label: string
  icon: React.ElementType
  border: string
  bg: string
  badge: string
  text: string
}

const AUDIT_CATEGORY_META: Record<AuditCategory, AuditCategoryMeta> = {
  identity_access:     { label: 'Identity & Access',  icon: Lock,         border: 'border-l-blue-500',   bg: 'bg-blue-50',   badge: 'bg-blue-100 text-blue-700',   text: 'text-blue-600' },
  data_lifecycle:      { label: 'Data Lifecycle',     icon: HardDrive,    border: 'border-l-violet-500', bg: 'bg-violet-50', badge: 'bg-violet-100 text-violet-700',text: 'text-violet-600' },
  retrieval:           { label: 'Retrieval',          icon: Search,       border: 'border-l-purple-500', bg: 'bg-purple-50', badge: 'bg-purple-100 text-purple-700',text: 'text-purple-600' },
  reasoning:           { label: 'Reasoning',          icon: Cpu,          border: 'border-l-amber-500',  bg: 'bg-amber-50',  badge: 'bg-amber-100 text-amber-700',  text: 'text-amber-600' },
  human_oversight:     { label: 'Human Oversight',   icon: UserCheck,    border: 'border-l-teal-500',   bg: 'bg-teal-50',   badge: 'bg-teal-100 text-teal-700',   text: 'text-teal-600' },
  validation:          { label: 'Validation',         icon: FlaskConical, border: 'border-l-green-500',  bg: 'bg-green-50',  badge: 'bg-green-100 text-green-700', text: 'text-green-600' },
  output_distribution: { label: 'Output & Distribution', icon: Share2,   border: 'border-l-rose-500',   bg: 'bg-rose-50',   badge: 'bg-rose-100 text-rose-700',   text: 'text-rose-600' },
}

const CATEGORY_ACTION_MAP: Array<[RegExp, AuditCategory]> = [
  [/login|logout|auth|permission|role|access.request|grant|revoke|invocation.auth|session.start/i, 'identity_access'],
  [/dataset|file.upload|ingest|parse|chunk|embed|index|transform|quarantine|archive|delete|version.creat|data\.intake/i, 'data_lifecycle'],
  [/retriev|context\.retrieval|context.request|evidence|recipe|filter|search|context.pack/i, 'retrieval'],
  [/prompt|model.invok|tool.invok|workflow.execut|llm|generate|reason|execution/i, 'reasoning'],
  [/correction|feedback|approval|reject|override|annotation|human|review|re-run|hitl/i, 'human_oversight'],
  [/validat|quality|hallucin|confidence|score|sla|groundedness|check|phi\.scan/i, 'validation'],
  [/export|download|distribut|artifact\.generated|artifact|report|output.shown|sent.to|answer.shown/i, 'output_distribution'],
]

function classifyAuditEvent(ev: any): AuditCategory {
  const key = `${ev.action || ''} ${ev.resourceType || ''}`
  for (const [re, cat] of CATEGORY_ACTION_MAP) {
    if (re.test(key)) return cat
  }
  // fallback by actorType
  if (ev.actorType === 'user') return 'human_oversight'
  if (ev.actorType === 'agent') return 'reasoning'
  return 'data_lifecycle'
}

// Helper to safely get metadata field
function mf(meta: any, ...keys: string[]): any {
  if (!meta || typeof meta !== 'object') return undefined
  for (const k of keys) if (meta[k] !== undefined && meta[k] !== null && meta[k] !== '') return meta[k]
  return undefined
}

function CopyBtn({ value }: { value: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500) }}
      className="ml-1 text-slate-400 hover:text-slate-600 transition-colors"
    >
      {done ? <CheckCheck className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
    </button>
  )
}

function AuditFieldRow({ label, value, mono = false, copyable = false }: {
  label: string; value: React.ReactNode; mono?: boolean; copyable?: boolean
}) {
  if (value === null || value === undefined || value === '' || value === '—') return null
  const strVal = typeof value === 'string' ? value : undefined
  return (
    <div>
      <p className="text-[10px] text-slate-400 uppercase tracking-wide font-medium mb-0.5">{label}</p>
      <div className={`flex items-start gap-1 text-xs ${mono ? 'font-mono' : ''} text-slate-700`}>
        <span className="break-all flex-1">{value}</span>
        {copyable && strVal && <CopyBtn value={strVal} />}
      </div>
    </div>
  )
}

function AuditStateDiff({ before, after }: { before: any; after: any }) {
  if (!before && !after) return null
  const b = before && typeof before === 'object' ? before : (typeof before === 'string' ? JSON.parse(before) : null)
  const a = after  && typeof after  === 'object' ? after  : (typeof after  === 'string' ? JSON.parse(after)  : null)
  const allKeys = Array.from(new Set([...Object.keys(b || {}), ...Object.keys(a || {})]))
  if (allKeys.length === 0) return null
  return (
    <div>
      <p className="text-[10px] text-slate-400 uppercase tracking-wide font-medium mb-1.5 flex items-center gap-1">
        <GitCompare className="w-3 h-3" /> State Change
      </p>
      <div className="rounded-lg border border-slate-200 overflow-hidden text-[11px] font-mono">
        <div className="grid grid-cols-2 border-b border-slate-200">
          <div className="px-2 py-1 bg-red-50 text-red-600 font-semibold text-[10px] flex items-center gap-1"><Minus className="w-3 h-3" />Before</div>
          <div className="px-2 py-1 bg-green-50 text-green-600 font-semibold text-[10px] flex items-center gap-1 border-l border-slate-200"><Plus className="w-3 h-3" />After</div>
        </div>
        {allKeys.map(k => {
          const bv = b?.[k]
          const av = a?.[k]
          const changed = JSON.stringify(bv) !== JSON.stringify(av)
          return (
            <div key={k} className={`grid grid-cols-2 border-b border-slate-100 last:border-0 ${changed ? 'bg-amber-50/40' : ''}`}>
              <div className="px-2 py-1 text-red-700 border-r border-slate-200">
                <span className="text-slate-400">{k}: </span>
                {bv !== undefined ? String(typeof bv === 'object' ? JSON.stringify(bv) : bv) : <span className="text-slate-300 italic">—</span>}
              </div>
              <div className="px-2 py-1 text-green-700">
                <span className="text-slate-400">{k}: </span>
                {av !== undefined ? String(typeof av === 'object' ? JSON.stringify(av) : av) : <span className="text-slate-300 italic">—</span>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function AuditEventDetail({ ev, category }: { ev: any; category: AuditCategory }) {
  const meta = ev.metadata && typeof ev.metadata === 'object' ? ev.metadata
    : (typeof ev.metadata === 'string' ? (() => { try { return JSON.parse(ev.metadata) } catch { return {} } })() : {})

  const catMeta = AUDIT_CATEGORY_META[category]

  return (
    <div className="border-t border-slate-100 bg-white">
      {/* WHO / WHEN / WHAT summary bar */}
      <div className={`grid grid-cols-2 sm:grid-cols-4 gap-3 px-4 py-3 ${catMeta.bg} border-b border-slate-100`}>
        <div>
          <p className="text-[9px] text-slate-500 uppercase tracking-widest font-semibold mb-0.5">WHO</p>
          <p className="text-xs font-semibold text-slate-800 truncate">{ev.actorId || ev.actorType || '—'}</p>
          <p className="text-[10px] text-slate-500 capitalize">{ev.actorType}</p>
        </div>
        <div>
          <p className="text-[9px] text-slate-500 uppercase tracking-widest font-semibold mb-0.5">WHEN</p>
          <p className="text-xs font-semibold text-slate-800">{new Date(ev.timestamp).toLocaleTimeString()}</p>
          <p className="text-[10px] text-slate-500">{new Date(ev.timestamp).toLocaleDateString()}</p>
        </div>
        <div>
          <p className="text-[9px] text-slate-500 uppercase tracking-widest font-semibold mb-0.5">WHAT</p>
          <p className="text-xs font-semibold text-slate-800 truncate">{ev.action}</p>
          <p className="text-[10px] text-slate-500">{ev.resourceType}</p>
        </div>
        <div>
          <p className="text-[9px] text-slate-500 uppercase tracking-widest font-semibold mb-0.5">RESULT</p>
          <p className="text-xs font-semibold text-slate-800">{mf(meta,'outcome','result','status') || '—'}</p>
          <p className="text-[10px] text-slate-500">{mf(meta,'access_decision') || ''}</p>
        </div>
      </div>

      <div className="px-4 py-4 space-y-4">
        {/* Identity & provenance */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* ON WHAT — Dataset Version Provenance */}
          <div className="space-y-2">
            <p className={`text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 ${catMeta.text}`}>
              <Database className="w-3 h-3" /> On What
            </p>
            <AuditFieldRow label="Resource ID"        value={ev.resourceId}                                    mono copyable />
            <AuditFieldRow label="Resource Type"      value={ev.resourceType} />
            <AuditFieldRow label="Dataset Version"    value={mf(meta,'dataset_version','datasetVersion')}       mono />
            <AuditFieldRow label="Schema Version"     value={mf(meta,'schema_version')}                         mono />
            <AuditFieldRow label="Dataset Checksum"   value={mf(meta,'dataset_checksum','checksum','sha256')}   mono copyable />
            <AuditFieldRow label="File ID(s)"         value={mf(meta,'file_ids','fileIds') ? String(mf(meta,'file_ids','fileIds')) : undefined} mono />
            <AuditFieldRow label="Context Pack Hash"  value={mf(meta,'context_pack_hash')}                      mono copyable />
            <AuditFieldRow label="Agent Version"      value={mf(meta,'agent_version')}                          mono />
          </div>

          {/* WHY & POLICY — Authorization + Policy Enforcement */}
          <div className="space-y-2">
            <p className={`text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 ${catMeta.text}`}>
              <Shield className="w-3 h-3" /> Why &amp; Policy
            </p>
            <AuditFieldRow label="Reason"             value={mf(meta,'reason','justification','why')} />
            <AuditFieldRow label="Policy Applied"     value={mf(meta,'policy_applied','policy','opa_policy')} />
            <AuditFieldRow label="Policy Outcome"     value={mf(meta,'policy_enforcement_outcome','policy_outcome')} />
            <AuditFieldRow label="Authorization"      value={mf(meta,'access_decision','authorization','user_authorization')} />
            <AuditFieldRow label="Auth Method"        value={mf(meta,'auth_method')} />
            <AuditFieldRow label="Role"               value={mf(meta,'role','user_role','reviewer_role')} />
            <AuditFieldRow label="Triggered By"       value={mf(meta,'triggered_by_user_id','assigned_to')}     mono />
            <AuditFieldRow label="Test Run"           value={ev.isTestRun != null ? (ev.isTestRun ? '⚠ Yes (non-production)' : '✓ Production') : undefined} />
          </div>
        </div>

        {/* WITH WHICH VERSION — Model / Prompt / Recipe */}
        {(mf(meta,'model_id','model') || mf(meta,'agent_type') || mf(meta,'prompt_template_version') || mf(meta,'parser_version') || mf(meta,'chunker_version') || mf(meta,'retrieval_recipe_id','retrieval_recipe') || mf(meta,'tool_ids')) && (
          <div className="space-y-2">
            <p className={`text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 ${catMeta.text}`}>
              <Server className="w-3 h-3" /> With Which Version
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <AuditFieldRow label="Model"                  value={mf(meta,'model_id','model')}                      mono />
              <AuditFieldRow label="Agent Type"             value={mf(meta,'agent_type')}                             mono />
              <AuditFieldRow label="Agent Version"          value={mf(meta,'agent_version')}                          mono />
              <AuditFieldRow label="Prompt Template ver."   value={mf(meta,'prompt_template_version')}                mono />
              <AuditFieldRow label="Parser Version"         value={mf(meta,'parser_version')}                         mono />
              <AuditFieldRow label="Chunker Version"        value={mf(meta,'chunker_version')}                        mono />
              <AuditFieldRow label="Transform Version"      value={mf(meta,'transformation_version')}                 mono />
              <AuditFieldRow label="Retrieval Recipe"       value={mf(meta,'retrieval_recipe_id','retrieval_recipe')} mono copyable />
              <AuditFieldRow label="Tool IDs"               value={mf(meta,'tool_ids') ? String(mf(meta,'tool_ids')) : undefined} mono />
            </div>
          </div>
        )}

        {/* RAW vs CURATED CONTEXT — shown for retrieval events */}
        {(mf(meta,'knowledge_source') || mf(meta,'raw_context_source') || mf(meta,'curated_context_source') || mf(meta,'context_type') || mf(meta,'ig_sections_retrieved') || mf(meta,'retrieval_gap_note')) && (
          <div className="space-y-2">
            <p className={`text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 ${catMeta.text}`}>
              <Search className="w-3 h-3" /> Raw vs. Curated Context
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <AuditFieldRow label="Knowledge Source"        value={mf(meta,'knowledge_source')} />
              <AuditFieldRow label="Context Type"            value={mf(meta,'context_type')} />
              <AuditFieldRow label="Raw Context Source"      value={mf(meta,'raw_context_source')} />
              <AuditFieldRow label="Curated Context Source"  value={mf(meta,'curated_context_source')} />
              <AuditFieldRow label="Retrieval Mode"          value={mf(meta,'retrieval_mode')} />
              <AuditFieldRow label="Retrieval Recipe"        value={mf(meta,'retrieval_recipe')}                   mono />
              <AuditFieldRow label="Candidates Fetched"      value={mf(meta,'candidates_fetched') != null ? String(mf(meta,'candidates_fetched')) : undefined} />
              <AuditFieldRow label="Queries Run"             value={mf(meta,'query_count') != null ? String(mf(meta,'query_count')) : undefined} />
            </div>
            {Array.isArray(mf(meta,'ig_sections_retrieved')) && (
              <div>
                <p className="text-[9px] font-semibold text-slate-400 uppercase mb-1">Sections Retrieved</p>
                <div className="space-y-0.5 max-h-32 overflow-y-auto pr-1">
                  {(mf(meta,'ig_sections_retrieved') as string[]).map((s: string, i: number) => (
                    <p key={i} className="text-[10px] text-slate-600 bg-slate-50 rounded px-2 py-0.5 border border-slate-100">§ {s}</p>
                  ))}
                </div>
              </div>
            )}
            {mf(meta,'retrieval_gap_note') && (
              <div className="bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                <p className="text-[9px] font-semibold text-amber-700 uppercase mb-0.5">Retrieval Gap Note</p>
                <p className="text-[10px] text-amber-800">{mf(meta,'retrieval_gap_note')}</p>
              </div>
            )}
          </div>
        )}

        {/* CORRECTIONS & OVERRIDES — human modifications */}
        {(mf(meta,'corrections_applied') != null || mf(meta,'human_overrides') || mf(meta,'modification_summary') || mf(meta,'human_modifications')) && (
          <div className="space-y-2">
            <p className={`text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 ${catMeta.text}`}>
              <UserCheck className="w-3 h-3" /> Corrections &amp; Overrides
            </p>
            <AuditFieldRow label="Corrections Applied"    value={mf(meta,'corrections_applied') != null ? `${mf(meta,'corrections_applied')} correction(s)` : undefined} />
            <AuditFieldRow label="Modification Summary"   value={mf(meta,'modification_summary')} />
            <AuditFieldRow label="Override Reason"        value={mf(meta,'override_reason')} />
            {Array.isArray(mf(meta,'human_modifications')) && (mf(meta,'human_modifications') as any[]).length > 0 && (
              <div>
                <p className="text-[9px] font-semibold text-slate-400 uppercase mb-1">Human Modifications</p>
                <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                  {(mf(meta,'human_modifications') as any[]).map((mod: any, i: number) => (
                    <div key={i} className="text-[10px] bg-amber-50 border border-amber-100 rounded px-2 py-1">
                      <span className="font-semibold text-amber-700">{mod.type?.replace(/_/g, ' ')}</span>
                      {' · '}<span className="text-slate-600">{mod.domain}</span>
                      {' · '}<span className="font-mono text-slate-700">{mod.source_column} → {mod.sdtm_variable || '—'}</span>
                      {mod.description && <p className="text-slate-500 mt-0.5">{mod.description}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {Array.isArray(mf(meta,'human_overrides')) && (
              <div>
                <p className="text-[9px] font-semibold text-slate-400 uppercase mb-1">Overrides</p>
                <pre className="text-[10px] font-mono text-slate-600 bg-slate-50 rounded p-2 border border-slate-100 whitespace-pre-wrap">
                  {JSON.stringify(mf(meta,'human_overrides'), null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}

        {/* MASKING RULES APPLIED */}
        {(mf(meta,'masking_rules') || mf(meta,'masking_rules_applied') || mf(meta,'masked_fields') || (mf(meta,'masking_applied') != null && mf(meta,'scan_method'))) && (
          <div className="space-y-2">
            <p className={`text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 ${catMeta.text}`}>
              <Lock className="w-3 h-3" /> Masking Rules Applied
            </p>
            <AuditFieldRow label="Masking Applied"    value={mf(meta,'masking_applied') != null ? (mf(meta,'masking_applied') ? '✓ Yes' : '✗ Not required') : undefined} />
            <AuditFieldRow label="Scan Method"        value={mf(meta,'scan_method')} />
            <AuditFieldRow label="Scan Result"        value={mf(meta,'scan_result')} />
            <AuditFieldRow label="Masking Method"     value={mf(meta,'masking_method')} />
            {Array.isArray(mf(meta,'masking_rules','masking_rules_applied')) && (
              <div>
                <p className="text-[9px] font-semibold text-slate-400 uppercase mb-0.5">Rules</p>
                <div className="space-y-1">
                  {(mf(meta,'masking_rules','masking_rules_applied') as any[]).map((r: any, i: number) => {
                    if (typeof r === 'string') {
                      return <span key={r} className="text-[9px] px-1.5 py-0.5 bg-orange-50 text-orange-700 rounded font-medium inline-block mr-1 mb-1">{r}</span>
                    }
                    return (
                      <div key={i} className="text-[10px] bg-orange-50 border border-orange-100 rounded px-2 py-1 flex items-start gap-2">
                        <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded mt-0.5 ${r.result === 'passed' || r.result === 'no_match' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{r.result ?? 'checked'}</span>
                        <div>
                          <p className="font-semibold text-orange-800 font-mono">{r.rule}</p>
                          {r.description && <p className="text-slate-500 mt-0.5">{r.description}</p>}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            {Array.isArray(mf(meta,'masked_fields')) && (
              <div>
                <p className="text-[9px] font-semibold text-slate-400 uppercase mb-0.5">Masked Fields</p>
                <div className="flex flex-wrap gap-1">
                  {(mf(meta,'masked_fields') as string[]).map((f: string) => (
                    <span key={f} className="text-[9px] px-1.5 py-0.5 bg-red-50 text-red-700 rounded font-mono">{f}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* POLICY ENFORCEMENT RECORD */}
        {(mf(meta,'policy_enforcement_log') || mf(meta,'regulatory_basis') || (mf(meta,'compliant_with') && !mf(meta,'phi_detected') && !mf(meta,'scan_result'))) && (
          <div className="space-y-2">
            <p className={`text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 ${catMeta.text}`}>
              <Shield className="w-3 h-3" /> Policy Enforcement Record
            </p>
            <AuditFieldRow label="Policy Applied"       value={mf(meta,'policy_applied','policy')} />
            <AuditFieldRow label="Policy Outcome"       value={mf(meta,'policy_enforcement_outcome')} />
            <AuditFieldRow label="Review Required By"   value={mf(meta,'review_required_by')} />
            <AuditFieldRow label="Regulatory Basis"     value={mf(meta,'regulatory_basis')} />
            {Array.isArray(mf(meta,'compliant_with')) && (
              <div>
                <p className="text-[9px] font-semibold text-slate-400 uppercase mb-0.5">Frameworks</p>
                <div className="flex flex-wrap gap-1">
                  {(mf(meta,'compliant_with') as string[]).map((f: string) => (
                    <span key={f} className="text-[9px] px-1.5 py-0.5 bg-green-100 text-green-800 rounded font-medium">{f}</span>
                  ))}
                </div>
              </div>
            )}
            {mf(meta,'policy_enforcement_log') && (
              <div>
                <p className="text-[9px] font-semibold text-slate-400 uppercase mb-1">Enforcement Log</p>
                {Array.isArray(mf(meta,'policy_enforcement_log')) ? (
                  <div className="space-y-1">
                    {(mf(meta,'policy_enforcement_log') as any[]).map((entry: any, i: number) => (
                      <div key={i} className="text-[10px] bg-slate-50 border border-slate-100 rounded px-2 py-1 flex items-start gap-2">
                        <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded mt-0.5 ${entry.outcome === 'passed' || entry.outcome === 'approved' || entry.outcome === 'authorized' ? 'bg-green-100 text-green-700' : entry.outcome === 'initiated' || entry.outcome === 'pending_reviewer_action' ? 'bg-blue-100 text-blue-700' : 'bg-red-100 text-red-700'}`}>{entry.outcome}</span>
                        <span className="font-mono text-slate-700">{entry.rule}</span>
                        {entry.approval_id && <span className="text-slate-400 font-mono text-[9px] ml-auto">{entry.approval_id}</span>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <pre className="text-[10px] font-mono text-slate-600 bg-slate-50 border border-slate-100 rounded p-2 whitespace-pre-wrap">
                    {JSON.stringify(mf(meta,'policy_enforcement_log'), null, 2)}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}

        {/* Category-specific fields */}
        {category === 'retrieval' && (mf(meta,'evidence_ids') || mf(meta,'filters_applied') || mf(meta,'excluded_evidence_summary')) && (
          <div className="space-y-2">
            <p className={`text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 ${catMeta.text}`}>
              <Search className="w-3 h-3" /> Retrieval Detail
            </p>
            <AuditFieldRow label="Evidence IDs"            value={mf(meta,'evidence_ids') ? JSON.stringify(mf(meta,'evidence_ids')) : undefined} mono />
            <AuditFieldRow label="Filters Applied"         value={mf(meta,'filters_applied') ? JSON.stringify(mf(meta,'filters_applied')) : undefined} />
            <AuditFieldRow label="Excluded Evidence"       value={mf(meta,'excluded_evidence_summary')} />
          </div>
        )}

        {category === 'human_oversight' && (mf(meta,'approval_notes') || mf(meta,'override_reason') || mf(meta,'annotation')) && (
          <div className="space-y-2">
            <p className={`text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 ${catMeta.text}`}>
              <UserCheck className="w-3 h-3" /> Oversight Detail
            </p>
            <AuditFieldRow label="Approval Notes"          value={mf(meta,'approval_notes','notes')} />
            <AuditFieldRow label="Override Reason"         value={mf(meta,'override_reason')} />
            <AuditFieldRow label="Annotation"              value={mf(meta,'annotation')} />
            <AuditFieldRow label="Reviewer"                value={mf(meta,'reviewer','reviewed_by')} />
          </div>
        )}

        {category === 'validation' && (mf(meta,'validation_outcome') || mf(meta,'quality_score') || mf(meta,'failure_reason') || mf(meta,'validation_passed') != null) && (
          <div className="space-y-2">
            <p className={`text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 ${catMeta.text}`}>
              <FlaskConical className="w-3 h-3" /> Validation Detail
            </p>
            <AuditFieldRow label="Validator ID"            value={mf(meta,'validator_id','validator')}       mono />
            <AuditFieldRow label="Outcome"                 value={mf(meta,'validation_outcome','outcome')} />
            <AuditFieldRow label="Validation Passed"       value={mf(meta,'validation_passed') != null ? (mf(meta,'validation_passed') ? '✓ Passed' : '✗ Failed') : undefined} />
            <AuditFieldRow label="Errors"                  value={mf(meta,'error_count') != null ? String(mf(meta,'error_count')) : undefined} />
            <AuditFieldRow label="Warnings"                value={mf(meta,'warning_count') != null ? String(mf(meta,'warning_count')) : undefined} />
            <AuditFieldRow label="Completeness"            value={mf(meta,'completeness_pct') != null ? `${mf(meta,'completeness_pct')}%` : undefined} />
            <AuditFieldRow label="Quality Score"           value={mf(meta,'quality_score') != null ? `${(Number(mf(meta,'quality_score')) * 100).toFixed(0)}%` : undefined} />
            <AuditFieldRow label="Failure Reason"          value={mf(meta,'failure_reason')} />
          </div>
        )}

        {/* PHI & Compliance block — shown on phi.scan.performed and any event with phi fields */}
        {(mf(meta,'phi_detected') != null || mf(meta,'masking_applied') != null || mf(meta,'regulatory_note') || mf(meta,'compliant_with') || mf(meta,'phi_review_performed') != null) && (
          <div className="space-y-2 border border-green-100 bg-green-50 rounded-lg p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 text-green-700">
              <Shield className="w-3 h-3" /> PHI &amp; Compliance
            </p>
            <AuditFieldRow label="PHI Detected"           value={mf(meta,'phi_detected') != null ? (mf(meta,'phi_detected') ? '⚠ Yes — masked' : '✓ None detected') : undefined} />
            <AuditFieldRow label="Masking Applied"        value={mf(meta,'masking_applied') != null ? (mf(meta,'masking_applied') ? '✓ Yes' : '✗ No (not required)') : undefined} />
            <AuditFieldRow label="PHI Review Performed"   value={mf(meta,'phi_review_performed') != null ? (mf(meta,'phi_review_performed') ? '✓ Yes' : '✗ No') : undefined} />
            <AuditFieldRow label="Scan Result"            value={mf(meta,'scan_result')} />
            <AuditFieldRow label="Regulatory Note"        value={mf(meta,'regulatory_note')} />
            {Array.isArray(mf(meta,'compliant_with')) && (
              <div>
                <p className="text-[9px] font-semibold text-green-600 uppercase mb-0.5">Frameworks</p>
                <div className="flex flex-wrap gap-1">
                  {(mf(meta,'compliant_with') as string[]).map((f: string) => (
                    <span key={f} className="text-[9px] px-1.5 py-0.5 bg-green-100 text-green-800 rounded font-medium">{f}</span>
                  ))}
                </div>
              </div>
            )}
            {mf(meta,'regulatory_basis') && (
              <AuditFieldRow label="Regulatory Basis" value={mf(meta,'regulatory_basis')} />
            )}
          </div>
        )}

        {category === 'output_distribution' && (mf(meta,'recipient') || mf(meta,'export_reason') || mf(meta,'artifact_id')) && (
          <div className="space-y-2">
            <p className={`text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 ${catMeta.text}`}>
              <Share2 className="w-3 h-3" /> Distribution Detail
            </p>
            <AuditFieldRow label="Artifact ID"             value={mf(meta,'artifact_id')}                   mono copyable />
            <AuditFieldRow label="Recipient / Destination" value={mf(meta,'recipient','destination')} />
            <AuditFieldRow label="Export Reason"           value={mf(meta,'export_reason')} />
            <AuditFieldRow label="Masking Applied"         value={mf(meta,'masking_applied') != null ? (mf(meta,'masking_applied') ? '✓ Yes' : '✗ No') : undefined} />
          </div>
        )}

        {/* State diff */}
        <AuditStateDiff before={ev.beforeState} after={ev.afterState} />

        {/* Session / network */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1">
          <AuditFieldRow label="Session ID"  value={ev.sessionId}   mono copyable />
          <AuditFieldRow label="IP Address"  value={ev.ipAddress}   mono />
        </div>

        {/* Tamper evidence */}
        <div className="bg-slate-50 rounded-lg p-3 space-y-2 border border-slate-100">
          <p className="text-[10px] text-slate-400 uppercase tracking-wide font-semibold flex items-center gap-1">
            <Hash className="w-3 h-3" /> Tamper Evidence (SHA-256 Chain)
          </p>
          <AuditFieldRow label="Row Hash (this record)"   value={ev.rowHash}  mono copyable />
          <AuditFieldRow label="Prev Hash (chain link)"   value={ev.prevHash} mono copyable />
          <AuditFieldRow label="Event ID"                 value={ev.eventId}  mono copyable />
        </div>

        {/* Any unhandled metadata */}
        {(() => {
          const handled = new Set([
            'outcome','result','status','access_decision','authorization','user_authorization','role','user_role','reviewer_role',
            'reason','justification','why','policy_applied','policy','opa_policy','masking_applied',
            'dataset_version','datasetVersion','schema_version','dataset_checksum',
            'file_ids','fileIds','checksum','sha256','context_pack_hash',
            'model_id','model','agent_type','agent_version','prompt_template_version','parser_version','chunker_version',
            'transformation_version','retrieval_recipe_id','tool_ids','retrieval_recipe',
            'evidence_ids','filters_applied','excluded_evidence_summary',
            'approval_notes','notes','override_reason','annotation','reviewer','reviewed_by',
            'validator_id','validator','validation_outcome','quality_score','failure_reason',
            'artifact_id','recipient','destination','export_reason',
            // PHI & Compliance
            'phi_detected','phi_fields_checked','phi_exposure_risk','phi_in_review_form',
            'phi_review_performed','masking_required','phi_checked',
            'scan_target','scan_method','scan_result','regulatory_note','compliant_with','regulatory_basis',
            // Validation enrichment
            'validation_passed','validation_methods','error_count','warning_count','completeness_pct',
            'domains_validated','validator_confidence','missing_required_vars','schema_consistency_passed',
            'domain_summaries',
            // Run completion enrichment
            'phi_exposure_checked','latency_ms','tool_calls_total','tool_calls_successful',
            // HITL enrichment
            'approval_method','artifacts_produced',
            // Retrieval enrichment
            'retrieval_mode','domains_queried','query_count','candidates_fetched',
            'ig_sections_retrieved','knowledge_source','retrieval_gap_note',
            'raw_context_source','curated_context_source','context_type',
            // Corrections & overrides
            'corrections_applied','human_overrides','modification_summary','human_modifications',
            // Masking rules
            'masking_rules','masking_rules_applied','masked_fields','masking_method',
            // Policy enforcement
            'policy_enforcement_log','policy_enforcement_outcome','policy_outcome','review_required_by',
            // Auth
            'auth_method','triggered_by_user_id','assigned_to',
          ])
          const extra = Object.entries(meta).filter(([k]) => !handled.has(k))
          if (extra.length === 0) return null
          return (
            <div>
              <p className="text-[10px] text-slate-400 uppercase tracking-wide font-medium mb-1.5 flex items-center gap-1">
                <Info className="w-3 h-3" /> Additional Context
              </p>
              <pre className="text-[10px] font-mono text-slate-600 bg-slate-50 border border-slate-100 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap max-h-40">
                {JSON.stringify(Object.fromEntries(extra), null, 2)}
              </pre>
            </div>
          )
        })()}
      </div>
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function isNonEmpty(v: any): boolean {
  if (v == null) return false
  if (typeof v === 'object' && !Array.isArray(v)) return Object.keys(v).length > 0
  if (Array.isArray(v)) return v.length > 0
  return true
}

function fmtDate(d: string | null | undefined) {
  if (!d) return ''
  return new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Convert structured learning data to a flowing natural language paragraph. */
function buildLearningNarrative(trace: any): string {
  const parts: string[] = []
  const ol = trace.outcomeLearning || {}
  const lr = trace.learningRecommendation || {}
  const fv = trace.feedbackValidation || {}
  const fEvents: any[] = Array.isArray(trace.feedbackEvents) ? trace.feedbackEvents : []
  const tt = (trace.traceType || 'agent').replace(/_/g, ' ')

  // Outcome sentence
  if (ol.success === true || ol.success === false) {
    const verb = ol.success ? 'completed successfully' : 'did not complete as expected'
    const actor = ol.hitl_actor ? ` Human reviewer ${ol.hitl_actor}` : ''
    const lat = ol.latency_ms ? ` (latency: ${Math.round(ol.latency_ms / 1000)}s)` : ''
    parts.push(`The ${tt} phase ${verb}.${actor ? `${actor} approved the output.` : ''}${lat}`)
  }

  // Learning recommendation sentence
  if (isNonEmpty(lr)) {
    const action = lr.action || 'monitor'
    const target = lr.target ? lr.target.replace(/_/g, ' ') : tt
    const conf = lr.confidence != null ? ` (confidence: ${Math.round(lr.confidence * 100)}%)` : ''
    const notes = lr.notes && !lr.auto_generated ? ` ${lr.notes}` : ''
    if (action === 'maintain') {
      parts.push(`The ${target} recipe is performing correctly — no tuning required${conf}.${notes}`)
    } else if (action === 'increase_weight') {
      parts.push(`Recommendation: increase retrieval weight for ${target}${conf}. ${notes || 'Consider expanding the retrieval top_k or adding domain-specific queries.'}`)
    } else if (action === 'review') {
      parts.push(`This ${target} step warrants a review${conf}. ${notes || 'Confidence was below threshold — check retrieval quality and evidence coverage.'}`)
    } else {
      parts.push(`Recommendation: ${action} on ${target}${conf}.${notes ? ` ${notes}` : ''}`)
    }
  }

  // Feedback validation sentence
  if (isNonEmpty(fv)) {
    const status = fv.validated ? 'validated and trusted' : 'flagged for review'
    const actor = fv.actor ? ` by ${fv.actor}` : ''
    const method = fv.validation_method ? ` via ${fv.validation_method.replace(/_/g, ' ')}` : ''
    const conf = fv.confidence != null ? ` (confidence: ${Math.round(fv.confidence * 100)}%)` : ''
    if (fv.user_feedback === 'approved') {
      parts.push(`Output was approved${actor}${method}${conf} — human review passed.`)
    } else if (fv.user_feedback && fv.user_feedback !== 'approved') {
      parts.push(`Human feedback "${fv.user_feedback}" was ${status}${actor}${method}${conf}.`)
    }
  }

  // Inline feedback events (trace corrections)
  if (fEvents.length > 0) {
    for (const fb of fEvents) {
      const ftype = (fb.feedback_type || '').toLowerCase()
      const by = fb.submitted_by ? `User ${fb.submitted_by.slice(0, 8)}` : 'A reviewer'
      const val = fb.feedback_value || {}
      const cat = val.feedback_category || ''
      const corrected = val.correction_payload?.corrected_answer || val.corrected_text || ''
      const expected = val.correction_payload?.expected_value || ''
      const stage = val.correction_payload?.targeted_stage || ''

      if (ftype === 'endorsement' || val.reason === 'correct') {
        parts.push(`${by} confirmed this decision was correct.`)
      } else if (ftype === 'correction' || corrected) {
        const catLabel = cat ? ` (${cat.replace(/_/g, ' ')})` : ''
        const stageLabel = stage ? ` at stage "${stage}"` : ''
        const corrLabel = corrected ? ` Corrected answer: "${corrected}".` : ''
        const expLabel = expected ? ` Expected value: "${expected}".` : ''
        parts.push(`${by} submitted a correction${catLabel}${stageLabel}.${corrLabel}${expLabel}`)
      } else if (ftype === 'rejection') {
        parts.push(`${by} rejected this decision${cat ? ` (${cat.replace(/_/g, ' ')})` : ''}.`)
      }
    }
  }

  return parts.length > 0 ? parts.join(' ') : 'No learning signal captured for this trace.'
}

// ── Learnings Run Tab ─────────────────────────────────────────────────────────
function LearningsRunTab({ traces }: { traces: any[] }) {
  const rows = traces.filter((t: any) =>
    isNonEmpty(t.outcomeLearning) || isNonEmpty(t.learningRecommendation) ||
    (Array.isArray(t.feedbackEvents) && t.feedbackEvents.length > 0)
  )

  if (rows.length === 0) {
    return (
      <div className="py-16 text-center text-slate-400 text-sm">
        <Activity className="w-8 h-8 mx-auto mb-2 opacity-30" />
        No learning signals captured for this run yet.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {rows.map((trace: any) => {
        const lr = trace.learningRecommendation || {}
        const ol = trace.outcomeLearning || {}
        const fEvents: any[] = Array.isArray(trace.feedbackEvents) ? trace.feedbackEvents : []
        const humanCorrections = fEvents.filter((fb: any) =>
          (fb.feedback_type || '').toLowerCase().includes('correction') ||
          fb.feedback_value?.correction_payload?.corrected_answer
        )
        const endorsements = fEvents.filter((fb: any) =>
          (fb.feedback_type || '').toLowerCase().includes('endorsement') ||
          fb.feedback_value?.reason === 'correct'
        )
        const narrative = buildLearningNarrative(trace)

        return (
          <div key={trace.id} className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide capitalize">
                  {(trace.traceType || 'trace').replace(/_/g, ' ')} learnings
                </span>
                {ol.success === true && <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-green-100 text-green-700 font-semibold">SUCCESS</span>}
                {ol.success === false && <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-red-100 text-red-700 font-semibold">FAILED</span>}
                {endorsements.length > 0 && (
                  <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-blue-50 text-blue-600 font-semibold flex items-center gap-1">
                    <ThumbsUp className="w-2.5 h-2.5" /> {endorsements.length} endorsed
                  </span>
                )}
                {humanCorrections.length > 0 && (
                  <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-amber-50 text-amber-700 font-semibold flex items-center gap-1">
                    <AlertCircle className="w-2.5 h-2.5" /> {humanCorrections.length} correction{humanCorrections.length > 1 ? 's' : ''}
                  </span>
                )}
              </div>
              <span className="text-[11px] text-slate-400">{fmtDate(trace.createdAt)}</span>
            </div>

            <div className="p-4 space-y-4">
              {/* Natural language narrative */}
              <div className="rounded-lg bg-brand-50 border border-brand-100 px-4 py-3">
                <p className="text-xs font-semibold text-brand-700 mb-1 flex items-center gap-1.5">
                  <Brain className="w-3.5 h-3.5" /> Learning Summary
                </p>
                <p className="text-sm text-slate-700 leading-relaxed">{narrative}</p>
              </div>

              {/* Recommendation badges */}
              {isNonEmpty(lr) && !lr.auto_generated && (
                <div>
                  <p className="text-xs font-semibold text-slate-500 mb-1.5">Recommendation Details</p>
                  <div className="flex flex-wrap gap-2">
                    {lr.action && <span className="px-2 py-0.5 rounded-full bg-brand-100 text-brand-700 text-[10px] font-semibold uppercase">{lr.action}</span>}
                    {lr.type && <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[10px]">{lr.type}</span>}
                    {lr.target && <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[10px]">{lr.target.replace(/_/g, ' ')}</span>}
                    {lr.confidence != null && <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[10px]">{Math.round(lr.confidence * 100)}% confidence</span>}
                  </div>
                  {lr.notes && <p className="text-xs text-slate-600 mt-1.5">{lr.notes}</p>}
                </div>
              )}

              {/* Human feedback corrections */}
              {humanCorrections.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-slate-500 mb-1.5 flex items-center gap-1">
                    <User className="w-3 h-3" /> Human Corrections ({humanCorrections.length})
                  </p>
                  <div className="space-y-2">
                    {humanCorrections.map((fb: any, i: number) => {
                      const val = fb.feedback_value || {}
                      const cp = val.correction_payload || {}
                      return (
                        <div key={i} className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs">
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="font-semibold text-amber-800">
                              {(val.feedback_category || 'correction').replace(/_/g, ' ')}
                            </span>
                            <span className="text-amber-600 text-[10px]">{fb.submitted_by ? `by ${fb.submitted_by.slice(0, 12)}` : ''}</span>
                          </div>
                          {cp.corrected_answer && (
                            <div className="mb-1"><span className="text-amber-700 font-medium">Corrected: </span><span className="text-slate-700">{cp.corrected_answer}</span></div>
                          )}
                          {cp.expected_value && (
                            <div className="mb-1"><span className="text-amber-700 font-medium">Expected: </span><span className="text-slate-700">{cp.expected_value}</span></div>
                          )}
                          {cp.targeted_stage && (
                            <div><span className="text-amber-700 font-medium">Stage: </span><span className="text-slate-600">{cp.targeted_stage}</span></div>
                          )}
                          {cp.corrected_mapping && (
                            <div className="mt-1.5">
                              <p className="text-amber-700 font-medium mb-1">Corrected Mapping:</p>
                              <pre className="text-[10px] bg-white rounded p-1.5 overflow-auto max-h-32 text-slate-700">{JSON.stringify(cp.corrected_mapping, null, 2)}</pre>
                            </div>
                          )}
                          {val.validation_result && (
                            <div className="mt-1.5 pt-1.5 border-t border-amber-200">
                              <span className="text-amber-700 font-medium">Validation: </span>
                              <span className={clsx('font-semibold', val.validation_result.outcome === 'valid' ? 'text-green-600' : 'text-red-600')}>
                                {val.validation_result.outcome || 'pending'}
                              </span>
                              {val.validation_result.verdict && <span className="text-slate-600"> — {val.validation_result.verdict}</span>}
                            </div>
                          )}
                          {val.learning_recommendation && (
                            <div className="mt-1.5 pt-1.5 border-t border-amber-200 text-[10px] text-amber-700">
                              Learning: {val.learning_recommendation.recommendation || JSON.stringify(val.learning_recommendation)}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Endorsements */}
              {endorsements.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-slate-500 mb-1 flex items-center gap-1">
                    <ThumbsUp className="w-3 h-3 text-green-500" /> Endorsements
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {endorsements.map((fb: any, i: number) => (
                      <span key={i} className="text-[11px] bg-green-50 text-green-700 border border-green-200 rounded px-2 py-0.5">
                        ✓ Confirmed correct{fb.submitted_by ? ` by ${fb.submitted_by.slice(0, 12)}` : ''}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Validation Run Tab ────────────────────────────────────────────────────────
function ValidationRunTab({ traces }: { traces: any[] }) {
  const rows = traces.filter((t: any) =>
    isNonEmpty(t.validationResult) || isNonEmpty(t.scorecard) ||
    isNonEmpty(t.validationLayer) || isNonEmpty(t.decisionAlternatives) ||
    isNonEmpty(t.stepLinkage) || isNonEmpty(t.feedbackValidation)
  ).map((t: any) => ({
    id: t.id,
    traceType: t.traceType,
    createdAt: t.createdAt,
    validation: t.validationResult,
    scorecard: t.scorecard,
    validationLayer: t.validationLayer,
    decisionAlternatives: t.decisionAlternatives,
    stepLinkage: t.stepLinkage,
    feedbackValidation: t.feedbackValidation,
  }))

  if (rows.length === 0) {
    return (
      <div className="py-16 text-center text-slate-400 text-sm">
        <CheckCircle className="w-8 h-8 mx-auto mb-2 opacity-30" />
        No validation data captured for this run yet.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {rows.map((row) => (
        <div key={row.id} className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-b border-slate-200">
            <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">{row.traceType}</span>
            <span className="text-[11px] text-slate-400">{row.createdAt ? new Date(row.createdAt).toLocaleString() : ''}</span>
          </div>

          <div className="p-4 space-y-4">
            {/* Validation Result + Scorecard */}
            {(isNonEmpty(row.validation) || isNonEmpty(row.scorecard)) && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {isNonEmpty(row.validation) && (
                  <div className="rounded-lg border border-slate-200 p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs font-semibold text-slate-500">Validation Result</span>
                      {row.validation?.outcome && (
                        <span className={clsx('px-2 py-0.5 rounded-full text-[10px] font-bold uppercase',
                          row.validation.outcome === 'valid' ? 'bg-green-100 text-green-700' :
                          row.validation.outcome === 'invalid' ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'
                        )}>{row.validation.outcome}</span>
                      )}
                    </div>
                    {row.validation?.verdict && <p className="text-xs text-slate-600 mb-1">{row.validation.verdict}</p>}
                    {row.validation?.error_count != null && (
                      <div className="flex gap-3 text-[11px] text-slate-500">
                        <span>Errors: <b>{row.validation.error_count}</b></span>
                        {row.validation?.warning_count != null && <span>Warnings: <b>{row.validation.warning_count}</b></span>}
                      </div>
                    )}
                    {isNonEmpty(row.validation) && !row.validation?.outcome && (
                      <pre className="text-[10px] text-slate-500 overflow-auto max-h-24">{JSON.stringify(row.validation, null, 2)}</pre>
                    )}
                  </div>
                )}
                {isNonEmpty(row.scorecard) && (
                  <div className="rounded-lg border border-slate-200 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold text-slate-500">Scorecard</span>
                      {row.scorecard?.coverage_pct != null && (
                        <span className="text-[11px] font-bold text-slate-600">{row.scorecard.coverage_pct}% coverage</span>
                      )}
                    </div>
                    {row.scorecard?.coverage_pct != null && (
                      <div className="flex items-center gap-2 mb-2">
                        <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                          <div className="h-full bg-brand-500 rounded-full" style={{ width: `${row.scorecard.coverage_pct}%` }} />
                        </div>
                        <span className="text-[10px] font-semibold text-slate-600">{row.scorecard.coverage_pct}%</span>
                      </div>
                    )}
                    <pre className="text-[10px] text-slate-500 overflow-auto max-h-24">{JSON.stringify(row.scorecard, null, 2)}</pre>
                  </div>
                )}
              </div>
            )}

            {/* Validation Layer — multi-engine methods */}
            {isNonEmpty(row.validationLayer) && (
              <div>
                <div className="text-xs font-semibold text-slate-500 mb-1.5">Validation Methods</div>
                {Array.isArray(row.validationLayer?.validation_methods) && row.validationLayer.validation_methods.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {row.validationLayer.validation_methods.map((m: string) => (
                      <span key={m} className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[10px] font-medium border border-blue-200">{m}</span>
                    ))}
                  </div>
                )}
                {(row.validationLayer?.overall_status || row.validationLayer?.error_count != null) && (
                  <div className="flex gap-3 text-[11px] text-slate-500 mb-1">
                    {row.validationLayer?.overall_status && <span>Status: <b>{row.validationLayer.overall_status}</b></span>}
                    {row.validationLayer?.error_count != null && <span>Errors: <b>{row.validationLayer.error_count}</b></span>}
                    {row.validationLayer?.warning_count != null && <span>Warnings: <b>{row.validationLayer.warning_count}</b></span>}
                  </div>
                )}
                {isNonEmpty(row.validationLayer?.checks) && (
                  <pre className="text-[10px] text-slate-500 bg-slate-50 rounded p-2 overflow-auto max-h-28">{JSON.stringify(row.validationLayer.checks, null, 2)}</pre>
                )}
              </div>
            )}

            {/* Decision Alternatives */}
            {isNonEmpty(row.decisionAlternatives) && (
              <div>
                <div className="text-xs font-semibold text-slate-500 mb-1.5">Decision Alternatives</div>
                <div className="space-y-1.5">
                  {(row.decisionAlternatives as any[]).map((alt: any, i: number) => (
                    <div key={i} className="flex items-start gap-2 text-[11px] bg-slate-50 rounded p-2">
                      <span className={clsx('mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0',
                        alt.rejected ? 'bg-red-400' : 'bg-green-400')} />
                      <div>
                        <span className="font-medium text-slate-700">{alt.option}</span>
                        {alt.reason && <span className="text-slate-500 ml-1">— {alt.reason}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Step Linkage */}
            {isNonEmpty(row.stepLinkage) && (
              <div>
                <div className="text-xs font-semibold text-slate-500 mb-1.5">Step Linkage</div>
                <div className="flex flex-wrap gap-2 text-[11px] text-slate-600">
                  {row.stepLinkage.depends_on?.length > 0 && (
                    <span className="bg-slate-100 rounded px-2 py-0.5">⬆ Depends on: <span className="font-mono">{(row.stepLinkage.depends_on as string[]).join(', ')}</span></span>
                  )}
                  {row.stepLinkage.affects?.length > 0 && (
                    <span className="bg-slate-100 rounded px-2 py-0.5">⬇ Affects: <span className="font-mono">{(row.stepLinkage.affects as string[]).join(', ')}</span></span>
                  )}
                  {row.stepLinkage.phase && (
                    <span className="bg-slate-100 rounded px-2 py-0.5">Phase: <span className="font-medium">{row.stepLinkage.phase}</span></span>
                  )}
                </div>
              </div>
            )}

            {/* Feedback Validation */}
            {isNonEmpty(row.feedbackValidation) && (
              <div>
                <div className="text-xs font-semibold text-slate-500 mb-1.5">Feedback Validation</div>
                <div className="flex flex-wrap gap-3 text-[11px] text-slate-600 bg-slate-50 rounded p-2">
                  {row.feedbackValidation?.user_feedback && (
                    <span>Feedback: <b>{row.feedbackValidation.user_feedback}</b></span>
                  )}
                  {row.feedbackValidation?.validated != null && (
                    <span className={clsx('font-semibold', row.feedbackValidation.validated ? 'text-green-600' : 'text-red-500')}>
                      {row.feedbackValidation.validated ? '✓ Validated' : '✗ Not validated'}
                    </span>
                  )}
                  {row.feedbackValidation?.validation_method && (
                    <span>Method: {row.feedbackValidation.validation_method}</span>
                  )}
                  {row.feedbackValidation?.confidence != null && (
                    <span>Confidence: <b>{Math.round(row.feedbackValidation.confidence * 100)}%</b></span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

export default function RunSessionPage() {
  const { runId } = useParams() as { runId: string }
  const router = useRouter()
  const { user } = useAuth()
  const orgId   = useOrgId()
  const userId  = user?.id ?? '00000000-0000-0000-0000-000000000002'

  const [run, setRun]                 = useState<any>(null)
  const [traces, setTraces]           = useState<any[]>([])
  const [auditEvents, setAuditEvents] = useState<any[]>([])
  const [auditCategoryFilter, setAuditCategoryFilter] = useState<AuditCategory | 'all'>('all')
  const [loadError, setLoadError]     = useState<string | null>(null)
  const [activeTab, setActiveTab]     = useState<'trace' | 'traces' | 'artifacts' | 'evaluation' | 'validation' | 'learnings' | 'audit' | 'graph'>('trace')
  const [loading, setLoading]         = useState(true)
  const [expandedTrace, setExpandedTrace] = useState<string | null>(null)
  const [copied, setCopied]           = useState(false)
  const [evaluatorCatalog, setEvaluatorCatalog] = useState<any[]>([])
  const [evaluatorResults, setEvaluatorResults] = useState<any[]>([])
  const [triggeringEvaluator, setTriggeringEvaluator] = useState<string | null>(null)
  const [showCustomEvaluatorForm, setShowCustomEvaluatorForm] = useState(false)
  const [customEvalForm, setCustomEvalForm] = useState({
    name: '', slug: '', description: '', category: 'quality',
    evaluatorType: 'llm_judge', promptTemplate: '', langfuseScoreName: '',
  })
  const [savingCustomEval, setSavingCustomEval] = useState(false)
  const [editingEvaluatorId, setEditingEvaluatorId] = useState<string | null>(null)
  const [editEvalForm, setEditEvalForm] = useState<{
    name: string; description: string; category: string;
    evaluatorType: string; promptTemplate: string; langfuseScoreName: string;
  } | null>(null)
  const [savingEditEval, setSavingEditEval] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchRun = useCallback(async () => {
    try {
      setLoadError(null)
      const [runResult, tracesResult, auditResult] = await Promise.allSettled([
        gql(`query { agentRunDetail(runId: "${runId}") {
          id status agentName agentType studyId llmModel tokensUsed
          stepTraces checkpointData artifacts outputSummary errorMessage
          startedAt completedAt createdAt
          sessionId latencyMs costUsd turnCount toolCallsTotal toolCallsSuccessful
          evaluation {
            taskCompleted faithfulnessScore reasoningScore
            hallucinationDetected hallucinationRate
            toolUsageAccuracy judgeVerdict judgeNotes judgeModel
            evaluatedAt evaluator
          }
        }}`),
        gql(`query { decisionTraces(runId: "${runId}") {
          id traceType traceVersion inputContext reasoningSteps sourcesCited output confidence
          mistakeType intentResolution retrievalPlan evidenceAssembly executionMode
          answerConstruction outcomeLearning confidenceDecomposition decisionLineage auditEvidence
          humanReadableSummary
          feedbackEvents validationResult scorecard learningRecommendation createdAt
          retrievalReasoning decisionAlternatives validationLayer stepLinkage feedbackValidation
        }}`),
        gql(`query { auditEvents(orgId: "${orgId}", runId: "${runId}", limit: 200) {
          eventId timestamp actorType actorId action resourceType resourceId
          metadata rowHash prevHash ipAddress sessionId beforeState afterState isTestRun
        }}`),
      ])

      if (runResult.status === 'fulfilled') {
        setRun(runResult.value.agentRunDetail)
      } else {
        setRun(null)
        setLoadError('Failed to load run details.')
      }

      if (tracesResult.status === 'fulfilled') {
        setTraces(tracesResult.value.decisionTraces || [])
      } else {
        setTraces([])
      }

      if (auditResult.status === 'fulfilled') {
        setAuditEvents(auditResult.value.auditEvents || [])
      } else {
        setAuditEvents([])
      }
    } catch (e) {
      console.error(e)
      setLoadError('Failed to load run details.')
    } finally {
      setLoading(false)
    }
  }, [runId, orgId])

  const fetchEvaluatorData = useCallback(async () => {
    try {
      const [catalogRes, resultsRes] = await Promise.allSettled([
        gql(`query { evaluatorCatalog { id name slug description category evaluatorType config isBuiltin isActive langfuseScoreName createdAt } }`),
        gql(`query { runEvaluatorResults(runId: "${runId}") { id runId evaluatorId evaluatorName evaluatorSlug evaluatorCategory evaluatorDescription isBuiltin status score verdict details notes errorMessage judgeModel triggeredBy createdAt completedAt } }`),
      ])
      if (catalogRes.status === 'fulfilled') setEvaluatorCatalog(catalogRes.value.evaluatorCatalog || [])
      if (resultsRes.status === 'fulfilled') setEvaluatorResults(resultsRes.value.runEvaluatorResults || [])
    } catch (e) { console.error('evaluator fetch failed', e) }
  }, [runId])

  useEffect(() => {
    fetchRun()
    pollRef.current = setInterval(() => {
      if (run && !ACTIVE_STATUSES.has(run.status)) { clearInterval(pollRef.current!); return }
      fetchRun()
    }, 3000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [runId])

  useEffect(() => {
    if (run && !ACTIVE_STATUSES.has(run.status) && pollRef.current) clearInterval(pollRef.current)
  }, [run?.status])

  useEffect(() => {
    fetchEvaluatorData()
  }, [runId])

  function copySessionId() {
    if (!run?.sessionId) return
    navigator.clipboard.writeText(run.sessionId)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  async function handleTriggerEvaluator(evaluatorId: string) {
    setTriggeringEvaluator(evaluatorId)
    try {
      const safeOrgId = orgId || '00000000-0000-0000-0000-000000000000'
      await gql(`mutation {
        triggerEvaluator(runId: "${runId}", evaluatorId: "${evaluatorId}", orgId: "${safeOrgId}", triggeredBy: "user") {
          id status score verdict evaluatorName
        }
      }`)
      await fetchEvaluatorData()
    } catch (e) { console.error('trigger evaluator failed', e) }
    finally { setTriggeringEvaluator(null) }
  }

  async function handleSaveCustomEvaluator() {
    if (!customEvalForm.name || !customEvalForm.slug) return
    setSavingCustomEval(true)
    try {
      const config = customEvalForm.promptTemplate
        ? { prompt_template: customEvalForm.promptTemplate }
        : {}
      await gql(`mutation($input: EvaluatorCreateInput!) { saveEvaluator(input: $input) { id name slug } }`, {
        input: {
          orgId,
          name: customEvalForm.name,
          slug: customEvalForm.slug,
          description: customEvalForm.description,
          category: customEvalForm.category,
          evaluatorType: customEvalForm.evaluatorType,
          config,
          langfuseScoreName: customEvalForm.langfuseScoreName || customEvalForm.slug,
          createdBy: 'user',
        }
      })
      setShowCustomEvaluatorForm(false)
      setCustomEvalForm({ name: '', slug: '', description: '', category: 'quality', evaluatorType: 'llm_judge', promptTemplate: '', langfuseScoreName: '' })
      await fetchEvaluatorData()
    } catch (e) { console.error('save custom evaluator failed', e) }
    finally { setSavingCustomEval(false) }
  }

  function handleStartEditEvaluator(ev: any) {
    const cfg = typeof ev.config === 'string' ? JSON.parse(ev.config) : (ev.config || {})
    setEditingEvaluatorId(ev.id)
    setEditEvalForm({
      name: ev.name,
      description: ev.description || '',
      category: ev.category,
      evaluatorType: ev.evaluatorType,
      promptTemplate: cfg.prompt_template || '',
      langfuseScoreName: ev.langfuseScoreName || '',
    })
  }

  async function handleSaveEditEvaluator() {
    if (!editingEvaluatorId || !editEvalForm) return
    setSavingEditEval(true)
    try {
      const config = editEvalForm.promptTemplate
        ? { prompt_template: editEvalForm.promptTemplate }
        : undefined
      await gql(`mutation($id: ID!, $input: EvaluatorUpdateInput!) { updateEvaluator(id: $id, input: $input) { id name slug } }`, {
        id: editingEvaluatorId,
        input: {
          name: editEvalForm.name,
          description: editEvalForm.description,
          category: editEvalForm.category,
          evaluatorType: editEvalForm.evaluatorType,
          langfuseScoreName: editEvalForm.langfuseScoreName,
          ...(config ? { config } : {}),
        }
      })
      setEditingEvaluatorId(null)
      setEditEvalForm(null)
      await fetchEvaluatorData()
    } catch (e) { console.error('update evaluator failed', e) }
    finally { setSavingEditEval(false) }
  }

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <Loader2 className="w-6 h-6 animate-spin text-brand-500" />
    </div>
  )
  if (!run) return <div className="p-8 text-slate-500">{loadError || 'Run not found.'}</div>

  // step_traces may be: [{obj}, ...] (new) or ["[{obj}]", ...] (old string-encoded)
  const _rawSteps = (typeof run.stepTraces === 'string' ? JSON.parse(run.stepTraces) : run.stepTraces) || []
  const _flatSteps: any[] = _rawSteps.flatMap((s: any) => {
    if (typeof s === 'string') {
      try { const p = JSON.parse(s); return Array.isArray(p) ? p : [p] } catch { return [] }
    }
    return Array.isArray(s) ? s : [s]
  })
  // If the run was cancelled and the step traces include a "rejected" step, label it as rejected
  const _wasReviewRejected = run.status === 'cancelled' && _flatSteps.some((s: any) => s.status === 'rejected')
  const badge = _wasReviewRejected
    ? { label: 'Review Rejected', cls: 'bg-red-50 text-red-700', icon: <XCircle className="w-3.5 h-3.5" /> }
    : (STATUS_BADGE[run.status] || STATUS_BADGE.pending)
  // Deduplicate: for each step number keep the last (most complete) entry
  const _stepByNum = new Map<number, any>()
  for (const s of _flatSteps) { _stepByNum.set(s.step ?? _flatSteps.indexOf(s), s) }
  // If the overall run is completed/failed/cancelled, any step still showing "running" is actually done
  const _runDone = !ACTIVE_STATUSES.has(run.status)
  const stepTraces = Array.from(_stepByNum.values())
    .sort((a, b) => (a.step ?? 0) - (b.step ?? 0))
    .map(s => {
      if (!_runDone) return s
      if (s.status === 'running') return { ...s, status: 'completed' }
      // A "waiting" step on a cancelled run = review was rejected
      if (s.status === 'waiting' && run.status === 'cancelled') {
        return { ...s, status: 'rejected', name: s.name?.replace('Awaiting', 'Rejected —') }
      }
      return s
    })
  const artifacts  = (typeof run.artifacts  === 'string' ? JSON.parse(run.artifacts)  : run.artifacts)  || []
  const duration   = run.startedAt && run.completedAt ? formatDuration(run.startedAt, run.completedAt) : null
  const ev         = run.evaluation

  const verdictCfg = ev?.judgeVerdict ? (VERDICT_CONFIG[ev.judgeVerdict] || VERDICT_CONFIG.unknown) : null

  return (
    <div className="space-y-0">

      {/* ── Header ── */}
      <div className="flex items-center gap-4 mb-4">
        <button onClick={() => router.push('/agents')} className="p-1.5 hover:bg-slate-100 rounded-lg">
          <ArrowLeft className="w-4 h-4 text-slate-500" />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900">{run.agentName || 'Agent Run'}</h1>
            <span className={clsx('flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium', badge.cls)}>
              {badge.icon} {badge.label}
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">Run ID: {runId}</p>
        </div>
        {/* HITL CTA — flow agents paused at a human task */}
        {run.status === 'waiting_human_task' && (() => {
          const cp = typeof run.checkpointData === 'string' ? JSON.parse(run.checkpointData || '{}') : (run.checkpointData || {})
          const taskId = cp.task_id
          return taskId ? (
            <a href={`/tasks/${taskId}`}
              className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white text-sm font-semibold rounded-lg transition-colors">
              <UserCheck className="w-4 h-4" /> Review Task
            </a>
          ) : null
        })()}
        {/* SDTM mapping approval CTA */}
        {run.status === 'waiting_approval' && (() => {
          const cp = typeof run.checkpointData === 'string' ? JSON.parse(run.checkpointData || '{}') : (run.checkpointData || {})
          const approvalId = cp.approval_id
          return approvalId ? (
            <a href={`/agents/mapping-review/${approvalId}`}
              className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold rounded-lg transition-colors">
              <PauseCircle className="w-4 h-4" /> Review Mapping
            </a>
          ) : null
        })()}
      </div>

      {/* ── Run Metadata ── */}
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500 mb-5 px-1">
        {run.agentType && (
          <span><span className="text-slate-400">Type:</span> {run.agentType}</span>
        )}
        {run.studyId && (
          <span><span className="text-slate-400">Study:</span> <span className="font-mono">{run.studyId}</span></span>
        )}
        {run.llmModel && (
          <span className="flex items-center gap-1">
            <Brain className="w-3 h-3 text-slate-400" />
            {run.llmModel}
          </span>
        )}
        {run.tokensUsed != null && (
          <span><span className="text-slate-400">Tokens:</span> {run.tokensUsed.toLocaleString()}</span>
        )}
        {run.startedAt && (
          <span><span className="text-slate-400">Started:</span> {formatTs(run.startedAt)}</span>
        )}
        {duration && (
          <span><span className="text-slate-400">Duration:</span> {duration}</span>
        )}
        {run.sessionId && (
          <span className="flex items-center gap-1">
            <span className="text-slate-400">Session:</span>
            <span className="font-mono text-slate-600">{run.sessionId.slice(0, 8)}…</span>
            <button onClick={copySessionId} title="Copy session ID"
              className="p-0.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
              {copied ? <CheckCircle className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
            </button>
          </span>
        )}
      </div>

      {/* ── Tabs ── */}
      <div className="border-b border-slate-200 mb-5">
        <div className="flex gap-1">
          {([
            { id: 'trace'      as const, label: 'Execution Trace',  icon: null,                                        dot: false },
            { id: 'traces'     as const, label: 'Decision Traces',  icon: <Brain className="w-3.5 h-3.5" />,           dot: traces.length > 0 },
            { id: 'artifacts'  as const, label: 'Artifacts',        icon: null,                                        dot: run.status === 'completed' && artifacts.length > 0 },
            { id: 'evaluation' as const, label: 'Evaluation',       icon: <BarChart2 className="w-3.5 h-3.5" />,       dot: ev?.judgeVerdict === 'fail' },
            { id: 'validation' as const, label: 'Validation',       icon: <CheckCircle className="w-3.5 h-3.5" />,     dot: traces.some((t: any) => isNonEmpty(t.validationResult) || isNonEmpty(t.validationLayer)) },
            { id: 'learnings'  as const, label: 'Learnings',         icon: <Activity className="w-3.5 h-3.5" />,        dot: traces.some((t: any) => isNonEmpty(t.outcomeLearning) || isNonEmpty(t.learningRecommendation) || (Array.isArray(t.feedbackEvents) && t.feedbackEvents.length > 0)) },
            { id: 'audit'      as const, label: 'Audit Log',        icon: <Shield className="w-3.5 h-3.5" />,          dot: false },
            { id: 'graph'      as const, label: 'Reasoning Graph',  icon: <Database className="w-3.5 h-3.5" />,        dot: false },
          ]).map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={clsx(
                'px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5',
                activeTab === tab.id
                  ? 'border-brand-500 text-brand-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700',
              )}>
              {tab.icon}
              {tab.label}
              {tab.dot && <span className={clsx('w-2 h-2 rounded-full', tab.id === 'evaluation' ? 'bg-red-400' : 'bg-amber-400')} />}
            </button>
          ))}
        </div>
      </div>

      {/* ── Execution Trace ── */}
      {activeTab === 'trace' && (
        <div className="space-y-2">
          {stepTraces.length === 0 ? (
            <div className="text-slate-400 text-sm py-8 text-center">
              {ACTIVE_STATUSES.has(run.status)
                ? <div className="flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Waiting for first step…</div>
                : 'No step traces recorded.'}
            </div>
          ) : stepTraces.map((step: any, i: number) => {
            const stepMs = step.started_at && step.completed_at
              ? new Date(step.completed_at).getTime() - new Date(step.started_at).getTime()
              : null
            return (
              <div key={i} className="flex gap-3 p-4 bg-white rounded-xl border border-slate-100">
                {STEP_ICONS[step.status] || STEP_ICONS.running}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400">Step {step.step}</span>
                    <span className="text-sm font-medium text-slate-800">{step.name}</span>
                    {step.tool_name && (
                      <span className="text-xs px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded font-mono">{step.tool_name}</span>
                    )}
                    {stepMs !== null && (
                      <span className="ml-auto text-xs text-slate-400">{stepMs < 1000 ? `${stepMs}ms` : `${(stepMs / 1000).toFixed(1)}s`}</span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">{step.details}</p>
                  {step.tool_result_status && (
                    <span className={clsx('mt-1 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium',
                      step.tool_result_status === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700')}>
                      {step.tool_result_status === 'success' ? <CheckCircle className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
                      {step.tool_result_status}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
          {run.errorMessage && (
            <div className="p-4 bg-red-50 rounded-xl border border-red-200 text-sm text-red-700">
              {run.errorMessage}
            </div>
          )}
        </div>
      )}

      {/* ── Decision Traces ── */}
      {activeTab === 'traces' && (
        <div className="space-y-3">
          {/* Download bar — always visible at top */}
          <div className="flex items-center justify-between gap-3 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
            <div>
              <p className="text-xs font-semibold text-slate-700">Decision Traces</p>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {traces.length > 0 ? `${traces.length} trace(s) — full audit of every AI decision` : 'No traces yet'}
              </p>
            </div>
            <button
              onClick={() => {
                const sep  = (ch: string, n = 80) => ch.repeat(n)
                const kv   = (k: string, v: any, indent = '    ') =>
                  v != null && v !== '' && !(Array.isArray(v) && v.length === 0)
                    ? `${indent}${k.padEnd(28)} ${typeof v === 'object' ? JSON.stringify(v, null, 0) : v}`
                    : null
                // Append a full JSON block for a section so no fields are ever missing
                const fullJson = (obj: any) => {
                  if (!obj || typeof obj !== 'object') return
                  lines.push(`    Full JSON:`)
                  JSON.stringify(obj, null, 2).split('\n').forEach(l => lines.push(`      ${l}`))
                }

                const lines: string[] = [
                  `DECISION TRACES`,
                  `Run ID:   ${runId}`,
                  `Exported: ${new Date().toLocaleString()}`,
                  `Traces:   ${traces.length}`,
                  sep('='),
                ]

                traces.forEach((trace: any, idx: number) => {
                  const ctx = trace.inputContext || {}
                  const isDet = ctx.provider === 'deterministic' || ctx.model === 'deterministic'

                  lines.push(``)
                  lines.push(sep('-'))
                  lines.push(`TRACE ${idx + 1} of ${traces.length}`)
                  lines.push(`  ID:         ${trace.id}`)
                  lines.push(`  Type:       ${(trace.traceType || 'unknown').toUpperCase()}${isDet ? ' [DETERMINISTIC]' : ''}`)
                  lines.push(`  Created:    ${trace.createdAt ? new Date(trace.createdAt).toLocaleString() : '—'}`)
                  if (trace.traceVersion) lines.push(`  Version:    v${trace.traceVersion}`)
                  if (trace.confidence != null) lines.push(`  Confidence: ${Math.round(trace.confidence * 100)}%`)
                  if (trace.mistakeType) lines.push(`  Mistake:    ${trace.mistakeType}`)
                  lines.push(sep('-'))

                  // Explanation
                  if (trace.humanReadableSummary) {
                    lines.push(``, `  ── Explanation ──`, ``)
                    lines.push(`    ${trace.humanReadableSummary}`)
                  }

                  // A. Intent Resolution
                  const ir = trace.intentResolution
                  if (ir) {
                    lines.push(``, `  ── A. Intent Resolution ──`, ``)
                    ;[
                      kv('Raw Query',                    ir.raw_user_query),
                      kv('Inferred Intent',              ir.inferred_intent),
                      kv('Normalized Query',             ir.normalized_query),
                      kv('Intent Confidence',            ir.intent_confidence != null ? `${Math.round(ir.intent_confidence * 100)}%` : null),
                      kv('Task Class',                   ir.inferred_task_class),
                    ].filter(Boolean).forEach(l => lines.push(l as string))
                    if (Array.isArray(ir.alternate_intents_considered) && ir.alternate_intents_considered.length) {
                      lines.push(`    Alternates Considered:`)
                      ir.alternate_intents_considered.forEach((a: any) =>
                        lines.push(`      • ${a.intent} — ${a.reason}${a.rejected ? ' [rejected]' : ''}`)
                      )
                    }
                    fullJson(ir)
                  }

                  // B. Retrieval Plan
                  const rp = trace.retrievalPlan
                  if (rp) {
                    lines.push('', '  ── ' + 'B. Retrieval Plan' + ' ──', '')
                    ;[
                      kv('Recipe',                       rp.retrieval_recipe || rp.recipe_version),
                      kv('Mode',                         rp.retrieval_mode),
                      kv('Auto Generated',               rp.auto_generated != null ? String(rp.auto_generated) : null),
                      kv('Candidates Considered',        rp.candidate_sources_considered),
                      kv('Candidates Rejected',          rp.candidate_sources_rejected),
                      kv('Selected Evidence',            rp.selected_evidence_count),
                      kv('Evidence Source',              rp.evidence_source),
                      kv('Rejection Reason',             rp.rejection_reason),
                    ].filter(Boolean).forEach(l => lines.push(l as string))
                    if (rp.retrieval_rationale) lines.push(`    Rationale: ${rp.retrieval_rationale}`)
                    if (Array.isArray(rp.upstream_phases_relied_on) && rp.upstream_phases_relied_on.length)
                      lines.push(`    Upstream Phases: ${rp.upstream_phases_relied_on.join(', ')}`)
                    fullJson(rp)
                  }

                  // C. Evidence Assembly
                  const ea = trace.evidenceAssembly
                  if (ea) {
                    lines.push('', '  ── ' + 'C. Evidence Assembly' + ' ──', '')
                    ;[
                      kv('Evidence Type',                ea.evidence_type),
                      kv('Selected Evidence Count',      ea.selected_evidence_count),
                      kv('Evidence Sufficiency Score',   ea.evidence_sufficiency_score),
                      kv('Grounding Method',             ea.grounding_method),
                      kv('Retrieval Confidence',         ea.retrieval_confidence),
                      kv('Tool Correctness Confidence',  ea.tool_correctness_confidence),
                      kv('Response Formulation Conf.',   ea.response_formulation_confidence),
                    ].filter(Boolean).forEach(l => lines.push(l as string))
                    if (Array.isArray(ea.evidence_ids) && ea.evidence_ids.length)
                      lines.push(`    Evidence IDs: ${ea.evidence_ids.join(', ')}`)
                    fullJson(ea)
                  }

                  // D. Execution Mode
                  const em = trace.executionMode
                  if (em) {
                    lines.push('', '  ── ' + 'D. Execution Mode' + ' ──', '')
                    ;[
                      kv('Reasoning Mode',               em.reasoning_mode),
                    ].filter(Boolean).forEach(l => lines.push(l as string))
                    if (Array.isArray(em.tools_invoked) && em.tools_invoked.length)
                      lines.push(`    Tools Invoked: ${em.tools_invoked.join(', ')}`)
                    if (Array.isArray(em.fallback_paths_used) && em.fallback_paths_used.length)
                      lines.push(`    Fallback Paths: ${em.fallback_paths_used.join(', ')}`)
                    if (Array.isArray(em.tool_invocation_details) && em.tool_invocation_details.length) {
                      lines.push(`    Tool Invocation Details:`)
                      em.tool_invocation_details.forEach((t: any) =>
                        lines.push(`      Step ${t.step}. [${t.tool}] → ${t.result_count ?? '?'} results`)
                      )
                    }
                    fullJson(em)
                  }

                  // E. Answer Construction
                  const ac = trace.answerConstruction
                  if (ac) {
                    lines.push('', '  ── ' + 'E. Answer Construction' + ' ──', '')
                    ;[
                      kv('Answer Type',                  ac.answer_type),
                      kv('Output Schema',                ac.output_schema),
                      kv('LLM Mapped Count',             ac.llm_mapped_count),
                      kv('Pre-Mapped Count',             ac.pre_mapped_count),
                      kv('Citations Attached',           ac.citations_attached != null ? String(ac.citations_attached) : null),
                    ].filter(Boolean).forEach(l => lines.push(l as string))
                    fullJson(ac)
                  }

                  // F. Outcome & Learning
                  const ol = trace.outcomeLearning
                  if (ol) {
                    lines.push('', '  ── ' + 'F. Outcome & Learning' + ' ──', '')
                    ;[
                      kv('Phase',                        ol.phase),
                      kv('Success',                      ol.success != null ? (ol.success ? 'YES' : 'NO') : null),
                      kv('Auto Generated',               ol.auto_generated != null ? String(ol.auto_generated) : null),
                    ].filter(Boolean).forEach(l => lines.push(l as string))
                    fullJson(ol)
                  }

                  // Confidence Decomposition
                  const cd = trace.confidenceDecomposition
                  if (cd && Object.keys(cd).length) {
                    lines.push('', '  ── ' + 'Confidence Decomposition' + ' ──', '')
                    ;[
                      kv('Grounding Method',             cd.grounding_method),
                      kv('Retrieval Confidence',         cd.retrieval_confidence),
                      kv('Tool Correctness Confidence',  cd.tool_correctness_confidence),
                      kv('Evidence Sufficiency Conf.',   cd.evidence_sufficiency_confidence),
                      kv('Response Formulation Conf.',   cd.response_formulation_confidence),
                    ].filter(Boolean).forEach(l => lines.push(l as string))
                    fullJson(cd)
                  }

                  // Validation Result
                  const vr = trace.validationResult
                  if (vr && Object.keys(vr).length) {
                    lines.push('', '  ── ' + 'Validation Result' + ' ──', '')
                    ;[
                      kv('Outcome',                      vr.outcome),
                      kv('Validator Method',             vr.validator_method),
                      kv('Validator Confidence',         vr.validator_confidence != null ? `${Math.round(vr.validator_confidence * 100)}%` : null),
                      kv('Schema Consistency Passed',    vr.schema_consistency_passed != null ? String(vr.schema_consistency_passed) : null),
                      kv('Missing Required Vars',        vr.missing_required_vars),
                    ].filter(Boolean).forEach(l => lines.push(l as string))
                    if (Array.isArray(vr.validation_methods_applied) && vr.validation_methods_applied.length)
                      lines.push(`    Methods Applied: ${vr.validation_methods_applied.join(', ')}`)
                    fullJson(vr)
                  }

                  // Response Scorecard
                  const sc = trace.scorecard
                  if (sc && Object.keys(sc).length) {
                    lines.push('', '  ── ' + 'Response Scorecard' + ' ──', '')
                    ;[
                      kv('Confidence',                   sc.confidence != null ? `${Math.round(sc.confidence * 100)}%` : null),
                      kv('Coverage',                     sc.coverage_pct != null ? `${sc.coverage_pct}%` : null),
                      kv('Schema Passed',                sc.schema_passed != null ? String(sc.schema_passed) : null),
                      kv('Missing Required Vars',        sc.missing_required_vars),
                    ].filter(Boolean).forEach(l => lines.push(l as string))
                    if (Array.isArray(sc.validation_methods) && sc.validation_methods.length)
                      lines.push(`    Validation Methods: ${sc.validation_methods.join(', ')}`)
                    fullJson(sc)
                  }

                  // Learning Recommendation
                  const lr = trace.learningRecommendation
                  if (lr && Object.keys(lr).length) {
                    lines.push('', '  ── ' + 'Learning Recommendation' + ' ──', '')
                    ;[
                      kv('Type',                         lr.type),
                      kv('Action',                       lr.action),
                      kv('Target',                       lr.target),
                      kv('Context',                      lr.context),
                      kv('Confidence',                   lr.confidence != null ? `${Math.round(lr.confidence * 100)}%` : null),
                      kv('Notes',                        lr.notes),
                    ].filter(Boolean).forEach(l => lines.push(l as string))
                    fullJson(lr)
                  }

                  // Decision Lineage
                  const dl = trace.decisionLineage
                  if (dl && Object.keys(dl).length) {
                    lines.push('', '  ── ' + 'Decision Lineage' + ' ──', '')
                    lines.push(`    ${JSON.stringify(dl, null, 2).split('\n').join('\n    ')}`)
                  }

                  // Audit Evidence
                  const ae = trace.auditEvidence
                  if (ae && Object.keys(ae).length) {
                    lines.push('', '  ── ' + 'Audit Evidence' + ' ──', '')
                    lines.push(`    ${JSON.stringify(ae, null, 2).split('\n').join('\n    ')}`)
                  }

                  // Sources Retrieved
                  if (Array.isArray(trace.sourcesCited) && trace.sourcesCited.length) {
                    lines.push('', '  ── ' + `Sources Retrieved (${trace.sourcesCited.length})` + ' ──', '')
                    trace.sourcesCited.forEach((s: any, si: number) => {
                      const flags = [
                        s.is_domain_specific === true  ? '✓ domain-specific' : null,
                        s.is_domain_specific === false ? '⚠ generic section' : null,
                        s.low_relevance_flag === true  ? '⚠ low-relevance'   : null,
                        s.query_type ? `query:${s.query_type}` : null,
                        Array.isArray(s.relevant_variables) && s.relevant_variables.length
                          ? `vars:[${s.relevant_variables.join(',')}]` : null,
                      ].filter(Boolean).join(' ')
                      lines.push(`    [${si+1}] ${s.doc_name || s.document_name || 'Unknown'} — ${s.doc_type || ''}`)
                      lines.push(`         § ${s.section || '—'}`)
                      lines.push(`         Relevance: ${s.score != null ? `${(s.score*100).toFixed(0)}%` : '?'}${flags ? `  ${flags}` : ''}`)
                      if (s.excerpt) lines.push(`         Excerpt: ${s.excerpt}`)
                      if (s.used_for) lines.push(`         Used for: ${s.used_for}`)
                      if (s.retrieval_note) lines.push(`         Note: ${s.retrieval_note}`)
                      lines.push(`         Full JSON: ${JSON.stringify(s)}`)
                    })
                  }

                  // Reasoning Chain
                  if (Array.isArray(trace.reasoningSteps) && trace.reasoningSteps.length) {
                    lines.push('', '  ── ' + `Reasoning Chain (${trace.reasoningSteps.length} steps)` + ' ──', '')
                    trace.reasoningSteps.forEach((step: any, si: number) => {
                      lines.push(`    ${step.step ?? si+1}. ${step.name ? `[${step.name}]` : ''}${step.status ? ` (${step.status})` : ''}`)
                      if (step.thought)   lines.push(`       ${step.thought}`)
                      if (step.decision)  lines.push(`       Decision: ${step.decision}`)
                      const meta = [
                        step.tool_used ? `tool:${step.tool_used}` : null,
                        step.action    ? `action:${step.action}`  : null,
                        step.model     ? `model:${step.model}`    : null,
                        step.result_count != null ? `${step.result_count} results` : null,
                        step.chunk_count  != null ? `${step.chunk_count} chunks`   : null,
                        step.prompt_length!= null ? `${step.prompt_length} chars`  : null,
                        step.from_cache != null ? (step.from_cache ? 'cache hit' : 'cache miss') : null,
                      ].filter(Boolean).join(' · ')
                      if (meta) lines.push(`       ${meta}`)
                      if (step.inputs  && Object.keys(step.inputs).length)
                        lines.push(`       Inputs:  ${JSON.stringify(step.inputs, null, 2).split('\n').join('\n                 ')}`)
                      if (step.outputs && Object.keys(step.outputs).length)
                        lines.push(`       Outputs: ${JSON.stringify(step.outputs, null, 2).split('\n').join('\n                 ')}`)
                    })
                  }

                  // Prompt preview
                  if (ctx.prompt_preview && !isDet) {
                    lines.push('', '  ── ' + 'Prompt Sent to Model' + ' ──', '')
                    ctx.prompt_preview.split('\n').slice(0, 30).forEach((l: string) =>
                      lines.push(`    ${l}`)
                    )
                    if (ctx.prompt_preview.split('\n').length > 30) lines.push('    [... truncated]')
                  }

                  // Output / Final Answer
                  if (trace.output?.content || trace.output?.summary) {
                    lines.push('', '  ── ' + (isDet ? 'Pre-computed Answer' : trace.traceType === 'output' ? 'Final Answer' : 'Generated Answer') + ' ──', '')
                    const txt = trace.output.content || trace.output.summary
                    txt.split('\n').forEach((l: string) => lines.push(`    ${l}`))
                    if (trace.output.full_length) lines.push(`    [${trace.output.full_length} chars total]`)
                  }

                  // Feedback / Corrections
                  const fbs = Array.isArray(trace.feedbackEvents) ? trace.feedbackEvents : []
                  if (fbs.length) {
                    lines.push('', '  ── ' + `Feedback / Corrections (${fbs.length})` + ' ──', '')
                    fbs.forEach((fb: any, fi: number) => {
                      lines.push(`    [${fi+1}] type=${fb.feedback_type || '—'} category=${fb.feedback_value?.feedback_category || '—'} at=${fb.created_at ? new Date(fb.created_at).toLocaleString() : '—'}`)
                      lines.push(`         ${JSON.stringify(fb.feedback_value || {}, null, 0)}`)
                    })
                  }

                  lines.push(``)
                })

                lines.push(sep('='))
                lines.push(`END OF DECISION TRACES`)
                const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `decision-traces-${runId}.txt`
                document.body.appendChild(a)
                a.click()
                document.body.removeChild(a)
                URL.revokeObjectURL(url)
              }}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg transition-colors shadow-sm whitespace-nowrap">
              <Download className="w-3.5 h-3.5" /> Download (.txt)
            </button>
          </div>
          {traces.length === 0 ? (
            <p className="text-slate-400 text-sm py-8 text-center">No decision traces yet.</p>
          ) : traces.map((trace, traceIdx) => {
            const tc = TRACE_TYPE_CONFIG[trace.traceType] || { label: trace.traceType, cls: 'bg-slate-100 text-slate-600' }
            const mc = trace.mistakeType ? MISTAKE_TYPE_CONFIG[trace.mistakeType] : null
            const ctx = trace.inputContext || {}
            const isDeterministic = ctx.provider === 'deterministic' || ctx.model === 'deterministic'
            const isOutput = trace.traceType === 'output'
            const stageEntries = [
              { title: 'A. Intent Resolution', payload: trace.intentResolution },
              { title: 'B. Retrieval Plan', payload: trace.retrievalPlan },
              { title: 'C. Evidence Assembly', payload: trace.evidenceAssembly },
              { title: 'D. Execution Mode', payload: trace.executionMode },
              { title: 'E. Answer Construction', payload: trace.answerConstruction },
              { title: 'F. Outcome & Learning', payload: trace.outcomeLearning },
            ]
            const hasV2Stages = stageEntries.some(entry => hasStagePayload(entry.payload))
            const hasConfidenceDecomposition = hasStagePayload(trace.confidenceDecomposition)
            const hasValidation = hasStagePayload(trace.validationResult)
            const hasScorecard = hasStagePayload(trace.scorecard)
            const hasLearnings = hasStagePayload(trace.learningRecommendation)
            const hasDecisionLineage = hasStagePayload(trace.decisionLineage)
            const hasAuditEvidence = hasStagePayload(trace.auditEvidence)
            const feedbackEvents = Array.isArray(trace.feedbackEvents) ? trace.feedbackEvents : []

            // Build a human-readable summary line for the collapsed row
            let summaryLine = ''
            if (ctx.user_message)        summaryLine = ctx.user_message
            else if (ctx.query)          summaryLine = ctx.query
            else if (trace.output?.summary) summaryLine = trace.output.summary
            else if (isOutput)           summaryLine = 'Final answer assembled'

            // WHAT label — describes the action taken
            const whatLabel = getTraceWhatLabel(trace, tc.label, isDeterministic)
            const whyLabel = getTraceWhyLabel(trace, isDeterministic)

            return (
              <div key={trace.id} className="bg-white rounded-xl border border-slate-100 overflow-hidden">
                {/* ── Collapsed header ── */}
                <button
                  onClick={() => setExpandedTrace(expandedTrace === trace.id ? null : trace.id)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50 transition-colors text-left">
                  <div className="flex items-center gap-2.5 min-w-0">
                    {/* Step index pill */}
                    <span className="w-5 h-5 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-[10px] font-bold flex-shrink-0">
                      {traceIdx + 1}
                    </span>
                    <span className={clsx('text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0', tc.cls)}>
                      {tc.label}
                    </span>
                    {mc && (
                      <span className={clsx('text-[10px] px-1.5 py-0.5 rounded font-bold flex-shrink-0', mc.cls)}>
                        {mc.label}
                      </span>
                    )}
                    {isDeterministic && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-indigo-50 text-indigo-600 flex-shrink-0">
                        DETERMINISTIC
                      </span>
                    )}
                    <span className="text-sm text-slate-700 truncate">{summaryLine || whatLabel}</span>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0 ml-3">
                    {trace.sourcesCited?.length > 0 && (
                      <span className="hidden sm:inline text-[10px] text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded">
                        {trace.sourcesCited.length} sources
                      </span>
                    )}
                    {trace.confidence != null && (
                      <div className="w-20 hidden sm:block">
                        <ConfidenceBar value={trace.confidence} />
                      </div>
                    )}
                    <span className="text-xs text-slate-400 whitespace-nowrap">{formatTs(trace.createdAt)}</span>
                    {expandedTrace === trace.id
                      ? <ChevronDown className="w-4 h-4 text-slate-400" />
                      : <ChevronRight className="w-4 h-4 text-slate-400" />}
                  </div>
                </button>

                {expandedTrace === trace.id && (
                  <div className="border-t border-slate-100">

                    {/* ── WHEN / WHAT / WHY header bar ── */}
                    <div className="grid grid-cols-3 divide-x divide-slate-100 bg-slate-50 text-[11px]">
                      <div className="px-4 py-2.5">
                        <p className="text-slate-400 font-semibold uppercase tracking-wide mb-0.5">WHEN</p>
                        <p className="text-slate-700 font-mono">{formatTs(trace.createdAt)}</p>
                        {trace.confidence != null && (
                          <p className="text-slate-500 mt-0.5">Confidence: {Math.round(trace.confidence * 100)}%</p>
                        )}
                      </div>
                      <div className="px-4 py-2.5">
                        <p className="text-slate-400 font-semibold uppercase tracking-wide mb-0.5">WHAT</p>
                        <p className="text-slate-700">{whatLabel}</p>
                        {ctx.node_label && (
                          <p className="text-slate-500 mt-0.5">Node: <span className="font-medium">{ctx.node_label}</span></p>
                        )}
                      </div>
                      <div className="px-4 py-2.5">
                        <p className="text-slate-400 font-semibold uppercase tracking-wide mb-0.5">WHY</p>
                        <p className="text-slate-700">{whyLabel}</p>
                      </div>
                    </div>

                    <div className="px-4 pb-4 space-y-4 pt-4">

                      {trace.humanReadableSummary && (
                        <div className="rounded-lg border border-sky-100 bg-sky-50 p-3">
                          <h4 className="text-xs font-semibold text-sky-700 mb-1.5">Explanation</h4>
                          <p className="text-xs text-sky-900 leading-relaxed">{trace.humanReadableSummary}</p>
                        </div>
                      )}

                      {(hasV2Stages || hasConfidenceDecomposition) && (
                        <div>
                          <h4 className="text-xs font-semibold text-slate-600 mb-2 flex items-center gap-1.5">
                            <Activity className="w-3.5 h-3.5 text-slate-400" />
                            Machine-Usable Stages {trace.traceVersion ? `(v${trace.traceVersion})` : '(v2)'}
                          </h4>
                          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
                            {stageEntries.map(entry => (
                              entry.title === 'B. Retrieval Plan'
                                ? <RetrievalPlanCard key={entry.title} payload={entry.payload} />
                                : <StagePayloadCard key={entry.title} title={entry.title} payload={entry.payload} />
                            ))}
                            <StagePayloadCard title="Confidence Decomposition" payload={trace.confidenceDecomposition} />
                          </div>
                        </div>
                      )}

                      {(hasValidation || hasScorecard || hasLearnings) && (
                        <div>
                          <h4 className="text-xs font-semibold text-slate-600 mb-2 flex items-center gap-1.5">
                            <CheckCircle className="w-3.5 h-3.5 text-slate-400" /> Validation & Quality
                          </h4>
                          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
                            <StagePayloadCard title="Validation Result" payload={trace.validationResult} />
                            <StagePayloadCard title="Response Scorecard" payload={trace.scorecard} />
                            <StagePayloadCard title="Learning Recommendation" payload={trace.learningRecommendation} />
                          </div>
                        </div>
                      )}

                      {(hasDecisionLineage || hasAuditEvidence) && (
                        <div>
                          <h4 className="text-xs font-semibold text-slate-600 mb-2 flex items-center gap-1.5">
                            <Shield className="w-3.5 h-3.5 text-slate-400" /> Audit & Provenance
                          </h4>
                          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
                            <StagePayloadCard title="Decision Lineage" payload={trace.decisionLineage} />
                            <StagePayloadCard title="Audit Evidence" payload={trace.auditEvidence} />
                          </div>
                        </div>
                      )}

                      {feedbackEvents.length > 0 && (
                        <div>
                          <h4 className="text-xs font-semibold text-slate-600 mb-2 flex items-center gap-1.5">
                            <ThumbsUp className="w-3.5 h-3.5 text-slate-400" /> Feedback / Corrections ({feedbackEvents.length})
                          </h4>
                          <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                            {feedbackEvents.map((fb: any, idx: number) => (
                              <div key={fb.id || idx} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                                <div className="flex items-center gap-2 text-xs mb-1.5">
                                  <span className="px-1.5 py-0.5 rounded bg-white border border-slate-200 text-slate-600 font-medium">
                                    {fb.feedback_type || 'feedback'}
                                  </span>
                                  {fb.feedback_value?.feedback_category && (
                                    <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 font-medium">
                                      {fb.feedback_value.feedback_category}
                                    </span>
                                  )}
                                  <span className="ml-auto text-slate-400">{formatTs(fb.created_at)}</span>
                                </div>
                                <pre className="text-[11px] text-slate-700 whitespace-pre-wrap break-words font-mono">
                                  {JSON.stringify(fb.feedback_value || {}, null, 2)}
                                </pre>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Reasoning chain */}
                      {Array.isArray(trace.reasoningSteps) && trace.reasoningSteps.length > 0 && (
                        <div>
                          <h4 className="text-xs font-semibold text-slate-600 mb-2 flex items-center gap-1.5">
                            <Brain className="w-3.5 h-3.5 text-slate-400" /> Reasoning Chain
                          </h4>
                          <div className="relative pl-4">
                            {/* vertical line */}
                            <div className="absolute left-[7px] top-2 bottom-2 w-px bg-slate-200" />
                            <div className="space-y-3">
                              {trace.reasoningSteps.map((step: any, i: number) => (
                                <div key={i} className="flex gap-3 relative">
                                  <span className="w-4 h-4 rounded-full border-2 border-brand-400 bg-white flex items-center justify-center text-[9px] font-bold text-brand-600 flex-shrink-0 relative z-10 -ml-1">
                                    {step.step || i + 1}
                                  </span>
                                  <div className="flex-1 min-w-0">
                                    {/* Step name + status */}
                                    {step.name && (
                                      <div className="flex items-center gap-1.5 mb-0.5">
                                        <span className="text-[10px] font-semibold text-slate-600">{step.name}</span>
                                        {step.status && (
                                          <span className={clsx('text-[9px] px-1.5 py-0.5 rounded font-medium',
                                            step.status === 'completed' ? 'bg-green-50 text-green-700' :
                                            step.status === 'skipped'   ? 'bg-slate-100 text-slate-400' :
                                            step.status === 'failed'    ? 'bg-red-50 text-red-600' :
                                            'bg-blue-50 text-blue-600')}>
                                            {step.status}
                                          </span>
                                        )}
                                      </div>
                                    )}
                                    <p className="text-xs text-slate-700 font-medium leading-snug">{step.thought}</p>
                                    {/* Decision rationale */}
                                    {step.decision && (
                                      <p className="text-[10px] text-slate-500 mt-0.5 italic leading-snug">{step.decision}</p>
                                    )}
                                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                      {step.action && (
                                        <span className="text-[10px] text-slate-400 font-mono">{step.action}</span>
                                      )}
                                      {step.tool_used && (
                                        <span className="text-[10px] px-1.5 py-0.5 bg-brand-50 text-brand-600 rounded font-medium">
                                          tool: {step.tool_used}
                                        </span>
                                      )}
                                      {step.model && (
                                        <span className="text-[10px] px-1.5 py-0.5 bg-purple-50 text-purple-600 rounded font-medium">
                                          {step.model}
                                        </span>
                                      )}
                                      {step.result_count != null && (
                                        <span className="text-[10px] text-slate-400">{step.result_count} results</span>
                                      )}
                                      {step.chunk_count != null && (
                                        <span className="text-[10px] text-slate-400">{step.chunk_count} chunks</span>
                                      )}
                                      {step.prompt_length != null && (
                                        <span className="text-[10px] text-slate-400">{step.prompt_length} chars</span>
                                      )}
                                      {step.from_cache != null && (
                                        <span className={clsx('text-[10px] px-1 rounded', step.from_cache ? 'bg-green-50 text-green-600' : 'bg-slate-100 text-slate-500')}>
                                          {step.from_cache ? 'cache hit' : 'cache miss'}
                                        </span>
                                      )}
                                    </div>
                                    {/* Inputs/Outputs summary */}
                                    {(step.inputs || step.outputs) && (
                                      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                                        {step.inputs && Object.keys(step.inputs).length > 0 && (
                                          <div className="bg-slate-50 rounded p-1.5 border border-slate-100">
                                            <p className="text-[9px] font-semibold text-slate-400 uppercase mb-0.5">Inputs</p>
                                            <pre className="text-[9px] text-slate-600 font-mono whitespace-pre-wrap break-words">
                                              {JSON.stringify(step.inputs, null, 1).slice(0, 200)}
                                            </pre>
                                          </div>
                                        )}
                                        {step.outputs && Object.keys(step.outputs).length > 0 && (
                                          <div className="bg-green-50 rounded p-1.5 border border-green-100">
                                            <p className="text-[9px] font-semibold text-green-600 uppercase mb-0.5">Outputs</p>
                                            <pre className="text-[9px] text-slate-600 font-mono whitespace-pre-wrap break-words">
                                              {JSON.stringify(step.outputs, null, 1).slice(0, 200)}
                                            </pre>
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Prompt preview (LLM traces) */}
                      {ctx.prompt_preview && !isDeterministic && (
                        <div>
                          <h4 className="text-xs font-semibold text-slate-600 mb-1.5 flex items-center gap-1.5">
                            <Database className="w-3.5 h-3.5 text-slate-400" /> Prompt sent to model
                          </h4>
                          <pre className="text-[11px] text-slate-600 bg-slate-50 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap max-h-48 font-mono border border-slate-100">
                            {ctx.prompt_preview}
                          </pre>
                        </div>
                      )}

                      {/* Sources retrieved */}
                      {Array.isArray(trace.sourcesCited) && trace.sourcesCited.length > 0 && (
                        <div>
                          <h4 className="text-xs font-semibold text-slate-600 mb-2 flex items-center gap-1.5">
                            <Database className="w-3.5 h-3.5 text-slate-400" />
                            {trace.sourcesCited.length} Sources Retrieved
                          </h4>
                          <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                            {trace.sourcesCited.map((s: any, i: number) => (
                              <div key={i} className="bg-slate-50 rounded-lg p-2.5 text-xs border border-slate-100">
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="text-[10px] font-bold text-slate-400">#{i + 1}</span>
                                  <span className="font-medium text-slate-700">{s.doc_name || s.document_name || 'Unknown'}</span>
                                  {s.doc_type && (
                                    <span className="px-1.5 py-0.5 bg-white border border-slate-200 rounded text-[10px] text-slate-500">{s.doc_type}</span>
                                  )}
                                  {s.section && (
                                    <span className="text-[10px] text-slate-400 truncate max-w-[160px]">§ {s.section}</span>
                                  )}
                                  {s.score != null && (
                                    <span className={clsx('ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded',
                                      s.score >= 0.8 ? 'bg-green-50 text-green-700' :
                                      s.score >= 0.6 ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500')}>
                                      {(s.score * 100).toFixed(0)}% relevance
                                    </span>
                                  )}
                                </div>
                                {s.excerpt && (
                                  <p className="text-slate-500 text-[11px] leading-relaxed line-clamp-3">{s.excerpt}</p>
                                )}
                                {/* Traceability badges — query_type, domain specificity, relevance flags */}
                                <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                                  {s.query_type && (
                                    <span className="text-[9px] px-1.5 py-0.5 bg-indigo-50 text-indigo-600 rounded font-medium uppercase tracking-wide">
                                      {s.query_type.replace(/_/g, ' ')}
                                    </span>
                                  )}
                                  {s.is_domain_specific === true && (
                                    <span className="text-[9px] px-1.5 py-0.5 bg-green-50 text-green-700 rounded font-medium">
                                      ✓ domain-specific
                                    </span>
                                  )}
                                  {s.is_domain_specific === false && s.query_type && (
                                    <span className="text-[9px] px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded font-medium">
                                      ⚠ generic section
                                    </span>
                                  )}
                                  {s.low_relevance_flag === true && (
                                    <span className="text-[9px] px-1.5 py-0.5 bg-red-50 text-red-600 rounded font-medium">
                                      low relevance
                                    </span>
                                  )}
                                  {Array.isArray(s.relevant_variables) && s.relevant_variables.length > 0 && (
                                    <span className="text-[9px] px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded font-mono"
                                      title={s.relevant_variables.join(', ')}>
                                      {s.relevant_variables.length} var{s.relevant_variables.length !== 1 ? 's' : ''} matched
                                    </span>
                                  )}
                                  {s.used_for && (
                                    <span className="text-[9px] text-slate-400 italic truncate max-w-[220px]" title={s.used_for}>
                                      {s.used_for}
                                    </span>
                                  )}
                                </div>
                                {s.retrieval_note && (
                                  <p className="text-[10px] text-amber-700 bg-amber-50 rounded px-2 py-1 mt-1.5 border border-amber-100">
                                    {s.retrieval_note}
                                  </p>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Answer / output */}
                      {(trace.output?.content || trace.output?.summary) && (
                        <div>
                          <h4 className="text-xs font-semibold text-slate-600 mb-1.5 flex items-center gap-1.5">
                            <CheckCircle className="w-3.5 h-3.5 text-green-500" />
                            {isDeterministic ? 'Pre-computed Answer' : trace.traceType === 'output' ? 'Final Answer' : 'Generated Answer'}
                          </h4>
                          <div className="bg-green-50 border border-green-100 rounded-lg p-3 text-sm text-slate-700 leading-relaxed">
                            {trace.output.content || trace.output.summary}
                          </div>
                          {trace.output.full_length && (
                            <p className="text-[10px] text-slate-400 mt-1">{trace.output.full_length} chars total</p>
                          )}
                        </div>
                      )}

                      {/* Per-trace feedback */}
                      <div className="pt-2 border-t border-slate-100">
                        <TraceFeedback traceId={trace.id} orgId={orgId} userId={userId} />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Artifacts ── */}
      {activeTab === 'artifacts' && (
        <ArtifactsPanel artifacts={artifacts} runId={runId} run={run} />
      )}

      {/* ── Evaluation ── */}
      {activeTab === 'evaluation' && (
        <div className="space-y-6">
          {!ev ? (
            <div className="text-center py-12 text-slate-400">
              <Activity className="w-8 h-8 mx-auto mb-2 text-slate-200" />
              <p className="text-sm">No evaluation data yet.</p>
              <p className="text-xs mt-1">Evaluation runs automatically after run completion.</p>
            </div>
          ) : (
            <>
              {/* Row 1 — Key metric cards */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                <MetricCard
                  label="Task Completed"
                  value={ev.taskCompleted == null ? '—' : ev.taskCompleted ? '✓' : '✗'}
                  colorCls={ev.taskCompleted == null ? 'text-slate-400' : ev.taskCompleted ? 'text-green-600' : 'text-red-500'}
                />
                <MetricCard
                  label="Latency"
                  value={ev.latencyMs != null ? `${(ev.latencyMs / 1000).toFixed(1)}s` : run.latencyMs != null ? `${(run.latencyMs / 1000).toFixed(1)}s` : '—'}
                />
                <MetricCard
                  label="Cost"
                  value={ev.costUsd != null ? `$${ev.costUsd.toFixed(4)}` : run.costUsd != null ? `$${run.costUsd.toFixed(4)}` : '—'}
                />
                <MetricCard
                  label="Turn Count"
                  value={ev.turnCount ?? run.turnCount ?? '—'}
                />
                <MetricCard
                  label="Tool Accuracy"
                  value={ev.toolUsageAccuracy != null ? `${Math.round(ev.toolUsageAccuracy * 100)}%` : '—'}
                  colorCls={
                    ev.toolUsageAccuracy == null ? 'text-slate-400' :
                    ev.toolUsageAccuracy >= 0.8 ? 'text-green-600' :
                    ev.toolUsageAccuracy >= 0.5 ? 'text-amber-600' : 'text-red-500'
                  }
                />
                <MetricCard
                  label="Judge Verdict"
                  value={
                    verdictCfg ? (
                      <span className={clsx('text-sm px-2 py-0.5 rounded-full font-semibold', verdictCfg.cls)}>
                        {ev.judgeVerdict}
                      </span>
                    ) : '—'
                  }
                />
              </div>

              {/* Row 2 — Charts */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">

                {/* Faithfulness + Reasoning gauges */}
                <div className="bg-white rounded-xl border border-slate-100 p-4">
                  <h4 className="text-xs font-medium text-slate-500 mb-3">Faithfulness & Reasoning</h4>
                  <ResponsiveContainer width="100%" height={140}>
                    <RadialBarChart
                      cx="50%" cy="100%"
                      innerRadius="40%"
                      outerRadius="90%"
                      barSize={12}
                      startAngle={180}
                      endAngle={0}
                      data={[
                        { name: 'Reasoning',    value: Math.round((ev.reasoningScore ?? 0) * 100),    fill: '#818cf8' },
                        { name: 'Faithfulness', value: Math.round((ev.faithfulnessScore ?? 0) * 100), fill: '#34d399' },
                      ]}
                    >
                      <RadialBar dataKey="value" cornerRadius={6} />
                      <Legend iconSize={8} wrapperStyle={{ fontSize: '11px', bottom: -4 }} />
                      <Tooltip formatter={(v: any) => `${v}%`} />
                    </RadialBarChart>
                  </ResponsiveContainer>
                </div>

                {/* Hallucination indicator */}
                <div className="bg-white rounded-xl border border-slate-100 p-4">
                  <h4 className="text-xs font-medium text-slate-500 mb-3">Hallucination</h4>
                  <div className="flex items-center gap-2 mb-3">
                    <span className={clsx('px-2 py-1 rounded-full text-xs font-semibold',
                      ev.hallucinationDetected ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700')}>
                      {ev.hallucinationDetected ? 'Detected' : 'None detected'}
                    </span>
                  </div>
                  <ResponsiveContainer width="100%" height={90}>
                    <BarChart data={[{ name: 'Rate', value: Math.round((ev.hallucinationRate ?? 0) * 100) }]} barSize={32}>
                      <XAxis dataKey="name" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} tickFormatter={v => `${v}%`} width={30} />
                      <Tooltip formatter={(v: any) => `${v}%`} />
                      <Bar dataKey="value" radius={[4, 4, 0, 0]}
                        fill={ev.hallucinationDetected ? '#f87171' : '#34d399'} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Tool usage breakdown */}
                <div className="bg-white rounded-xl border border-slate-100 p-4">
                  <h4 className="text-xs font-medium text-slate-500 mb-3">Tool Usage</h4>
                  {(ev.toolCallsTotal ?? run.toolCallsTotal) > 0 ? (
                    <>
                      <ResponsiveContainer width="100%" height={110}>
                        <PieChart>
                          <Pie
                            data={[
                              { name: 'Success', value: ev.toolCallsSuccessful ?? run.toolCallsSuccessful ?? 0 },
                              { name: 'Failed',  value: Math.max(0, (ev.toolCallsTotal ?? run.toolCallsTotal ?? 0) - (ev.toolCallsSuccessful ?? run.toolCallsSuccessful ?? 0)) },
                            ]}
                            cx="50%" cy="50%"
                            innerRadius={28} outerRadius={48}
                            paddingAngle={3}
                            dataKey="value"
                          >
                            <RechartsCell key="success" fill="#34d399" />
                            <RechartsCell key="failed"  fill="#f87171" />
                          </Pie>
                          <Tooltip />
                          <Legend iconSize={8} wrapperStyle={{ fontSize: '11px' }} />
                        </PieChart>
                      </ResponsiveContainer>
                      <p className="text-xs text-center text-slate-400 mt-1">
                        {ev.toolCallsSuccessful ?? run.toolCallsSuccessful ?? 0} / {ev.toolCallsTotal ?? run.toolCallsTotal ?? 0} calls
                      </p>
                    </>
                  ) : (
                    <p className="text-xs text-slate-400 text-center py-8">No tool calls</p>
                  )}
                </div>

                {/* Accuracy scores bar chart */}
                <div className="bg-white rounded-xl border border-slate-100 p-4">
                  <h4 className="text-xs font-medium text-slate-500 mb-3">Accuracy Scores</h4>
                  <ResponsiveContainer width="100%" height={140}>
                    <BarChart
                      layout="vertical"
                      data={[
                        { name: 'Faithfulness', value: Math.round((ev.faithfulnessScore ?? 0) * 100) },
                        { name: 'Reasoning',    value: Math.round((ev.reasoningScore ?? 0) * 100) },
                        { name: 'Tool',         value: Math.round((ev.toolUsageAccuracy ?? 1) * 100) },
                      ]}
                      barSize={14}
                    >
                      <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10 }} tickFormatter={v => `${v}%`} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={72} />
                      <Tooltip formatter={(v: any) => `${v}%`} />
                      <Bar dataKey="value" radius={[0, 4, 4, 0]} fill="#818cf8" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Row 3 — Judge notes */}
              {(ev.judgeNotes || ev.judgeModel) && (
                <div className="bg-slate-50 rounded-xl border border-slate-100 px-5 py-4">
                  <div className="flex items-start gap-2">
                    <Brain className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
                    <div>
                      {ev.judgeNotes && (
                        <p className="text-sm text-slate-600 italic">"{ev.judgeNotes}"</p>
                      )}
                      <p className="text-xs text-slate-400 mt-1.5">
                        {ev.judgeModel && <>LLM Judge: <span className="font-mono">{ev.judgeModel}</span>{' · '}</>}
                        Evaluated {formatTs(ev.evaluatedAt)}
                        {ev.evaluator && <> · Evaluator: {ev.evaluator}</>}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── Evaluator Results Section ── */}
          {evaluatorResults.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-indigo-500" />
                <h3 className="text-sm font-semibold text-slate-800">Evaluator Results</h3>
                <span className="text-xs text-slate-400">{evaluatorResults.length} evaluator{evaluatorResults.length !== 1 ? 's' : ''} run</span>
              </div>
              <div className="space-y-3">
                {evaluatorResults.map((r: any) => {
                  const pct = r.score != null ? Math.round(r.score * 100) : null
                  const scoreColor = pct == null ? 'text-slate-400' : pct >= 80 ? 'text-green-600' : pct >= 60 ? 'text-amber-600' : 'text-red-500'
                  const verdictCls = r.verdict === 'pass' ? 'bg-green-100 text-green-700' : r.verdict === 'fail' ? 'bg-red-100 text-red-700' : r.verdict === 'partial' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'
                  const details = r.details || {}
                  const dims: Record<string, number> = details.scoring_dimensions || {}
                  const rawFields: Record<string, string> = details.raw_parsed_fields || {}
                  const qualitative: Record<string, string> = details.qualitative_findings || {
                    ...(details.violations && details.violations !== 'none' ? { violations: details.violations } : {}),
                    ...(details.issues && details.issues !== 'none' ? { issues: details.issues } : {}),
                  }
                  return (
                    <div key={r.id} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                      {/* Header row */}
                      <div className="flex items-start justify-between px-5 pt-4 pb-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <p className="text-sm font-semibold text-slate-800">{r.evaluatorName}</p>
                            {r.isBuiltin && <span className="text-[10px] bg-indigo-50 text-indigo-600 px-1.5 py-0.5 rounded font-medium">built-in</span>}
                          </div>
                          <p className="text-xs text-slate-400">{r.evaluatorCategory} · <span className="font-mono">{r.evaluatorSlug}</span> · Judge: <span className="font-mono">{r.judgeModel || '—'}</span></p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className={clsx('text-xs px-2.5 py-1 rounded-full font-semibold', verdictCls)}>{r.verdict || 'pending'}</span>
                          {pct != null && (
                            <span className={clsx('text-xl font-bold tabular-nums', scoreColor)}>{pct}<span className="text-xs font-normal">%</span></span>
                          )}
                        </div>
                      </div>

                      {/* Overall score bar */}
                      {pct != null && (
                        <div className="px-5 mb-3">
                          <div className="w-full bg-slate-100 rounded-full h-2">
                            <div className={clsx('h-2 rounded-full transition-all', pct >= 80 ? 'bg-green-500' : pct >= 60 ? 'bg-amber-500' : 'bg-red-500')}
                              style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      )}

                      {/* Scoring dimension breakdown */}
                      {Object.keys(dims).length > 0 && (
                        <div className="px-5 pb-3 space-y-1.5">
                          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">Scoring Breakdown</p>
                          {Object.entries(dims).map(([dim, val]) => {
                            const pctDim = Math.round((val as number) * 100)
                            return (
                              <div key={dim} className="flex items-center gap-3">
                                <span className="text-xs text-slate-500 w-48 truncate capitalize">{dim.replace(/_/g, ' ')}</span>
                                <div className="flex-1 bg-slate-100 rounded-full h-1.5">
                                  <div className={clsx('h-1.5 rounded-full', pctDim >= 80 ? 'bg-green-500' : pctDim >= 60 ? 'bg-amber-500' : 'bg-red-500')}
                                    style={{ width: `${pctDim}%` }} />
                                </div>
                                <span className={clsx('text-xs font-semibold tabular-nums w-10 text-right',
                                  pctDim >= 80 ? 'text-green-600' : pctDim >= 60 ? 'text-amber-600' : 'text-red-500')}>
                                  {pctDim}%
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      )}

                      {/* Qualitative findings — violations, invented facts, unsupported claims, etc. */}
                      {Object.keys(qualitative).length > 0 && (
                        <div className="mx-5 mb-3 space-y-2">
                          {Object.entries(qualitative).map(([k, v]) => {
                            const isNegative = ['violations', 'invented_facts', 'unsupported_claims'].includes(k)
                            return (
                              <div key={k} className={clsx(
                                'border rounded-lg px-3 py-2',
                                isNegative ? 'bg-red-50 border-red-100' : 'bg-amber-50 border-amber-100'
                              )}>
                                <p className={clsx('text-[10px] font-semibold uppercase mb-0.5',
                                  isNegative ? 'text-red-500' : 'text-amber-600')}>
                                  {k.replace(/_/g, ' ')}
                                </p>
                                <p className={clsx('text-xs', isNegative ? 'text-red-700' : 'text-amber-700')}>{String(v)}</p>
                              </div>
                            )
                          })}
                        </div>
                      )}

                      {/* Other qualitative raw fields */}
                      {Object.keys(rawFields).length > 0 && (
                        <div className="px-5 pb-3 space-y-1">
                          {Object.entries(rawFields).map(([k, v]) => (
                            <div key={k} className="flex gap-2 text-xs">
                              <span className="text-slate-400 capitalize flex-shrink-0">{k.replace(/_/g, ' ')}:</span>
                              <span className="text-slate-600">{String(v)}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Notes */}
                      {r.notes && (
                        <div className="px-5 pb-3">
                          <p className="text-xs text-slate-600 italic bg-slate-50 rounded-lg px-3 py-2">"{r.notes}"</p>
                        </div>
                      )}

                      {r.errorMessage && (
                        <div className="mx-5 mb-3 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                          <p className="text-xs text-red-600">Error: {r.errorMessage}</p>
                        </div>
                      )}

                      {/* Input/Output context (audit trail) */}
                      {(details.input_used || details.output_evaluated) && (
                        <details className="px-5 pb-4">
                          <summary className="text-[10px] text-slate-400 cursor-pointer hover:text-slate-600 select-none">
                            Show audit context (input / output evaluated)
                          </summary>
                          <div className="mt-2 space-y-2">
                            {details.input_used && (
                              <div>
                                <p className="text-[10px] font-semibold text-slate-400 uppercase mb-1">Input evaluated</p>
                                <p className="text-xs text-slate-600 bg-slate-50 rounded px-2 py-1.5 font-mono whitespace-pre-wrap">{details.input_used}</p>
                              </div>
                            )}
                            {details.output_evaluated && (
                              <div>
                                <p className="text-[10px] font-semibold text-slate-400 uppercase mb-1">Output evaluated</p>
                                <p className="text-xs text-slate-600 bg-slate-50 rounded px-2 py-1.5 font-mono whitespace-pre-wrap line-clamp-6">{details.output_evaluated}</p>
                              </div>
                            )}
                            {details.raw_llm_response && (
                              <div>
                                <p className="text-[10px] font-semibold text-slate-400 uppercase mb-1">Raw LLM judge response</p>
                                <pre className="text-[10px] text-slate-500 bg-slate-50 rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap">{details.raw_llm_response}</pre>
                              </div>
                            )}
                          </div>
                        </details>
                      )}

                      {/* Footer */}
                      <div className="px-5 pb-3 flex items-center justify-between border-t border-slate-50 pt-2">
                        <p className="text-[10px] text-slate-300">
                          Run {fmtDate(r.createdAt)}{r.triggeredBy ? ` · by ${r.triggeredBy}` : ''}
                          {details.scoring_method ? ` · ${details.scoring_method}` : ''}
                        </p>
                        <span className="text-[10px] font-mono text-slate-300">{r.id?.slice(0, 8)}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* ── Evaluator Catalog ── */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-slate-500" />
                <h3 className="text-sm font-semibold text-slate-800">Available Evaluators</h3>
                <span className="text-xs text-slate-400">{evaluatorCatalog.length} evaluator{evaluatorCatalog.length !== 1 ? 's' : ''}</span>
              </div>
              <button
                onClick={() => setShowCustomEvaluatorForm(v => !v)}
                className="flex items-center gap-1 text-xs bg-indigo-600 text-white px-3 py-1.5 rounded-lg hover:bg-indigo-700 transition-colors"
              >
                <span>+ Custom Evaluator</span>
              </button>
            </div>

            {/* Custom evaluator form */}
            {showCustomEvaluatorForm && (
              <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4 space-y-3">
                <h4 className="text-sm font-semibold text-indigo-800">Configure Custom Evaluator</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-slate-600 block mb-1">Name *</label>
                    <input className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                      placeholder="My Evaluator" value={customEvalForm.name}
                      onChange={e => setCustomEvalForm(f => ({ ...f, name: e.target.value }))} />
                  </div>
                  <div>
                    <label className="text-xs text-slate-600 block mb-1">Slug (unique key) *</label>
                    <input className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400"
                      placeholder="my_evaluator" value={customEvalForm.slug}
                      onChange={e => setCustomEvalForm(f => ({ ...f, slug: e.target.value.replace(/\s+/g, '_').toLowerCase() }))} />
                  </div>
                  <div className="col-span-2">
                    <label className="text-xs text-slate-600 block mb-1">Description</label>
                    <input className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                      placeholder="What does this evaluator check?" value={customEvalForm.description}
                      onChange={e => setCustomEvalForm(f => ({ ...f, description: e.target.value }))} />
                  </div>
                  <div>
                    <label className="text-xs text-slate-600 block mb-1">Category</label>
                    <select className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                      value={customEvalForm.category}
                      onChange={e => setCustomEvalForm(f => ({ ...f, category: e.target.value }))}>
                      <option value="quality">Quality</option>
                      <option value="safety">Safety</option>
                      <option value="compliance">Compliance</option>
                      <option value="domain">Domain</option>
                      <option value="performance">Performance</option>
                      <option value="custom">Custom</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-slate-600 block mb-1">Evaluator Type</label>
                    <select className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                      value={customEvalForm.evaluatorType}
                      onChange={e => setCustomEvalForm(f => ({ ...f, evaluatorType: e.target.value }))}>
                      <option value="llm_judge">LLM Judge</option>
                      <option value="custom_prompt">Custom Prompt</option>
                      <option value="threshold">Threshold (rule-based)</option>
                    </select>
                  </div>
                  {(customEvalForm.evaluatorType === 'llm_judge' || customEvalForm.evaluatorType === 'custom_prompt') && (
                    <div className="col-span-2">
                      <label className="text-xs text-slate-600 block mb-1">
                        Prompt Template <span className="text-slate-400">(use {'{input}'}, {'{output}'}, {'{context}'} placeholders)</span>
                      </label>
                      <textarea className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400 resize-y"
                        rows={5} placeholder="Evaluate the following AI response for [your criteria]...&#10;Input: {input}&#10;Output: {output}&#10;Score from 0.0 to 1.0..."
                        value={customEvalForm.promptTemplate}
                        onChange={e => setCustomEvalForm(f => ({ ...f, promptTemplate: e.target.value }))} />
                    </div>
                  )}
                  <div>
                    <label className="text-xs text-slate-600 block mb-1">Langfuse Score Name</label>
                    <input className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400"
                      placeholder="my_evaluator_score" value={customEvalForm.langfuseScoreName}
                      onChange={e => setCustomEvalForm(f => ({ ...f, langfuseScoreName: e.target.value }))} />
                  </div>
                </div>
                <div className="flex gap-2 pt-1">
                  <button onClick={handleSaveCustomEvaluator} disabled={savingCustomEval || !customEvalForm.name || !customEvalForm.slug}
                    className="flex items-center gap-1 bg-indigo-600 text-white text-xs px-4 py-2 rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors">
                    {savingCustomEval ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                    Save Evaluator
                  </button>
                  <button onClick={() => setShowCustomEvaluatorForm(false)}
                    className="text-xs text-slate-500 px-3 py-2 rounded-lg hover:bg-slate-100 transition-colors">
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Catalog grid */}
            {evaluatorCatalog.length === 0 ? (
              <div className="text-center py-8 text-slate-400">
                <Activity className="w-6 h-6 mx-auto mb-2" />
                <p className="text-xs">Loading evaluator catalog...</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {evaluatorCatalog.map((ev: any) => {
                  const alreadyRun = evaluatorResults.find((r: any) => r.evaluatorId === ev.id)
                  const isTriggering = triggeringEvaluator === ev.id
                  const isEditing = editingEvaluatorId === ev.id
                  const catColors: Record<string, string> = {
                    quality: 'bg-indigo-50 text-indigo-600',
                    safety: 'bg-red-50 text-red-600',
                    compliance: 'bg-amber-50 text-amber-600',
                    domain: 'bg-purple-50 text-purple-600',
                    performance: 'bg-blue-50 text-blue-600',
                    custom: 'bg-slate-100 text-slate-600',
                  }
                  const catCls = catColors[ev.category] || 'bg-slate-100 text-slate-600'
                  return (
                    <div key={ev.id} className={clsx(
                      'bg-white rounded-xl border flex flex-col',
                      alreadyRun ? 'border-green-200' : 'border-slate-100'
                    )}>
                      {/* Card header */}
                      <div className="p-4 flex flex-col gap-2 flex-1">
                        <div className="flex items-start justify-between">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-slate-800 truncate">{ev.name}</p>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <span className={clsx('text-[10px] px-1.5 py-0.5 rounded font-medium', catCls)}>{ev.category}</span>
                              {ev.isBuiltin && <span className="text-[10px] text-slate-400">built-in</span>}
                              {!ev.isBuiltin && <span className="text-[10px] text-emerald-500">custom</span>}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {alreadyRun && (
                              <span className={clsx('text-[10px] px-2 py-0.5 rounded-full font-semibold',
                                alreadyRun.verdict === 'pass' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700')}>
                                {alreadyRun.verdict || 'ran'}
                              </span>
                            )}
                            {/* Edit button — pencil icon */}
                            <button
                              onClick={() => {
                                if (isEditing) { setEditingEvaluatorId(null); setEditEvalForm(null) }
                                else { handleStartEditEvaluator(ev) }
                              }}
                              className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                              title={isEditing ? 'Cancel edit' : 'Edit evaluator'}
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                {isEditing
                                  ? <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                  : <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l-4 1 1-4 9.293-9.293a1 1 0 011.414 0l2.586 2.586a1 1 0 010 1.414L9 13z" />
                                }
                              </svg>
                            </button>
                          </div>
                        </div>
                        {ev.description && !isEditing && (
                          <p className="text-xs text-slate-500 leading-relaxed line-clamp-2">{ev.description}</p>
                        )}
                        {alreadyRun && alreadyRun.score != null && !isEditing && (
                          <div className="flex items-center gap-2">
                            <div className="flex-1 bg-slate-100 rounded-full h-1">
                              <div className={clsx('h-1 rounded-full', alreadyRun.score >= 0.8 ? 'bg-green-500' : alreadyRun.score >= 0.6 ? 'bg-amber-500' : 'bg-red-500')}
                                style={{ width: `${Math.round(alreadyRun.score * 100)}%` }} />
                            </div>
                            <span className="text-xs font-semibold text-slate-600">{Math.round(alreadyRun.score * 100)}%</span>
                          </div>
                        )}
                      </div>

                      {/* Edit form — inline */}
                      {isEditing && editEvalForm && (
                        <div className="border-t border-indigo-100 bg-indigo-50 px-4 py-3 space-y-2">
                          {!ev.isBuiltin && (
                            <div>
                              <label className="text-[10px] text-slate-500 block mb-0.5">Name</label>
                              <input className="w-full border border-slate-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white"
                                value={editEvalForm.name}
                                onChange={e => setEditEvalForm(f => f ? {...f, name: e.target.value} : f)} />
                            </div>
                          )}
                          <div>
                            <label className="text-[10px] text-slate-500 block mb-0.5">Description</label>
                            <textarea className="w-full border border-slate-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white resize-none"
                              rows={2} value={editEvalForm.description}
                              onChange={e => setEditEvalForm(f => f ? {...f, description: e.target.value} : f)} />
                          </div>
                          {!ev.isBuiltin && (
                            <div>
                              <label className="text-[10px] text-slate-500 block mb-0.5">Category</label>
                              <select className="w-full border border-slate-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white"
                                value={editEvalForm.category}
                                onChange={e => setEditEvalForm(f => f ? {...f, category: e.target.value} : f)}>
                                {['quality','safety','compliance','domain','performance','custom'].map(c => (
                                  <option key={c} value={c}>{c}</option>
                                ))}
                              </select>
                            </div>
                          )}
                          <div>
                            <label className="text-[10px] text-slate-500 block mb-0.5">Prompt Template</label>
                            <textarea className="w-full border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white resize-y"
                              rows={4} value={editEvalForm.promptTemplate}
                              onChange={e => setEditEvalForm(f => f ? {...f, promptTemplate: e.target.value} : f)} />
                          </div>
                          <div>
                            <label className="text-[10px] text-slate-500 block mb-0.5">Langfuse Score Name</label>
                            <input className="w-full border border-slate-200 rounded-lg px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white"
                              value={editEvalForm.langfuseScoreName}
                              onChange={e => setEditEvalForm(f => f ? {...f, langfuseScoreName: e.target.value} : f)} />
                          </div>
                          <div className="flex gap-2 pt-1">
                            <button onClick={handleSaveEditEvaluator} disabled={savingEditEval}
                              className="text-[10px] bg-indigo-600 text-white px-3 py-1.5 rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1 transition-colors">
                              {savingEditEval ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : null}
                              Save changes
                            </button>
                            <button onClick={() => { setEditingEvaluatorId(null); setEditEvalForm(null) }}
                              className="text-[10px] text-slate-500 px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors">
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Run button */}
                      {!isEditing && (
                        <div className="px-4 pb-4">
                          <button
                            onClick={() => handleTriggerEvaluator(ev.id)}
                            disabled={isTriggering}
                            className={clsx(
                              'w-full text-xs px-3 py-1.5 rounded-lg font-medium transition-colors flex items-center justify-center gap-1',
                              alreadyRun
                                ? 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                                : 'bg-indigo-600 text-white hover:bg-indigo-700'
                            )}
                          >
                            {isTriggering
                              ? <><Loader2 className="w-3 h-3 animate-spin" /> Running...</>
                              : alreadyRun ? 'Re-run (replaces previous result)' : 'Run Evaluator'}
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Audit Log ── */}
      {activeTab === 'audit' && (() => {
        // Classify and filter events
        const classified = auditEvents.map(ev => ({ ev, category: classifyAuditEvent(ev) }))
        const filtered = auditCategoryFilter === 'all' ? classified : classified.filter(c => c.category === auditCategoryFilter)

        // Category counts
        const counts: Partial<Record<AuditCategory | 'all', number>> = { all: auditEvents.length }
        for (const { category } of classified) counts[category] = (counts[category] || 0) + 1

        const exportCsv = () => {
          const headers = ['eventId','timestamp','actorType','actorId','action','resourceType','resourceId','category','rowHash','ipAddress']
          const rows = classified.map(({ ev, category }) =>
            headers.map(h => {
              const v = h === 'category' ? category : (ev as any)[h]
              return `"${String(v ?? '').replace(/"/g, '""')}"`
            }).join(',')
          )
          const blob = new Blob([[headers.join(','), ...rows].join('\n')], { type: 'text/csv' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a'); a.href = url; a.download = `audit-log-${runId}.csv`; a.click()
          URL.revokeObjectURL(url)
        }

        const exportJson = () => {
          const payload = {
            export_type: 'audit_log',
            run_id: runId,
            exported_at: new Date().toISOString(),
            total_events: auditEvents.length,
            events: classified.map(({ ev, category }) => ({
              ...ev,
              category,
              metadata: ev.metadata && typeof ev.metadata === 'string' ? JSON.parse(ev.metadata) : ev.metadata,
              before_state: ev.beforeState && typeof ev.beforeState === 'string' ? JSON.parse(ev.beforeState) : ev.beforeState,
              after_state: ev.afterState && typeof ev.afterState === 'string' ? JSON.parse(ev.afterState) : ev.afterState,
            })),
          }
          const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a'); a.href = url; a.download = `audit-log-${runId}.json`; a.click()
          URL.revokeObjectURL(url)
        }

        const exportTextReport = () => {
          const lines: string[] = [
            `AUDIT LOG — RUN ${runId}`,
            `Exported: ${new Date().toLocaleString()}`,
            `Total Events: ${auditEvents.length}`,
            '='.repeat(80),
            '',
          ]
          classified.forEach(({ ev, category }, i) => {
            const meta = ev.metadata && typeof ev.metadata === 'object' ? ev.metadata
              : (typeof ev.metadata === 'string' ? (() => { try { return JSON.parse(ev.metadata) } catch { return {} } })() : {})
            const before = ev.beforeState && typeof ev.beforeState === 'string' ? (() => { try { return JSON.parse(ev.beforeState) } catch { return ev.beforeState } })() : ev.beforeState
            const after = ev.afterState && typeof ev.afterState === 'string' ? (() => { try { return JSON.parse(ev.afterState) } catch { return ev.afterState } })() : ev.afterState

            lines.push(`[${String(i + 1).padStart(3, '0')}] ${ev.action}`)
            lines.push(`  Category:      ${category}`)
            lines.push(`  Timestamp:     ${new Date(ev.timestamp).toLocaleString()}`)
            lines.push(`  Actor:         ${ev.actorType} / ${ev.actorId}`)
            lines.push(`  Resource:      ${ev.resourceType} / ${ev.resourceId || '—'}`)
            if (ev.ipAddress) lines.push(`  IP Address:    ${ev.ipAddress}`)
            if (before) lines.push(`  Before State:  ${JSON.stringify(before)}`)
            if (after)  lines.push(`  After State:   ${JSON.stringify(after)}`)
            // Provenance fields
            if (meta.model)              lines.push(`  Model:         ${meta.model}`)
            if (meta.agent_version)      lines.push(`  Agent Version: ${meta.agent_version}`)
            if (meta.retrieval_recipe)   lines.push(`  Recipe:        ${meta.retrieval_recipe}`)
            if (meta.policy_applied)     lines.push(`  Policy:        ${meta.policy_applied}`)
            if (meta.regulatory_basis)   lines.push(`  Regulatory:    ${meta.regulatory_basis}`)
            if (meta.phi_detected != null) lines.push(`  PHI Detected:  ${meta.phi_detected}`)
            if (meta.masking_applied != null) lines.push(`  Masking:       ${meta.masking_applied}`)
            if (meta.validation_passed != null) lines.push(`  Validated:     ${meta.validation_passed}`)
            if (meta.corrections_applied != null) lines.push(`  Corrections:   ${meta.corrections_applied} human overrides`)
            if (meta.dataset_version)   lines.push(`  Dataset Ver:   ${meta.dataset_version}`)
            if (meta.checksum || meta.dataset_checksum) lines.push(`  Checksum:      ${meta.checksum || meta.dataset_checksum}`)
            lines.push(`  Row Hash:      ${ev.rowHash || '—'}`)
            lines.push(`  Prev Hash:     ${ev.prevHash || '—'}`)
            lines.push(`  Event ID:      ${ev.eventId}`)
            lines.push('')
          })
          lines.push('='.repeat(80))
          lines.push('END OF AUDIT LOG')
          const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a'); a.href = url; a.download = `audit-log-${runId}.txt`; a.click()
          URL.revokeObjectURL(url)
        }

        return (
          <div className="space-y-4">
            {/* Header */}
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <Shield className="w-4 h-4 text-indigo-600" />
                    <span className="text-sm font-semibold text-slate-800">Tamper-Evident Compliance Record</span>
                    <span className={clsx('text-[10px] font-semibold px-2 py-0.5 rounded-full',
                      auditEvents.length > 0 ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500')}>
                      {auditEvents.length} events · SHA-256 hash-chained
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 leading-relaxed">
                    Every governed action across the AI lifecycle — data intake, parsing, indexing, retrieval,
                    reasoning, human feedback, corrections, approvals, overrides, and exports — recorded
                    immutably with full provenance for regulatory inspection.
                  </p>
                </div>
                {auditEvents.length > 0 && (
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button onClick={exportCsv}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium rounded-lg transition-colors">
                      <Download className="w-3.5 h-3.5" /> CSV
                    </button>
                    <button onClick={exportJson}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium rounded-lg transition-colors">
                      <Download className="w-3.5 h-3.5" /> JSON
                    </button>
                    <button onClick={exportTextReport}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-medium rounded-lg transition-colors">
                      <Download className="w-3.5 h-3.5" /> Text Report
                    </button>
                  </div>
                )}
              </div>

              {/* Compliance coverage — only show when events exist */}
              {auditEvents.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px] text-slate-500">
                  {[
                    '✓ Dataset version provenance',
                    '✓ User authorization',
                    '✓ Model / prompt / recipe used',
                    '✓ Masking rules applied',
                    '✓ Raw vs. curated context',
                    '✓ Corrections & overrides',
                    '✓ Before/after state diffs',
                    '✓ Policy enforcement record',
                  ].map(q => (
                    <div key={q} className="bg-slate-50 rounded px-2 py-1 text-green-700 font-medium">{q}</div>
                  ))}
                </div>
              )}
            </div>

            {/* Category filter tabs */}
            {auditEvents.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => setAuditCategoryFilter('all')}
                  className={clsx('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border',
                    auditCategoryFilter === 'all'
                      ? 'bg-slate-800 text-white border-slate-800'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300')}>
                  <Filter className="w-3 h-3" /> All <span className="opacity-60">({counts.all})</span>
                </button>
                {(Object.keys(AUDIT_CATEGORY_META) as AuditCategory[]).map(cat => {
                  const cm = AUDIT_CATEGORY_META[cat]
                  const Icon = cm.icon
                  const c = counts[cat] || 0
                  if (c === 0) return null
                  return (
                    <button
                      key={cat}
                      onClick={() => setAuditCategoryFilter(cat)}
                      className={clsx('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border',
                        auditCategoryFilter === cat
                          ? `${cm.badge} border-transparent`
                          : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300')}>
                      <Icon className="w-3 h-3" /> {cm.label} <span className="opacity-60">({c})</span>
                    </button>
                  )
                })}
              </div>
            )}

            {/* Event list */}
            {filtered.length === 0 ? (
              <div className="text-center py-10 text-slate-400 text-sm">
                <Shield className="w-8 h-8 mx-auto mb-2 text-slate-200" />
                {auditEvents.length === 0 ? 'No audit events recorded for this run yet.' : 'No events in this category.'}
              </div>
            ) : (
              <div className="space-y-1.5">
                {filtered.map(({ ev, category }, i) => {
                  const evKey = ev.eventId || String(i)
                  const isOpen = expandedTrace === ('audit_' + evKey)
                  const cm = AUDIT_CATEGORY_META[category]
                  const Icon = cm.icon
                  const meta = ev.metadata && typeof ev.metadata === 'object' ? ev.metadata
                    : (typeof ev.metadata === 'string' ? (() => { try { return JSON.parse(ev.metadata) } catch { return {} } })() : {})
                  const hasStateChange = ev.beforeState || ev.afterState
                  const hasMistake = mf(meta,'hallucination_detected','mistake_type')
                  const hasOverride = category === 'human_oversight' && /override/i.test(ev.action)
                  return (
                    <div key={evKey} className={`rounded-xl border border-slate-200 overflow-hidden bg-white border-l-4 ${cm.border}`}>
                      <button
                        onClick={() => setExpandedTrace(isOpen ? null : 'audit_' + evKey)}
                        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors text-left">
                        {/* Category icon */}
                        <span className={`flex-shrink-0 p-1.5 rounded-lg ${cm.badge}`}>
                          <Icon className="w-3.5 h-3.5" />
                        </span>
                        {/* Actor badge */}
                        <span className={clsx('flex-shrink-0 text-[10px] font-semibold px-2 py-1 rounded',
                          ev.actorType === 'agent'  ? 'bg-purple-50 text-purple-700' :
                          ev.actorType === 'user'   ? 'bg-blue-50 text-blue-700'   : 'bg-slate-100 text-slate-600')}>
                          {ev.actorType}
                        </span>
                        {/* Timestamp */}
                        <span className="text-xs text-slate-400 font-mono whitespace-nowrap flex-shrink-0">
                          {new Date(ev.timestamp).toISOString().replace('T', ' ').slice(0, 19)}Z
                        </span>
                        {/* Action */}
                        <span className="text-sm font-semibold text-slate-800 flex-1 min-w-0 truncate">{ev.action}</span>
                        {/* Resource */}
                        <span className="text-xs text-slate-400 hidden sm:flex items-center gap-1 flex-shrink-0">
                          {ev.resourceType}
                          {ev.resourceId && <span className="font-mono">{String(ev.resourceId).slice(0, 8)}…</span>}
                        </span>
                        {/* Flags */}
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {hasStateChange && <span title="Has state change"><GitCompare className="w-3.5 h-3.5 text-amber-500" /></span>}
                          {hasMistake && <span title="Validation flag"><AlertTriangle className="w-3.5 h-3.5 text-red-500" /></span>}
                          {hasOverride && <span title="Human override"><UserCheck className="w-3.5 h-3.5 text-teal-500" /></span>}
                        </div>
                        {isOpen ? <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />}
                      </button>
                      {isOpen && <AuditEventDetail ev={ev} category={category} />}
                    </div>
                  )
                })}
              </div>
            )}

            {/* Chain integrity footer */}
            <div className="flex items-center gap-2 text-xs text-slate-400 bg-slate-50 rounded-lg px-3 py-2">
              <Link2 className="w-3.5 h-3.5 flex-shrink-0 text-green-500" />
              <span>
                All <strong className="text-slate-600">{auditEvents.length} events</strong> are SHA-256 hash-chained (21 CFR Part 11 / ICH E6 R3 compliant).
                Each row hash covers all fields + previous record hash — any tampering breaks the chain.
              </span>
            </div>
          </div>
        )
      })()}

      {/* ── Reasoning Graph (Neo4j) ── */}
      {activeTab === 'graph' && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden" style={{ height: 600 }}>
          <AgentReasoningGraph runId={runId} orgId={orgId} />
        </div>
      )}

      {/* ── Validation ── */}
      {activeTab === 'validation' && (
        <ValidationRunTab traces={traces} />
      )}

      {/* ── Learnings ── */}
      {activeTab === 'learnings' && (
        <LearningsRunTab traces={traces} />
      )}
    </div>
  )
}
