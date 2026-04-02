import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/postgres';
import { authenticate, requireScope, AuthRequest } from '../middleware/auth';
import { writeAuditEvent } from '../integrations/auditClient';
import { emitEvent } from '../integrations/kafkaProducer';
import { generateBpmnXml, type WorkflowDefinition } from '../services/bpmnGenerator';

const router = Router();

// GET /apps — list apps for org (+ published platform apps)
// Accepts org_id from JWT or query param (for internal gateway calls)
router.get('/', async (req: AuthRequest, res: Response) => {
  const orgId = (req.query.org_id as string) || req.orgId || '';
  const { status, category } = req.query;
  const conditions: string[] = ['(a.org_id = $1 OR (a.is_published = TRUE AND a.publisher_org_id = $2))'];
  const params: unknown[] = [orgId, '00000000-0000-0000-0000-000000000000'];
  let idx = 3;
  if (status) { conditions.push(`a.status = $${idx++}`); params.push(status); }
  if (category) { conditions.push(`a.category = $${idx++}`); params.push(category); }
  const sql = `SELECT * FROM app_definitions a WHERE ${conditions.join(' AND ')} ORDER BY a.created_at DESC`;
  const result = await query(sql, params);
  res.json({ apps: result.rows });
});

// POST /apps — create app definition
router.post('/', authenticate, requireScope('apps:write'), async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const userId = req.user!.sub;
  const { name, slug, description, category, bpmn_xml, form_ids, agent_attachments, settings } = req.body;
  if (!name || !slug) return res.status(400).json({ error: 'name and slug are required' });

  // Check for existing app with same slug in this org
  const { rows: existing } = await query(
    'SELECT id FROM app_definitions WHERE org_id = $1 AND slug = $2',
    [orgId, slug]
  );
  if (existing.length) return res.status(409).json({ error: 'App with this slug already exists', app_id: existing[0].id });

  const id = uuidv4();
  await query(
    `INSERT INTO app_definitions (id, org_id, name, slug, description, category, bpmn_xml, form_ids, agent_attachments, settings, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, orgId, name, slug, description || '', category || 'clinical',
     bpmn_xml || null, JSON.stringify(form_ids || []), JSON.stringify(agent_attachments || []),
     JSON.stringify(settings || {}), userId]
  );
  const { rows } = await query('SELECT * FROM app_definitions WHERE id = $1', [id]);
  await writeAuditEvent({ orgId, actorId: userId, action: 'app.created', resourceType: 'app_definition', resourceId: id, afterState: rows[0] });
  await emitEvent('app.created', orgId, { app_id: id, name }, undefined, userId);
  res.status(201).json(rows[0]);
});

// GET /apps/:id — single app (accepts org_id from query param for internal gateway calls)
router.get('/:id', async (req: AuthRequest, res: Response) => {
  const orgId = (req.query.org_id as string) || req.orgId || '';
  // If org_id provided: match own apps OR published apps. Without org_id: match any (internal call).
  const { rows } = orgId
    ? await query(
        'SELECT * FROM app_definitions WHERE id = $1 AND (org_id = $2 OR is_published = TRUE)',
        [req.params.id, orgId]
      )
    : await query('SELECT * FROM app_definitions WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'App not found' });
  res.json(rows[0]);
});

// PATCH /apps/:id — update app
router.patch('/:id', authenticate, requireScope('apps:write'), async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const userId = req.user!.sub;
  const { name, description, category, bpmn_xml, form_ids, agent_attachments, settings, workflow_definition } = req.body;
  const { rows: existing } = await query('SELECT * FROM app_definitions WHERE id = $1 AND org_id = $2', [req.params.id, orgId]);
  if (!existing.length) return res.status(404).json({ error: 'App not found' });

  // If workflow_definition is provided, auto-generate BPMN XML from it
  let resolvedBpmnXml = bpmn_xml;
  if (workflow_definition && typeof workflow_definition === 'object') {
    try {
      resolvedBpmnXml = generateBpmnXml(workflow_definition as WorkflowDefinition);
    } catch (err) {
      console.error('BPMN generation failed:', err);
      return res.status(400).json({ error: 'Failed to generate BPMN from workflow definition' });
    }
  }

  await query(
    `UPDATE app_definitions SET name=COALESCE($1,name), description=COALESCE($2,description),
     category=COALESCE($3,category), bpmn_xml=COALESCE($4,bpmn_xml),
     form_ids=COALESCE($5,form_ids), agent_attachments=COALESCE($6,agent_attachments),
     settings=COALESCE($7,settings), updated_at=NOW(), updated_by=$8,
     workflow_definition=COALESCE($11,workflow_definition)
     WHERE id=$9 AND org_id=$10`,
    [name, description, category, resolvedBpmnXml,
     form_ids ? JSON.stringify(form_ids) : null,
     agent_attachments ? JSON.stringify(agent_attachments) : null,
     settings ? JSON.stringify(settings) : null,
     userId, req.params.id, orgId,
     workflow_definition ? JSON.stringify(workflow_definition) : null]
  );
  const { rows } = await query('SELECT * FROM app_definitions WHERE id = $1', [req.params.id]);
  await writeAuditEvent({ orgId, actorId: userId, action: 'app.updated', resourceType: 'app_definition', resourceId: req.params.id });
  res.json(rows[0]);
});

// DELETE /apps/:id
router.delete('/:id', authenticate, requireScope('apps:write'), async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const userId = req.user!.sub;
  const { rowCount } = await query('DELETE FROM app_definitions WHERE id = $1 AND org_id = $2', [req.params.id, orgId]);
  if (!rowCount) return res.status(404).json({ error: 'App not found' });
  await writeAuditEvent({ orgId, actorId: userId, action: 'app.deleted', resourceType: 'app_definition', resourceId: req.params.id });
  res.json({ deleted: true });
});

export default router;
