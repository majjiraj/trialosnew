import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authenticate, AuthRequest } from '../middleware/auth';
import { createInstance, cancelInstance } from '../services/zeebeClient';
import { query } from '../db/postgres';
import { emitEvent } from '../integrations/kafkaProducer';

const router = Router();

// POST /instances — start workflow instance
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const orgId = req.orgId!;
    const userId = req.user!.sub;
    const { installation_id, app_id, study_id, bpmn_process_id, input_variables, sla_deadline } = req.body;
    if (!bpmn_process_id) return res.status(400).json({ error: 'bpmn_process_id required' });

    const instanceId = uuidv4();
    const vars = { ...input_variables, org_id: orgId, instance_id: instanceId, started_by: userId };

    const { instanceKey } = await createInstance(bpmn_process_id, vars);

    await query(
      `INSERT INTO workflow_instances (id, org_id, installation_id, app_id, study_id, zeebe_instance_key, bpmn_process_id, input_variables, sla_deadline, started_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [instanceId, orgId, installation_id || null, app_id || null, study_id || null,
       instanceKey ? String(instanceKey) : null, bpmn_process_id,
       JSON.stringify(vars), sla_deadline || null, userId]
    );

    const { rows } = await query('SELECT * FROM workflow_instances WHERE id = $1', [instanceId]);
    await emitEvent('workflow.started', orgId, { instance_id: instanceId, bpmn_process_id }, study_id, userId);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[instances] POST error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' });
  }
});

// GET /instances — list instances for org (accepts org_id query param for internal calls)
router.get('/', async (req: AuthRequest, res: Response) => {
  const orgId = (req.query.org_id as string) || req.orgId || '';
  const { status, app_id, study_id, limit = '50' } = req.query;
  const conditions = ['org_id = $1'];
  const params: unknown[] = [orgId];
  let idx = 2;
  if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
  if (app_id) { conditions.push(`app_id = $${idx++}`); params.push(app_id); }
  if (study_id) { conditions.push(`study_id = $${idx++}`); params.push(study_id); }
  params.push(parseInt(String(limit), 10));
  const { rows } = await query(
    `SELECT * FROM workflow_instances WHERE ${conditions.join(' AND ')} ORDER BY started_at DESC LIMIT $${idx}`,
    params
  );
  res.json({ instances: rows });
});

// GET /instances/:id
router.get('/:id', async (req: AuthRequest, res: Response) => {
  const orgId = (req.query.org_id as string) || req.orgId || '';
  // If we have an orgId, scope the query; otherwise allow internal lookup by id only
  const { rows } = orgId
    ? await query('SELECT * FROM workflow_instances WHERE id = $1 AND org_id = $2', [req.params.id, orgId])
    : await query('SELECT * FROM workflow_instances WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Instance not found' });
  res.json(rows[0]);
});

// PATCH /instances/:id — update mutable fields (e.g. study_id after form submission)
router.patch('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const { study_id } = req.body;
  const updates: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (study_id !== undefined) { updates.push(`study_id = $${idx++}`); params.push(study_id); }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id, orgId);
  await query(`UPDATE workflow_instances SET ${updates.join(', ')} WHERE id = $${idx++} AND org_id = $${idx}`, params);
  const { rows } = await query('SELECT * FROM workflow_instances WHERE id = $1 AND org_id = $2', [req.params.id, orgId]);
  if (!rows.length) return res.status(404).json({ error: 'Instance not found' });
  res.json(rows[0]);
});

// DELETE /instances/:id — terminate instance
router.delete('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const userId = req.user!.sub;
  const { rows } = await query('SELECT * FROM workflow_instances WHERE id = $1 AND org_id = $2', [req.params.id, orgId]);
  if (!rows.length) return res.status(404).json({ error: 'Instance not found' });

  if (rows[0].zeebe_instance_key) {
    await cancelInstance(String(rows[0].zeebe_instance_key));
  }
  await query(
    "UPDATE workflow_instances SET status = 'terminated', completed_at = NOW() WHERE id = $1",
    [req.params.id]
  );
  await emitEvent('workflow.terminated', orgId, { instance_id: req.params.id }, undefined, userId);
  res.json({ terminated: true });
});

export default router;
