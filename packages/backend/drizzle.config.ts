import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit runs this file standalone, outside the app's config loader, so it reads
 * `DATABASE_URL` from the environment directly rather than through `src/config.ts`.
 *
 * `pnpm db:generate` writes SQL into `src/db/migrations`. Nothing is applied until
 * `pnpm db:migrate` is run explicitly — no migration has been run against any database.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required to run drizzle-kit. See .env.example.');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
