import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

export interface ValidationResult {
  valid: boolean;
  errors: Array<{ field: string; message: string }>;
}

export function validateFormData(schema: Record<string, unknown>, data: unknown): ValidationResult {
  const validate = ajv.compile(schema);
  const valid = validate(data);
  if (valid) return { valid: true, errors: [] };
  const errors = (validate.errors || []).map(err => ({
    field: err.instancePath.replace(/^\//, '') || err.params?.missingProperty || 'unknown',
    message: err.message || 'Validation error',
  }));
  return { valid: false, errors };
}

export function evaluateConditionalLogic(
  conditionalLogic: Array<{ when: { field: string; operator: string; value: unknown }; then: Record<string, unknown> }>,
  data: Record<string, unknown>
): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  for (const rule of conditionalLogic || []) {
    const { when, then } = rule;
    const fieldValue = data[when.field];
    let matches = false;
    if (when.operator === 'equals') matches = fieldValue === when.value;
    else if (when.operator === 'not_equals') matches = fieldValue !== when.value;
    else if (when.operator === 'contains') matches = String(fieldValue).includes(String(when.value));
    else if (when.operator === 'greater_than') matches = Number(fieldValue) > Number(when.value);
    else if (when.operator === 'less_than') matches = Number(fieldValue) < Number(when.value);
    if (matches) Object.assign(overrides, then);
  }
  return overrides;
}
