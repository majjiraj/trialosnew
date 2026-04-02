'use client'
import { useState, useEffect } from 'react'
import { clsx } from 'clsx'
import {
  ChevronDown, ChevronRight, FileText, Brain, Star, ThumbsUp, ThumbsDown, AlertCircle, GitBranch,
  User, ArrowRight, CheckCircle2, Edit3, PlusCircle, MinusCircle, Database
} from 'lucide-react'
import { toast } from 'sonner'

interface PerMappingEntry {
  domain: string
  sdtm_variable: string
  source_column: string
  source_file: string
  mapping_method: string
  confidence: number
  derivation_type: string
  derivation_rule: string
  reasoning: string
  // HITL fields
  type?: string
  changes?: Record<string, { before: string; after: string }>
  actor?: string
  description?: string
}

interface DomainFileReason {
  domain: string
  source_file: string
  columns_contributed: number
  reason: string
}

interface ReasoningStep {
  step: number
  thought: string
  tool_used?: string
  action?: string
  result_count?: number
  per_mapping?: PerMappingEntry[]
  domain?: string
  source_column?: string
  sdtm_variable?: string
  changes?: Record<string, { before: string; after: string }>
  actor?: string
}

interface DecisionTrace {
  id: string
  trace_type: string
  input_context: Record<string, unknown>
  reasoning_steps: ReasoningStep[]
  retrieval_reasoning?: {
    domain_to_file_mapping?: DomainFileReason[]
    per_mapping_decisions?: PerMappingEntry[]
    selected_domains?: string[]
    reason?: string
    domain_file_reasoning?: DomainFileReason[]
  }
  sources_cited: { doc_name: string; doc_type: string; chunk_id: string; score: number; section?: string; excerpt?: string }[]
  output: Record<string, unknown>
  confidence: number
  created_at: string
}

const CONTEXT_GRAPH_URL = process.env.NEXT_PUBLIC_CONTEXT_GRAPH_URL || 'http://localhost:8008'
const ORG_ID = '00000000-0000-0000-0000-000000000001'

function MappingMethodBadge({ method }: { method: string }) {
  return (
    <span className={clsx('text-[10px] px-1.5 py-0.5 rounded font-semibold',
      method === 'exact_name_match'
        ? 'bg-green-100 text-green-700'
        : 'bg-blue-100 text-blue-700'
    )}>
      {method === 'exact_name_match' ? '⚡ Exact Match' : '🤖 LLM Mapped'}
    </span>
  )
}

function PerMappingTable({ entries, title }: { entries: PerMappingEntry[]; title: string }) {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? entries : entries.slice(0, 5)
  return (
    <div className="mt-2 border border-slate-200 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-slate-50 border-b border-slate-200">
        <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1">
          <Database className="w-3 h-3" /> {title} ({entries.length} mappings)
        </span>
        {entries.length > 5 && (
          <button onClick={() => setExpanded(e => !e)} className="text-[10px] text-blue-500 hover:underline">
            {expanded ? 'Show less' : `Show all ${entries.length}`}
          </button>
        )}
      </div>
      <table className="w-full text-[10px]">
        <thead className="bg-slate-50 border-b border-slate-200">
          <tr>
            <th className="px-2 py-1 text-left text-slate-500">Source Column</th>
            <th className="px-2 py-1 text-left text-slate-500">Source File</th>
            <th className="px-1 py-1 text-slate-400">→</th>
            <th className="px-2 py-1 text-left text-slate-500">SDTM Variable</th>
            <th className="px-2 py-1 text-left text-slate-500">Domain</th>
            <th className="px-2 py-1 text-left text-slate-500">Method</th>
            <th className="px-2 py-1 text-left text-slate-500">Conf</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((m, i) => (
            <tr key={i} className="border-b border-slate-100 hover:bg-slate-50 group">
              <td className="px-2 py-1 font-mono text-slate-700">{m.source_column}</td>
              <td className="px-2 py-1 text-slate-400 truncate max-w-[100px]" title={m.source_file}>{m.source_file}</td>
              <td className="px-1 py-1 text-slate-300">→</td>
              <td className="px-2 py-1 font-mono font-semibold text-purple-700">{m.sdtm_variable}</td>
              <td className="px-2 py-1 text-slate-500">{m.domain}</td>
              <td className="px-2 py-1"><MappingMethodBadge method={m.mapping_method} /></td>
              <td className="px-2 py-1 text-slate-500">{m.confidence}%</td>
            </tr>
          ))}
          {shown.map((m, i) => m.reasoning ? (
            <tr key={`r-${i}`} className="border-b border-dashed border-slate-100 bg-slate-50/50">
              <td colSpan={7} className="px-2 py-1 text-[10px] text-slate-400 italic">
                ↳ {m.reasoning}
              </td>
            </tr>
          ) : null)}
        </tbody>
      </table>
    </div>
  )
}

function HITLChangesPanel({ steps }: { steps: ReasoningStep[] }) {
  const modifications = steps.filter(s => s.action && ['mapping_added','mapping_changed','mapping_removed','endorsement'].includes(s.action))
  if (!modifications.length) return null
  return (
    <div className="mt-2 space-y-1">
      {modifications.map((m, i) => (
        <div key={i} className={clsx('flex items-start gap-2 px-3 py-2 rounded-lg text-xs border', {
          'bg-green-50 border-green-200 text-green-800': m.action === 'mapping_added',
          'bg-amber-50 border-amber-200 text-amber-800': m.action === 'mapping_changed',
          'bg-red-50 border-red-200 text-red-800': m.action === 'mapping_removed',
          'bg-blue-50 border-blue-200 text-blue-800': m.action === 'endorsement',
        })}>
          {m.action === 'mapping_added' && <PlusCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
          {m.action === 'mapping_changed' && <Edit3 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
          {m.action === 'mapping_removed' && <MinusCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
          {m.action === 'endorsement' && <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />}
          <div className="flex-1">
            <span className="font-medium">{m.thought}</span>
            {m.changes && Object.entries(m.changes).map(([field, chg]) => (
              <div key={field} className="mt-1 flex items-center gap-1 text-[10px]">
                <span className="text-slate-500">{field}:</span>
                <span className="line-through opacity-60">{chg.before}</span>
                <ArrowRight className="w-2.5 h-2.5" />
                <span className="font-semibold">{chg.after}</span>
              </div>
            ))}
            {m.actor && <div className="text-[10px] mt-0.5 opacity-70 flex items-center gap-1"><User className="w-2.5 h-2.5" /> {m.actor}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}

function TraceCard({ trace }: { trace: DecisionTrace }) {
  const [open, setOpen] = useState(false)
  const [feedbackSent, setFeedbackSent] = useState(false)

  const sendFeedback = async (type: 'endorsement' | 'rejection' | 'rating', value: Record<string, unknown>) => {
    try {
      await fetch(`${CONTEXT_GRAPH_URL}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision_trace_id: trace.id,
          org_id: ORG_ID,
          feedback_type: type,
          feedback_value: value,
          submitted_by: '00000000-0000-0000-0000-000000000002',
        }),
      })
      setFeedbackSent(true)
      toast.success('Feedback recorded — context quality will improve')
    } catch {
      toast.error('Failed to send feedback')
    }
  }

  const typeColor: Record<string, string> = {
    tool_call:   'text-blue-600 bg-blue-50',
    reasoning:   'text-purple-600 bg-purple-50',
    synthesis:   'text-amber-600 bg-amber-50',
    output:      'text-green-600 bg-green-50',
    hitl_review: 'text-orange-600 bg-orange-50',
  }

  const isHITL = trace.trace_type === 'hitl_review'
  const domainFileMapping = trace.retrieval_reasoning?.domain_to_file_mapping || trace.retrieval_reasoning?.domain_file_reasoning || []

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 bg-white hover:bg-slate-50 transition-colors text-left"
      >
        {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
        <span className={clsx('px-2 py-0.5 rounded text-xs font-semibold capitalize', typeColor[trace.trace_type] || 'text-slate-600 bg-slate-100')}>
          {isHITL ? '👤 HITL Review' : trace.trace_type.replace('_', ' ')}
        </span>
        <span className="text-sm text-slate-600 flex-1 truncate">
          {isHITL
            ? `Human review by ${trace.input_context?.actor || 'reviewer'} — ${String(trace.output?.modification_count || 0)} change(s)`
            : String(trace.input_context?.query || trace.input_context?.tool || trace.input_context?.step_name || 'Decision').slice(0, 60)
          }
        </span>
        <div className="flex items-center gap-2 flex-shrink-0">
          {trace.sources_cited?.length > 0 && (
            <span className="flex items-center gap-1 text-xs text-slate-400">
              <FileText className="w-3 h-3" /> {trace.sources_cited.length} src
            </span>
          )}
          <span className="text-xs text-slate-400">
            {Math.round((trace.confidence || 1) * 100)}% conf
          </span>
          <span className="text-xs text-slate-300">
            {new Date(trace.created_at).toLocaleTimeString()}
          </span>
        </div>
      </button>

      {open && (
        <div className="border-t border-slate-100 bg-slate-50 p-4 space-y-4">

          {/* HITL changes */}
          {isHITL && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-1">
                <User className="w-3.5 h-3.5" /> Human Modifications
              </p>
              <HITLChangesPanel steps={trace.reasoning_steps} />
            </div>
          )}

          {/* Domain → File reasoning */}
          {domainFileMapping.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-1">
                <Database className="w-3.5 h-3.5" /> Domain → Source File Mapping Rationale
              </p>
              <div className="space-y-1">
                {domainFileMapping.map((dfr, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs px-3 py-2 bg-white border border-slate-200 rounded-lg">
                    <span className="font-semibold text-purple-700 w-8 flex-shrink-0">{dfr.domain}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-slate-300 flex-shrink-0 mt-0.5" />
                    <span className="font-mono text-slate-600 truncate flex-shrink-0 max-w-[140px]" title={dfr.source_file}>{dfr.source_file}</span>
                    <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded flex-shrink-0">{dfr.columns_contributed} cols</span>
                    <span className="text-slate-400 text-[10px] italic">{dfr.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Reasoning steps */}
          {trace.reasoning_steps?.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-1">
                <Brain className="w-3.5 h-3.5" /> Reasoning Steps
              </p>
              <div className="space-y-3">
                {trace.reasoning_steps.map((step, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="w-5 h-5 rounded-full bg-slate-200 text-slate-500 text-xs font-semibold flex items-center justify-center flex-shrink-0 mt-0.5">
                      {step.step || i + 1}
                    </span>
                    <div className="flex-1">
                      <p className="text-xs text-slate-700">{step.thought}</p>
                      {step.tool_used && (
                        <span className="text-[10px] font-mono text-slate-400 mt-0.5 block">
                          Tool: {step.tool_used}{step.result_count !== undefined ? ` → ${step.result_count} results` : ''}
                        </span>
                      )}
                      {/* Per-mapping table inline for exact-match and LLM steps */}
                      {step.per_mapping && step.per_mapping.length > 0 && (
                        <PerMappingTable
                          entries={step.per_mapping}
                          title={step.action === 'exact_match_pre_mapping' ? 'Exact-Match Mappings' : 'LLM-Generated Mappings'}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Sources cited */}
          {trace.sources_cited?.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-1">
                <FileText className="w-3.5 h-3.5" /> Sources Cited
              </p>
              <div className="space-y-2">
                {trace.sources_cited.slice(0, 5).map((src, i) => (
                  <div key={i} className="bg-white border border-slate-200 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-slate-700 truncate">{src.doc_name}</span>
                      <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                        <span className="text-[10px] px-1.5 py-0.5 bg-slate-100 rounded text-slate-500 font-mono">{src.doc_type}</span>
                        <span className="text-[10px] text-slate-400">{Math.round((src.score || 0) * 100)}%</span>
                      </div>
                    </div>
                    {src.section && <p className="text-[10px] text-blue-500 mb-1">§ {src.section}</p>}
                    {src.excerpt && (
                      <p className="text-xs text-slate-500 line-clamp-2 italic">"{src.excerpt}"</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Output summary */}
          {trace.output && Object.keys(trace.output).length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Output</p>
              <pre className="text-[10px] text-slate-600 bg-white border border-slate-200 rounded-lg p-2 overflow-x-auto">
                {JSON.stringify(trace.output, null, 2).slice(0, 800)}
              </pre>
            </div>
          )}

          {/* Feedback */}
          {!feedbackSent ? (
            <div className="flex items-center gap-2 pt-1">
              <span className="text-xs text-slate-400">Was this useful?</span>
              <button
                onClick={() => sendFeedback('endorsement', { reason: 'helpful' })}
                className="flex items-center gap-1 px-2 py-1 text-xs text-green-600 bg-green-50 hover:bg-green-100 rounded-md transition-colors"
              >
                <ThumbsUp className="w-3 h-3" /> Yes
              </button>
              <button
                onClick={() => sendFeedback('rejection', { reason: 'not_helpful' })}
                className="flex items-center gap-1 px-2 py-1 text-xs text-red-600 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
              >
                <ThumbsDown className="w-3 h-3" /> No
              </button>
              {[4, 5].map(rating => (
                <button
                  key={rating}
                  onClick={() => sendFeedback('rating', { rating })}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-amber-600 bg-amber-50 hover:bg-amber-100 rounded-md"
                >
                  <Star className="w-3 h-3" /> {rating}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-green-600 flex items-center gap-1">
              <ThumbsUp className="w-3 h-3" /> Feedback recorded
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export function DecisionTracePanel({ runId }: { runId: string }) {
  const [traces, setTraces] = useState<DecisionTrace[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!runId) return
    setLoading(true)
    fetch(`${CONTEXT_GRAPH_URL}/traces/${runId}`)
      .then(r => r.json())
      .then(data => { setTraces(data.traces || []); setLoading(false) })
      .catch(() => { setError('Could not load decision traces'); setLoading(false) })
  }, [runId])

  if (loading) return <div className="text-sm text-slate-400 p-4">Loading decision traces…</div>
  if (error) return (
    <div className="flex items-center gap-2 text-sm text-slate-400 p-4">
      <AlertCircle className="w-4 h-4" /> {error}
    </div>
  )
  if (traces.length === 0) return (
    <div className="text-sm text-slate-400 p-4 text-center">No decision traces for this run</div>
  )

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <GitBranch className="w-4 h-4 text-slate-400" />
        <h3 className="text-sm font-semibold text-slate-700">Decision Traces</h3>
        <span className="text-xs text-slate-400">({traces.length} steps)</span>
      </div>
      <p className="text-xs text-slate-400">
        Every reasoning step, tool call, source cited, and human review — for full reproducibility and auditability.
      </p>
      {traces.map(trace => <TraceCard key={trace.id} trace={trace} />)}
    </div>
  )
}

