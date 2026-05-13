'use client'
import { useState, useEffect, useCallback } from 'react'
import { ReactFlow, useNodesState, useEdgesState, addEdge,
         Background, Controls, MiniMap, type Node, type Edge, type Connection,
         Handle, Position } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { clsx } from 'clsx'
import {
  Database, FileText, Tag, Lightbulb, Cpu, AlertCircle, Loader2, X, RefreshCw,
  BookOpen, AlignLeft, Table2, Image as ImageIcon, Layers, GitBranch,
  Activity, Zap, ChevronLeft, ChevronRight, CheckCircle,
} from 'lucide-react'

const CONTEXT_GRAPH_URL = process.env.NEXT_PUBLIC_CONTEXT_GRAPH_URL || 'http://localhost:8008'

// ─── Types ────────────────────────────────────────────────────────────────────

interface GraphNode {
  id: string
  type: string
  label: string
  metadata: Record<string, unknown>
  importance: number
  has_embedding: boolean
}

interface GraphEdge {
  source: string
  target: string
  type: string
  weight: number
}

interface GraphStats {
  status: string
  total_chunks: number
  embedded_chunks: number
  chunks_capped?: boolean
  total_entities: number
  total_concepts: number
  context_index_entries: number
  index_quality: number | null
  embedding_dim: number
  embedding_model: string
  index_type: string
  index_health?: string
}

interface DocumentGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  stats: GraphStats
}

interface ProcessingLogEntry {
  id: string
  step: string
  event: string        // 'started' | 'progress' | 'completed' | 'failed'
  message: string
  metadata: Record<string, unknown>
  created_at: string
}

interface DocIntelligence {
  document: {
    id: string; name: string; file_name: string; document_type: string
    status: string; file_size_bytes: number; sha256_hash: string
    version: string; source_type: string; created_at: string
    updated_at: string; error_message: string | null
  }
  classification: {
    method: string; suggested_types: string[]
    confidence_scores: Record<string, number>; llm_analysis: string | null
    key_phrases: string[]; structure_description: string
  }
  chunk_stats: {
    total: number; text_chunks: number; tables: number
    figures: number; table_rows: number; embedded: number; max_page: number
    avg_chars: number; avg_chars_text: number; avg_chars_table: number
    avg_chars_figure: number; avg_chars_table_row: number
    section_count: number; chunk_strategy: 'toc_driven' | 'page_based' | 'hybrid' | 'xpt_tabular'
  }
  tables: Array<{
    chunk_index: number; page_number: number; section: string
    content: string; columns: string[]; row_count: number
  }>
  images: Array<{
    chunk_index: number; page_number: number; section: string
    caption: string; image_url: string
  }>
  extracted_files: Array<{
    document_id: string; file_name: string; name: string
    document_type: string; file_size_bytes: number
    created_at: string | null
    domain: string | null
    row_count: number | null
    unique_subjects: number | null
    unique_sites: number | null
  }>
  graph_summary: {
    entity_breakdown: Array<{ type: string; count: number }>
    edge_breakdown: Array<{ type: string; count: number }>
    total_concepts: number
    index_entries: number
    index_quality: number | null
    index_health: string
    embedding_dim: number
    embedding_model: string
  } | null
  processing_logs: ProcessingLogEntry[]
}

type Tab = 'overview' | 'statistics' | 'content' | 'graph' | 'intelligence'

// ─── Node color + icon config ─────────────────────────────────────────────────

const NODE_STYLE: Record<string, { border: string; bg: string; icon: React.ElementType; iconColor: string }> = {
  document: { border: 'border-brand-500',  bg: 'bg-brand-50',  icon: FileText,   iconColor: 'text-brand-500' },
  chunk:    { border: 'border-slate-400',  bg: 'bg-white',     icon: Database,   iconColor: 'text-slate-400' },
  entity:   { border: 'border-green-500',  bg: 'bg-green-50',  icon: Tag,        iconColor: 'text-green-500' },
  concept:  { border: 'border-purple-500', bg: 'bg-purple-50', icon: Lightbulb,  iconColor: 'text-purple-500' },
}

const EDGE_COLOR: Record<string, string> = {
  contains:       '#94a3b8',
  extracted_from: '#22c55e',
  is_type:        '#a855f7',
  references:     '#f59e0b',
  cites:          '#3b82f6',
  co_occurs_with: '#ec4899',
}

// ─── Custom node components ───────────────────────────────────────────────────

function GraphCard({ data }: { data: Record<string, unknown> }) {
  const nodeType = data.nodeType as string
  const style = NODE_STYLE[nodeType] || NODE_STYLE.chunk
  const Icon = style.icon
  const hasEmbedding = data.hasEmbedding as boolean
  const importance = data.importance as number

  return (
    <div className={clsx(
      'rounded-lg border-l-4 shadow-sm text-left w-40',
      style.border, style.bg,
      'border border-slate-200'
    )}>
      {nodeType !== 'document' && (
        <Handle type="target" position={Position.Left} className="!w-2 !h-2 !border !bg-slate-400" />
      )}
      <div className="px-2.5 py-2">
        <div className="flex items-center gap-1.5 mb-1">
          <Icon className={clsx('w-3 h-3 flex-shrink-0', style.iconColor)} />
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{nodeType}</span>
          {hasEmbedding && (
            <span title="Has vector embedding" className="ml-auto w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />
          )}
        </div>
        <p className="text-xs font-medium text-slate-800 leading-tight line-clamp-2">
          {data.label as string}
        </p>
        {nodeType === 'entity' && data.entityType != null && (
          <span className="mt-1 inline-block text-[10px] px-1.5 py-0.5 bg-green-100 text-green-700 rounded-full">
            {String(data.entityType)}
          </span>
        )}
        {importance < 0.9 && (
          <div className="mt-1.5 flex items-center gap-1">
            <div className="flex-1 h-1 bg-slate-200 rounded-full overflow-hidden">
              <div className="h-full bg-brand-400 rounded-full" style={{ width: `${Math.round(importance * 100)}%` }} />
            </div>
            <span className="text-[10px] text-slate-400">{Math.round(importance * 100)}%</span>
          </div>
        )}
      </div>
      {nodeType !== 'concept' && (
        <Handle type="source" position={Position.Right} className="!w-2 !h-2 !border !bg-slate-400" />
      )}
    </div>
  )
}

const nodeTypes = { graphCard: GraphCard }

// ─── Layout helper ────────────────────────────────────────────────────────────

const ENTITY_LIKE_TYPES = new Set(['entity', 'sdtm_domain', 'sdtm_variable', 'codelist', 'codelist_term'])

function layoutNodes(rawNodes: GraphNode[]): Node[] {
  const byType: Record<string, GraphNode[]> = { document: [], chunk: [], entity: [], concept: [] }
  for (const n of rawNodes) {
    if (ENTITY_LIKE_TYPES.has(n.type)) {
      byType['entity'].push(n)
    } else {
      byType[n.type]?.push(n)
    }
  }

  const COL_X = { document: 60, chunk: 280, entity: 520, concept: 760 }
  const ROW_H = 110
  const result: Node[] = []

  for (const [type, nodes] of Object.entries(byType)) {
    const startY = -(nodes.length - 1) * ROW_H / 2
    nodes.forEach((n, i) => {
      const meta = n.metadata || {}
      result.push({
        id: n.id,
        type: 'graphCard',
        position: { x: COL_X[type as keyof typeof COL_X] ?? 60, y: startY + i * ROW_H },
        data: {
          label:       n.label,
          nodeType:    n.type,
          importance:  n.importance,
          hasEmbedding: n.has_embedding,
          entityType:  meta.type as string | undefined,
        },
      })
    })
  }
  return result
}

function layoutEdges(rawEdges: GraphEdge[]): Edge[] {
  return rawEdges.map((e, i) => ({
    id:             `e-${i}`,
    source:         e.source,
    target:         e.target,
    label:          e.type.replace(/_/g, ' '),
    animated:       e.type === 'extracted_from' || e.type === 'contains',
    style:          { stroke: EDGE_COLOR[e.type] || '#94a3b8', strokeWidth: Math.max(1, e.weight * 1.5) },
    labelStyle:     { fontSize: 9, fill: '#94a3b8' },
    labelBgStyle:   { fill: 'white', opacity: 0.8 },
  }))
}

// ─── Stats Panel ──────────────────────────────────────────────────────────────

function StatsPanel({ stats }: { stats: GraphStats }) {
  const pct = stats.total_chunks > 0
    ? Math.round((stats.embedded_chunks / stats.total_chunks) * 100)
    : 0

  return (
    <div className="w-64 flex-shrink-0 border-l border-slate-200 bg-white p-4 space-y-4 overflow-y-auto">
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-1">
          <Cpu className="w-3.5 h-3.5" /> Graph Statistics
        </p>
        <div className="space-y-1.5">
          {[
            ['Document nodes', '1'],
            ['Chunk nodes',    String(stats.total_chunks)],
            ['Entity nodes',   String(stats.total_entities)],
            ['Concept nodes',  String(stats.total_concepts)],
          ].map(([label, val]) => (
            <div key={label} className="flex items-center justify-between text-xs">
              <span className="text-slate-500">{label}</span>
              <span className="font-semibold text-slate-800">{val}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-1">
          <Database className="w-3.5 h-3.5" /> Vector Index
        </p>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-500">Model</span>
            <span className="font-mono text-[10px] text-slate-700">{stats.embedding_model}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-500">Dimensions</span>
            <span className="font-semibold text-slate-800">{stats.embedding_dim}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-500">Index type</span>
            <span className="font-mono text-[10px] text-slate-700">{stats.index_type}</span>
          </div>
          {stats.index_health && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-500">Index health</span>
              <span className={clsx(
                'font-semibold text-[10px]',
                stats.index_health === 'ready' ? 'text-green-600' : 'text-amber-500'
              )}>
                {stats.index_health === 'ready' ? 'Ready' : 'Needs more data'}
              </span>
            </div>
          )}
        </div>

        <div className="mt-3">
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-slate-500">Chunks vectorized</span>
            <span className="font-semibold text-slate-800">{stats.embedded_chunks}/{stats.total_chunks}</span>
          </div>
          <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={clsx(
                'h-full rounded-full transition-all',
                pct === 100 ? 'bg-green-400' : pct > 50 ? 'bg-brand-400' : 'bg-amber-400'
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-[10px] text-slate-400 mt-0.5">{pct}% indexed</p>
          {stats.chunks_capped && (
            <p className="text-[10px] text-amber-500 mt-1">
              Large document — graph shows first 100 chunks
            </p>
          )}
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Context Index</p>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-500">Index entries</span>
            <span className="font-semibold text-slate-800">{stats.context_index_entries}</span>
          </div>
          {stats.index_quality != null && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-500">Quality score</span>
              <span className={clsx(
                'font-semibold',
                stats.index_quality >= 0.7 ? 'text-green-600' :
                stats.index_quality >= 0.4 ? 'text-amber-600' : 'text-red-500'
              )}>
                {Math.round(stats.index_quality * 100)}%
              </span>
            </div>
          )}
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Legend</p>
        <div className="space-y-1">
          {Object.entries(NODE_STYLE).map(([type, s]) => {
            const Icon = s.icon
            return (
              <div key={type} className="flex items-center gap-2 text-xs text-slate-600">
                <div className={clsx('w-3 h-3 rounded border-l-2 flex-shrink-0', s.border, s.bg)} />
                <Icon className={clsx('w-3 h-3', s.iconColor)} />
                <span className="capitalize">{type}</span>
              </div>
            )
          })}
        </div>
        <div className="mt-2 space-y-1">
          {Object.entries(EDGE_COLOR).slice(0, 5).map(([type, color]) => (
            <div key={type} className="flex items-center gap-2 text-xs text-slate-500">
              <div className="w-5 h-0.5 rounded" style={{ backgroundColor: color }} />
              <span>{type.replace(/_/g, ' ')}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Graph canvas (lazy-loaded) ───────────────────────────────────────────────

function GraphCanvas({ documentId, orgId }: { documentId: string; orgId: string }) {
  const [graph, setGraph] = useState<DocumentGraph | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const onConnect = useCallback(
    (params: Connection) => setEdges(es => addEdge(params, es)),
    [setEdges]
  )

  useEffect(() => {
    setLoading(true)
    fetch(`${CONTEXT_GRAPH_URL}/graph/document/${documentId}?org_id=${orgId}`)
      .then(r => r.json())
      .then((data: DocumentGraph) => {
        setGraph(data)
        if (data.stats.status === 'not_indexed') { setLoading(false); return }
        setNodes(layoutNodes(data.nodes))
        setEdges(layoutEdges(data.edges))
        setLoading(false)
      })
      .catch(() => {
        setError('Could not load graph — context-graph service may be offline')
        setLoading(false)
      })
  }, [documentId, orgId, setNodes, setEdges])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-sm text-slate-400">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading graph…
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-slate-400">
        <AlertCircle className="w-4 h-4" /> {error}
      </div>
    )
  }
  if (graph?.stats.status === 'not_indexed') {
    return (
      <div className="p-4 text-sm text-slate-400 text-center">
        Graph not yet built for this document — processing may still be in progress
      </div>
    )
  }

  return (
    <div className="flex h-full">
      <div className="flex-1">
        <ReactFlow
          nodes={nodes} edges={edges}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          fitView fitViewOptions={{ padding: 0.2 }}
          minZoom={0.1} maxZoom={3}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#e2e8f0" gap={20} size={1} />
          <Controls className="!border-slate-200 !shadow-sm" />
          <MiniMap
            nodeColor={n => {
              const t = (n.data?.nodeType as string) || 'chunk'
              return { document: '#3b82f6', chunk: '#94a3b8', entity: '#22c55e', concept: '#a855f7' }[t] || '#94a3b8'
            }}
            className="!border-slate-200 !shadow-sm"
          />
        </ReactFlow>
      </div>
      {graph?.stats && <StatsPanel stats={graph.stats} />}
    </div>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(bytes: number) {
  if (!bytes) return '—'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const DOC_TYPE_LABELS: Record<string, string> = {
  protocol: 'Protocol', sap: 'Statistical Analysis Plan', crf: 'CRF',
  csr: 'Clinical Study Report', sdtm_ig: 'SDTM Implementation Guide',
  adam_ig: 'ADaM Implementation Guide', lab_manual: 'Lab Manual',
  lab_report: 'Lab Report', study_budget: 'Study Budget',
  dmp: 'Data Management Plan', icf: 'Informed Consent Form',
  ich_guideline: 'ICH Guideline', controlled_terminology: 'Controlled Terminology',
  other: 'Other',
}

const ENTITY_COLORS: Record<string, string> = {
  sdtm_variable: 'bg-blue-500',
  sdtm_domain:   'bg-purple-500',
  codelist:      'bg-amber-500',
  entity:        'bg-green-500',
  concept:       'bg-violet-500',
}

const ENTITY_TEXT_COLORS: Record<string, string> = {
  sdtm_variable: 'text-blue-700',
  sdtm_domain:   'text-purple-700',
  codelist:      'text-amber-700',
  entity:        'text-green-700',
  concept:       'text-violet-700',
}

// ─── Tab components ───────────────────────────────────────────────────────────

function OverviewTab({ intel }: { intel: DocIntelligence }) {
  const { document: doc, classification: cls, chunk_stats } = intel
  const typeLabel = DOC_TYPE_LABELS[doc.document_type] || doc.document_type
  const confidence = cls.confidence_scores[doc.document_type]

  const methodLabel = {
    auto_classified:    'AI · Auto-detected',
    llm_pending_review: 'AI → Pending review',
    manually_set:       'Manually specified',
  }[cls.method] || cls.method

  const methodColor = {
    auto_classified:    'bg-blue-50 text-blue-700 border-blue-200',
    llm_pending_review: 'bg-amber-50 text-amber-700 border-amber-200',
    manually_set:       'bg-slate-100 text-slate-600 border-slate-200',
  }[cls.method] || 'bg-slate-100 text-slate-600 border-slate-200'

  const statusColor: Record<string, string> = {
    indexed: 'bg-green-100 text-green-700',
    processing: 'bg-blue-100 text-blue-700',
    error: 'bg-red-100 text-red-700',
    pending: 'bg-slate-100 text-slate-600',
  }

  return (
    <div className="space-y-4 p-6">
      {/* Document Type Card */}
      <div className="card p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-brand-50 border border-brand-100 flex items-center justify-center flex-shrink-0">
              <FileText className="w-5 h-5 text-brand-500" />
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Document Type</p>
              <p className="text-lg font-bold text-slate-900 leading-tight">{typeLabel}</p>
            </div>
          </div>
          <span className={clsx('text-xs font-medium px-2.5 py-1 rounded-full border flex-shrink-0', methodColor)}>
            {methodLabel}
          </span>
        </div>
        {confidence != null && (
          <div className="mt-3">
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-slate-500">Confidence</span>
              <span className="font-semibold text-slate-700">{Math.round(confidence * 100)}%</span>
            </div>
            <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
              <div
                className={clsx('h-full rounded-full', confidence >= 0.8 ? 'bg-green-400' : confidence >= 0.5 ? 'bg-amber-400' : 'bg-red-400')}
                style={{ width: `${Math.round(confidence * 100)}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Classification Reasoning Card */}
      <div className="card p-4 space-y-3">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Classification Reasoning</p>
        <div className="bg-slate-50 rounded p-3 text-sm text-slate-700">
          {cls.llm_analysis || 'Document type was specified at upload time.'}
        </div>
        {cls.key_phrases.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {cls.key_phrases.map((phrase, i) => (
              <span key={i} className="bg-blue-50 text-blue-700 text-[11px] px-2 py-0.5 rounded-full border border-blue-100">
                {phrase}
              </span>
            ))}
          </div>
        )}
        {cls.structure_description && (
          <p className="text-xs italic text-slate-500">{cls.structure_description}</p>
        )}
      </div>

      {/* Document Metadata Card */}
      <div className="card p-4">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Document Metadata</p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2">
          {[
            ['File name', doc.file_name],
            ['SHA-256', doc.sha256_hash ? `${doc.sha256_hash.slice(0, 16)}…` : '—'],
            ['Size', fmt(doc.file_size_bytes)],
            ['Version', doc.version || '—'],
            ['Source', doc.source_type || '—'],
            ['Uploaded', doc.created_at ? new Date(doc.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'],
            ['Last updated', doc.updated_at ? new Date(doc.updated_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'],
          ].map(([label, val]) => (
            <div key={label} className="flex items-start justify-between gap-2 text-xs py-1 border-b border-slate-50">
              <span className="text-slate-500 flex-shrink-0">{label}</span>
              <span className="font-medium text-slate-800 text-right truncate max-w-[160px]" title={val}>{val}</span>
            </div>
          ))}
          <div className="flex items-start justify-between gap-2 text-xs py-1 border-b border-slate-50">
            <span className="text-slate-500 flex-shrink-0">Status</span>
            <span className={clsx('px-2 py-0.5 rounded-full text-[11px] font-semibold', statusColor[doc.status] || 'bg-slate-100 text-slate-600')}>
              {doc.status}
            </span>
          </div>
        </div>
        {doc.error_message && (
          <div className="mt-3 flex items-start gap-2 text-xs text-red-600 bg-red-50 rounded p-2">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            {doc.error_message}
          </div>
        )}
      </div>
    </div>
  )
}

function StatCard({ icon: Icon, label, value, sub }: { icon: React.ElementType; label: string; value: string | number; sub?: string }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-1.5">
        <Icon className="w-4 h-4 text-slate-400" />
        <span className="text-xs text-slate-500">{label}</span>
      </div>
      <p className="text-2xl font-bold text-slate-900 leading-tight">{value}</p>
      {sub && <p className="text-[11px] text-slate-400 mt-0.5">{sub}</p>}
    </div>
  )
}

function StatisticsTab({ intel }: { intel: DocIntelligence }) {
  const cs = intel.chunk_stats
  const gs = intel.graph_summary

  const entityTotal = gs?.entity_breakdown.reduce((s, e) => s + e.count, 0) ?? 0
  const conceptCount = gs?.total_concepts ?? 0
  const edgeTotal = gs?.edge_breakdown.reduce((s, e) => s + e.count, 0) ?? 0
  const embPct = cs.total > 0 ? Math.round((cs.embedded / cs.total) * 100) : 0

  const total = cs.text_chunks + cs.tables + cs.figures
  const textPct   = total > 0 ? (cs.text_chunks / total) * 100 : 0
  const tablePct  = total > 0 ? (cs.tables / total) * 100 : 0
  const figurePct = total > 0 ? (cs.figures / total) * 100 : 0

  const indexHealth = gs?.index_health === 'ready' ? 'Ready' : gs?.index_health === 'insufficient_data' ? 'Partial' : '—'

  return (
    <div className="p-6 space-y-6">
      <div className="grid grid-cols-3 gap-3">
        <StatCard icon={BookOpen}   label="Pages"            value={cs.max_page || '—'} />
        <StatCard icon={AlignLeft}  label="Text sections"    value={cs.text_chunks} />
        <StatCard icon={Table2}     label="Tables"           value={cs.tables} />
        <StatCard icon={ImageIcon}  label="Images"           value={cs.figures} />
        <StatCard icon={Layers}     label="Total chunks"     value={cs.total} />
        <StatCard icon={Cpu}        label="Vectors embedded" value={`${cs.embedded}/${cs.total}`} sub={`${embPct}% complete`} />
        <StatCard icon={Tag}        label="Entity nodes"     value={entityTotal || '—'} />
        <StatCard icon={Lightbulb}  label="Concept nodes"    value={conceptCount || '—'} />
        <StatCard icon={GitBranch}  label="Graph edges"      value={edgeTotal || '—'} />
        <StatCard icon={Database}   label="Index entries"    value={gs?.index_entries ?? '—'} />
        <StatCard icon={Activity}   label="Index health"     value={indexHealth} />
        <StatCard icon={Zap}        label="Embedding dim"    value={gs?.embedding_dim ?? '—'} />
      </div>

      {/* Embedding coverage */}
      <div className="card p-4">
        <div className="flex items-center justify-between text-sm mb-2">
          <span className="font-medium text-slate-700">Embedding coverage</span>
          <span className="font-semibold text-slate-900">{cs.embedded} / {cs.total} chunks</span>
        </div>
        <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden">
          <div
            className={clsx('h-full rounded-full transition-all', embPct === 100 ? 'bg-green-400' : embPct > 50 ? 'bg-brand-400' : 'bg-amber-400')}
            style={{ width: `${embPct}%` }}
          />
        </div>
        <p className="text-xs text-slate-400 mt-1">{embPct}% of chunks have vector embeddings</p>
      </div>

      {/* Chunk composition */}
      {total > 0 && (
        <div className="card p-4">
          <p className="text-sm font-medium text-slate-700 mb-3">Chunk composition</p>
          <div className="w-full h-6 rounded-full overflow-hidden flex">
            <div className="bg-blue-400 h-full transition-all" style={{ width: `${textPct}%` }} title={`Text: ${cs.text_chunks}`} />
            <div className="bg-amber-400 h-full transition-all" style={{ width: `${tablePct}%` }} title={`Tables: ${cs.tables}`} />
            <div className="bg-green-400 h-full transition-all" style={{ width: `${figurePct}%` }} title={`Figures: ${cs.figures}`} />
          </div>
          <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-400 inline-block" /> Text ({cs.text_chunks})</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block" /> Tables ({cs.tables})</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-400 inline-block" /> Images ({cs.figures})</span>
          </div>
        </div>
      )}

      {/* Chunking strategy */}
      <ChunkStrategyCard cs={cs} />

      {/* Extracted domain files */}
      {intel.extracted_files && intel.extracted_files.length > 0 && (
        <div className="card p-4 space-y-3">
          <div className="flex items-center gap-2 mb-3">
            <Database className="w-4 h-4 text-slate-600" />
            <h3 className="text-sm font-semibold text-slate-700">Extracted Domain Files</h3>
            <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
              {intel.extracted_files.length}
            </span>
          </div>
          <div className="divide-y divide-slate-100">
            {intel.extracted_files.map((f) => (
              <div key={f.document_id} className="py-2.5 flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-900 truncate">
                    {f.file_name || f.name}
                  </p>
                  <div className="flex items-center gap-3 mt-1.5 text-xs text-slate-500 flex-wrap">
                    {f.domain && (
                      <span className="bg-slate-100 text-slate-700 px-2 py-1 rounded">
                        Domain: {f.domain}
                      </span>
                    )}
                    {f.row_count !== null && f.row_count !== undefined && (
                      <span className="flex items-center gap-1">
                        <AlignLeft className="w-3 h-3" />
                        {f.row_count.toLocaleString()} rows
                      </span>
                    )}
                    {f.unique_subjects && (
                      <span className="flex items-center gap-1">
                        <Tag className="w-3 h-3" />
                        {f.unique_subjects} subjects
                      </span>
                    )}
                    {f.file_size_bytes && (
                      <span className="text-slate-400">
                        {(f.file_size_bytes / 1024).toLocaleString('en', { maximumFractionDigits: 1 })} KB
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const STRATEGY_META: Record<string, { label: string; color: string; desc: string }> = {
  toc_driven:  { label: 'ToC-driven',  color: 'bg-violet-100 text-violet-700 border-violet-200', desc: 'Sections detected from table of contents — prose accumulated per section, then slid at 1 500 chars.' },
  page_based:  { label: 'Page-based',  color: 'bg-blue-100 text-blue-700 border-blue-100',       desc: 'No section hierarchy detected — content split by page boundaries with sliding window.' },
  hybrid:      { label: 'Hybrid',      color: 'bg-amber-100 text-amber-700 border-amber-200',    desc: 'Partial section coverage — mix of section-driven and page-boundary splits.' },
  xpt_tabular: { label: 'XPT Tabular', color: 'bg-teal-100 text-teal-700 border-teal-200',       desc: 'SAS transport file — one header/variable summary chunk, then batches of 20 data rows per chunk.' },
}

function ChunkStrategyCard({ cs }: { cs: DocIntelligence['chunk_stats'] }) {
  const meta = STRATEGY_META[cs.chunk_strategy] ?? STRATEGY_META['hybrid']

  // avg tokens per type (4 chars ≈ 1 token)
  const toTok = (chars: number) => chars > 0 ? Math.round(chars / 4) : null
  const rows = [
    { label: 'Text sections',  avg: cs.avg_chars_text,      count: cs.text_chunks, color: 'bg-blue-400' },
    { label: 'Table cells',    avg: cs.avg_chars_table,     count: cs.tables,      color: 'bg-amber-400' },
    { label: 'Table rows',     avg: cs.avg_chars_table_row, count: cs.table_rows,  color: 'bg-orange-300' },
    { label: 'Images/figures', avg: cs.avg_chars_figure,    count: cs.figures,     color: 'bg-green-400' },
  ].filter(r => r.count > 0 && r.avg > 0)

  const avgTok = toTok(cs.avg_chars)
  // typical retrieval fetch = top-k chunks. ~5 chunks loaded per query
  const retrievalBudget = avgTok ? avgTok * 5 : null

  return (
    <div className="card p-4 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-slate-700">Chunking strategy</p>
        <span className={clsx('text-[11px] font-semibold border px-2 py-0.5 rounded-full', meta.color)}>
          {meta.label}
        </span>
      </div>
      <p className="text-xs text-slate-500">{meta.desc}</p>

      {rows.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-slate-600">Average chunk size by type</p>
          <div className="divide-y divide-slate-100 text-xs">
            {rows.map(r => (
              <div key={r.label} className="flex items-center gap-3 py-1.5">
                <span className={clsx('w-2 h-2 rounded-full flex-shrink-0', r.color)} />
                <span className="flex-1 text-slate-600">{r.label}</span>
                <span className="text-slate-500 tabular-nums">{r.avg.toLocaleString()} chars</span>
                <span className="w-16 text-right font-mono text-slate-800">
                  ~{toTok(r.avg)?.toLocaleString()} tok
                </span>
              </div>
            ))}
            {cs.avg_chars > 0 && (
              <div className="flex items-center gap-3 py-1.5 font-semibold">
                <span className="w-2 h-2 rounded-full flex-shrink-0 bg-slate-400" />
                <span className="flex-1 text-slate-700">Overall average</span>
                <span className="text-slate-600 tabular-nums">{cs.avg_chars.toLocaleString()} chars</span>
                <span className="w-16 text-right font-mono text-slate-900">
                  ~{avgTok?.toLocaleString()} tok
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {retrievalBudget && (
        <div className="bg-slate-50 rounded-lg p-3 text-xs text-slate-600 flex items-start gap-2">
          <Zap className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
          <span>
            Retrieval cost estimate: top-5 chunks ≈{' '}
            <span className="font-semibold text-slate-800">{retrievalBudget.toLocaleString()} tokens</span>
            {' '}context per query (4 chars ≈ 1 token)
          </span>
        </div>
      )}
    </div>
  )
}

function TableCard({ table, onView }: {
  table: DocIntelligence['tables'][0]
  onView: () => void
}) {
  return (
    <div className="border border-slate-200 rounded-lg p-3 hover:bg-slate-50 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-semibold bg-slate-100 text-slate-600 px-2 py-0.5 rounded">p.{table.page_number}</span>
            {table.section && <span className="text-[11px] text-slate-500 truncate">{table.section}</span>}
          </div>
          {table.columns.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {table.columns.slice(0, 6).map((col, i) => (
                <span key={i} className="text-[10px] bg-blue-50 text-blue-700 border border-blue-100 px-1.5 py-0.5 rounded">{col}</span>
              ))}
              {table.columns.length > 6 && (
                <span className="text-[10px] text-slate-400">+{table.columns.length - 6} more</span>
              )}
            </div>
          )}
          {table.row_count > 0 && (
            <p className="text-[11px] text-slate-400 mt-1">{table.row_count} rows</p>
          )}
        </div>
        <button
          onClick={onView}
          className="flex-shrink-0 text-xs text-brand-600 hover:text-brand-700 font-medium whitespace-nowrap"
        >
          View Table →
        </button>
      </div>
    </div>
  )
}

function ContentTab({ intel }: { intel: DocIntelligence }) {
  const [tableIdx, setTableIdx] = useState<number | null>(null)
  const [imageIdx, setImageIdx] = useState<number | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setTableIdx(null); setImageIdx(null) }
      if (imageIdx !== null) {
        if (e.key === 'ArrowLeft') setImageIdx(i => i !== null ? Math.max(0, i - 1) : null)
        if (e.key === 'ArrowRight') setImageIdx(i => i !== null ? Math.min(intel.images.length - 1, i + 1) : null)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [imageIdx, intel.images.length])

  return (
    <div className="space-y-6 p-6">
      {/* Tables */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Table2 className="w-4 h-4 text-slate-600" />
          <h3 className="text-sm font-semibold text-slate-700">Tables</h3>
          <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">{intel.tables.length}</span>
        </div>
        {intel.tables.length === 0 ? (
          <p className="text-sm text-slate-400">No tables found in this document.</p>
        ) : (
          <div className="max-h-[500px] overflow-y-auto space-y-2 pr-1">
            {intel.tables.map((t, i) => (
              <TableCard key={t.chunk_index} table={t} onView={() => setTableIdx(i)} />
            ))}
          </div>
        )}
      </div>

      {/* Images */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <ImageIcon className="w-4 h-4 text-slate-600" />
          <h3 className="text-sm font-semibold text-slate-700">Images</h3>
          <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">{intel.images.length}</span>
        </div>
        {intel.images.length === 0 ? (
          <p className="text-sm text-slate-400">No images found in this document.</p>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {intel.images.map((img, i) => (
              <button
                key={img.chunk_index}
                onClick={() => setImageIdx(i)}
                className="text-left group rounded-lg overflow-hidden border border-slate-200 hover:border-brand-300 transition-colors"
              >
                {img.image_url ? (
                  <img
                    src={img.image_url}
                    alt={img.caption || `Image p.${img.page_number}`}
                    className="w-full aspect-video object-cover bg-slate-100"
                  />
                ) : (
                  <div className="w-full aspect-video bg-slate-100 flex items-center justify-center">
                    <div className="text-center text-slate-500">
                      <ImageIcon className="w-5 h-5 mx-auto mb-1" />
                      <p className="text-[11px]">Figure extracted</p>
                    </div>
                  </div>
                )}
                <div className="p-2">
                  <p className="text-[11px] text-slate-500">p.{img.page_number}{img.section ? ` · ${img.section}` : ''}</p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Table popup */}
      {tableIdx !== null && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={() => setTableIdx(null)} />
          <div className="relative bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 flex-shrink-0">
              <div className="flex items-center gap-2">
                <Table2 className="w-4 h-4 text-slate-500" />
                <span className="text-sm font-semibold text-slate-800">
                  Table — p.{intel.tables[tableIdx].page_number}
                  {intel.tables[tableIdx].section ? ` · ${intel.tables[tableIdx].section}` : ''}
                </span>
              </div>
              <button onClick={() => setTableIdx(null)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <pre className="font-mono text-xs whitespace-pre-wrap bg-slate-50 p-4 rounded overflow-auto max-h-[60vh] text-slate-700">
                {intel.tables[tableIdx].content}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Image lightbox */}
      {imageIdx !== null && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/80" onClick={() => setImageIdx(null)} />
          <div className="relative max-w-4xl w-full flex flex-col items-center">
            {imageIdx > 0 && (
              <button
                onClick={e => { e.stopPropagation(); setImageIdx(i => i !== null ? i - 1 : null) }}
                className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-12 p-2 bg-white/20 hover:bg-white/30 rounded-full text-white transition-colors"
              >
                <ChevronLeft className="w-6 h-6" />
              </button>
            )}
            {imageIdx < intel.images.length - 1 && (
              <button
                onClick={e => { e.stopPropagation(); setImageIdx(i => i !== null ? i + 1 : null) }}
                className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-12 p-2 bg-white/20 hover:bg-white/30 rounded-full text-white transition-colors"
              >
                <ChevronRight className="w-6 h-6" />
              </button>
            )}
            {intel.images[imageIdx].image_url ? (
              <img
                src={intel.images[imageIdx].image_url}
                alt={intel.images[imageIdx].caption || `Image ${imageIdx + 1}`}
                className="max-h-[70vh] w-auto rounded-lg object-contain"
              />
            ) : (
              <div className="max-h-[70vh] w-full max-w-2xl rounded-lg bg-slate-800 border border-slate-700 py-16 flex items-center justify-center">
                <div className="text-center text-slate-200">
                  <ImageIcon className="w-8 h-8 mx-auto mb-2" />
                  <p className="text-sm">Figure extracted without image asset URL</p>
                </div>
              </div>
            )}
            <div className="mt-3 text-center text-white">
              {intel.images[imageIdx].caption && (
                <p className="text-sm">{intel.images[imageIdx].caption}</p>
              )}
              <p className="text-xs text-white/60 mt-1">
                p.{intel.images[imageIdx].page_number}
                {intel.images[imageIdx].section ? ` · ${intel.images[imageIdx].section}` : ''}
                {' '}· {imageIdx + 1} / {intel.images.length}
              </p>
            </div>
            <button
              onClick={() => setImageIdx(null)}
              className="absolute top-0 right-0 -translate-y-12 p-1.5 bg-white/20 hover:bg-white/30 rounded-lg text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const STEP_BADGE_COLORS: Record<string, string> = {
  ingestion:         'bg-blue-100 text-blue-700',
  embedding:         'bg-purple-100 text-purple-700',
  entity_extraction: 'bg-amber-100 text-amber-700',
  graph_build:       'bg-green-100 text-green-700',
  xpt_graph:         'bg-teal-100 text-teal-700',
  indexing:          'bg-slate-100 text-slate-600',
}

function IntelligenceTab({ intel }: { intel: DocIntelligence }) {
  const cs = intel.chunk_stats
  const gs = intel.graph_summary
  const logs = intel.processing_logs ?? []

  const entityBreakdown = gs?.entity_breakdown ?? []
  const edgeBreakdown = gs?.edge_breakdown ?? []
  const entityTotal = entityBreakdown.reduce((s, e) => s + e.count, 0)
  const maxEntityCount = Math.max(...entityBreakdown.map(e => e.count), 1)

  const conceptCount = gs?.total_concepts ?? 0

  // Derive step status from logs
  const ALL_PIPELINE_STEPS = ['ingestion', 'embedding', 'entity_extraction', 'xpt_graph', 'graph_build', 'indexing']
  const activeSteps = ALL_PIPELINE_STEPS.filter(s => logs.some(l => l.step === s))
  const stepsToShow = activeSteps.length > 0 ? activeSteps : []

  const stepStatus = (step: string) => {
    const sl = logs.filter(l => l.step === step)
    if (sl.some(l => l.event === 'failed')) return 'failed'
    if (sl.some(l => l.event === 'completed')) return 'done'
    if (sl.some(l => l.event === 'started' || l.event === 'progress')) return 'active'
    return 'pending'
  }

  const stepDetail = (step: string) => {
    const completed = logs.filter(l => l.step === step && l.event === 'completed').at(-1)
    const active = logs.filter(l => l.step === step && (l.event === 'progress' || l.event === 'started')).at(-1)
    const entry = completed || active
    if (!entry) return null
    const ms = entry.metadata?.duration_ms as number | undefined
    const model = (entry.metadata?.model || entry.metadata?.llm_model) as string | undefined
    return { message: entry.message, duration: ms, model }
  }

  // Model summary bar from completed log entries
  const embeddingModel = logs.find(l => l.step === 'embedding' && l.event === 'completed')?.metadata?.model as string | undefined
  const llmModel = logs.find(l => l.step === 'entity_extraction' && l.event === 'completed')?.metadata?.llm_model as string | undefined
  const indexModel = logs.find(l => l.step === 'indexing' && l.event === 'completed')?.metadata?.embedding_model as string | undefined
  const xptModel = logs.find(l => l.step === 'xpt_graph' && l.event === 'completed')?.metadata?.embedding_model as string | undefined

  const dot = (status: string) => clsx(
    'w-3 h-3 rounded-full flex-shrink-0 mt-0.5',
    status === 'done'    ? 'bg-green-500'
    : status === 'active'  ? 'bg-blue-400'
    : status === 'failed'  ? 'bg-red-400'
    : 'bg-slate-300'
  )

  return (
    <div className="p-6 space-y-6">
      {/* Model summary bar */}
      {logs.length > 0 && (
        <div className="card p-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
          <span className="font-semibold text-slate-600 text-xs">Models used:</span>
          <span>Ingestion: <span className="text-slate-700 font-medium">file parser</span></span>
          {embeddingModel && <span>Embedding: <span className="text-slate-700 font-medium">{embeddingModel} 768d</span></span>}
          {llmModel && <span>Entities: <span className="text-slate-700 font-medium">{llmModel}</span></span>}
          {(indexModel || xptModel) && <span>Index: <span className="text-slate-700 font-medium">{indexModel || xptModel}</span></span>}
        </div>
      )}

      {/* What was extracted */}
      <div className="card p-4">
        <p className="text-sm font-semibold text-slate-700 mb-1">What was extracted</p>
        {entityTotal > 0 ? (
          <>
            <p className="text-xs text-slate-500 mb-4">
              From {cs.total} chunks across {cs.max_page} pages, the system extracted{' '}
              <span className="font-semibold text-slate-700">{entityTotal}</span> knowledge nodes and built{' '}
              <span className="font-semibold text-slate-700">{conceptCount}</span> canonical concepts.
            </p>
            <div className="space-y-2">
              {entityBreakdown.map(e => (
                <div key={e.type} className="flex items-center gap-3">
                  <span className={clsx('text-xs font-mono w-32 flex-shrink-0', ENTITY_TEXT_COLORS[e.type] || 'text-slate-600')}>
                    {e.type}
                  </span>
                  <div className="flex-1 h-4 bg-slate-100 rounded overflow-hidden">
                    <div
                      className={clsx('h-full rounded transition-all', ENTITY_COLORS[e.type] || 'bg-slate-400')}
                      style={{ width: `${(e.count / maxEntityCount) * 100}%` }}
                    />
                  </div>
                  <span className="text-xs font-semibold text-slate-700 w-12 text-right">{e.count}</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="text-xs text-slate-400">Entity extraction has not run yet for this document.</p>
        )}
      </div>

      {/* Build Log — data-driven from processing_logs */}
      <div className="card p-4">
        <p className="text-sm font-semibold text-slate-700 mb-4">Context Graph Build Log</p>
        {stepsToShow.length === 0 ? (
          <p className="text-xs text-slate-400">No processing log entries yet. Logs appear after the next upload or reprocess.</p>
        ) : (
          <div className="space-y-4">
            {stepsToShow.map(step => {
              const status = stepStatus(step)
              const detail = stepDetail(step)
              const stepLabel = step === 'entity_extraction' ? 'Entity Extract'
                : step === 'graph_build' ? 'Graph Build'
                : step === 'xpt_graph' ? 'XPT Graph'
                : step.charAt(0).toUpperCase() + step.slice(1)
              return (
                <div key={step} className="flex gap-3">
                  <div className={dot(status)} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-semibold text-slate-700">{stepLabel}</p>
                      {status === 'active' && <Loader2 className="w-3 h-3 text-blue-400 animate-spin" />}
                      {status === 'done' && <CheckCircle className="w-3 h-3 text-green-500" />}
                      {detail?.duration != null && (
                        <span className="text-[10px] text-slate-400 ml-auto">{(detail.duration / 1000).toFixed(1)}s</span>
                      )}
                    </div>
                    {detail && (
                      <p className="text-xs text-slate-500 mt-0.5">
                        {detail.message}
                        {detail.model && <span className="text-slate-400"> · {detail.model}</span>}
                      </p>
                    )}
                    {edgeBreakdown.length > 0 && step === 'graph_build' && (
                      <div className="flex flex-wrap gap-1.5 mt-1.5">
                        {edgeBreakdown.map(p => (
                          <span key={p.type} className="text-[11px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
                            {p.type} ×{p.count}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Detailed Log Timeline */}
      {logs.length > 0 && (
        <div className="card p-4">
          <p className="text-sm font-semibold text-slate-700 mb-3">Processing Timeline</p>
          <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
            {logs.map(entry => {
              const ts = new Date(entry.created_at)
              const timeStr = ts.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
              const ms = entry.metadata?.duration_ms as number | undefined
              const model = (entry.metadata?.model || entry.metadata?.llm_model || entry.metadata?.embedding_model) as string | undefined
              return (
                <div key={entry.id} className="flex items-start gap-2 text-[11px]">
                  <span className="text-slate-400 font-mono flex-shrink-0 w-20">{timeStr}</span>
                  <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0',
                    STEP_BADGE_COLORS[entry.step] || 'bg-slate-100 text-slate-600')}>
                    {entry.step}.{entry.event}
                  </span>
                  <span className="text-slate-600 flex-1 min-w-0 truncate">{entry.message}</span>
                  {ms != null && (
                    <span className="text-slate-400 flex-shrink-0">{(ms / 1000).toFixed(1)}s</span>
                  )}
                  {model && (
                    <span className="text-slate-400 flex-shrink-0 truncate max-w-[80px]">{model.split(':')[0]}</span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function DocumentGraphView({ documentId, orgId }: { documentId: string; orgId: string }) {
  return <GraphCanvas documentId={documentId} orgId={orgId} />
}

// ─── Modal wrapper ────────────────────────────────────────────────────────────

export function DocumentGraphModal({
  documentId,
  documentName,
  orgId,
  onClose,
}: {
  documentId: string
  documentName: string
  orgId: string
  onClose: () => void
}) {
  const [activeTab, setActiveTab] = useState<Tab>('overview')
  const [intel, setIntel] = useState<DocIntelligence | null>(null)
  const [intelError, setIntelError] = useState(false)
  const [graph, setGraph] = useState<DocumentGraph | null>(null)
  const [graphLoaded, setGraphLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const fetchIntel = useCallback(() => {
    setRefreshing(true)
    fetch(`${CONTEXT_GRAPH_URL}/documents/${documentId}/intelligence?org_id=${orgId}`)
      .then(r => r.json())
      .then(data => { setIntel(data); setIntelError(false) })
      .catch(() => setIntelError(true))
      .finally(() => setRefreshing(false))
  }, [documentId, orgId])

  // Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Fetch intelligence immediately
  useEffect(() => { fetchIntel() }, [fetchIntel])

  // Auto-poll every 15s while graph build is in progress
  // Stop when the last log entry is a 'completed' event for the final pipeline step
  useEffect(() => {
    const logs = intel?.processing_logs ?? []
    const lastLog = logs.at(-1)
    const finalSteps = new Set(['indexing', 'xpt_graph'])
    const hasChunks = (intel?.chunk_stats.total ?? 0) > 0
    const fullyEmbedded =
      hasChunks &&
      (intel?.chunk_stats.embedded ?? 0) >= (intel?.chunk_stats.total ?? 0)
    const isDoneByLogs = !!(lastLog && lastLog.event === 'completed' && finalSteps.has(lastLog.step))
    const isDoneByStatus = intel?.document.status === 'indexed'
    const isDone = isDoneByLogs || isDoneByStatus || fullyEmbedded
    const isProcessing = !!intel && hasChunks && !isDone
    if (!isProcessing) return
    const id = setInterval(fetchIntel, 15000)
    return () => clearInterval(id)
  }, [intel, fetchIntel])

  // Fetch graph lazily when graph tab is first opened
  useEffect(() => {
    if (activeTab === 'graph' && !graphLoaded) {
      fetch(`${CONTEXT_GRAPH_URL}/graph/document/${documentId}?org_id=${orgId}`)
        .then(r => r.json())
        .then((data: DocumentGraph) => { setGraph(data); setGraphLoaded(true) })
        .catch(() => setGraphLoaded(true))
    }
  }, [activeTab, graphLoaded, documentId, orgId])

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'overview',      label: 'Overview' },
    { id: 'statistics',    label: 'Statistics' },
    { id: 'content',       label: 'Content' },
    { id: 'graph',         label: 'Knowledge Graph' },
    { id: 'intelligence',  label: 'Intelligence' },
  ]

  const loading = !intel && !intelError

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div
        className="relative w-full max-w-6xl bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{ height: 'calc(100vh - 64px)' }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-slate-200 flex-shrink-0">
          <FileText className="w-4 h-4 text-brand-500 flex-shrink-0" />
          <p className="text-sm font-semibold text-slate-900 truncate flex-1 min-w-0">{documentName}</p>

          {/* Tabs */}
          <div className="flex items-center gap-0.5 bg-slate-100 rounded-lg p-0.5 flex-shrink-0">
            {tabs.map(t => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={clsx(
                  'px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap',
                  activeTab === t.id
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {intel && (intel.processing_logs ?? []).length > 0 && (() => {
            const logs = intel.processing_logs
            const lastLog = logs.at(-1)
            const finalSteps = new Set(['indexing', 'xpt_graph'])
            const hasChunks = (intel.chunk_stats.total ?? 0) > 0
            const fullyEmbedded =
              hasChunks &&
              (intel.chunk_stats.embedded ?? 0) >= (intel.chunk_stats.total ?? 0)
            const isDoneByLogs = !!(lastLog && lastLog.event === 'completed' && finalSteps.has(lastLog.step))
            const isDoneByStatus = intel.document.status === 'indexed'
            const isDone = isDoneByLogs || isDoneByStatus || fullyEmbedded
            const activeLog = !isDone && logs.filter(l => l.event === 'started' || l.event === 'progress').at(-1)
            return activeLog ? (
              <span className="flex items-center gap-1 text-[11px] text-blue-600 bg-blue-50 border border-blue-200 px-2 py-1 rounded-full flex-shrink-0">
                <Loader2 className="w-3 h-3 animate-spin" /> {activeLog.step.replace('_', ' ')}…
              </span>
            ) : null
          })()}
          <button
            onClick={fetchIntel}
            title="Refresh"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors flex-shrink-0"
          >
            <RefreshCw className={clsx('w-4 h-4', refreshing && 'animate-spin')} />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors flex-shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab content */}
        {loading ? (
          <div className="flex-1 flex items-center justify-center gap-2 text-sm text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading document intelligence…
          </div>
        ) : intelError ? (
          <div className="flex-1 flex items-center justify-center gap-2 text-sm text-slate-400">
            <AlertCircle className="w-4 h-4" /> Could not load document data
          </div>
        ) : intel ? (
          <>
            {activeTab === 'overview' && (
              <div className="flex-1 min-h-0 overflow-y-auto">
                <OverviewTab intel={intel} />
              </div>
            )}
            {activeTab === 'statistics' && (
              <div className="flex-1 min-h-0 overflow-y-auto">
                <StatisticsTab intel={intel} />
              </div>
            )}
            {activeTab === 'content' && (
              <div className="flex-1 min-h-0 overflow-y-auto">
                <ContentTab intel={intel} />
              </div>
            )}
            {activeTab === 'graph' && (
              <div className="flex-1 min-h-0 overflow-hidden">
                {!graphLoaded ? (
                  <div className="flex items-center justify-center h-full gap-2 text-sm text-slate-400">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading graph…
                  </div>
                ) : (
                  <GraphCanvas documentId={documentId} orgId={orgId} />
                )}
              </div>
            )}
            {activeTab === 'intelligence' && (
              <div className="flex-1 min-h-0 overflow-y-auto">
                <IntelligenceTab intel={intel} />
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  )
}
