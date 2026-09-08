import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { config } from '../config.js';
import * as schema from './schema.js';

let _sql = null;
let _db = null;

/** Lazy singleton — the API still boots (AI proxy only) if the DB is absent. */
export function getDb() {
  if (!_db) {
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL is not set — account/project features are disabled');
    }
    _sql = postgres(config.databaseUrl, { max: 8, idle_timeout: 30 });
    _db = drizzle(_sql, { schema });
  }
  return _db;
}

export function getSql() {
  getDb();
  return _sql;
}

export const dbEnabled = () => !!config.databaseUrl;

export { schema };
