import axios from 'axios';
import { config } from '../config';

export async function writeAuditEvent(params: {
  orgId: string;
  studyId?: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  beforeState?: unknown;
  afterState?: unknown;
}) {
  try {
    await axios.post(`${config.auditServiceUrl}/events`, {
      org_id: params.orgId,
      study_id: params.studyId || null,
      actor_type: 'user',
      actor_id: params.actorId,
      action: params.action,
      resource_type: params.resourceType,
      resource_id: params.resourceId || null,
      before_state: params.beforeState || null,
      after_state: params.afterState || null,
    });
  } catch (err) {
    console.warn('[app-composer] Audit write failed:', err);
  }
}
