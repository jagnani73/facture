/**
 * Database handle. postgres.js under Drizzle.
 *
 * Lazily constructed so that importing a service does not open a socket — the health
 * route and the unit tests both need the module graph without a live Postgres.
 */

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getConfig } from '../config.js';
import * as schema from './schema.js';

export type Database = PostgresJsDatabase<typeof schema>;

let sql: ReturnType<typeof postgres> | undefined;
let database: Database | undefined;

export function getDb(): Database {
  if (!database) {
    const { env } = getConfig();
    sql = postgres(env.DATABASE_URL, {
      max: env.DATABASE_POOL_MAX,
      // bigint columns come back as JS bigint, matching the schema's `mode: 'bigint'`.
      transform: { undefined: null },
      onnotice: () => {},
    });
    database = drizzle(sql, { schema });
  }
  return database;
}

/** Cheap liveness probe for `GET /health`. Never throws. */
export async function pingDb(): Promise<{ ok: boolean; latencyMs: number; error: string | null }> {
  const startedAt = performance.now();
  try {
    if (!sql) getDb();
    const client = sql;
    if (!client) throw new Error('postgres client was not initialised');
    await client`select 1`;
    return { ok: true, latencyMs: Math.round(performance.now() - startedAt), error: null };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function closeDb(): Promise<void> {
  await sql?.end({ timeout: 5 });
  sql = undefined;
  database = undefined;
}

export { schema };
