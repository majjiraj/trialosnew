import { Pool } from 'pg';
import { config } from '../config';

export const pool = new Pool({ connectionString: config.databaseUrl });

export async function query(sql: string, params?: unknown[]) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}
