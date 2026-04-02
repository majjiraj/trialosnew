import express from 'express';
import cors from 'cors';
import { config } from './config';
import { connectKafka } from './integrations/kafkaProducer';

import appsRouter from './routes/apps';
import versionsRouter from './routes/versions';
import lifecycleRouter from './routes/lifecycle';
import installsRouter from './routes/installs';
import signaturesRouter from './routes/signatures';
import catalogRouter from './routes/catalog';

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'app-composer', port: config.port }));

// App CRUD + lifecycle
app.use('/apps', appsRouter);
app.use('/apps/:id', versionsRouter);
app.use('/apps/:id', lifecycleRouter);
app.use('/apps/:id', signaturesRouter);
app.use('/apps/:id', installsRouter);

// Install management (non-nested)
app.use('/', installsRouter);

// Catalog
app.use('/', catalogRouter);

async function start() {
  await connectKafka();
  app.listen(config.port, () => {
    console.log(`[app-composer] Running on port ${config.port}`);
  });
}

start().catch(console.error);
