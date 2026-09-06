/**
 * The secondary market: a holder relisting seasoned paper into the same book.
 *
 * `sold -> listed` was a declared edge in `invoice-machine.ts` from the first migration and
 * the route refused it outright, so the README's own argument — that a buyer bids tighter on
 * paper they know they can exit, and the secondary leg is what makes the primary quote
 * competitive — rested on something with no code behind it.
 *
 * These tests are written mostly about the ACCOUNTING rather than the happy path, because a
 * resale's dangerous failure is silent: one receivable, two settled trades, and two mandates
 * each carrying the debtor concentration for it. The venue would refuse good trades against
 * headroom it actually has back, and the arithmetic would look perfectly consistent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKET_NOW_ISO } from '../src/db/seed.js';
import { currentHolderTrade, isResale, sellingPartyIdOf, sellingPartyOf } from '../src/parties.js';
import type { TradeRow } from '../src/db/schema.js';
import { call, createHarness, RESALE_SIGNER, type Harness } from './helpers.js';

let h: Harness;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(MARKET_NOW_ISO));
  h = await createHarness({ env: RESALE_SIGNER('0.0.6098431') });
});

afterEach(() => {
  vi.useRealTimers();
  h.restore();
});

/** Just enough of a trade row for the party helpers, which read four fields between them. */
const tradeLike = (over: Partial<TradeRow>): TradeRow =>
  ({
    id: 'trade-1',
    sellerId: 'seller-1',
    resellerBuyerId: null,
    buyerId: 'buyer-1',
    status: 'settled',
    supersededAt: null,
    settledAt: new Date('2026-09-01T00:00:00.000Z'),
    ...over,
  }) as TradeRow;

describe('who is selling', () => {
  it('names the originator on a first sale', () => {
    const trade = tradeLike({});
    expect(sellingPartyOf(trade)).toEqual({ kind: 'originator', sellerId: 'seller-1' });
    expect(sellingPartyIdOf(trade)).toBe('seller-1');
    expect(isResale(trade)).toBe(false);
  });

  /*
   * The two ids live in different tables, so the tag is what tells a caller which store to
   * ask. An id on its own cannot, which is why `sellingPartyOf` is a tagged pair and only
   * `sellingPartyIdOf` flattens it.
   */
  it('names the previous holder on a resale, and keeps the originator on the row', () => {
    const trade = tradeLike({ resellerBuyerId: 'buyer-9' });
    expect(sellingPartyOf(trade)).toEqual({ kind: 'holder', buyerId: 'buyer-9' });
    expect(sellingPartyIdOf(trade)).toBe('buyer-9');
    expect(isResale(trade)).toBe(true);
    expect(trade.sellerId).toBe('seller-1');
  });
});

describe('who holds the paper now', () => {
  it('is nobody when nothing has settled', () => {
    expect(currentHolderTrade([tradeLike({ status: 'preparing' })])).toBeNull();
    expect(currentHolderTrade([])).toBeNull();
  });

  it('is the newest settled trade', () => {
    const older = tradeLike({ id: 'a', settledAt: new Date('2026-09-01T00:00:00.000Z') });
    const newer = tradeLike({ id: 'b', settledAt: new Date('2026-09-03T00:00:00.000Z') });
    expect(currentHolderTrade([older, newer])?.id).toBe('b');
    expect(currentHolderTrade([newer, older])?.id).toBe('b');
  });

  /*
   * The filter that makes a resale legible. Without it the previous holder's trade is still
   * `settled` against an invoice that is still `sold`, so it keeps answering as the holder.
   */
  it('ignores a position that has been sold on', () => {
    const superseded = tradeLike({
      id: 'a',
      settledAt: new Date('2026-09-05T00:00:00.000Z'),
      supersededAt: new Date('2026-09-06T00:00:00.000Z'),
    });
    const current = tradeLike({ id: 'b', settledAt: new Date('2026-09-03T00:00:00.000Z') });

    // Even though the superseded one settled LATER, it is not the holder.
    expect(currentHolderTrade([superseded, current])?.id).toBe('b');
  });

  it('orders by settlement, not by arming', () => {
    const armedFirst = tradeLike({ id: 'a', settledAt: new Date('2026-09-04T00:00:00.000Z') });
    const armedSecond = tradeLike({ id: 'b', settledAt: new Date('2026-09-02T00:00:00.000Z') });
    expect(currentHolderTrade([armedFirst, armedSecond])?.id).toBe('a');
  });
});

describe('handing a position over', () => {
  const holderTradeOf = async (label: string) =>
    currentHolderTrade(
      await h.store.listTrades({ invoiceId: h.seeded.invoiceIds[label] ?? '', limit: 100 }),
    );

  /*
   * The defect this exists to prevent. One receivable, two settled trades, and both mandates
   * carrying the same debtor concentration — the venue quoting wide against headroom the
   * first holder actually has back.
   */
  it('stops the old holder carrying exposure they no longer have', async () => {
    const trade = await holderTradeOf('INV-2033');
    expect(trade).not.toBeNull();
    const mandateId = trade?.mandateId ?? '';
    const invoice = await h.store.getInvoice(h.seeded.invoiceIds['INV-2033'] ?? '');
    const debtorId = invoice?.debtorId ?? '';

    const before = (await h.store.debtorExposure([mandateId])).get(mandateId) ?? {};
    expect(before[debtorId]).toBeGreaterThan(0n);

    await h.store.supersedePosition({
      tradeId: trade?.id ?? '',
      mandateId,
      amount: trade?.proceedsMinor ?? 0n,
      rail: trade?.cashRail ?? null,
      at: new Date(),
    });

    const after = (await h.store.debtorExposure([mandateId])).get(mandateId) ?? {};
    expect(after[debtorId] ?? 0n).toBe((before[debtorId] ?? 0n) - (trade?.proceedsMinor ?? 0n));
  });

  it('gives the old holder their allocation back', async () => {
    const trade = await holderTradeOf('INV-2033');
    const mandateId = trade?.mandateId ?? '';
    const before = await h.store.getMandate(mandateId);

    const { superseded } = await h.store.supersedePosition({
      tradeId: trade?.id ?? '',
      mandateId,
      amount: trade?.proceedsMinor ?? 0n,
      rail: 'x402',
      at: new Date(),
    });

    const after = await h.store.getMandate(mandateId);
    expect(superseded).toBe(true);
    expect(after?.allocatedMinor).toBe(
      (before?.allocatedMinor ?? 0n) - (trade?.proceedsMinor ?? 0n),
    );
    // x402 was paid in the buyer's own HBAR, so the vault never moved and the commitment stands.
    expect(after?.fundedMinor).toBe(before?.fundedMinor);
  });

  /*
   * Rail-dependent for the reason `retireAllocatedCapital` is: paper bought out of the Arc
   * vault was paid for with escrowed USDC that has already left, so the commitment retires
   * with the allocation rather than becoming spendable again.
   */
  it('retires the commitment too when the vault paid for it', async () => {
    const trade = await holderTradeOf('INV-2033');
    const mandateId = trade?.mandateId ?? '';
    const before = await h.store.getMandate(mandateId);

    await h.store.supersedePosition({
      tradeId: trade?.id ?? '',
      mandateId,
      amount: trade?.proceedsMinor ?? 0n,
      rail: 'arc-vault',
      at: new Date(),
    });

    const after = await h.store.getMandate(mandateId);
    expect(after?.fundedMinor).toBe((before?.fundedMinor ?? 0n) - (trade?.proceedsMinor ?? 0n));
  });

  /*
   * A retried settlement must not release the same capital twice. The second release would be
   * real money appearing on a mandate that never got it back.
   */
  it('is idempotent', async () => {
    const trade = await holderTradeOf('INV-2033');
    const mandateId = trade?.mandateId ?? '';

    const first = await h.store.supersedePosition({
      tradeId: trade?.id ?? '',
      mandateId,
      amount: trade?.proceedsMinor ?? 0n,
      rail: 'x402',
      at: new Date(),
    });
    const between = await h.store.getMandate(mandateId);

    const second = await h.store.supersedePosition({
      tradeId: trade?.id ?? '',
      mandateId,
      amount: trade?.proceedsMinor ?? 0n,
      rail: 'x402',
      at: new Date(),
    });

    expect(first.superseded).toBe(true);
    expect(second.superseded).toBe(false);
    expect((await h.store.getMandate(mandateId))?.allocatedMinor).toBe(between?.allocatedMinor);
  });
});

describe('the resale offer', () => {
  /*
   * Quotability is what makes the relist worth anything: seasoned paper is shorter-tenor
   * paper, so it prices off the same standing bids and clears tighter because less time
   * remains. `quote-engine.ts` never reads a seller, so this needed no pricing change at all.
   */
  it('puts sold paper back on the book, where it prices on its remaining tenor', async () => {
    const id = h.seeded.invoiceIds['INV-2033'] ?? '';

    const listed = await call(h.app, 'POST', `/v1/invoices/${id}/list`);
    expect(listed.status).toBe(200);
    expect(listed.body.invoice.status).toBe('listed');

    const quote = await call(h.app, 'GET', `/v1/invoices/${id}/quote`);
    expect(quote.status).toBe(200);
    expect(quote.body.tenorDays).toBeGreaterThan(0);
  });
});
