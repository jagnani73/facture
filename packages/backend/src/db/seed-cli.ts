/**
 * `pnpm db:seed` — fill a Postgres database with the demo book.
 *
 * Separate from `seed.ts` so that importing the dataset does not open a connection: the
 * tests seed a `MemoryStore` from the same module, and a seed script that connected on
 * import would drag Postgres into every unit test.
 *
 * Assumes the migrations in `src/db/migrations` have been applied (`pnpm db:migrate`).
 * Re-running it against an already-seeded database will fail on the uniqueness index,
 * which is the correct outcome: the ids are deterministic, so a second run is a duplicate
 * rather than a refresh.
 */

import { closeDb, getDb } from './index.js';
import { createPgStore } from './pg-store.js';
import { RATING_NOTE, seedStore } from './seed.js';
import { loadConfig } from '../config.js';

async function main(): Promise<void> {
  loadConfig();
  const result = await seedStore(createPgStore(getDb()));

  process.stdout.write(
    `${JSON.stringify({ seeded: result.counts, note: RATING_NOTE }, null, 2)}\n`,
  );
  process.stdout.write('\nThe two invoices the demo turns on:\n');
  process.stdout.write(`  MF-2046  ${result.invoiceIds['INV-2046'] ?? '?'}  clears at 18.50%\n`);
  process.stdout.write(
    `  MF-2047  ${result.invoiceIds['INV-2047'] ?? '?'}  refused by every mandate\n`,
  );
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`seed failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
