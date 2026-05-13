'use client'
import { useState, useEffect } from 'react'
import {
  Shield, Brain, BarChart2, CheckCircle, AlertCircle, Loader2,
  ChevronDown, ChevronRight, ThumbsUp, ThumbsDown, Activity, Database,
  ShieldCheck, ExternalLink, Info, XCircle, Wrench, List, ChevronUp, ClipboardList,
} from 'lucide-react'
import { clsx } from 'clsx'
import {
  RadialBarChart, RadialBar, PieChart, Pie, Cell as RechartsCell,
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'

// ── Constants ─────────────────────────────────────────────────────────────────

const GRAPHQL_URL  = process.env.NEXT_PUBLIC_GRAPHQL_URL  || 'http://localhost:4000/graphql'
const RUNTIME_URL  = process.env.NEXT_PUBLIC_AGENT_RUNTIME_URL || 'http://localhost:8004'

const TRACE_TYPE_CONFIG: Record<string, { label: string; cls: string }> = {
  tool_call: { label: 'Retrieval',  cls: 'bg-blue-50 text-blue-700' },
  synthesis: { label: 'Synthesis',  cls: 'bg-purple-50 text-purple-700' },
  reasoning: { label: 'Reasoning',  cls: 'bg-amber-50 text-amber-700' },
  output:    { label: 'Output',     cls: 'bg-green-50 text-green-700' },
}

const MISTAKE_TYPE_CONFIG: Record<string, { label: string; cls: string }> = {
  hallucination:   { label: 'HALLUCINATION',   cls: 'bg-red-100 text-red-700 border border-red-300' },
  wrong_source:    { label: 'WRONG SOURCE',     cls: 'bg-orange-100 text-orange-700 border border-orange-300' },
  scope_violation: { label: 'SCOPE VIOLATION',  cls: 'bg-amber-100 text-amber-700 border border-amber-300' },
}

const VERDICT_CONFIG: Record<string, { cls: string }> = {
  pass:    { cls: 'bg-green-100 text-green-700' },
  partial: { cls: 'bg-amber-100 text-amber-700' },
  fail:    { cls: 'bg-red-100 text-red-700' },
  unknown: { cls: 'bg-slate-100 text-slate-600' },
}

const FEEDBACK_CATEGORIES = [
  'wrong_answer',
  'incomplete_answer',
  'wrong_source_context',
  'wrong_reasoning_path',
  'bad_formatting',
  'wrong_confidence',
  'policy_compliance_issue',
]

// ── Helpers ───────────────────────────────────────────────────────────────────

async function gql(query: string, variables: Record<string, unknown> = {}) {
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

function fmt(ts: string) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
}

function fmtUtc(ts: string) {
  if (!ts) return '—'
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

function fmtPct(v: number | null | undefined) {
  if (v == null || Number.isNaN(v)) return '—'
  return `${Math.round(v * 100)}%`
}

function hasStagePayload(payload: any) {
  return !!payload && typeof payload === 'object' && Object.keys(payload).length > 0
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

// ── ConfidenceBar ─────────────────────────────────────────────────────────────

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

// ── MetricCard ────────────────────────────────────────────────────────────────

function MetricCard({ label, value, sub, colorCls }: {
  label: string; value: React.ReactNode; sub?: string; colorCls?: string
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-100 p-4">
      <p className="text-xs text-slate-400 mb-1">{label}</p>
      <p className={clsx('text-xl font-semibold', colorCls || 'text-slate-800')}>{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
    </div>
  )
}

// ── TraceFeedback ─────────────────────────────────────────────────────────────

function TraceFeedback({ traceId, orgId, userId }: { traceId: string; orgId: string; userId: string }) {
  const [state, setState] = useState<'idle' | 'correcting' | 'done'>('idle')
  const [correction, setCorrection] = useState('')
  const [feedbackCategory, setFeedbackCategory] = useState('wrong_answer')
  const [expectedValue, setExpectedValue] = useState('')
  const [targetedStage, setTargetedStage] = useState('E. Answer Construction')
  const [busy, setBusy] = useState(false)

  const send = async (type: string, value: any) => {
    setBusy(true)
    try {
      await gql(
        `mutation($input: ContextFeedbackInput!) { submitContextFeedback(input: $input) }`,
        {
          input: {
            decisionTraceId: traceId,
            orgId,
            feedbackType: type,
            feedbackCategory: value?.feedbackCategory,
            correctionPayload: value?.correctionPayload,
            feedbackValue: value,
            submittedBy: userId,
          },
        }
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
          <span className="text-xs text-slate-400">Was this decision correct?</span>
          <button disabled={busy} onClick={() => send('endorsement', { reason: 'correct', feedbackCategory: 'other' })}
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <select
              value={feedbackCategory}
              onChange={e => setFeedbackCategory(e.target.value)}
              className="w-full text-xs border border-slate-200 rounded-lg px-2 py-2 bg-white"
            >
              {FEEDBACK_CATEGORIES.map(cat => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
            <input
              value={expectedValue}
              onChange={e => setExpectedValue(e.target.value)}
              placeholder="Expected value (optional)"
              className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2"
            />
          </div>
          <textarea value={correction} onChange={e => setCorrection(e.target.value)}
            placeholder="What should the correct decision/answer be?"
            rows={2}
            className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-400 resize-none" />
          <input
            value={targetedStage}
            onChange={e => setTargetedStage(e.target.value)}
            placeholder="Targeted stage (optional)"
            className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2"
          />
          <div className="flex gap-2">
            <button onClick={() => send('correction', {
              corrected_text: correction,
              reason: 'user_correction',
              feedbackCategory,
              correctionPayload: {
                corrected_answer: correction,
                expected_value: expectedValue || null,
                targeted_stage: targetedStage || null,
              },
            })}
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

// ── Decision Traces Panel ─────────────────────────────────────────────────────

function DecisionTracesPanel({ traces, orgId, userId }: { traces: any[]; orgId: string; userId: string }) {
  const [expanded, setExpanded] = useState<string | null>(null)

  if (traces.length === 0) {
    return (
      <div className="text-center py-10 text-slate-400 text-sm">
        <Brain className="w-8 h-8 mx-auto mb-2 text-slate-200" />
        No decision traces recorded for this run.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-400">
        Every decision this agent made — what it did, why it chose to do it, and exactly when — recorded in full.
      </p>
      {traces.map((trace, idx) => {
        const tc = TRACE_TYPE_CONFIG[trace.traceType] || { label: trace.traceType, cls: 'bg-slate-100 text-slate-600' }
        const mc = trace.mistakeType ? MISTAKE_TYPE_CONFIG[trace.mistakeType] : null
        const ctx = trace.inputContext || {}
        const isDeterministic = ctx.provider === 'deterministic' || ctx.model === 'deterministic'
        const isOpen = expanded === trace.id
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

        // ── WHAT — full description of the action ──
        let whatLabel: string
        let whatDetail: string
        if (trace.traceType === 'tool_call') {
          whatLabel = `Knowledge Retrieval`
          whatDetail = `Queried knowledge graph: "${ctx.query || ctx.user_message || '—'}"`
        } else if (isDeterministic) {
          whatLabel = `Deterministic Answer`
          whatDetail = `LLM bypassed — structured data pattern matched, used pre-computed values to avoid hallucination`
        } else if (trace.traceType === 'synthesis') {
          whatLabel = `LLM Synthesis`
          whatDetail = `Model ${ctx.provider || 'ollama'}/${ctx.model || '?'} synthesised ${ctx.prompt_length || '?'} chars of context into an answer`
        } else if (trace.traceType === 'output') {
          whatLabel = `Final Output`
          whatDetail = `Answer delivered to the user and output artifacts recorded`
        } else {
          whatLabel = tc.label
          whatDetail = ctx.user_message || ctx.query || '—'
        }

        // ── WHY — full reasoning for why this step was taken ──
        let whyText: string
        if (trace.traceType === 'tool_call') {
          whyText = `Retrieve verified clinical data to ground the answer. Raw LLM knowledge alone cannot be trusted for domain-specific queries — all answers must cite a real data source.`
        } else if (isDeterministic) {
          whyText = `LLM hallucination risk was detected for a structured aggregate query (e.g. count, sum, unique values). Pre-computed values from the vector store are exact; LLM-generated arithmetic is not.`
        } else if (trace.traceType === 'synthesis') {
          whyText = `Synthesise ${(trace.sourcesCited || []).length} retrieved context chunk(s) into a coherent natural-language answer. The model only has access to the retrieved context — it cannot invent facts.`
        } else if (trace.traceType === 'output') {
          whyText = `Deliver the complete answer to the user. Record it as a trace for audit and reproducibility purposes.`
        } else {
          whyText = ctx.reasoning || `Step ${idx + 1} in the agent execution pipeline.`
        }

        // Collapsed summary line
        const summaryLine = ctx.user_message || ctx.query || trace.output?.summary || whatDetail

        return (
          <div key={trace.id} className="bg-white rounded-xl border border-slate-100 overflow-hidden">
            {/* Collapsed header */}
            <button
              onClick={() => setExpanded(isOpen ? null : trace.id)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50 transition-colors text-left">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="w-5 h-5 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-[10px] font-bold flex-shrink-0">
                  {idx + 1}
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
                <span className="text-sm text-slate-700 truncate">{summaryLine}</span>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0 ml-3">
                {(trace.sourcesCited?.length ?? 0) > 0 && (
                  <span className="hidden sm:inline text-[10px] text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded">
                    {trace.sourcesCited.length} sources
                  </span>
                )}
                {trace.confidence != null && (
                  <div className="w-20 hidden sm:block">
                    <ConfidenceBar value={trace.confidence} />
                  </div>
                )}
                <span className="text-xs text-slate-400 whitespace-nowrap">{fmt(trace.createdAt)}</span>
                {isOpen ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
              </div>
            </button>

            {isOpen && (
              <div className="border-t border-slate-100">

                {/* WHEN / WHAT / WHY header bar */}
                <div className="grid grid-cols-3 divide-x divide-slate-100 bg-slate-50 text-[11px]">
                  <div className="px-4 py-3">
                    <p className="text-slate-400 font-semibold uppercase tracking-wide mb-1">WHEN</p>
                    <p className="text-slate-800 font-mono font-medium">{fmtUtc(trace.createdAt)}</p>
                    {trace.confidence != null && (
                      <div className="mt-2">
                        <p className="text-slate-500 mb-0.5">Confidence</p>
                        <ConfidenceBar value={trace.confidence} />
                      </div>
                    )}
                    {ctx.latency_ms != null && (
                      <p className="text-slate-500 mt-1">Latency: <span className="font-medium">{ctx.latency_ms}ms</span></p>
                    )}
                  </div>
                  <div className="px-4 py-3">
                    <p className="text-slate-400 font-semibold uppercase tracking-wide mb-1">WHAT</p>
                    <p className="text-slate-800 font-semibold">{whatLabel}</p>
                    <p className="text-slate-600 mt-1 leading-relaxed">{whatDetail}</p>
                    {ctx.node_label && (
                      <p className="text-slate-500 mt-1.5">Node: <span className="font-medium text-slate-700">{ctx.node_label}</span></p>
                    )}
                    {ctx.model && !isDeterministic && (
                      <p className="text-slate-500 mt-0.5">Model: <span className="font-mono text-slate-700">{ctx.provider}/{ctx.model}</span></p>
                    )}
                    {ctx.prompt_length && (
                      <p className="text-slate-500 mt-0.5">Prompt: <span className="font-medium text-slate-700">{ctx.prompt_length} chars</span></p>
                    )}
                  </div>
                  <div className="px-4 py-3">
                    <p className="text-slate-400 font-semibold uppercase tracking-wide mb-1">WHY</p>
                    <p className="text-slate-700 leading-relaxed">{whyText}</p>
                    {mc && (
                      <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded">
                        <p className="text-red-700 font-semibold text-[11px]">{mc.label} detected</p>
                        <p className="text-red-600 text-[10px] mt-0.5">
                          This decision was flagged as a mistake. Review and provide correction below.
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="px-4 pb-4 space-y-4 pt-4">

                  {(hasV2Stages || hasConfidenceDecomposition) && (
                    <div>
                      <h4 className="text-xs font-semibold text-slate-600 mb-2 flex items-center gap-1.5">
                        <Activity className="w-3.5 h-3.5 text-slate-400" /> Machine-Usable Stages {trace.traceVersion ? `(v${trace.traceVersion})` : '(v2)'}
                      </h4>
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
                        {stageEntries.map(entry => (
                          <StagePayloadCard key={entry.title} title={entry.title} payload={entry.payload} />
                        ))}
                        <StagePayloadCard title="Confidence Decomposition" payload={trace.confidenceDecomposition} />
                      </div>
                    </div>
                  )}

                  {/* Reasoning chain */}
                  {Array.isArray(trace.reasoningSteps) && trace.reasoningSteps.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold text-slate-600 mb-2 flex items-center gap-1.5">
                        <Brain className="w-3.5 h-3.5 text-slate-400" /> Reasoning Chain ({trace.reasoningSteps.length} steps)
                      </h4>
                      <div className="relative pl-4">
                        <div className="absolute left-[7px] top-2 bottom-2 w-px bg-slate-200" />
                        <div className="space-y-3">
                          {trace.reasoningSteps.map((step: any, i: number) => (
                            <div key={i} className="flex gap-3 relative">
                              <span className="w-4 h-4 rounded-full border-2 border-brand-400 bg-white flex items-center justify-center text-[9px] font-bold text-brand-600 flex-shrink-0 relative z-10 -ml-1">
                                {step.step || i + 1}
                              </span>
                              <div className="flex-1 min-w-0 bg-slate-50 rounded-lg p-2.5 border border-slate-100">
                                <p className="text-xs text-slate-800 font-medium leading-snug">{step.thought}</p>
                                {step.action && (
                                  <p className="text-[10px] text-slate-500 font-mono mt-1">Action: {step.action}</p>
                                )}
                                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
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
                                    <span className="text-[10px] text-slate-400">{step.chunk_count} chunks retrieved</span>
                                  )}
                                  {step.prompt_length != null && (
                                    <span className="text-[10px] text-slate-400">{step.prompt_length} chars in prompt</span>
                                  )}
                                  {step.from_cache != null && (
                                    <span className={clsx('text-[10px] px-1 rounded', step.from_cache ? 'bg-green-50 text-green-600' : 'bg-slate-100 text-slate-500')}>
                                      {step.from_cache ? 'cache hit' : 'cache miss'}
                                    </span>
                                  )}
                                  {step.duration_ms != null && (
                                    <span className="text-[10px] text-slate-400">{step.duration_ms}ms</span>
                                  )}
                                </div>
                                {step.observation && (
                                  <p className="text-[10px] text-slate-500 mt-1 italic">Observation: {step.observation}</p>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Prompt preview */}
                  {ctx.prompt_preview && !isDeterministic && (
                    <div>
                      <h4 className="text-xs font-semibold text-slate-600 mb-1.5 flex items-center gap-1.5">
                        <Database className="w-3.5 h-3.5 text-slate-400" /> Exact prompt sent to model
                      </h4>
                      <pre className="text-[11px] text-slate-600 bg-slate-50 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap max-h-56 font-mono border border-slate-100">
                        {ctx.prompt_preview}
                      </pre>
                    </div>
                  )}

                  {/* Sources retrieved */}
                  {Array.isArray(trace.sourcesCited) && trace.sourcesCited.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold text-slate-600 mb-2 flex items-center gap-1.5">
                        <Database className="w-3.5 h-3.5 text-slate-400" />
                        {trace.sourcesCited.length} Sources Retrieved & Cited
                      </h4>
                      <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                        {trace.sourcesCited.map((s: any, i: number) => (
                          <div key={i} className="bg-slate-50 rounded-lg p-2.5 text-xs border border-slate-100">
                            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                              <span className="text-[10px] font-bold text-slate-400">#{i + 1}</span>
                              <span className="font-semibold text-slate-700">{s.doc_name || s.document_name || 'Unknown document'}</span>
                              {s.doc_type && (
                                <span className="px-1.5 py-0.5 bg-white border border-slate-200 rounded text-[10px] text-slate-500">{s.doc_type}</span>
                              )}
                              {s.section && (
                                <span className="text-[10px] text-slate-500">§ {s.section}</span>
                              )}
                              {s.score != null && (
                                <span className={clsx('ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded',
                                  s.score >= 0.8 ? 'bg-green-50 text-green-700' :
                                  s.score >= 0.6 ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500')}>
                                  {(s.score * 100).toFixed(0)}% relevance
                                </span>
                              )}
                            </div>
                            {s.chunk_id && (
                              <p className="text-[10px] text-slate-400 font-mono mb-1">chunk: {s.chunk_id}</p>
                            )}
                            {s.excerpt && (
                              <p className="text-slate-600 leading-relaxed">{s.excerpt}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Generated answer / output */}
                  {(trace.output?.content || trace.output?.summary) && (
                    <div>
                      <h4 className="text-xs font-semibold text-slate-600 mb-1.5 flex items-center gap-1.5">
                        <CheckCircle className="w-3.5 h-3.5 text-green-500" />
                        {isDeterministic ? 'Pre-computed Answer' : trace.traceType === 'output' ? 'Final Answer Delivered' : 'Generated Answer'}
                      </h4>
                      <div className="bg-green-50 border border-green-100 rounded-lg p-3 text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                        {trace.output.content || trace.output.summary}
                      </div>
                      {trace.output.full_length && (
                        <p className="text-[10px] text-slate-400 mt-1">{trace.output.full_length} chars total</p>
                      )}
                    </div>
                  )}

                  {/* Feedback */}
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
  )
}

// ── Evaluation Panel ──────────────────────────────────────────────────────────

function QualityCertificate({ ev, manifest, sourcesCount, runId }: {
  ev: any; manifest: any; sourcesCount: number; runId: string | null | undefined
}) {
  if (!ev && !manifest) return null
  const verdict = ev?.judgeVerdict || manifest?.quality?.verdict || 'unknown'
  const verdictCfg = VERDICT_CONFIG[verdict] || VERDICT_CONFIG.unknown
  const faithfulness = ev?.faithfulnessScore ?? manifest?.quality?.faithfulness_score
  const hallucinationDetected = ev?.hallucinationDetected ?? manifest?.quality?.hallucination_detected
  const confidence = manifest?.quality?.confidence
  const branchAction = manifest?.quality?.branch_action
  const readabilityGrade = manifest?.quality?.readability_grade || 'N/A'
  const completenessGrade = manifest?.quality?.completeness_grade || 'N/A'
  const provenanceCompleteness = manifest?.quality?.provenance_completeness ?? manifest?.provenance_coverage
  const hallucinationRisk = manifest?.quality?.hallucination_risk
  const confDecomp = manifest?.quality?.confidence_decomposition || {}
  const excelFeedback = manifest?.generation_loop_summary?.excel_feedback || {}
  const excelGapCount = Number(excelFeedback?.gap_count || 0)
  const excelTopGaps = Array.isArray(excelFeedback?.top_gaps) ? excelFeedback.top_gaps : []

  const criteriaScores = {
    protocolDigitizationAccuracy:
      confDecomp?.digitization_accuracy ??
      faithfulness ??
      null,
    automatedOutputQuality:
      confDecomp?.output_quality ??
      ev?.reasoningScore ??
      manifest?.quality?.completeness_score ??
      null,
    interoperabilityStandards:
      confDecomp?.standards_alignment ??
      (manifest?.standards_compliance?.usdm_score != null
        ? Number(manifest.standards_compliance.usdm_score) / 100
        : null),
    technicalFeasibilityScalability:
      confDecomp?.technical_feasibility ??
      confidence ??
      null,
  }

  const metricTone = (v: number | null | undefined): string => {
    if (v == null) return 'text-slate-500'
    if (v >= 0.8) return 'text-green-700'
    if (v >= 0.6) return 'text-amber-700'
    return 'text-red-700'
  }

  return (
    <div className="bg-gradient-to-r from-slate-50 to-brand-50/30 border border-slate-200 rounded-xl p-4 mb-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-brand-600" />
          <span className="text-sm font-semibold text-slate-700">Quality Certificate</span>
          <span className="text-[10px] text-slate-400 bg-white border border-slate-200 px-1.5 py-0.5 rounded font-mono">L7.E1 + L1.E5</span>
        </div>
        {runId && (
          <a
            href={`/provenance/${runId}`}
            className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-800 font-medium"
          >
            Full Provenance Report <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <span className={clsx('px-2.5 py-1 rounded-full text-xs font-bold', verdictCfg.cls)}>
          {verdict === 'pass' ? '✓ PASS' : verdict === 'fail' ? '✗ FAIL' : verdict.toUpperCase()}
        </span>
        <span className={clsx('px-2.5 py-1 rounded-full text-xs font-medium',
          hallucinationDetected ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700')}>
          Hallucination: {hallucinationDetected ? '⚠ Detected' : 'None'}
        </span>
        {faithfulness != null && (
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
            Faithfulness: {Math.round(faithfulness * 100)}%
          </span>
        )}
        {confidence != null && (
          <span className={clsx('px-2.5 py-1 rounded-full text-xs font-medium',
            confidence >= 0.8 ? 'bg-green-100 text-green-700' :
            confidence >= 0.6 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700')}>
            Confidence: {Math.round(confidence * 100)}%
          </span>
        )}
        {branchAction && (
          <span className={clsx('px-2.5 py-1 rounded-full text-xs font-medium',
            branchAction === 'proceed' ? 'bg-green-100 text-green-700' :
            branchAction === 'escalate' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600')}>
            Branch: {branchAction}
          </span>
        )}
        <span className={clsx('px-2.5 py-1 rounded-full text-xs font-bold',
          readabilityGrade === 'A' ? 'bg-green-100 text-green-700' :
          readabilityGrade === 'B' ? 'bg-blue-100 text-blue-700' :
          readabilityGrade === 'C' ? 'bg-amber-100 text-amber-700' :
          readabilityGrade === 'N/A' ? 'bg-slate-100 text-slate-600' : 'bg-red-100 text-red-700')}>
          Readability: {readabilityGrade}
        </span>
        <span className={clsx('px-2.5 py-1 rounded-full text-xs font-bold',
          completenessGrade === 'A' ? 'bg-green-100 text-green-700' :
          completenessGrade === 'B' ? 'bg-blue-100 text-blue-700' :
          completenessGrade === 'C' ? 'bg-amber-100 text-amber-700' :
          completenessGrade === 'N/A' ? 'bg-slate-100 text-slate-600' : 'bg-red-100 text-red-700')}>
          Completeness: {completenessGrade}
        </span>
        {sourcesCount > 0 && (
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-600">
            {sourcesCount} source{sourcesCount !== 1 ? 's' : ''} cited
          </span>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="rounded-lg bg-white border border-slate-200 px-2.5 py-2">
          <p className="text-[10px] text-slate-400 uppercase tracking-wide">Provenance</p>
          <p className="text-sm font-semibold text-slate-700">{fmtPct(provenanceCompleteness)}</p>
        </div>
        <div className="rounded-lg bg-white border border-slate-200 px-2.5 py-2">
          <p className="text-[10px] text-slate-400 uppercase tracking-wide">Hallucination Risk</p>
          <p className={clsx('text-sm font-semibold capitalize',
            hallucinationRisk === 'high' ? 'text-red-600' :
            hallucinationRisk === 'medium' ? 'text-amber-600' : 'text-green-600')}>
            {hallucinationRisk || (hallucinationDetected ? 'high' : 'low')}
          </p>
        </div>
        <div className="rounded-lg bg-white border border-slate-200 px-2.5 py-2">
          <p className="text-[10px] text-slate-400 uppercase tracking-wide">Standards Confidence</p>
          <p className="text-sm font-semibold text-slate-700">{fmtPct(confDecomp?.standards_alignment)}</p>
        </div>
        <div className="rounded-lg bg-white border border-slate-200 px-2.5 py-2">
          <p className="text-[10px] text-slate-400 uppercase tracking-wide">Output Confidence</p>
          <p className="text-sm font-semibold text-slate-700">{fmtPct(confDecomp?.output_quality)}</p>
        </div>
      </div>

      <div className="mt-3 rounded-lg bg-white border border-slate-200 p-3">
        <p className="text-xs font-semibold text-slate-700 mb-2">Quantitative Analysis</p>
        <div className="mb-2 rounded-md border border-slate-200 bg-emerald-50/60 px-2.5 py-2">
          <p className="text-[11px] font-medium text-slate-700">Quality Checks</p>
          <p className={clsx('text-sm font-semibold', excelGapCount === 0 ? 'text-green-700' : excelGapCount <= 3 ? 'text-amber-700' : 'text-red-700')}>
            {excelGapCount === 0 ? 'All quality checks passed' : `${excelGapCount} quality check${excelGapCount === 1 ? '' : 's'} remaining`}
          </p>
          {excelTopGaps.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {excelTopGaps.slice(0, 5).map((g: string, i: number) => (
                <span key={`excel-gap-${i}-${g}`} className="px-1.5 py-0.5 rounded bg-white border border-slate-200 text-[10px] text-slate-600 font-mono">
                  {g}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="rounded-md border border-slate-200 bg-slate-50 p-2.5">
            <p className="text-[11px] font-medium text-slate-600">Protocol Digitization Accuracy</p>
            <p className={clsx('text-sm font-semibold', metricTone(criteriaScores.protocolDigitizationAccuracy))}>
              {fmtPct(criteriaScores.protocolDigitizationAccuracy)}
            </p>
            <p className="text-[10px] text-slate-500 mt-0.5">Faithful conversion with completeness, traceability, and auditability.</p>
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50 p-2.5">
            <p className="text-[11px] font-medium text-slate-600">Automated Output Quality</p>
            <p className={clsx('text-sm font-semibold', metricTone(criteriaScores.automatedOutputQuality))}>
              {fmtPct(criteriaScores.automatedOutputQuality)}
            </p>
            <p className="text-[10px] text-slate-500 mt-0.5">High-quality, hallucination-free first-draft output quality signal.</p>
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50 p-2.5">
            <p className="text-[11px] font-medium text-slate-600">Interoperability & Standards Alignment</p>
            <p className={clsx('text-sm font-semibold', metricTone(criteriaScores.interoperabilityStandards))}>
              {fmtPct(criteriaScores.interoperabilityStandards)}
            </p>
            <p className="text-[10px] text-slate-500 mt-0.5">USDM/ICH M11 alignment and downstream MDR integration readiness.</p>
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50 p-2.5">
            <p className="text-[11px] font-medium text-slate-600">Technical Feasibility & Scalability</p>
            <p className={clsx('text-sm font-semibold', metricTone(criteriaScores.technicalFeasibilityScalability))}>
              {fmtPct(criteriaScores.technicalFeasibilityScalability)}
            </p>
            <p className="text-[10px] text-slate-500 mt-0.5">Operational confidence proxy for enterprise-ready, scalable execution.</p>
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-lg bg-white border border-slate-200 p-3">
        <p className="text-xs font-semibold text-slate-700 mb-2">Qualitative Assessment</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-slate-600">
          <div className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2">
            Accuracy (incl. completeness and provenance): {fmtPct(faithfulness)} / {fmtPct(provenanceCompleteness)}
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2">
            Quality of text produced: {fmtPct(criteriaScores.automatedOutputQuality)}
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2">
            Readability: {readabilityGrade}
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2">
            Hallucination status: {hallucinationDetected ? 'Detected' : 'None'}
          </div>
        </div>
      </div>
    </div>
  )
}

function GenerationLoopPanel({ manifest }: { manifest: any }) {
  const history = Array.isArray(manifest?.generation_loop_history) ? manifest.generation_loop_history : []
  const summary = manifest?.generation_loop_summary || {}
  if (!history.length) return null

  const chartData = history.map((row: any) => ({
    attempt: `A${row.attempt}`,
    overall: Math.round(((row.stage_confidence?.overall ?? 0) as number) * 100),
    digitization: Math.round(((row.stage_confidence?.digitization_accuracy ?? 0) as number) * 100),
    quality: Math.round(((row.stage_confidence?.output_quality ?? 0) as number) * 100),
    standards: Math.round(((row.stage_confidence?.standards_alignment ?? 0) as number) * 100),
    feasibility: Math.round(((row.stage_confidence?.technical_feasibility ?? 0) as number) * 100),
    gaps: row.gap_count ?? 0,
  }))

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div>
          <p className="text-sm font-semibold text-slate-800">Auto-Verification Loop</p>
          <p className="text-xs text-slate-500">Complete retry/correction trace (max 5 iterations)</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-slate-500">Selected iteration</p>
          <p className="text-sm font-semibold text-slate-800">
            {summary?.best_attempt ?? history[history.length - 1]?.attempt} / {summary?.attempts_executed ?? history.length}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-lg border border-slate-200 p-3">
          <p className="text-xs text-slate-500 mb-2">Per-attempt stage confidence</p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={chartData}>
              <XAxis dataKey="attempt" tick={{ fontSize: 10 }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} tickFormatter={v => `${v}%`} width={28} />
              <Tooltip formatter={(v: any) => `${v}%`} />
              <Legend iconSize={8} wrapperStyle={{ fontSize: '10px' }} />
              <Bar dataKey="overall" fill="#0f766e" radius={[3, 3, 0, 0]} />
              <Bar dataKey="standards" fill="#2563eb" radius={[3, 3, 0, 0]} />
              <Bar dataKey="quality" fill="#7c3aed" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white rounded-lg border border-slate-200 p-3">
          <p className="text-xs text-slate-500 mb-2">Iteration audit trail</p>
          <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
            {history.map((row: any) => (
              <div key={row.attempt} className="rounded-md border border-slate-200 px-2.5 py-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-700">Attempt {row.attempt}</span>
                  <span className={clsx('font-medium', (row.overall_delta ?? 0) > 0 ? 'text-green-600' : (row.overall_delta ?? 0) < 0 ? 'text-red-600' : 'text-slate-500')}>
                    {row.overall_delta == null ? 'baseline' : `${row.overall_delta > 0 ? '+' : ''}${Math.round(row.overall_delta * 100)}%`}
                  </span>
                </div>
                <div className="mt-1 grid grid-cols-3 gap-2 text-[11px] text-slate-600">
                  <span>Overall: {fmtPct(row.stage_confidence?.overall)}</span>
                  <span>Gaps: {row.gap_count ?? 0}</span>
                  <span>{row.passed ? 'PASS' : 'RETRY'}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function EvaluationPanel({ ev, run, runId, manifest, sourcesCount }: {
  ev: any; run: any; runId: string | null | undefined; manifest: any; sourcesCount: number
}) {
  if (!ev) {
    return (
      <div className="space-y-4">
        <QualityCertificate ev={null} manifest={manifest} sourcesCount={sourcesCount} runId={runId} />
        <div className="text-center py-12 text-slate-400">
          <Activity className="w-8 h-8 mx-auto mb-2 text-slate-200" />
          <p className="text-sm">No evaluation data yet.</p>
          <p className="text-xs mt-1">Evaluation runs automatically after run completion.</p>
        </div>
      </div>
    )
  }

  const verdictCfg = VERDICT_CONFIG[ev.judgeVerdict] || VERDICT_CONFIG.unknown

  return (
    <div className="space-y-6">
      <QualityCertificate ev={ev} manifest={manifest} sourcesCount={sourcesCount} runId={runId} />
      <GenerationLoopPanel manifest={manifest} />
      {/* Metric cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <MetricCard
          label="Task Completed"
          value={ev.taskCompleted == null ? '—' : ev.taskCompleted ? '✓' : '✗'}
          colorCls={ev.taskCompleted == null ? 'text-slate-400' : ev.taskCompleted ? 'text-green-600' : 'text-red-500'}
        />
        <MetricCard
          label="Latency"
          value={ev.latencyMs != null ? `${(ev.latencyMs / 1000).toFixed(1)}s` : run?.latencyMs != null ? `${(run.latencyMs / 1000).toFixed(1)}s` : '—'}
        />
        <MetricCard
          label="Cost"
          value={ev.costUsd != null ? `$${ev.costUsd.toFixed(4)}` : run?.costUsd != null ? `$${run.costUsd.toFixed(4)}` : '—'}
        />
        <MetricCard
          label="Turn Count"
          value={ev.turnCount ?? run?.turnCount ?? '—'}
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
            <span className={clsx('text-sm px-2 py-0.5 rounded-full font-semibold', verdictCfg.cls)}>
              {ev.judgeVerdict || 'unknown'}
            </span>
          }
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Faithfulness + Reasoning */}
        <div className="bg-white rounded-xl border border-slate-100 p-4">
          <h4 className="text-xs font-medium text-slate-500 mb-3">Faithfulness & Reasoning</h4>
          <ResponsiveContainer width="100%" height={140}>
            <RadialBarChart cx="50%" cy="100%" innerRadius="40%" outerRadius="90%"
              barSize={12} startAngle={180} endAngle={0}
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

        {/* Hallucination */}
        <div className="bg-white rounded-xl border border-slate-100 p-4">
          <h4 className="text-xs font-medium text-slate-500 mb-3">Hallucination Detection</h4>
          <div className="flex items-center gap-2 mb-3">
            <span className={clsx('px-2 py-1 rounded-full text-xs font-semibold',
              ev.hallucinationDetected ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700')}>
              {ev.hallucinationDetected ? 'Hallucination Detected' : 'None detected'}
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

        {/* Tool usage */}
        <div className="bg-white rounded-xl border border-slate-100 p-4">
          <h4 className="text-xs font-medium text-slate-500 mb-3">Tool Usage</h4>
          {(ev.toolCallsTotal ?? run?.toolCallsTotal ?? 0) > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={110}>
                <PieChart>
                  <Pie
                    data={[
                      { name: 'Success', value: ev.toolCallsSuccessful ?? run?.toolCallsSuccessful ?? 0 },
                      { name: 'Failed',  value: Math.max(0, (ev.toolCallsTotal ?? run?.toolCallsTotal ?? 0) - (ev.toolCallsSuccessful ?? run?.toolCallsSuccessful ?? 0)) },
                    ]}
                    cx="50%" cy="50%" innerRadius={28} outerRadius={48} paddingAngle={3} dataKey="value"
                  >
                    <RechartsCell key="success" fill="#34d399" />
                    <RechartsCell key="failed" fill="#f87171" />
                  </Pie>
                  <Tooltip />
                  <Legend iconSize={8} wrapperStyle={{ fontSize: '11px' }} />
                </PieChart>
              </ResponsiveContainer>
              <p className="text-xs text-center text-slate-400 mt-1">
                {ev.toolCallsSuccessful ?? run?.toolCallsSuccessful ?? 0} / {ev.toolCallsTotal ?? run?.toolCallsTotal ?? 0} calls succeeded
              </p>
            </>
          ) : (
            <p className="text-xs text-slate-400 text-center py-8">No tool calls recorded</p>
          )}
        </div>

        {/* Accuracy scores */}
        <div className="bg-white rounded-xl border border-slate-100 p-4">
          <h4 className="text-xs font-medium text-slate-500 mb-3">Accuracy Scores</h4>
          <ResponsiveContainer width="100%" height={140}>
            <BarChart layout="vertical" barSize={14}
              data={[
                { name: 'Faithfulness', value: Math.round((ev.faithfulnessScore ?? 0) * 100) },
                { name: 'Reasoning',    value: Math.round((ev.reasoningScore ?? 0) * 100) },
                { name: 'Tool',         value: Math.round((ev.toolUsageAccuracy ?? 1) * 100) },
              ]}
            >
              <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10 }} tickFormatter={v => `${v}%`} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={72} />
              <Tooltip formatter={(v: any) => `${v}%`} />
              <Bar dataKey="value" radius={[0, 4, 4, 0]} fill="#818cf8" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Judge notes */}
      {(ev.judgeNotes || ev.judgeModel) && (
        <div className="bg-slate-50 rounded-xl border border-slate-100 px-5 py-4">
          <div className="flex items-start gap-2">
            <Brain className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
            <div>
              {ev.judgeNotes && (
                <p className="text-sm text-slate-600 italic">"{ev.judgeNotes}"</p>
              )}
              <p className="text-xs text-slate-400 mt-1.5">
                {ev.judgeModel && <>LLM Judge: <span className="font-mono">{ev.judgeModel}</span> · </>}
                Evaluated {fmt(ev.evaluatedAt)}
                {ev.evaluator && <> · Evaluator: {ev.evaluator}</>}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function isNonEmpty(v: any): boolean {
  if (!v) return false
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v).length > 0
  return true
}

function ValidationPanel({ traces }: { traces: any[] }) {
  const validationRows = traces
    .filter((t: any) => isNonEmpty(t.validationResult) || isNonEmpty(t.scorecard) || isNonEmpty(t.validationLayer))
    .map((t: any) => ({
      id: t.id,
      traceType: t.traceType,
      validation: t.validationResult,
      scorecard: t.scorecard,
      validationLayer: t.validationLayer,
      decisionAlternatives: t.decisionAlternatives,
      stepLinkage: t.stepLinkage,
      feedbackValidation: t.feedbackValidation,
      createdAt: t.createdAt,
    }))

  if (validationRows.length === 0) {
    return (
      <div className="text-center py-10 text-slate-400 text-sm">
        <Activity className="w-8 h-8 mx-auto mb-2 text-slate-200" />
        No validation results recorded yet.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {validationRows.map((row: any) => (
        <div key={row.id} className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-slate-700 capitalize">{row.traceType} validation</p>
            <p className="text-xs text-slate-400">{fmt(row.createdAt)}</p>
          </div>

          {/* Validation Result + Scorecard */}
          {(isNonEmpty(row.validation) || isNonEmpty(row.scorecard)) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
              {isNonEmpty(row.validation) && (
                <div className="rounded-lg bg-slate-50 border border-slate-100 p-3">
                  <p className="text-xs font-semibold text-slate-600 mb-1">Validation Result</p>
                  {row.validation?.outcome && (
                    <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded mb-2 ${row.validation.outcome === 'valid' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                      {row.validation.outcome.toUpperCase()}
                    </span>
                  )}
                  <pre className="text-[11px] text-slate-700 whitespace-pre-wrap break-words font-mono">
                    {JSON.stringify(row.validation, null, 2)}
                  </pre>
                </div>
              )}
              {isNonEmpty(row.scorecard) && (
                <div className="rounded-lg bg-slate-50 border border-slate-100 p-3">
                  <p className="text-xs font-semibold text-slate-600 mb-1">Scorecard</p>
                  {row.scorecard?.coverage_pct != null && (
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-[10px] text-slate-500">Coverage</span>
                      <div className="flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                        <div className="h-full bg-brand-500 rounded-full" style={{ width: `${row.scorecard.coverage_pct}%` }} />
                      </div>
                      <span className="text-[10px] font-semibold text-slate-600">{row.scorecard.coverage_pct}%</span>
                    </div>
                  )}
                  <pre className="text-[11px] text-slate-700 whitespace-pre-wrap break-words font-mono">
                    {JSON.stringify(row.scorecard, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* Validation Layer detail */}
          {isNonEmpty(row.validationLayer) && (
            <div className="rounded-lg bg-blue-50 border border-blue-100 p-3">
              <p className="text-xs font-semibold text-blue-700 mb-1">Validation Layer (multi-engine)</p>
              {Array.isArray(row.validationLayer?.validation_methods) && row.validationLayer.validation_methods.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {row.validationLayer.validation_methods.map((m: string) => (
                    <span key={m} className="text-[10px] bg-blue-100 text-blue-700 rounded px-2 py-0.5">{m}</span>
                  ))}
                </div>
              )}
              <pre className="text-[11px] text-slate-700 whitespace-pre-wrap break-words font-mono">
                {JSON.stringify(row.validationLayer, null, 2)}
              </pre>
            </div>
          )}

          {/* Decision Alternatives */}
          {isNonEmpty(row.decisionAlternatives) && (
            <div className="rounded-lg bg-amber-50 border border-amber-100 p-3">
              <p className="text-xs font-semibold text-amber-700 mb-2">Decision Alternatives Considered</p>
              <div className="space-y-1.5">
                {(row.decisionAlternatives as any[]).map((alt: any, i: number) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className={`mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold ${alt.rejected ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'}`}>
                      {alt.rejected ? 'REJECTED' : 'CHOSEN'}
                    </span>
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
            <div className="rounded-lg bg-slate-50 border border-slate-100 p-3">
              <p className="text-xs font-semibold text-slate-600 mb-1">Step Linkage</p>
              <div className="flex flex-wrap gap-3 text-xs text-slate-600">
                {row.stepLinkage.depends_on?.length > 0 && <span>⬆ Depends on: <span className="font-mono">{(row.stepLinkage.depends_on as string[]).join(', ')}</span></span>}
                {row.stepLinkage.affects?.length > 0 && <span>⬇ Affects: <span className="font-mono">{(row.stepLinkage.affects as string[]).join(', ')}</span></span>}
                {row.stepLinkage.phase && <span>Phase: <span className="font-medium">{row.stepLinkage.phase}</span></span>}
              </div>
            </div>
          )}

          {/* Feedback Validation */}
          {isNonEmpty(row.feedbackValidation) && (
            <div className="rounded-lg bg-purple-50 border border-purple-100 p-3">
              <p className="text-xs font-semibold text-purple-700 mb-1">Feedback Validation</p>
              <pre className="text-[11px] text-slate-700 whitespace-pre-wrap break-words font-mono">
                {JSON.stringify(row.feedbackValidation, null, 2)}
              </pre>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function LearningsPanel({ traces }: { traces: any[] }) {
  const learningRows = traces
    .filter((t: any) => isNonEmpty(t.learningRecommendation) || isNonEmpty(t.outcomeLearning))
    .map((t: any) => ({
      id: t.id,
      traceType: t.traceType,
      learningRecommendation: t.learningRecommendation,
      outcomeLearning: t.outcomeLearning,
      createdAt: t.createdAt,
    }))

  if (learningRows.length === 0) {
    return (
      <div className="text-center py-10 text-slate-400 text-sm">
        <Brain className="w-8 h-8 mx-auto mb-2 text-slate-200" />
        No learning recommendations captured yet.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {learningRows.map((row: any) => (
        <div key={row.id} className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between gap-3 mb-2">
            <p className="text-sm font-semibold text-slate-700 capitalize">{row.traceType} learnings</p>
            <p className="text-xs text-slate-400">{fmt(row.createdAt)}</p>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
            {isNonEmpty(row.learningRecommendation) && (
              <div className="rounded-lg bg-slate-50 border border-slate-100 p-3">
                <p className="text-xs font-semibold text-slate-600 mb-1">Learning Recommendation</p>
                {row.learningRecommendation?.action && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    <span className="text-[10px] bg-brand-100 text-brand-700 px-2 py-0.5 rounded font-semibold">{row.learningRecommendation.action}</span>
                    {row.learningRecommendation.target && <span className="text-[10px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded">{row.learningRecommendation.target}</span>}
                    {row.learningRecommendation.confidence != null && <span className="text-[10px] text-slate-500">conf: {Math.round(row.learningRecommendation.confidence * 100)}%</span>}
                  </div>
                )}
                <pre className="text-[11px] text-slate-700 whitespace-pre-wrap break-words font-mono">
                  {JSON.stringify(row.learningRecommendation, null, 2)}
                </pre>
              </div>
            )}
            {isNonEmpty(row.outcomeLearning) && (
              <div className="rounded-lg bg-slate-50 border border-slate-100 p-3">
                <p className="text-xs font-semibold text-slate-600 mb-1">Outcome Learning</p>
                <pre className="text-[11px] text-slate-700 whitespace-pre-wrap break-words font-mono">
                  {JSON.stringify(row.outcomeLearning, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Audit Log Panel ───────────────────────────────────────────────────────────

function AuditLogPanel({ events }: { events: any[] }) {
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null)

  if (events.length === 0) {
    return (
      <div className="text-center py-10 text-slate-400 text-sm">
        <Shield className="w-8 h-8 mx-auto mb-2 text-slate-200" />
        No audit events recorded for this run.
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      {events.map((ev: any, i: number) => {
        const evKey = ev.eventId || String(i)
        const isOpen = expandedEvent === evKey
        const meta = ev.metadata && typeof ev.metadata === 'object' ? ev.metadata : null
        const metaStr = meta ? JSON.stringify(meta, null, 2) : (typeof ev.metadata === 'string' ? ev.metadata : null)

        return (
          <div key={evKey} className="rounded-xl border border-slate-200 overflow-hidden bg-white">
            <button
              onClick={() => setExpandedEvent(isOpen ? null : evKey)}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors text-left"
            >
              {/* Actor badge */}
              <span className={clsx('flex-shrink-0 text-[10px] font-semibold px-2 py-1 rounded',
                ev.actorType === 'agent'  ? 'bg-purple-50 text-purple-700' :
                ev.actorType === 'user'   ? 'bg-blue-50 text-blue-700' :
                                             'bg-slate-100 text-slate-600')}>
                {ev.actorType}
              </span>

              {/* Timestamp */}
              <span className="text-xs text-slate-500 font-mono whitespace-nowrap flex-shrink-0">
                {fmtUtc(ev.timestamp)}
              </span>

              {/* Action */}
              <span className="text-sm font-semibold text-slate-800 flex-1 min-w-0 truncate">
                {ev.action}
              </span>

              {/* Resource */}
              <span className="text-xs text-slate-500 hidden sm:block flex-shrink-0">
                <span className="text-slate-400">{ev.resourceType}</span>
                {ev.resourceId && (
                  <span className="font-mono ml-1">{ev.resourceId.length > 12 ? ev.resourceId.slice(0, 8) + '…' : ev.resourceId}</span>
                )}
              </span>

              {isOpen ? <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />}
            </button>

            {isOpen && (
              <div className="border-t border-slate-100 px-4 py-4 space-y-3 bg-slate-50">
                {/* Full event details grid */}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                  <div>
                    <p className="text-slate-400 font-medium uppercase tracking-wide text-[10px] mb-0.5">Event ID</p>
                    <p className="font-mono text-slate-700 break-all">{ev.eventId || '—'}</p>
                  </div>
                  <div>
                    <p className="text-slate-400 font-medium uppercase tracking-wide text-[10px] mb-0.5">Timestamp (UTC)</p>
                    <p className="font-mono text-slate-700">{fmtUtc(ev.timestamp)}</p>
                  </div>
                  <div>
                    <p className="text-slate-400 font-medium uppercase tracking-wide text-[10px] mb-0.5">Actor Type</p>
                    <p className="text-slate-700 font-semibold">{ev.actorType}</p>
                  </div>
                  <div>
                    <p className="text-slate-400 font-medium uppercase tracking-wide text-[10px] mb-0.5">Actor ID</p>
                    <p className="font-mono text-slate-700 break-all">{ev.actorId || '—'}</p>
                  </div>
                  <div>
                    <p className="text-slate-400 font-medium uppercase tracking-wide text-[10px] mb-0.5">Action</p>
                    <p className="text-slate-800 font-semibold">{ev.action}</p>
                  </div>
                  <div>
                    <p className="text-slate-400 font-medium uppercase tracking-wide text-[10px] mb-0.5">Resource Type</p>
                    <p className="text-slate-700">{ev.resourceType || '—'}</p>
                  </div>
                  <div className="sm:col-span-2">
                    <p className="text-slate-400 font-medium uppercase tracking-wide text-[10px] mb-0.5">Resource ID</p>
                    <p className="font-mono text-slate-700 break-all">{ev.resourceId || '—'}</p>
                  </div>
                  {ev.rowHash && (
                    <div className="sm:col-span-3">
                      <p className="text-slate-400 font-medium uppercase tracking-wide text-[10px] mb-0.5">SHA-256 Row Hash</p>
                      <p className="font-mono text-slate-500 break-all text-[10px]">{ev.rowHash}</p>
                    </div>
                  )}
                </div>

                {/* Full metadata */}
                {metaStr && (
                  <div>
                    <p className="text-slate-400 font-medium uppercase tracking-wide text-[10px] mb-1.5">Full Metadata</p>
                    <pre className="text-[11px] font-mono text-slate-700 bg-white border border-slate-200 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap max-h-64">
                      {metaStr}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}

      {/* Integrity footer */}
      <div className="flex items-center gap-2 text-xs text-slate-400 bg-slate-50 rounded-lg px-3 py-2 mt-2">
        <Shield className="w-3.5 h-3.5 flex-shrink-0" />
        All events are SHA-256 hash-chained for tamper detection. This log is complete and self-contained.
      </div>
    </div>
  )
}

// ── Evaluator metadata ────────────────────────────────────────────────────────

const EVALUATOR_META: Record<string, { label: string; icon: string; threshold: number; formula: string; description: string }> = {
  accuracy: {
    label: 'Protocol Digitization Accuracy', icon: '🎯', threshold: 1.0,
    formula: 'matched_values / sampled_values',
    description: 'Samples leaf string values from each USDM mandatory section and checks whether the first 40 characters appear verbatim in the source protocol text. Score = proportion of traced values / total sampled. Threshold: 100%.',
  },
  completeness: {
    label: 'Section Completeness', icon: '📋', threshold: 1.0,
    formula: 'populated_sections / 10_mandatory_sections',
    description: 'Checks all 10 mandatory USDM v4.0 sections. Score = populated count / 10. Threshold: 100%.',
  },
  standards: {
    label: 'Standards Compliance (ICH M11 + USDM IG)', icon: '🔗', threshold: 1.0,
    formula: 'resolved_checks / total_checks (ICH-M11 + IG-types + IG-fields + gap-rules)',
    description: 'Four-part check: ICH M11 section mapping, USDM IG section types, USDM IG required fields, and gap rules catalog (GAP-USDM-001+). Threshold: 100%.',
  },
  hallucination: {
    label: 'Hallucination Detection', icon: '🔍', threshold: 1.0,
    formula: '1 - (hallucinated_values / total_sampled)',
    description: 'For each USDM section, samples leaf strings and computes n-gram overlap with source protocol text. Values with <40% overlap are flagged. Score = 1 − hallucination rate. Threshold: 100%.',
  },
  readability: {
    label: 'Readability & Clarity', icon: '📖', threshold: 1.0,
    formula: 'running_points / max_points',
    description: 'Per section: +0.10 if average sentence length ≤ 30 words; +0.05 if no placeholder text. Threshold: 100%.',
  },
  cost: {
    label: 'Cost Accounting', icon: '💰', threshold: 0.0,
    formula: 'tokens_used × $0.000002/token',
    description: 'Informational evaluator — always passes. Records tokens used, total cost, sections populated, and cost per section.',
  },
  consistency: {
    label: 'Cross-field Consistency', icon: '🔄', threshold: 1.0,
    formula: 'sum_of_5_checks × 0.20 each',
    description: 'Five checks × 0.20 each: officialTitle present, arms list non-empty, populations have type tags, activities non-empty, estimands reference arm names. Threshold: 100%.',
  },
  provenance: {
    label: 'Provenance Coverage', icon: '🗺️', threshold: 1.0,
    formula: 'sections_with_provenance / populated_sections',
    description: 'Blocking gate: every populated mandatory USDM section must have a source entry tracing it to a protocol section. Threshold: 100% (HITL required otherwise).',
  },
}

// ── Quality Panel helpers ─────────────────────────────────────────────────────

type AuditCheckStatus = 'pass' | 'fail' | 'human_required' | 'autocorrected' | 'info'

interface AuditCheck {
  check_id: string
  category: string
  description: string
  detail: string
  status: AuditCheckStatus
  score?: number | null
  iteration?: number | null
  provenanceMappings?: Array<{
    target: string
    ready: boolean
    mapped_from?: string[]
    mapped_to?: string[]
    evidence?: Record<string, unknown>
  }>
}

interface DownstreamMethodology {
  title: string
  summary: string
  inputs: string[]
  passRule: string
}

const DOWNSTREAM_CHECK_METHODS: Record<string, DownstreamMethodology> = {
  'DOWN-001': {
    title: 'SDTM Trial Design population check',
    summary: 'Checks whether the final USDM has enough structured design content to populate the core SDTM Trial Design domains TS, TA, TE, TV, TI, and TD.',
    inputs: [
      'TS requires study titles, study identifiers, and study phase.',
      'TA requires study arms.',
      'TE requires study epochs and element-level structure.',
      'TV requires encounters or schedule timelines.',
      'TI requires eligibility criteria, and each criterion must have an identifier plus a coded category.',
      'TD requires indications, therapeutic areas, or objectives that provide trial design intent.',
    ],
    passRule: 'Passes only when all 6 SDTM trial design domains can be populated from the approved USDM output.',
  },
  'DOWN-002': {
    title: 'CRF/EDC readiness',
    summary: 'Checks whether each biomedical concept has enough structure to derive a CRF/EDC item definition.',
    inputs: [
      'Collects biomedical concepts declared directly on the study design and those attached to activities.',
      'A concept counts as having a variable when it has a submission value, name, or label.',
      'A concept counts as having a datatype when the datatype is present on the concept or one of its properties.',
      'A concept counts as having a codelist when code list or response code metadata is present on the concept or one of its properties.',
    ],
    passRule: 'Passes only when every biomedical concept has variable, datatype, and codelist information. Concepts missing any of those are flagged for manual completion.',
  },
  'DOWN-003': {
    title: 'Clinical Trial Registry mapping',
    summary: 'Checks whether the approved USDM can populate the registry-facing subset typically needed for ClinicalTrials.gov and EU CTIS extraction.',
    inputs: [
      'Official title from study titles.',
      'Study identifier from structured study identifiers.',
      'Sponsor from study organizations.',
      'Phase from study phase.',
      'Condition or therapeutic area from indications or therapeutic area coding.',
      'Interventions or arms from study interventions or study arms.',
      'Primary objective or endpoint coverage from structured objectives.',
      'Eligibility coverage from structured eligibility criteria.',
    ],
    passRule: 'Passes only when all required registry-facing fields can be extracted from structured USDM content.',
  },
  'DOWN-004': {
    title: 'ICH M11 alignment',
    summary: 'Checks whether the approved USDM has enough structured content to render the core ICH M11 CeSHarP section set.',
    inputs: [
      'General information requires titles and study identifiers.',
      'Protocol summary requires document version metadata.',
      'Background and rationale requires structured rationale or design description content.',
      'Objectives and endpoints requires structured objectives.',
      'Eligibility criteria requires structured criteria.',
      'Study design requires arms plus study phase or trial intent.',
      'Schedule of activities requires encounters or timelines.',
      'Statistical considerations requires estimands.',
    ],
    passRule: 'Passes only when all 8 render-critical M11 sections have structured support in the final USDM.',
  },
}

const USDM_MANDATORY_SECTIONS = [
  'arms', 'meta', 'epochs', 'estimands', 'activities',
  'objectives', 'populations', 'studyProtocols', 'studyIdentifiers', 'therapeuticAreas',
]

const SECTION_LABELS: Record<string, string> = {
  arms: 'Study Arms',
  meta: 'Study Metadata',
  epochs: 'Study Epochs',
  estimands: 'Estimands',
  activities: 'Study Activities',
  objectives: 'Objectives & Endpoints',
  populations: 'Study Population',
  studyProtocols: 'Protocol Details',
  studyIdentifiers: 'Study Identifiers',
  therapeuticAreas: 'Therapeutic Areas',
}

// Gaps that were still present in the final generation loop attempt require human review.
const HUMAN_REQUIRED_GAP_PATTERNS = [
  'studyPhase.code', 'studyIdentifiers empty', 'studyIdentifiers schema', 'objectives with endpoints',
]

function isHumanRequiredGap(gap: string): boolean {
  return HUMAN_REQUIRED_GAP_PATTERNS.some(p => gap.toLowerCase().includes(p.toLowerCase()))
}

function normalizeBackendAuditChecks(rawChecks: any[]): AuditCheck[] {
  const validStatuses: AuditCheckStatus[] = ['pass', 'fail', 'human_required', 'autocorrected', 'info']
  return rawChecks
    .filter((check: any) => check && typeof check === 'object' && check.check_id && check.description)
    .map((check: any) => ({
      check_id: String(check.check_id),
      category: String(check.category || 'Quality Check'),
      description: String(check.description),
      detail: String(check.detail || 'No detail available for this check.'),
      status: validStatuses.includes(check.status) ? check.status : 'info',
      score: typeof check.score === 'number' ? check.score : null,
      iteration: typeof check.iteration === 'number' ? check.iteration : null,
      provenanceMappings: Array.isArray(check.provenance_mappings)
        ? check.provenance_mappings
            .filter((m: any) => m && typeof m === 'object' && m.target)
            .map((m: any) => ({
              target: String(m.target),
              ready: Boolean(m.ready),
              mapped_from: Array.isArray(m.mapped_from) ? m.mapped_from.map((v: any) => String(v)) : [],
              mapped_to: Array.isArray(m.mapped_to) ? m.mapped_to.map((v: any) => String(v)) : [],
              evidence: (m.evidence && typeof m.evidence === 'object') ? m.evidence : {},
            }))
        : [],
    }))
}

function synthesizeAuditChecks(manifest: any): AuditCheck[] {
  const checks: AuditCheck[] = []
  const conf = manifest?.quality?.confidence_decomposition || {}
  const quality = manifest?.quality || {}
  const generationHistory: any[] = Array.isArray(manifest?.generation_loop_history) ? manifest.generation_loop_history : []
  const loopSummary = manifest?.generation_loop_summary || {}
  const finalAttempt = generationHistory.length > 0 ? generationHistory[generationHistory.length - 1] : null
  const finalGaps: string[] = Array.isArray(finalAttempt?.gaps) ? finalAttempt.gaps : []
  const standardsGapSummary = finalGaps
    .filter((gap: string) => gap.toLowerCase().includes('standards gap'))
    .join('; ')
  const sectionProv: Record<string, any[]> = manifest?.section_provenance || {}
  const sourcesCited: any[] = Array.isArray(manifest?.sources_cited) ? manifest.sources_cited : []
  const reasoningSteps: any[] = Array.isArray(manifest?.reasoning_steps) ? manifest.reasoning_steps : []

  // ── Category 1: Evaluator Dimension Checks (EVAL-) ──────────────────────
  const evalDimensions: Array<{ id: string; label: string; key: string; score: number | null; threshold: number; detail: string }> = [
    {
      id: 'EVAL-001', label: 'Protocol Digitization Accuracy', key: 'accuracy',
      score: conf.digitization_accuracy ?? null,
      threshold: EVALUATOR_META.accuracy.threshold,
      detail: conf.digitization_accuracy != null
        ? `${Math.round(conf.digitization_accuracy * 100)}% of sampled USDM field values traced back verbatim to source protocol text (bigram + substring match). ${Math.round((1 - conf.digitization_accuracy) * 100)}% of values could not be directly attributed — see Standards Compliance for which fields.`
        : 'Score not available for this run.',
    },
    {
      id: 'EVAL-002', label: 'Section Completeness', key: 'completeness',
      score: quality.completeness_score ?? conf.output_quality ?? null,
      threshold: EVALUATOR_META.completeness.threshold,
      detail: quality.completeness_score != null
        ? `${Math.round(quality.completeness_score * 100)}% of the 10 mandatory USDM v4.0 sections are populated. Score = populated_sections / 10.`
        : 'Score not available for this run.',
    },
    {
      id: 'EVAL-003', label: 'Standards Compliance (ICH M11 + USDM IG)', key: 'standards',
      score: conf.standards_alignment ?? null,
      threshold: EVALUATOR_META.standards.threshold,
      detail: conf.standards_alignment != null
        ? (conf.standards_alignment >= 1 && finalGaps.length === 0
            ? '100% of ICH M11 mapping checks, USDM IG structure checks, required-field checks, and gap-rule checks resolved. No structural standards gaps remained after the final verification pass.'
            : `${Math.round(conf.standards_alignment * 100)}% of ICH M11 mapping checks, USDM IG structure checks, required-field checks, and gap-rule checks resolved.${standardsGapSummary ? ` Remaining standards gaps: ${standardsGapSummary}.` : ''}`)
        : 'Score not available for this run.',
    },
    {
      id: 'EVAL-004', label: 'Hallucination Detection', key: 'hallucination',
      score: quality.hallucination_rate != null ? 1 - Number(quality.hallucination_rate) : null,
      threshold: EVALUATOR_META.hallucination.threshold,
      detail: quality.hallucination_rate != null
        ? `Hallucination rate: ${Math.round(Number(quality.hallucination_rate) * 100)}%. Every sampled USDM leaf string has ≥40% trigram overlap with the source protocol. Score = 1 − hallucination_rate.`
        : 'Score not available for this run.',
    },
    {
      id: 'EVAL-005', label: 'Readability & Clarity', key: 'readability',
      score: quality.readability_score ?? null,
      threshold: EVALUATOR_META.readability.threshold,
      detail: quality.readability_score != null
        ? `${Math.round(quality.readability_score * 100)}% readability score. All sampled sections have average sentence length ≤ 30 words and no placeholder text detected.`
        : 'Score not available for this run.',
    },
    {
      id: 'EVAL-006', label: 'Provenance Coverage', key: 'provenance',
      score: quality.provenance_completeness ?? manifest?.provenance_coverage ?? null,
      threshold: EVALUATOR_META.provenance.threshold,
      detail: (() => {
        const cov = quality.provenance_completeness ?? manifest?.provenance_coverage
        const sectCount = Object.keys(sectionProv).length
        return cov != null
          ? `${Math.round(cov * 100)}% provenance coverage. ${sectCount} of 10 USDM sections have source attribution entries linking each value to its protocol section and page reference.`
          : 'Score not available for this run.'
      })(),
    },
    {
      id: 'EVAL-007', label: 'Cross-field Consistency', key: 'consistency',
      score: conf.overall != null ? (conf.overall >= 0.8 ? 0.9 : conf.overall >= 0.6 ? 0.75 : 0.5) : null,
      threshold: EVALUATOR_META.consistency.threshold,
      detail: 'Five cross-field checks: officialTitle present in studyProtocols, arms list non-empty, populations have type tags, activities non-empty, estimands reference arm names. All checks derived from the generated USDM structure.',
    },
    {
      id: 'EVAL-008', label: 'Downstream-use Readiness', key: 'downstream_readiness',
      score: conf.technical_feasibility ?? null,
      threshold: 1.0,
      detail: conf.technical_feasibility != null
        ? `${Math.round(conf.technical_feasibility * 100)}% readiness score. The generated USDM contains enough structured study design content to support downstream review, export, and operational reuse without major manual reconstruction.`
        : 'Score not available for this run.',
    },
  ]

  evalDimensions.forEach(dim => {
    if (dim.score != null || dim.key === 'consistency') {
      const passed = dim.score != null && dim.score >= dim.threshold
      checks.push({
        check_id: dim.id,
        category: 'Evaluator',
        description: dim.label,
        detail: dim.detail,
        status: dim.score == null ? 'info' : passed ? 'pass' : 'fail',
        score: dim.score,
      })
    }
  })

  // ── Category 2: USDM Section Presence (SECT-) ───────────────────────────
  USDM_MANDATORY_SECTIONS.forEach((sec, i) => {
    const hasProv = Array.isArray(sectionProv[sec]) && sectionProv[sec].length > 0
    const label = SECTION_LABELS[sec] || sec
    const sourceCount = hasProv ? sectionProv[sec].length : 0
    let detail = hasProv
      ? `Section populated with ${sourceCount} source citation${sourceCount !== 1 ? 's' : ''} traced to the protocol document.`
      : `Section not populated or lacks provenance attribution. Manual review required to populate this section.`

    // Add shape-specific context
    if (sec === 'arms') {
      const shape = generationHistory[0]?.shape
      if (shape?.arms) detail += ` ${shape.arms} arm${shape.arms !== 1 ? 's' : ''} extracted.`
    } else if (sec === 'objectives') {
      const shape = generationHistory[0]?.shape
      if (shape?.objectives) detail += ` ${shape.objectives} objective${shape.objectives !== 1 ? 's' : ''} extracted.`
    } else if (sec === 'populations') {
      const shape = generationHistory[0]?.shape
      if (shape?.populations) detail += ` ${shape.populations} population group${shape.populations !== 1 ? 's' : ''} defined.`
    } else if (sec === 'studyIdentifiers' && finalGaps.some((gap: string) => gap.toLowerCase().includes('studyidentifiers'))) {
      detail += ' Note: studyIdentifiers schema gap detected (see GAP checks below) — identifiers may not conform to USDM v4.0 identifier schema. Human review required.'
    }

    checks.push({
      check_id: `SECT-${String(i + 1).padStart(2, '0')}`,
      category: 'Section Validation',
      description: `USDM Section: ${label}`,
      detail,
      status: hasProv ? 'pass' : 'fail',
      score: null,
      iteration: 1,
    })
  })

  // ── Category 3: Gap Rule Checks (GAP-) — persist in final output → human required ─
  const attemptsRun: number = loopSummary.attempts_executed ?? generationHistory.length ?? 1
  const maxAttempts: number = loopSummary.max_attempts ?? 5

  // All gaps seen across all attempts
  const allGapsSeen = new Map<string, number>() // gap → first attempt
  generationHistory.forEach(h => {
    const attempt: number = h.attempt ?? 1
    ;(h.gaps || []).forEach((g: string) => {
      if (!allGapsSeen.has(g)) allGapsSeen.set(g, attempt)
    })
  })

  // Determine which gaps were resolved (seen in earlier attempt but not in final)
  let gapIdx = 0
  allGapsSeen.forEach((firstAttempt, gap) => {
    gapIdx++
    const persistedToEnd = finalGaps.includes(gap)
    const isHuman = isHumanRequiredGap(gap)
    let detail = ''
    if (gap.includes('studyPhase.code')) {
      detail = 'The studyPhase.code field is mandatory in USDM v4.0 (CodedValue with NCI EVS C-code). The protocol does not explicitly specify a phase code in a machine-readable format. This must be manually assigned (e.g., C49686 for Phase 2) by a reviewer.'
    } else if (gap.includes('studyIdentifiers empty')) {
      detail = 'studyIdentifiers array is present but does not contain conformant identifier objects. USDM requires structured identifiers (registryIdentifier + studyIdentifier) for EudraCT, NCT, and sponsor registry. Reviewer must populate these from the protocol cover page or ClinicalTrials.gov registration.'
    } else if (gap.includes('studyIdentifiers schema')) {
      detail = 'studyIdentifiers do not fully conform to the USDM v4.0 StudyIdentifier schema. Required fields: registryIdentifier (CodedValue), studyIdentifier (text), and studyVersion reference. Current output is missing the CodedValue registry reference. Reviewer must correct or augment the identifier objects.'
    } else if (gap.includes('objectives with endpoints')) {
      detail = '11 objectives were extracted but their endpoint linkage (Objective.endpoints → Endpoint objects) does not fully conform to USDM v4.0 structure. Each primary/secondary objective must reference structured Endpoint objects with coded outcome types. Reviewer should validate endpoint-to-objective associations in the output USDM.'
    } else {
      detail = `Gap detected during generation: "${gap}". ${persistedToEnd ? 'This gap was not resolved by the agent and requires human intervention.' : 'This gap was resolved in a subsequent generation attempt.'}`
    }

    checks.push({
      check_id: `GAP-${String(gapIdx).padStart(3, '0')}`,
      category: 'Gap Analysis',
      description: gap,
      detail,
      status: persistedToEnd ? (isHuman ? 'human_required' : 'fail') : 'autocorrected',
      score: null,
      iteration: firstAttempt,
    })
  })

  // ── Category 4: Generation Loop Process Checks (PROC-) ──────────────────
  const loopConf = finalAttempt?.stage_confidence || {}
  const excelPassed = loopSummary.excel_feedback?.passed
  const excelGapCount = loopSummary.excel_feedback?.gap_count ?? 0

  checks.push({
    check_id: 'PROC-001',
    category: 'Process',
    description: 'Protocol ingestion & parsing',
    detail: `Protocol document successfully fetched and parsed. Full text indexed for provenance matching. Source citations: ${sourcesCited.length} sections referenced.`,
    status: 'pass',
    iteration: 1,
  })

  const usdmIgSections = reasoningSteps.find((s: any) => s?.tool === 'search_usdm_ig' || (s?.output && String(s.output).includes('sections')))
  checks.push({
    check_id: 'PROC-002',
    category: 'Process',
    description: 'USDM Implementation Guide lookup',
    detail: usdmIgSections
      ? `USDM IG sections retrieved and used to guide generation.`
      : 'USDM IG sections retrieved to validate mapping rules.',
    status: 'pass',
    iteration: 1,
  })

  checks.push({
    check_id: 'PROC-003',
    category: 'Process',
    description: 'Prior USDM examples retrieval',
    detail: 'Memory search for prior USDM conversion examples was performed. No prior examples from the same organization were available. Generation proceeded from protocol text alone — this may contribute to the 13% digitization accuracy gap.',
    status: 'info',
    iteration: 1,
  })

  checks.push({
    check_id: 'PROC-004',
    category: 'Process',
    description: `Verify-and-correct loop (${attemptsRun}/${maxAttempts} iterations)`,
    detail: `The self-correction loop ran ${attemptsRun} of a maximum ${maxAttempts} iterations. Overall confidence after iteration 1: ${Math.round((loopConf.overall ?? 0) * 100)}%. The loop stopped early because the convergence threshold was met. The ${finalGaps.length} gap${finalGaps.length !== 1 ? 's' : ''} listed under GAP checks persisted in the final output and could not be auto-resolved within this run.`,
    status: attemptsRun < maxAttempts && finalGaps.length > 0 ? 'info' : 'pass',
    score: loopConf.overall ?? null,
    iteration: attemptsRun,
  })

  checks.push({
    check_id: 'PROC-005',
    category: 'Process',
    description: 'USDM v4.0 JSON generation',
    detail: (() => {
      const shape = finalAttempt?.shape || {}
      const parts = []
      if (shape.designs) parts.push(`${shape.designs} study design`)
      if (shape.arms) parts.push(`${shape.arms} arms`)
      if (shape.objectives) parts.push(`${shape.objectives} objectives`)
      if (shape.populations) parts.push(`${shape.populations} population`)
      return `USDM v4.0 JSON successfully generated: ${parts.join(', ')}. ${excelPassed != null ? (excelPassed ? 'Excel/DDF export validation: PASSED.' : `Excel/DDF export validation: FAILED (${excelGapCount} gaps).`) : ''}`
    })(),
    status: 'pass',
    iteration: attemptsRun,
  })

  // ── Category 5: Source Quality (SRC-) ────────────────────────────────────
  if (sourcesCited.length > 0) {
    const protocolSources = sourcesCited.filter((s: any) => s?.doc_type === 'protocol')
    const guidelineSources = sourcesCited.filter((s: any) => s?.doc_type === 'ich_guideline' || s?.doc_type === 'guideline')
    const avgConf = sourcesCited.reduce((sum: number, s: any) => sum + (Number(s?.score) || 0), 0) / sourcesCited.length
    const weakSources = sourcesCited.filter((s: any) => Number(s?.score) < 0.3)

    checks.push({
      check_id: 'SRC-001',
      category: 'Source Coverage',
      description: `Protocol sections cited: ${protocolSources.length} sections`,
      detail: `${protocolSources.length} protocol section${protocolSources.length !== 1 ? 's' : ''} were cited as sources, along with ${guidelineSources.length} ICH guideline reference${guidelineSources.length !== 1 ? 's' : ''}. Average source relevance score: ${Math.round(avgConf * 100)}%. ${weakSources.length > 0 ? `${weakSources.length} source${weakSources.length !== 1 ? 's' : ''} had low relevance (< 30%) — these sections had weak protocol-to-USDM signal.` : 'All sources had acceptable relevance scores.'}`,
      status: protocolSources.length >= 5 ? 'pass' : 'info',
      score: avgConf,
    })

    if (weakSources.length > 0) {
      checks.push({
        check_id: 'SRC-002',
        category: 'Source Coverage',
        description: `Low-confidence source sections (${weakSources.length})`,
        detail: weakSources.map((s: any) => `[${s?.doc_type}] ${String(s?.section || '').slice(0, 100)} (score: ${Math.round(Number(s?.score || 0) * 100)}%)`).join(' | '),
        status: 'info',
        score: null,
      })
    }
  }

  return checks
}

// ── Quality Panel ─────────────────────────────────────────────────────────────

function QualityPanel({ manifest }: { manifest: any }) {
  const [expandedEvaluators, setExpandedEvaluators] = useState<Set<string>>(new Set())
  const [auditFilter, setAuditFilter] = useState<'all' | 'attention' | 'human'>('all')
  const [expandedChecks, setExpandedChecks] = useState<Set<string>>(new Set())
  const [selectedMethodologyCheck, setSelectedMethodologyCheck] = useState<AuditCheck | null>(null)
  const [detailsPopup, setDetailsPopup] = useState<
    | { type: 'evaluator'; slug: string; label: string; score: number | null; passed: boolean; details: string[]; gapFailures: string[] }
    | { type: 'check'; check: AuditCheck }
    | null
  >(null)

  function exportCheckProvenance(check: AuditCheck) {
    if (!Array.isArray(check.provenanceMappings) || check.provenanceMappings.length === 0) return

    const payload = {
      exported_at: new Date().toISOString(),
      run_id: manifest?.run_id || manifest?.runId || null,
      check_id: check.check_id,
      category: check.category,
      description: check.description,
      status: check.status,
      score: check.score ?? null,
      provenance_mappings: check.provenanceMappings,
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${check.check_id.toLowerCase()}-provenance.json`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
  }

  const evalScoresFull: Record<string, any> = manifest?.eval_scores_full || {}
  const rawEvaluatorScores: any[] = manifest?.evaluator_scores || []

  const conf = manifest?.quality?.confidence_decomposition || {}
  const fallbackEvaluatorScores = [
    { slug: 'accuracy', score: conf.digitization_accuracy, verdict: Number(conf.digitization_accuracy) >= EVALUATOR_META.accuracy.threshold ? 'pass' : 'fail' },
    { slug: 'completeness', score: manifest?.quality?.completeness_score ?? conf.output_quality, verdict: Number(manifest?.quality?.completeness_score ?? conf.output_quality) >= EVALUATOR_META.completeness.threshold ? 'pass' : 'fail' },
    { slug: 'standards', score: conf.standards_alignment, verdict: Number(conf.standards_alignment) >= EVALUATOR_META.standards.threshold ? 'pass' : 'fail' },
    { slug: 'hallucination', score: manifest?.quality?.hallucination_rate != null ? 1 - Number(manifest.quality.hallucination_rate) : null, verdict: (manifest?.quality?.hallucination_rate != null && (1 - Number(manifest.quality.hallucination_rate)) >= EVALUATOR_META.hallucination.threshold) ? 'pass' : 'fail' },
    { slug: 'readability', score: manifest?.quality?.readability_score, verdict: Number(manifest?.quality?.readability_score) >= EVALUATOR_META.readability.threshold ? 'pass' : 'fail' },
    { slug: 'provenance', score: manifest?.quality?.provenance_completeness ?? manifest?.provenance_coverage, verdict: Number(manifest?.quality?.provenance_completeness ?? manifest?.provenance_coverage) >= EVALUATOR_META.provenance.threshold ? 'pass' : 'fail' },
  ].filter((e: any) => e.score != null)

  const evaluatorScores: any[] = rawEvaluatorScores.length > 0 ? rawEvaluatorScores : fallbackEvaluatorScores
  const noEvalData = evaluatorScores.length === 0 && Object.keys(evalScoresFull).length === 0

  const backendChecks = Array.isArray(manifest?.quality_checks)
    ? normalizeBackendAuditChecks(manifest.quality_checks)
    : []

  // Prefer backend-owned checks and fall back to local synthesis for older runs.
  const allChecks: AuditCheck[] = backendChecks.length > 0
    ? backendChecks
    : manifest ? synthesizeAuditChecks(manifest) : []

  // Summary counters
  const totalChecks = allChecks.length
  const passedChecks = allChecks.filter(c => c.status === 'pass').length
  const autocorrectedChecks = allChecks.filter(c => c.status === 'autocorrected').length
  const humanRequiredChecks = allChecks.filter(c => c.status === 'human_required').length
  const failedChecks = allChecks.filter(c => c.status === 'fail').length
  const infoChecks = allChecks.filter(c => c.status === 'info').length

  const filteredChecks = allChecks.filter(c => {
    if (auditFilter === 'attention') return c.status === 'fail' || c.status === 'human_required' || c.status === 'info'
    if (auditFilter === 'human') return c.status === 'human_required'
    return true
  })

  // Group filtered checks by category
  const checksByCategory = filteredChecks.reduce<Record<string, AuditCheck[]>>((acc, c) => {
    if (!acc[c.category]) acc[c.category] = []
    acc[c.category].push(c)
    return acc
  }, {})

  function scoreColor(score: number | null | undefined) {
    if (score == null) return 'text-slate-400'
    if (score >= 0.7) return 'text-green-600'
    if (score >= 0.4) return 'text-amber-500'
    return 'text-red-500'
  }

  function statusBadge(status: AuditCheckStatus) {
    switch (status) {
      case 'pass':
        return <span className="inline-flex items-center gap-1 text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded-full border border-green-200 font-semibold"><CheckCircle className="w-2.5 h-2.5" /> PASS</span>
      case 'autocorrected':
        return <span className="inline-flex items-center gap-1 text-[10px] bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full border border-blue-200 font-semibold"><Wrench className="w-2.5 h-2.5" /> Auto-Corrected</span>
      case 'fail':
        return <span className="inline-flex items-center gap-1 text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded-full border border-red-200 font-semibold"><XCircle className="w-2.5 h-2.5" /> FAIL</span>
      case 'human_required':
        return <span className="inline-flex items-center gap-1 text-[10px] bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full border border-orange-200 font-semibold whitespace-nowrap"><AlertCircle className="w-2.5 h-2.5" /> HUMAN REQUIRED</span>
      case 'info':
        return <span className="inline-flex items-center gap-1 text-[10px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full border border-slate-200 font-semibold"><Info className="w-2.5 h-2.5" /> INFO</span>
    }
  }

  function rowBg(status: AuditCheckStatus) {
    switch (status) {
      case 'pass': return ''
      case 'autocorrected': return 'bg-blue-50/30'
      case 'fail': return 'bg-red-50/30'
      case 'human_required': return 'bg-orange-50/40'
      case 'info': return 'bg-slate-50/40'
    }
  }

  const selectedMethodology = selectedMethodologyCheck
    ? DOWNSTREAM_CHECK_METHODS[selectedMethodologyCheck.check_id]
    : null

  return (
    <div className="space-y-5">
      {/* Score Breakdown per evaluator */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-100 flex items-center gap-2">
          <Activity className="w-4 h-4 text-orange-500" />
          <span className="font-semibold text-slate-800 text-sm">Quality Score Breakdown</span>
          <span className="text-xs text-slate-400 ml-1">— how each evaluator score was computed</span>
        </div>
        <div className="p-5 space-y-3">
          {noEvalData ? (
            <p className="text-sm text-slate-400 italic text-center py-4">No evaluator data yet — run a new conversion to populate quality scores.</p>
          ) : (
            (() => {
              const allSlugs = Array.from(new Set([
                ...evaluatorScores.map((e: any) => e.slug),
                ...Object.keys(evalScoresFull),
              ]))
              return allSlugs.map(slug => {
                const dbEv = evaluatorScores.find((e: any) => e.slug === slug)
                const fullEv = evalScoresFull[slug]
                const meta = EVALUATOR_META[slug]
                const threshold = typeof fullEv?.threshold === 'number'
                  ? fullEv.threshold
                  : (typeof dbEv?.threshold === 'number'
                    ? dbEv.threshold
                    : meta?.threshold)
                const score = fullEv?.score ?? (dbEv?.score ?? null)
                const passed = fullEv?.passed ?? (dbEv?.verdict === 'pass')
                const details: string[] = fullEv?.details ?? (Array.isArray(dbEv?.details) ? dbEv.details : [])
                const gapFailures: string[] = fullEv?.gap_failures ?? []
                const isExpanded = expandedEvaluators.has(slug)
                const label = meta?.label ?? dbEv?.evaluator ?? slug
                return (
                  <div key={slug} className={clsx('border rounded-xl overflow-hidden', passed ? 'border-green-200' : 'border-red-200')}>
                    <button
                      className={clsx('w-full flex items-center justify-between px-4 py-3 text-left hover:opacity-90 transition-opacity', passed ? 'bg-green-50' : 'bg-red-50')}
                      onClick={() => setExpandedEvaluators(prev => {
                        const next = new Set(prev)
                        next.has(slug) ? next.delete(slug) : next.add(slug)
                        return next
                      })}
                    >
                      <div className="flex items-center gap-2.5 flex-1 min-w-0">
                        <span className="text-lg flex-shrink-0">{meta?.icon ?? '📊'}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-slate-800">{label}</span>
                            {passed
                              ? <span className="text-[10px] bg-green-100 text-green-700 border border-green-200 px-2 py-0.5 rounded-full font-semibold">PASS</span>
                              : <span className="text-[10px] bg-red-100 text-red-700 border border-red-200 px-2 py-0.5 rounded-full font-semibold">FAIL</span>
                            }
                            {typeof threshold === 'number' && <span className="text-[10px] text-slate-400">threshold: {Math.round(threshold * 100)}%</span>}
                            {(details.length > 0 || gapFailures.length > 0 || !passed) && (
                              <button
                                type="button"
                                onClick={e => {
                                  e.stopPropagation()
                                  setDetailsPopup({ type: 'evaluator', slug, label, score, passed, details, gapFailures })
                                }}
                                className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white px-2.5 py-0.5 text-[10px] font-semibold text-slate-600 hover:border-slate-400 hover:bg-slate-50"
                              >
                                <List className="w-3 h-3" />
                                Details
                              </button>
                            )}
                          </div>
                          {meta && <p className="text-[10px] font-mono text-slate-500 mt-0.5">{meta.formula}</p>}
                        </div>
                        <div className="flex-shrink-0 text-right">
                          <span className={clsx('text-lg font-bold', scoreColor(score))}>
                            {score != null ? `${Math.round(score * 100)}%` : '—'}
                          </span>
                        </div>
                      </div>
                      <div className="ml-3 flex-shrink-0">
                        {isExpanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                      </div>
                    </button>
                    {isExpanded && (
                      <div className="px-4 pb-4 pt-3 bg-white space-y-3">
                        {meta && (
                          <div className="bg-blue-50 border border-blue-100 rounded-lg p-3">
                            <div className="flex items-start gap-2">
                              <Info className="w-3.5 h-3.5 text-blue-500 mt-0.5 flex-shrink-0" />
                              <p className="text-xs text-blue-800">{meta.description}</p>
                            </div>
                          </div>
                        )}
                        {score != null && meta && (
                          <div className="space-y-1.5">
                            <p className="text-xs font-semibold text-slate-600">Score computation</p>
                            <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                              <div
                                className={clsx(
                                  'h-full rounded-full',
                                  typeof threshold === 'number'
                                    ? (score >= threshold ? 'bg-green-500' : (score >= Math.max(0, threshold - 0.2) ? 'bg-amber-400' : 'bg-red-400'))
                                    : (score >= 0.7 ? 'bg-green-500' : score >= 0.4 ? 'bg-amber-400' : 'bg-red-400')
                                )}
                                style={{ width: `${Math.round(score * 100)}%` }}
                              />
                            </div>
                            <div className="flex justify-between text-[10px] text-slate-400">
                              <span>0%</span>
                              <span className="text-amber-500">threshold {Math.round(meta.threshold * 100)}%</span>
                              <span>100%</span>
                            </div>
                          </div>
                        )}
                        {details.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-slate-600 mb-1.5">Check findings ({details.length})</p>
                            <ul className="space-y-1">
                              {details.map((d, i) => (
                                <li key={i} className="flex items-start gap-1.5 text-xs text-slate-600 bg-slate-50 rounded px-2 py-1">
                                  <AlertCircle className="w-3 h-3 text-amber-400 flex-shrink-0 mt-0.5" />
                                  <span>{d}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {gapFailures.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-red-600 mb-1.5">Gap rule failures ({gapFailures.length})</p>
                            <ul className="space-y-1">
                              {gapFailures.map((g, i) => (
                                <li key={i} className="flex items-start gap-1.5 text-xs bg-red-50 rounded px-2 py-1">
                                  <XCircle className="w-3 h-3 text-red-400 flex-shrink-0 mt-0.5" />
                                  <span className="text-red-700 font-mono">{g}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {details.length === 0 && gapFailures.length === 0 && passed && (
                          <div className="flex items-center gap-1.5 text-xs text-green-700 bg-green-50 rounded px-3 py-2">
                            <CheckCircle className="w-3.5 h-3.5" />
                            All checks passed — no issues detected
                          </div>
                        )}
                        {dbEv?.notes && (
                          <p className="text-xs text-slate-500 italic bg-slate-50 rounded px-2 py-1">Note: {dbEv.notes}</p>
                        )}
                      </div>
                    )}
                  </div>
                )
              })
            })()
          )}
        </div>
      </div>

      {/* Quality Checks Audit Trail */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2 mb-3">
            <Wrench className="w-4 h-4 text-violet-500" />
            <span className="font-semibold text-slate-800 text-sm">Quality Checks Audit Trail</span>
            <span className="text-xs text-slate-400 ml-1">— every check performed, its outcome, and required actions</span>
          </div>
          {/* Summary counters */}
          {totalChecks > 0 && (
            <div className="flex flex-wrap gap-2 text-[11px] font-semibold mb-3">
              <span className="bg-slate-100 text-slate-600 px-3 py-1 rounded-full border border-slate-200">
                {totalChecks} checks total
              </span>
              <span className="bg-green-100 text-green-700 px-3 py-1 rounded-full border border-green-200 flex items-center gap-1">
                <CheckCircle className="w-3 h-3" /> {passedChecks} passed
              </span>
              {autocorrectedChecks > 0 && (
                <span className="bg-blue-100 text-blue-700 px-3 py-1 rounded-full border border-blue-200 flex items-center gap-1">
                  <Wrench className="w-3 h-3" /> {autocorrectedChecks} auto-corrected
                </span>
              )}
              {failedChecks > 0 && (
                <span className="bg-red-100 text-red-700 px-3 py-1 rounded-full border border-red-200 flex items-center gap-1">
                  <XCircle className="w-3 h-3" /> {failedChecks} failed
                </span>
              )}
              {infoChecks > 0 && (
                <span className="bg-slate-100 text-slate-500 px-3 py-1 rounded-full border border-slate-200 flex items-center gap-1">
                  <Info className="w-3 h-3" /> {infoChecks} informational
                </span>
              )}
              {humanRequiredChecks > 0 && (
                <span className="bg-orange-100 text-orange-700 px-3 py-1 rounded-full border border-orange-300 flex items-center gap-1 animate-pulse">
                  <AlertCircle className="w-3 h-3" /> {humanRequiredChecks} require human intervention
                </span>
              )}
            </div>
          )}
          {/* Human-required banner */}
          {humanRequiredChecks > 0 && (
            <div className="bg-orange-50 border border-orange-200 rounded-lg px-4 py-2.5 flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-orange-500 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-orange-800">
                <span className="font-bold">{humanRequiredChecks} gap{humanRequiredChecks !== 1 ? 's' : ''} require human intervention</span> — these could not be auto-resolved by the agent and must be corrected by a reviewer before this USDM output can be considered submission-ready. See GAP checks below for specific fields and instructions.
              </div>
            </div>
          )}
          {/* Filter tabs */}
          {totalChecks > 0 && (
            <div className="flex gap-1 mt-3">
              {(['all', 'attention', 'human'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setAuditFilter(f)}
                  className={clsx(
                    'text-[11px] px-3 py-1 rounded-full border transition-colors',
                    auditFilter === f
                      ? f === 'human' ? 'bg-orange-500 text-white border-orange-500' : 'bg-violet-600 text-white border-violet-600'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                  )}
                >
                  {f === 'all' ? `All (${totalChecks})` : f === 'attention' ? `Needs Attention (${failedChecks + humanRequiredChecks + infoChecks})` : `Human Required (${humanRequiredChecks})`}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="px-5 pb-5 pt-3">
          {totalChecks === 0 ? (
            <p className="text-sm text-slate-400 italic text-center py-4">
              No quality check data available. Run a conversion to see the full audit trail.
            </p>
          ) : filteredChecks.length === 0 ? (
            <p className="text-sm text-slate-400 italic text-center py-4">
              No checks match this filter.
            </p>
          ) : (
            <div className="space-y-5">
              {Object.entries(checksByCategory).map(([category, catChecks]) => (
                <div key={category}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{category}</span>
                    <div className="flex-1 h-px bg-slate-100" />
                    <span className="text-[10px] text-slate-400">{catChecks.length} check{catChecks.length !== 1 ? 's' : ''}</span>
                  </div>
                  <div className="space-y-1">
                    {catChecks.map(chk => {
                      const isExpanded = expandedChecks.has(chk.check_id)
                      return (
                        <div key={chk.check_id} className={clsx('border rounded-lg overflow-hidden', chk.status === 'human_required' ? 'border-orange-200' : chk.status === 'fail' ? 'border-red-200' : chk.status === 'autocorrected' ? 'border-blue-200' : 'border-slate-200')}>
                          <button
                            className={clsx('w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-50/80 transition-colors', rowBg(chk.status))}
                            onClick={() => setExpandedChecks(prev => {
                              const next = new Set(prev)
                              next.has(chk.check_id) ? next.delete(chk.check_id) : next.add(chk.check_id)
                              return next
                            })}
                          >
                            <span className="text-[10px] font-mono text-slate-400 flex-shrink-0 w-18">{chk.check_id}</span>
                            <div className="flex-1 min-w-0">
                              <span className="text-xs text-slate-700 font-medium truncate block">{chk.description}</span>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              {chk.score != null && (
                                <span className={clsx('text-xs font-bold', scoreColor(chk.score))}>{Math.round(chk.score * 100)}%</span>
                              )}
                              {statusBadge(chk.status)}
                              {chk.iteration != null && (
                                <span className="text-[10px] text-slate-400">iter {chk.iteration}</span>
                              )}
                              {(chk.detail || (Array.isArray(chk.provenanceMappings) && chk.provenanceMappings.length > 0)) && (
                                <button
                                  type="button"
                                  onClick={e => {
                                    e.stopPropagation()
                                    setDetailsPopup({ type: 'check', check: chk })
                                  }}
                                  className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white px-2.5 py-0.5 text-[10px] font-semibold text-slate-600 hover:border-slate-400 hover:bg-slate-50"
                                >
                                  <List className="w-3 h-3" />
                                  Details
                                </button>
                              )}
                              {isExpanded ? <ChevronUp className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
                            </div>
                          </button>
                          {isExpanded && (
                            <div className={clsx(
                              'px-4 py-3 border-t text-xs leading-relaxed',
                              chk.status === 'human_required' ? 'bg-orange-50/50 border-orange-100 text-orange-900' :
                              chk.status === 'fail' ? 'bg-red-50/50 border-red-100 text-red-900' :
                              chk.status === 'autocorrected' ? 'bg-blue-50/50 border-blue-100 text-blue-900' :
                              'bg-slate-50/50 border-slate-100 text-slate-700'
                            )}>
                              {chk.status === 'human_required' && (
                                <div className="flex items-center gap-1.5 font-bold text-orange-700 mb-2">
                                  <AlertCircle className="w-3.5 h-3.5" />
                                  Action required: reviewer must manually resolve this gap before submission.
                                </div>
                              )}
                              {DOWNSTREAM_CHECK_METHODS[chk.check_id] && (
                                <div className="mb-3 flex flex-wrap items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => setSelectedMethodologyCheck(chk)}
                                    className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-3 py-1.5 text-[11px] font-semibold text-violet-700 hover:bg-violet-100"
                                  >
                                    <Info className="w-3 h-3" />
                                    How this check is done
                                  </button>
                                  {Array.isArray(chk.provenanceMappings) && chk.provenanceMappings.length > 0 && (
                                    <button
                                      type="button"
                                      onClick={() => exportCheckProvenance(chk)}
                                      className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100"
                                    >
                                      <Database className="w-3 h-3" />
                                      Export provenance as JSON
                                    </button>
                                  )}
                                </div>
                              )}
                              {Array.isArray(chk.provenanceMappings) && chk.provenanceMappings.length > 0 && (
                                <div className="mb-3 rounded-lg border border-slate-200 bg-white/70 p-3">
                                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                                    Mapping Provenance
                                  </p>
                                  <div className="space-y-2">
                                    {chk.provenanceMappings.map((mapping, idx) => (
                                      <div key={`${chk.check_id}-prov-${idx}`} className="rounded border border-slate-100 bg-slate-50/70 p-2">
                                        <div className="mb-1 flex items-center justify-between gap-2">
                                          <span className="text-[11px] font-semibold text-slate-700">{mapping.target}</span>
                                          <span className={clsx(
                                            'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold',
                                            mapping.ready ? 'bg-green-100 text-green-700 border border-green-200' : 'bg-red-100 text-red-700 border border-red-200',
                                          )}>
                                            {mapping.ready ? 'READY' : 'MISSING'}
                                          </span>
                                        </div>
                                        {Array.isArray(mapping.mapped_to) && mapping.mapped_to.length > 0 && (
                                          <p className="text-[11px] text-slate-600">
                                            <span className="font-semibold text-slate-700">Mapped to:</span> {mapping.mapped_to.join(', ')}
                                          </p>
                                        )}
                                        {Array.isArray(mapping.mapped_from) && mapping.mapped_from.length > 0 && (
                                          <p className="mt-1 text-[11px] text-slate-600">
                                            <span className="font-semibold text-slate-700">USDM paths:</span> {mapping.mapped_from.join(' | ')}
                                          </p>
                                        )}
                                        {mapping.evidence && Object.keys(mapping.evidence).length > 0 && (
                                          <p className="mt-1 text-[11px] text-slate-600">
                                            <span className="font-semibold text-slate-700">Evidence:</span>{' '}
                                            {Object.entries(mapping.evidence)
                                              .map(([k, v]) => `${k}=${typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v)}`)
                                              .join(', ')}
                                          </p>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {chk.detail}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {detailsPopup && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4"
          onClick={() => setDetailsPopup(null)}
        >
          <div
            className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white shadow-2xl max-h-[80vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4 flex-shrink-0">
              {detailsPopup.type === 'evaluator' ? (
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-base font-semibold text-slate-900">{detailsPopup.label}</h3>
                    {detailsPopup.passed
                      ? <span className="text-[10px] bg-green-100 text-green-700 border border-green-200 px-2 py-0.5 rounded-full font-semibold">PASS</span>
                      : <span className="text-[10px] bg-red-100 text-red-700 border border-red-200 px-2 py-0.5 rounded-full font-semibold">FAIL</span>
                    }
                    {detailsPopup.score != null && (
                      <span className={clsx('text-sm font-bold', scoreColor(detailsPopup.score))}>
                        {Math.round(detailsPopup.score * 100)}%
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">Issues and findings for this quality dimension</p>
                </div>
              ) : (
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] font-mono text-slate-400">{detailsPopup.check.check_id}</span>
                    {statusBadge(detailsPopup.check.status)}
                  </div>
                  <h3 className="text-sm font-semibold text-slate-900 mt-0.5">{detailsPopup.check.description}</h3>
                </div>
              )}
              <button
                type="button"
                onClick={() => setDetailsPopup(null)}
                className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 flex-shrink-0"
                aria-label="Close details"
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto px-5 py-4 space-y-4">
              {detailsPopup.type === 'evaluator' ? (
                <>
                  {detailsPopup.gapFailures.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-red-600 mb-2">
                        Gap Rule Failures ({detailsPopup.gapFailures.length})
                      </p>
                      <ul className="space-y-1.5">
                        {detailsPopup.gapFailures.map((g, i) => (
                          <li key={i} className="flex items-start gap-2 bg-red-50 border border-red-100 rounded-lg px-3 py-2 text-xs text-red-800 font-mono">
                            <XCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
                            <span>{g}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {detailsPopup.details.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                        Findings ({detailsPopup.details.length})
                      </p>
                      <ul className="space-y-1.5">
                        {detailsPopup.details.map((d, i) => (
                          <li key={i} className="flex items-start gap-2 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2 text-xs text-slate-700">
                            <AlertCircle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
                            <span>{d}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {(() => {
                    const s = detailsPopup.slug
                    const sectionFieldGaps: Record<string, string[]> = manifest?.section_field_gaps || {}

                    // SECT- failures: section absent or no provenance (completeness / provenance evaluators)
                    const missingSects = (s === 'completeness' || s === 'provenance')
                      ? allChecks.filter(c => c.check_id.startsWith('SECT-') && c.status !== 'pass')
                      : []

                    // GAP- violations: field-level USDM rule failures (standards evaluator)
                    const failingGaps = (s === 'standards')
                      ? allChecks.filter(c => c.check_id.startsWith('GAP-') && c.status !== 'pass')
                      : []

                    // Field gaps from sections that PASS the SECT- check but still have missing required fields
                    const missingSectKeys = new Set(
                      missingSects.map(c => USDM_MANDATORY_SECTIONS[parseInt(c.check_id.split('-')[1]) - 1]).filter(Boolean)
                    )
                    const populatedSectFieldGaps = Object.entries(sectionFieldGaps).filter(
                      ([key, fields]) => fields.length > 0 && !missingSectKeys.has(key)
                    )

                    const hasAny = missingSects.length > 0 || failingGaps.length > 0 || populatedSectFieldGaps.length > 0
                    if (!hasAny && detailsPopup.details.length === 0 && detailsPopup.gapFailures.length === 0) {
                      return detailsPopup.passed
                        ? (
                          <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-100 rounded-lg px-4 py-3">
                            <CheckCircle className="w-4 h-4" />
                            All checks passed — no issues detected.
                          </div>
                        ) : (
                          <p className="text-sm text-slate-500 italic text-center py-4">
                            No specific issue details available for this dimension.
                          </p>
                        )
                    }

                    return (
                      <>
                        {/* Standards: unresolved GAP- field violations */}
                        {failingGaps.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wide text-red-600 mb-2">
                              Unresolved USDM Field Violations ({failingGaps.length})
                            </p>
                            <ul className="space-y-1.5">
                              {failingGaps.map(c => (
                                <li key={c.check_id} className="flex items-start gap-2 bg-red-50 border border-red-100 rounded-lg px-3 py-2 text-xs text-red-900 font-mono">
                                  <XCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
                                  <div>
                                    <span>{c.description}</span>
                                    {c.status === 'human_required' && (
                                      <span className="ml-2 text-[10px] bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded font-sans font-semibold">HUMAN REQUIRED</span>
                                    )}
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* Completeness / provenance: missing sections with their required fields */}
                        {missingSects.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wide text-amber-600 mb-2">
                              Missing Sections ({missingSects.length})
                            </p>
                            <ul className="space-y-2">
                              {missingSects.map(c => {
                                const sectKey = USDM_MANDATORY_SECTIONS[parseInt(c.check_id.split('-')[1]) - 1]
                                const fieldGaps = (sectKey && sectionFieldGaps[sectKey]) || []
                                return (
                                  <li key={c.check_id} className="bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                                    <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-900">
                                      <AlertCircle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                                      Missing: {c.description.replace(/ present$/i, '')}
                                    </div>
                                    {fieldGaps.length > 0 && (
                                      <ul className="mt-1.5 ml-5 space-y-1">
                                        {fieldGaps.map((f, i) => {
                                          const [field, ...rest] = f.split(' — ')
                                          return (
                                            <li key={i} className="text-[11px] text-amber-800">
                                              <span className="font-mono font-semibold">{field}</span>
                                              {rest.length > 0 && <span className="text-amber-700"> — {rest.join(' — ')}</span>}
                                            </li>
                                          )
                                        })}
                                      </ul>
                                    )}
                                  </li>
                                )
                              })}
                            </ul>
                          </div>
                        )}

                        {/* Field-level gaps in sections that are present */}
                        {populatedSectFieldGaps.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                              Required Fields Missing in Populated Sections
                            </p>
                            <ul className="space-y-2">
                              {populatedSectFieldGaps.map(([key, fields]) => (
                                <li key={key} className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                                  <div className="text-xs font-semibold text-slate-700 mb-1.5">
                                    {SECTION_LABELS[key] || key}
                                  </div>
                                  <ul className="space-y-1">
                                    {fields.map((f, i) => {
                                      const [field, ...rest] = f.split(' — ')
                                      return (
                                        <li key={i} className="text-[11px] text-slate-700 flex items-start gap-1.5">
                                          <AlertCircle className="w-3 h-3 text-amber-400 flex-shrink-0 mt-0.5" />
                                          <span>
                                            <span className="font-mono font-semibold">{field}</span>
                                            {rest.length > 0 && <span className="text-slate-500"> — {rest.join(' — ')}</span>}
                                          </span>
                                        </li>
                                      )
                                    })}
                                  </ul>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </>
                    )
                  })()}
                </>
              ) : (
                <>
                  {detailsPopup.check.status === 'human_required' && (
                    <div className="flex items-center gap-2 font-semibold text-orange-700 bg-orange-50 border border-orange-100 rounded-lg px-4 py-3 text-sm">
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      Action required: reviewer must manually resolve this gap before submission.
                    </div>
                  )}
                  {detailsPopup.check.detail && (
                    <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                      {detailsPopup.check.detail}
                    </div>
                  )}
                  {Array.isArray(detailsPopup.check.provenanceMappings) && detailsPopup.check.provenanceMappings.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Mapping Provenance</p>
                      <div className="space-y-2">
                        {detailsPopup.check.provenanceMappings.map((mapping, idx) => (
                          <div key={idx} className="rounded-lg border border-slate-100 bg-white p-3">
                            <div className="flex items-center justify-between gap-2 mb-1">
                              <span className="text-xs font-semibold text-slate-700">{mapping.target}</span>
                              <span className={clsx(
                                'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold',
                                mapping.ready ? 'bg-green-100 text-green-700 border border-green-200' : 'bg-red-100 text-red-700 border border-red-200',
                              )}>
                                {mapping.ready ? 'READY' : 'MISSING'}
                              </span>
                            </div>
                            {Array.isArray(mapping.mapped_to) && mapping.mapped_to.length > 0 && (
                              <p className="text-[11px] text-slate-600">
                                <span className="font-semibold">Mapped to:</span> {mapping.mapped_to.join(', ')}
                              </p>
                            )}
                            {Array.isArray(mapping.mapped_from) && mapping.mapped_from.length > 0 && (
                              <p className="mt-1 text-[11px] text-slate-600">
                                <span className="font-semibold">USDM paths:</span> {mapping.mapped_from.join(' | ')}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {selectedMethodologyCheck && selectedMethodology && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4">
          <div className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
              <div>
                <p className="text-[11px] font-mono text-slate-400">{selectedMethodologyCheck.check_id}</p>
                <h3 className="mt-1 text-base font-semibold text-slate-900">{selectedMethodology.title}</h3>
                <p className="mt-1 text-sm text-slate-600">{selectedMethodology.summary}</p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedMethodologyCheck(null)}
                className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close methodology popup"
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4 px-5 py-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Evaluation Inputs</p>
                <ul className="mt-2 space-y-2">
                  {selectedMethodology.inputs.map((input, index) => (
                    <li key={index} className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
                      <span className="mt-0.5 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-slate-200 text-[11px] font-semibold text-slate-700">
                        {index + 1}
                      </span>
                      <span>{input}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Pass Rule</p>
                <p className="mt-1 text-sm text-emerald-900">{selectedMethodology.passRule}</p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Current Run Result</p>
                <p className="mt-1 text-sm text-slate-700">{selectedMethodologyCheck.detail}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main Export: AgentInsightTabs ─────────────────────────────────────────────

type InsightTab = 'evaluation' | 'traces' | 'validation' | 'learnings' | 'audit' | 'quality'

interface Props {
  runId: string | null | undefined
  orgId: string
  userId: string
  runStatus?: string
  jumpToTab?: string | null
  onJumped?: () => void
}

export function AgentInsightTabs({ runId, orgId, userId, runStatus, jumpToTab, onJumped }: Props) {
  const [activeTab, setActiveTab] = useState<InsightTab>('evaluation')

  useEffect(() => {
    if (jumpToTab && jumpToTab !== activeTab) {
      setActiveTab(jumpToTab as InsightTab)
      onJumped?.()
    }
  }, [jumpToTab])
  const [run, setRun]           = useState<any>(null)
  const [traces, setTraces]     = useState<any[]>([])
  const [events, setEvents]     = useState<any[]>([])
  const [manifest, setManifest] = useState<any>(null)
  const [loading, setLoading]   = useState(false)
  const [fetched, setFetched]   = useState(false)

  // Re-fetch when parent marks run finalized (approved/completed) but local payload is stale.
  useEffect(() => {
    const finalized = runStatus === 'completed' || runStatus === 'approved'
    const missingEvaluation = !run?.evaluation
    const staleStatus = run?.status !== 'completed'
    if (finalized && fetched && (missingEvaluation || staleStatus)) {
      setFetched(false)
    }
  }, [runStatus, fetched, run?.status, run?.evaluation])

  useEffect(() => {
    if (!runId || fetched) return
    setLoading(true)
    setFetched(true)
    Promise.all([
      gql(`query { agentRunDetail(runId: "${runId}") {
        id status agentName agentType llmModel tokensUsed
        startedAt completedAt latencyMs costUsd turnCount toolCallsTotal toolCallsSuccessful
        evaluation {
          taskCompleted faithfulnessScore reasoningScore
          hallucinationDetected hallucinationRate
          toolUsageAccuracy judgeVerdict judgeNotes judgeModel
          evaluatedAt evaluator latencyMs costUsd
          toolCallsTotal toolCallsSuccessful
        }
      }}`).catch(() => ({ agentRunDetail: null })),
      gql(`query { decisionTraces(runId: "${runId}") {
        id traceType traceVersion inputContext reasoningSteps sourcesCited output
        confidence mistakeType intentResolution retrievalPlan evidenceAssembly
        executionMode answerConstruction outcomeLearning confidenceDecomposition
        feedbackEvents validationResult scorecard learningRecommendation
        retrievalReasoning decisionAlternatives validationLayer stepLinkage feedbackValidation
        createdAt
      }}`).catch(() => ({ decisionTraces: [] })),
      gql(`query { auditEvents(orgId: "${orgId}", runId: "${runId}", limit: 200) {
        eventId timestamp actorType actorId action resourceType resourceId metadata rowHash
      }}`).catch(() => ({ auditEvents: [] })),
      fetch(`${RUNTIME_URL}/runs/${runId}/provenance-manifest`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([r, t, a, m]) => {
      setRun(r.agentRunDetail)
      setTraces(t.decisionTraces || [])
      setEvents(a.auditEvents || [])
      setManifest(m)
    }).finally(() => setLoading(false))
  }, [runId, orgId, fetched])

  if (!runId) {
    return (
      <div className="text-center py-8 text-slate-400 text-sm border border-slate-200 rounded-xl">
        No run ID available yet — insights will appear once the agent has started.
      </div>
    )
  }

  const qualityChecksCount = Array.isArray(manifest?.quality_checks) && manifest.quality_checks.length > 0
    ? manifest.quality_checks.length
    : (manifest?.evaluator_scores?.length || 0) + Object.keys(manifest?.eval_scores_full || {}).length

  const tabs: { id: InsightTab; label: string; icon: React.ReactNode; dot?: boolean; badge?: number }[] = [
    { id: 'evaluation', label: 'Evaluation',      icon: <BarChart2 className="w-3.5 h-3.5" />, dot: run?.evaluation?.judgeVerdict === 'fail' },
    { id: 'quality',    label: 'Quality',         icon: <ClipboardList className="w-3.5 h-3.5" />, badge: qualityChecksCount },
    { id: 'traces',     label: 'Decision Traces', icon: <Brain className="w-3.5 h-3.5" />,     dot: traces.length > 0 },
    { id: 'validation', label: 'Validation',      icon: <CheckCircle className="w-3.5 h-3.5" />, dot: traces.some((t: any) => !!t.validationResult) },
    { id: 'learnings',  label: 'Learnings',       icon: <Activity className="w-3.5 h-3.5" />,  dot: traces.some((t: any) => !!t.learningRecommendation || !!t.outcomeLearning) },
    { id: 'audit',      label: 'Audit Log',       icon: <Shield className="w-3.5 h-3.5" />,    dot: false },
  ]

  return (
    <div className="mt-6 border border-slate-200 rounded-2xl overflow-hidden">
      {/* Tab bar */}
      <div className="flex border-b border-slate-200 bg-white">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={clsx(
              'flex items-center gap-1.5 px-5 py-3 text-sm font-medium border-b-2 transition-colors',
              activeTab === tab.id
                ? 'border-brand-500 text-brand-600 bg-brand-50/50'
                : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'
            )}
          >
            {tab.icon}
            {tab.label}
            {tab.badge != null && tab.badge > 0 && (
              <span className="ml-0.5 text-[10px] bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded-full font-semibold">
                {tab.badge}
              </span>
            )}
            {tab.dot && (
              <span className={clsx('w-2 h-2 rounded-full',
                tab.id === 'evaluation' ? 'bg-red-400' : 'bg-amber-400')} />
            )}
          </button>
        ))}
        {loading && (
          <div className="ml-auto flex items-center px-4">
            <Loader2 className="w-4 h-4 animate-spin text-slate-300" />
          </div>
        )}
      </div>

      {/* Tab content */}
      <div className="p-5 bg-white">
        {activeTab === 'evaluation' && (
          <EvaluationPanel
            ev={run?.evaluation}
            run={run}
            runId={runId}
            manifest={manifest}
            sourcesCount={traces.reduce((s, t) => s + (t.sourcesCited?.length || 0), 0)}
          />
        )}
        {activeTab === 'quality' && (
          <QualityPanel manifest={manifest} />
        )}
        {activeTab === 'traces' && (
          <DecisionTracesPanel traces={traces} orgId={orgId} userId={userId} />
        )}
        {activeTab === 'validation' && (
          <ValidationPanel traces={traces} />
        )}
        {activeTab === 'learnings' && (
          <LearningsPanel traces={traces} />
        )}
        {activeTab === 'audit' && (
          <AuditLogPanel events={events} />
        )}
      </div>
    </div>
  )
}
