/**
 * TrialOS MongoDB Seed Script — ACP Collections
 * Run with: mongosh <connection-string> seed-mongodb.js
 * Or via docker exec: docker exec -i trialo-mongodb-1 mongosh trialo --username trialo --password trialopass --authenticationDatabase admin seed-mongodb.js
 */

const db = db.getSiblingDB('trialo');

// ─── form_schemas ──────────────────────────────────────────────────────────────
db.createCollection('form_schemas', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['form_id', 'org_id', 'title', 'json_schema', 'created_at'],
      properties: {
        form_id:        { bsonType: 'string' },
        org_id:         { bsonType: 'string' },
        app_id:         { bsonType: ['string', 'null'] },
        title:          { bsonType: 'string' },
        description:    { bsonType: ['string', 'null'] },
        json_schema:    { bsonType: 'object' },
        ui_schema:      { bsonType: ['object', 'null'] },
        conditional_logic: { bsonType: ['array', 'null'] },
        version:        { bsonType: 'string' },
        status:         { bsonType: 'string', enum: ['draft', 'active', 'archived'] },
        created_by:     { bsonType: ['string', 'null'] },
        created_at:     { bsonType: 'date' },
        updated_at:     { bsonType: ['date', 'null'] },
      }
    }
  },
  validationAction: 'warn',
});

db.form_schemas.createIndex({ form_id: 1 }, { unique: true });
db.form_schemas.createIndex({ org_id: 1, app_id: 1 });
db.form_schemas.createIndex({ org_id: 1, status: 1 });

// Seed example SAE intake form schema
db.form_schemas.insertMany([
  {
    form_id: 'form-sae-initial-report',
    org_id: '00000000-0000-0000-0000-000000000000',
    app_id: null,
    title: 'SAE Initial Report',
    description: 'Serious Adverse Event initial report form for site CRC/PI completion',
    version: '1.0.0',
    status: 'active',
    json_schema: {
      type: 'object',
      title: 'SAE Initial Report',
      required: ['subject_id', 'ae_term', 'onset_date', 'reporter_name', 'sae_criteria'],
      properties: {
        subject_id:     { type: 'string', title: 'Subject ID', pattern: '^[A-Z0-9-]+$' },
        ae_term:        { type: 'string', title: 'Adverse Event Term', minLength: 3 },
        onset_date:     { type: 'string', format: 'date', title: 'Onset Date' },
        severity:       { type: 'string', title: 'Severity', enum: ['mild', 'moderate', 'severe', 'life-threatening', 'fatal'] },
        sae_criteria:   { type: 'array', title: 'SAE Criteria Met', items: { type: 'string', enum: ['death', 'life_threatening', 'hospitalization', 'disability', 'congenital', 'medically_significant'] } },
        related_to_study: { type: 'boolean', title: 'Related to Study Drug?' },
        action_taken:   { type: 'string', title: 'Action Taken', enum: ['none', 'dose_reduced', 'drug_interrupted', 'drug_discontinued', 'not_applicable'] },
        narrative:      { type: 'string', title: 'Narrative Description', minLength: 50 },
        reporter_name:  { type: 'string', title: 'Reporter Name' },
        reporter_role:  { type: 'string', title: 'Reporter Role', enum: ['site_crc', 'site_pi', 'medical_monitor'] },
      }
    },
    ui_schema: {
      subject_id:     { 'ui:placeholder': 'e.g. TRIAL-001-001' },
      sae_criteria:   { 'ui:widget': 'checkboxes' },
      narrative:      { 'ui:widget': 'textarea', 'ui:options': { rows: 6 } },
      onset_date:     { 'ui:widget': 'date' },
      related_to_study: { 'ui:widget': 'radio' },
    },
    conditional_logic: [
      {
        when: { field: 'severity', operator: 'equals', value: 'fatal' },
        then: { field: 'narrative', rules: { required: true, minLength: 100 } }
      }
    ],
    created_by: null,
    created_at: new Date(),
    updated_at: null,
  },
  {
    form_id: 'form-protocol-deviation',
    org_id: '00000000-0000-0000-0000-000000000000',
    app_id: null,
    title: 'Protocol Deviation Report',
    description: 'Report and classify protocol deviations',
    version: '1.0.0',
    status: 'active',
    json_schema: {
      type: 'object',
      title: 'Protocol Deviation Report',
      required: ['subject_id', 'deviation_type', 'deviation_date', 'description', 'reporter_name'],
      properties: {
        subject_id:       { type: 'string', title: 'Subject ID' },
        deviation_type:   { type: 'string', title: 'Deviation Type', enum: ['eligibility', 'consent', 'dosing', 'visit_timing', 'prohibited_medication', 'procedure', 'other'] },
        deviation_date:   { type: 'string', format: 'date', title: 'Deviation Date' },
        discovered_date:  { type: 'string', format: 'date', title: 'Date Discovered' },
        description:      { type: 'string', title: 'Description of Deviation', minLength: 30 },
        root_cause:       { type: 'string', title: 'Root Cause' },
        impact:           { type: 'string', title: 'Subject Safety Impact', enum: ['none', 'minimal', 'moderate', 'significant'] },
        corrective_action:{ type: 'string', title: 'Corrective Action Taken' },
        preventive_action:{ type: 'string', title: 'Preventive Action' },
        reporter_name:    { type: 'string', title: 'Reporter Name' },
      }
    },
    ui_schema: {
      description:       { 'ui:widget': 'textarea', 'ui:options': { rows: 4 } },
      root_cause:        { 'ui:widget': 'textarea', 'ui:options': { rows: 3 } },
      corrective_action: { 'ui:widget': 'textarea', 'ui:options': { rows: 3 } },
      preventive_action: { 'ui:widget': 'textarea', 'ui:options': { rows: 3 } },
    },
    conditional_logic: [],
    created_by: null,
    created_at: new Date(),
    updated_at: null,
  }
]);

// ─── form_submissions ──────────────────────────────────────────────────────────
db.createCollection('form_submissions', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['submission_id', 'form_id', 'org_id', 'data', 'status', 'submitted_at'],
      properties: {
        submission_id:    { bsonType: 'string' },
        form_id:          { bsonType: 'string' },
        org_id:           { bsonType: 'string' },
        workflow_task_id: { bsonType: ['string', 'null'] },
        instance_id:      { bsonType: ['string', 'null'] },
        submitted_by:     { bsonType: ['string', 'null'] },
        data:             { bsonType: 'object' },
        encrypted_fields: { bsonType: ['object', 'null'] },
        reviewer_annotations: { bsonType: ['array', 'null'] },
        status:           { bsonType: 'string', enum: ['draft', 'submitted', 'reviewed', 'signed', 'rejected'] },
        esignature_id:    { bsonType: ['string', 'null'] },
        submitted_at:     { bsonType: 'date' },
        updated_at:       { bsonType: ['date', 'null'] },
      }
    }
  },
  validationAction: 'warn',
});

db.form_submissions.createIndex({ submission_id: 1 }, { unique: true });
db.form_submissions.createIndex({ form_id: 1, org_id: 1 });
db.form_submissions.createIndex({ org_id: 1, status: 1 });
db.form_submissions.createIndex({ workflow_task_id: 1 });

// ─── app_run_data ──────────────────────────────────────────────────────────────
db.createCollection('app_run_data', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['instance_id', 'org_id', 'event_type', 'timestamp'],
      properties: {
        instance_id:   { bsonType: 'string' },
        org_id:        { bsonType: 'string' },
        event_type:    { bsonType: 'string' },
        element_id:    { bsonType: ['string', 'null'] },
        element_name:  { bsonType: ['string', 'null'] },
        element_type:  { bsonType: ['string', 'null'] },
        variables:     { bsonType: ['object', 'null'] },
        agent_run_result: { bsonType: ['object', 'null'] },
        actor_id:      { bsonType: ['string', 'null'] },
        timestamp:     { bsonType: 'date' },
      }
    }
  },
  validationAction: 'warn',
});

db.app_run_data.createIndex({ instance_id: 1, timestamp: 1 });
db.app_run_data.createIndex({ org_id: 1, event_type: 1 });

// ─── bpmn_templates ───────────────────────────────────────────────────────────
db.createCollection('bpmn_templates', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['template_id', 'name', 'bpmn_xml', 'created_at'],
      properties: {
        template_id:   { bsonType: 'string' },
        org_id:        { bsonType: ['string', 'null'] },  // null = platform template
        name:          { bsonType: 'string' },
        description:   { bsonType: ['string', 'null'] },
        category:      { bsonType: 'string' },
        bpmn_xml:      { bsonType: 'string' },
        thumbnail_url: { bsonType: ['string', 'null'] },
        tags:          { bsonType: 'array' },
        created_at:    { bsonType: 'date' },
      }
    }
  },
  validationAction: 'warn',
});

db.bpmn_templates.createIndex({ template_id: 1 }, { unique: true });
db.bpmn_templates.createIndex({ org_id: 1, category: 1 });
db.bpmn_templates.createIndex({ tags: 1 });

// Seed placeholder platform templates (org_id: null = available to all)
db.bpmn_templates.insertMany([
  {
    template_id: 'tpl-sae-review',
    org_id: null,
    name: 'SAE Review Workflow',
    description: 'End-to-end Serious Adverse Event review process with AI classification, medical review, regulatory notification, PI signature, and report generation.',
    category: 'safety',
    bpmn_xml: '<!-- SAE Review BPMN loaded from services/workflow-bridge/templates/sae-review.bpmn -->',
    thumbnail_url: null,
    tags: ['SAE', 'safety', 'regulatory', '21CFR', 'eSignature'],
    created_at: new Date(),
  },
  {
    template_id: 'tpl-adverse-event-intake',
    org_id: null,
    name: 'Adverse Event Intake',
    description: 'Initial adverse event capture with triage and routing to appropriate review workflow.',
    category: 'safety',
    bpmn_xml: '<!-- AE Intake BPMN loaded from services/workflow-bridge/templates/adverse-event-intake.bpmn -->',
    thumbnail_url: null,
    tags: ['AE', 'safety', 'intake'],
    created_at: new Date(),
  },
  {
    template_id: 'tpl-protocol-deviation',
    org_id: null,
    name: 'Protocol Deviation Handling',
    description: 'Capture, classify, and remediate protocol deviations with CAPA workflow.',
    category: 'compliance',
    bpmn_xml: '<!-- PD BPMN loaded from services/workflow-bridge/templates/protocol-deviation.bpmn -->',
    thumbnail_url: null,
    tags: ['protocol', 'deviation', 'CAPA', 'compliance'],
    created_at: new Date(),
  },
  {
    template_id: 'tpl-site-initiation',
    org_id: null,
    name: 'Site Initiation Visit',
    description: 'Structured site initiation checklist with document collection, training verification, and regulatory package sign-off.',
    category: 'site-management',
    bpmn_xml: '<!-- Site Init BPMN loaded from services/workflow-bridge/templates/site-initiation.bpmn -->',
    thumbnail_url: null,
    tags: ['site', 'initiation', 'SIV', 'checklist'],
    created_at: new Date(),
  }
]);

// ─── app_marketplace_reviews ──────────────────────────────────────────────────
db.createCollection('app_marketplace_reviews', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['app_id', 'org_id', 'reviewer_id', 'rating', 'created_at'],
      properties: {
        app_id:       { bsonType: 'string' },
        org_id:       { bsonType: 'string' },
        reviewer_id:  { bsonType: 'string' },
        rating:       { bsonType: 'int', minimum: 1, maximum: 5 },
        title:        { bsonType: ['string', 'null'] },
        body:         { bsonType: ['string', 'null'] },
        created_at:   { bsonType: 'date' },
      }
    }
  },
  validationAction: 'warn',
});

db.app_marketplace_reviews.createIndex({ app_id: 1, created_at: -1 });
db.app_marketplace_reviews.createIndex({ app_id: 1, org_id: 1, reviewer_id: 1 }, { unique: true });

print('✅ TrialOS MongoDB ACP seed complete.');
print('   Collections created: form_schemas, form_submissions, app_run_data, bpmn_templates, app_marketplace_reviews');
