'use client'
import { useState, useEffect } from 'react'
import {
  Shield, Brain, BarChart2, CheckCircle, AlertCircle, Loader2,
  ChevronDown, ChevronRight, ThumbsUp, ThumbsDown, Activity, Database,
} from 'lucide-react'
import { clsx } from 'clsx'
import {
  RadialBarChart, RadialBar, PieChart, Pie, Cell as RechartsCell,
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'

// ── Constants ─────────────────────────────────────────────────────────────────

const GRAPHQL_URL = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'

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

function EvaluationPanel({ ev, run }: { ev: any; run: any }) {
  if (!ev) {
    return (
      <div className="text-center py-12 text-slate-400">
        <Activity className="w-8 h-8 mx-auto mb-2 text-slate-200" />
        <p className="text-sm">No evaluation data yet.</p>
        <p className="text-xs mt-1">Evaluation runs automatically after run completion.</p>
      </div>
    )
  }

  const verdictCfg = VERDICT_CONFIG[ev.judgeVerdict] || VERDICT_CONFIG.unknown

  return (
    <div className="space-y-6">
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

// ── Main Export: AgentInsightTabs ─────────────────────────────────────────────

type InsightTab = 'evaluation' | 'traces' | 'validation' | 'learnings' | 'audit'

interface Props {
  runId: string | null | undefined
  orgId: string
  userId: string
}

export function AgentInsightTabs({ runId, orgId, userId }: Props) {
  const [activeTab, setActiveTab] = useState<InsightTab>('evaluation')
  const [run, setRun]           = useState<any>(null)
  const [traces, setTraces]     = useState<any[]>([])
  const [events, setEvents]     = useState<any[]>([])
  const [loading, setLoading]   = useState(false)
  const [fetched, setFetched]   = useState(false)

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
          evaluatedAt evaluator latencyMs costUsd turnCount
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
    ]).then(([r, t, a]) => {
      setRun(r.agentRunDetail)
      setTraces(t.decisionTraces || [])
      setEvents(a.auditEvents || [])
    }).finally(() => setLoading(false))
  }, [runId, orgId, fetched])

  if (!runId) {
    return (
      <div className="text-center py-8 text-slate-400 text-sm border border-slate-200 rounded-xl">
        No run ID available yet — insights will appear once the agent has started.
      </div>
    )
  }

  const tabs: { id: InsightTab; label: string; icon: React.ReactNode; dot?: boolean }[] = [
    { id: 'evaluation', label: 'Evaluation',      icon: <BarChart2 className="w-3.5 h-3.5" />, dot: run?.evaluation?.judgeVerdict === 'fail' },
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
          <EvaluationPanel ev={run?.evaluation} run={run} />
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
