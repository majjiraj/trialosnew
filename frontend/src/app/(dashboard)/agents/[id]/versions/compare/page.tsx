'use client'
import { useState, useEffect, Suspense } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, GitCompare, Loader2, AlertCircle } from 'lucide-react'
import { ReactFlow, Background, Controls, useNodesState, useEdgesState, type Node, type Edge } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { nodeTypes } from '@/components/flow/FlowNodes'
import { clsx } from 'clsx'

const MARKETPLACE_URL = process.env.NEXT_PUBLIC_MARKETPLACE_URL || 'http://localhost:8005'

const NODE_TYPE_MAP: Record<string, string> = {
  data_source: 'dataSource', llm: 'llm', code: 'code', chart: 'chart',
  document: 'document', output: 'output', hitl: 'hitl', condition: 'condition',
  agent: 'agent', context_graph: 'context_graph', skill: 'skill',
  memory: 'memory', reflect: 'reflect', planner: 'planner', file_op: 'file_op',
}

const DIFF_COLORS = {
  added:     { border: '#16a34a', bg: '#f0fdf4' },
  removed:   { border: '#dc2626', bg: '#fef2f2' },
  changed:   { border: '#d97706', bg: '#fffbeb' },
  unchanged: { border: '#94a3b8', bg: '#ffffff' },
}

type DiffStatus = 'added' | 'removed' | 'changed' | 'unchanged'

function classifyNodeDiff(
  nodesV1: any[], nodesV2: any[]
): Record<string, DiffStatus> {
  const result: Record<string, DiffStatus> = {}
  const mapV1 = Object.fromEntries(nodesV1.map(n => [n.id, n]))
  const mapV2 = Object.fromEntries(nodesV2.map(n => [n.id, n]))

  for (const n of nodesV1) {
    if (!mapV2[n.id]) {
      result[n.id] = 'removed'
    } else {
      const v1str = JSON.stringify({ type: n.type, config: n.config, label: n.label })
      const v2str = JSON.stringify({ type: mapV2[n.id].type, config: mapV2[n.id].config, label: mapV2[n.id].label })
      result[n.id] = v1str === v2str ? 'unchanged' : 'changed'
    }
  }
  for (const n of nodesV2) {
    if (!mapV1[n.id]) {
      result[n.id] = 'added'
    }
  }
  return result
}

function layoutNodes(nodes: any[], edges: any[]) {
  const adj: Record<string, string[]> = {}
  const inDegree: Record<string, number> = {}
  for (const n of nodes) { adj[n.id] = []; inDegree[n.id] = 0 }
  for (const e of edges) {
    adj[e.source]?.push(e.target)
    inDegree[e.target] = (inDegree[e.target] || 0) + 1
  }
  const layer: Record<string, number> = {}
  const queue = nodes.filter(n => inDegree[n.id] === 0).map(n => n.id)
  for (const id of queue) layer[id] = 0
  while (queue.length) {
    const id = queue.shift()!
    for (const nxt of adj[id] || []) {
      layer[nxt] = Math.max(layer[nxt] ?? 0, (layer[id] ?? 0) + 1)
      queue.push(nxt)
    }
  }
  const layerCount: Record<number, number> = {}
  const layerIdx: Record<string, number> = {}
  for (const n of nodes) {
    const l = layer[n.id] ?? 0
    layerIdx[n.id] = layerCount[l] ?? 0
    layerCount[l] = (layerCount[l] ?? 0) + 1
  }
  const COL_W = 220, ROW_H = 120
  return nodes.map(n => {
    const l = layer[n.id] ?? 0
    const idx = layerIdx[n.id] ?? 0
    const total = layerCount[l] ?? 1
    return {
      id: n.id,
      type: NODE_TYPE_MAP[n.type] || n.type || 'dataSource',
      position: { x: l * COL_W + 40, y: idx * ROW_H - ((total - 1) * ROW_H) / 2 + 200 },
      data: { label: n.label, ...(n.config || {}) },
    }
  })
}

function buildEdges(rawEdges: any[]) {
  return (rawEdges || []).map((e: any, i: number) => ({
    id: `e${i}`, source: e.source, target: e.target,
    type: 'smoothstep', animated: false,
    style: { stroke: '#94a3b8', strokeWidth: 1.5 },
  }))
}

// ── Flow Diff Canvas ──────────────────────────────────────────────────────────

function FlowCanvas({ snapshot, diffMap, label }: {
  snapshot: any
  diffMap: Record<string, DiffStatus>
  label: string
}) {
  const fd = snapshot?.flow_definition
  const rawNodes = fd?.nodes || []
  const rawEdges = fd?.edges || []

  const coloredNodes = layoutNodes(rawNodes, rawEdges).map(n => {
    const status = diffMap[n.id] || 'unchanged'
    const colors = DIFF_COLORS[status]
    return {
      ...n,
      style: {
        borderColor: colors.border,
        borderWidth: 2,
        backgroundColor: colors.bg,
      },
    }
  })

  const [nodes, , onNodesChange] = useNodesState<Node>(coloredNodes as Node[])
  const [edges, , onEdgesChange] = useEdgesState<Edge>(buildEdges(rawEdges))

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center gap-2">
        <span className="font-mono text-sm font-bold text-slate-700">{label}</span>
        <span className="text-xs text-slate-400">{rawNodes.length} nodes</span>
      </div>
      <div className="flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          minZoom={0.3}
        >
          <Background color="#e2e8f0" gap={20} />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  )
}

// ── Text Diff ─────────────────────────────────────────────────────────────────

function TextDiff({ v1, v2 }: { v1: any; v2: any }) {
  function diffLines(a: string[], b: string[]) {
    const setA = new Set(a)
    const setB = new Set(b)
    const all = [...new Set([...a, ...b])]
    return all.map(line => ({
      line,
      inA: setA.has(line),
      inB: setB.has(line),
    }))
  }

  function getSection(label: string, linesA: string[], linesB: string[]) {
    const diff = diffLines(linesA, linesB)
    const hasChanges = diff.some(d => !(d.inA && d.inB))
    return (
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">{label}</h4>
        {diff.length === 0 ? (
          <p className="text-xs text-slate-400 italic">Empty</p>
        ) : (
          <div className="rounded-lg overflow-hidden border border-slate-200 text-xs font-mono">
            {diff.map((d, i) => (
              <div key={i} className={clsx('px-3 py-1', {
                'bg-red-50 text-red-700': d.inA && !d.inB,
                'bg-green-50 text-green-700': !d.inA && d.inB,
                'text-slate-600': d.inA && d.inB,
              })}>
                {d.inA && !d.inB ? '− ' : !d.inA && d.inB ? '+ ' : '  '}
                {d.line}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  const descA = (v1?.description || '').split('\n').filter(Boolean)
  const descB = (v2?.description || '').split('\n').filter(Boolean)

  const llmPromptsA = (v1?.flow_definition?.nodes || [])
    .filter((n: any) => n.type === 'llm')
    .flatMap((n: any) => [n.config?.systemPrompt, n.config?.prompt].filter(Boolean))
  const llmPromptsB = (v2?.flow_definition?.nodes || [])
    .filter((n: any) => n.type === 'llm')
    .flatMap((n: any) => [n.config?.systemPrompt, n.config?.prompt].filter(Boolean))

  const toolsA = v1?.declared_tools || []
  const toolsB = v2?.declared_tools || []

  const permsA = v1?.required_permissions || []
  const permsB = v2?.required_permissions || []

  return (
    <div className="p-4 overflow-y-auto h-full">
      {getSection('Description', descA, descB)}
      {getSection('LLM Prompts', llmPromptsA, llmPromptsB)}
      {getSection('Declared Tools', toolsA, toolsB)}
      {getSection('Required Permissions', permsA, permsB)}
    </div>
  )
}

// ── Summary Tab ───────────────────────────────────────────────────────────────

function SummaryTab({ v1, v2, agentId }: { v1: any; v2: any; agentId: string }) {
  const nodesV1 = v1?.flow_definition?.nodes || []
  const nodesV2 = v2?.flow_definition?.nodes || []
  const diffMap = classifyNodeDiff(nodesV1, nodesV2)

  const added    = Object.values(diffMap).filter(s => s === 'added').length
  const removed  = Object.values(diffMap).filter(s => s === 'removed').length
  const changed  = Object.values(diffMap).filter(s => s === 'changed').length
  const unchanged = Object.values(diffMap).filter(s => s === 'unchanged').length

  function VersionMeta({ snapshot, label }: { snapshot: any; label: string }) {
    return (
      <div className="bg-slate-50 rounded-xl p-4 space-y-2">
        <h4 className="font-semibold text-slate-700 text-sm">{label}</h4>
        <div className="space-y-1 text-xs text-slate-600">
          <div><span className="text-slate-400">Version: </span><span className="font-mono font-medium">v{snapshot?.version}</span></div>
          <div><span className="text-slate-400">Change: </span>{snapshot?.change_type}</div>
          <div><span className="text-slate-400">Reason: </span>{snapshot?.change_reason || '—'}</div>
          <div><span className="text-slate-400">By: </span>{snapshot?.changed_by_name || snapshot?.changed_by || '—'}</div>
          <div><span className="text-slate-400">Date: </span>{snapshot?.created_at ? new Date(snapshot.created_at).toLocaleDateString() : '—'}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 space-y-6 overflow-y-auto h-full">
      <div>
        <h3 className="text-sm font-semibold text-slate-700 mb-3">Node Changes</h3>
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: 'Added',     count: added,     color: 'text-green-600 bg-green-50 border-green-200' },
            { label: 'Removed',   count: removed,   color: 'text-red-600 bg-red-50 border-red-200' },
            { label: 'Changed',   count: changed,   color: 'text-amber-600 bg-amber-50 border-amber-200' },
            { label: 'Unchanged', count: unchanged, color: 'text-slate-600 bg-slate-50 border-slate-200' },
          ].map(item => (
            <div key={item.label} className={clsx('rounded-xl border p-3 text-center', item.color)}>
              <div className="text-2xl font-bold">{item.count}</div>
              <div className="text-xs font-medium mt-0.5">{item.label}</div>
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-400 mt-2">
          Total: {nodesV1.length} → {nodesV2.length} nodes ({nodesV2.length - nodesV1.length >= 0 ? '+' : ''}{nodesV2.length - nodesV1.length})
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <VersionMeta snapshot={v1} label={`v${v1?.version}`} />
        <VersionMeta snapshot={v2} label={`v${v2?.version}`} />
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────

function ComparePageInner() {
  const params       = useParams()
  const searchParams = useSearchParams()
  const router       = useRouter()
  const agentId      = params.id as string
  const v1Param      = searchParams.get('v1') || ''
  const v2Param      = searchParams.get('v2') || ''

  const [data, setData]       = useState<{ v1: any; v2: any } | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab]         = useState<'flow' | 'text' | 'summary'>('flow')

  useEffect(() => {
    if (!v1Param || !v2Param) return
    fetch(`${MARKETPLACE_URL}/agents/${agentId}/versions/compare?v1=${v1Param}&v2=${v2Param}`)
      .then(r => r.json())
      .then(d => setData({ v1: d.v1, v2: d.v2 }))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [agentId, v1Param, v2Param])

  const diffMap = data
    ? classifyNodeDiff(
        data.v1?.flow_definition?.nodes || [],
        data.v2?.flow_definition?.nodes || [],
      )
    : {}

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-slate-200 bg-white flex-shrink-0">
        <button onClick={() => router.back()} className="p-1.5 hover:bg-slate-100 rounded-lg">
          <ArrowLeft className="w-4 h-4 text-slate-500" />
        </button>
        <GitCompare className="w-4 h-4 text-brand-500" />
        <h1 className="font-semibold text-slate-900">
          Compare <span className="font-mono text-brand-600">v{v1Param}</span> vs <span className="font-mono text-brand-600">v{v2Param}</span>
        </h1>
        <div className="ml-auto flex gap-1">
          {(['flow', 'text', 'summary'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={clsx('px-3 py-1.5 text-xs font-medium rounded-lg transition-colors', {
                'bg-brand-600 text-white': tab === t,
                'text-slate-600 hover:bg-slate-100': tab !== t,
              })}
            >
              {t === 'flow' ? 'Flow Diff' : t === 'text' ? 'Text Diff' : 'Summary'}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center flex-1 text-slate-400 gap-2">
          <Loader2 className="w-5 h-5 animate-spin" /> Loading comparison…
        </div>
      ) : !data ? (
        <div className="flex items-center justify-center flex-1 text-slate-400 gap-2">
          <AlertCircle className="w-5 h-5" /> Could not load comparison data
        </div>
      ) : (
        <div className="flex-1 overflow-hidden">
          {tab === 'flow' && (
            <div className="h-full flex flex-col">
              {/* Legend */}
              <div className="flex items-center gap-4 px-4 py-2 border-b border-slate-100 bg-slate-50 text-xs flex-shrink-0">
                {Object.entries(DIFF_COLORS).map(([key, val]) => (
                  <span key={key} className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded border-2 inline-block" style={{ borderColor: val.border, backgroundColor: val.bg }} />
                    <span className="capitalize text-slate-500">{key}</span>
                  </span>
                ))}
              </div>
              <div className="flex flex-1 overflow-hidden divide-x divide-slate-200">
                <div className="flex-1 overflow-hidden">
                  <FlowCanvas snapshot={data.v1} diffMap={diffMap} label={`v${v1Param}`} />
                </div>
                <div className="flex-1 overflow-hidden">
                  <FlowCanvas snapshot={data.v2} diffMap={diffMap} label={`v${v2Param}`} />
                </div>
              </div>
            </div>
          )}
          {tab === 'text' && (
            <TextDiff v1={data.v1} v2={data.v2} />
          )}
          {tab === 'summary' && (
            <SummaryTab v1={data.v1} v2={data.v2} agentId={agentId} />
          )}
        </div>
      )}
    </div>
  )
}

export default function ComparePage() {
  return (
    <Suspense>
      <ComparePageInner />
    </Suspense>
  )
}
