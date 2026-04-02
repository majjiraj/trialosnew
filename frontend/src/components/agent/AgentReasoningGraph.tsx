'use client'

import React, { useEffect, useState, useCallback } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  MarkerType,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Bot, GitBranch, BarChart2, MessageSquare, Search,
  Zap, FileText, Database, Loader2, X, ChevronRight,
  Shield, AlertTriangle, Download, Filter, ChevronDown,
  Copy, CheckCheck, Link2, Target, Layers, BookOpen,
  Activity, Clock, User, Hash, AlertCircle,
} from 'lucide-react'

const CONTEXT_GRAPH_URL =
  process.env.NEXT_PUBLIC_CONTEXT_GRAPH_URL || 'http://localhost:8008'

// ── Node type → visual style ──────────────────────────────────────────────────

const NODE_META: Record<string, {
  border: string; bg: string; selectedBorder: string
  icon: React.ElementType; iconColor: string; label: string
}> = {
  agent_run:        { border: 'border-brand-500',  bg: 'bg-brand-50',   selectedBorder: 'border-brand-700',   icon: Bot,           iconColor: 'text-brand-500',  label: 'Agent Run' },
  decision_trace:   { border: 'border-indigo-500', bg: 'bg-indigo-50',  selectedBorder: 'border-indigo-700',  icon: GitBranch,     iconColor: 'text-indigo-500', label: 'Decision' },
  score:            { border: 'border-green-500',  bg: 'bg-green-50',   selectedBorder: 'border-green-700',   icon: BarChart2,     iconColor: 'text-green-500',  label: 'Score' },
  feedback:         { border: 'border-amber-500',  bg: 'bg-amber-50',   selectedBorder: 'border-amber-700',   icon: MessageSquare, iconColor: 'text-amber-500',  label: 'Feedback' },
  retrieval_recipe: { border: 'border-purple-500', bg: 'bg-purple-50',  selectedBorder: 'border-purple-700',  icon: Search,        iconColor: 'text-purple-500', label: 'Retrieval' },
  skill_invocation: { border: 'border-teal-500',   bg: 'bg-teal-50',    selectedBorder: 'border-teal-700',    icon: Zap,           iconColor: 'text-teal-500',   label: 'Skill' },
  prompt_template:  { border: 'border-slate-500',  bg: 'bg-slate-50',   selectedBorder: 'border-slate-700',   icon: FileText,      iconColor: 'text-slate-500',  label: 'Template' },
  chunk:            { border: 'border-slate-300',  bg: 'bg-white',      selectedBorder: 'border-slate-500',   icon: Database,      iconColor: 'text-slate-400',  label: 'Chunk' },
}

const EDGE_COLOR: Record<string, string> = {
  HAS_DECISION:     '#6366f1',
  HAS_SCORE:        '#22c55e',
  HAS_FEEDBACK:     '#f59e0b',
  USED_RECIPE:      '#a855f7',
  INVOKED_SKILL:    '#14b8a6',
  USES_TEMPLATE:    '#64748b',
  CORRECTS:         '#ef4444',
  USED_IN_DECISION: '#3b82f6',
}

// ── Mistake type badge config ─────────────────────────────────────────────────

const MISTAKE_BADGE: Record<string, { label: string; cls: string }> = {
  hallucination:    { label: '⚠ Hallucination',    cls: 'bg-red-100 text-red-700 border border-red-200' },
  wrong_source:     { label: '⚠ Wrong Source',      cls: 'bg-orange-100 text-orange-700 border border-orange-200' },
  scope_violation:  { label: '⚠ Scope Violation',   cls: 'bg-yellow-100 text-yellow-700 border border-yellow-200' },
}

const AUDIT_GRADE_CLS: Record<string, string> = {
  high:   'bg-green-100 text-green-700',
  medium: 'bg-amber-100 text-amber-700',
  low:    'bg-red-100 text-red-700',
}

// ── Custom node renderer ──────────────────────────────────────────────────────

function GraphNode({ data }: { data: any }) {
  const meta = NODE_META[data.nodeType] || NODE_META.decision_trace
  const Icon = meta.icon
  const isSelected = data.selected
  const md = data.metadata || {}
  const mistakeBadge = md.mistake_type ? MISTAKE_BADGE[md.mistake_type] : null
  const auditGrade = md.audit_evidence?.audit_grade || md.audit_grade
  return (
    <div
      className={`border-2 rounded-lg px-3 py-2 text-xs shadow-sm min-w-[130px] max-w-[190px] cursor-pointer transition-shadow
        ${isSelected ? `${meta.selectedBorder} shadow-md ring-2 ring-offset-1 ring-opacity-50` : meta.border} ${meta.bg}`}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <Icon size={12} className={meta.iconColor} />
        <span className={`font-semibold uppercase tracking-wide text-[10px] ${meta.iconColor}`}>
          {meta.label}
        </span>
        {isSelected && <ChevronRight size={10} className="ml-auto text-slate-400" />}
      </div>
      <div className="text-slate-700 truncate font-medium">{data.label}</div>
      {md.confidence != null && (
        <div className="text-slate-500 text-[10px] mt-0.5">
          conf: {(md.confidence * 100).toFixed(0)}%
        </div>
      )}
      {md.judge_verdict && (
        <div className="text-slate-500 text-[10px] mt-0.5">
          verdict: {md.judge_verdict}
        </div>
      )}
      {md.feedback_type && (
        <div className="text-slate-500 text-[10px] mt-0.5">
          type: {md.feedback_type}
        </div>
      )}
      {/* Audit grade chip */}
      {auditGrade && (
        <span className={`inline-block mt-1 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase ${AUDIT_GRADE_CLS[auditGrade.toLowerCase()] || 'bg-slate-100 text-slate-500'}`}>
          {auditGrade} audit
        </span>
      )}
      {/* Mistake type warning */}
      {mistakeBadge && (
        <div className={`mt-1 px-1.5 py-0.5 rounded text-[9px] font-semibold ${mistakeBadge.cls}`}>
          {mistakeBadge.label}
        </div>
      )}
      {/* Trace version */}
      {md.trace_version != null && (
        <div className="text-[9px] text-slate-400 mt-0.5">v{md.trace_version}</div>
      )}
    </div>
  )
}

const nodeTypes = { graphCard: GraphNode }

// ── Column-based layout helper ────────────────────────────────────────────────

const TYPE_COLUMN: Record<string, number> = {
  agent_run: 0,
  decision_trace: 1,
  retrieval_recipe: 1,
  skill_invocation: 2,
  score: 2,
  feedback: 2,
  prompt_template: 3,
  chunk: 3,
}
const COL_X = [60, 280, 500, 720]
const ROW_H = 120

function layoutNodes(rawNodes: any[]) {
  const colCounters: Record<number, number> = {}
  return rawNodes.map((n) => {
    const col = TYPE_COLUMN[n.node_type] ?? 1
    const row = colCounters[col] ?? 0
    colCounters[col] = row + 1
    return {
      id: n.id,
      type: 'graphCard',
      position: { x: COL_X[col] ?? 280, y: 60 + row * ROW_H },
      data: {
        nodeType: n.node_type,
        label: n.label || n.node_type,
        metadata: n.metadata || {},
        importance: n.importance ?? 1,
        selected: false,
      },
    }
  })
}

function buildEdges(rawEdges: any[]) {
  return rawEdges.map((e, i) => ({
    id: `e-${i}-${e.source}-${e.target}`,
    source: e.source,
    target: e.target,
    label: e.type,
    style: { stroke: EDGE_COLOR[e.type] || '#94a3b8', strokeWidth: 1.5 },
    markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLOR[e.type] || '#94a3b8' },
    labelStyle: { fontSize: 9, fill: '#64748b' },
    labelBgStyle: { fill: '#f8fafc' },
  }))
}

// ── Detail panel helpers ──────────────────────────────────────────────────────

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div>
      <div className="text-[10px] text-slate-400 uppercase tracking-wide font-medium mb-0.5">{label}</div>
      <div className="text-xs text-slate-700 bg-slate-50 rounded p-2 break-words whitespace-pre-wrap">
        {typeof value === 'object' && !React.isValidElement(value)
          ? JSON.stringify(value, null, 2)
          : value}
      </div>
    </div>
  )
}

function ConfidenceBar({ value, label = 'Confidence' }: { value: number; label?: string }) {
  const pct = Math.round(value * 100)
  const color = pct >= 75 ? 'bg-green-500' : pct >= 50 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div>
      <div className="text-[10px] text-slate-400 uppercase tracking-wide font-medium mb-0.5">{label}</div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-2 bg-slate-200 rounded-full overflow-hidden">
          <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="text-xs font-medium text-slate-600 w-8 text-right">{pct}%</span>
      </div>
    </div>
  )
}

function VerdictBadge({ verdict }: { verdict: string }) {
  const color = verdict === 'pass' ? 'bg-green-100 text-green-700'
    : verdict === 'partial' ? 'bg-amber-100 text-amber-700'
    : verdict === 'fail' ? 'bg-red-100 text-red-700'
    : 'bg-slate-100 text-slate-500'
  return <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${color}`}>{verdict}</span>
}

function CopyableHash({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(hash).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="flex items-start gap-1.5 bg-slate-50 rounded p-2">
      <span className="text-[10px] font-mono text-slate-600 break-all flex-1">{hash}</span>
      <button onClick={copy} className="flex-shrink-0 mt-0.5 hover:text-brand-600 text-slate-400 transition-colors">
        {copied ? <CheckCheck size={11} className="text-green-500" /> : <Copy size={11} />}
      </button>
    </div>
  )
}

function SectionHeader({ icon, title, color = 'text-slate-500' }: { icon: React.ReactNode; title: string; color?: string }) {
  return (
    <div className={`flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider ${color} mt-3 mb-1.5 pb-1 border-b border-slate-100`}>
      {icon}
      {title}
    </div>
  )
}

function CollapsibleSection({ title, icon, color, defaultOpen = false, children }: {
  title: string; icon: React.ReactNode; color?: string; defaultOpen?: boolean; children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border border-slate-100 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 px-3 py-2 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
      >
        <span className={color || 'text-slate-500'}>{icon}</span>
        <span className={`text-[10px] font-semibold uppercase tracking-wide flex-1 ${color || 'text-slate-600'}`}>{title}</span>
        {open ? <ChevronDown size={11} className="text-slate-400" /> : <ChevronRight size={11} className="text-slate-400" />}
      </button>
      {open && <div className="px-3 py-2 space-y-2">{children}</div>}
    </div>
  )
}

// ── Audit & Compliance section ────────────────────────────────────────────────

function AuditComplianceSection({ md }: { md: any }) {
  const ae = md.audit_evidence || {}
  const dl = md.decision_lineage || {}
  const hasAudit = Object.keys(ae).length > 0
  const hasLineage = Object.keys(dl).length > 0
  const mistakeBadge = md.mistake_type ? MISTAKE_BADGE[md.mistake_type] : null

  if (!hasAudit && !hasLineage && !md.mistake_type && md.trace_version == null) return null

  const gradeKey = (ae.audit_grade || '').toLowerCase()
  const gradeCls = AUDIT_GRADE_CLS[gradeKey] || 'bg-slate-100 text-slate-500'

  return (
    <CollapsibleSection
      title="Audit & Compliance"
      icon={<Shield size={11} />}
      color="text-indigo-600"
      defaultOpen={true}
    >
      {/* Compliance indicators row */}
      <div className="flex flex-wrap gap-1.5 mb-1">
        {md.trace_version != null && (
          <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded text-[10px] font-mono">
            Trace v{md.trace_version}
          </span>
        )}
        {ae.audit_grade && (
          <span className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${gradeCls}`}>
            {ae.audit_grade} Audit Grade
          </span>
        )}
        {mistakeBadge && (
          <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${mistakeBadge.cls}`}>
            {mistakeBadge.label}
          </span>
        )}
      </div>

      {/* Artifact hash (21 CFR Part 11 tamper evidence) */}
      {ae.artifact_record?.sha256 && (
        <div>
          <div className="text-[10px] text-slate-400 uppercase tracking-wide font-medium mb-0.5 flex items-center gap-1">
            <Hash size={9} /> Artifact SHA-256
          </div>
          <CopyableHash hash={ae.artifact_record.sha256} />
        </div>
      )}

      {/* Approval record */}
      {ae.approval_record && (
        <div className="bg-indigo-50 rounded p-2 space-y-1">
          <div className="text-[10px] text-indigo-500 font-semibold uppercase tracking-wide flex items-center gap-1">
            <User size={9} /> Approval Record
          </div>
          {ae.approval_record.approved_by && (
            <div className="text-[10px] text-slate-600">By: <span className="font-medium">{ae.approval_record.approved_by}</span></div>
          )}
          {ae.approval_record.approved_at && (
            <div className="text-[10px] text-slate-500 flex items-center gap-1">
              <Clock size={9} /> {new Date(ae.approval_record.approved_at).toLocaleString()}
            </div>
          )}
          {ae.approval_record.modifications && (
            <div className="text-[10px] text-slate-600 mt-1">Modifications: {ae.approval_record.modifications}</div>
          )}
        </div>
      )}

      {/* Auditor questions answered */}
      {ae.auditor_questions_answered && Object.keys(ae.auditor_questions_answered).length > 0 && (
        <div>
          <div className="text-[10px] text-slate-400 uppercase tracking-wide font-medium mb-1">Auditor Q&A</div>
          <div className="space-y-1">
            {Object.entries(ae.auditor_questions_answered).map(([q, a]) => (
              <div key={q} className="bg-slate-50 rounded p-1.5">
                <div className="text-[10px] font-medium text-slate-600">{q}</div>
                <div className="text-[10px] text-slate-500 mt-0.5">{String(a)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Audit gaps */}
      {ae.audit_gaps && ae.audit_gaps.length > 0 && (
        <div className="bg-red-50 rounded p-2">
          <div className="text-[10px] text-red-500 font-semibold uppercase tracking-wide flex items-center gap-1 mb-1">
            <AlertCircle size={9} /> Audit Gaps
          </div>
          <ul className="space-y-0.5">
            {ae.audit_gaps.map((gap: string, i: number) => (
              <li key={i} className="text-[10px] text-red-700 flex gap-1">
                <span className="text-red-400">•</span> {gap}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Decision lineage / provenance */}
      {hasLineage && (
        <div>
          <div className="text-[10px] text-slate-400 uppercase tracking-wide font-medium mb-1 flex items-center gap-1">
            <Link2 size={9} /> Decision Lineage
          </div>
          <div className="space-y-1">
            {dl.parent_trace_id && (
              <div className="text-[10px] text-slate-600 bg-slate-50 rounded px-2 py-1">
                Parent: <span className="font-mono">{dl.parent_trace_id}</span>
              </div>
            )}
            {dl.lineage_path && Array.isArray(dl.lineage_path) && dl.lineage_path.length > 0 && (
              <div className="flex flex-col gap-0.5">
                {dl.lineage_path.map((step: string, i: number) => (
                  <div key={i} className="flex items-center gap-1 text-[10px] text-slate-600">
                    {i > 0 && <span className="text-slate-300">↓</span>}
                    <span className="font-mono bg-slate-50 px-1.5 py-0.5 rounded">{step}</span>
                  </div>
                ))}
              </div>
            )}
            {dl.data_source && <div className="text-[10px] text-slate-600">Source: {dl.data_source}</div>}
            {dl.transformation && <div className="text-[10px] text-slate-600">Transform: {dl.transformation}</div>}
          </div>
        </div>
      )}
    </CollapsibleSection>
  )
}

// ── Retrieval & Evidence section ──────────────────────────────────────────────

const RETRIEVAL_MODE_CLS: Record<string, string> = {
  hybrid:   'bg-purple-100 text-purple-700',
  semantic: 'bg-blue-100 text-blue-700',
  keyword:  'bg-slate-100 text-slate-600',
  bm25:     'bg-slate-100 text-slate-600',
  dense:    'bg-cyan-100 text-cyan-700',
}

function RetrievalSection({ md }: { md: any }) {
  const rp = md.retrieval_plan || {}
  const ir = md.intent_resolution || {}
  const ea = md.evidence_assembly || {}
  const sources = md.sources_cited || []
  const hasRetrieval = Object.keys(rp).length > 0 || Object.keys(ir).length > 0 || Object.keys(ea).length > 0 || sources.length > 0

  if (!hasRetrieval) return null

  const mode = rp.retrieval_mode || rp.mode
  const modeCls = mode ? (RETRIEVAL_MODE_CLS[mode.toLowerCase()] || 'bg-slate-100 text-slate-600') : null

  return (
    <CollapsibleSection
      title="Retrieval & Evidence"
      icon={<Search size={11} />}
      color="text-purple-600"
      defaultOpen={true}
    >
      {/* Intent Resolution */}
      {Object.keys(ir).length > 0 && (
        <div className="bg-purple-50 rounded p-2 space-y-1">
          <div className="text-[10px] text-purple-600 font-semibold uppercase tracking-wide flex items-center gap-1 mb-1">
            <Target size={9} /> Intent Resolution
          </div>
          {ir.query_intent && <div className="text-[10px] text-slate-700"><span className="text-slate-400">Intent:</span> {ir.query_intent}</div>}
          {ir.resolved_entities && ir.resolved_entities.length > 0 && (
            <div className="text-[10px] text-slate-700">
              <span className="text-slate-400">Entities:</span>{' '}
              <span className="font-medium">{ir.resolved_entities.join(', ')}</span>
            </div>
          )}
          {ir.scope && <div className="text-[10px] text-slate-700"><span className="text-slate-400">Scope:</span> {ir.scope}</div>}
          {ir.confidence && <ConfidenceBar value={ir.confidence} label="Intent Confidence" />}
        </div>
      )}

      {/* Retrieval Plan */}
      {Object.keys(rp).length > 0 && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {mode && modeCls && (
              <span className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${modeCls}`}>
                {mode} retrieval
              </span>
            )}
            {rp.top_k && (
              <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded text-[10px]">
                top-{rp.top_k}
              </span>
            )}
          </div>
          {rp.query && <MetaRow label="Query" value={rp.query} />}
          {rp.filters && Object.keys(rp.filters).length > 0 && (
            <MetaRow label="Filters" value={rp.filters} />
          )}
          {rp.min_score != null && (
            <div className="text-[10px] text-slate-600 bg-slate-50 rounded px-2 py-1">
              Min score threshold: <span className="font-medium">{(rp.min_score * 100).toFixed(0)}%</span>
            </div>
          )}
        </div>
      )}

      {/* Evidence Assembly */}
      {Object.keys(ea).length > 0 && (
        <div className="bg-blue-50 rounded p-2 space-y-1">
          <div className="text-[10px] text-blue-600 font-semibold uppercase tracking-wide flex items-center gap-1 mb-1">
            <Layers size={9} /> Evidence Assembly
          </div>
          {ea.chunks_assembled != null && (
            <div className="text-[10px] text-slate-700">Chunks assembled: <span className="font-medium">{ea.chunks_assembled}</span></div>
          )}
          {ea.coherence_score != null && (
            <ConfidenceBar value={ea.coherence_score} label="Coherence Score" />
          )}
          {ea.deduplication_applied != null && (
            <div className="text-[10px] text-slate-600">
              Deduplication: {ea.deduplication_applied ? '✓ Applied' : '✗ Not applied'}
            </div>
          )}
          {ea.assembly_strategy && (
            <div className="text-[10px] text-slate-600">Strategy: {ea.assembly_strategy}</div>
          )}
        </div>
      )}

      {/* Sources Cited — enhanced */}
      {sources.length > 0 && (
        <div>
          <div className="text-[10px] text-slate-400 uppercase tracking-wide font-medium mb-1">
            Sources Cited ({sources.length})
          </div>
          <div className="space-y-1">
            {sources.map((s: any, i: number) => {
              const score = s.score ?? s.relevance_score
              const docName = s.doc_name || s.document_name || s.chunk_id || String(s)
              const page = s.page || s.page_number
              const section = s.section || s.chapter
              return (
                <div key={i} className="bg-slate-50 rounded p-2 space-y-0.5">
                  <div className="text-[10px] font-medium text-slate-700 flex items-start gap-1">
                    <BookOpen size={9} className="text-slate-400 mt-0.5 flex-shrink-0" />
                    <span className="break-words">{docName}</span>
                  </div>
                  <div className="flex flex-wrap gap-2 ml-3.5">
                    {page != null && (
                      <span className="text-[9px] text-slate-500">p.{page}</span>
                    )}
                    {section && (
                      <span className="text-[9px] text-slate-500">§{section}</span>
                    )}
                    {score != null && (
                      <span className={`text-[9px] font-semibold ${score >= 0.75 ? 'text-green-600' : score >= 0.5 ? 'text-amber-600' : 'text-red-600'}`}>
                        {(score * 100).toFixed(0)}% match
                      </span>
                    )}
                  </div>
                  {s.excerpt && (
                    <div className="text-[9px] text-slate-400 italic ml-3.5 line-clamp-2">{s.excerpt}</div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </CollapsibleSection>
  )
}

// ── Reasoning Pipeline section ────────────────────────────────────────────────

function ReasoningPipelineSection({ md }: { md: any }) {
  const ir = md.intent_resolution || {}
  const em = md.execution_mode || {}
  const ac = md.answer_construction || {}
  const ol = md.outcome_learning || {}
  const cd = md.confidence_decomposition || md.confidenceDecomposition || {}
  const hasReasoning = md.reasoning_chain?.length > 0 || Object.keys(em).length > 0
    || Object.keys(ac).length > 0 || Object.keys(ol).length > 0 || Object.keys(cd).length > 0

  if (!hasReasoning) return null

  return (
    <CollapsibleSection
      title="Reasoning Pipeline"
      icon={<Activity size={11} />}
      color="text-amber-600"
      defaultOpen={true}
    >
      {/* Reasoning chain */}
      {md.reasoning_chain?.length > 0 && (
        <div>
          <div className="text-[10px] text-slate-400 uppercase tracking-wide font-medium mb-1">
            Reasoning Steps ({md.reasoning_chain.length})
          </div>
          <ol className="space-y-1">
            {md.reasoning_chain.map((step: string | any, i: number) => (
              <li key={i} className="flex gap-1.5 text-xs text-slate-600 bg-slate-50 rounded p-1.5">
                <span className="text-slate-400 flex-shrink-0 font-mono text-[10px]">{i + 1}.</span>
                <span className="text-[11px]">{typeof step === 'string' ? step : JSON.stringify(step)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Execution mode */}
      {Object.keys(em).length > 0 && (
        <div className="bg-amber-50 rounded p-2 space-y-1">
          <div className="text-[10px] text-amber-600 font-semibold uppercase tracking-wide mb-1">Execution Mode</div>
          {em.mode && (
            <span className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded text-[10px] font-semibold uppercase">
              {em.mode}
            </span>
          )}
          {em.tools_used && em.tools_used.length > 0 && (
            <div className="text-[10px] text-slate-600 mt-1">
              Tools: <span className="font-medium">{em.tools_used.join(', ')}</span>
            </div>
          )}
          {em.parallel != null && (
            <div className="text-[10px] text-slate-600">
              Parallel execution: {em.parallel ? '✓ Yes' : '✗ No'}
            </div>
          )}
        </div>
      )}

      {/* Answer construction */}
      {Object.keys(ac).length > 0 && (
        <div className="bg-teal-50 rounded p-2 space-y-1">
          <div className="text-[10px] text-teal-600 font-semibold uppercase tracking-wide mb-1">Answer Construction</div>
          {ac.format && <div className="text-[10px] text-slate-600">Format: <span className="font-medium">{ac.format}</span></div>}
          {ac.structure && <div className="text-[10px] text-slate-600">Structure: <span className="font-medium">{ac.structure}</span></div>}
          {ac.citations_included != null && (
            <div className="text-[10px] text-slate-600">
              Citations: {ac.citations_included ? '✓ Included' : '✗ Not included'}
            </div>
          )}
          {ac.word_count != null && (
            <div className="text-[10px] text-slate-600">Word count: {ac.word_count}</div>
          )}
        </div>
      )}

      {/* Outcome learning */}
      {Object.keys(ol).length > 0 && (
        <div className="bg-green-50 rounded p-2 space-y-1">
          <div className="text-[10px] text-green-600 font-semibold uppercase tracking-wide mb-1">Outcome Learning</div>
          {ol.learned_patterns && ol.learned_patterns.length > 0 && (
            <div>
              <div className="text-[10px] text-slate-500 mb-0.5">Patterns learned:</div>
              <ul className="space-y-0.5">
                {ol.learned_patterns.map((p: string, i: number) => (
                  <li key={i} className="text-[10px] text-slate-600 flex gap-1">
                    <span className="text-green-400">•</span> {p}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {ol.corrections_applied && ol.corrections_applied.length > 0 && (
            <div>
              <div className="text-[10px] text-slate-500 mb-0.5">Corrections applied:</div>
              <ul className="space-y-0.5">
                {ol.corrections_applied.map((c: string, i: number) => (
                  <li key={i} className="text-[10px] text-slate-600 flex gap-1">
                    <span className="text-amber-400">•</span> {c}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {ol.feedback_incorporated != null && (
            <div className="text-[10px] text-slate-600">
              Feedback incorporated: {ol.feedback_incorporated ? '✓ Yes' : '✗ No'}
            </div>
          )}
        </div>
      )}

      {/* Confidence decomposition */}
      {Object.keys(cd).length > 0 && (
        <div>
          <div className="text-[10px] text-slate-400 uppercase tracking-wide font-medium mb-1">Confidence Breakdown</div>
          <div className="space-y-1.5">
            {Object.entries(cd).map(([key, val]) => (
              typeof val === 'number'
                ? <ConfidenceBar key={key} value={val as number} label={key.replace(/_/g, ' ')} />
                : <MetaRow key={key} label={key.replace(/_/g, ' ')} value={val as any} />
            ))}
          </div>
        </div>
      )}
    </CollapsibleSection>
  )
}

// ── Graph toolbar ─────────────────────────────────────────────────────────────

type VerdictFilter = 'all' | 'pass' | 'partial' | 'fail'
type NodeTypeFilter = string | 'all'

interface GraphStats {
  totalNodes: number
  totalEdges: number
  hallucinationCount: number
  auditGapCount: number
  complianceCoverage: number
}

function computeStats(rawNodes: any[], rawEdges: any[]): GraphStats {
  const hallucinationCount = rawNodes.filter(n => n.metadata?.mistake_type || n.metadata?.hallucination_detected).length
  const withAudit = rawNodes.filter(n => n.metadata?.audit_evidence && Object.keys(n.metadata.audit_evidence).length > 0).length
  const withGaps = rawNodes.filter(n => n.metadata?.audit_evidence?.audit_gaps?.length > 0).length
  const complianceCoverage = rawNodes.length > 0 ? Math.round((withAudit / rawNodes.length) * 100) : 0
  return { totalNodes: rawNodes.length, totalEdges: rawEdges.length, hallucinationCount, auditGapCount: withGaps, complianceCoverage }
}

function GraphToolbar({
  stats, verdictFilter, setVerdictFilter, nodeTypeFilter, setNodeTypeFilter,
  availableTypes, onExport,
}: {
  stats: GraphStats
  verdictFilter: VerdictFilter
  setVerdictFilter: (v: VerdictFilter) => void
  nodeTypeFilter: NodeTypeFilter
  setNodeTypeFilter: (t: NodeTypeFilter) => void
  availableTypes: string[]
  onExport: () => void
}) {
  const [showTypeFilter, setShowTypeFilter] = useState(false)
  return (
    <div className="flex-shrink-0 border-b border-slate-100 bg-white px-4 py-2 flex flex-wrap items-center gap-3 text-xs">
      {/* Stats */}
      <div className="flex items-center gap-3 mr-2">
        <span className="text-slate-400">Nodes: <span className="font-semibold text-slate-700">{stats.totalNodes}</span></span>
        <span className="text-slate-400">Edges: <span className="font-semibold text-slate-700">{stats.totalEdges}</span></span>
        <span className={`flex items-center gap-1 ${stats.hallucinationCount > 0 ? 'text-red-600 font-semibold' : 'text-slate-400'}`}>
          {stats.hallucinationCount > 0 && <AlertTriangle size={11} />}
          {stats.hallucinationCount} flag{stats.hallucinationCount !== 1 ? 's' : ''}
        </span>
        {stats.auditGapCount > 0 && (
          <span className="flex items-center gap-1 text-amber-600 font-semibold">
            <AlertCircle size={11} /> {stats.auditGapCount} gap{stats.auditGapCount !== 1 ? 's' : ''}
          </span>
        )}
        <span className={`flex items-center gap-1 ${stats.complianceCoverage >= 80 ? 'text-green-600' : stats.complianceCoverage >= 50 ? 'text-amber-600' : 'text-red-600'}`}>
          <Shield size={11} /> {stats.complianceCoverage}% coverage
        </span>
      </div>

      <div className="h-4 w-px bg-slate-200" />

      {/* Verdict filter */}
      <div className="flex items-center gap-1">
        {(['all', 'pass', 'partial', 'fail'] as VerdictFilter[]).map(v => (
          <button
            key={v}
            onClick={() => setVerdictFilter(v)}
            className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase transition-colors ${
              verdictFilter === v
                ? v === 'all' ? 'bg-slate-700 text-white'
                  : v === 'pass' ? 'bg-green-600 text-white'
                  : v === 'partial' ? 'bg-amber-500 text-white'
                  : 'bg-red-500 text-white'
                : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
            }`}
          >
            {v}
          </button>
        ))}
      </div>

      <div className="h-4 w-px bg-slate-200" />

      {/* Node type filter */}
      <div className="relative">
        <button
          onClick={() => setShowTypeFilter(o => !o)}
          className="flex items-center gap-1 px-2 py-0.5 bg-slate-100 hover:bg-slate-200 rounded text-[10px] text-slate-600 transition-colors"
        >
          <Filter size={10} />
          {nodeTypeFilter === 'all' ? 'All types' : NODE_META[nodeTypeFilter]?.label || nodeTypeFilter}
          <ChevronDown size={9} />
        </button>
        {showTypeFilter && (
          <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-50 min-w-[130px] py-1">
            <button
              onClick={() => { setNodeTypeFilter('all'); setShowTypeFilter(false) }}
              className={`w-full text-left px-3 py-1 text-[10px] hover:bg-slate-50 ${nodeTypeFilter === 'all' ? 'font-semibold text-brand-600' : 'text-slate-600'}`}
            >
              All types
            </button>
            {availableTypes.map(t => (
              <button
                key={t}
                onClick={() => { setNodeTypeFilter(t); setShowTypeFilter(false) }}
                className={`w-full text-left px-3 py-1 text-[10px] hover:bg-slate-50 ${nodeTypeFilter === t ? 'font-semibold text-brand-600' : 'text-slate-600'}`}
              >
                {NODE_META[t]?.label || t}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="ml-auto">
        <button
          onClick={onExport}
          className="flex items-center gap-1 px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded text-[10px] font-medium transition-colors"
        >
          <Download size={10} /> Export JSON
        </button>
      </div>
    </div>
  )
}

function NodeDetailPanel({ node, onClose }: { node: Node; onClose: () => void }) {
  const data = node.data as any
  const meta = NODE_META[data.nodeType] || NODE_META.decision_trace
  const Icon = meta.icon
  const md = data.metadata || {}

  // Known keys handled by structured sections — excluded from the catch-all
  const HANDLED_KEYS = new Set([
    'confidence', 'judge_verdict', 'summary', 'trace_type', 'feedback_type',
    'correction', 'skill_name', 'tool_name', 'model', 'tokens_used',
    'faithfulness_score', 'reasoning_score', 'hallucination_detected',
    'hallucination_rate', 'judge_notes', 'reasoning_chain', 'sources_cited',
    'prompt', 'output', 'created_at', 'judge_model',
    // structured sections
    'audit_evidence', 'decision_lineage', 'mistake_type', 'trace_version', 'audit_grade',
    'retrieval_plan', 'intent_resolution', 'evidence_assembly',
    'execution_mode', 'answer_construction', 'outcome_learning',
    'confidence_decomposition', 'confidenceDecomposition',
  ])

  return (
    <div className="w-72 flex-shrink-0 border-l border-slate-200 bg-white flex flex-col overflow-hidden">
      {/* Panel header */}
      <div className={`flex items-center gap-2 px-4 py-3 border-b border-slate-100 ${meta.bg}`}>
        <Icon size={14} className={meta.iconColor} />
        <span className={`text-xs font-semibold uppercase tracking-wide ${meta.iconColor}`}>{meta.label}</span>
        <button onClick={onClose} className="ml-auto p-0.5 hover:bg-black/10 rounded">
          <X size={13} className="text-slate-500" />
        </button>
      </div>

      {/* Scrollable detail body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">

        {/* ── Identity ── */}
        <div>
          <div className="text-[10px] text-slate-400 uppercase tracking-wide font-medium mb-0.5">Label</div>
          <div className="text-sm font-semibold text-slate-800">{data.label}</div>
        </div>

        {md.confidence != null && <ConfidenceBar value={md.confidence} />}

        {md.judge_verdict && (
          <div>
            <div className="text-[10px] text-slate-400 uppercase tracking-wide font-medium mb-1">Verdict</div>
            <VerdictBadge verdict={md.judge_verdict} />
          </div>
        )}

        <MetaRow label="Summary" value={md.summary} />
        <MetaRow label="Trace Type" value={md.trace_type} />

        {/* Quality scores */}
        {md.faithfulness_score != null && <ConfidenceBar value={md.faithfulness_score} label="Faithfulness" />}
        {md.reasoning_score != null && <ConfidenceBar value={md.reasoning_score} label="Reasoning Score" />}

        {md.hallucination_detected != null && (
          <div className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded ${md.hallucination_detected ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>
            <AlertTriangle size={11} />
            {md.hallucination_detected ? 'Hallucination Detected' : 'No Hallucination'}
          </div>
        )}

        <MetaRow label="Judge Notes" value={md.judge_notes} />

        {/* Skill / tool info */}
        <MetaRow label="Skill Name" value={md.skill_name} />
        <MetaRow label="Tool Name" value={md.tool_name} />
        <MetaRow label="Model" value={md.model} />
        <MetaRow label="Tokens Used" value={md.tokens_used} />
        <MetaRow label="Feedback Type" value={md.feedback_type} />
        <MetaRow label="Correction" value={md.correction} />

        {/* ── Audit & Compliance ── */}
        <AuditComplianceSection md={md} />

        {/* ── Retrieval & Evidence ── */}
        <RetrievalSection md={md} />

        {/* ── Reasoning Pipeline ── */}
        <ReasoningPipelineSection md={md} />

        {/* Prompt / Output */}
        {md.prompt && <MetaRow label="Prompt" value={md.prompt} />}
        <MetaRow label="Output" value={md.output} />

        <MetaRow label="Created At" value={md.created_at ? new Date(md.created_at).toLocaleString() : null} />

        {/* Catch-all: any remaining unhandled metadata keys */}
        {Object.entries(md)
          .filter(([k]) => !HANDLED_KEYS.has(k))
          .map(([k, v]) => (
            <MetaRow key={k} label={k.replace(/_/g, ' ')} value={v as any} />
          ))
        }
      </div>
    </div>
  )
}

interface Props {
  runId: string
  orgId: string
}

export function AgentReasoningGraph({ runId, orgId }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState<any>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<any>([])
  const [loading, setLoading] = useState(false)
  const [empty, setEmpty] = useState(false)
  const [fetched, setFetched] = useState(false)
  const [selectedNode, setSelectedNode] = useState<Node | null>(null)
  const [rawNodes, setRawNodes] = useState<any[]>([])
  const [rawEdges, setRawEdges] = useState<any[]>([])
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>('all')
  const [nodeTypeFilter, setNodeTypeFilter] = useState<NodeTypeFilter>('all')

  const load = useCallback(async () => {
    if (fetched) return
    setFetched(true)
    setLoading(true)
    try {
      const res = await fetch(
        `${CONTEXT_GRAPH_URL}/graph/run/${runId}?org_id=${orgId}`
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const rn: any[] = data.nodes || []
      const re: any[] = data.edges || []
      if (rn.length === 0) {
        setEmpty(true)
      } else {
        setRawNodes(rn)
        setRawEdges(re)
        setNodes(layoutNodes(rn))
        setEdges(buildEdges(re))
      }
    } catch {
      setEmpty(true)
    } finally {
      setLoading(false)
    }
  }, [runId, orgId, fetched])

  useEffect(() => { load() }, [load])

  // Re-filter nodes/edges when filters change
  useEffect(() => {
    if (rawNodes.length === 0) return
    const filtered = rawNodes.filter(n => {
      const typeOk = nodeTypeFilter === 'all' || n.node_type === nodeTypeFilter
      const verdict = n.metadata?.judge_verdict
      const verdictOk = verdictFilter === 'all' || verdict === verdictFilter
      return typeOk && verdictOk
    })
    const filteredIds = new Set(filtered.map((n: any) => n.id))
    const filteredEdges = rawEdges.filter(e => filteredIds.has(e.source) && filteredIds.has(e.target))
    setNodes(layoutNodes(filtered))
    setEdges(buildEdges(filteredEdges))
    setSelectedNode(null)
  }, [verdictFilter, nodeTypeFilter, rawNodes, rawEdges])

  const availableTypes = Array.from(new Set(rawNodes.map(n => n.node_type)))

  const stats = computeStats(rawNodes, rawEdges)

  const handleExport = useCallback(() => {
    const payload = {
      runId,
      exportedAt: new Date().toISOString(),
      stats,
      nodes: rawNodes,
      edges: rawEdges,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `reasoning-graph-${runId}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [runId, rawNodes, rawEdges, stats])

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode(prev => prev?.id === node.id ? null : node)
    setNodes(ns => ns.map(n => ({
      ...n,
      data: { ...n.data, selected: n.id === node.id && !(selectedNode?.id === node.id) },
    })))
  }, [selectedNode, setNodes])

  const handlePaneClick = useCallback(() => {
    setSelectedNode(null)
    setNodes(ns => ns.map(n => ({ ...n, data: { ...n.data, selected: false } })))
  }, [setNodes])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500 gap-2">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-sm">Loading reasoning graph…</span>
      </div>
    )
  }

  if (empty) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-2">
        <GitBranch size={32} className="opacity-30" />
        <p className="text-sm">No graph data yet for this run.</p>
        <p className="text-xs text-slate-300">
          Graph nodes are written as the agent executes decisions, retrievals, and skill invocations.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <GraphToolbar
        stats={stats}
        verdictFilter={verdictFilter}
        setVerdictFilter={setVerdictFilter}
        nodeTypeFilter={nodeTypeFilter}
        setNodeTypeFilter={setNodeTypeFilter}
        availableTypes={availableTypes}
        onExport={handleExport}
      />

      <div className="flex flex-1 min-h-0">
        <div className="flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            onNodeClick={handleNodeClick}
            onPaneClick={handlePaneClick}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.3}
            maxZoom={2}
          >
            <Background gap={16} size={1} color="#e2e8f0" />
            <Controls />
            <MiniMap
              nodeColor={(n) => {
                const meta = NODE_META[(n.data as any)?.nodeType]
                return meta ? meta.iconColor.replace('text-', '#').replace('-500', '') : '#94a3b8'
              }}
              pannable
              zoomable
            />
          </ReactFlow>
        </div>

        {selectedNode && (
          <NodeDetailPanel
            node={selectedNode}
            onClose={() => {
              setSelectedNode(null)
              setNodes(ns => ns.map(n => ({ ...n, data: { ...n.data, selected: false } })))
            }}
          />
        )}
      </div>
    </div>
  )
}
