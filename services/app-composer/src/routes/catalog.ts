import { Router, Response } from 'express';
import { query } from '../db/postgres';
import { authenticate, requireScope, AuthRequest } from '../middleware/auth';

const router = Router();

// GET /catalog — published apps available to install (public endpoint)
router.get('/catalog', async (_req: AuthRequest, res: Response) => {
  const { rows } = await query(
    `SELECT a.*, COUNT(ai.id) as install_count
     FROM app_definitions a
     LEFT JOIN app_installations ai ON ai.app_id = a.id AND ai.status = 'active'
     WHERE a.is_published = TRUE AND a.status = 'published'
     GROUP BY a.id
     ORDER BY install_count DESC, a.created_at DESC`
  );
  res.json({ apps: rows });
});

// GET /marketplace/apps — alias with review scores (joined from MongoDB via aggregation — placeholder)
router.get('/marketplace/apps', authenticate, requireScope('apps:read'), async (_req: AuthRequest, res: Response) => {
  const { rows } = await query(
    `SELECT a.* FROM app_definitions a
     WHERE a.is_published = TRUE AND a.status = 'published'
     ORDER BY a.created_at DESC`
  );
  res.json({ apps: rows });
});

export default router;
