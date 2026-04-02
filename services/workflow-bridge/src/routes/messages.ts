import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { publishMessage } from '../services/zeebeClient';

const router = Router();

// POST /messages — BPMN message correlation
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  const { message_name, correlation_key, variables } = req.body;
  if (!message_name || !correlation_key) return res.status(400).json({ error: 'message_name and correlation_key required' });
  await publishMessage(message_name, correlation_key, variables || {});
  res.json({ published: true, message_name, correlation_key });
});

export default router;
