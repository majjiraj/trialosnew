/**
 * agentRunWorker — Zeebe job worker for trialo:agent-run service tasks.
 *
 * When Zeebe activates a service task of type "trialo:agent-run", this worker:
 * 1. Reads task headers: agent_slug, trigger_mode, timeout_seconds
 * 2. Resolves agent installation for the org
 * 3. Checks trigger_condition (conditional mode)
 * 4. Calls Agent Runtime POST /run
 * 5. Polls until agent run completes or fails
 * 6. Records in workflow_agent_runs
 * 7. Emits Kafka event
 * 8. Completes Zeebe job with output variables
 */
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { query } from '../db/postgres';
import { emitEvent } from '../integrations/kafkaProducer';

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 150; // 5 minutes max

export interface AgentRunJobVariables {
  org_id: string;
  instance_id: string;
  study_id?: string;
  [key: string]: unknown;
}

export interface AgentRunJobHeaders {
  agent_slug?: string;
  agent_def_id?: string;
  trigger_mode?: 'always' | 'conditional' | 'manual';
  trigger_condition?: string;
  timeout_seconds?: string;
  output_mapping?: string; // JSON: { zeebe_var: agent_output_key }
}

async function resolveInstallation(orgId: string, agentDefId?: string, agentSlug?: string): Promise<{ installationId: string; agentDefId: string } | null> {
  let sql: string;
  let params: unknown[];

  if (agentDefId) {
    sql = `SELECT ai.id as installation_id, ai.agent_id as agent_def_id
           FROM agent_installations ai
           WHERE ai.org_id = $1 AND ai.agent_id = $2 AND ai.is_active = TRUE LIMIT 1`;
    params = [orgId, agentDefId];
  } else if (agentSlug) {
    sql = `SELECT ai.id as installation_id, ai.agent_id as agent_def_id
           FROM agent_installations ai
           JOIN agent_definitions ad ON ad.id = ai.agent_id
           WHERE ai.org_id = $1 AND ad.slug = $2 AND ai.is_active = TRUE LIMIT 1`;
    params = [orgId, agentSlug];
  } else {
    return null;
  }

  const { rows } = await query(sql, params);
  if (!rows.length) return null;
  return { installationId: rows[0].installation_id, agentDefId: rows[0].agent_def_id };
}

async function pollAgentRun(runId: string, maxAttempts = MAX_POLL_ATTEMPTS): Promise<{ status: string; outputSummary?: string; stepTraces?: unknown }> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const { data } = await axios.get(`${config.agentRuntimeUrl}/runs/${runId}`);
      if (data.status === 'completed' || data.status === 'failed') {
        return { status: data.status, outputSummary: data.output_summary, stepTraces: data.step_traces };
      }
    } catch (err) {
      console.warn('[agentRunWorker] Poll error:', err);
    }
  }
  return { status: 'failed' };
}

export async function runAgentForJob(jobKey: string, variables: AgentRunJobVariables, headers: AgentRunJobHeaders, instanceId?: string): Promise<Record<string, unknown>> {
  const orgId = variables.org_id;
  const studyId = variables.study_id;

  // Check trigger condition
  if (headers.trigger_mode === 'conditional' && headers.trigger_condition) {
    // Simple FEEL-like evaluation: "variable == value"
    const parts = headers.trigger_condition.split('==').map(s => s.trim());
    if (parts.length === 2) {
      const fieldVal = variables[parts[0]];
      const expectedVal = parts[1].replace(/['"]/g, '');
      if (String(fieldVal) !== expectedVal) {
        console.log(`[agentRunWorker] Skipping job ${jobKey}: condition not met (${headers.trigger_condition})`);
        return { agent_skipped: true };
      }
    }
  }

  // Resolve installation
  const installation = await resolveInstallation(orgId, headers.agent_def_id, headers.agent_slug);
  if (!installation) {
    console.warn(`[agentRunWorker] No installation found for agent ${headers.agent_slug || headers.agent_def_id} in org ${orgId}`);
    return { agent_error: 'installation_not_found' };
  }

  // Build input context from variables
  const inputContext: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(variables)) {
    if (!['org_id', 'instance_id'].includes(key)) inputContext[key] = value;
  }

  // Call Agent Runtime
  let agentRunId: string | null = null;
  try {
    const { data } = await axios.post(`${config.agentRuntimeUrl}/run`, {
      installation_id: installation.installationId,
      study_id: studyId || null,
      org_id: orgId,
      input_context: inputContext,
      is_test_run: false,
    });
    agentRunId = data.run_id || data.id;
  } catch (err) {
    console.error('[agentRunWorker] Failed to start agent run:', err);
    return { agent_error: 'start_failed' };
  }

  // Record in workflow_agent_runs
  const runLinkId = uuidv4();
  await query(
    `INSERT INTO workflow_agent_runs (id, org_id, instance_id, agent_run_id, step_id, agent_def_id, input_vars, status, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'running',NOW())`,
    [runLinkId, orgId, instanceId, agentRunId, String(jobKey), installation.agentDefId, JSON.stringify(inputContext)]
  );

  // Poll for completion
  const result = await pollAgentRun(agentRunId!);

  await query(
    'UPDATE workflow_agent_runs SET status=$1, output_vars=$2, completed_at=NOW() WHERE id=$3',
    [result.status, JSON.stringify(result), runLinkId]
  );

  await emitEvent('workflow.agent_run_completed', orgId, {
    instance_id: instanceId, agent_run_id: agentRunId, status: result.status,
  }, studyId);

  // Map output variables
  const outputVars: Record<string, unknown> = {
    agent_run_id: agentRunId,
    agent_run_status: result.status,
    agent_output_summary: result.outputSummary,
  };

  if (headers.output_mapping) {
    try {
      const mapping: Record<string, string> = JSON.parse(headers.output_mapping);
      const stepTraces = result.stepTraces as Record<string, unknown> | undefined;
      for (const [zeebeVar, outputKey] of Object.entries(mapping)) {
        if (stepTraces && outputKey in stepTraces) outputVars[zeebeVar] = stepTraces[outputKey];
      }
    } catch {
      console.warn('[agentRunWorker] Failed to parse output_mapping');
    }
  }

  return outputVars;
}
