'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { ReactFlow, useNodesState, useEdgesState, Background, Controls,
         MiniMap, type Node, type Edge, MarkerType } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  BookOpen, RefreshCw, Loader2, Network, Shield, AlignLeft, Database,
  Info, ChevronRight, ChevronDown, LayoutGrid,
  GitBranch, Layers, X,
} from 'lucide-react'
import { clsx } from 'clsx'

const CONTEXT_GRAPH_URL = process.env.NEXT_PUBLIC_CONTEXT_GRAPH_URL   || 'http://localhost:8008'
const STANDARDS_URL     = process.env.NEXT_PUBLIC_STANDARDS_REGISTRY_URL || 'http://localhost:8012'

// ─── Types ────────────────────────────────────────────────────────────────────

interface FNode {
  id: string; node_type: string; label: string
  metadata: Record<string, unknown>; importance_weight: number
  external_id: string; has_embedding: boolean
}
interface FEdge {
  id: string; source_node_id: string; target_node_id: string
  edge_type: string; weight: number; metadata: Record<string, unknown>
}
interface FoundationGraph {
  nodes: FNode[]; edges: FEdge[]
  stats: { total_nodes: number; total_edges: number; node_types: Record<string, number> }
}

// ─── Type style map ───────────────────────────────────────────────────────────

const TYPE_STYLE: Record<string, { bg: string; border: string; text: string; dot: string; label: string }> = {
  document:       { bg: '#EFF6FF', border: '#93C5FD', text: '#1D4ED8', dot: '#3B82F6', label: 'Document' },
  entity:         { bg: '#F0FDF4', border: '#86EFAC', text: '#166534', dot: '#22C55E', label: 'Entity' },
  concept:        { bg: '#FFF7ED', border: '#FED7AA', text: '#9A3412', dot: '#F97316', label: 'Concept' },
  standard:       { bg: '#EFF6FF', border: '#93C5FD', text: '#1D4ED8', dot: '#3B82F6', label: 'Standard' },
  codelist:       { bg: '#ECFDF5', border: '#6EE7B7', text: '#047857', dot: '#10B981', label: 'Codelist' },
  regulatory_req: { bg: '#F5F3FF', border: '#C4B5FD', text: '#6D28D9', dot: '#8B5CF6', label: 'Requirement' },
  sdtm_domain:    { bg: '#FFFBEB', border: '#FCD34D', text: '#B45309', dot: '#F59E0B', label: 'SDTM Domain' },
  usdm_concept:   { bg: '#FDF4FF', border: '#E879F9', text: '#86198F', dot: '#D946EF', label: 'USDM Concept' },
}

function styleFor(type: string) {
  return TYPE_STYLE[type] ?? { bg: '#F9FAFB', border: '#E5E7EB', text: '#374151', dot: '#6B7280', label: type }
}

// ─── Build hierarchical ReactFlow graph ───────────────────────────────────────

function buildHierarchicalFlow(
  graphData: FoundationGraph,
  focusNodeId: string | null,
): { nodes: Node[]; edges: Edge[] } {
  const { nodes: fn, edges: fe } = graphData
  const nodeById = new Map(fn.map(n => [n.id, n]))

  // Determine which nodes to show.
  // If a document is focused, keep only that document and its connected non-document subgraph.
  let visibleNodeIds: Set<string>
  if (focusNodeId && nodeById.get(focusNodeId)?.node_type === 'document') {
    visibleNodeIds = new Set([focusNodeId])
    const queue = [focusNodeId]

    while (queue.length > 0) {
      const cur = queue.shift()!
      for (const e of fe) {
        if (e.source_node_id !== cur && e.target_node_id !== cur) continue

        const otherId = e.source_node_id === cur ? e.target_node_id : e.source_node_id
        const other = nodeById.get(otherId)
        if (!other) continue

        // Never pull in other document roots; keep subgraph scoped to selected document.
        if (other.node_type === 'document' && otherId !== focusNodeId) continue

        if (!visibleNodeIds.has(otherId)) {
          visibleNodeIds.add(otherId)
          queue.push(otherId)
        }
      }
    }
  } else if (focusNodeId) {
    visibleNodeIds = new Set([focusNodeId])
    for (const e of fe) {
      if (e.source_node_id === focusNodeId) visibleNodeIds.add(e.target_node_id)
      if (e.target_node_id === focusNodeId) visibleNodeIds.add(e.source_node_id)
    }
  } else {
    visibleNodeIds = new Set(fn.map(n => n.id))
  }

  const visibleNodes = fn.filter(n => visibleNodeIds.has(n.id))
  const visibleEdges = fe.filter(e => {
    if (!visibleNodeIds.has(e.source_node_id) || !visibleNodeIds.has(e.target_node_id)) return false
    if (!focusNodeId) return true
    const srcType = nodeById.get(e.source_node_id)?.node_type
    const tgtType = nodeById.get(e.target_node_id)?.node_type
    // When focused on a document, suppress edges to other documents entirely.
    if (srcType === 'document' && e.source_node_id !== focusNodeId) return false
    if (tgtType === 'document' && e.target_node_id !== focusNodeId) return false
    return true
  })

  // Document-graph-like column layout for easier correlation:
  // document -> chunk -> entity -> concept -> other.
  const COL_X = { document: 60, chunk: 300, entity: 540, concept: 780, other: 1020 }
  const ROW_H = 110
  const byCol: Record<string, FNode[]> = { document: [], chunk: [], entity: [], concept: [], other: [] }

  for (const n of visibleNodes) {
    if (n.node_type === 'document') byCol.document.push(n)
    else if (n.node_type === 'chunk') byCol.chunk.push(n)
    else if (n.node_type === 'entity') byCol.entity.push(n)
    else if (n.node_type === 'concept') byCol.concept.push(n)
    else byCol.other.push(n)
  }

  const posMap: Record<string, { x: number; y: number }> = {}
  for (const [col, nodes] of Object.entries(byCol)) {
    const startY = -((nodes.length - 1) * ROW_H) / 2
    nodes.forEach((n, i) => {
      posMap[n.id] = {
        x: COL_X[col as keyof typeof COL_X] ?? COL_X.other,
        y: startY + i * ROW_H,
      }
    })
  }

  const rfNodes: Node[] = visibleNodes.map(n => {
    const s = styleFor(n.node_type)
    const isDoc = n.node_type === 'document'
    const isFocused = n.id === focusNodeId
    return {
      id: n.id,
      position: posMap[n.id] ?? { x: 0, y: 0 },
      data: {
        label: (
          <div
            className="text-left"
            style={{ maxWidth: isDoc ? 185 : 165 }}
            title={n.label}
          >
            <div
              className={clsx('font-semibold truncate', isDoc ? 'text-sm' : 'text-xs')}
              style={{ color: s.text }}
            >
              {n.label}
            </div>
            {n.node_type === 'document' && n.metadata?.doc_type != null && (
              <div className="text-xs mt-0.5" style={{ color: s.text, opacity: 0.7 }}>
                {String(n.metadata.doc_type).replace(/_/g, ' ').toUpperCase()}
              </div>
            )}
            {n.node_type === 'entity' && n.metadata?.entity_type != null && (
              <div className="text-xs mt-0.5" style={{ color: s.text, opacity: 0.7 }}>
                {String(n.metadata.entity_type)}
              </div>
            )}
            {n.node_type === 'regulatory_req' && n.metadata?.authority != null && (
              <div className="text-xs mt-0.5" style={{ color: s.text, opacity: 0.7 }}>
                {String(n.metadata.authority)} · {n.metadata.category != null ? String(n.metadata.category) : ''}
              </div>
            )}
            {n.node_type === 'codelist' && (
              <div className="text-xs mt-0.5" style={{ color: s.text, opacity: 0.7 }}>
                {n.metadata?.codelist_code != null ? String(n.metadata.codelist_code) : ''}
                {n.metadata?.is_extensible ? ' · extensible' : ''}
              </div>
            )}
            {n.node_type === 'standard' && n.metadata?.publisher != null && (
              <div className="text-xs mt-0.5" style={{ color: s.text, opacity: 0.7 }}>
                {String(n.metadata.publisher)}
              </div>
            )}
          </div>
        ),
      },
      style: {
        background: s.bg,
        border: `${isFocused ? 2.5 : 1.5}px solid ${isFocused ? s.dot : s.border}`,
        borderRadius: isDoc ? 10 : 8,
        padding: isDoc ? '8px 12px' : '5px 10px',
        width: isDoc ? 205 : 185,
        boxShadow: isFocused ? `0 0 0 3px ${s.dot}33` : undefined,
        cursor: 'pointer',
      },
    }
  })

  const rfEdges: Edge[] = visibleEdges.map(e => ({
    id: e.id,
    source: e.source_node_id,
    target: e.target_node_id,
    label: e.edge_type,
    type: 'smoothstep',
    style: { stroke: '#CBD5E1', strokeWidth: 1.5 },
    labelStyle: { fontSize: 9, fill: '#94A3B8', fontFamily: 'monospace' },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#CBD5E1', width: 14, height: 14 },
    animated: false,
  }))

  return { nodes: rfNodes, edges: rfEdges }
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, color, loading }: {
  label: string; value: number; color: string; loading: boolean
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl px-5 py-3 min-w-[120px]">
      <p className={clsx('text-2xl font-bold', color)}>{loading ? '—' : value}</p>
      <p className="text-xs text-slate-500 mt-0.5">{label}</p>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function FoundationGraphPage() {
  const [graph, setGraph]             = useState<FoundationGraph | null>(null)
  const [loading, setLoading]         = useState(true)
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null)
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null)
  const [selectedNode, setSelectedNode] = useState<FNode | null>(null)
  const [view, setView]               = useState<'graph' | 'registry'>('graph')

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([])
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([])

  const loadGraph = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${CONTEXT_GRAPH_URL}/graph/foundation`)
      if (res.ok) {
        const data: FoundationGraph = await res.json()
        setGraph(data)
        setLastRefreshed(new Date().toLocaleTimeString())
      }
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }, [])

  useEffect(() => { loadGraph() }, [])

  useEffect(() => {
    if (!graph) return
    const { nodes, edges } = buildHierarchicalFlow(graph, focusNodeId)
    setRfNodes(nodes)
    setRfEdges(edges)
  }, [graph, focusNodeId])

  // Canvas click: show details only — never change graph focus from here
  function handleNodeClick(_: unknown, rfNode: Node) {
    if (!rfNode.id) { setSelectedNode(null); return }
    const found = graph?.nodes.find(n => n.id === rfNode.id) ?? null
    if (found?.node_type === 'document') {
      setFocusNodeId(found.id)
    }
    setSelectedNode(found)
  }

  const stats   = graph?.stats
  const edges   = graph?.edges ?? []

  // Count outgoing edges from a node (used for document→entity connections)
  const stdChildCount = useCallback((nodeId: string) => {
    return edges.filter(e => e.source_node_id === nodeId).length
  }, [edges])

  return (
    <div className="flex flex-col h-full bg-slate-50 overflow-hidden">

      {/* ── Header ── */}
      <div className="bg-white border-b border-slate-200 px-6 py-4 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-50 border border-blue-200 flex items-center justify-center">
              <Layers className="w-4 h-4 text-blue-600" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                Foundation Context Graph
                <span className="text-xs font-normal text-slate-400 bg-slate-100 px-2 py-0.5 rounded">L1 Layer</span>
              </h1>
              <p className="text-xs text-slate-500 mt-0.5">
                Documents marked as foundational in the Document library
                {lastRefreshed && <span className="ml-2 text-slate-400">· Refreshed {lastRefreshed}</span>}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex bg-slate-100 rounded-lg p-0.5">
              {([['graph','Graph',GitBranch],['registry','Registry',LayoutGrid]] as const).map(([v,l,Icon]) => (
                <button key={v} onClick={() => setView(v)}
                  className={clsx('flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors',
                    view === v ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700')}>
                  <Icon className="w-3.5 h-3.5" />{l}
                </button>
              ))}
            </div>
            <button onClick={loadGraph} disabled={loading}
              className="flex items-center gap-2 px-4 py-2 bg-slate-100 text-slate-700 text-sm font-medium rounded-lg hover:bg-slate-200 disabled:opacity-60 transition-colors">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Refresh
            </button>
          </div>
        </div>

        {/* Stats row */}
        <div className="mt-3 flex items-center gap-3">
          <StatCard label="Total Nodes" value={stats?.total_nodes ?? 0}          color="text-slate-700"    loading={loading} />
          <StatCard label="Documents"   value={stats?.node_types?.document ?? 0} color="text-blue-600"     loading={loading} />
          <StatCard label="Entities"    value={stats?.node_types?.entity ?? 0}   color="text-emerald-600"  loading={loading} />
          <StatCard label="Concepts"    value={stats?.node_types?.concept ?? 0}  color="text-violet-600"   loading={loading} />
          <StatCard label="Edges"       value={stats?.total_edges ?? 0}          color="text-slate-500"    loading={loading} />

          {focusNodeId && (
            <button onClick={() => { setFocusNodeId(null); setSelectedNode(null) }}
              className="ml-2 flex items-center gap-1.5 px-3 py-2 bg-blue-50 text-blue-700 text-xs font-medium rounded-lg hover:bg-blue-100 transition-colors">
              <X className="w-3.5 h-3.5" />
              Clear focus
            </button>
          )}
        </div>
      </div>

      {/* ── Body ── */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center"><Loader2 className="w-8 h-8 text-blue-500 animate-spin mx-auto mb-3" />
            <p className="text-sm text-slate-500">Loading foundation graph…</p></div>
        </div>
      ) : !graph || stats?.total_nodes === 0 ? (
        <EmptyState />
      ) : view === 'graph' ? (
        <GraphView
          rfNodes={rfNodes} rfEdges={rfEdges}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          selectedNode={selectedNode} graph={graph!}
          nodeChildCount={stdChildCount} focusNodeId={focusNodeId}
          onFocusDocument={id => { setFocusNodeId(id); setSelectedNode(null) }}
          onClearFocus={() => { setFocusNodeId(null); setSelectedNode(null) }}
          edges={edges}
        />
      ) : (
        <RegistryView
          graph={graph!}
          onSelectNode={setSelectedNode} selectedNode={selectedNode}
        />
      )}
    </div>
  )
}

// ─── Graph View ───────────────────────────────────────────────────────────────

function GraphView({ rfNodes, rfEdges, onNodesChange, onEdgesChange, onNodeClick,
  selectedNode, graph, nodeChildCount, focusNodeId, onFocusDocument, onClearFocus, edges }: {
  rfNodes: Node[]; rfEdges: Edge[]
  onNodesChange: (c: any) => void; onEdgesChange: (c: any) => void
  onNodeClick: (e: any, n: Node) => void
  selectedNode: FNode | null; graph: FoundationGraph
  nodeChildCount: (id: string) => number; focusNodeId: string | null
  onFocusDocument: (id: string) => void; onClearFocus: () => void
  edges: FEdge[]
}) {
  const docNodes = graph.nodes.filter(n => n.node_type === 'document')

  return (
    <div className="flex flex-1 min-h-0">
      {/* Documents rail */}
      <div className="w-64 border-r border-slate-200 bg-white flex flex-col overflow-hidden flex-shrink-0">
        <div className="px-4 py-2.5 border-b border-slate-100 bg-slate-50">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Foundational Docs</p>
          <p className="text-xs text-slate-400 mt-0.5">Click to focus connections</p>
        </div>
        <div className="flex-1 overflow-y-auto py-2 px-3 space-y-1">
          {docNodes.map(doc => {
            const s = styleFor('document')
            const childCount = nodeChildCount(doc.id)
            const active = focusNodeId === doc.id
            const hasConnections = childCount > 0
            return (
              <button key={doc.id} onClick={() => onFocusDocument(doc.id)}
                className={clsx('w-full text-left px-3 py-2.5 rounded-lg transition-colors border',
                  active
                    ? 'bg-blue-50 border-blue-200 ring-1 ring-blue-200'
                    : 'border-transparent hover:bg-slate-50')}>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ background: hasConnections ? s.dot : '#CBD5E1' }} />
                  <p className="text-sm truncate flex-1 font-medium text-slate-800">
                    {doc.label}
                  </p>
                  {hasConnections ? (
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 font-mono flex-shrink-0">
                      {childCount}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-300 flex-shrink-0">—</span>
                  )}
                </div>
                {doc.metadata?.doc_type != null && (
                  <p className="text-xs text-slate-400 mt-0.5 pl-4">
                    {String(doc.metadata.doc_type).replace(/_/g, ' ').toUpperCase()}
                  </p>
                )}
              </button>
            )
          })}
        </div>
        <div className="px-4 py-3 border-t border-slate-100 bg-slate-50">
          <div className="space-y-1.5">
            {(['document', 'entity', 'concept'] as const).map(type => {
              const ts = styleFor(type)
              return (
                <div key={type} className="flex items-center gap-2 text-xs text-slate-500">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ background: ts.dot }} />
                  {ts.label}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Main graph canvas */}
      <div className="flex-1 relative bg-slate-50">

        {/* Focus breadcrumb */}
        {focusNodeId && (() => {
          const focusedNode = graph.nodes.find(n => n.id === focusNodeId)
          const childCount = nodeChildCount(focusNodeId)
          return (
            <div className="absolute top-3 left-3 z-10 bg-white border border-slate-200 text-slate-700 text-xs px-3 py-2 rounded-lg shadow-sm flex items-center gap-2">
              <Network className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
              <span className="font-medium">{focusedNode?.label ?? 'Document'}</span>
              {childCount > 0
                ? <span className="text-slate-400">· {childCount} connected nodes</span>
                : <span className="text-amber-500">· no connected nodes</span>
              }
              <button onClick={onClearFocus} className="ml-1 text-slate-400 hover:text-slate-700">
                <X className="w-3 h-3" />
              </button>
            </div>
          )
        })()}

        {focusNodeId && nodeChildCount(focusNodeId) === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center max-w-xs bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
              {(() => {
                const focNode = graph.nodes.find(n => n.id === focusNodeId)
                const s = styleFor(focNode?.node_type ?? 'document')
                return (
                  <>
                    <div className="w-10 h-10 rounded-lg mx-auto mb-3 flex items-center justify-center"
                      style={{ background: s.bg, border: `1px solid ${s.border}` }}>
                      <Network className="w-5 h-5" style={{ color: s.dot }} />
                    </div>
                    <p className="font-semibold text-slate-800 mb-1">{focNode?.label}</p>
                    <p className="text-xs text-slate-400 mt-3">
                      No connected nodes found for this document yet.
                    </p>
                    <button onClick={onClearFocus}
                      className="mt-4 text-xs text-blue-600 hover:underline">
                      Show full graph
                    </button>
                  </>
                )
              })()}
            </div>
          </div>
        ) : (
          <ReactFlow
            nodes={rfNodes} edges={rfEdges}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick} fitView fitViewOptions={{ padding: 0.2 }}
            minZoom={0.1} maxZoom={2}
          >
            <Background color="#E2E8F0" gap={24} size={1} />
            <Controls />
            <MiniMap
              nodeColor={n => {
                const fn = graph.nodes.find(fn => fn.id === n.id)
                return fn ? (styleFor(fn.node_type).dot) : '#9CA3AF'
              }}
              style={{ background: '#F8FAFC', border: '1px solid #E2E8F0' }}
            />
          </ReactFlow>
        )}
      </div>

      {/* Node detail panel — click any node to open; click × to close */}
      {selectedNode ? (
        <div className="w-72 border-l border-slate-200 bg-white flex flex-col overflow-hidden flex-shrink-0">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ background: styleFor(selectedNode.node_type).dot }} />
              <p className="text-sm font-semibold text-slate-800 truncate">{selectedNode.label}</p>
            </div>
            <button onClick={() => onNodeClick(null, { id: '' } as any)}
              className="text-slate-400 hover:text-slate-600 flex-shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
            <NodeDetailContent node={selectedNode} graph={{ nodes: graph.nodes, edges: graph.edges }} />
          </div>
        </div>
      ) : (
        <div className="w-56 border-l border-slate-100 bg-white flex items-center justify-center">
          <p className="text-xs text-slate-400 text-center px-4">
            Click any node<br />to see details
          </p>
        </div>
      )}
    </div>
  )
}

// ─── Registry View ────────────────────────────────────────────────────────────

function RegistryView({ graph, onSelectNode, selectedNode }: {
  graph: FoundationGraph
  onSelectNode: (n: FNode) => void; selectedNode: FNode | null
}) {
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null)

  const documents = graph.nodes.filter(n => n.node_type === 'document')
  const allEntities = graph.nodes.filter(n => n.node_type === 'entity' || n.node_type === 'concept')

  const docChildren = (docId: string) => {
    const childIds = new Set(
      graph.edges.filter(e => e.source_node_id === docId).map(e => e.target_node_id)
    )
    return allEntities.filter(e => childIds.has(e.id))
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-5xl mx-auto space-y-3">
        {documents.map(doc => {
          const children = docChildren(doc.id)
          const s = styleFor('document')
          const expanded = expandedDoc === doc.id
          return (
            <div key={doc.id} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <button onClick={() => setExpandedDoc(expanded ? null : doc.id)}
                className="w-full flex items-center justify-between px-5 py-4 hover:bg-slate-50 transition-colors text-left">
                <div className="flex items-center gap-3">
                  <div className="w-3 h-3 rounded-full" style={{ background: s.dot }} />
                  <div>
                    <p className="font-semibold text-slate-900">{doc.label}</p>
                    {doc.metadata?.doc_type != null && (
                      <p className="text-xs text-slate-500 mt-0.5">
                        {String(doc.metadata.doc_type).replace(/_/g, ' ').toUpperCase()}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {children.length > 0 && (
                    <span className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full font-medium">
                      {children.length} entities
                    </span>
                  )}
                  {expanded ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
                </div>
              </button>
              {expanded && children.length > 0 && (
                <div className="border-t border-slate-100 px-5 py-3">
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                    {children.map(child => {
                      const cs = styleFor(child.node_type)
                      return (
                        <button key={child.id} onClick={() => onSelectNode(child)}
                          className={clsx('text-left p-2.5 rounded-lg border transition-colors',
                            selectedNode?.id === child.id ? 'ring-2' : 'hover:shadow-sm')}
                          style={{ background: cs.bg, borderColor: cs.border }}>
                          <p className="text-xs font-medium truncate" style={{ color: cs.text }}>{child.label}</p>
                          {child.metadata?.entity_type != null && (
                            <p className="text-xs opacity-60 mt-0.5" style={{ color: cs.text }}>
                              {String(child.metadata.entity_type)}
                            </p>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              {expanded && children.length === 0 && (
                <div className="border-t border-slate-100 px-5 py-4 text-sm text-slate-400">
                  No connected entities found for this document
                </div>
              )}
            </div>
          )
        })}
        {documents.length === 0 && (
          <div className="text-center text-slate-400 py-12 text-sm">
            No foundational documents uploaded yet
          </div>
        )}
      </div>

      {selectedNode && (
        <div className="fixed right-6 top-1/3 w-80 bg-white rounded-xl border border-slate-200 shadow-xl z-10 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: styleFor(selectedNode.node_type).dot }} />
              <p className="text-sm font-semibold text-slate-800 truncate">{selectedNode.label}</p>
            </div>
            <button onClick={() => onSelectNode(null as any)} className="text-slate-400 hover:text-slate-600 flex-shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="p-4 space-y-3 max-h-80 overflow-y-auto">
            <NodeDetailContent node={selectedNode} graph={{ nodes: graph.nodes, edges: graph.edges }} />
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Node detail content (shared) ────────────────────────────────────────────

function NodeDetailContent({ node, graph }: {
  node: FNode; graph: { nodes: FNode[]; edges: FEdge[] }
}) {
  const s = styleFor(node.node_type)
  const connections = graph.edges.filter(e =>
    e.source_node_id === node.id || e.target_node_id === node.id
  )

  return (
    <>
      <div>
        <span className="text-xs px-2 py-0.5 rounded-full font-medium"
          style={{ background: s.bg, color: s.text, border: `1px solid ${s.border}` }}>
          {s.label}
        </span>
      </div>

      <div className="space-y-2 text-xs">
        {node.external_id && (
          <div className="flex justify-between gap-2">
            <span className="text-slate-400">ID</span>
            <span className="font-mono text-slate-500 text-right break-all">{node.external_id}</span>
          </div>
        )}
        {Object.entries(typeof node.metadata === 'string' ? ((): Record<string,unknown> => { try { return JSON.parse(node.metadata as unknown as string) } catch { return {} } })() : (node.metadata ?? {})).map(([k, v]) =>
          k !== 'source' && v != null && String(v).length > 0 && (
            <div key={k} className="flex justify-between gap-2">
              <span className="text-slate-400 capitalize flex-shrink-0">{k.replace(/_/g, ' ')}</span>
              <span className="text-slate-700 text-right break-words">
                {Array.isArray(v) ? (v as string[]).join(', ') : String(v)}
              </span>
            </div>
          )
        )}
      </div>

      {connections.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-400 mb-1.5">CONNECTIONS ({connections.length})</p>
          <div className="space-y-1">
            {connections.slice(0, 6).map(e => {
              const otherId = e.source_node_id === node.id ? e.target_node_id : e.source_node_id
              const other = graph.nodes.find(n => n.id === otherId)
              const dir = e.source_node_id === node.id ? '→' : '←'
              return (
                <div key={e.id} className="text-xs flex gap-1.5 items-baseline">
                  <span className="text-slate-300 font-mono">{dir}</span>
                  <span className="bg-slate-100 text-slate-500 px-1 rounded font-mono">{e.edge_type}</span>
                  <span className="text-slate-600 truncate">{other?.label ?? '…'}</span>
                </div>
              )
            })}
            {connections.length > 6 && <p className="text-xs text-slate-400">+{connections.length - 6} more</p>}
          </div>
        </div>
      )}
    </>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center max-w-sm">
        <div className="w-16 h-16 rounded-2xl bg-slate-50 border border-slate-100 flex items-center justify-center mx-auto mb-4">
          <Layers className="w-8 h-8 text-slate-400" />
        </div>
        <p className="text-slate-700 font-semibold text-lg">No foundational documents yet</p>
        <p className="text-sm text-slate-500 mt-2">
          Upload documents in the Document library and mark them as foundational to build the graph.
        </p>
      </div>
    </div>
  )
}
