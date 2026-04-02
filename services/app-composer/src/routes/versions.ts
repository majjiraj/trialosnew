import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/postgres';
import { authenticate, requireScope, AuthRequest } from '../middleware/auth';
import { writeAuditEvent } from '../integrations/auditClient';

const router = Router({ mergeParams: true });

// GET /apps/:id/versions
router.get('/', authenticate, requireScope('apps:read'), async (req: AuthRequest, res: Response) => {
  const { rows } = await query(
    'SELECT * FROM app_versions WHERE app_id = $1 ORDER BY created_at DESC',
    [req.params.id]
  );
  res.json({ versions: rows });
});

// POST /apps/:id/versions — create new version snapshot
router.post('/', authenticate, requireScope('apps:write'), async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const userId = req.user!.sub;
  const { change_type, change_reason } = req.body;

  const { rows: apps } = await query(
    'SELECT * FROM app_definitions WHERE id = $1 AND org_id = $2',
    [req.params.id, orgId]
  );
  if (!apps.length) return res.status(404).json({ error: 'App not found' });
  const app = apps[0];

  // Compute next version number
  const { rows: lastVersions } = await query(
    'SELECT version FROM app_versions WHERE app_id = $1 ORDER BY created_at DESC LIMIT 1',
    [req.params.id]
  );
  const lastVer = lastVersions[0]?.version || app.version || '1.0.0';
  const parts = lastVer.split('.').map(Number);
  if (change_type === 'major') { parts[0]++; parts[1] = 0; parts[2] = 0; }
  else if (change_type === 'minor') { parts[1]++; parts[2] = 0; }
  else { parts[2]++; }
  const newVersion = parts.join('.');

  // Archive existing active version
  await query(
    "UPDATE app_versions SET status = 'archived' WHERE app_id = $1 AND status = 'active'",
    [req.params.id]
  );

  const id = uuidv4();
  await query(
    `INSERT INTO app_versions (id, app_id, version, status, change_type, change_reason, changed_by, name, description, bpmn_xml, form_ids, agent_attachments, settings)
     VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, req.params.id, newVersion, change_type || 'minor', change_reason || '',
     userId, app.name, app.description, app.bpmn_xml,
     JSON.stringify(app.form_ids), JSON.stringify(app.agent_attachments), JSON.stringify(app.settings)]
  );

  const { rows } = await query('SELECT * FROM app_versions WHERE id = $1', [id]);
  await writeAuditEvent({ orgId, actorId: userId, action: 'app.versioned', resourceType: 'app_version', resourceId: id, afterState: { app_id: req.params.id, version: newVersion } });
  res.status(201).json(rows[0]);
});

// GET /apps/:id/versions/:vid
router.get('/:vid', authenticate, requireScope('apps:read'), async (req: AuthRequest, res: Response) => {
  const { rows } = await query(
    'SELECT * FROM app_versions WHERE id = $1 AND app_id = $2',
    [req.params.vid, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Version not found' });
  res.json(rows[0]);
});

export default router;
