import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';

const router = Router();

const TEMPLATES = [
  { id: 'sae-review', name: 'SAE Review Workflow', description: 'End-to-end SAE processing with AI classification and PI sign-off' },
  { id: 'protocol-deviation', name: 'Protocol Deviation Handling', description: 'Capture, classify, and remediate protocol deviations with CAPA' },
  { id: 'adverse-event-intake', name: 'Adverse Event Intake', description: 'AE capture with triage and routing to appropriate review workflow' },
  { id: 'site-initiation', name: 'Site Initiation Visit', description: 'Structured SIV checklist with regulatory package sign-off' },
  { id: 'sdtm-data-review', name: 'SDTM Data Review', description: 'Upload SDTM XPT files and interactively query study data with the SDTM Explorer AI agent' },
];

const TEMPLATES_DIR = path.join(__dirname, '../../templates');

// GET /templates — list available BPMN templates
router.get('/', (_req, res) => {
  res.json({ templates: TEMPLATES });
});

// GET /templates/:id — get template metadata + BPMN XML
router.get('/:id', (req, res) => {
  const { id } = req.params;
  const tmpl = TEMPLATES.find(t => t.id === id);
  if (!tmpl) return res.status(404).json({ error: 'Template not found' });

  const filePath = path.join(TEMPLATES_DIR, `${id}.bpmn`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Template file not found' });

  const xml = fs.readFileSync(filePath, 'utf-8');
  res.json({ id: tmpl.id, name: tmpl.name, description: tmpl.description, xml });
});

export default router;
