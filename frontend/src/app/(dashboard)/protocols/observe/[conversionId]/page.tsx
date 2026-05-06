'use client'
import { useState, useEffect, useCallback } from 'react'
import {
  Loader2, ArrowLeft, RefreshCw, Download, ExternalLink,
  CheckCircle2, XCircle, AlertTriangle, Clock, ChevronDown, ChevronRight,
  GitBranch, Users, Shield, FileCode2, RotateCcw, Eye, Brain,
} from 'lucide-react'
import { clsx } from 'clsx'
import { toast } from 'sonner'
import Link from 'next/link'
import { useOrgId, useAuth } from '@/components/layout/AuthContext'
import { DecisionTracePanel } from '@/components/context/DecisionTracePanel'
import { DocumentGraphView } from '@/components/context/DocumentGraphView'

const AGENT_RUNTIME_URL = process.env.NEXT_PUBLIC_AGENT_RUNTIME_URL || 'http://localhost:8004'
const CONTEXT_GRAPH_URL = process.env.NEXT_PUBLIC_CONTEXT_GRAPH_URL || 'http://localhost:8008'

type Tab = 'traces' | 'confidence' | 'hitl' | 'graph' | 'roles' | 'raw'
type ConversionDetail = {
  id: string; status: string; confidence?: number; retry_count?: number
  eval_accuracy?: number; eval_completeness?: number; eval_standards?: number
  eval_hallucination?: number; eval_readability?: number; eval_consistency?: number
  eval_cost_usd?: number; usdm_json?: Record<string, unknown>
  observe_summary?: Record<string, unknown>; client_graph_built?: boolean
  client_graph_node_count?: number; run_id?: string; protocol_doc_id?: string
  approval_id?: string; study_id?: string; created_at: string
}

const EVALUATORS = [
  { key: 'eval_accuracy',      label: 'Accuracy',      threshold: 0.85, invert: false },
  { key: 'eval_completeness',  label: 'Completeness',  threshold: 0.90, invert: false },
  { key: 'eval_standards',     label: 'Standards',     threshold: 0.80, invert: false },
  { key: 'eval_hallucination', label: 'No Hallucination', threshold: 0.95, invert: false },
  { key: 'eval_readability',   label: 'Readability',   threshold: 0.70, invert: false },
  { key: 'eval_consistency',   label: 'Consistency',   threshold: 0.80, invert: false },
  { key: 'eval_cost_usd',      label: 'Cost (USD)',    threshold: 1.00, invert: true  },
] as const

const NODE_COLORS: Record<string, string> = {
  usdm_section:  'bg-purple-100 text-purple-800',
  role:          'bg-blue-100 text-blue-800',
  permission:    'bg-cyan-100 text-cyan-800',
  user:          'bg-green-100 text-green-800',
  learning:      'bg-amber-100 text-amber-800',
  decision:      'bg-slate-100 text-slate-800',
  organization:  'bg-indigo-100 text-indigo-800',
  conversion:    'bg-violet-100 text-violet-800',
}

function EvalCard({ label, value, threshold, invert }: { label: string; value: number | undefined; threshold: number; invert: boolean }) {
  if (value == null) return (
    <div className="p-3 rounded-xl border border-slate-200 bg-slate-50">
      <p className="text-xs font-medium text-slate-500 mb-1">{label}</p>
      <p className="text-sm text-slate-400">—</p>
    </div>
  )

  const pct = invert ? Math.max(0, (1 - value / threshold) * 100) : value * 100
  const passing = invert ? value <= threshold : value >= threshold
  const borderline = !passing && Math.abs(value - threshold) <= (invert ? threshold * 0.05 : 0.05)

  const colorCls = passing
    ? 'border-emerald-200 bg-emerald-50'
    : borderline
      ? 'border-amber-200 bg-amber-50'
      : 'border-red-200 bg-red-50'

  const valueCls = passing
    ? 'text-emerald-700'
    : borderline ? 'text-amber-700' : 'text-red-700'

  return (
    <div className={clsx('p-3 rounded-xl border', colorCls)}>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-medium text-slate-600">{label}</p>
        {passing
          ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
          : borderline
            ? <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
            : <XCircle className="w-3.5 h-3.5 text-red-600" />}
      </div>
      <p className={clsx('text-lg font-bold', valueCls)}>
        {invert ? `$${value.toFixed(4)}` : `${Math.round(value * 100)}%`}
      </p>
      <div className="mt-2 h-1.5 rounded-full bg-white/60 overflow-hidden">
        <div
          className={clsx('h-full rounded-full', passing ? 'bg-emerald-500' : borderline ? 'bg-amber-500' : 'bg-red-500')}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <p className="text-xs text-slate-500 mt-1">
        threshold: {invert ? `$${threshold}` : `${Math.round(threshold * 100)}%`}
      </p>
    </div>
  )
}

function JsonTree({ data, depth = 0 }: { data: unknown; depth?: number }) {
  const [expanded, setExpanded] = useState(depth < 2)
  if (data === null || data === undefined) return <span className="text-slate-400">null</span>
  if (typeof data === 'string') return <span className="text-emerald-700">"{data}"</span>
  if (typeof data === 'number') return <span className="text-blue-700">{data}</span>
  if (typeof data === 'boolean') return <span className="text-purple-700">{String(data)}</span>
  if (Array.isArray(data)) {
    if (data.length === 0) return <span className="text-slate-400">[]</span>
    return (
      <span>
        <button onClick={() => setExpanded(e => !e)} className="text-slate-500 hover:text-slate-700">
          {expanded ? <ChevronDown className="w-3 h-3 inline" /> : <ChevronRight className="w-3 h-3 inline" />}
          [{data.length}]
        </button>
        {expanded && (
          <div className="ml-4 border-l border-slate-200 pl-2 mt-0.5">
            {data.map((item, i) => (
              <div key={i} className="my-0.5">
                <span className="text-slate-400">{i}: </span>
                <JsonTree data={item} depth={depth + 1} />
              </div>
            ))}
          </div>
        )}
      </span>
    )
  }
  if (typeof data === 'object') {
    const keys = Object.keys(data as object)
    if (keys.length === 0) return <span className="text-slate-400">{'{}'}</span>
    return (
      <span>
        <button onClick={() => setExpanded(e => !e)} className="text-slate-500 hover:text-slate-700">
          {expanded ? <ChevronDown className="w-3 h-3 inline" /> : <ChevronRight className="w-3 h-3 inline" />}
          {'{'}…{'}'}
        </button>
        {expanded && (
          <div className="ml-4 border-l border-slate-200 pl-2 mt-0.5">
            {keys.map(k => (
              <div key={k} className="my-0.5">
                <span className="text-slate-700 font-medium">"{k}"</span>
                <span className="text-slate-400">: </span>
                <JsonTree data={(data as Record<string, unknown>)[k]} depth={depth + 1} />
              </div>
            ))}
          </div>
        )}
      </span>
    )
  }
  return <span>{String(data)}</span>
}

type ClientGraphNode = { id: string; type: string; label: string; metadata: Record<string, unknown> }

function RolesTab({ nodes }: { nodes: ClientGraphNode[] }) {
  const roleNodes = nodes.filter(n => n.type === 'role')
  const userNodes = nodes.filter(n => n.type === 'user')

  return (
    <div className="grid grid-cols-2 gap-6 h-full overflow-y-auto p-4">
      {/* Users */}
      <div>
        <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
          <Users className="w-4 h-4" /> Users ({userNodes.length})
        </h3>
        <div className="space-y-2">
          {userNodes.map(u => {
            const roles: string[] = Array.isArray(u.metadata.roles) ? u.metadata.roles as string[] : []
            return (
              <div key={u.id} className="p-3 rounded-lg border border-slate-200 bg-slate-50">
                <p className="text-sm font-medium text-slate-800 truncate">{u.label}</p>
                {u.metadata.name != null && <p className="text-xs text-slate-500">{String(u.metadata.name)}</p>}
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {roles.map(r => (
                    <span key={r} className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-xs">{r}</span>
                  ))}
                  {roles.length === 0 && <span className="text-xs text-slate-400">no roles assigned</span>}
                </div>
              </div>
            )
          })}
          {userNodes.length === 0 && <p className="text-sm text-slate-400">No users in client graph</p>}
        </div>
      </div>

      {/* Roles → Permissions */}
      <div>
        <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
          <Shield className="w-4 h-4" /> Role Permissions
        </h3>
        <div className="space-y-2">
          {roleNodes.map(r => {
            const perms: string[] = Array.isArray(r.metadata.permissions) ? r.metadata.permissions as string[] : []
            return (
              <div key={r.id} className="p-3 rounded-lg border border-blue-100 bg-blue-50">
                <p className="text-sm font-semibold text-blue-800 mb-1.5">{r.label}</p>
                <div className="flex flex-wrap gap-1">
                  {perms.map(p => (
                    <span key={p} className="px-2 py-0.5 bg-cyan-100 text-cyan-700 rounded text-xs font-mono">{p}</span>
                  ))}
                </div>
              </div>
            )
          })}
          {roleNodes.length === 0 && (
            <p className="text-sm text-slate-400">Build the client graph to see roles</p>
          )}
        </div>
      </div>
    </div>
  )
}

export default function ObservePage({ params }: { params: { conversionId: string } }) {
  const { conversionId } = params
  const orgId = useOrgId()
  const { user } = useAuth()
  const userId = user?.id ?? '00000000-0000-0000-0000-000000000002'

  const [conversion, setConversion] = useState<ConversionDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<Tab>('traces')
  const [graphMode, setGraphMode] = useState<'foundation' | 'client'>('foundation')
  const [clientGraph, setClientGraph] = useState<{ nodes: ClientGraphNode[]; edges: unknown[] } | null>(null)
  const [buildingGraph, setBuildingGraph] = useState(false)

  const fetchConversion = useCallback(async () => {
    try {
      const res = await fetch(`${AGENT_RUNTIME_URL}/usdm/${conversionId}`)
      if (res.ok) {
        const data = await res.json()
        setConversion(data)
      }
    } catch { /* non-fatal */ } finally {
      setLoading(false)
    }
  }, [conversionId])

  useEffect(() => { fetchConversion() }, [fetchConversion])

  // Poll while running
  useEffect(() => {
    if (!conversion || !['running', 'pending'].includes(conversion.status)) return
    const id = setInterval(fetchConversion, 3000)
    return () => clearInterval(id)
  }, [conversion, fetchConversion])

  const fetchClientGraph = useCallback(async () => {
    try {
      const url = `${CONTEXT_GRAPH_URL}/client-graph/${orgId}?conversion_id=${conversionId}`
      const res = await fetch(url)
      if (res.ok) setClientGraph(await res.json())
    } catch { /* non-fatal */ }
  }, [orgId, conversionId])

  useEffect(() => {
    if (conversion?.client_graph_built) fetchClientGraph()
  }, [conversion?.client_graph_built, fetchClientGraph])

  const handleBuildClientGraph = async () => {
    if (!conversion) return
    setBuildingGraph(true)
    try {
      const res = await fetch(`${CONTEXT_GRAPH_URL}/client-graph/build-from-usdm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_id: orgId,
          conversion_id: conversionId,
          study_id: conversion.study_id,
        }),
      })
      if (!res.ok) throw new Error('Build failed')
      const data = await res.json()
      toast.success(`Client graph built — ${data.nodes_created} nodes, ${data.edges_created} edges`)
      await fetchConversion()
      await fetchClientGraph()
    } catch {
      toast.error('Failed to build client graph')
    } finally {
      setBuildingGraph(false)
    }
  }

  const handleDownloadUsdm = () => {
    if (!conversion?.usdm_json) return
    const blob = new Blob([JSON.stringify(conversion.usdm_json, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `usdm_${conversionId.slice(0, 8)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    )
  }

  if (!conversion) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-500">
        <AlertTriangle className="w-8 h-8" />
        <p>Conversion not found</p>
        <Link href="/protocols" className="text-brand-600 hover:underline text-sm">Back to Protocol Hub</Link>
      </div>
    )
  }

  const evaluatorsPassed = EVALUATORS.filter(e => {
    const v = conversion[e.key as keyof ConversionDetail] as number | undefined
    if (v == null) return false
    return e.invert ? v <= e.threshold : v >= e.threshold
  }).length

  const tabs: { key: Tab; label: string; icon: React.ElementType }[] = [
    { key: 'traces',     label: 'Decision Traces',   icon: GitBranch },
    { key: 'confidence', label: 'Confidence & Retries', icon: Brain },
    { key: 'hitl',       label: 'HITL',              icon: Users },
    { key: 'graph',      label: 'Context Graph',     icon: Eye },
    { key: 'roles',      label: 'Roles & Permissions', icon: Shield },
    { key: 'raw',        label: 'Raw USDM',          icon: FileCode2 },
  ]

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <Link href="/protocols" className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-slate-900">Conversion Observability</h1>
          <p className="text-xs text-slate-400 font-mono">{conversionId}</p>
        </div>
        <button onClick={fetchConversion} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
          <RefreshCw className="w-4 h-4" />
        </button>
        <Link href={`/usdm/${conversionId}`} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-50">
          <ExternalLink className="w-3 h-3" /> Full Editor
        </Link>
      </div>

      {/* Summary bar */}
      <div className="grid grid-cols-6 gap-3 mb-4">
        {[
          { label: 'Confidence', value: conversion.confidence != null ? `${Math.round(conversion.confidence * 100)}%` : '—', sub: 'overall', color: 'text-brand-700' },
          { label: 'Evaluators', value: `${evaluatorsPassed}/7`, sub: 'passed', color: evaluatorsPassed >= 5 ? 'text-emerald-700' : evaluatorsPassed >= 3 ? 'text-amber-700' : 'text-red-700' },
          { label: 'Retries',    value: String(conversion.retry_count ?? 0), sub: 'attempts', color: 'text-slate-700' },
          { label: 'HITL',       value: conversion.approval_id ? '1' : '0', sub: 'actions', color: 'text-slate-700' },
          { label: 'Sections',   value: conversion.usdm_json ? String(Object.keys(conversion.usdm_json).length) : '—', sub: 'populated', color: 'text-slate-700' },
          { label: 'Cost',       value: conversion.eval_cost_usd != null ? `$${conversion.eval_cost_usd.toFixed(4)}` : '—', sub: 'USD', color: 'text-slate-700' },
        ].map(s => (
          <div key={s.label} className="bg-white border border-slate-200 rounded-xl px-3 py-2.5">
            <p className="text-xs text-slate-500 font-medium">{s.label}</p>
            <p className={clsx('text-xl font-bold mt-0.5', s.color)}>{s.value}</p>
            <p className="text-xs text-slate-400">{s.sub}</p>
          </div>
        ))}
      </div>

      {/* Tabs + content */}
      <div className="flex-1 bg-white border border-slate-200 rounded-xl flex flex-col min-h-0 overflow-hidden">
        <div className="flex border-b border-slate-100 px-4 flex-shrink-0 overflow-x-auto">
          {tabs.map(t => {
            const Icon = t.icon
            return (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={clsx(
                  'flex items-center gap-1.5 px-3 py-3 text-xs font-medium border-b-2 whitespace-nowrap transition-colors',
                  activeTab === t.key
                    ? 'border-brand-500 text-brand-700'
                    : 'border-transparent text-slate-500 hover:text-slate-700',
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {t.label}
              </button>
            )
          })}
        </div>

        <div className="flex-1 overflow-hidden">
          {/* Tab 1 — Decision Traces */}
          {activeTab === 'traces' && (
            <div className="h-full overflow-y-auto">
              {conversion.run_id
                ? <DecisionTracePanel runId={conversion.run_id} />
                : (
                  <div className="flex items-center justify-center h-full text-sm text-slate-400 gap-2">
                    <Clock className="w-5 h-5" /> No run ID — conversion may still be pending
                  </div>
                )}
            </div>
          )}

          {/* Tab 2 — Confidence & Retries */}
          {activeTab === 'confidence' && (
            <div className="h-full overflow-y-auto p-4">
              <h3 className="text-sm font-semibold text-slate-700 mb-3">Evaluator Scorecards</h3>
              <div className="grid grid-cols-3 lg:grid-cols-4 gap-3 mb-6">
                {EVALUATORS.map(e => (
                  <EvalCard
                    key={e.key}
                    label={e.label}
                    value={conversion[e.key as keyof ConversionDetail] as number | undefined}
                    threshold={e.threshold}
                    invert={e.invert}
                  />
                ))}
              </div>

              {(conversion.retry_count ?? 0) > 0 && (
                <>
                  <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                    <RotateCcw className="w-4 h-4" /> Retry History ({conversion.retry_count} retries)
                  </h3>
                  <div className="space-y-2">
                    {Array.from({ length: conversion.retry_count! }).map((_, i) => (
                      <div key={i} className="flex items-center gap-3 p-3 rounded-lg border border-amber-100 bg-amber-50">
                        <div className="w-6 h-6 rounded-full bg-amber-200 flex items-center justify-center text-xs font-bold text-amber-700">
                          {i + 1}
                        </div>
                        <div>
                          <p className="text-xs font-medium text-amber-800">
                            {i === 0 ? 'L1: Reprompt with patch'
                              : i === 1 ? 'L2: Broadened retrieval'
                              : i === 2 ? 'L3: Escalated model (gpt-4)'
                              : i === 3 ? 'L4: Alternate agent delegation'
                              : 'L5: HITL escalation'}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {(conversion.observe_summary as any)?.node_types && (
                <>
                  <h3 className="text-sm font-semibold text-slate-700 mb-3 mt-6">Observe Summary</h3>
                  <div className="font-mono text-xs bg-slate-50 rounded-lg p-4 border border-slate-200">
                    <JsonTree data={conversion.observe_summary} />
                  </div>
                </>
              )}
            </div>
          )}

          {/* Tab 3 — HITL */}
          {activeTab === 'hitl' && (
            <div className="h-full overflow-y-auto p-4">
              {conversion.approval_id ? (
                <div className="space-y-4">
                  <div className="p-4 rounded-xl border border-amber-200 bg-amber-50">
                    <div className="flex items-center gap-2 mb-2">
                      <Clock className="w-4 h-4 text-amber-600" />
                      <p className="text-sm font-semibold text-amber-800">Approval Required</p>
                    </div>
                    <p className="text-xs text-amber-700 mb-3">Approval ID: <span className="font-mono">{conversion.approval_id}</span></p>
                    <Link
                      href={`/tasks?approval=${conversion.approval_id}`}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 text-white rounded-lg text-xs font-medium hover:bg-amber-700 w-fit"
                    >
                      <ExternalLink className="w-3 h-3" /> Open in Approval Queue
                    </Link>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-2">
                  <CheckCircle2 className="w-10 h-10 text-emerald-300" />
                  <p className="text-sm">No HITL interactions for this conversion</p>
                </div>
              )}
            </div>
          )}

          {/* Tab 4 — Context Graph */}
          {activeTab === 'graph' && (
            <div className="h-full flex flex-col">
              {/* Toggle + Build button */}
              <div className="flex items-center gap-3 px-4 py-2.5 border-b border-slate-100 flex-shrink-0">
                <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-medium">
                  {(['foundation', 'client'] as const).map(m => (
                    <button
                      key={m}
                      onClick={() => setGraphMode(m)}
                      className={clsx(
                        'px-3 py-1.5 capitalize transition-colors',
                        graphMode === m ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50',
                      )}
                    >
                      {m === 'foundation' ? 'Foundation' : 'Client-Specific'}
                    </button>
                  ))}
                </div>

                {graphMode === 'client' && !conversion.client_graph_built && (
                  <button
                    onClick={handleBuildClientGraph}
                    disabled={buildingGraph}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-600 text-white rounded-lg text-xs font-medium hover:bg-brand-700 disabled:opacity-60"
                  >
                    {buildingGraph ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitBranch className="w-3 h-3" />}
                    Build Client Graph
                  </button>
                )}

                {graphMode === 'client' && conversion.client_graph_built && (
                  <span className="flex items-center gap-1 text-xs text-emerald-600">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {conversion.client_graph_node_count} nodes
                  </span>
                )}

                {/* Node colour legend */}
                {graphMode === 'client' && conversion.client_graph_built && (
                  <div className="flex flex-wrap gap-1.5 ml-auto">
                    {Object.entries(NODE_COLORS).slice(0, 6).map(([type, cls]) => (
                      <span key={type} className={clsx('px-2 py-0.5 rounded-full text-xs', cls)}>
                        {type.replace('_', ' ')}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-hidden">
                {graphMode === 'foundation' ? (
                  conversion.protocol_doc_id ? (
                    <DocumentGraphView documentId={conversion.protocol_doc_id} orgId={orgId} />
                  ) : (
                    <div className="flex items-center justify-center h-full text-sm text-slate-400">
                      No protocol document linked to this conversion
                    </div>
                  )
                ) : !conversion.client_graph_built ? (
                  <div className="flex flex-col items-center justify-center h-full text-sm text-slate-400 gap-3">
                    <GitBranch className="w-10 h-10 text-slate-200" />
                    <p>Client-specific graph not built yet</p>
                    <p className="text-xs">Click "Build Client Graph" to extract USDM sections, decisions, learnings, and role graph</p>
                  </div>
                ) : clientGraph ? (
                  <div className="p-4 h-full overflow-y-auto">
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                      {clientGraph.nodes.map(n => (
                        <div key={n.id} className="p-2.5 rounded-lg border border-slate-200 bg-slate-50 text-xs">
                          <span className={clsx('inline-block px-1.5 py-0.5 rounded-full text-xs mb-1', NODE_COLORS[n.type] || 'bg-slate-100 text-slate-700')}>
                            {n.type.replace('_', ' ')}
                          </span>
                          <p className="font-medium text-slate-800 truncate">{n.label}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-full">
                    <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Tab 5 — Roles & Permissions */}
          {activeTab === 'roles' && (
            conversion.client_graph_built && clientGraph ? (
              <RolesTab nodes={clientGraph.nodes} />
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-sm text-slate-400 gap-3 p-4">
                <Shield className="w-10 h-10 text-slate-200" />
                <p>Build the client graph first to view the roles & permissions graph</p>
                <button
                  onClick={handleBuildClientGraph}
                  disabled={buildingGraph}
                  className="flex items-center gap-1.5 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-60"
                >
                  {buildingGraph ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitBranch className="w-4 h-4" />}
                  Build Client Graph
                </button>
              </div>
            )
          )}

          {/* Tab 6 — Raw USDM */}
          {activeTab === 'raw' && (
            <div className="h-full flex flex-col">
              <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-100 flex-shrink-0">
                <span className="text-xs text-slate-500 flex-1">USDM v4.0 JSON output</span>
                <button
                  onClick={handleDownloadUsdm}
                  disabled={!conversion.usdm_json}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 text-slate-600 rounded-lg text-xs font-medium hover:bg-slate-50 disabled:opacity-40"
                >
                  <Download className="w-3 h-3" /> Download JSON
                </button>
                <Link
                  href={`/usdm/${conversionId}`}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-600 text-white rounded-lg text-xs font-medium hover:bg-brand-700"
                >
                  <ExternalLink className="w-3 h-3" /> Full Editor
                </Link>
              </div>
              <div className="flex-1 overflow-y-auto p-4 font-mono text-xs bg-slate-50">
                {conversion.usdm_json
                  ? <JsonTree data={conversion.usdm_json} />
                  : <span className="text-slate-400">No USDM output yet</span>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
