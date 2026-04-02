import { Kafka } from 'kafkajs';
import { config } from '../config';
import { v4 as uuidv4 } from 'uuid';

const kafka = new Kafka({ clientId: 'workflow-bridge', brokers: config.kafkaBrokers });
const producer = kafka.producer();
let connected = false;

export async function connectKafka() {
  try {
    await producer.connect();
    connected = true;
    console.log('[workflow-bridge] Kafka producer connected');
  } catch (err) {
    console.warn('[workflow-bridge] Kafka unavailable:', err);
  }
}

export async function emitEvent(eventType: string, orgId: string, payload: Record<string, unknown>, studyId?: string, actorId?: string) {
  if (!connected) return;
  const message = { event_id: uuidv4(), event_type: eventType, org_id: orgId, study_id: studyId || null, actor_id: actorId || null, timestamp: new Date().toISOString(), payload };
  await producer.send({ topic: 'trialo.events.workflows', messages: [{ key: orgId, value: JSON.stringify(message) }] });
}
