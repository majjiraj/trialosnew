import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/postgres';
import { authenticate, requireScope, AuthRequest } from '../middleware/auth';
import { writeAuditEvent } from '../integrations/auditClient';
import { emitEvent } from '../integrations/kafkaProducer';
import axios from 'axios';
import { config } from '../config';

const router = Router({ mergeParams: true });

// POST /apps/:id/install
router.post('/install', authenticate, requireScope('apps:install'), async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const userId = req.user!.sub;
  const appId = req.params.id;
  const { consented_permissions, custom_config } = req.body;

  // Fetch app
  const { rows: apps } = await query(
    'SELECT * FROM app_definitions WHERE id = $1 AND (org_id = $2 OR is_published = TRUE)',
    [appId, orgId]
  );
  if (!apps.length) return res.status(404).json({ error: 'App not found' });
  const app = apps[0];

  // Check already installed
  const { rows: existing } = await query(
    "SELECT id FROM app_installations WHERE org_id = $1 AND app_id = $2 AND status != 'uninstalled'",
    [orgId, appId]
  );
  if (existing.length) return res.status(409).json({ error: 'App already installed', installation_id: existing[0].id });

  // Auto-install agent attachments
  const agentAttachments: Array<{ agent_def_id: string }> = app.agent_attachments || [];
  for (const att of agentAttachments) {
    try {
      await axios.post(`${config.marketplaceUrl}/agents/install`, {
        org_id: orgId, agent_id: att.agent_def_id,
        installed_by: userId, consented_permissions: [],
      });
    } catch (err: unknown) {
      const axiosErr = err as { response?: { status?: number } };
      if (axiosErr.response?.status !== 409) {
        console.warn('[app-composer] Agent auto-install failed:', att.agent_def_id, err);
      }
    }
  }

  // Deploy BPMN to Zeebe via workflow-bridge
  let zeebeDeploymentKey: number | null = null;
  if (app.bpmn_xml) {
    try {
      const { data } = await axios.post(`${config.workflowBridgeUrl}/deployments`, {
        org_id: orgId, app_id: appId, bpmn_xml: app.bpmn_xml,
      });
      zeebeDeploymentKey = data.deployment_key;
    } catch (err) {
      console.warn('[app-composer] BPMN deployment failed:', err);
    }
  }

  const installId = uuidv4();
  await query(
    `INSERT INTO app_installations (id, org_id, app_id, installed_version, installed_by, zeebe_deployment_key, custom_config, consented_permissions)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [installId, orgId, appId, app.version, userId, zeebeDeploymentKey,
     JSON.stringify(custom_config || {}), consented_permissions || []]
  );

  const { rows } = await query('SELECT * FROM app_installations WHERE id = $1', [installId]);
  await writeAuditEvent({ orgId, actorId: userId, action: 'app.installed', resourceType: 'app_installation', resourceId: installId, afterState: rows[0] });
  await emitEvent('app.installed', orgId, { app_id: appId, installation_id: installId }, undefined, userId);
  res.status(201).json(rows[0]);
});

// GET /installs — list installs for org (accepts org_id from query param for internal gateway calls)
router.get('/installs', async (req: AuthRequest, res: Response) => {
  const orgId = (req.query.org_id as string) || req.orgId || '';
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  const { rows } = await query(
    `SELECT i.*, a.name as app_name, a.description, a.category, a.slug, a.bpmn_xml as app_bpmn_xml
     FROM app_installations i JOIN app_definitions a ON a.id = i.app_id
     WHERE i.org_id = $1 AND i.status != 'uninstalled' ORDER BY i.installed_at DESC`,
    [orgId]
  );
  res.json({ installations: rows });
});

// PATCH /installs/:iid
router.patch('/installs/:iid', authenticate, requireScope('apps:install'), async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const userId = req.user!.sub;
  const { custom_config, status } = req.body;
  await query(
    'UPDATE app_installations SET custom_config=COALESCE($1,custom_config), status=COALESCE($2,status), updated_at=NOW() WHERE id=$3 AND org_id=$4',
    [custom_config ? JSON.stringify(custom_config) : null, status, req.params.iid, orgId]
  );
  const { rows } = await query('SELECT * FROM app_installations WHERE id = $1', [req.params.iid]);
  await writeAuditEvent({ orgId, actorId: userId, action: 'app_installation.updated', resourceType: 'app_installation', resourceId: req.params.iid });
  res.json(rows[0]);
});

// POST /installs/:iid/upgrade
router.post('/installs/:iid/upgrade', authenticate, requireScope('apps:install'), async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const userId = req.user!.sub;
  const { rows: installs } = await query(
    'SELECT i.*, a.version as latest_version, a.bpmn_xml FROM app_installations i JOIN app_definitions a ON a.id = i.app_id WHERE i.id = $1 AND i.org_id = $2',
    [req.params.iid, orgId]
  );
  if (!installs.length) return res.status(404).json({ error: 'Installation not found' });
  const install = installs[0];

  // Re-deploy BPMN (in-flight instances continue on old version)
  let newDeploymentKey = install.zeebe_deployment_key;
  if (install.bpmn_xml) {
    try {
      const { data } = await axios.post(`${config.workflowBridgeUrl}/deployments`, {
        org_id: orgId, app_id: install.app_id, bpmn_xml: install.bpmn_xml,
      });
      newDeploymentKey = data.deployment_key;
    } catch (err) {
      console.warn('[app-composer] BPMN re-deploy failed:', err);
    }
  }

  await query(
    'UPDATE app_installations SET installed_version=$1, zeebe_deployment_key=$2, updated_at=NOW() WHERE id=$3',
    [install.latest_version, newDeploymentKey, req.params.iid]
  );
  await writeAuditEvent({ orgId, actorId: userId, action: 'app_installation.upgraded', resourceType: 'app_installation', resourceId: req.params.iid });
  res.json({ upgraded: true, new_version: install.latest_version });
});

export default router;
