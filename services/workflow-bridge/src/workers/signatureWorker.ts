/**
 * signatureWorker — Zeebe job worker for trialo:require-esig.
 * Checks that an e-signature exists before allowing task completion.
 */
import { query } from '../db/postgres';

export async function checkESignature(resourceId: string, orgId: string): Promise<boolean> {
  const { rows } = await query(
    'SELECT id FROM electronic_signatures WHERE resource_id = $1 AND org_id = $2 LIMIT 1',
    [resourceId, orgId]
  );
  return rows.length > 0;
}
