import express from 'express';
import cors from 'cors';
import { config } from './config';
import { connectMongo } from './db/mongo';
import { connectKafka } from './integrations/kafkaProducer';

import formsRouter from './routes/forms';
import submissionsRouter from './routes/submissions';

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'form-engine', port: config.port }));

app.use('/forms', formsRouter);
app.use('/forms/:id', submissionsRouter);

async function start() {
  await connectMongo();
  await connectKafka();
  app.listen(config.port, () => {
    console.log(`[form-engine] Running on port ${config.port}`);
  });
}

start().catch(console.error);
