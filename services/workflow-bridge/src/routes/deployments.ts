import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authenticate, AuthRequest } from '../middleware/auth';
import { deployBpmn } from '../services/zeebeClient';
import { query } from '../db/postgres';

const router = Router();

// POST /deployments — deploy BPMN to Zeebe (internal service-to-service, no JWT required)
router.post('/', async (req: AuthRequest, res: Response) => {
  const { org_id, app_id, bpmn_xml } = req.body;
  if (!bpmn_xml) return res.status(400).json({ error: 'bpmn_xml required' });

  const processId = `app-${app_id || uuidv4()}`;
  const { deploymentKey } = await deployBpmn(bpmn_xml, processId);

  // Record deployment in app_installations if app_id provided
  if (app_id && deploymentKey) {
    await query(
      'UPDATE app_installations SET zeebe_deployment_key = $1 WHERE app_id = $2 AND org_id = $3',
      [String(deploymentKey), app_id, org_id]
    );
  }

  res.status(201).json({
    deployment_key: deploymentKey ? String(deploymentKey) : null,
    process_id: processId,
    status: deploymentKey ? 'deployed' : 'pending',
  });
});

// GET /deployments — list deployments for org (from app_installations)
router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const { rows } = await query(
    `SELECT i.id, i.app_id, i.zeebe_deployment_key, i.installed_version, i.status, a.name as app_name
     FROM app_installations i JOIN app_definitions a ON a.id = i.app_id
     WHERE i.org_id = $1 AND i.zeebe_deployment_key IS NOT NULL`,
    [orgId]
  );
  res.json({ deployments: rows });
});

// DELETE /deployments/:key — undeploy (cancel all instances)
router.delete('/:key', authenticate, async (req: AuthRequest, res: Response) => {
  // Zeebe doesn't support true undeploy — mark installation as suspended
  const orgId = req.orgId!;
  await query(
    "UPDATE app_installations SET status = 'suspended' WHERE zeebe_deployment_key = $1 AND org_id = $2",
    [req.params.key, orgId]
  );
  res.json({ undeployed: true, deployment_key: req.params.key });
});

export default router;
