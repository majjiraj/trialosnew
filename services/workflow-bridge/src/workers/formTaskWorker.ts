/**
 * formTaskWorker — Creates workflow_tasks rows when Zeebe activates user tasks.
 * Assigns to the appropriate user/role based on task headers.
 */
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/postgres';
import { emitEvent } from '../integrations/kafkaProducer';

export interface FormTaskJobVariables {
  org_id: string;
  instance_id: string;
  study_id?: string;
  [key: string]: unknown;
}

export interface FormTaskJobHeaders {
  form_id?: string;
  assignee_role?: string;
  sla_hours?: string;
}

export async function createFormTask(
  jobKey: string,
  variables: FormTaskJobVariables,
  headers: FormTaskJobHeaders,
  elementId: string,
  elementName: string
): Promise<string> {
  const orgId = variables.org_id;
  const instanceId = variables.instance_id;
  const studyId = variables.study_id;

  const dueDate = headers.sla_hours
    ? new Date(Date.now() + parseInt(headers.sla_hours, 10) * 3600 * 1000)
    : null;

  // De-duplicate: if this job key already has a task, return it (handles job re-activation after timeout)
  const { rows: existing } = await query('SELECT id FROM workflow_tasks WHERE zeebe_job_key = $1', [String(jobKey)]);
  if (existing.length) return existing[0].id;

  const taskId = uuidv4();
  await query(
    `INSERT INTO workflow_tasks (id, org_id, instance_id, zeebe_job_key, element_id, element_name, form_id, assignee_role, status, due_date, variables)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10)`,
    [taskId, orgId, instanceId, String(jobKey), elementId, elementName,
     headers.form_id || null, headers.assignee_role || null, dueDate,
     JSON.stringify(variables)]
  );

  await emitEvent('task.created', orgId, { task_id: taskId, instance_id: instanceId, element_name: elementName }, studyId);
  return taskId;
}
