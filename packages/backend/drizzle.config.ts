import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit runs this file standalone, outside the app's config loader, so it reads
 * `DATABASE_URL` from the environment directly rather than through `src/config.ts`.
 *
 * `DATABASE_URL` is a SQLite file path, not a connection URL — see `src/db/index.ts` for
 * why the persistence layer is a file. `pnpm db:generate` writes SQL into
 * `src/db/migrations`; nothing is applied until `pnpm db:migrate` is run explicitly.
 *
 * `db:migrate` opens the file with drizzle-kit's own connection, which does NOT set
 * `foreign_keys = ON`. That is fine and deliberate: the pragma governs enforcement at write
 * time, not the DDL, and the app's own connection sets it on every open.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required to run drizzle-kit. See .env.example.');
}

/*
 * better-sqlite3 will not create a missing parent directory, and `data/` is gitignored —
 * so on a fresh clone `db:migrate` would fail with "Cannot open database because the
 * directory does not exist" before the app had ever run. The app's own loader already does
 * this in `src/db/index.ts`; drizzle-kit runs standalone and never reaches it.
 */
mkdirSync(dirname(url), { recursive: true });

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
