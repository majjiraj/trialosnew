'use client'
import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { ReactFlow, Background, Controls, MiniMap, useNodesState, useEdgesState, type Node, type Edge } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ArrowLeft, Shield, GitBranch, Plus, Loader2, Edit2, History, Globe, EyeOff, Bot, BarChart3, CheckCircle, XCircle, AlertCircle, ChevronDown, ChevronRight, TrendingUp, TrendingDown, Info } from 'lucide-react'
import { nodeTypes } from '@/components/flow/FlowNodes'
import { useOrgId, useAuth } from '@/components/layout/AuthContext'

const GRAPHQL_URL = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
const MARKETPLACE_URL = process.env.NEXT_PUBLIC_MARKETPLACE_URL || 'http://localhost:8005'

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

const NODE_TYPE_MAP: Record<string, string> = {
  data_source: 'data_source',
  dataSource: 'data_source',
  llm: 'llm',
  lm: 'llm',
  code: 'code',
  chart: 'chart',
  document: 'document',
  output: 'output',
  hitl: 'hitl',
  hitr: 'hitl',
  condition: 'condition',
  context_graph: 'context_graph',
  skill: 'skill',
  file_op: 'file_op',
  fileOp: 'file_op',
  agent: 'agent',
  memory: 'memory',
  reflect: 'reflect',
  planner: 'planner',
}

function layoutNodes(nodes: any[], edges: any[]) {
  // Build forward-only adjacency (ignore back-edges to avoid BFS cycles)
  const nodeIds = new Set(nodes.map(n => n.id))

  // First pass: assign layers using only forward edges (DFS with visited guard)
  const layer: Record<string, number> = {}
  const visited = new Set<string>()

  function assignLayer(id: string, depth: number) {
    if (!nodeIds.has(id)) return
    if ((layer[id] ?? -1) >= depth) return  // already placed at same or deeper layer
    layer[id] = depth
    if (visited.has(id)) return             // back-edge — stop here, don't recurse
    visited.add(id)
    for (const e of edges) {
      if (e.source === id) assignLayer(e.target, depth + 1)
    }
    visited.delete(id)
  }

  // Start from roots (nodes with no incoming forward edges)
  const targets = new Set(edges.map((e: any) => e.target))
  const roots = nodes.filter(n => !targets.has(n.id))
  const startNodes = roots.length > 0 ? roots : [nodes[0]]
  for (const n of startNodes) assignLayer(n.id, 0)
  // Assign layer 0 to any orphaned nodes
  for (const n of nodes) { if (layer[n.id] === undefined) layer[n.id] = 0 }

  // Count nodes per layer for vertical spacing
  const layerCount: Record<number, number> = {}
  const layerIdx:   Record<string, number> = {}
  for (const n of nodes) {
    const l = layer[n.id]
    layerIdx[n.id] = layerCount[l] ?? 0
    layerCount[l]  = (layerCount[l] ?? 0) + 1
  }

  const COL_W = 240, ROW_H = 130
  return nodes.map(n => {
    const l     = layer[n.id] ?? 0
    const idx   = layerIdx[n.id] ?? 0
    const total = layerCount[l] ?? 1
    return {
      ...n,
      type: NODE_TYPE_MAP[n.type] || n.type || 'data_source',
      position: {
        x: l * COL_W + 40,
        y: idx * ROW_H - ((total - 1) * ROW_H) / 2 + 200,
      },
      data: { label: n.label, ...(n.config || {}) },
    }
  })
}

export default function FlowViewPage() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const slug = params.slug as string
  const orgId = useOrgId()
  const { user } = useAuth()

  const [agent, setAgent] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [installed, setInstalled] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [selectedNode, setSelectedNode] = useState<any>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const [activeTab, setActiveTab] = useState<'flow' | 'evaluators'>(
    searchParams.get('tab') === 'evaluators' ? 'evaluators' : 'flow'
  )
  const [evalStats, setEvalStats] = useState<any>(null)
  const [evalLoading, setEvalLoading] = useState(false)
  const [expandedEval, setExpandedEval] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      gql(`query { agent(slug: "${slug}") {
        id name slug version category description publisherType agentType
        requiredPermissions declaredTools flowDefinition agentPurpose isPublished publisherOrgId
      }}`),
      gql(`query { installations(orgId: "${orgId}") { agentId } }`),
    ]).then(([agentData, instData]) => {
      const a = agentData.agent
      setAgent(a)
      setInstalled((instData.installations || []).some((i: any) => i.agentId === a?.id))

      if (a?.flowDefinition) {
        const fd = typeof a.flowDefinition === 'string' ? JSON.parse(a.flowDefinition) : a.flowDefinition
        const rawNodes = fd.nodes || []
        const rawEdgesData = fd.edges || []

        // Detect back-edges (target has a lower or equal layer than source after layout)
        const laid = layoutNodes(rawNodes, rawEdgesData)
        const posMap: Record<string, number> = {}
        for (const n of laid) posMap[n.id] = n.position.x

        const rawEdges = rawEdgesData.map((e: any, i: number) => {
          const isBack = (posMap[e.target] ?? 0) <= (posMap[e.source] ?? 0)
          return {
            id: `e${i}`,
            source: e.source,
            target: e.target,
            label: e.label || undefined,
            type: 'smoothstep',
            animated: isBack,
            style: isBack
              ? { stroke: '#f59e0b', strokeWidth: 1.5, strokeDasharray: '5 3' }
              : { stroke: '#94a3b8', strokeWidth: 1.5 },
            labelStyle: { fontSize: 10, fill: '#f59e0b' },
            labelBgStyle: { fill: '#fffbeb', fillOpacity: 0.9 },
          }
        })
        setNodes(laid)
        setEdges(rawEdges)
      }
    }).catch(console.error).finally(() => setLoading(false))
  }, [slug])

  async function handleInstall() {
    if (!agent) return
    setInstalling(true)
    try {
      await gql(`
        mutation { installAgent(orgId: "${orgId}", agentId: "${agent.id}",
          installedBy: "${user?.id ?? '00000000-0000-0000-0000-000000000002'}", consentedPermissions: ${JSON.stringify(agent.requiredPermissions || [])}) { id } }`)
      setInstalled(true)
    } catch (e) { console.error(e) }
    setInstalling(false)
  }

  async function handlePublishToggle() {
    if (!agent) return
    setToggling(true)
    const endpoint = agent.isPublished ? 'unpublish' : 'publish'
    try {
      const res = await fetch(`${MARKETPLACE_URL}/agents/${agent.id}/${endpoint}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, is_platform_admin: !!user?.is_platform_admin }),
      })
      if (res.ok) {
        setAgent((prev: any) => ({ ...prev, isPublished: !prev.isPublished }))
      }
    } catch (e) { console.error(e) }
    setToggling(false)
  }

  const isOwner = agent?.publisherOrgId === orgId || user?.is_platform_admin

  const fetchEvalStats = useCallback(async () => {
    if (!agent) return
    setEvalLoading(true)
    try {
      const data = await gql(`
        query AgentEvalStats($agentName: String!, $orgId: String!) {
          agentEvaluatorStats(agentName: $agentName, orgId: $orgId) {
            agentName orgId totalEvaluations evaluatorCount
            stats {
              evaluatorId evaluatorName evaluatorSlug evaluatorCategory evaluatorDescription isBuiltin
              runCount avgScore minScore maxScore scoreStddev
              passCount failCount partialCount unknownCount passRate failRate
              lastEvaluatedAt firstEvaluatedAt provenanceNarrative scoringDimensions
              trend { day avgScore count }
              recentResults { id runId score verdict notes judgeModel triggeredBy createdAt runStatus }
            }
          }
        }
      `, { agentName: agent.name, orgId: orgId || '' })
      setEvalStats(data.agentEvaluatorStats)
    } catch (e) { console.error(e) }
    setEvalLoading(false)
  }, [agent, orgId])

  useEffect(() => {
    if (activeTab === 'evaluators' && agent && !evalStats) {
      fetchEvalStats()
    }
  }, [activeTab, agent])

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <Loader2 className="w-6 h-6 animate-spin text-brand-500" />
    </div>
  )

  if (!agent) return <div className="p-8 text-slate-500">Agent not found.</div>

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Header */}
      <div className="flex items-center gap-4 px-5 py-3 border-b border-slate-200 bg-white flex-shrink-0">
        <button onClick={() => router.back()} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors">
          <ArrowLeft className="w-4 h-4 text-slate-500" />
        </button>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <GitBranch className="w-4 h-4 text-brand-500 flex-shrink-0" />
          <h1 className="font-semibold text-slate-900 truncate">{agent.name}</h1>
          <span className="text-xs text-slate-400">v{agent.version}</span>
          <span className="flex items-center gap-1 text-xs text-green-700 bg-green-50 px-2 py-0.5 rounded-full font-medium">
            <Shield className="w-3 h-3" /> {agent.publisherType}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isOwner && (
            <>
              <button onClick={() => router.push(`/agents/build?edit_id=${agent.id}`)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors">
                <Bot className="w-3.5 h-3.5" /> Edit with AI
              </button>
              <button onClick={() => router.push(`/agents/create-flow?edit_id=${agent.id}`)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors">
                <Edit2 className="w-3.5 h-3.5" /> Edit Flow
              </button>
              <button onClick={() => router.push(`/agents/${agent.id}/versions`)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors">
                <History className="w-3.5 h-3.5" /> History
              </button>
              <button onClick={handlePublishToggle} disabled={toggling}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-white rounded-lg transition-colors disabled:opacity-50"
                style={{ backgroundColor: agent.isPublished ? '#dc2626' : '#16a34a' }}>
                {toggling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> :
                  agent.isPublished ? <EyeOff className="w-3.5 h-3.5" /> : <Globe className="w-3.5 h-3.5" />}
                {agent.isPublished ? 'Unpublish' : 'Publish'}
              </button>
            </>
          )}
          {installed ? (
            <span className="px-3 py-1.5 text-xs text-green-700 bg-green-50 rounded-lg font-medium">✓ Installed</span>
          ) : (
            <button onClick={handleInstall} disabled={installing}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
              {installing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              Install
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-200 bg-white px-5 flex-shrink-0">
        {([
          { id: 'flow', label: 'Flow', icon: <GitBranch className="w-3.5 h-3.5" /> },
          { id: 'evaluators', label: 'Evaluators', icon: <BarChart3 className="w-3.5 h-3.5" /> },
        ] as const).map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${
              activeTab === tab.id
                ? 'border-brand-500 text-brand-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}>
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {activeTab === 'flow' ? (
        <div className="flex flex-1 overflow-hidden">
          {/* Flow Canvas */}
          <div className="flex-1">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              nodeTypes={nodeTypes}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={true}
              onNodeClick={(_, node) => setSelectedNode(node)}
              fitView
              fitViewOptions={{ padding: 0.3 }}
              minZoom={0.4}
            >
              <Background color="#e2e8f0" gap={20} />
              <Controls />
              <MiniMap nodeColor={() => '#94a3b8'} className="!bg-white !border-slate-200" />
            </ReactFlow>
          </div>

          {/* Right Panel */}
          <div className="w-64 border-l border-slate-200 bg-white overflow-y-auto flex-shrink-0">
            {selectedNode ? (
              <div className="p-4 space-y-3">
                <h3 className="font-semibold text-slate-900 text-sm">{selectedNode.data?.label}</h3>
                <div className="text-xs text-slate-400 uppercase tracking-wide">{selectedNode.type}</div>
                {Object.entries(selectedNode.data || {}).filter(([k]) => k !== 'label').map(([k, v]) => (
                  <div key={k}>
                    <div className="text-xs text-slate-400 font-medium capitalize mb-0.5">{k.replace(/_/g, ' ')}</div>
                    <div className="text-xs text-slate-700 bg-slate-50 rounded p-2 break-all">
                      {typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-4 space-y-4">
                <div>
                  <div className="text-xs text-slate-400 font-medium mb-1">Description</div>
                  <p className="text-xs text-slate-600 leading-relaxed">{agent.description}</p>
                </div>
                {agent.requiredPermissions?.length > 0 && (
                  <div>
                    <div className="text-xs text-slate-400 font-medium mb-1">Required Permissions</div>
                    <div className="flex flex-wrap gap-1">
                      {agent.requiredPermissions.map((p: string) => (
                        <span key={p} className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">{p}</span>
                      ))}
                    </div>
                  </div>
                )}
                {agent.declaredTools?.length > 0 && (
                  <div>
                    <div className="text-xs text-slate-400 font-medium mb-1">Tools</div>
                    <div className="flex flex-wrap gap-1">
                      {agent.declaredTools.map((t: string) => (
                        <span key={t} className="text-[10px] bg-brand-50 text-brand-700 px-1.5 py-0.5 rounded">{t}</span>
                      ))}
                    </div>
                  </div>
                )}
                <p className="text-[10px] text-slate-400 italic">Click a node to inspect its configuration</p>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* ── Evaluators Tab ──────────────────────────────────────────────── */
        <div className="flex-1 overflow-y-auto bg-slate-50 p-6">
          {evalLoading ? (
            <div className="flex items-center justify-center h-48">
              <Loader2 className="w-6 h-6 animate-spin text-brand-500" />
            </div>
          ) : !evalStats || evalStats.evaluatorCount === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-3">
              <BarChart3 className="w-10 h-10 text-slate-300" />
              <p className="text-slate-500 text-sm">No evaluations have been run for this agent yet.</p>
              <p className="text-slate-400 text-xs">Open an agent run and use the Evaluations tab to run evaluators.</p>
            </div>
          ) : (
            <div className="space-y-6 max-w-5xl mx-auto">
              {/* Summary header */}
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-white rounded-xl border border-slate-200 p-4">
                  <div className="text-xs text-slate-400 font-medium mb-1">Total Evaluations</div>
                  <div className="text-2xl font-bold text-slate-900">{evalStats.totalEvaluations}</div>
                  <div className="text-xs text-slate-400 mt-1">across {evalStats.evaluatorCount} evaluator{evalStats.evaluatorCount !== 1 ? 's' : ''}</div>
                </div>
                <div className="bg-white rounded-xl border border-slate-200 p-4">
                  <div className="text-xs text-slate-400 font-medium mb-1">Overall Pass Rate</div>
                  <div className="text-2xl font-bold text-green-700">
                    {evalStats.stats.length > 0
                      ? Math.round(evalStats.stats.reduce((a: number, s: any) => a + (s.passRate ?? 0), 0) / evalStats.stats.length * 100) + '%'
                      : 'N/A'}
                  </div>
                  <div className="text-xs text-slate-400 mt-1">average across all evaluators</div>
                </div>
                <div className="bg-white rounded-xl border border-slate-200 p-4">
                  <div className="text-xs text-slate-400 font-medium mb-1">Best Evaluator</div>
                  <div className="text-sm font-semibold text-slate-900 mt-1">
                    {evalStats.stats[0]?.evaluatorName ?? '—'}
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {evalStats.stats[0]?.avgScore != null ? `avg ${Math.round(evalStats.stats[0].avgScore * 100)}%` : ''}
                  </div>
                </div>
              </div>

              {/* Per-evaluator cards */}
              <div className="space-y-3">
                <div className="text-sm font-semibold text-slate-700">Evaluator Performance (all runs, this tenant)</div>
                {evalStats.stats.map((stat: any) => {
                  const pct = stat.avgScore != null ? Math.round(stat.avgScore * 100) : null
                  const isExpanded = expandedEval === stat.evaluatorId
                  const verdictColor = (v: string) => v === 'pass' ? 'text-green-700 bg-green-50' : v === 'fail' ? 'text-red-700 bg-red-50' : 'text-amber-700 bg-amber-50'
                  const VerdictIcon = ({ v }: { v: string }) => v === 'pass' ? <CheckCircle className="w-3 h-3" /> : v === 'fail' ? <XCircle className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />
                  const trendDir = stat.trend.length >= 2
                    ? (stat.trend[stat.trend.length - 1].avgScore ?? 0) >= (stat.trend[0].avgScore ?? 0)
                    : null

                  return (
                    <div key={stat.evaluatorId} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                      {/* Card header */}
                      <button
                        className="w-full flex items-center gap-4 p-4 text-left hover:bg-slate-50 transition-colors"
                        onClick={() => setExpandedEval(isExpanded ? null : stat.evaluatorId)}>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-sm font-semibold text-slate-900">{stat.evaluatorName}</span>
                            {stat.isBuiltin && <span className="text-[10px] bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded font-medium">BUILT-IN</span>}
                            <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">{stat.evaluatorCategory}</span>
                          </div>
                          <p className="text-xs text-slate-500 truncate">{stat.evaluatorDescription}</p>
                        </div>

                        {/* Score bar */}
                        <div className="w-32 flex-shrink-0">
                          <div className="flex justify-between text-xs mb-1">
                            <span className="text-slate-400">{stat.runCount} run{stat.runCount !== 1 ? 's' : ''}</span>
                            <span className={`font-semibold ${pct != null && pct >= 70 ? 'text-green-700' : pct != null && pct >= 50 ? 'text-amber-700' : 'text-red-700'}`}>
                              {pct != null ? `${pct}%` : '—'}
                            </span>
                          </div>
                          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full transition-all ${pct != null && pct >= 70 ? 'bg-green-500' : pct != null && pct >= 50 ? 'bg-amber-500' : 'bg-red-500'}`}
                              style={{ width: `${pct ?? 0}%` }} />
                          </div>
                          <div className="flex gap-2 mt-1 text-[10px] text-slate-400">
                            <span className="text-green-600">{stat.passCount}P</span>
                            <span className="text-amber-600">{stat.partialCount}W</span>
                            <span className="text-red-600">{stat.failCount}F</span>
                          </div>
                        </div>

                        {/* Trend indicator */}
                        <div className="flex-shrink-0 w-8 text-right">
                          {trendDir === true && <TrendingUp className="w-4 h-4 text-green-500" />}
                          {trendDir === false && <TrendingDown className="w-4 h-4 text-red-500" />}
                        </div>
                        <div className="flex-shrink-0">
                          {isExpanded ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
                        </div>
                      </button>

                      {/* Expanded detail */}
                      {isExpanded && (
                        <div className="border-t border-slate-100 p-4 space-y-4 bg-slate-50">
                          {/* Provenance narrative */}
                          {stat.provenanceNarrative && (
                            <div className="flex gap-2 bg-blue-50 border border-blue-100 rounded-lg p-3">
                              <Info className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
                              <p className="text-xs text-blue-800 leading-relaxed">{stat.provenanceNarrative}</p>
                            </div>
                          )}

                          {/* Score stats grid */}
                          <div className="grid grid-cols-4 gap-3">
                            {[
                              { label: 'Min', value: stat.minScore != null ? `${Math.round(stat.minScore * 100)}%` : '—' },
                              { label: 'Avg', value: stat.avgScore != null ? `${Math.round(stat.avgScore * 100)}%` : '—' },
                              { label: 'Max', value: stat.maxScore != null ? `${Math.round(stat.maxScore * 100)}%` : '—' },
                              { label: 'Std Dev', value: stat.scoreStddev != null ? `±${Math.round(stat.scoreStddev * 100)}%` : '—' },
                            ].map(({ label, value }) => (
                              <div key={label} className="bg-white rounded-lg border border-slate-200 p-2 text-center">
                                <div className="text-[10px] text-slate-400">{label}</div>
                                <div className="text-sm font-bold text-slate-900">{value}</div>
                              </div>
                            ))}
                          </div>

                          {/* Scoring dimensions */}
                          {stat.scoringDimensions?.length > 0 && (
                            <div>
                              <div className="text-xs font-medium text-slate-500 mb-1.5">Scoring Dimensions</div>
                              <div className="flex flex-wrap gap-1.5">
                                {stat.scoringDimensions.map((d: string) => (
                                  <span key={d} className="text-[11px] bg-purple-50 text-purple-700 border border-purple-100 px-2 py-0.5 rounded-full">
                                    {d.replace(/_/g, ' ')}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Trend sparkline (text-based) */}
                          {stat.trend?.length > 0 && (
                            <div>
                              <div className="text-xs font-medium text-slate-500 mb-1.5">30-day Trend</div>
                              <div className="flex items-end gap-1 h-12">
                                {stat.trend.map((t: any, i: number) => {
                                  const h = t.avgScore != null ? Math.round(t.avgScore * 100) : 0
                                  return (
                                    <div key={i} className="flex-1 flex flex-col items-center gap-0.5 group relative">
                                      <div className="w-full rounded-sm bg-brand-400 opacity-80 hover:opacity-100 transition-opacity"
                                        style={{ height: `${Math.max(h, 4)}%` }} title={`${t.day}: ${h}%`} />
                                      <div className="absolute bottom-full mb-1 bg-slate-800 text-white text-[9px] px-1.5 py-0.5 rounded hidden group-hover:block whitespace-nowrap z-10">
                                        {t.day?.slice(0, 10)}: {h}% ({t.count} run{t.count !== 1 ? 's' : ''})
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                              <div className="flex justify-between text-[9px] text-slate-300 mt-0.5">
                                <span>{stat.trend[0]?.day?.slice(0, 10)}</span>
                                <span>{stat.trend[stat.trend.length - 1]?.day?.slice(0, 10)}</span>
                              </div>
                            </div>
                          )}

                          {/* Recent results */}
                          {stat.recentResults?.length > 0 && (
                            <div>
                              <div className="text-xs font-medium text-slate-500 mb-1.5">Recent Results (last {stat.recentResults.length})</div>
                              <div className="space-y-1.5">
                                {stat.recentResults.map((r: any) => (
                                  <div key={r.id} className="bg-white rounded-lg border border-slate-200 p-3 flex items-start gap-3">
                                    <span className={`flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0 ${verdictColor(r.verdict)}`}>
                                      <VerdictIcon v={r.verdict} /> {r.verdict?.toUpperCase()}
                                    </span>
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-2">
                                        <span className={`text-sm font-bold ${r.score >= 0.7 ? 'text-green-700' : r.score >= 0.5 ? 'text-amber-700' : 'text-red-700'}`}>
                                          {r.score != null ? `${Math.round(r.score * 100)}%` : '—'}
                                        </span>
                                        <span className="text-[10px] text-slate-400">
                                          {r.createdAt ? new Date(r.createdAt).toLocaleString() : ''}
                                        </span>
                                        {r.judgeModel && <span className="text-[10px] text-slate-400">via {r.judgeModel}</span>}
                                      </div>
                                      {r.notes && <p className="text-xs text-slate-600 mt-0.5 line-clamp-2">{r.notes}</p>}
                                      <div className="flex items-center gap-2 mt-1">
                                        <a href={`/agents/runs/${r.runId}`} className="text-[10px] text-brand-500 hover:underline">
                                          View run →
                                        </a>
                                        <span className={`text-[10px] ${r.runStatus === 'completed' ? 'text-green-600' : 'text-slate-400'}`}>
                                          ({r.runStatus})
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Metadata footer */}
                          <div className="text-[10px] text-slate-400 flex gap-4">
                            {stat.firstEvaluatedAt && <span>First run: {new Date(stat.firstEvaluatedAt).toLocaleDateString()}</span>}
                            {stat.lastEvaluatedAt && <span>Last run: {new Date(stat.lastEvaluatedAt).toLocaleDateString()}</span>}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
