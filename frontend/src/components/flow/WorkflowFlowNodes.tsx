import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Play, Square, User, Bot, Globe, Bell, Timer, GitBranch } from 'lucide-react'

export interface WfNodeData extends Record<string, unknown> {
  label: string
  // wf_user_task
  formId?: string
  assigneeRole?: string
  slaHours?: number
  requiresEsig?: boolean
  // wf_agent_task
  agentId?: string
  agentName?: string
  // wf_api_task
  apiUrl?: string
  apiMethod?: string
  apiBody?: string
  // wf_notification
  notifRecipientRole?: string
  notifMessage?: string
  // wf_timer
  timerDuration?: string
  // wf_gateway
  defaultBranch?: string
}

function WfNodeCard({
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
  preview?: string
  hasTarget: boolean
  hasSource: boolean
  selected?: boolean
}) {
  return (
    <div
      className={`bg-white rounded-lg shadow-md border-2 w-44 overflow-hidden ${
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

export function WfStartNode({ data, selected }: NodeProps) {
  const d = data as WfNodeData
  return (
    <WfNodeCard
      color="#22c55e"
      icon={Play}
      typeLabel="Start"
      label={d.label || 'Start'}
      hasTarget={false}
      hasSource={true}
      selected={selected}
    />
  )
}

export function WfEndNode({ data, selected }: NodeProps) {
  const d = data as WfNodeData
  return (
    <WfNodeCard
      color="#ef4444"
      icon={Square}
      typeLabel="End"
      label={d.label || 'End'}
      hasTarget={true}
      hasSource={false}
      selected={selected}
    />
  )
}

export function WfUserTaskNode({ data, selected }: NodeProps) {
  const d = data as WfNodeData
  const preview = [d.assigneeRole?.replace(/_/g, ' '), d.formId ? `form: ${d.formId.slice(0, 8)}…` : ''].filter(Boolean).join(' · ')
  return (
    <WfNodeCard
      color="#3b82f6"
      icon={User}
      typeLabel="User Task"
      label={d.label || 'User Task'}
      preview={preview}
      hasTarget={true}
      hasSource={true}
      selected={selected}
    />
  )
}

export function WfAgentTaskNode({ data, selected }: NodeProps) {
  const d = data as WfNodeData
  return (
    <WfNodeCard
      color="#6366f1"
      icon={Bot}
      typeLabel="Agent Task"
      label={d.label || 'Agent Task'}
      preview={d.agentName || 'Select agent'}
      hasTarget={true}
      hasSource={true}
      selected={selected}
    />
  )
}

export function WfApiTaskNode({ data, selected }: NodeProps) {
  const d = data as WfNodeData
  const preview = d.apiUrl ? `${d.apiMethod || 'POST'} ${d.apiUrl.slice(0, 20)}…` : 'Configure URL'
  return (
    <WfNodeCard
      color="#f97316"
      icon={Globe}
      typeLabel="API Task"
      label={d.label || 'API Task'}
      preview={preview}
      hasTarget={true}
      hasSource={true}
      selected={selected}
    />
  )
}

export function WfNotificationNode({ data, selected }: NodeProps) {
  const d = data as WfNodeData
  const preview = d.notifRecipientRole?.replace(/_/g, ' ') || 'Set recipient'
  return (
    <WfNodeCard
      color="#14b8a6"
      icon={Bell}
      typeLabel="Notification"
      label={d.label || 'Notification'}
      preview={preview}
      hasTarget={true}
      hasSource={true}
      selected={selected}
    />
  )
}

export function WfTimerNode({ data, selected }: NodeProps) {
  const d = data as WfNodeData
  return (
    <WfNodeCard
      color="#eab308"
      icon={Timer}
      typeLabel="Timer"
      label={d.label || 'Timer'}
      preview={d.timerDuration || 'PT1H'}
      hasTarget={true}
      hasSource={true}
      selected={selected}
    />
  )
}

export function WfGatewayNode({ data, selected }: NodeProps) {
  const d = data as WfNodeData
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
      <div className="px-5 py-2">
        <div className="flex items-center gap-1.5 mb-1">
          <GitBranch className="w-3.5 h-3.5 flex-shrink-0 text-cyan-500" />
          <span className="text-xs text-slate-400 uppercase tracking-wide font-medium">Gateway</span>
        </div>
        <div className="text-sm font-semibold text-slate-900 truncate">{d.label || 'Gateway'}</div>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        id="true"
        className="!w-3 !h-3 !border-2 !border-green-500 !bg-white"
        style={{ top: '35%' }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="false"
        className="!w-3 !h-3 !border-2 !border-red-500 !bg-white"
      />
    </div>
  )
}

export const wfNodeTypes = {
  wf_start: WfStartNode,
  wf_end: WfEndNode,
  wf_user_task: WfUserTaskNode,
  wf_agent_task: WfAgentTaskNode,
  wf_api_task: WfApiTaskNode,
  wf_notification: WfNotificationNode,
  wf_timer: WfTimerNode,
  wf_gateway: WfGatewayNode,
}
