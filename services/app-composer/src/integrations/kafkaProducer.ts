import { Kafka } from 'kafkajs';
import { config } from '../config';
import { v4 as uuidv4 } from 'uuid';

const kafka = new Kafka({ clientId: 'app-composer', brokers: config.kafkaBrokers });
const producer = kafka.producer();
let connected = false;

export async function connectKafka() {
  try {
    await producer.connect();
    connected = true;
    console.log('[app-composer] Kafka producer connected');
  } catch (err) {
    console.warn('[app-composer] Kafka unavailable, events will be skipped:', err);
  }
}

export async function emitEvent(eventType: string, orgId: string, payload: Record<string, unknown>, studyId?: string, actorId?: string) {
  if (!connected) return;
  const topic = eventType.startsWith('workflow') ? 'trialo.events.workflows'
              : eventType.startsWith('form')     ? 'trialo.events.forms'
              : 'trialo.events.apps';
  const message = {
    event_id: uuidv4(),
    event_type: eventType,
    org_id: orgId,
    study_id: studyId || null,
    actor_id: actorId || null,
    timestamp: new Date().toISOString(),
    payload,
  };
  await producer.send({ topic, messages: [{ key: orgId, value: JSON.stringify(message) }] });
}
