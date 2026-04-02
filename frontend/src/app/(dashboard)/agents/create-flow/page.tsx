'use client'
import { useState, useCallback, useRef, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useOrgId, useAuth } from '@/components/layout/AuthContext'
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
import { nodeTypes, type NodeData, type HitlInlineField } from '@/components/flow/FlowNodes'
import { toast } from 'sonner'
import {
  Database, Brain, Code2, BarChart2, FileText, ArrowRight, Trash2, ChevronDown,
  GitBranch, Bot, Network, BarChart3, MessageSquare, FolderCog, ShieldCheck,
  Wand2, BookMarked, ScanEye, ListTodo, FolderOpen, BrainCircuit,
  X, Save,
} from 'lucide-react'
import { clsx } from 'clsx'

// ── Constants ──────────────────────────────────────────────────────────────────

const AGENT_RUNTIME_URL = 'http://localhost:8004'
const MARKETPLACE_URL   = 'http://localhost:8005'

const SOURCE_TYPE_TO_TOOL: Record<string, string> = {
  sdtm: 'read_sdtm_domain',
  adam: 'read_adam_dataset',
  raw_edc: 'read_raw_edc_data',
  ctms: 'read_ctms_data',
  budget: 'query_budget_data',
  documents: 'search_documents',
  ig: 'search_implementation_guides',
  crf: 'read_crf_specification',
  sap: 'search_documents',
}

const RF_TO_API_TYPE: Record<string, string> = {
  dataSource: 'data_source',
  llm: 'llm',
  code: 'code',
  chart: 'chart',
  document: 'document',
  output: 'output',
  condition: 'condition',
  agent: 'agent',
  context_graph: 'context_graph',
  skill: 'skill',
  memory: 'memory',
  reflect: 'reflect',
  planner: 'planner',
  file_op: 'file_op',
  hitl: 'hitl',
}

const CONDITION_OPS = [
  { value: 'gt',           label: '>' },
  { value: 'lt',           label: '<' },
  { value: 'gte',          label: '>=' },
  { value: 'lte',          label: '<=' },
  { value: 'eq',           label: '=' },
  { value: 'neq',          label: '≠' },
  { value: 'contains',     label: 'contains' },
  { value: 'not_contains', label: 'not contains' },
]

interface PaletteItem {
  type: string
  label: string
  icon: React.ElementType
  sourceType?: string
  color?: string
}

const PALETTE_SECTIONS: { section: string; items: PaletteItem[] }[] = [
  { section: 'DATA', items: [
    { type: 'dataSource', label: 'SDTM',    icon: Database, sourceType: 'sdtm' },
    { type: 'dataSource', label: 'ADaM',    icon: Database, sourceType: 'adam' },
    { type: 'dataSource', label: 'Raw EDC', icon: Database, sourceType: 'raw_edc' },
    { type: 'dataSource', label: 'CTMS',    icon: Database, sourceType: 'ctms' },
    { type: 'dataSource', label: 'Budget',  icon: Database, sourceType: 'budget' },
    { type: 'dataSource', label: 'Docs',    icon: Database, sourceType: 'documents' },
    { type: 'dataSource', label: 'CRF',     icon: Database, sourceType: 'crf' },
    { type: 'dataSource', label: 'IGs',     icon: Database, sourceType: 'ig' },
    { type: 'dataSource', label: 'SAP',     icon: Database, sourceType: 'sap' },
  ]},
  { section: 'PROCESS', items: [
    { type: 'llm',  label: 'LLM',  icon: Brain },
    { type: 'code', label: 'Code', icon: Code2 },
  ]},
  { section: 'FLOW CONTROL', items: [
    { type: 'condition', label: 'Condition', icon: GitBranch, color: '#06b6d4' },
    { type: 'agent',     label: 'Agent',     icon: Bot,       color: '#6366f1' },
  ]},
  { section: 'KNOWLEDGE', items: [
    { type: 'context_graph', label: 'Context Graph', icon: Network, color: '#8b5cf6' },
  ]},
  { section: 'OUTPUT', items: [
    { type: 'chart',    label: 'Chart',    icon: BarChart2 },
    { type: 'document', label: 'Doc',      icon: FileText },
    { type: 'output',   label: 'Output',   icon: ArrowRight },
  ]},
  { section: 'DEEP AGENT', items: [
    { type: 'skill',   label: 'Skill',   icon: Wand2,      color: '#ec4899' },
    { type: 'memory',  label: 'Memory',  icon: BookMarked, color: '#0ea5e9' },
    { type: 'reflect', label: 'Reflect', icon: ScanEye,    color: '#f43f5e' },
    { type: 'planner', label: 'Planner', icon: ListTodo,   color: '#f59e0b' },
    { type: 'file_op', label: 'File',    icon: FolderOpen, color: '#10b981' },
  ]},
]

const CATEGORIES = [
  'data_management', 'safety', 'regulatory', 'pharmacovigilance',
  'biostatistics', 'clinical_operations', 'general',
]

const PURPOSES = [
  'adverse_event_review', 'data_quality_check', 'lab_review',
  'protocol_deviation', 'csr_generation', 'statistical_analysis', 'custom',
]

// ── Template starter flows ─────────────────────────────────────────────────────

const TEMPLATES: {
  id: string
  label: string
  description: string
  icon: React.ElementType
  color: string
  nodes: Partial<Node>[]
  edges: Partial<Edge>[]
}[] = [
  {
    id: 'chart',
    label: 'Dynamic Chart',
    description: 'Load data, analyse with LLM, render chart',
    icon: BarChart3,
    color: '#f97316',
    nodes: [
      { id: 't1', type: 'dataSource', position: { x: 50,  y: 150 }, data: { label: 'SDTM Data', sourceType: 'sdtm', tool: 'read_sdtm_domain' } },
      { id: 't2', type: 'llm',        position: { x: 250, y: 150 }, data: { label: 'Analyse', model: 'gemma:latest', provider: 'ollama', prompt: 'Summarise key findings from the data.' } },
      { id: 't3', type: 'chart',      position: { x: 450, y: 150 }, data: { label: 'Chart', chartType: 'bar' } },
      { id: 't4', type: 'output',     position: { x: 650, y: 150 }, data: { label: 'Output', outputFormat: 'narrative' } },
    ],
    edges: [
      { id: 'te1', source: 't1', target: 't2', animated: true },
      { id: 'te2', source: 't2', target: 't3', animated: true },
      { id: 'te3', source: 't3', target: 't4', animated: true },
    ],
  },
  {
    id: 'conversation',
    label: 'Conversation',
    description: 'Context graph + LLM for Q&A',
    icon: MessageSquare,
    color: '#8b5cf6',
    nodes: [
      { id: 't1', type: 'context_graph', position: { x: 50,  y: 150 }, data: { label: 'Context', queryTemplate: '{messages[-1]}', topK: 8 } },
      { id: 't2', type: 'llm',           position: { x: 280, y: 150 }, data: { label: 'Respond', model: 'gemma:latest', provider: 'ollama', prompt: 'Answer the question using the context provided.' } },
      { id: 't3', type: 'output',        position: { x: 500, y: 150 }, data: { label: 'Output', outputFormat: 'narrative' } },
    ],
    edges: [
      { id: 'te1', source: 't1', target: 't2', animated: true },
      { id: 'te2', source: 't2', target: 't3', animated: true },
    ],
  },
  {
    id: 'data_mgmt',
    label: 'Data Mgmt',
    description: 'Conditional routing on data quality',
    icon: FolderCog,
    color: '#3b82f6',
    nodes: [
      { id: 't1', type: 'dataSource', position: { x: 50,  y: 200 }, data: { label: 'SDTM Data', sourceType: 'sdtm', tool: 'read_sdtm_domain' } },
      { id: 't2', type: 'condition',  position: { x: 250, y: 200 }, data: { label: 'Has Data?', conditionField: 'data.t1.record_count', conditionOp: 'gt', conditionValue: '0' } },
      { id: 't3', type: 'llm',        position: { x: 450, y: 100 }, data: { label: 'Format',   model: 'gemma:latest', provider: 'ollama', prompt: 'Format the data for output.' } },
      { id: 't4', type: 'output',     position: { x: 450, y: 320 }, data: { label: 'No Data',  outputFormat: 'narrative', outputTitle: 'No records found' } },
      { id: 't5', type: 'output',     position: { x: 650, y: 100 }, data: { label: 'Output',   outputFormat: 'narrative' } },
    ],
    edges: [
      { id: 'te1', source: 't1', target: 't2', animated: true },
      { id: 'te2', source: 't2', target: 't3', animated: true, sourceHandle: 'true',  style: { stroke: '#22c55e' } },
      { id: 'te3', source: 't2', target: 't4', animated: true, sourceHandle: 'false', style: { stroke: '#ef4444' } },
      { id: 'te4', source: 't3', target: 't5', animated: true },
    ],
  },
  {
    id: 'data_quality',
    label: 'Data Quality',
    description: 'LLM quality check + branch on result',
    icon: ShieldCheck,
    color: '#22c55e',
    nodes: [
      { id: 't1', type: 'dataSource', position: { x: 50,  y: 200 }, data: { label: 'AE Data', sourceType: 'sdtm', tool: 'read_sdtm_domain' } },
      { id: 't2', type: 'llm',        position: { x: 250, y: 200 }, data: { label: 'QC Check', model: 'gemma:latest', provider: 'ollama', prompt: 'Check data quality and return a JSON with {"issues_found": true/false, "summary": "..."}' } },
      { id: 't3', type: 'condition',  position: { x: 450, y: 200 }, data: { label: 'Issues?', conditionField: 'data.t2.issues_found', conditionOp: 'eq', conditionValue: 'true' } },
      { id: 't4', type: 'output',     position: { x: 650, y: 100 }, data: { label: 'Pass',    outputFormat: 'narrative', outputTitle: 'QC Passed' } },
      { id: 't5', type: 'output',     position: { x: 650, y: 320 }, data: { label: 'Flagged', outputFormat: 'narrative', outputTitle: 'QC Issues Found' } },
    ],
    edges: [
      { id: 'te1', source: 't1', target: 't2', animated: true },
      { id: 'te2', source: 't2', target: 't3', animated: true },
      { id: 'te3', source: 't3', target: 't4', animated: true, sourceHandle: 'false', style: { stroke: '#22c55e' } },
      { id: 'te4', source: 't3', target: 't5', animated: true, sourceHandle: 'true',  style: { stroke: '#ef4444' } },
    ],
  },
]

// ── Reverse config: map API node config → ReactFlow NodeData keys ──────────────

function reverseConfig(type: string, config: Record<string, unknown>): Record<string, unknown> {
  if (type === 'data_source') return { tool: config.tool, params: config.params || {} }
  if (type === 'llm') {
    const sc = (config.expertise_scaffold as Record<string, unknown>) || {}
    return {
      provider: config.provider || 'ollama',
      model: config.model || '',
      prompt: config.prompt || '',
      systemPrompt: config.systemPrompt || '',
      temperature: config.temperature ?? 0,
      endpointUrl: config.endpointUrl || '',
      apiKey: config.apiKey || '',
      scaffoldRole: sc.role || '',
      scaffoldDomain: sc.domain || '',
      scaffoldConstraints: ((sc.constraints as string[]) || []).join('\n'),
      scaffoldReasoningStyle: sc.reasoning_style || '',
      scaffoldOutputFormat: sc.output_format || '',
    }
  }
  if (type === 'code') return { code: config.code || '' }
  if (type === 'chart') {
    const p = (config.params as Record<string, unknown>) || {}
    return { chartType: p.chart_type || 'bar', chartTitle: p.title || '', xField: p.x_field || '', yField: p.y_field || '', colorField: p.color_field || '' }
  }
  if (type === 'document') {
    const p = (config.params as Record<string, unknown>) || {}
    return { documentType: p.document_type || 'memo', docTitle: p.title || '', section: p.section || '' }
  }
  if (type === 'output') {
    const p = (config.params as Record<string, unknown>) || {}
    return { outputFormat: p.format || 'narrative', outputTitle: p.title || '' }
  }
  if (type === 'condition') return { conditionField: config.field || '', conditionOp: config.op || 'eq', conditionValue: config.value || '' }
  if (type === 'agent') return { agentId: config.agent_id || '', inputPrompt: config.input_prompt || '', timeoutSeconds: config.timeout ?? 60 }
  if (type === 'context_graph') return { graphId: config.graph_id || '', queryTemplate: config.query_template || '{messages[-1]}', topK: config.top_k ?? 8 }
  if (type === 'skill') return { skillId: config.skill_id || '', skillType: config.skill_type || '', skillParams: config.params || {} }
  if (type === 'memory') return { memoryOperation: config.operation || 'read', memoryKey: config.memory_key || '', memoryValuePath: config.value_path || '', memoryScopedToStudy: config.scoped_to_study ?? true }
  if (type === 'reflect') return { rubric: config.rubric || '', scoreThreshold: config.score_threshold ?? 0.7, reflectTargetNodeId: config.target_node_id || '' }
  if (type === 'planner') return { objective: config.objective || '', maxTasks: config.max_tasks ?? 5, contextHint: config.context_hint || '' }
  if (type === 'file_op') return { fileOperation: config.operation || 'read', filePath: config.path || '', fileContentSource: config.content_source || '' }
  if (type === 'hitl') return { hitlDescription: config.description || '', hitlFormId: config.form_id || '', hitlAssignedRole: config.assigned_role || '', hitlFieldMappings: config.field_mappings || {}, hitlInlineFields: config.fields || [] }
  return config
}

// ── Flow definition converter ──────────────────────────────────────────────────

function extractConfig(type: string, d: NodeData) {
  if (type === 'dataSource')
    return { tool: d.tool || SOURCE_TYPE_TO_TOOL[d.sourceType || 'sdtm'], params: d.params || {} }
  if (type === 'llm') {
    const scaffold: Record<string, unknown> = {}
    if (d.scaffoldRole)           scaffold.role            = d.scaffoldRole
    if (d.scaffoldDomain)         scaffold.domain          = d.scaffoldDomain
    if (d.scaffoldConstraints)    scaffold.constraints     = (d.scaffoldConstraints as string).split('\n').filter(Boolean)
    if (d.scaffoldReasoningStyle) scaffold.reasoning_style = d.scaffoldReasoningStyle
    if (d.scaffoldOutputFormat)   scaffold.output_format   = d.scaffoldOutputFormat
    return {
      provider: d.provider || 'ollama',
      model: d.model || 'gemma:latest',
      prompt: d.prompt || '',
      systemPrompt: d.systemPrompt || '',
      temperature: d.temperature ?? 0,
      ...(d.endpointUrl ? { endpointUrl: d.endpointUrl } : {}),
      ...(d.apiKey ? { apiKey: d.apiKey } : {}),
      expertise_scaffold: Object.keys(scaffold).length > 0 ? scaffold : undefined,
    }
  }
  if (type === 'code')
    return { language: 'python', code: d.code || '' }
  if (type === 'chart')
    return { tool: 'generate_chart', params: { chart_type: d.chartType || 'bar', title: d.chartTitle || '', x_field: d.xField || '', y_field: d.yField || '', color_field: d.colorField || '' } }
  if (type === 'document')
    return { tool: 'create_document', params: { document_type: d.documentType || 'memo', title: d.docTitle || '', section: d.section || '' } }
  if (type === 'output')
    return { tool: 'generate_pdf_report', params: { title: d.outputTitle || 'Output', format: d.outputFormat || 'narrative' } }
  if (type === 'condition')
    return { field: d.conditionField || '', op: d.conditionOp || 'eq', value: d.conditionValue || '' }
  if (type === 'agent')
    return { agent_id: d.agentId || '', input_prompt: d.inputPrompt || '', timeout: d.timeoutSeconds ?? 60 }
  if (type === 'context_graph')
    return { graph_id: d.graphId || '', query_template: d.queryTemplate || '{messages[-1]}', top_k: d.topK ?? 8 }
  if (type === 'skill')
    return { skill_id: d.skillId || '', skill_type: d.skillType || 'function', params: d.skillParams || {} }
  if (type === 'memory')
    return { operation: d.memoryOperation || 'read', memory_key: d.memoryKey || '', value_path: d.memoryValuePath || '', scoped_to_study: d.memoryScopedToStudy ?? true }
  if (type === 'reflect')
    return { rubric: d.rubric || '', score_threshold: d.scoreThreshold ?? 0.7, target_node_id: d.reflectTargetNodeId || '' }
  if (type === 'planner')
    return { objective: d.objective || '', max_tasks: d.maxTasks ?? 5, context_hint: d.contextHint || '' }
  if (type === 'file_op')
    return { operation: d.fileOperation || 'read', path: d.filePath || '', content_source: d.fileContentSource || '' }
  if (type === 'hitl')
    return { title: d.label || 'Human review required', description: d.hitlDescription || '', form_id: d.hitlFormId || null, assigned_role: d.hitlAssignedRole || null, field_mappings: d.hitlFieldMappings || {}, fields: d.hitlInlineFields || [] }
  return {}
}

function toFlowDefinition(nodes: Node[], edges: Edge[]) {
  return {
    nodes: nodes.map(n => ({
      id: n.id,
      type: RF_TO_API_TYPE[n.type!] || n.type,
      label: (n.data as NodeData).label,
      config: extractConfig(n.type!, n.data as NodeData),
    })),
    edges: edges.map(e => ({
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? null,
    })),
  }
}

// ── Properties Panel ───────────────────────────────────────────────────────────

interface ProviderInfo { provider: string; configured: boolean; models: string[] }
interface AgentInfo    { id: string; name: string; agent_mode: string }
interface GraphInfo    { id: string; name: string; document_count?: number }
interface SkillInfo    { id: string; name: string; skill_type: string; description: string }

interface FormInfo { formId: string; title: string }

function PropertiesPanel({
  node,
  onUpdate,
  onDelete,
  providers,
  availableAgents,
  availableGraphs,
  availableSkills,
  orgId,
  edges,
  allNodes,
}: {
  node: Node
  onUpdate: (id: string, patch: Partial<NodeData>) => void
  onDelete: (id: string) => void
  providers: ProviderInfo[]
  availableAgents: AgentInfo[]
  availableGraphs: GraphInfo[]
  availableSkills: SkillInfo[]
  orgId: string
  edges: Edge[]
  allNodes: Node[]
}) {
  const [scaffoldOpen, setScaffoldOpen] = useState(false)
  const [securityOpen, setSecurityOpen] = useState(false)
  const [codeValidation, setCodeValidation] = useState<{ valid: boolean; message: string } | null>(null)
  const [validating, setValidating] = useState(false)
  const [availableForms, setAvailableForms] = useState<FormInfo[]>([])
  const d   = node.data as NodeData
  const upd = (patch: Partial<NodeData>) => onUpdate(node.id, patch)
  const getStr = (key: keyof NodeData) => (d[key] as string) || ''

  const currentProvider   = getStr('provider') || 'ollama'
  const providerInfo      = providers.find(p => p.provider === currentProvider)
  const modelsForProvider = providerInfo?.models ?? []

  // Fetch forms when hitl node is selected
  useEffect(() => {
    if (node.type !== 'hitl' || !orgId) return
    const gqlUrl = process.env.NEXT_PUBLIC_GRAPHQL_URL || 'http://localhost:4000/graphql'
    fetch(gqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query($orgId: String!) { forms(orgId: $orgId) { formId title } }`,
        variables: { orgId },
      }),
    }).then(r => r.json()).then(d => setAvailableForms(d.data?.forms || [])).catch(() => {})
  }, [node.type, orgId])

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900 capitalize">{node.type?.replace('_', ' ')} Node</h3>
        <button
          onClick={() => onDelete(node.id)}
          className="p-1 text-slate-400 hover:text-red-500 rounded"
          title="Delete node"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1">Label</label>
        <input
          type="text"
          value={d.label || ''}
          onChange={e => upd({ label: e.target.value })}
          className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {node.type === 'dataSource' && (
        <>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Source Type</label>
            <select
              value={getStr('sourceType') || 'sdtm'}
              onChange={e => upd({ sourceType: e.target.value, tool: SOURCE_TYPE_TO_TOOL[e.target.value] })}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {Object.keys(SOURCE_TYPE_TO_TOOL).map(k => (
                <option key={k} value={k}>{k.toUpperCase().replace('_', ' ')}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Tool</label>
            <input
              type="text"
              value={getStr('tool') || SOURCE_TYPE_TO_TOOL[getStr('sourceType') || 'sdtm']}
              onChange={e => upd({ tool: e.target.value })}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-xs"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Params</label>
            {Object.entries((d.params as Record<string, string>) || {}).map(([k, v]) => (
              <div key={k} className="flex gap-1.5 mb-1.5">
                <input type="text" value={k} readOnly className="flex-1 px-2 py-1 border border-slate-200 rounded text-xs bg-slate-50" />
                <input
                  type="text" value={v}
                  onChange={e => upd({ params: { ...(d.params as Record<string, string> || {}), [k]: e.target.value } })}
                  className="flex-1 px-2 py-1 border border-slate-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                  onClick={() => {
                    const p = { ...(d.params as Record<string, string> || {}) }
                    delete p[k]; upd({ params: p })
                  }}
                  className="text-slate-400 hover:text-red-500 text-xs px-1"
                >×</button>
              </div>
            ))}
            <button
              onClick={() => upd({ params: { ...(d.params as Record<string, string> || {}), '': '' } })}
              className="text-xs text-blue-600 hover:text-blue-700 mt-1"
            >+ Add param</button>
          </div>
        </>
      )}

      {node.type === 'llm' && (
        <>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Provider</label>
            <select
              value={currentProvider}
              onChange={e => upd({ provider: e.target.value, model: '' })}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {providers.map(p => (
                <option key={p.provider} value={p.provider}>
                  {p.provider === 'ollama' ? 'Ollama (Local)' :
                   p.provider === 'openai' ? 'OpenAI' :
                   p.provider === 'anthropic' ? 'Anthropic' : 'Azure OpenAI'}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Model</label>
            {currentProvider === 'azure' ? (
              <input
                type="text"
                value={getStr('model')}
                onChange={e => upd({ model: e.target.value })}
                placeholder="Deployment name"
                className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            ) : (
              <select
                value={getStr('model') || modelsForProvider[0] || ''}
                onChange={e => upd({ model: e.target.value })}
                className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {modelsForProvider.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">System Prompt</label>
            <textarea
              rows={3} value={getStr('systemPrompt')}
              onChange={e => upd({ systemPrompt: e.target.value })}
              placeholder="You are a clinical AI agent..."
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Prompt</label>
            <textarea
              rows={4} value={getStr('prompt')}
              onChange={e => upd({ prompt: e.target.value })}
              placeholder="Analyse the data and provide clinical insights..."
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Temperature: {(d.temperature as number) ?? 0}
            </label>
            <input
              type="range" min={0} max={1} step={0.05}
              value={(d.temperature as number) ?? 0}
              onChange={e => upd({ temperature: parseFloat(e.target.value) })}
              className="w-full"
            />
          </div>
          {/* Security & Endpoint accordion */}
          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <button
              onClick={() => setSecurityOpen(o => !o)}
              className="w-full flex items-center justify-between px-3 py-2 bg-slate-50 hover:bg-slate-100 transition-colors"
            >
              <span className="flex items-center gap-1.5 text-xs font-medium text-slate-700">
                🔐 Security & Endpoint
              </span>
              <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${securityOpen ? 'rotate-180' : ''}`} />
            </button>
            {securityOpen && (
              <div className="px-3 py-3 space-y-3 bg-white">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Custom Endpoint URL</label>
                  <input
                    type="text" value={getStr('endpointUrl')}
                    onChange={e => upd({ endpointUrl: e.target.value })}
                    placeholder={
                      currentProvider === 'ollama' ? 'http://localhost:11434' :
                      currentProvider === 'azure' ? 'https://<resource>.openai.azure.com/' :
                      'Leave blank to use default'
                    }
                    className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <p className="text-[10px] text-slate-400 mt-0.5">Override the default provider endpoint</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">API Key</label>
                  <input
                    type="password" value={getStr('apiKey')}
                    onChange={e => upd({ apiKey: e.target.value })}
                    placeholder="sk-... or leave blank to use environment variable"
                    className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <p className="text-[10px] text-slate-400 mt-0.5">
                    {currentProvider === 'ollama' ? 'Not needed for local Ollama' :
                     currentProvider === 'azure' ? 'Azure subscription key' :
                     'If blank, uses OPENAI_API_KEY / ANTHROPIC_API_KEY env var'}
                  </p>
                </div>
              </div>
            )}
          </div>
          {/* Expertise Scaffold accordion */}
          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <button
              onClick={() => setScaffoldOpen(o => !o)}
              className="w-full flex items-center justify-between px-3 py-2 bg-slate-50 hover:bg-slate-100 transition-colors"
            >
              <span className="flex items-center gap-1.5 text-xs font-medium text-slate-700">
                <BrainCircuit className="w-3.5 h-3.5 text-purple-500" />
                Expertise Scaffold
              </span>
              <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${scaffoldOpen ? 'rotate-180' : ''}`} />
            </button>
            {scaffoldOpen && (
              <div className="px-3 py-3 space-y-3 bg-white">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Role</label>
                  <input
                    type="text" value={getStr('scaffoldRole')}
                    onChange={e => upd({ scaffoldRole: e.target.value })}
                    placeholder="e.g. Clinical Data Analyst"
                    className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-xs focus:outline-none focus:ring-1 focus:ring-purple-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Domain</label>
                  <input
                    type="text" value={getStr('scaffoldDomain')}
                    onChange={e => upd({ scaffoldDomain: e.target.value })}
                    placeholder="e.g. CDISC SDTM, Clinical Trials"
                    className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-xs focus:outline-none focus:ring-1 focus:ring-purple-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Constraints (one per line)</label>
                  <textarea
                    rows={3} value={getStr('scaffoldConstraints')}
                    onChange={e => upd({ scaffoldConstraints: e.target.value })}
                    placeholder={"Always cite data sources\nUse CDISC terminology"}
                    className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-xs focus:outline-none focus:ring-1 focus:ring-purple-500 resize-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Reasoning Style</label>
                  <select
                    value={getStr('scaffoldReasoningStyle') || 'chain-of-thought'}
                    onChange={e => upd({ scaffoldReasoningStyle: e.target.value })}
                    className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-xs bg-white focus:outline-none focus:ring-1 focus:ring-purple-500"
                  >
                    <option value="chain-of-thought">Chain of Thought</option>
                    <option value="step-by-step">Step by Step</option>
                    <option value="direct">Direct</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Output Format</label>
                  <input
                    type="text" value={getStr('scaffoldOutputFormat')}
                    onChange={e => upd({ scaffoldOutputFormat: e.target.value })}
                    placeholder="e.g. JSON, Markdown table, narrative"
                    className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-xs focus:outline-none focus:ring-1 focus:ring-purple-500"
                  />
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {node.type === 'code' && (
        <>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Language</label>
            <span className="inline-block px-2 py-0.5 text-xs bg-green-100 text-green-700 rounded font-mono">Python</span>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-medium text-slate-600">Code</label>
              <button
                onClick={async () => {
                  setValidating(true)
                  setCodeValidation(null)
                  try {
                    const res = await fetch(`${AGENT_RUNTIME_URL}/validate-code`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ code: getStr('code') }),
                    })
                    const data = await res.json() as { valid: boolean; errors?: { line: number; message: string }[] }
                    if (data.valid) {
                      setCodeValidation({ valid: true, message: '✓ Syntax valid' })
                    } else {
                      const err = (data.errors || []).map((e: { line: number; message: string }) => `Line ${e.line}: ${e.message}`).join('; ')
                      setCodeValidation({ valid: false, message: err || 'Syntax error' })
                    }
                  } catch {
                    setCodeValidation({ valid: false, message: 'Could not validate' })
                  } finally {
                    setValidating(false)
                  }
                }}
                disabled={validating || !getStr('code')}
                className="text-xs px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-600 disabled:opacity-40 transition-colors"
              >
                {validating ? 'Validating…' : 'Validate Syntax'}
              </button>
            </div>
            {codeValidation && (
              <div className={`mb-1.5 px-2.5 py-1.5 rounded text-xs font-mono ${codeValidation.valid ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                {codeValidation.message}
              </div>
            )}
            <p className="text-xs text-slate-400 mb-1">
              <code>state_data</code> available, assign to <code>result</code>
            </p>
            <textarea
              rows={12} value={getStr('code')}
              onChange={e => { upd({ code: e.target.value }); setCodeValidation(null) }}
              placeholder={'# state_data is available\n# assign your output to result\nresult = {"processed": True}'}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y bg-slate-900 text-green-300"
            />
          </div>
        </>
      )}

      {node.type === 'chart' && (
        <>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Chart Type</label>
            <select
              value={getStr('chartType') || 'bar'}
              onChange={e => upd({ chartType: e.target.value })}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {['bar', 'line', 'scatter', 'box', 'pie', 'histogram', 'heatmap'].map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          {([
            { key: 'chartTitle' as const, label: 'Title' },
            { key: 'xField'    as const, label: 'X Field' },
            { key: 'yField'    as const, label: 'Y Field' },
            { key: 'colorField' as const, label: 'Color Field' },
          ] as { key: keyof NodeData; label: string }[]).map(({ key, label }) => (
            <div key={String(key)}>
              <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
              <input
                type="text" value={getStr(key)}
                onChange={e => upd({ [key]: e.target.value } as Partial<NodeData>)}
                className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          ))}
        </>
      )}

      {node.type === 'document' && (
        <>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Document Type</label>
            <select
              value={getStr('documentType') || 'memo'}
              onChange={e => upd({ documentType: e.target.value })}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {['protocol_section', 'sap_section', 'memo', 'amendment', 'data_review_memo', 'statistical_analysis'].map(t => (
                <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </div>
          {([
            { key: 'docTitle' as const, label: 'Title' },
            { key: 'section'  as const, label: 'Section' },
          ] as { key: keyof NodeData; label: string }[]).map(({ key, label }) => (
            <div key={String(key)}>
              <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
              <input
                type="text" value={getStr(key)}
                onChange={e => upd({ [key]: e.target.value } as Partial<NodeData>)}
                className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          ))}
        </>
      )}

      {node.type === 'output' && (
        <>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Format</label>
            <select
              value={getStr('outputFormat') || 'narrative'}
              onChange={e => upd({ outputFormat: e.target.value })}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {['narrative', 'pdf', 'table', 'json'].map(f => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Title</label>
            <input
              type="text" value={getStr('outputTitle')}
              onChange={e => upd({ outputTitle: e.target.value })}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </>
      )}

      {node.type === 'condition' && (
        <>
          <p className="text-xs text-slate-500">Visual condition builder. No code required.</p>
          <div className="p-3 bg-cyan-50 rounded-lg border border-cyan-200 space-y-3">
            <p className="text-xs font-medium text-cyan-700">If</p>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Field (dot path)</label>
              <input
                type="text"
                value={getStr('conditionField')}
                onChange={e => upd({ conditionField: e.target.value })}
                placeholder="e.g. data.n1.record_count"
                className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-xs font-mono focus:outline-none focus:ring-2 focus:ring-cyan-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Operator</label>
              <select
                value={getStr('conditionOp') || 'eq'}
                onChange={e => upd({ conditionOp: e.target.value })}
                className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
              >
                {CONDITION_OPS.map(op => (
                  <option key={op.value} value={op.value}>{op.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Value</label>
              <input
                type="text"
                value={getStr('conditionValue')}
                onChange={e => upd({ conditionValue: e.target.value })}
                placeholder="0"
                className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
              />
            </div>
          </div>
          {/* Branch preview */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-slate-600">Branch outcomes</p>
            {['true', 'false'].map(branch => {
              const connectedEdges = edges.filter(e => e.source === node.id && e.sourceHandle === branch)
              const connectedNodeLabels = connectedEdges.map(e => {
                const target = allNodes.find(n => n.id === e.target)
                return (target?.data as NodeData)?.label || e.target
              })
              return (
                <div key={branch} className={`flex items-start gap-2 p-2 rounded-lg border ${branch === 'true' ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                  <span className={`w-2 h-2 rounded-full mt-0.5 flex-shrink-0 ${branch === 'true' ? 'bg-green-500' : 'bg-red-500'}`} />
                  <div>
                    <p className={`text-xs font-medium ${branch === 'true' ? 'text-green-700' : 'text-red-700'}`}>
                      {branch === 'true' ? 'True → right handle' : 'False → bottom handle'}
                    </p>
                    {connectedNodeLabels.length > 0 ? (
                      <p className="text-[10px] text-slate-500 mt-0.5">→ {connectedNodeLabels.join(', ')}</p>
                    ) : (
                      <p className="text-[10px] text-slate-400 mt-0.5 italic">No connection (drag from handle)</p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          <p className="text-xs text-slate-400">Drag from the green (right) or red (bottom) handle to connect branches.</p>
        </>
      )}

      {node.type === 'agent' && (
        <>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Agent</label>
            <select
              value={getStr('agentId')}
              onChange={e => {
                const a = availableAgents.find(ag => ag.id === e.target.value)
                upd({ agentId: e.target.value, agentName: a?.name, agentMode: a?.agent_mode })
              }}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">— Select agent —</option>
              {availableAgents.map(a => (
                <option key={a.id} value={a.id}>{a.name} ({a.agent_mode})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Input / Prompt</label>
            <textarea
              rows={4} value={getStr('inputPrompt')}
              onChange={e => upd({ inputPrompt: e.target.value })}
              placeholder="Pass context or instructions to the sub-agent..."
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Timeout: {(d.timeoutSeconds as number) ?? 60}s
            </label>
            <input
              type="range" min={10} max={120} step={5}
              value={(d.timeoutSeconds as number) ?? 60}
              onChange={e => upd({ timeoutSeconds: parseInt(e.target.value) })}
              className="w-full"
            />
          </div>
        </>
      )}

      {node.type === 'context_graph' && (
        <>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Graph</label>
            <select
              value={getStr('graphId')}
              onChange={e => {
                const g = availableGraphs.find(gr => gr.id === e.target.value)
                upd({ graphId: e.target.value, graphName: g?.name })
              }}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-500"
            >
              <option value="">— Select graph —</option>
              {availableGraphs.map(g => (
                <option key={g.id} value={g.id}>{g.name}{g.document_count != null ? ` (${g.document_count} docs)` : ''}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Query Template</label>
            <textarea
              rows={3} value={getStr('queryTemplate') || '{messages[-1]}'}
              onChange={e => upd({ queryTemplate: e.target.value })}
              placeholder="{messages[-1]}"
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-500 resize-none"
            />
            <p className="text-[10px] text-slate-400 mt-0.5">Use {'{'}messages[-1]{'}'} to reference the last message</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Top K results</label>
            <input
              type="number" min={1} max={20}
              value={(d.topK as number) ?? 8}
              onChange={e => upd({ topK: parseInt(e.target.value) })}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
          </div>
        </>
      )}

      {node.type === 'skill' && (
        <>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Skill</label>
            <select
              value={getStr('skillId')}
              onChange={e => {
                const s = availableSkills.find(sk => sk.id === e.target.value)
                upd({ skillId: e.target.value, skillName: s?.name, skillType: s?.skill_type })
              }}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-pink-500"
            >
              <option value="">— Select skill —</option>
              {availableSkills.map(s => (
                <option key={s.id} value={s.id}>{s.name} ({s.skill_type})</option>
              ))}
            </select>
            <a href="/agents/skills" target="_blank" className="text-xs text-pink-600 hover:underline mt-1 block">
              + Create new skill →
            </a>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Params</label>
            {Object.entries((d.skillParams as Record<string, string>) || {}).map(([k, v]) => (
              <div key={k} className="flex gap-1.5 mb-1.5">
                <input type="text" value={k} readOnly className="flex-1 px-2 py-1 border border-slate-200 rounded text-xs bg-slate-50" />
                <input
                  type="text" value={v}
                  onChange={e => upd({ skillParams: { ...(d.skillParams as Record<string, string> || {}), [k]: e.target.value } })}
                  className="flex-1 px-2 py-1 border border-slate-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-pink-500"
                />
                <button
                  onClick={() => {
                    const p = { ...(d.skillParams as Record<string, string> || {}) }
                    delete p[k]; upd({ skillParams: p })
                  }}
                  className="text-slate-400 hover:text-red-500 text-xs px-1"
                >×</button>
              </div>
            ))}
            <button
              onClick={() => upd({ skillParams: { ...(d.skillParams as Record<string, string> || {}), '': '' } })}
              className="text-xs text-pink-600 hover:text-pink-700 mt-1"
            >+ Add param</button>
          </div>
        </>
      )}

      {node.type === 'memory' && (
        <>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Operation</label>
            <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-medium">
              {['read', 'write'].map(op => (
                <button
                  key={op}
                  onClick={() => upd({ memoryOperation: op })}
                  className={`flex-1 px-3 py-1.5 capitalize transition-colors ${
                    (getStr('memoryOperation') || 'read') === op
                      ? 'bg-sky-500 text-white'
                      : 'bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >{op}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Memory Key</label>
            <input
              type="text" value={getStr('memoryKey')}
              onChange={e => upd({ memoryKey: e.target.value })}
              placeholder="e.g. last_run_summary"
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sky-500"
            />
          </div>
          {(getStr('memoryOperation') || 'read') === 'write' && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Value Dot Path</label>
              <input
                type="text" value={getStr('memoryValuePath')}
                onChange={e => upd({ memoryValuePath: e.target.value })}
                placeholder="e.g. data.n1.result"
                className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="scopedToStudy"
              checked={(d.memoryScopedToStudy as boolean) ?? true}
              onChange={e => upd({ memoryScopedToStudy: e.target.checked })}
              className="rounded border-slate-300 text-sky-500"
            />
            <label htmlFor="scopedToStudy" className="text-xs text-slate-600">Scoped to current study</label>
          </div>
        </>
      )}

      {node.type === 'reflect' && (
        <>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Rubric</label>
            <textarea
              rows={3} value={getStr('rubric')}
              onChange={e => upd({ rubric: e.target.value })}
              placeholder="Is this output accurate, complete, and well-reasoned?"
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-rose-500 resize-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Score Threshold: {((d.scoreThreshold as number) ?? 0.7).toFixed(2)}
            </label>
            <input
              type="range" min={0} max={1} step={0.05}
              value={(d.scoreThreshold as number) ?? 0.7}
              onChange={e => upd({ scoreThreshold: parseFloat(e.target.value) })}
              className="w-full accent-rose-500"
            />
            <p className="text-xs text-slate-400 mt-0.5">Score below this adds a correction signal to messages</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Target Node ID (optional)</label>
            <input
              type="text" value={getStr('reflectTargetNodeId')}
              onChange={e => upd({ reflectTargetNodeId: e.target.value })}
              placeholder="Leave empty to use last message"
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-xs font-mono focus:outline-none focus:ring-2 focus:ring-rose-500"
            />
          </div>
        </>
      )}

      {node.type === 'planner' && (
        <>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Objective</label>
            <textarea
              rows={3} value={getStr('objective')}
              onChange={e => upd({ objective: e.target.value })}
              placeholder="Leave empty to use the last message as objective"
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 resize-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Max Tasks: {(d.maxTasks as number) ?? 5}
            </label>
            <input
              type="range" min={2} max={10} step={1}
              value={(d.maxTasks as number) ?? 5}
              onChange={e => upd({ maxTasks: parseInt(e.target.value) })}
              className="w-full accent-amber-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Context Hint</label>
            <input
              type="text" value={getStr('contextHint')}
              onChange={e => upd({ contextHint: e.target.value })}
              placeholder="Optional context to guide planning"
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
            />
          </div>
        </>
      )}

      {node.type === 'file_op' && (
        <>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Operation</label>
            <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-medium">
              {['read', 'write', 'list'].map(op => (
                <button
                  key={op}
                  onClick={() => upd({ fileOperation: op })}
                  className={`flex-1 px-2 py-1.5 capitalize transition-colors ${
                    (getStr('fileOperation') || 'read') === op
                      ? 'bg-emerald-500 text-white'
                      : 'bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >{op}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Path</label>
            <input
              type="text" value={getStr('filePath')}
              onChange={e => upd({ filePath: e.target.value })}
              placeholder="e.g. reports/output.json"
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <p className="text-xs text-slate-400 mt-0.5">Namespaced under org/study/files/ in MinIO</p>
          </div>
          {(getStr('fileOperation') || 'read') === 'write' && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Content Dot Path</label>
              <input
                type="text" value={getStr('fileContentSource')}
                onChange={e => upd({ fileContentSource: e.target.value })}
                placeholder="e.g. data.n1.result"
                className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
          )}
        </>
      )}

      {node.type === 'hitl' && (
        <>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Description</label>
            <textarea
              rows={2} value={getStr('hitlDescription')}
              onChange={e => upd({ hitlDescription: e.target.value })}
              placeholder="Describe what the assignee needs to do"
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 resize-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Assign to Role</label>
            <select
              value={getStr('hitlAssignedRole')}
              onChange={e => upd({ hitlAssignedRole: e.target.value })}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500"
            >
              <option value="">— select role —</option>
              <option value="data-manager">Data Manager</option>
              <option value="medical-monitor">Medical Monitor</option>
              <option value="statistician">Statistician</option>
              <option value="study-coordinator">Study Coordinator</option>
              <option value="principal-investigator">Principal Investigator</option>
              <option value="quality-assurance">Quality Assurance</option>
              <option value="admin">Admin</option>
            </select>
          </div>

          {/* Inline Form Fields Builder */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-medium text-slate-600">Form Fields</label>
              <button
                onClick={() => {
                  const fields: HitlInlineField[] = [...((d.hitlInlineFields as HitlInlineField[]) || [])]
                  fields.push({ name: `field_${fields.length + 1}`, label: 'New Field', type: 'text', required: false, editable: true })
                  upd({ hitlInlineFields: fields })
                }}
                className="text-xs text-amber-600 hover:text-amber-700"
              >+ Add field</button>
            </div>
            <div className="space-y-2">
              {((d.hitlInlineFields as HitlInlineField[]) || []).map((field, i) => (
                <div key={i} className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg space-y-1.5">
                  <div className="flex gap-1.5">
                    <input
                      type="text" value={field.name} placeholder="field_name"
                      onChange={e => {
                        const fields = [...((d.hitlInlineFields as HitlInlineField[]) || [])]
                        fields[i] = { ...fields[i], name: e.target.value }
                        upd({ hitlInlineFields: fields })
                      }}
                      className="flex-1 px-2 py-1 border border-slate-200 rounded text-xs font-mono focus:outline-none focus:ring-1 focus:ring-amber-500"
                    />
                    <select
                      value={field.type}
                      onChange={e => {
                        const fields = [...((d.hitlInlineFields as HitlInlineField[]) || [])]
                        fields[i] = { ...fields[i], type: e.target.value as HitlInlineField['type'] }
                        upd({ hitlInlineFields: fields })
                      }}
                      className="px-2 py-1 border border-slate-200 rounded text-xs bg-white focus:outline-none focus:ring-1 focus:ring-amber-500"
                    >
                      <option value="text">text</option>
                      <option value="textarea">textarea</option>
                      <option value="number">number</option>
                      <option value="boolean">boolean</option>
                      <option value="select">select</option>
                    </select>
                    <button
                      onClick={() => {
                        const fields = ((d.hitlInlineFields as HitlInlineField[]) || []).filter((_, fi) => fi !== i)
                        upd({ hitlInlineFields: fields })
                      }}
                      className="text-slate-400 hover:text-red-500 px-1 text-xs"
                    >×</button>
                  </div>
                  <input
                    type="text" value={field.label} placeholder="Display label"
                    onChange={e => {
                      const fields = [...((d.hitlInlineFields as HitlInlineField[]) || [])]
                      fields[i] = { ...fields[i], label: e.target.value }
                      upd({ hitlInlineFields: fields })
                    }}
                    className="w-full px-2 py-1 border border-slate-200 rounded text-xs focus:outline-none focus:ring-1 focus:ring-amber-500"
                  />
                  {field.type === 'select' && (
                    <input
                      type="text" value={(field.options || []).join(',')} placeholder="opt1,opt2,opt3"
                      onChange={e => {
                        const fields = [...((d.hitlInlineFields as HitlInlineField[]) || [])]
                        fields[i] = { ...fields[i], options: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }
                        upd({ hitlInlineFields: fields })
                      }}
                      className="w-full px-2 py-1 border border-slate-200 rounded text-xs font-mono focus:outline-none focus:ring-1 focus:ring-amber-500"
                    />
                  )}
                  <div className="flex gap-3 text-xs">
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input type="checkbox" checked={!!field.required}
                        onChange={e => {
                          const fields = [...((d.hitlInlineFields as HitlInlineField[]) || [])]
                          fields[i] = { ...fields[i], required: e.target.checked }
                          upd({ hitlInlineFields: fields })
                        }}
                        className="rounded border-slate-300" />
                      Required
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input type="checkbox" checked={field.editable !== false}
                        onChange={e => {
                          const fields = [...((d.hitlInlineFields as HitlInlineField[]) || [])]
                          fields[i] = { ...fields[i], editable: e.target.checked }
                          upd({ hitlInlineFields: fields })
                        }}
                        className="rounded border-slate-300" />
                      Editable
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Form Preview */}
          {((d.hitlInlineFields as HitlInlineField[]) || []).length > 0 && (
            <div className="border border-dashed border-amber-300 rounded-lg p-3 bg-amber-50/50">
              <p className="text-xs font-medium text-amber-700 mb-2">Form Preview</p>
              <div className="space-y-2">
                {((d.hitlInlineFields as HitlInlineField[]) || []).map((field, i) => (
                  <div key={i}>
                    <label className="block text-xs text-slate-600 mb-0.5">
                      {field.label || field.name}
                      {field.required && <span className="text-red-500 ml-0.5">*</span>}
                    </label>
                    {field.type === 'textarea' ? (
                      <textarea rows={2} disabled placeholder="(reviewer input)" className="w-full px-2 py-1 border border-slate-200 rounded text-xs bg-white resize-none text-slate-400" />
                    ) : field.type === 'boolean' ? (
                      <div className="flex items-center gap-2"><input type="checkbox" disabled className="rounded" /><span className="text-xs text-slate-400">Yes / No</span></div>
                    ) : field.type === 'select' ? (
                      <select disabled className="w-full px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-400">
                        <option>{(field.options || ['Option 1'])[0]}</option>
                      </select>
                    ) : (
                      <input type={field.type === 'number' ? 'number' : 'text'} disabled placeholder="(reviewer input)" className="w-full px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-400" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Optional: Attach existing form from Forms Library */}
          <div className="border-t border-slate-100 pt-3">
            <label className="block text-xs font-medium text-slate-600 mb-1">Or attach a Form from Forms Library</label>
            <select
              value={getStr('hitlFormId')}
              onChange={e => upd({ hitlFormId: e.target.value })}
              className="w-full px-2.5 py-1.5 border border-slate-200 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-500"
            >
              <option value="">— no form —</option>
              {availableForms.map(f => (
                <option key={f.formId} value={f.formId}>{f.title}</option>
              ))}
            </select>
            {availableForms.length === 0 && (
              <p className="text-xs text-slate-400 mt-0.5">No forms found — build one in Forms Library first</p>
            )}
          </div>
          {getStr('hitlFormId') && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Pre-fill from previous steps
                <span className="text-slate-400 font-normal ml-1">(form field → node path)</span>
              </label>
              {Object.entries((d.hitlFieldMappings as Record<string, string>) || {}).map(([formField, nodePath], i) => (
                <div key={i} className="flex gap-1.5 mb-1.5">
                  <input
                    type="text" value={formField} placeholder="form_field"
                    onChange={e => {
                      const m = { ...(d.hitlFieldMappings as Record<string, string> || {}) }
                      const val = m[formField]; delete m[formField]; m[e.target.value] = val
                      upd({ hitlFieldMappings: m })
                    }}
                    className="flex-1 px-2 py-1 border border-slate-200 rounded text-xs font-mono focus:outline-none focus:ring-1 focus:ring-amber-500"
                  />
                  <input
                    type="text" value={nodePath} placeholder="nodeId.key"
                    onChange={e => upd({ hitlFieldMappings: { ...(d.hitlFieldMappings as Record<string, string> || {}), [formField]: e.target.value } })}
                    className="flex-1 px-2 py-1 border border-slate-200 rounded text-xs font-mono focus:outline-none focus:ring-1 focus:ring-amber-500"
                  />
                  <button
                    onClick={() => {
                      const m = { ...(d.hitlFieldMappings as Record<string, string> || {}) }
                      delete m[formField]; upd({ hitlFieldMappings: m })
                    }}
                    className="text-slate-400 hover:text-red-500 text-xs px-1"
                  >×</button>
                </div>
              ))}
              <button
                onClick={() => upd({ hitlFieldMappings: { ...(d.hitlFieldMappings as Record<string, string> || {}), '': '' } })}
                className="text-xs text-amber-600 hover:text-amber-700 mt-1"
              >+ Add mapping</button>
              <p className="text-xs text-slate-400 mt-1">
                e.g. <code className="font-mono">subject_id</code> → <code className="font-mono">node_1.records.0.subject</code>
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Version Dialog ─────────────────────────────────────────────────────────────

function VersionDialog({
  currentVersion,
  onSave,
  onCancel,
}: {
  currentVersion: string
  onSave: (changeType: 'major' | 'minor', reason: string) => void
  onCancel: () => void
}) {
  const [changeType, setChangeType] = useState<'major' | 'minor'>('minor')
  const [reason, setReason] = useState('')
  const v = currentVersion || '1.0.0'
  const parts = v.split('.').map(Number)
  const preview = changeType === 'major'
    ? `${(parts[0] || 1) + 1}.0.0`
    : `${parts[0] || 1}.${(parts[1] || 0) + 1}.0`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-900">Save New Version</h2>
          <button onClick={onCancel} className="p-1 hover:bg-slate-100 rounded-lg">
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-2">Version bump</label>
            <div className="flex gap-3">
              {(['minor', 'major'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setChangeType(t)}
                  className={clsx('flex-1 py-2 rounded-lg border text-sm font-medium transition-colors', {
                    'bg-blue-600 text-white border-blue-600': changeType === t,
                    'bg-white text-slate-600 border-slate-200 hover:bg-slate-50': changeType !== t,
                  })}
                >
                  {t === 'minor' ? 'Minor' : 'Major'}
                  <span className="block text-xs mt-0.5 opacity-70">
                    {v} → {t === 'minor' ? `${parts[0]}.${(parts[1] || 0) + 1}.0` : `${(parts[0] || 1) + 1}.0.0`}
                  </span>
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-400 mt-1.5">
              New version: <span className="font-mono font-medium text-slate-700">{preview}</span>
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Change reason <span className="text-red-500">*</span>
            </label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={3}
              placeholder="Describe what changed and why..."
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>
        </div>
        <div className="px-5 py-4 border-t border-slate-100 flex justify-end gap-2">
          <button onClick={onCancel}
            className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg transition-colors">
            Cancel
          </button>
          <button
            onClick={() => reason.trim() && onSave(changeType, reason.trim())}
            disabled={!reason.trim()}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
            <Save className="w-4 h-4" /> Save & Activate
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Template overlay ───────────────────────────────────────────────────────────

function TemplateOverlay({ onSelect }: { onSelect: (templateId: string) => void }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900/60 z-10 backdrop-blur-sm">
      <div className="bg-white rounded-xl shadow-2xl p-6 max-w-xl w-full mx-4">
        <h2 className="text-base font-bold text-slate-900 mb-1">Start with a template</h2>
        <p className="text-xs text-slate-500 mb-4">Choose a starter flow or drag nodes from the palette to start from scratch</p>
        <div className="grid grid-cols-2 gap-3">
          {TEMPLATES.map(t => (
            <button
              key={t.id}
              onClick={() => onSelect(t.id)}
              className="flex items-start gap-3 p-3 rounded-lg border border-slate-200 hover:border-blue-300 hover:bg-blue-50 transition-all text-left group"
            >
              <div
                className="w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0 mt-0.5"
                style={{ backgroundColor: `${t.color}20` }}
              >
                <t.icon className="w-4 h-4" style={{ color: t.color }} />
              </div>
              <div>
                <div className="text-sm font-semibold text-slate-900 group-hover:text-blue-700">{t.label}</div>
                <div className="text-xs text-slate-500 mt-0.5">{t.description}</div>
              </div>
            </button>
          ))}
        </div>
        <button
          onClick={() => onSelect('')}
          className="mt-3 text-xs text-slate-400 hover:text-slate-600 w-full text-center"
        >
          Start from scratch →
        </button>
      </div>
    </div>
  )
}

// ── Main Flow Builder ─────────────────────────────────────────────────────────

let nodeCounter = 0
function newNodeId() {
  return `node_${++nodeCounter}_${Date.now()}`
}

const NODE_TYPE_MAP_CF: Record<string, string> = {
  data_source: 'dataSource',
  llm: 'llm',
  code: 'code',
  chart: 'chart',
  document: 'document',
  output: 'output',
  hitl: 'hitl',
  condition: 'condition',
  agent: 'agent',
  context_graph: 'context_graph',
  skill: 'skill',
  memory: 'memory',
  reflect: 'reflect',
  planner: 'planner',
  file_op: 'file_op',
}

function layoutNodesForEdit(nodes: any[], edges: any[]) {
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
    const rfType = NODE_TYPE_MAP_CF[n.type] || n.type || 'dataSource'
    return {
      id: n.id,
      type: rfType,
      position: { x: l * COL_W + 40, y: idx * ROW_H - ((total - 1) * ROW_H) / 2 + 200 },
      data: { label: n.label, ...reverseConfig(n.type, n.config || {}) },
    }
  })
}

function FlowBuilder() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const editId = searchParams.get('edit_id')
  const orgId  = useOrgId()
  const { user } = useAuth()
  const { screenToFlowPosition } = useReactFlow()
  const reactFlowWrapper = useRef<HTMLDivElement>(null)

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [selectedNode, setSelectedNode]  = useState<Node | null>(null)
  const [saving, setSaving]              = useState(false)
  const [showTemplates, setShowTemplates] = useState(true)
  const [showVersionDialog, setShowVersionDialog] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [editAgent, setEditAgent] = useState<any>(null)

  const [name,     setName]     = useState('')
  const [category, setCategory] = useState('data_management')
  const [purpose,  setPurpose]  = useState('custom')
  const [agentMode, setAgentMode] = useState<'standard' | 'deep'>('standard')

  // Data for pickers
  const [providers,       setProviders]       = useState<ProviderInfo[]>([{ provider: 'ollama', configured: true, models: ['gemma:latest'] }])
  const [availableAgents, setAvailableAgents] = useState<AgentInfo[]>([])
  const [availableGraphs, setAvailableGraphs] = useState<GraphInfo[]>([])
  const [availableSkills, setAvailableSkills] = useState<SkillInfo[]>([])

  useEffect(() => {
    if (editId && orgId) {
      // Edit mode: load existing agent
      fetch(`${MARKETPLACE_URL}/agents/by-id/${editId}?org_id=${orgId}`)
        .then(r => r.json())
        .then(agent => {
          setEditAgent(agent)
          setEditMode(true)
          setName(agent.name || '')
          setCategory(agent.category || 'data_management')
          setAgentMode(agent.agent_mode || 'standard')
          const fd = agent.flow_definition
          if (fd) {
            const rawNodes = fd.nodes || []
            const rawEdges = (fd.edges || []).map((e: any, i: number) => ({
              id: `e${i}`, source: e.source, target: e.target,
              type: 'smoothstep', animated: true,
            }))
            setNodes(layoutNodesForEdit(rawNodes, fd.edges || []) as Node[])
            setEdges(rawEdges)
            setShowTemplates(false)
          }
        })
        .catch(console.error)
      return
    }
    // Load pre-generated flow from Agent Builder
    const pendingFlow = sessionStorage.getItem('pending_flow')
    if (pendingFlow) {
      try {
        const { nodes: pNodes, edges: pEdges, agentName, agentDescription, category: pCategory } = JSON.parse(pendingFlow)
        if (pNodes?.length) {
          setNodes(layoutNodesForEdit(pNodes, pEdges || []) as Node[])
        }
        if (pEdges?.length) {
          setEdges(pEdges.map((e: any, i: number) => ({
            id: e.id || `e${i}`,
            source: e.source,
            target: e.target,
            type: 'smoothstep',
            animated: true,
          })))
        }
        if (agentName) setName(agentName)
        if (pCategory) setCategory(pCategory)
        setShowTemplates(false)
      } catch {}
      sessionStorage.removeItem('pending_flow')
    }
  }, [editId, orgId]) // eslint-disable-line

  useEffect(() => {
    if (!orgId) return
    // Fetch providers
    fetch(`${AGENT_RUNTIME_URL}/providers/available`)
      .then(r => r.json())
      .then(d => { if (d.providers?.length) setProviders(d.providers) })
      .catch(() => {})
    // Fetch available agents
    fetch(`${AGENT_RUNTIME_URL}/agents/available?org_id=${orgId}`)
      .then(r => r.json())
      .then(d => { if (d.agents) setAvailableAgents(d.agents) })
      .catch(() => {})
    // Fetch standard graphs
    fetch(`${AGENT_RUNTIME_URL}/standard-graphs?org_id=${orgId}`)
      .then(r => r.json())
      .then(d => { if (d.graphs) setAvailableGraphs(d.graphs) })
      .catch(() => {})
    // Fetch skills
    fetch(`${MARKETPLACE_URL}/skills?org_id=${orgId}`)
      .then(r => r.json())
      .then(d => { if (d.skills) setAvailableSkills(d.skills) })
      .catch(() => {})
  }, [orgId])

  const applyTemplate = useCallback((templateId: string) => {
    setShowTemplates(false)
    if (!templateId) return
    const tpl = TEMPLATES.find(t => t.id === templateId)
    if (!tpl) return
    setNodes(tpl.nodes as Node[])
    setEdges(tpl.edges as Edge[])
  }, [setNodes, setEdges])

  const onConnect = useCallback(
    (params: Connection) => {
      // Prompt for sourceHandle when connecting from a condition node
      const sourceNode = nodes.find(n => n.id === params.source)
      if (sourceNode?.type === 'condition') {
        const handle = params.sourceHandle || window.prompt('Branch? (true / false)', 'true')
        if (!handle) return
        const edgeStyle = handle === 'true' ? { stroke: '#22c55e' } : { stroke: '#ef4444' }
        setEdges(es => addEdge({ ...params, sourceHandle: handle, animated: true, style: edgeStyle }, es))
      } else {
        setEdges(es => addEdge({ ...params, animated: true }, es))
      }
    },
    [setEdges, nodes],
  )

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode(node)
  }, [])

  const onPaneClick = useCallback(() => setSelectedNode(null), [])

  const updateNodeData = useCallback((id: string, patch: Partial<NodeData>) => {
    setNodes(ns =>
      ns.map(n => n.id === id ? { ...n, data: { ...n.data, ...patch } } : n),
    )
    setSelectedNode(prev =>
      prev?.id === id ? { ...prev, data: { ...prev.data, ...patch } } : prev,
    )
  }, [setNodes])

  const deleteNode = useCallback((id: string) => {
    setNodes(ns => ns.filter(n => n.id !== id))
    setEdges(es => es.filter(e => e.source !== id && e.target !== id))
    setSelectedNode(null)
  }, [setNodes, setEdges])

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const raw = e.dataTransfer.getData('application/reactflow')
      if (!raw) return
      setShowTemplates(false)
      const { type, defaultData } = JSON.parse(raw) as { type: string; defaultData: Partial<NodeData> }
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const id = newNodeId()
      setNodes(ns => [
        ...ns,
        {
          id,
          type,
          position,
          data: { label: defaultData?.label || type, ...defaultData },
        },
      ])
    },
    [screenToFlowPosition, setNodes],
  )

  const handleSave = async () => {
    if (!name.trim()) { toast.error('Please enter an agent name'); return }
    if (nodes.length === 0) { toast.error('Add at least one node to the canvas'); return }
    if (editMode && editId) {
      setShowVersionDialog(true)
      return
    }
    setSaving(true)
    try {
      const flowDefinition = toFlowDefinition(nodes, edges)
      const res = await fetch(`${MARKETPLACE_URL}/agents/create-flow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_id: orgId,
          created_by: user?.id ?? '00000000-0000-0000-0000-000000000002',
          name: name.trim(),
          description: `Flow agent: ${name.trim()}`,
          category,
          agent_purpose: purpose,
          agent_mode: agentMode,
          flow_definition: flowDefinition,
          output_format: 'narrative',
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { detail?: string }
        throw new Error(err.detail || 'Failed to create agent')
      }
      toast.success('Flow agent created and activated!')
      router.push('/agents')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      toast.error(`Error: ${message}`)
    } finally {
      setSaving(false)
    }
  }

  const handleSaveEdit = async (changeType: 'major' | 'minor', changeReason: string) => {
    if (!editId) return
    setShowVersionDialog(false)
    setSaving(true)
    try {
      const flowDefinition = toFlowDefinition(nodes, edges)
      const putRes = await fetch(`${MARKETPLACE_URL}/agents/${editId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_id: orgId,
          updated_by: user?.id ?? '00000000-0000-0000-0000-000000000002',
          change_type: changeType,
          change_reason: changeReason,
          name: name.trim(),
          description: `Flow agent: ${name.trim()}`,
          category,
          flow_definition: flowDefinition,
          agent_mode: agentMode,
        }),
      })
      if (!putRes.ok) {
        const err = await putRes.json().catch(() => ({})) as { detail?: string }
        throw new Error(err.detail || 'Failed to update agent')
      }
      const putData = await putRes.json()

      const activateRes = await fetch(`${MARKETPLACE_URL}/agents/${editId}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_id: orgId,
          version: putData.version,
          activated_by: user?.id ?? '00000000-0000-0000-0000-000000000002',
        }),
      })
      if (!activateRes.ok) {
        const err = await activateRes.json().catch(() => ({})) as { detail?: string }
        throw new Error(err.detail || 'Failed to activate version')
      }
      toast.success('Agent updated and activated!')
      router.push(`/agents/flow-view/${editAgent?.slug}`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      toast.error(`Error: ${message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col h-screen bg-white overflow-hidden">
      {showVersionDialog && (
        <VersionDialog
          currentVersion={editAgent?.version || '1.0.0'}
          onSave={handleSaveEdit}
          onCancel={() => setShowVersionDialog(false)}
        />
      )}
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-slate-200 bg-white flex-shrink-0">
        <span className="text-sm font-semibold text-slate-800 mr-2">
          {editMode ? `Editing: ${editAgent?.name || '…'}` : 'Flow Builder'}
        </span>
        <input
          type="text"
          placeholder="Agent name *"
          value={name}
          onChange={e => setName(e.target.value)}
          className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm w-52 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <div className="relative">
          <select
            value={category}
            onChange={e => setCategory(e.target.value)}
            className="appearance-none pl-3 pr-7 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {CATEGORIES.map(c => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
          </select>
          <ChevronDown className="absolute right-2 top-2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
        </div>
        <div className="relative">
          <select
            value={purpose}
            onChange={e => setPurpose(e.target.value)}
            className="appearance-none pl-3 pr-7 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {PURPOSES.map(p => <option key={p} value={p}>{p.replace(/_/g, ' ')}</option>)}
          </select>
          <ChevronDown className="absolute right-2 top-2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
        </div>

        {/* Agent mode toggle */}
        <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-medium">
          <button
            onClick={() => setAgentMode('standard')}
            className={`px-3 py-1.5 transition-colors ${
              agentMode === 'standard' ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            Standard
          </button>
          <button
            onClick={() => setAgentMode('deep')}
            className={`px-3 py-1.5 transition-colors ${
              agentMode === 'deep' ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            Deep Agent
          </button>
        </div>

        <div className="flex-1" />
        <button
          onClick={() => { setNodes([]); setEdges([]); setSelectedNode(null); setShowTemplates(true) }}
          className="px-3 py-1.5 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50"
        >
          Clear
        </button>
        <button
          onClick={handleSave}
          disabled={saving || !name.trim()}
          className="px-4 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving…' : editMode ? 'Save Edit' : 'Create & Activate'}
        </button>
      </div>

      {/* Three-panel body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Palette */}
        <div className="w-[220px] flex-shrink-0 border-r border-slate-200 overflow-y-auto bg-slate-50 py-3 px-3 space-y-4">
          {PALETTE_SECTIONS.map(({ section, items }) => {
            // Hide DEEP AGENT section unless in deep mode
            if (section === 'DEEP AGENT' && agentMode !== 'deep') return null
            // In standard mode, hide Agent node from FLOW CONTROL
            if (section === 'FLOW CONTROL' && agentMode !== 'deep') {
              return (
                <div key={section}>
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest mb-2 px-1">{section}</p>
                  <div className="space-y-1">
                    {items.filter(i => i.type !== 'agent').map(item => (
                      <PaletteItemRow key={`${item.type}-${item.label}`} item={item} />
                    ))}
                    <div className="text-[10px] text-slate-400 px-1 py-0.5 italic">
                      Enable Deep Agent for Agent node
                    </div>
                  </div>
                </div>
              )
            }
            return (
              <div key={section}>
                <p className={`text-[10px] font-semibold uppercase tracking-widest mb-2 px-1 ${
                  section === 'DEEP AGENT' ? 'text-indigo-500' : 'text-slate-400'
                }`}>{section}</p>
                <div className="space-y-1">
                  {items.map(item => (
                    <PaletteItemRow key={`${item.type}-${item.label}`} item={item} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>

        {/* Canvas */}
        <div className="relative flex-1 bg-slate-900" ref={reactFlowWrapper} onDragOver={onDragOver} onDrop={onDrop}>
          {showTemplates && nodes.length === 0 && (
            <TemplateOverlay onSelect={applyTemplate} />
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            fitView
            deleteKeyCode="Delete"
          >
            <Background color="#334155" gap={20} />
            <Controls className="!bg-slate-800 !border-slate-600" />
            <MiniMap
              className="!bg-slate-800 !border-slate-600"
              nodeColor={() => '#475569'}
            />
          </ReactFlow>
        </div>

        {/* Properties panel */}
        <div className="w-[280px] flex-shrink-0 border-l border-slate-200 bg-white overflow-hidden">
          {selectedNode ? (
            <PropertiesPanel
              node={selectedNode}
              onUpdate={updateNodeData}
              onDelete={deleteNode}
              providers={providers}
              availableAgents={availableAgents}
              availableGraphs={availableGraphs}
              availableSkills={availableSkills}
              orgId={orgId}
              edges={edges}
              allNodes={nodes}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-center p-6 text-slate-400">
              <p className="text-sm">Select a node to configure it</p>
              <p className="text-xs mt-1">or drag nodes from the palette</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Palette row helper ─────────────────────────────────────────────────────────

function PaletteItemRow({ item }: { item: PaletteItem }) {
  return (
    <div
      draggable
      onDragStart={e => {
        e.dataTransfer.setData('application/reactflow', JSON.stringify({
          type: item.type,
          defaultData: {
            label: item.label,
            ...(item.sourceType
              ? { sourceType: item.sourceType, tool: SOURCE_TYPE_TO_TOOL[item.sourceType] }
              : {}),
          },
        }))
        e.dataTransfer.effectAllowed = 'move'
      }}
      className="flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-grab bg-white border border-slate-200 hover:border-slate-300 hover:shadow-sm transition-all select-none"
    >
      <item.icon
        className="w-4 h-4 flex-shrink-0"
        style={{ color: item.color || '#64748b' }}
      />
      <span className="text-sm text-slate-700">{item.label}</span>
    </div>
  )
}

export default function FlowBuilderPage() {
  return (
    <Suspense>
      <ReactFlowProvider>
        <FlowBuilder />
      </ReactFlowProvider>
    </Suspense>
  )
}
