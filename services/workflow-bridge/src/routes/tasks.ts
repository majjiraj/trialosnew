import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../db/postgres';
import { emitEvent } from '../integrations/kafkaProducer';
import { writeAuditEvent } from '../integrations/auditClient';
import { getZeebeClient, isZeebeAvailable } from '../services/zeebeClient';

const router = Router();

// GET /tasks — list tasks for org (accepts org_id query param for internal calls)
router.get('/', async (req: AuthRequest, res: Response) => {
  const orgId = (req.query.org_id as string) || req.orgId || '';
  const { status, assignee_id, limit = '50' } = req.query;
  const conditions = ['t.org_id = $1'];
  const params: unknown[] = [orgId];
  let idx = 2;
  if (status) { conditions.push(`t.status = $${idx++}`); params.push(status); }
  if (assignee_id) { conditions.push(`t.assignee_id = $${idx++}`); params.push(assignee_id); }
  params.push(parseInt(String(limit), 10));
  const { rows } = await query(
    `SELECT t.*, wi.bpmn_process_id, wi.app_id,
            CASE WHEN t.due_date < NOW() AND t.status NOT IN ('completed','cancelled') THEN true ELSE false END as is_overdue
     FROM workflow_tasks t
     LEFT JOIN workflow_instances wi ON wi.id = t.instance_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC LIMIT $${idx}`,
    params
  );
  res.json({ tasks: rows });
});

// GET /tasks/my — tasks for current user (by assignee_id or role match)
router.get('/my', authenticate, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.sub;
  const orgId = req.orgId!;
  const userRoles: string[] = req.user!.roles || [];
  const { rows } = await query(
    `SELECT t.*, wi.bpmn_process_id, wi.app_id,
            CASE WHEN t.due_date < NOW() AND t.status NOT IN ('completed','cancelled') THEN true ELSE false END as is_overdue
     FROM workflow_tasks t
     LEFT JOIN workflow_instances wi ON wi.id = t.instance_id
     WHERE t.org_id = $1 AND t.status IN ('pending','claimed')
       AND (t.assignee_id = $2 OR (t.assignee_id IS NULL AND t.assignee_role = ANY($3::text[])))
     ORDER BY t.due_date ASC NULLS LAST`,
    [orgId, userId, userRoles]
  );
  res.json({ tasks: rows });
});

// GET /tasks/:taskId
router.get('/:taskId', authenticate, async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const { rows } = await query(
    'SELECT t.*, wi.bpmn_process_id, wi.input_variables FROM workflow_tasks t LEFT JOIN workflow_instances wi ON wi.id = t.instance_id WHERE t.id = $1 AND t.org_id = $2',
    [req.params.taskId, orgId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Task not found' });
  res.json(rows[0]);
});

// POST /tasks/:taskId/claim
router.post('/:taskId/claim', authenticate, async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const userId = req.user!.sub;
  const { rowCount } = await query(
    "UPDATE workflow_tasks SET status='claimed', assignee_id=$1, claimed_at=NOW() WHERE id=$2 AND org_id=$3 AND status='pending'",
    [userId, req.params.taskId, orgId]
  );
  if (!rowCount) return res.status(400).json({ error: 'Task not found or already claimed' });
  await writeAuditEvent({ orgId, actorId: userId, action: 'task.claimed', resourceType: 'workflow_task', resourceId: req.params.taskId });
  res.json({ claimed: true, assignee_id: userId });
});

// POST /tasks/:taskId/complete
router.post('/:taskId/complete', authenticate, async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const userId = req.user!.sub;
  const { completion_data, esignature_id } = req.body;

  const { rows } = await query('SELECT * FROM workflow_tasks WHERE id = $1 AND org_id = $2', [req.params.taskId, orgId]);
  if (!rows.length) return res.status(404).json({ error: 'Task not found' });
  const task = rows[0];

  await query(
    "UPDATE workflow_tasks SET status='completed', completed_at=NOW(), completion_data=$1, esignature_id=$2 WHERE id=$3",
    [JSON.stringify(completion_data || {}), esignature_id || null, req.params.taskId]
  );

  // Zeebe job was already completed by the trialo:user-task worker when the task was created.
  // No need to call completeJob here.

  await writeAuditEvent({ orgId, actorId: userId, action: 'task.completed', resourceType: 'workflow_task', resourceId: req.params.taskId });
  await emitEvent('task.completed', orgId, { task_id: req.params.taskId, instance_id: task.instance_id }, undefined, userId);
  const { rows: updated } = await query('SELECT * FROM workflow_tasks WHERE id = $1', [req.params.taskId]);
  res.json(updated[0]);
});

// POST /tasks/:taskId/reassign
router.post('/:taskId/reassign', authenticate, async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const userId = req.user!.sub;
  const { new_assignee_id } = req.body;
  if (!new_assignee_id) return res.status(400).json({ error: 'new_assignee_id required' });
  await query(
    'UPDATE workflow_tasks SET assignee_id=$1 WHERE id=$2 AND org_id=$3',
    [new_assignee_id, req.params.taskId, orgId]
  );
  await writeAuditEvent({ orgId, actorId: userId, action: 'task.reassigned', resourceType: 'workflow_task', resourceId: req.params.taskId });
  res.json({ reassigned: true, new_assignee_id });
});

export default router;
