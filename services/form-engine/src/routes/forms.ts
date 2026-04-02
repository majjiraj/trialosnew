import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/mongo';
import { authenticate, AuthRequest } from '../middleware/auth';
import { validateFormData } from '../services/validationService';

const router = Router();

// GET /forms — list forms for org (accepts org_id query param for internal calls)
router.get('/', async (req: AuthRequest, res: Response) => {
  const orgId = (req.query.org_id as string) || req.orgId || '';
  const db = getDb();
  const { app_id, status } = req.query;
  const filter: Record<string, unknown> = { org_id: orgId };
  if (app_id) filter.app_id = app_id;
  if (status) filter.status = status;
  const forms = await db.collection('form_schemas').find(filter).sort({ created_at: -1 }).toArray();
  res.json({ forms });
});

// POST /forms — create form schema
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const userId = req.user!.sub;
  const { title, description, json_schema, ui_schema, conditional_logic, app_id } = req.body;
  if (!title || !json_schema) return res.status(400).json({ error: 'title and json_schema required' });

  const formId = `form-${uuidv4()}`;
  const doc = {
    form_id: formId, org_id: orgId, app_id: app_id || null,
    title, description: description || null,
    json_schema, ui_schema: ui_schema || null,
    conditional_logic: conditional_logic || [],
    version: '1.0.0', status: 'draft',
    created_by: userId, created_at: new Date(), updated_at: null,
  };
  const db = getDb();
  await db.collection('form_schemas').insertOne(doc);
  res.status(201).json(doc);
});

// GET /forms/:id
router.get('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const db = getDb();
  const form = await db.collection('form_schemas').findOne({ form_id: req.params.id, org_id: orgId });
  if (!form) return res.status(404).json({ error: 'Form not found' });
  res.json(form);
});

// PATCH /forms/:id
router.patch('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const db = getDb();
  const { title, description, json_schema, ui_schema, conditional_logic, status } = req.body;
  const update: Record<string, unknown> = { updated_at: new Date() };
  if (title) update.title = title;
  if (description !== undefined) update.description = description;
  if (json_schema) update.json_schema = json_schema;
  if (ui_schema !== undefined) update.ui_schema = ui_schema;
  if (conditional_logic !== undefined) update.conditional_logic = conditional_logic;
  if (status) update.status = status;
  const result = await db.collection('form_schemas').findOneAndUpdate(
    { form_id: req.params.id, org_id: orgId },
    { $set: update },
    { returnDocument: 'after' }
  );
  if (!result) return res.status(404).json({ error: 'Form not found' });
  res.json(result);
});

// GET /forms/:id/render — return schema + ui_schema for frontend rendering
router.get('/:id/render', authenticate, async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const db = getDb();
  const form = await db.collection('form_schemas').findOne(
    { form_id: req.params.id, org_id: orgId },
    { projection: { form_id: 1, title: 1, json_schema: 1, ui_schema: 1, conditional_logic: 1 } }
  );
  if (!form) return res.status(404).json({ error: 'Form not found' });
  res.json(form);
});

// POST /forms/:id/validate — validate data without saving
router.post('/:id/validate', authenticate, async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const db = getDb();
  const form = await db.collection('form_schemas').findOne({ form_id: req.params.id, org_id: orgId });
  if (!form) return res.status(404).json({ error: 'Form not found' });
  const result = validateFormData(form.json_schema, req.body.data);
  res.json(result);
});

export default router;
