'use client'
import { useState, useCallback, useEffect, Suspense } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  addEdge,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { wfNodeTypes, type WfNodeData } from '@/components/flow/WorkflowFlowNodes'
import { useAuth, useOrgId } from '@/components/layout/AuthContext'
import { ArrowLeft, Save, Trash2, Play, Square, User, Bot, Globe, Bell, Timer, GitBranch } from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────

const ROLES = ['site_crc', 'site_pi', 'cro_data_manager', 'medical_monitor', 'safety_officer']

const PALETTE_SECTIONS = [
  {
    section: 'EVENTS',
    items: [
      { type: 'wf_start',  label: 'Start',  icon: Play,      color: '#22c55e', data: { label: 'Start' } },
      { type: 'wf_end',    label: 'End',    icon: Square,    color: '#ef4444', data: { label: 'End' } },
    ],
  },
  {
    section: 'TASKS',
    items: [
      { type: 'wf_user_task',   label: 'User Task',   icon: User,  color: '#3b82f6', data: { label: 'User Task' } },
      { type: 'wf_agent_task',  label: 'Agent Task',  icon: Bot,   color: '#6366f1', data: { label: 'Agent Task' } },
      { type: 'wf_api_task',    label: 'API Task',    icon: Globe, color: '#f97316', data: { label: 'API Task' } },
    ],
  },
  {
    section: 'CONTROL',
    items: [
      { type: 'wf_gateway', label: 'Gateway', icon: GitBranch, color: '#06b6d4', data: { label: 'Gateway' } },
      { type: 'wf_timer',   label: 'Timer',   icon: Timer,     color: '#eab308', data: { label: 'Timer', timerDuration: 'PT1H' } },
    ],
  },
  {
    section: 'NOTIFY',
    items: [
      { type: 'wf_notification', label: 'Notify', icon: Bell, color: '#14b8a6', data: { label: 'Notification' } },
    ],
  },
]

// ─────────────────────────────────────────────────────────────────────────────

interface FormInfo  { formId: string; title: string }
interface AgentInfo { id: string; name: string }

function WfPropertiesPanel({
  node,
  edge,
  onUpdateNode,
  onUpdateEdge,
  onDeleteNode,
  forms,
  agents,
}: {
  node: Node | null
  edge: Edge | null
  onUpdateNode: (id: string, patch: Partial<WfNodeData>) => void
  onUpdateEdge: (id: string, patch: Partial<Record<string, unknown>>) => void
  onDeleteNode: (id: string) => void
  forms: FormInfo[]
  agents: AgentInfo[]
}) {
  if (edge) {
    const edgeData = (edge.data || {}) as { condition?: string }
    return (
      <div className="h-full overflow-y-auto p-4 space-y-4">
        <h3 className="text-sm font-semibold text-slate-900">Edge Condition</h3>
        <p className="text-xs text-slate-500">
          Expression evaluated in FEEL. Example: <code className="bg-slate-100 px-1 rounded">severity == "critical"</code>
        </p>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Condition Expression</label>
          <input
            type="text"
            value={edgeData.condition || ''}
            onChange={e => onUpdateEdge(edge.id, { condition: e.target.value })}
            placeholder='severity == "critical"'
            className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>
    )
  }

  if (!node) {
    return (
      <div className="h-full flex items-center justify-center p-4">
        <p className="text-sm text-slate-400 text-center">Select a node or edge to edit its properties</p>
      </div>
    )
  }

  const d = node.data as WfNodeData
  const upd = (patch: Partial<WfNodeData>) => onUpdateNode(node.id, patch)
  const getStr = (k: keyof WfNodeData) => (d[k] as string) || ''

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900 capitalize">
          {node.type?.replace(/wf_/, '').replace(/_/g, ' ')} Properties
        </h3>
        {node.type !== 'wf_start' && node.type !== 'wf_end' && (
          <button
            onClick={() => onDeleteNode(node.id)}
            className="p-1 text-slate-400 hover:text-red-500 rounded"
            title="Delete node"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Common: label */}
      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1">Label</label>
        <input
          type="text"
          value={d.label || ''}
          onChange={e => upd({ label: e.target.value })}
          className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* wf_user_task */}
      {node.type === 'wf_user_task' && (
        <>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Attach Form</label>
            <select
              value={getStr('formId')}
              onChange={e => upd({ formId: e.target.value || undefined })}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">— None —</option>
              {forms.map(f => (
                <option key={f.formId} value={f.formId}>{f.title}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Assignee Role</label>
            <select
              value={getStr('assigneeRole')}
              onChange={e => upd({ assigneeRole: e.target.value })}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">— None —</option>
              {ROLES.map(r => (
                <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">SLA Hours</label>
            <input
              type="number"
              min={1}
              value={d.slaHours ?? ''}
              onChange={e => upd({ slaHours: e.target.value ? Number(e.target.value) : undefined })}
              placeholder="24"
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={!!d.requiresEsig}
              onChange={e => upd({ requiresEsig: e.target.checked })}
              className="rounded"
            />
            <span className="text-sm text-slate-700">Requires E-Signature (21 CFR Part 11)</span>
          </label>
        </>
      )}

      {/* wf_agent_task */}
      {node.type === 'wf_agent_task' && (
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Agent</label>
          <select
            value={getStr('agentId')}
            onChange={e => {
              const agent = agents.find(a => a.id === e.target.value)
              upd({ agentId: e.target.value || undefined, agentName: agent?.name })
            }}
            className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">— Select agent —</option>
            {agents.map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* wf_api_task */}
      {node.type === 'wf_api_task' && (
        <>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Method</label>
            <select
              value={getStr('apiMethod') || 'POST'}
              onChange={e => upd({ apiMethod: e.target.value })}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {['GET', 'POST', 'PUT'].map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">URL</label>
            <input
              type="text"
              value={getStr('apiUrl')}
              onChange={e => upd({ apiUrl: e.target.value })}
              placeholder="https://api.example.com/endpoint"
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Body (JSON template)</label>
            <textarea
              rows={4}
              value={getStr('apiBody')}
              onChange={e => upd({ apiBody: e.target.value })}
              placeholder='{"studyId": "{{studyId}}"}'
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>
        </>
      )}

      {/* wf_notification */}
      {node.type === 'wf_notification' && (
        <>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Recipient Role</label>
            <select
              value={getStr('notifRecipientRole')}
              onChange={e => upd({ notifRecipientRole: e.target.value })}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">— None —</option>
              {ROLES.map(r => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Message</label>
            <textarea
              rows={3}
              value={getStr('notifMessage')}
              onChange={e => upd({ notifMessage: e.target.value })}
              placeholder="Action required: please review..."
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>
        </>
      )}

      {/* wf_timer */}
      {node.type === 'wf_timer' && (
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Duration (ISO 8601)</label>
          <input
            type="text"
            value={getStr('timerDuration') || 'PT1H'}
            onChange={e => upd({ timerDuration: e.target.value })}
            placeholder="PT2H / P1D / PT30M"
            className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-xs text-slate-400 mt-1">PT2H = 2 hours · P1D = 1 day · PT30M = 30 minutes</p>
        </div>
      )}

      {/* wf_gateway */}
      {node.type === 'wf_gateway' && (
        <p className="text-xs text-slate-500 bg-slate-50 rounded-lg p-3">
          Select an outgoing edge from this gateway to set its condition expression.
        </p>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

let nodeCounter = 1

function WorkflowCanvasInner({ appId }: { appId: string }) {
  const router = useRouter()
  const orgId  = useOrgId()
  const { screenToFlowPosition } = useReactFlow()

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [selectedNode, setSelectedNode] = useState<Node | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<Edge | null>(null)
  const [processId, setProcessId] = useState('process-1')
  const [appName, setAppName] = useState('')
  const [saving, setSaving] = useState(false)
  const [forms, setForms]   = useState<FormInfo[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([])

  const gqlUrl = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
  const token  = () => decodeURIComponent(document.cookie.match(/trialo_token=([^;]+)/)?.[1] ?? '')

  // Load app + forms + agents on mount
  useEffect(() => {
    if (!appId || !orgId) return

    const gql = (query: string, variables: Record<string, unknown>) =>
      fetch(gqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      }).then(r => r.json())

    Promise.all([
      gql(
        `query($id: ID!, $orgId: String) {
          app(id: $id, orgId: $orgId) { id name slug workflowDefinition bpmnXml }
        }`,
        { id: appId, orgId }
      ),
      gql(
        `query($orgId: String!) { forms(orgId: $orgId) { formId title status } }`,
        { orgId }
      ),
      gql(
        `query($orgId: String!) { agents(orgId: $orgId) { id name } }`,
        { orgId }
      ),
    ]).then(([appData, formsData, agentsData]) => {
      const app = appData.data?.app
      if (app) {
        setAppName(app.name || '')
        if (app.workflowDefinition) {
          const wd = app.workflowDefinition as { nodes?: Node[]; edges?: Edge[]; processId?: string }
          if (wd.nodes) setNodes(wd.nodes)
          if (wd.edges) setEdges(wd.edges)
          if (wd.processId) setProcessId(wd.processId)
        }
      }
      setForms(formsData.data?.forms || [])
      setAgents(agentsData.data?.agents || [])
    }).catch(console.error)
  }, [appId, orgId])

  // Palette drag
  const onDragStart = (e: React.DragEvent, type: string, data: Partial<WfNodeData>) => {
    e.dataTransfer.setData('application/reactflow', JSON.stringify({ type, data }))
    e.dataTransfer.effectAllowed = 'move'
  }

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const raw = e.dataTransfer.getData('application/reactflow')
      if (!raw) return
      const { type, data } = JSON.parse(raw) as { type: string; data: Partial<WfNodeData> }
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const id = `${type}-${nodeCounter++}`
      setNodes(nds => [
        ...nds,
        { id, type, position, data: { ...data } } as Node,
      ])
    },
    [screenToFlowPosition]
  )

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges(eds => addEdge({ ...connection, animated: true }, eds))
    },
    [setEdges]
  )

  // Selection
  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode(node)
    setSelectedEdge(null)
  }, [])

  const onEdgeClick = useCallback((_: React.MouseEvent, edge: Edge) => {
    setSelectedEdge(edge)
    setSelectedNode(null)
  }, [])

  const onPaneClick = useCallback(() => {
    setSelectedNode(null)
    setSelectedEdge(null)
  }, [])

  // Update node data
  const onUpdateNode = useCallback((id: string, patch: Partial<WfNodeData>) => {
    setNodes(nds =>
      nds.map(n => n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)
    )
    setSelectedNode(prev => prev?.id === id ? { ...prev, data: { ...prev.data, ...patch } } : prev)
  }, [setNodes])

  // Update edge data
  const onUpdateEdge = useCallback((id: string, patch: Partial<Record<string, unknown>>) => {
    setEdges(eds =>
      eds.map(e => e.id === id ? { ...e, data: { ...(e.data || {}), ...patch } } : e)
    )
    setSelectedEdge(prev => prev?.id === id ? { ...prev, data: { ...(prev.data || {}), ...patch } } : prev)
  }, [setEdges])

  // Delete node
  const onDeleteNode = useCallback((id: string) => {
    setNodes(nds => nds.filter(n => n.id !== id))
    setEdges(eds => eds.filter(e => e.source !== id && e.target !== id))
    setSelectedNode(null)
  }, [setNodes, setEdges])

  // Save
  const handleSave = async () => {
    setSaving(true)
    try {
      const workflowDefinition = { nodes, edges, processId }
      const res = await fetch(gqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
        body: JSON.stringify({
          query: `mutation($id: ID!, $input: UpdateAppInput!) { updateApp(id: $id, input: $input) { id } }`,
          variables: { id: appId, input: { workflowDefinition } },
        }),
      })
      const json = await res.json()
      if (json.errors?.length) {
        alert(`Save failed: ${json.errors[0].message}`)
        return
      }
      router.push(`/apps/${appId}`)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 h-14 bg-white border-b border-slate-200 flex-shrink-0">
        <Link href={`/apps/${appId}`} className="text-slate-400 hover:text-slate-600">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1">
          <span className="text-sm font-semibold text-slate-900">{appName}</span>
          <span className="ml-2 text-xs text-slate-400">· Workflow Builder</span>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/apps/${appId}`}
            className="px-3 py-1.5 text-xs text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">
            Back to App
          </Link>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-brand-500 text-white rounded-lg text-xs font-medium hover:bg-brand-600 disabled:opacity-60"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? 'Saving…' : 'Save Workflow'}
          </button>
        </div>
      </div>

      {/* Body: palette | canvas | properties */}
      <div className="flex flex-1 overflow-hidden">
        {/* Palette */}
        <div className="w-52 bg-white border-r border-slate-200 overflow-y-auto flex-shrink-0 p-3 space-y-4">
          {PALETTE_SECTIONS.map(({ section, items }) => (
            <div key={section}>
              <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">{section}</p>
              <div className="space-y-1">
                {items.map(item => (
                  <div
                    key={`${item.type}-${item.label}`}
                    draggable
                    onDragStart={e => onDragStart(e, item.type, item.data)}
                    className="flex items-center gap-2 px-2 py-2 rounded-lg border border-slate-200 bg-white cursor-grab active:cursor-grabbing hover:border-slate-300 hover:bg-slate-50 select-none"
                  >
                    <item.icon className="w-3.5 h-3.5 flex-shrink-0" style={{ color: item.color }} />
                    <span className="text-xs text-slate-700 font-medium">{item.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Canvas */}
        <div className="flex-1 relative" onDrop={onDrop} onDragOver={onDragOver}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onPaneClick={onPaneClick}
            nodeTypes={wfNodeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
          >
            <Background gap={16} color="#e2e8f0" />
            <Controls />
            <MiniMap nodeStrokeWidth={3} />
          </ReactFlow>
          {nodes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center">
                <p className="text-slate-400 text-sm">Drag nodes from the palette to build your workflow</p>
                <p className="text-slate-300 text-xs mt-1">Connect nodes by dragging from a handle to another</p>
              </div>
            </div>
          )}
        </div>

        {/* Properties panel */}
        <div className="w-72 bg-white border-l border-slate-200 flex-shrink-0">
          <WfPropertiesPanel
            node={selectedNode}
            edge={selectedEdge}
            onUpdateNode={onUpdateNode}
            onUpdateEdge={onUpdateEdge}
            onDeleteNode={onDeleteNode}
            forms={forms}
            agents={agents}
          />
        </div>
      </div>
    </div>
  )
}

function WorkflowBuilderContent() {
  const params = useParams()
  const appId = params.id as string

  return (
    <ReactFlowProvider>
      <WorkflowCanvasInner appId={appId} />
    </ReactFlowProvider>
  )
}

export default function WorkflowBuilderPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading…</div>}>
      <WorkflowBuilderContent />
    </Suspense>
  )
}
