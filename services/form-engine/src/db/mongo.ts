import { MongoClient, Db } from 'mongodb';
import { config } from '../config';

let client: MongoClient;
let db: Db;

export async function connectMongo(): Promise<Db> {
  if (db) return db;
  client = new MongoClient(config.mongoUrl);
  await client.connect();
  db = client.db('trialo');
  console.log('[form-engine] MongoDB connected');
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error('MongoDB not connected');
  return db;
}
