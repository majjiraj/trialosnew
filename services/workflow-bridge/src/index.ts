import express from 'express';
import cors from 'cors';
import { config } from './config';
import { initZeebe, getZeebeClient, isZeebeAvailable } from './services/zeebeClient';
import { connectKafka } from './integrations/kafkaProducer';
import { runAgentForJob, AgentRunJobVariables, AgentRunJobHeaders } from './workers/agentRunWorker';
import { sendNotificationForJob, NotificationJobVariables } from './workers/notificationWorker';
import { createFormTask, FormTaskJobVariables, FormTaskJobHeaders } from './workers/formTaskWorker';
import { checkESignature } from './workers/signatureWorker';

import deploymentsRouter from './routes/deployments';
import instancesRouter from './routes/instances';
import tasksRouter from './routes/tasks';
import messagesRouter from './routes/messages';
import templatesRouter from './routes/templates';

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'workflow-bridge', port: config.port, zeebe: isZeebeAvailable() }));

app.use('/deployments', deploymentsRouter);
app.use('/instances', instancesRouter);
app.use('/tasks', tasksRouter);
app.use('/messages', messagesRouter);
app.use('/templates', templatesRouter);

async function registerJobWorkers() {
  if (!isZeebeAvailable()) {
    console.log('[workflow-bridge] Zeebe not available, skipping job worker registration');
    return;
  }
  const zeebe = getZeebeClient();

  // Worker: trialo:agent-run
  zeebe.createWorker({
    taskType: 'trialo:agent-run',
    taskHandler: async (job) => {
      try {
        const variables = job.variables as AgentRunJobVariables;
        const headers = job.customHeaders as AgentRunJobHeaders;
        const outputVars = await runAgentForJob(job.key, variables, headers, variables.instance_id);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return job.complete(outputVars as any);
      } catch (err) {
        console.error('[agentRunWorker] Job failed:', err);
        return job.fail({ errorMessage: String(err), retries: job.retries - 1 });
      }
    },
    maxJobsToActivate: 5,
    timeout: 300000, // 5 minutes
  });

  // Worker: trialo:send-notification
  zeebe.createWorker({
    taskType: 'trialo:send-notification',
    taskHandler: async (job) => {
      try {
        const outputVars = await sendNotificationForJob(job.variables as NotificationJobVariables);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return job.complete(outputVars as any);
      } catch (err) {
        return job.fail({ errorMessage: String(err), retries: job.retries - 1 });
      }
    },
    maxJobsToActivate: 10,
    timeout: 30000,
  });

  // Worker: trialo:require-esig
  zeebe.createWorker({
    taskType: 'trialo:require-esig',
    taskHandler: async (job) => {
      const vars = job.variables as { org_id: string; task_id?: string };
      if (!vars.task_id) return job.fail({ errorMessage: 'task_id required for esig check', retries: 0 });
      const hasSig = await checkESignature(vars.task_id, vars.org_id);
      if (!hasSig) {
        // Requeue — front-end must collect e-signature before completing
        return job.fail({ errorMessage: 'E-signature required', retries: job.retries });
      }
      return job.complete({ esig_verified: true });
    },
    maxJobsToActivate: 10,
    timeout: 30000,
  });

  // Worker: trialo:user-task (form task assignment)
  zeebe.createWorker({
    taskType: 'trialo:user-task',
    taskHandler: async (job) => {
      try {
        const variables = job.variables as FormTaskJobVariables;
        const headers = job.customHeaders as FormTaskJobHeaders;
        const taskId = await createFormTask(job.key, variables, headers, job.elementId || '', (job as unknown as { elementName?: string }).elementName || '');
        // Complete the Zeebe job immediately so the process advances; tasks are tracked in workflow_tasks.
        // task.complete route updates the DB only (zeebe job already done here).
        return job.complete({ workflow_task_id: taskId });
      } catch (err) {
        return job.fail({ errorMessage: String(err), retries: job.retries - 1 });
      }
    },
    maxJobsToActivate: 20,
    timeout: 86400000, // 24 hours
  });

  console.log('[workflow-bridge] Job workers registered: trialo:agent-run, trialo:send-notification, trialo:require-esig, trialo:user-task');
}

async function start() {
  await initZeebe();
  await connectKafka();
  await registerJobWorkers();
  app.listen(config.port, () => {
    console.log(`[workflow-bridge] Running on port ${config.port}`);
  });
}

start().catch(console.error);
