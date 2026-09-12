/**
 * The persistence contract.
 *
 * These are the invariants the SQLite implementation puts in a `BEGIN IMMEDIATE`
 * transaction to guarantee, and they are asserted against the in-memory one because the
 * interface is what both promise. A fake that is easier to satisfy than the real thing tests
 * nothing, so `MemoryStore` implements the same clamping, the same idempotency and the same
 * ordering.
 *
 * `test/sqlite-store.test.ts` covers what is true only of the real engine — money above 2^53,
 * the pragmas, and the same bounds holding under concurrent allocations.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryStore } from '../src/db/memory-store.js';
import { seedId } from '../src/db/seed.js';
import { ratingService } from '../src/services/rating.js';
import { createHarness, type Harness } from './helpers.js';

let h: Harness;
let store: MemoryStore;

beforeEach(async () => {
  h = await createHarness();
  store = h.store;
});

afterEach(() => {
  h.restore();
});

describe('mandate capital', () => {
  const mandate = () => h.seeded.mandateIds['MND-06'] ?? '';

  it('cannot allocate past the unallocated balance', async () => {
    await expect(store.allocate(mandate(), 20_000_001n)).rejects.toMatchObject({
      code: 'insufficient_mandate_balance',
    });
  });

  it('marks a mandate exhausted when its last capital is spoken for', async () => {
    const after = await store.allocate(mandate(), 20_000_000n);
    expect(after.status).toBe('exhausted');

    // The edge back exists, or an unwind would strand the capital.
    const released = await store.release(mandate(), 5_000_000n);
    expect(released.status).toBe('active');
  });

  it('makes a withdrawal lose to an allocation, which is what firm means', async () => {
    await store.allocate(mandate(), 12_000_000n);

    await expect(
      store.withdrawFromMandate({ mandateId: mandate(), amount: 10_000_000n, at: new Date() }),
    ).rejects.toMatchObject({ code: 'insufficient_mandate_balance' });

    const { withdrawn } = await store.withdrawFromMandate({ mandateId: mandate(), at: new Date() });
    expect(withdrawn).toBe(8_000_000n);
  });

  it('clamps a release at zero rather than going negative', async () => {
    const after = await store.release(mandate(), 999_999_999n);
    expect(after.allocatedMinor).toBe(0n);
  });
});

describe('the uniqueness registry', () => {
  it('refuses a second instrument for the same receivable', async () => {
    const existing = await store.getInvoice(h.seeded.invoiceIds['INV-2046'] ?? '');

    await expect(
      store.insertInvoice({
        sellerId: h.seeded.sellerId,
        debtorId: h.seeded.debtorIds['DBT-PETRA'] ?? '',
        invoiceNumber: 'MF-2046',
        faceValue: 6_230_000n,
        currency: 'USD',
        issuedAt: new Date('2026-08-28T00:00:00.000Z'),
        dueAt: new Date('2026-12-04T00:00:00.000Z'),
        uniquenessHash: existing?.uniquenessHash ?? '',
      }),
    ).rejects.toMatchObject({ code: 'duplicate_receivable' });
  });
});

describe('exposure', () => {
  it('stops counting a position once its invoice has matured', async () => {
    const mandateId = h.seeded.mandateIds['MND-02'] ?? '';
    const before = (await store.debtorExposure([mandateId])).get(mandateId) ?? {};
    const calder = h.seeded.debtorIds['DBT-CALDER'] ?? '';
    expect(before[calder]).toBe(4_144_652n);

    await store.updateInvoice(h.seeded.invoiceIds['INV-2024'] ?? '', { status: 'matured' });

    const after = (await store.debtorExposure([mandateId])).get(mandateId) ?? {};
    expect(after[calder]).toBeUndefined();
  });

  it('returns an empty bucket for a mandate that holds nothing, not a missing key', async () => {
    const mandateId = h.seeded.mandateIds['MND-06'] ?? '';
    const exposure = await store.debtorExposure([mandateId]);
    expect(exposure.get(mandateId)).toEqual({});
  });
});

describe('the rating ledger', () => {
  const debtor = () => h.seeded.debtorIds['DBT-SABLE'] ?? '';

  it('moves a cold start onto the ladder and refreshes the stored grade', async () => {
    for (let i = 0; i < 4; i += 1) {
      await ratingService.recordOutcome({
        debtorId: debtor(),
        invoiceId: seedId(`SYNTH-${i}`),
        outcome: 'on_time',
        faceValue: 100_000n,
        at: new Date('2026-09-01T00:00:00.000Z'),
      });
    }

    const assessment = await ratingService.ratingFor(debtor());
    expect(assessment.rating).toBe('B');
    expect((await store.getDebtor(debtor()))?.rating).toBe('B');
  });

  it('cannot be moved twice by the same receivable', async () => {
    const input = {
      debtorId: debtor(),
      invoiceId: seedId('SYNTH-replay'),
      outcome: 'on_time' as const,
      faceValue: 100_000n,
      at: new Date('2026-09-01T00:00:00.000Z'),
    };

    await ratingService.recordOutcome(input);
    const replayed = await ratingService.recordOutcome(input);

    expect(replayed.record.settledOnTime).toBe(1);
    expect(replayed.score).toBe(1);
  });

  it('marks a default permanently, whatever the record before it', async () => {
    for (let i = 0; i < 9; i += 1) {
      await ratingService.recordOutcome({
        debtorId: debtor(),
        invoiceId: seedId(`SYNTH-good-${i}`),
        outcome: 'on_time',
        faceValue: 100_000n,
        at: new Date('2026-09-01T00:00:00.000Z'),
      });
    }
    expect((await ratingService.ratingFor(debtor())).rating).toBe('A');

    const marked = await ratingService.recordOutcome({
      debtorId: debtor(),
      invoiceId: seedId('SYNTH-bad'),
      outcome: 'default',
      faceValue: 100_000n,
      at: new Date('2026-09-02T00:00:00.000Z'),
    });

    expect(marked.rating).toBe('D');
    expect(marked.permanentlyMarked).toBe(true);
    // A defaulted face value is not credited as settled.
    expect(marked.record.settledFaceValue).toBe(900_000n);
  });

  it('reads a whole book of ratings in one pass, treating an unknown id as a cold start', async () => {
    const ids = [...Object.values(h.seeded.debtorIds), seedId('DBT-NOBODY')];
    const ratings = await ratingService.ratingsFor(ids);

    expect(ratings.size).toBe(ids.length);
    expect(ratings.get(seedId('DBT-NOBODY'))?.rating).toBe('UNRATED');
  });
});

describe('reading trades back', () => {
  const invoice = () => h.seeded.invoiceIds['INV-2033'] ?? '';

  it('scopes a read to one receivable, so maturity finds the current holder', async () => {
    const settled = await store.listTrades({ invoiceId: invoice(), status: 'settled', limit: 50 });

    expect(settled).toHaveLength(1);
    expect(settled[0]?.id).toBe(h.seeded.tradeIds['TRD-4417']);
    // Filtering a page of the whole book in memory finds this only while the book is small
    // enough to fit in that page; scoping the read is what makes it true on a busy one.
    expect(settled.every((t) => t.invoiceId === invoice())).toBe(true);
  });

  it('finds armed trades older than an instant, oldest first, and nothing settled', async () => {
    const seedTrade = await store.getTrade(h.seeded.tradeIds['TRD-4417'] ?? '');
    const base = seedTrade!.createdAt.getTime();

    const older = await store.insertTrade({
      ...seedTrade!,
      id: seedId('TRD-ARMED-OLD'),
      status: 'awaiting_payment',
      createdAt: new Date(base),
      settledAt: null,
    });
    const newer = await store.insertTrade({
      ...seedTrade!,
      id: seedId('TRD-ARMED-NEW'),
      status: 'preparing',
      createdAt: new Date(base + 60_000),
      settledAt: null,
    });
    await store.insertTrade({
      ...seedTrade!,
      id: seedId('TRD-ARMED-FRESH'),
      status: 'awaiting_payment',
      createdAt: new Date(base + 600_000),
      settledAt: null,
    });

    const stale = await store.listArmedTradesOlderThan(new Date(base + 120_000), 25);

    expect(stale.map((t) => t.id)).toEqual([older.id, newer.id]);
  });

  it('honours its limit, so one request cannot inherit the whole backlog', async () => {
    const seedTrade = await store.getTrade(h.seeded.tradeIds['TRD-4417'] ?? '');
    for (let i = 0; i < 5; i += 1) {
      await store.insertTrade({
        ...seedTrade!,
        id: seedId(`TRD-BACKLOG-${i}`),
        status: 'awaiting_payment',
        createdAt: new Date(seedTrade!.createdAt.getTime() + i * 1_000),
        settledAt: null,
      });
    }

    expect(await store.listArmedTradesOlderThan(new Date(), 2)).toHaveLength(2);
  });
});

describe('issuance job state', () => {
  it('survives as a row so the queue can be rebuilt after a restart', async () => {
    await store.saveIssuanceJob({
      invoiceId: h.seeded.invoiceIds['INV-2051'] ?? '',
      state: 'queued',
      attempts: 2,
      nextAttemptAt: new Date('2026-09-01T09:35:00.000Z'),
      lastError: 'receipt for transaction had status BUSY',
    });

    const unfinished = await store.listUnfinishedIssuanceJobs();
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0]?.attempts).toBe(2);
    expect(unfinished[0]?.lastError).toContain('BUSY');
  });
});

describe('indexer cursors', () => {
  it('persist, so a restart reads as "behind" rather than as "never polled"', async () => {
    await store.setCursor('arc-testnet', '81234');
    expect(await store.getCursor('arc-testnet')).toBe('81234');
    expect(await store.getCursor('nowhere')).toBeNull();
  });
});

/**
 * Party lookup and wallet recording, which both onboarding routes stand on.
 *
 * Two actors, one contract. `POST /v1/sellers` and `POST /v1/buyers` are idempotent on a
 * verified email and refuse to rebind a recorded address, and neither property lives in the
 * route — the route asks the store for a row by email and then asks it to fill a field. So
 * the guarantees are asserted here, on the seam, against **both** parties: a seller-only
 * assertion would let the buyer half drift, which is exactly how one fact maintained in two
 * places goes wrong in this codebase.
 */
describe('party lookup by email', () => {
  it('finds a seller however the address was capitalised or spaced', async () => {
    const created = await store.insertSeller({ name: 'Ardent', email: 'desk@ardent.example' });

    expect((await store.getSellerByEmail('  DESK@Ardent.Example '))?.id).toBe(created.id);
    expect(await store.getSellerByEmail('someone@ardent.example')).toBeNull();
  });

  it('finds a buyer however the address was capitalised or spaced', async () => {
    const created = await store.insertBuyer({ name: 'Ardent', email: 'desk@ardent.example' });

    expect((await store.getBuyerByEmail('  DESK@Ardent.Example '))?.id).toBe(created.id);
    expect(await store.getBuyerByEmail('someone@ardent.example')).toBeNull();
  });

  /* The two tables are separate identities, so one email can be both sides of the market. */
  it('does not let a seller row answer a buyer lookup', async () => {
    await store.insertSeller({ name: 'Ardent', email: 'desk@ardent.example' });

    expect(await store.getBuyerByEmail('desk@ardent.example')).toBeNull();
  });

  /**
   * The normalisation happens on the WRITE, and this is the pair that can tell.
   *
   * The two cases above insert an address that is already lowercase, so they pass whether a store
   * normalises the query, the row, both or only the write. That is how the two implementations
   * came to disagree unnoticed: `MemoryStore` lowercased both sides of its comparison and
   * `SqliteStore` lowercased only the query, and neither touched the value going in. A row written
   * `Desk@Ardent.Example` was therefore findable in one store and invisible in the other.
   *
   * Asserting the STORED spelling rather than only the lookup is what makes this a test of the
   * write. Under SQLite the stored value is what `sellers_email_key` and `buyers_email_key`
   * compare, so a store that only normalised queries would let one business arrive twice — and the
   * index, which is the backstop when two sign-ins race, cannot enforce a rule the values were not
   * written under.
   */
  it('stores a seller address lowercased, whatever the caller typed', async () => {
    const created = await store.insertSeller({ name: 'Ardent', email: '  Desk@Ardent.Example ' });

    expect(created.email).toBe('desk@ardent.example');
    expect((await store.getSellerByEmail('desk@ardent.example'))?.id).toBe(created.id);
    expect((await store.getSellerByEmail('DESK@ARDENT.EXAMPLE'))?.id).toBe(created.id);
  });

  it('stores a buyer address lowercased, whatever the caller typed', async () => {
    const created = await store.insertBuyer({ name: 'Ardent', email: '  Desk@Ardent.Example ' });

    expect(created.email).toBe('desk@ardent.example');
    expect((await store.getBuyerByEmail('desk@ardent.example'))?.id).toBe(created.id);
    expect((await store.getBuyerByEmail('DESK@ARDENT.EXAMPLE'))?.id).toBe(created.id);
  });

  /**
   * A customer is the third party keyed on an address, and `insertDebtor` had the same gap.
   *
   * `upsertDebtor` normalises and always did, so a debtor inserted with capitals is one whose
   * rating accumulator a later upsert walks straight past — and that accumulator is what the whole
   * curve prices off. Included here rather than left to the two identity tables because a rule
   * maintained for two of three tables is the split this repo keeps paying for.
   */
  it('stores a customer address lowercased too, so an upsert finds it again', async () => {
    const created = await store.insertDebtor({ name: 'Northwind', email: 'AP@Northwind.Example' });

    expect(created.email).toBe('ap@northwind.example');
    const upserted = await store.upsertDebtor({
      name: 'Northwind Ltd',
      email: 'ap@northwind.example',
    });
    expect(upserted.id).toBe(created.id);
  });
});

describe('recording a wallet', () => {
  it('fills a buyer address and leaves the other field alone', async () => {
    const created = await store.insertBuyer({ name: 'Ardent', email: 'desk@ardent.example' });
    expect(created.arcAddress).toBeNull();

    const filled = await store.updateBuyerWallet(created.id, { arcAddress: '0xabc' });

    expect(filled.arcAddress).toBe('0xabc');
    expect(filled.hederaAccountId).toBeNull();
  });

  /*
   * An absent key and a `null` one are different instructions — "this sign-in said nothing
   * about a Hedera account" against "clear it" — and collapsing them would wipe a recorded
   * address every time the other field was the one being filled.
   */
  it('skips a key the caller did not supply rather than nulling it', async () => {
    const created = await store.insertBuyer({
      name: 'Ardent',
      email: 'desk@ardent.example',
      hederaAccountId: '0.0.9001',
    });

    const after = await store.updateBuyerWallet(created.id, { arcAddress: '0xabc' });

    expect(after.hederaAccountId).toBe('0.0.9001');
  });

  it('writes an explicit null, which is not the same as omitting the key', async () => {
    const created = await store.insertBuyer({
      name: 'Ardent',
      email: 'desk@ardent.example',
      hederaAccountId: '0.0.9001',
    });

    const after = await store.updateBuyerWallet(created.id, { hederaAccountId: null });

    expect(after.hederaAccountId).toBeNull();
  });

  it('refuses a buyer that does not exist rather than inserting one', async () => {
    await expect(
      store.updateBuyerWallet(seedId('no-such-buyer'), { arcAddress: '0xabc' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses a seller that does not exist, the same way', async () => {
    await expect(
      store.updateSellerWallet(seedId('no-such-seller'), { arcAddress: '0xabc' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  /*
   * The in-memory store hands back copies. Without that a caller mutating a returned row
   * would edit the table, and every test in this file that reads a row after a write would
   * pass for the wrong reason.
   */
  it('hands back a copy rather than the stored row', async () => {
    const created = await store.insertBuyer({ name: 'Ardent', email: 'desk@ardent.example' });
    const returned = await store.updateBuyerWallet(created.id, { arcAddress: '0xabc' });

    returned.arcAddress = '0xdeadbeef';

    expect((await store.getBuyer(created.id))?.arcAddress).toBe('0xabc');
  });
});
