/**
 * Database handle. `better-sqlite3` under Drizzle.
 *
 * A file on disk cannot be down, cannot refuse a connection and cannot be a container that
 * did not start. That is the whole reason this is SQLite: the persistence layer is not a
 * thing that can fail on the day, and `DATABASE_URL` is a path rather than a URL.
 *
 * Lazily constructed so that importing a service does not open the file — the health
 * route and the unit tests both need the module graph without a database.
 *
 * ## The two pragmas are not optional
 *
 * - `foreign_keys = ON`. SQLite ships with foreign keys **off**, per connection, and a
 *   schema full of `REFERENCES` clauses that are never enforced looks exactly like one that
 *   is. Every FK in `schema.ts` depends on this line.
 * - `journal_mode = WAL`. Readers stop blocking the writer, which is what lets `/health`
 *   answer while a settlement transaction is open. It is persistent in the file, but it is
 *   set on every open so a database restored from a copy still gets it.
 *
 * `busy_timeout` is set alongside them: SQLite serialises writers, and the correct response
 * to a second writer is to wait for the first rather than to fail the request.
 */

import BetterSqlite3 from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getConfig } from '../config.js';
import * as schema from './schema.js';

export type Database = BetterSQLite3Database<typeof schema>;

/** How long a blocked writer waits for the open one before giving up. */
const BUSY_TIMEOUT_MS = 5_000;

let handle: BetterSqlite3.Database | undefined;
let database: Database | undefined;

/**
 * Opens a SQLite connection with the pragmas this schema assumes.
 *
 * Exported so tests can build a throwaway database (`:memory:` or a temp file) without
 * `loadConfig()` and without touching the process-wide handle below.
 */
export function openSqlite(path: string): BetterSqlite3.Database {
  if (path !== ':memory:' && !path.startsWith('file:')) {
    // A missing parent directory is an ENOENT that reads as "unable to open database file",
    // which is a bad way to learn that `./data` was never created.
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new BetterSqlite3(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

/** A Drizzle handle over an already-open connection. */
export const wrapSqlite = (client: BetterSqlite3.Database): Database => drizzle(client, { schema });

export function getDb(): Database {
  if (!database) {
    const { env } = getConfig();
    handle = openSqlite(env.DATABASE_URL);
    database = wrapSqlite(handle);
  }
  return database;
}

/** Cheap liveness probe for `GET /health`. Never throws. */
export function pingDb(): Promise<{ ok: boolean; latencyMs: number; error: string | null }> {
  const startedAt = performance.now();
  try {
    if (!handle) getDb();
    const client = handle;
    if (!client) throw new Error('sqlite client was not initialised');
    client.prepare('select 1').get();
    return Promise.resolve({
      ok: true,
      latencyMs: Math.round(performance.now() - startedAt),
      error: null,
    });
  } catch (err) {
    return Promise.resolve({
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function closeDb(): Promise<void> {
  handle?.close();
  handle = undefined;
  database = undefined;
  return Promise.resolve();
}

export { schema };
