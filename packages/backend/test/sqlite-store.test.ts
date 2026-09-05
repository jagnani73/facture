/**
 * The SQLite store, against a real database file.
 *
 * `test/store.test.ts` asserts the persistence *contract* against `MemoryStore`, which is
 * the right place for it: the contract is what both implementations promise. This file
 * asserts the things that are only true because the engine underneath is SQLite, and each
 * one is a trap that fails silently if it is got wrong:
 *
 * - **money survives above 2^53**, because the column is TEXT and never a JS `number`;
 * - **foreign keys actually reject**, because SQLite disables them per connection by
 *   default and an unenforced `REFERENCES` clause looks exactly like an enforced one;
 * - **an allocation stays inside the unallocated balance** when several arrive at once,
 *   without the `SELECT … FOR UPDATE` the Postgres implementation used.
 *
 * Every case runs the checked-in migration SQL against a fresh file on disk — not a schema
 * pushed from `schema.ts` — so a migration that does not apply fails here rather than on
 * the day.
 */

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { openSqlite, wrapSqlite } from '../src/db/index.js';
import { seedId, seedStore, type SeedResult } from '../src/db/seed.js';
import { createSqliteStore, type SqliteStore } from '../src/db/sqlite-store.js';

const MIGRATIONS = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

let dir: string;
let client: BetterSqlite3.Database;
let store: SqliteStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'facture-sqlite-'));
  client = openSqlite(join(dir, 'facture.db'));
  migrate(wrapSqlite(client), { migrationsFolder: MIGRATIONS });
  store = createSqliteStore(wrapSqlite(client));
});

afterEach(() => {
  client.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The SQLite extended result code behind a rejection.
 *
 * Drizzle wraps driver errors in `DrizzleQueryError`, whose message is the failed SQL rather
 * than the constraint. Matching on the message would pass for the wrong reason, so the test
 * asserts the code SQLite itself raised.
 */
function driverCode(err: unknown): string | null {
  let cursor: unknown = err;
  for (let depth = 0; depth < 8 && typeof cursor === 'object' && cursor !== null; depth += 1) {
    const { code, cause } = cursor as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && code.startsWith('SQLITE_')) return code;
    if (cause === undefined || cause === cursor) return null;
    cursor = cause;
  }
  return null;
}

async function driverCodeOf(run: Promise<unknown>): Promise<string | null> {
  try {
    await run;
    return null;
  } catch (err) {
    return driverCode(err);
  }
}

const appCodeOf = (err: unknown): unknown =>
  typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;

/** Enough of a party graph to hang an invoice off. */
async function parties(): Promise<{ sellerId: string; debtorId: string }> {
  const seller = await store.insertSeller({ name: 'Meridian', email: 'a@meridian.test' });
  const debtor = await store.insertDebtor({ name: 'Petra', email: 'b@petra.test' });
  return { sellerId: seller.id, debtorId: debtor.id };
}

const invoiceRow = (
  ids: { sellerId: string; debtorId: string },
  faceValue: bigint,
  suffix = '1',
) => ({
  sellerId: ids.sellerId,
  debtorId: ids.debtorId,
  invoiceNumber: `INV-${suffix}`,
  faceValue,
  currency: 'USD',
  issuedAt: new Date('2026-08-01T00:00:00.000Z'),
  dueAt: new Date('2026-12-04T00:00:00.000Z'),
  uniquenessHash: `0x${suffix.padStart(64, '0')}`,
});

describe('money is TEXT, not INTEGER', () => {
  it('round-trips a face value above 2^53 without losing a unit', async () => {
    const ids = await parties();
    // 2^53 + 1 is the first integer a JS `number` cannot represent. If this column were
    // INTEGER, better-sqlite3 would hand it back as 9007199254740992 and nothing would say so.
    const face = 9_007_199_254_740_993n;

    const written = await store.insertInvoice(invoiceRow(ids, face));
    expect(written.faceValue).toBe(face);

    const read = await store.getInvoice(written.id);
    expect(read?.faceValue).toBe(face);
    // The rounded value a `number` column would have produced, spelled out.
    expect(read?.faceValue).not.toBe(BigInt(Number(face)));
  });

  it('round-trips a value wider than int64, which INTEGER could not hold at all', async () => {
    const ids = await parties();
    const face = 123_456_789_012_345_678_901_234_567_890n;

    const written = await store.insertInvoice(invoiceRow(ids, face));
    expect((await store.getInvoice(written.id))?.faceValue).toBe(face);
  });

  it('stores the amount with TEXT storage class, so SQLite never rounds it', async () => {
    const ids = await parties();
    await store.insertInvoice(invoiceRow(ids, 9_007_199_254_740_993n));

    const probe = client
      .prepare('select typeof(face_value) as kind, face_value as raw from invoices')
      .get() as { kind: string; raw: string };

    expect(probe.kind).toBe('text');
    expect(probe.raw).toBe('9007199254740993');
  });

  it('keeps the accumulator exact when a huge settlement is recorded', async () => {
    const ids = await parties();
    const face = 9_007_199_254_740_993n;
    const invoice = await store.insertInvoice(invoiceRow(ids, face));

    const first = await store.recordOutcome({
      debtorId: ids.debtorId,
      invoiceId: invoice.id,
      outcome: 'on_time',
      faceValue: face,
      at: new Date('2026-12-04T00:00:00.000Z'),
    });
    expect(first.alreadyRecorded).toBe(false);
    expect(first.debtor.settledFaceValue).toBe(face);

    // A replayed maturity may not tighten a rating, or move the money, twice.
    const replay = await store.recordOutcome({
      debtorId: ids.debtorId,
      invoiceId: invoice.id,
      outcome: 'on_time',
      faceValue: face,
      at: new Date('2026-12-05T00:00:00.000Z'),
    });
    expect(replay.alreadyRecorded).toBe(true);
    expect(replay.debtor.settledFaceValue).toBe(face);
    expect(replay.debtor.settledOnTime).toBe(1);
  });
});

describe('the foreign_keys pragma is actually on', () => {
  it('reports it on the connection', () => {
    expect(client.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('refuses an invoice whose seller does not exist', async () => {
    const { debtorId } = await parties();
    const code = await driverCodeOf(
      store.insertInvoice(invoiceRow({ sellerId: seedId('nobody'), debtorId }, 1_000n)),
    );
    expect(code).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
  });

  it('refuses a settlement outcome against an invoice that was never listed', async () => {
    const { debtorId } = await parties();
    const code = await driverCodeOf(
      store.recordOutcome({
        debtorId,
        invoiceId: seedId('no-such-invoice'),
        outcome: 'on_time',
        faceValue: 1_000n,
        at: new Date(),
      }),
    );
    expect(code).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
  });
});

describe('the WAL pragma is set', () => {
  it('reports wal on the connection', () => {
    expect(client.pragma('journal_mode', { simple: true })).toBe('wal');
  });
});

describe('allocation is bounded without a row lock', () => {
  /** A funded mandate with a known unallocated balance. */
  async function fundedMandate(funded: bigint): Promise<string> {
    const buyer = await store.insertBuyer({ name: 'Ardent', email: 'c@ardent.test' });
    const mandate = await store.insertMandate({
      buyerId: buyer.id,
      ratingFloor: 'C',
      maxTenorDays: 120,
      annualisedYieldBps: 1_400,
      currency: 'USD',
      exposureLimitMinor: funded,
    });
    await store.fundMandate({
      mandateId: mandate.id,
      amount: funded,
      escrowRef: 'escrow-1',
      at: new Date(),
    });
    return mandate.id;
  }

  it('never lets concurrent allocations exceed the unallocated balance', async () => {
    const funded = 10_000_000n;
    const id = await fundedMandate(funded);

    // Ten claims of 2,000,000 against 10,000,000: at most five may win. They are launched
    // together; SQLite serialises the writers, which is exactly why no row lock is needed.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => store.allocate(id, 2_000_000n)),
    );

    const won = results.filter((r) => r.status === 'fulfilled').length;
    const lost = results.filter(
      (r) => r.status === 'rejected' && appCodeOf(r.reason) === 'insufficient_mandate_balance',
    ).length;
    expect(won).toBe(5);
    expect(lost).toBe(5);

    const after = await store.getMandate(id);
    expect(after?.allocatedMinor).toBe(funded);
    expect(after?.allocatedMinor).toBeLessThanOrEqual(after?.fundedMinor ?? 0n);
    expect(after?.status).toBe('exhausted');
  });

  it('makes a withdrawal racing an allocation lose to the allocation', async () => {
    const id = await fundedMandate(10_000_000n);

    const [alloc, withdraw] = await Promise.allSettled([
      store.allocate(id, 8_000_000n),
      store.withdrawFromMandate({ mandateId: id, amount: 6_000_000n, at: new Date() }),
    ]);

    expect(alloc.status).toBe('fulfilled');
    expect(withdraw.status).toBe('rejected');

    const after = await store.getMandate(id);
    // Committed capital is not the buyer's to pull: funded is untouched, allocated stands.
    expect(after?.fundedMinor).toBe(10_000_000n);
    expect(after?.allocatedMinor).toBe(8_000_000n);
  });

  it('releases capacity back and clamps at zero', async () => {
    const id = await fundedMandate(10_000_000n);
    await store.allocate(id, 10_000_000n);

    const released = await store.release(id, 999_999_999n);
    expect(released.allocatedMinor).toBe(0n);
    expect(released.status).toBe('active');
  });
});

describe('the expiry read, in SQL', () => {
  /*
   * `created_at` is an epoch-ms INTEGER and `status` is TEXT with no enum behind it, so
   * this read is a numeric comparison and an `IN` list rather than anything the dialect
   * checks. Both are easy to get quietly wrong — a string comparison on the instant would
   * still return rows, just the wrong ones.
   */
  let seeded: SeedResult;

  beforeEach(async () => {
    seeded = await seedStore(store);
  });

  it('returns only armed trades, oldest first, from before the cutoff', async () => {
    const settled = await store.getTrade(seeded.tradeIds['TRD-4417'] ?? '');
    const base = settled!.createdAt.getTime();

    await store.insertTrade({
      ...settled!,
      id: seedId('TRD-SQL-OLD'),
      status: 'awaiting_payment',
      createdAt: new Date(base - 60_000),
      settledAt: null,
    });
    await store.insertTrade({
      ...settled!,
      id: seedId('TRD-SQL-FRESH'),
      status: 'awaiting_payment',
      createdAt: new Date(base + 3_600_000),
      settledAt: null,
    });

    const stale = await store.listArmedTradesOlderThan(new Date(base), 25);

    expect(stale.map((t) => t.id)).toEqual([seedId('TRD-SQL-OLD')]);
  });

  it('scopes a trade read to one receivable', async () => {
    const forInvoice = await store.listTrades({
      invoiceId: seeded.invoiceIds['INV-2033'] ?? '',
      status: 'settled',
      limit: 50,
    });

    expect(forInvoice.map((t) => t.id)).toEqual([seeded.tradeIds['TRD-4417']]);
  });

  it('round-trips the position size through the TEXT money column', async () => {
    const settled = await store.getTrade(seeded.tradeIds['TRD-4417'] ?? '');

    // Face-value-many units, as issuance mints them — and a bigint, never a number.
    expect(settled?.unitsMinor).toBe(9_500_000n);
    expect(typeof settled?.unitsMinor).toBe('bigint');
  });
});

describe('the migration and the demo book applied to a file', () => {
  let seeded: SeedResult;

  beforeEach(async () => {
    seeded = await seedStore(store);
  });

  it('creates every table the schema declares', () => {
    const tables = client
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' " +
          "and name <> '__drizzle_migrations' order by name",
      )
      .all() as { name: string }[];

    expect(tables.map((t) => t.name)).toEqual([
      'buyers',
      'confirmation_requests',
      'debtors',
      'indexer_cursors',
      'invoices',
      'issuance_jobs',
      'mandates',
      'quotes',
      'refusal_receipts',
      'sellers',
      'settlement_outcomes',
      'trades',
    ]);
  });

  it('holds the two invoices the demo turns on', async () => {
    const clears = await store.getInvoice(seeded.invoiceIds['INV-2046'] ?? '');
    const refused = await store.getInvoice(seeded.invoiceIds['INV-2047'] ?? '');

    expect(clears?.invoiceNumber).toBe('MF-2046');
    expect(clears?.faceValue).toBe(6_230_000n);
    expect(refused?.invoiceNumber).toBe('MF-2047');
    expect(refused?.faceValue).toBe(2_750_000n);
  });

  it('keeps instants as instants across the epoch-ms column', async () => {
    const invoice = await store.getInvoice(seeded.invoiceIds['INV-2046'] ?? '');
    expect(invoice?.dueAt).toBeInstanceOf(Date);
    expect(invoice?.dueAt.toISOString()).toBe('2026-12-04T00:00:00.000Z');
  });

  it('aggregates per-debtor exposure in bigint, not through SQL sum()', async () => {
    const mandateIds = Object.values(seeded.mandateIds);
    const exposure = await store.debtorExposure(mandateIds);

    expect(exposure.size).toBe(mandateIds.length);
    for (const bucket of exposure.values()) {
      for (const committed of Object.values(bucket)) {
        expect(typeof committed).toBe('bigint');
      }
    }

    // Every committed figure has to be backed by an open trade on that mandate.
    const total = [...exposure.values()]
      .flatMap((bucket) => Object.values(bucket))
      .reduce((acc, v) => acc + v, 0n);
    expect(total).toBeGreaterThan(0n);
  });

  it('rejects the same receivable listed a second time', async () => {
    const existing = await store.getInvoice(seeded.invoiceIds['INV-2046'] ?? '');
    if (!existing) throw new Error('seed did not produce MF-2046');

    await expect(
      store.insertInvoice({
        sellerId: existing.sellerId,
        debtorId: existing.debtorId,
        invoiceNumber: existing.invoiceNumber,
        faceValue: existing.faceValue,
        currency: existing.currency,
        issuedAt: existing.issuedAt,
        dueAt: existing.dueAt,
        uniquenessHash: existing.uniquenessHash,
      }),
    ).rejects.toMatchObject({ code: 'duplicate_receivable' });
  });

  it('pages the book with a keyset cursor', async () => {
    const first = await store.listInvoices({ sellerId: seeded.sellerId, limit: 3 });
    expect(first.rows).toHaveLength(3);
    expect(first.nextCursor).toBeDefined();

    const second = await store.listInvoices({
      sellerId: seeded.sellerId,
      limit: 3,
      cursor: first.nextCursor,
    });
    const overlap = second.rows.filter((row) => first.rows.some((r) => r.id === row.id));
    expect(overlap).toHaveLength(0);
  });
});
