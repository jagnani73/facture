/**
 * Settlement, beyond the happy path the route tests already cover.
 *
 * Three things here are load-bearing rather than incidental:
 *
 * - **Maturity pays whoever holds the token now**, not whoever bought it first. Without
 *   that the paper cannot legitimately change hands, because a second buyer would have no
 *   way to be paid — so it is what makes this a secondary market at all.
 * - **A half-settled trade is reported, not swallowed.** Cash gone and security not
 *   delivered is the one genuinely bad state, and it must not be unwound: releasing a hold
 *   against a payment that actually happened turns a reconcilable state into a lost one.
 * - **Issuance state reaches storage**, so the book can stop showing an invoice as being
 *   added once its instrument exists.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKET_NOW_ISO, seedId } from '../src/db/seed.js';
import { createStoreIssuanceSink, IssuanceQueue } from '../src/services/issuance.js';
import { settlementService } from '../src/services/settlement.js';
import { call, createHarness, type Harness } from './helpers.js';

let h: Harness;

/* Same reason as routes.test.ts: a quote lives five minutes and the route checks expiry
 * against the real clock, so an unfrozen suite passes only inside that window. */
beforeEach(async () => {
  // Fake ONLY Date. The issuance queue backs off with real setTimeout, and faking timers
  // wholesale leaves it never firing.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(MARKET_NOW_ISO));
  h = await createHarness();
});

afterEach(() => {
  vi.useRealTimers();
  h.restore();
});

const asOf = `?asOf=${encodeURIComponent(MARKET_NOW_ISO)}`;

describe('maturity', () => {
  it('routes to the current holder and marks the invoice matured', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2033'] ?? '';

    const result = await settlementService.settleAtMaturity(invoiceId);

    expect(result.tradeId).toBe(h.seeded.tradeIds['TRD-4417']);
    expect(result.assetLeg.state).toBe('settled');
    // Face value, payable to whoever holds the token now.
    expect(result.cashLeg.amountMinor).toBe('9500000');
    expect((await h.store.getInvoice(invoiceId))?.status).toBe('matured');
  });

  it('reports the cash leg as pending, because no debtor payment rail exists here', async () => {
    const result = await settlementService.settleAtMaturity(h.seeded.invoiceIds['INV-2033'] ?? '');

    expect(result.cashLeg.state).toBe('pending');
    expect(result.cashLeg.transaction).toBeNull();
    expect(result.cashLeg.explorerUrl).toBeNull();
  });

  it('gives the capital back so an exhausted mandate can quote again', async () => {
    const mandateId = h.seeded.mandateIds['MND-01'] ?? '';
    const before = await h.store.getMandate(mandateId);

    await settlementService.settleAtMaturity(h.seeded.invoiceIds['INV-2033'] ?? '');

    const after = await h.store.getMandate(mandateId);
    expect(before!.allocatedMinor - after!.allocatedMinor).toBe(9_439_616n);
  });

  it('tightens the customer’s rating, once, however many times it is observed', async () => {
    const debtorId = h.seeded.debtorIds['DBT-LUMEN'] ?? '';
    const before = await h.store.getDebtor(debtorId);

    await settlementService.settleAtMaturity(h.seeded.invoiceIds['INV-2033'] ?? '');
    const once = await h.store.getDebtor(debtorId);
    expect(once!.settledOnTime).toBe(before!.settledOnTime + 1);

    // A replayed maturity event must not move it a second time.
    await settlementService.settleAtMaturity(h.seeded.invoiceIds['INV-2033'] ?? '');
    const twice = await h.store.getDebtor(debtorId);
    expect(twice!.settledOnTime).toBe(once!.settledOnTime);
  });

  it('refuses to mature an invoice that never sold', async () => {
    await expect(
      settlementService.settleAtMaturity(h.seeded.invoiceIds['INV-2041'] ?? ''),
    ).rejects.toThrow(/never settled/);
  });
});

describe('the half-settled state', () => {
  it('is reported loudly and is not unwound, because the payment really happened', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2041'] ?? '';
    const quote = await call(h.app, 'GET', `/v1/invoices/${invoiceId}/quote${asOf}`);
    await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId, quoteId: quote.body.quoteId },
    });

    h.ats.failExecute = true;
    const res = await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId, quoteId: quote.body.quoteId },
      headers: {
        'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify({ signature: '0x' })).toString('base64'),
      },
    });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('internal_error');
    expect(res.body.detail).toContain('half-settled');
    // The hold is left alone. Releasing it here would strand a payment that cleared.
    expect(h.ats.released).toHaveLength(0);

    const trade = [...h.store.trades.values()].find((t) => t.invoiceId === invoiceId);
    expect(trade?.status).toBe('failed');
    expect(trade?.cashTransaction).toBe('0.0.6098467@1756000150.000000001');
  });
});

describe('unwinding', () => {
  it('is safe to call twice', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2041'] ?? '';
    const quote = await call(h.app, 'GET', `/v1/invoices/${invoiceId}/quote${asOf}`);
    const armed = await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId, quoteId: quote.body.quoteId },
    });

    const first = await settlementService.unwind(armed.body.trade.id, 'timed out');
    const second = await settlementService.unwind(armed.body.trade.id, 'timed out again');

    expect(first.state).toBe('released');
    expect(second.state).toBe('released');
    expect(h.ats.released).toHaveLength(1);
  });

  it('refuses to unwind a settled trade — that would be a new sale', async () => {
    await expect(
      settlementService.unwind(h.seeded.tradeIds['TRD-4417'] ?? '', 'nope'),
    ).rejects.toThrow(/cannot be unwound/);
  });
});

describe('the issuance sink', () => {
  it('writes the durable job and the projection the book reads', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2051'] ?? '';
    const queue = new IssuanceQueue({
      minIntervalMs: 0,
      maxAttempts: 2,
      backoffBaseMs: 1,
      sink: createStoreIssuanceSink(),
      deploy: () =>
        Promise.resolve({
          securityId: '0.0.777777',
          evmAddress: `0x${'cd'.repeat(20)}` as const,
          transactionId: '0.0.5512@1756000400.000000001',
          gasUsed: 6_978_091,
        }),
    });

    queue.enqueue({
      invoiceId,
      isin: 'US0000000000',
      regulationType: 'reg-d-506c',
      maturityAt: new Date('2026-09-30T00:00:00.000Z'),
      faceValue: 1_225_000n,
      currency: 'USD',
      name: 'Meridian Fabrication receivable MF-2051',
      symbol: 'FAC2051',
    });

    for (let i = 0; i < 200 && queue.status(invoiceId)?.state !== 'issued'; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const invoice = await h.store.getInvoice(invoiceId);
    expect(invoice?.issuanceState).toBe('issued');
    expect(invoice?.securityId).toBe('0.0.777777');
    expect(invoice?.issuanceTxId).toBe('0.0.5512@1756000400.000000001');

    // Nothing finished is left in the queue table for a restart to pick up again.
    expect(await h.store.listUnfinishedIssuanceJobs()).toHaveLength(0);
  });

  it('leaves a failed job on the invoice with its reason, rather than silently', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2052'] ?? '';
    const queue = new IssuanceQueue({
      minIntervalMs: 0,
      maxAttempts: 2,
      backoffBaseMs: 1,
      sink: createStoreIssuanceSink(),
      deploy: () => Promise.reject(new Error('CONTRACT_REVERT_EXECUTED: onlyValidISIN')),
    });

    queue.enqueue({
      invoiceId,
      isin: 'not-an-isin',
      regulationType: 'reg-d-506c',
      maturityAt: new Date('2026-10-20T00:00:00.000Z'),
      faceValue: 890_000n,
      currency: 'USD',
      name: 'Meridian Fabrication receivable MF-2052',
      symbol: 'FAC2052',
    });

    for (let i = 0; i < 200 && queue.status(invoiceId)?.state !== 'failed'; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const invoice = await h.store.getInvoice(invoiceId);
    expect(invoice?.issuanceState).toBe('failed');
    expect(invoice?.issuanceError).toContain('onlyValidISIN');
    // Not retried: a bad ISIN will never work, and burning six attempts only delays
    // telling the seller their invoice is unlistable.
    expect(invoice?.issuanceAttempts).toBe(1);
  });
});

describe('a store with nothing in it', () => {
  it('is not a broken service — an unknown invoice is a 404, not a crash', async () => {
    const res = await call(h.app, 'GET', `/v1/invoices/${seedId('INV-NOWHERE')}`);
    expect(res.status).toBe(404);
  });
});
