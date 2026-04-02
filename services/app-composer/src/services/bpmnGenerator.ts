export interface WfNode {
  id: string
  type: string
  position: { x: number; y: number }
  data: {
    label?: string
    formId?: string
    assigneeRole?: string
    slaHours?: number
    requiresEsig?: boolean
    agentId?: string
    agentName?: string
    apiUrl?: string
    apiMethod?: string
    apiBody?: string
    notifRecipientRole?: string
    notifMessage?: string
    timerDuration?: string
    defaultBranch?: string
    [key: string]: unknown
  }
}

export interface WfEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  data?: {
    condition?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface WorkflowDefinition {
  nodes: WfNode[]
  edges: WfEdge[]
  processId: string
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function toFeelCondition(expr: string): string {
  // Convert simple equality operators to FEEL syntax
  return expr
    .replace(/==/g, '=')
    .replace(/!=/g, '!=')
    .trim()
}

function buildElement(node: WfNode, outgoingEdges: WfEdge[], incomingEdges: WfEdge[]): string {
  const { id, type, data } = node
  const name = escapeXml(data.label || id)
  const outgoing = outgoingEdges.map(e => `      <outgoing>${e.id}</outgoing>`).join('\n')
  const incoming = incomingEdges.map(e => `      <incoming>${e.id}</incoming>`).join('\n')

  switch (type) {
    case 'wf_start':
      return `    <startEvent id="${id}" name="${name}">
${outgoing}
    </startEvent>`

    case 'wf_end':
      return `    <endEvent id="${id}" name="${name}">
${incoming}
    </endEvent>`

    case 'wf_user_task': {
      const formDef = data.formId
        ? `\n      <extensionElements>\n        <zeebe:formDefinition formKey="${escapeXml(data.formId)}" />\n        <zeebe:assignmentDefinition assignee="${escapeXml(data.assigneeRole || '')}" />\n      </extensionElements>`
        : ''
      return `    <userTask id="${id}" name="${name}">${formDef}
${incoming}
${outgoing}
    </userTask>`
    }

    case 'wf_agent_task': {
      const agentId = escapeXml(data.agentId || '')
      return `    <serviceTask id="${id}" name="${name}">
      <extensionElements>
        <zeebe:taskDefinition type="trialo:agent-run" />
        <zeebe:taskHeaders>
          <zeebe:header key="agent_id" value="${agentId}" />
        </zeebe:taskHeaders>
      </extensionElements>
${incoming}
${outgoing}
    </serviceTask>`
    }

    case 'wf_api_task': {
      const url = escapeXml(data.apiUrl || '')
      const method = escapeXml(data.apiMethod || 'POST')
      const body = escapeXml(data.apiBody || '')
      return `    <serviceTask id="${id}" name="${name}">
      <extensionElements>
        <zeebe:taskDefinition type="trialo:http-call" />
        <zeebe:taskHeaders>
          <zeebe:header key="url" value="${url}" />
          <zeebe:header key="method" value="${method}" />
          <zeebe:header key="body" value="${body}" />
        </zeebe:taskHeaders>
      </extensionElements>
${incoming}
${outgoing}
    </serviceTask>`
    }

    case 'wf_notification': {
      const role = escapeXml(data.notifRecipientRole || '')
      const msg = escapeXml(data.notifMessage || '')
      return `    <serviceTask id="${id}" name="${name}">
      <extensionElements>
        <zeebe:taskDefinition type="trialo:send-notification" />
        <zeebe:taskHeaders>
          <zeebe:header key="recipient_role" value="${role}" />
          <zeebe:header key="message" value="${msg}" />
        </zeebe:taskHeaders>
      </extensionElements>
${incoming}
${outgoing}
    </serviceTask>`
    }

    case 'wf_timer': {
      const duration = escapeXml(data.timerDuration || 'PT1H')
      return `    <intermediateCatchEvent id="${id}" name="${name}">
      <timerEventDefinition>
        <timeDuration xsi:type="tFormalExpression">${duration}</timeDuration>
      </timerEventDefinition>
${incoming}
${outgoing}
    </intermediateCatchEvent>`
    }

    case 'wf_gateway':
      return `    <exclusiveGateway id="${id}" name="${name}" default="${data.defaultBranch || ''}">
${incoming}
${outgoing}
    </exclusiveGateway>`

    default:
      // Fallback: treat as service task
      return `    <serviceTask id="${id}" name="${name}">
${incoming}
${outgoing}
    </serviceTask>`
  }
}

function buildSequenceFlow(edge: WfEdge, nodes: Map<string, WfNode>): string {
  const sourceNode = nodes.get(edge.source)
  const condition = edge.data?.condition
  const conditionEl = condition
    ? `\n      <conditionExpression>\${${toFeelCondition(condition)}}</conditionExpression>`
    : ''

  return `    <sequenceFlow id="${edge.id}" sourceRef="${edge.source}" targetRef="${edge.target}">${conditionEl}
    </sequenceFlow>`
}

export function generateBpmnXml(workflowDefinition: WorkflowDefinition): string {
  const { nodes, edges, processId } = workflowDefinition
  const pid = processId || 'process-1'

  const nodeMap = new Map<string, WfNode>(nodes.map(n => [n.id, n]))

  // Build outgoing and incoming edge maps
  const outgoingMap = new Map<string, WfEdge[]>()
  const incomingMap = new Map<string, WfEdge[]>()
  for (const edge of edges) {
    if (!outgoingMap.has(edge.source)) outgoingMap.set(edge.source, [])
    if (!incomingMap.has(edge.target)) incomingMap.set(edge.target, [])
    outgoingMap.get(edge.source)!.push(edge)
    incomingMap.get(edge.target)!.push(edge)
  }

  const elements = nodes.map(node =>
    buildElement(node, outgoingMap.get(node.id) || [], incomingMap.get(node.id) || [])
  )

  const flows = edges.map(edge => buildSequenceFlow(edge, nodeMap))

  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             xmlns:modeler="http://camunda.org/schema/modeler/1.0"
             targetNamespace="http://bpmn.io/schema/bpmn"
             exporter="Trialo Workflow Builder"
             exporterVersion="1.0">
  <process id="${pid}" isExecutable="true">
${elements.join('\n')}
${flows.join('\n')}
  </process>
</definitions>`
}
