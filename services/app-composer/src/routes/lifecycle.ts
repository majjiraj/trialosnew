import { Router, Response } from 'express';
import { query } from '../db/postgres';
import { authenticate, requireScope, AuthRequest } from '../middleware/auth';
import { writeAuditEvent } from '../integrations/auditClient';
import { emitEvent } from '../integrations/kafkaProducer';

const router = Router({ mergeParams: true });

// POST /apps/:id/submit-for-review
router.post('/submit-for-review', authenticate, requireScope('apps:write'), async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const userId = req.user!.sub;
  const { rowCount } = await query(
    "UPDATE app_definitions SET status='under_review', updated_at=NOW(), updated_by=$1 WHERE id=$2 AND org_id=$3 AND status='draft'",
    [userId, req.params.id, orgId]
  );
  if (!rowCount) return res.status(400).json({ error: 'App not found or not in draft status' });
  await writeAuditEvent({ orgId, actorId: userId, action: 'app.submitted_for_review', resourceType: 'app_definition', resourceId: req.params.id });
  await emitEvent('app.submitted_for_review', orgId, { app_id: req.params.id }, undefined, userId);
  res.json({ status: 'under_review' });
});

// POST /apps/:id/publish (platform admin only)
router.post('/publish', authenticate, requireScope('apps:publish'), async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const userId = req.user!.sub;
  await query(
    "UPDATE app_definitions SET status='published', is_published=TRUE, publisher_org_id=org_id, updated_at=NOW(), updated_by=$1 WHERE id=$2",
    [userId, req.params.id]
  );
  await writeAuditEvent({ orgId, actorId: userId, action: 'app.published', resourceType: 'app_definition', resourceId: req.params.id });
  await emitEvent('app.published', orgId, { app_id: req.params.id }, undefined, userId);
  res.json({ status: 'published', is_published: true });
});

// POST /apps/:id/unpublish
router.post('/unpublish', authenticate, requireScope('apps:publish'), async (req: AuthRequest, res: Response) => {
  const userId = req.user!.sub;
  const orgId = req.orgId!;
  await query(
    "UPDATE app_definitions SET is_published=FALSE, updated_at=NOW(), updated_by=$1 WHERE id=$2",
    [userId, req.params.id]
  );
  await writeAuditEvent({ orgId, actorId: userId, action: 'app.unpublished', resourceType: 'app_definition', resourceId: req.params.id });
  res.json({ is_published: false });
});

// POST /apps/:id/deprecate
router.post('/deprecate', authenticate, requireScope('apps:publish'), async (req: AuthRequest, res: Response) => {
  const userId = req.user!.sub;
  const orgId = req.orgId!;
  await query(
    "UPDATE app_definitions SET status='deprecated', is_published=FALSE, updated_at=NOW(), updated_by=$1 WHERE id=$2",
    [userId, req.params.id]
  );
  await writeAuditEvent({ orgId, actorId: userId, action: 'app.deprecated', resourceType: 'app_definition', resourceId: req.params.id });
  res.json({ status: 'deprecated' });
});

export default router;
