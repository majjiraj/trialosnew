import { createCipheriv, createDecipheriv, randomBytes, createHmac } from 'crypto';
import { config } from '../config';

const ALGORITHM = 'aes-256-gcm';

function deriveKey(orgId: string): Buffer {
  // HKDF-derived per-org key from master FIELD_ENCRYPTION_KEY
  const master = Buffer.from(config.fieldEncryptionKey, 'hex');
  return createHmac('sha256', master).update(`org:${orgId}`).digest();
}

export function encryptField(plaintext: string, orgId: string): string {
  const key = deriveKey(orgId);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptField(ciphertext: string, orgId: string): string {
  const key = deriveKey(orgId);
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.slice(0, 12);
  const tag = buf.slice(12, 28);
  const encrypted = buf.slice(28);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

export function encryptPiiFields(data: Record<string, unknown>, piiFields: string[], orgId: string): { clean: Record<string, unknown>; encrypted: Record<string, string> } {
  const clean: Record<string, unknown> = { ...data };
  const encrypted: Record<string, string> = {};
  for (const field of piiFields) {
    if (field in clean && clean[field] !== undefined && clean[field] !== null) {
      encrypted[field] = encryptField(String(clean[field]), orgId);
      clean[field] = '[ENCRYPTED]';
    }
  }
  return { clean, encrypted };
}
