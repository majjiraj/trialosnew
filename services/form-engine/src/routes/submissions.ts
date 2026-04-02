import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { getDb } from '../db/mongo';
import { authenticate, AuthRequest } from '../middleware/auth';
import { validateFormData } from '../services/validationService';
import { encryptPiiFields } from '../services/encryptionService';
import { emitEvent } from '../integrations/kafkaProducer';
import { writeAuditEvent } from '../integrations/auditClient';
import axios from 'axios';
import { config } from '../config';

// PII fields that must be encrypted at rest
const PII_FIELDS = ['subject_id', 'date_of_birth', 'patient_name', 'reporter_name', 'email', 'phone'];

const router = Router({ mergeParams: true });

// POST /forms/:id/submit
router.post('/submit', authenticate, async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const userId = req.user!.sub;
  const formId = req.params.id;
  const { data, workflow_task_id, instance_id } = req.body;

  const db = getDb();
  const form = await db.collection('form_schemas').findOne({ form_id: formId, org_id: orgId });
  if (!form) return res.status(404).json({ error: 'Form not found' });

  // Validate
  const validation = validateFormData(form.json_schema, data);
  if (!validation.valid) return res.status(422).json({ error: 'Validation failed', errors: validation.errors });

  // Encrypt PII
  const { clean, encrypted } = encryptPiiFields(data, PII_FIELDS, orgId);

  const submissionId = uuidv4();
  const doc = {
    submission_id: submissionId, form_id: formId, org_id: orgId,
    workflow_task_id: workflow_task_id || null,
    instance_id: instance_id || null,
    submitted_by: userId, data: clean, encrypted_fields: encrypted,
    reviewer_annotations: [], status: 'submitted',
    esignature_id: null, submitted_at: new Date(), updated_at: null,
  };
  await db.collection('form_submissions').insertOne(doc);
  await writeAuditEvent({ orgId, actorId: userId, action: 'form.submitted', resourceType: 'form_submission', resourceId: submissionId });
  await emitEvent('form.submitted', orgId, { form_id: formId, submission_id: submissionId }, undefined, userId);
  res.status(201).json({ ...doc, encrypted_fields: undefined }); // never return encrypted PII
});

// GET /forms/:id/submissions/:subId
router.get('/submissions/:subId', authenticate, async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const db = getDb();
  const sub = await db.collection('form_submissions').findOne(
    { submission_id: req.params.subId, org_id: orgId },
    { projection: { encrypted_fields: 0 } } // never expose encrypted PII in list
  );
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  res.json(sub);
});

// PATCH /forms/:id/submissions/:subId — update status / add annotation
router.patch('/submissions/:subId', authenticate, async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const db = getDb();
  const { status, reviewer_annotation } = req.body;
  const update: Record<string, unknown> = { updated_at: new Date() };
  if (status) update.status = status;
  if (reviewer_annotation) update['$push'] = { reviewer_annotations: { ...reviewer_annotation, reviewed_by: req.user!.sub, reviewed_at: new Date() } };
  const result = await db.collection('form_submissions').findOneAndUpdate(
    { submission_id: req.params.subId, org_id: orgId },
    reviewer_annotation ? { $set: { status, updated_at: new Date() }, $push: { reviewer_annotations: { ...reviewer_annotation, reviewed_by: req.user!.sub, reviewed_at: new Date() } } } : { $set: update },
    { returnDocument: 'after', projection: { encrypted_fields: 0 } }
  );
  if (!result) return res.status(404).json({ error: 'Submission not found' });
  res.json(result);
});

// POST /submissions/:subId/sign — e-signature on submission
router.post('/submissions/:subId/sign', authenticate, async (req: AuthRequest, res: Response) => {
  const orgId = req.orgId!;
  const userId = req.user!.sub;
  const { meaning, password } = req.body;
  if (!meaning || !password) return res.status(400).json({ error: 'meaning and password required' });

  // Verify password
  try {
    await axios.post(`${config.authServiceUrl}/auth/verify-password`, { user_id: userId, password });
  } catch {
    return res.status(401).json({ error: 'Password verification failed' });
  }

  const db = getDb();
  const sub = await db.collection('form_submissions').findOne({ submission_id: req.params.subId, org_id: orgId }, { projection: { encrypted_fields: 0 } });
  if (!sub) return res.status(404).json({ error: 'Submission not found' });

  const contentHash = createHash('sha256').update(JSON.stringify(sub)).digest('hex');
  const sigId = uuidv4();

  // Store signature in PostgreSQL
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: config.databaseUrl });
  await pool.query(
    `INSERT INTO electronic_signatures (id, org_id, resource_type, resource_id, signer_id, meaning, auth_method, content_hash)
     VALUES ($1,$2,'form_submission',$3,$4,$5,'password',$6)`,
    [sigId, orgId, req.params.subId, userId, meaning, contentHash]
  );
  await pool.end();

  // Update submission status
  await db.collection('form_submissions').updateOne(
    { submission_id: req.params.subId },
    { $set: { status: 'signed', esignature_id: sigId, updated_at: new Date() } }
  );

  await writeAuditEvent({ orgId, actorId: userId, action: 'form_submission.signed', resourceType: 'form_submission', resourceId: req.params.subId });
  res.status(201).json({ signature_id: sigId, content_hash: contentHash, signed_at: new Date() });
});

export default router;
