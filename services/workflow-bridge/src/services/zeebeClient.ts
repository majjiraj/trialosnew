import { Camunda8 } from '@camunda8/sdk';
import { config } from '../config';

let camunda: Camunda8;
let zeebeClient: ReturnType<Camunda8['getZeebeGrpcApiClient']>;
let available = false;

export async function initZeebe() {
  try {
    camunda = new Camunda8({
      ZEEBE_ADDRESS: config.zeebeAddress,
      ZEEBE_CLIENT_ID: undefined,
      ZEEBE_CLIENT_SECRET: undefined,
      CAMUNDA_OAUTH_URL: undefined,
      CAMUNDA_TASKLIST_BASE_URL: undefined,
      CAMUNDA_OPERATE_BASE_URL: undefined,
      CAMUNDA_OPTIMIZE_BASE_URL: undefined,
      CAMUNDA_MODELER_BASE_URL: undefined,
      // Disable TLS for self-managed Zeebe in dev (plaintext gRPC)
      CAMUNDA_SECURE_CONNECTION: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    zeebeClient = camunda.getZeebeGrpcApiClient();

    // Timeout topology check — Zeebe may not be ready yet and the SDK retries forever
    const topologyResult = await Promise.race([
      zeebeClient.topology(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Zeebe topology timeout after 5s')), 5000)),
    ]);
    console.log('[workflow-bridge] Zeebe connected, brokers:', (topologyResult as { brokers: unknown[] }).brokers.length);
    available = true;
  } catch (err) {
    console.warn('[workflow-bridge] Zeebe unavailable, workflow operations will degrade gracefully:', (err as Error).message);
  }
}

export function getZeebeClient() {
  return zeebeClient;
}

export function isZeebeAvailable() {
  return available;
}

export async function deployBpmn(bpmnXml: string, processId: string): Promise<{ deploymentKey: string | null }> {
  if (!available) return { deploymentKey: null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (zeebeClient as any).deployResource({ process: Buffer.from(bpmnXml), name: `${processId}.bpmn` });
  return { deploymentKey: String(result.key ?? result.deploymentKey ?? '') };
}

export async function createInstance(bpmnProcessId: string, variables: Record<string, unknown>): Promise<{ instanceKey: string | null }> {
  if (!available) return { instanceKey: null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await zeebeClient.createProcessInstance({ bpmnProcessId, variables: variables as any });
  return { instanceKey: String(result.processInstanceKey) };
}

export async function cancelInstance(instanceKey: string): Promise<void> {
  if (!available) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (zeebeClient as any).cancelProcessInstance(instanceKey);
}

export async function publishMessage(messageName: string, correlationKey: string, variables: Record<string, unknown>): Promise<void> {
  if (!available) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (zeebeClient as any).publishMessage({ messageName, correlationKey, variables, timeToLive: 60000 });
}
