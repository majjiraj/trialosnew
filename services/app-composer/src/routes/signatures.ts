import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { query } from '../db/postgres';
import { authenticate, requireScope, AuthRequest } from '../middleware/auth';
import { writeAuditEvent } from '../integrations/auditClient';
import axios from 'axios';
import { config } from '../config';

const router = Router({ mergeParams: true });

// POST /apps/:id/sign — 21 CFR Part 11 e-signature
router.post('/sign', authenticate, requireScope('esig:create'), async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const userId = req.user!.sub;
  const appId = req.params.id;
  const { meaning, password, resource_type, resource_id } = req.body;

  if (!meaning || !password) return res.status(400).json({ error: 'meaning and password required' });

  // Verify password via auth service
  try {
    await axios.post(`${config.authServiceUrl}/auth/verify-password`, {
      user_id: userId, password,
    });
  } catch {
    return res.status(401).json({ error: 'Password verification failed' });
  }

  // Fetch current resource state for content hash
  let resourceState: unknown = { app_id: appId, resource_type, resource_id };
  if (resource_type === 'app_definition') {
    const { rows } = await query('SELECT * FROM app_definitions WHERE id = $1', [appId]);
    resourceState = rows[0] || resourceState;
  } else if (resource_type === 'app_version' && resource_id) {
    const { rows } = await query('SELECT * FROM app_versions WHERE id = $1', [resource_id]);
    resourceState = rows[0] || resourceState;
  }

  const contentHash = createHash('sha256').update(JSON.stringify(resourceState)).digest('hex');
  const sigId = uuidv4();

  await query(
    `INSERT INTO electronic_signatures (id, org_id, resource_type, resource_id, signer_id, meaning, auth_method, content_hash)
     VALUES ($1,$2,$3,$4,$5,$6,'password',$7)`,
    [sigId, orgId, resource_type || 'app_definition', resource_id || appId, userId, meaning, contentHash]
  );

  const auditResult = await query(
    `INSERT INTO audit_events (event_id, org_id, actor_type, actor_id, action, resource_type, resource_id, row_hash)
     VALUES (gen_random_uuid(), $1, 'user', $2, 'esignature.created', $3, $4, $5) RETURNING event_id`,
    [orgId, userId, resource_type || 'app_definition', resource_id || appId, contentHash]
  );

  // Chain audit event id
  await query('UPDATE electronic_signatures SET audit_event_id = $1 WHERE id = $2',
    [auditResult.rows[0]?.event_id, sigId]);

  const { rows } = await query('SELECT * FROM electronic_signatures WHERE id = $1', [sigId]);
  await writeAuditEvent({ orgId, actorId: userId, action: 'esignature.created', resourceType: resource_type || 'app_definition', resourceId: resource_id || appId });
  res.status(201).json(rows[0]);
});

// GET /apps/:id/signatures
router.get('/signatures', authenticate, requireScope('apps:read'), async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const { rows } = await query(
    'SELECT * FROM electronic_signatures WHERE org_id = $1 AND resource_id = $2 ORDER BY signed_at DESC',
    [orgId, req.params.id]
  );
  res.json({ signatures: rows });
});

export default router;
