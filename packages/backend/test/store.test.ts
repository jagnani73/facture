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
