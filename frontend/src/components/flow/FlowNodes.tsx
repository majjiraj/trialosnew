import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Database, Brain, Code2, BarChart2, FileText, ArrowRight, PauseCircle, GitBranch, Bot, Network, Wand2, BookMarked, ScanEye, ListTodo, FolderOpen } from 'lucide-react'

export interface NodeData extends Record<string, unknown> {
  label: string
  // DataSource
  sourceType?: string    // sdtm|adam|raw_edc|ctms|budget|documents|ig|crf|sap
  tool?: string
  params?: Record<string, string>
  // LLM
  provider?: string      // ollama|openai|anthropic|azure
  model?: string
  prompt?: string
  systemPrompt?: string
  temperature?: number
  // Expertise Scaffold (on LLM node)
  scaffoldRole?: string
  scaffoldDomain?: string
  scaffoldConstraints?: string
  scaffoldReasoningStyle?: string
  scaffoldOutputFormat?: string
  // Chart
  chartType?: string
  chartTitle?: string
  xField?: string
  yField?: string
  colorField?: string
  // Document
  documentType?: string
  docTitle?: string
  section?: string
  // Code
  language?: string
  code?: string
  // Output
  outputFormat?: string
  outputTitle?: string
  // Condition
  conditionField?: string
  conditionOp?: string
  conditionValue?: string
  // Agent
  agentId?: string
  agentName?: string
  agentMode?: string
  inputPrompt?: string
  timeoutSeconds?: number
  // Context Graph
  graphId?: string
  graphName?: string
  queryTemplate?: string
  topK?: number
  // Skill
  skillId?: string
  skillName?: string
  skillType?: string
  skillParams?: Record<string, string>
  // Memory
  memoryOperation?: string
  memoryKey?: string
  memoryValuePath?: string
  memoryScopedToStudy?: boolean
  // Reflect
  rubric?: string
  scoreThreshold?: number
  reflectTargetNodeId?: string
  // Planner
  objective?: string
  maxTasks?: number
  contextHint?: string
  // FileOp
  fileOperation?: string
  filePath?: string
  fileContentSource?: string
  // Hitl (human-in-the-loop)
  hitlDescription?: string
  hitlFormId?: string
  hitlAssignedRole?: string
  hitlFieldMappings?: Record<string, string>  // formField -> node.path
  hitlInlineFields?: HitlInlineField[]
  // LLM security / endpoint
  endpointUrl?: string
  apiKey?: string
}

export interface HitlInlineField {
  name: string
  label: string
  type: 'text' | 'textarea' | 'number' | 'boolean' | 'select'
  required?: boolean
  editable?: boolean
  description?: string
  options?: string[]
  default?: string
}

function NodeCard({
  color,
  icon: Icon,
  typeLabel,
  label,
  preview,
  hasTarget,
  hasSource,
  selected,
}: {
  color: string
  icon: React.ElementType
  typeLabel: string
  label: string
  preview: string
  hasTarget: boolean
  hasSource: boolean
  selected?: boolean
}) {
  return (
    <div
      className={`bg-white rounded-lg shadow-md border-2 w-40 overflow-hidden ${
        selected ? 'border-blue-500' : 'border-slate-200'
      }`}
      style={{ borderLeft: `4px solid ${color}` }}
    >
      {hasTarget && (
        <Handle
          type="target"
          position={Position.Left}
          className="!w-3 !h-3 !border-2 !border-slate-400 !bg-white"
        />
      )}
      <div className="px-3 pt-2 pb-2">
        <div className="flex items-center gap-1.5 mb-1">
          <Icon className="w-3.5 h-3.5 flex-shrink-0" style={{ color }} />
          <span className="text-xs text-slate-400 uppercase tracking-wide font-medium">{typeLabel}</span>
        </div>
        <div className="text-sm font-semibold text-slate-900 truncate">{label}</div>
        {preview && (
          <div className="text-xs text-slate-500 truncate mt-0.5">{preview}</div>
        )}
      </div>
      {hasSource && (
        <Handle
          type="source"
          position={Position.Right}
          className="!w-3 !h-3 !border-2 !border-slate-400 !bg-white"
        />
      )}
    </div>
  )
}

export function DataSourceNode({ data, selected }: NodeProps) {
  const d = data as NodeData
  const preview = [d.sourceType?.toUpperCase(), d.tool?.replace(/_/g, ' ')].filter(Boolean).join(' · ')
  return (
    <NodeCard
      color="#3b82f6"
      icon={Database}
      typeLabel="Data Source"
      label={d.label || 'Data Source'}
      preview={preview}
      hasTarget={false}
      hasSource={true}
      selected={selected}
    />
  )
}

export function LLMNode({ data, selected }: NodeProps) {
  const d = data as NodeData
  return (
    <NodeCard
      color="#a855f7"
      icon={Brain}
      typeLabel="LLM"
      label={d.label || 'LLM'}
      preview={(d.model as string) || 'llama3.1:8b'}
      hasTarget={true}
      hasSource={true}
      selected={selected}
    />
  )
}

export function CodeNode({ data, selected }: NodeProps) {
  const d = data as NodeData
  return (
    <NodeCard
      color="#22c55e"
      icon={Code2}
      typeLabel="Code"
      label={d.label || 'Code'}
      preview={(d.language as string) || 'Python'}
      hasTarget={true}
      hasSource={true}
      selected={selected}
    />
  )
}

export function ChartNode({ data, selected }: NodeProps) {
  const d = data as NodeData
  return (
    <NodeCard
      color="#f97316"
      icon={BarChart2}
      typeLabel="Chart"
      label={d.label || 'Chart'}
      preview={(d.chartType as string) || 'bar chart'}
      hasTarget={true}
      hasSource={true}
      selected={selected}
    />
  )
}

export function DocumentNode({ data, selected }: NodeProps) {
  const d = data as NodeData
  return (
    <NodeCard
      color="#f59e0b"
      icon={FileText}
      typeLabel="Document"
      label={d.label || 'Document'}
      preview={((d.documentType as string) || 'memo').replace(/_/g, ' ')}
      hasTarget={true}
      hasSource={true}
      selected={selected}
    />
  )
}

export function OutputNode({ data, selected }: NodeProps) {
  const d = data as NodeData
  return (
    <NodeCard
      color="#64748b"
      icon={ArrowRight}
      typeLabel="Output"
      label={d.label || 'Output'}
      preview={(d.outputFormat as string) || 'narrative'}
      hasTarget={true}
      hasSource={false}
      selected={selected}
    />
  )
}

export function HitlNode({ data, selected }: NodeProps) {
  const d = data as NodeData & { config?: { title?: string } }
  return (
    <div className={`rounded-lg bg-white shadow-sm w-40 text-xs border-2 border-l-4 border-l-amber-500 border-amber-200 ${selected ? 'ring-2 ring-amber-400' : ''}`}>
      <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-amber-400" />
      <div className="px-2 py-1 border-b border-amber-100 flex items-center gap-1">
        <PauseCircle size={10} className="text-amber-500" />
        <span className="text-[10px] text-amber-600 font-medium uppercase tracking-wide">Human Review</span>
      </div>
      <div className="px-2 py-2">
        <div className="font-semibold text-slate-800 truncate">{d.label}</div>
        <div className="text-[10px] text-slate-400 mt-0.5 truncate">{d.config?.title || 'Awaiting approval'}</div>
      </div>
      <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-amber-400" />
    </div>
  )
}

export function ConditionNode({ data, selected }: NodeProps) {
  const d = data as NodeData
  const preview = [d.conditionField, d.conditionOp, d.conditionValue].filter(Boolean).join(' ')
  return (
    <div
      className={`relative bg-white shadow-md border-2 w-44 overflow-visible ${
        selected ? 'border-cyan-500' : 'border-slate-200'
      }`}
      style={{
        borderLeft: '4px solid #06b6d4',
        clipPath: 'polygon(8px 0%, calc(100% - 8px) 0%, 100% 50%, calc(100% - 8px) 100%, 8px 100%, 0% 50%)',
      }}
    >
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !border-2 !border-cyan-400 !bg-white" />
      <div className="px-4 py-2">
        <div className="flex items-center gap-1.5 mb-1">
          <GitBranch className="w-3.5 h-3.5 flex-shrink-0 text-cyan-500" />
          <span className="text-xs text-slate-400 uppercase tracking-wide font-medium">Condition</span>
        </div>
        <div className="text-sm font-semibold text-slate-900 truncate">{d.label || 'Condition'}</div>
        {preview && <div className="text-xs text-slate-500 truncate mt-0.5 font-mono">{preview}</div>}
      </div>
      {/* True handle — right */}
      <Handle
        type="source"
        position={Position.Right}
        id="true"
        className="!w-3 !h-3 !border-2 !border-green-500 !bg-white"
        style={{ top: '35%' }}
      />
      {/* False handle — bottom */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="false"
        className="!w-3 !h-3 !border-2 !border-red-500 !bg-white"
      />
    </div>
  )
}

export function AgentNode({ data, selected }: NodeProps) {
  const d = data as NodeData
  return (
    <div
      className={`bg-white rounded-lg shadow-md border-2 border-dashed w-44 overflow-hidden ${
        selected ? 'border-indigo-500' : 'border-indigo-300'
      }`}
      style={{ borderLeft: '4px solid #6366f1' }}
    >
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !border-2 !border-indigo-400 !bg-white" />
      <div className="px-3 pt-2 pb-2">
        <div className="flex items-center gap-1.5 mb-1">
          <Bot className="w-3.5 h-3.5 flex-shrink-0 text-indigo-500" />
          <span className="text-xs text-slate-400 uppercase tracking-wide font-medium">Agent</span>
          {d.agentMode && (
            <span className={`ml-auto text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
              d.agentMode === 'deep' ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500'
            }`}>
              {d.agentMode}
            </span>
          )}
        </div>
        <div className="text-sm font-semibold text-slate-900 truncate">
          {d.agentName || d.label || 'Select agent'}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!w-3 !h-3 !border-2 !border-indigo-400 !bg-white" />
    </div>
  )
}

export function ContextGraphNode({ data, selected }: NodeProps) {
  const d = data as NodeData
  return (
    <NodeCard
      color="#8b5cf6"
      icon={Network}
      typeLabel="Context Graph"
      label={d.graphName || d.label || 'Context Graph'}
      preview={d.queryTemplate ? d.queryTemplate.slice(0, 30) : 'Select graph'}
      hasTarget={true}
      hasSource={true}
      selected={selected}
    />
  )
}

export function SkillNode({ data, selected }: NodeProps) {
  const d = data as NodeData
  const preview = [d.skillName || 'Select skill', d.skillType ? `(${d.skillType})` : ''].filter(Boolean).join(' ')
  return (
    <NodeCard
      color="#ec4899"
      icon={Wand2}
      typeLabel="Skill"
      label={d.label || 'Skill'}
      preview={preview}
      hasTarget={true}
      hasSource={true}
      selected={selected}
    />
  )
}

export function MemoryNode({ data, selected }: NodeProps) {
  const d = data as NodeData
  const op = (d.memoryOperation as string || 'read').toUpperCase()
  const preview = `${op} · ${d.memoryKey || 'key'}`
  return (
    <NodeCard
      color="#0ea5e9"
      icon={BookMarked}
      typeLabel="Memory"
      label={d.label || 'Memory'}
      preview={preview}
      hasTarget={true}
      hasSource={true}
      selected={selected}
    />
  )
}

export function ReflectNode({ data, selected }: NodeProps) {
  const d = data as NodeData
  const threshold = Math.round(((d.scoreThreshold as number) ?? 0.7) * 100)
  return (
    <NodeCard
      color="#f43f5e"
      icon={ScanEye}
      typeLabel="Reflect"
      label={d.label || 'Reflect'}
      preview={`threshold ${threshold}%`}
      hasTarget={true}
      hasSource={true}
      selected={selected}
    />
  )
}

export function PlannerNode({ data, selected }: NodeProps) {
  const d = data as NodeData
  const max = (d.maxTasks as number) ?? 5
  return (
    <NodeCard
      color="#f59e0b"
      icon={ListTodo}
      typeLabel="Planner"
      label={d.label || 'Planner'}
      preview={`max ${max} tasks`}
      hasTarget={true}
      hasSource={true}
      selected={selected}
    />
  )
}

export function FileOpNode({ data, selected }: NodeProps) {
  const d = data as NodeData
  const op = (d.fileOperation as string || 'read').toUpperCase()
  const preview = `${op} · ${d.filePath || 'path'}`
  return (
    <NodeCard
      color="#10b981"
      icon={FolderOpen}
      typeLabel="File"
      label={d.label || 'File Op'}
      preview={preview}
      hasTarget={true}
      hasSource={true}
      selected={selected}
    />
  )
}

export const nodeTypes = {
  dataSource: DataSourceNode,
  data_source: DataSourceNode,
  llm: LLMNode,
  code: CodeNode,
  chart: ChartNode,
  document: DocumentNode,
  output: OutputNode,
  hitl: HitlNode,
  condition: ConditionNode,
  agent: AgentNode,
  context_graph: ContextGraphNode,
  skill: SkillNode,
  memory: MemoryNode,
  reflect: ReflectNode,
  planner: PlannerNode,
  file_op: FileOpNode,
}
