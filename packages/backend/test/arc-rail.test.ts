/**
 * Settling out of the buyer's escrowed capital, on Arc.
 *
 * Two rails now carry the cash leg, and they are not two ways of doing one thing. `x402` is a
 * payment the buyer signs for this trade. `arc-vault` draws on USDC the buyer put in
 * `MandateVault` before the invoice existed — no challenge and no signature, because a funded
 * mandate already agreed to anything meeting its terms. Asking for a second consent is what
 * would make a standing bid not standing.
 *
 * So the rail decides what `POST /v1/trades` even returns: 402 with something to sign, or 200
 * with a trade already settled. That is worth testing at the route rather than the service,
 * because the status code is the first thing a client branches on.
 *
 * The ordering inside a vault settlement is the other thing under test, and it is chosen by
 * which way a failure hurts. Cash commits into the escrow *before* the paper moves: reverse
 * the two and a failed payout leaves the buyer holding paper nobody paid for, which cannot be
 * undone. This way a failed delivery leaves money in an escrow that returns it to the mandate
 * after a day, and the seller keeps their position.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { call, createHarness, fakeArcEscrow, listInvoice, type Harness } from './helpers.js';
import { MARKET_NOW_ISO, marketNow } from '../src/db/seed.js';
import { usdcPayoutFor, usdcRequiredFor, type ArcEscrow } from '../src/services/arc.js';

let h: Harness;

/*
 * The seeded book is priced as of a fixed instant, and a quote carries an expiry. Without the
 * clock pinned, every arming here races the quote it just took and fails as "expired" —
 * which is a true refusal about the wrong thing.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(MARKET_NOW_ISO));
});

afterEach(() => {
  vi.useRealTimers();
  h.restore();
});

const asOf = `?asOf=${marketNow().toISOString()}`;

/**
 * What the seeded book's ordinary invoice costs, in USDC minor units at the test scale.
 *
 * `usdcPayoutFor`, not `usdcRequiredFor`. These two rounded the same way until 2026-09-04
 * and this helper pinned the wrong one: a payment rounds down and a backing requirement
 * rounds up, so at 1 ppm they differ by a unit on every inexact division. Using the
 * requirement here made the tests agree with the defect.
 */
const priceOf = (proceedsMinor: bigint) => usdcPayoutFor(proceedsMinor, 'USD', 1);

/** A vault holding enough for anything on the book, recording every call it receives. */
function vault(overrides: Partial<ArcEscrow> = {}) {
  const calls = {
    registerMatch: [] as { tradeId: string; seller: string; priceUsdcMinor: bigint }[],
    executePayout: [] as { tradeId: string; secretHash: string }[],
  };
  const escrow = fakeArcEscrow({
    depositedFor: () => Promise.resolve(1_000_000_000n),
    registerMatch: (input) => {
      calls.registerMatch.push({
        tradeId: input.tradeId,
        seller: input.seller,
        priceUsdcMinor: input.priceUsdcMinor,
      });
      return Promise.resolve({ transactionHash: '0xmatchtx', matchId: '0xmatch' });
    },
    executePayout: (input) => {
      calls.executePayout.push({ tradeId: input.tradeId, secretHash: input.secretHash });
      return Promise.resolve({
        transactionHash: '0xpayouttx',
        lockId: '0xlock',
        authId: '0xauth',
      });
    },
    ...overrides,
  });
  return { escrow, calls };
}

async function arm(invoiceLabel = 'INV-2041') {
  const invoiceId = h.seeded.invoiceIds[invoiceLabel] ?? '';
  // A sale needs an offer, and the seeded book is confirmed rather than listed.
  await listInvoice(h.app, invoiceId);
  const quote = await call(h.app, 'GET', `/v1/invoices/${invoiceId}/quote${asOf}`);
  const armed = await call(h.app, 'POST', '/v1/trades', {
    body: { invoiceId, quoteId: quote.body.quoteId },
  });
  return { invoiceId, quoteId: quote.body.quoteId as string, armed };
}

describe('choosing a rail', () => {
  it('settles out of the vault when the bid is escrowed, without a challenge', async () => {
    const { escrow } = vault();
    h = await createHarness({ arc: escrow });

    const { armed } = await arm();

    expect(armed.status).toBe(200);
    expect(armed.body.cashLeg.rail).toBe('arc-vault');
    expect(armed.body.cashLeg.chain).toBe('arc');
    expect(armed.body.cashLeg.state).toBe('settled');
    // Nothing to sign, so nothing that says how to sign it.
    expect(armed.body.accepts).toBeUndefined();
    expect(armed.body.signatureHeader).toBeUndefined();
  });

  /* The old path, unchanged. An unfunded bid still pays per trade. */
  it('issues an x402 challenge when the vault holds nothing', async () => {
    const { escrow } = vault({ depositedFor: () => Promise.resolve(0n) });
    h = await createHarness({ arc: escrow });

    const { armed } = await arm();

    expect(armed.status).toBe(402);
    expect(armed.body.rail.chosen).toBe('x402');
    expect(armed.body.rail.reason).toContain('USDC minor units on Arc');
    expect(armed.body.accepts).toHaveLength(1);
  });

  it('issues a challenge when no vault is configured at all', async () => {
    h = await createHarness();

    const { armed } = await arm();

    expect(armed.status).toBe(402);
    expect(armed.body.rail.reason).toContain('No Arc vault is configured');
  });

  /*
   * An unreadable vault must not stop a sale. The other rail is right there and works, and
   * refusing to trade because a second rail was unavailable would be the same mistake the
   * compliance gate makes when it lets an indeterminate answer move a price.
   */
  it('falls back to x402 rather than refusing when the vault cannot be read', async () => {
    const { escrow } = vault({ depositedFor: () => Promise.reject(new Error('rpc down')) });
    h = await createHarness({ arc: escrow });

    const { armed } = await arm();

    expect(armed.status).toBe(402);
    expect(armed.body.rail.reason).toContain('could not be read');
  });

  /*
   * `registerMatch` binds the payee permanently and the vault will happily bind an address
   * nobody controls. A seller with none on file is a reason to use the other rail, not a
   * reason to open a lock into the void.
   */
  it('refuses the vault rail when the seller has no Arc address', async () => {
    const { escrow } = vault();
    h = await createHarness({ arc: escrow });
    await h.store.updateSellerWallet(h.seeded.sellerId, { arcAddress: null });

    const { armed } = await arm();

    expect(armed.status).toBe(402);
    expect(armed.body.rail.reason).toContain('no Arc address');
  });
});

describe('what a vault settlement does, and in what order', () => {
  it('binds the payout before the paper moves', async () => {
    const { escrow, calls } = vault();
    h = await createHarness({ arc: escrow });

    const { armed } = await arm();

    expect(calls.registerMatch).toHaveLength(1);
    expect(calls.executePayout).toHaveLength(1);
    expect(h.ats.executed).toHaveLength(1);

    // The binding names the seller and the price the venue actually charged.
    const trade = armed.body.trade;
    expect(calls.registerMatch[0]?.tradeId).toBe(trade.id);
    expect(calls.registerMatch[0]?.priceUsdcMinor).toBe(priceOf(BigInt(trade.proceeds)));
  });

  /*
   * The number a reader can check against the transaction. `proceeds` is US cents and the
   * money that moved is that figure scaled into USDC, so a receipt carrying only the first
   * invites someone to compare $59,331.78 against a transfer of 0.059331 and conclude the
   * venue is lying.
   */
  it('reports what moved in the settlement asset, not only the invoice price', async () => {
    const { escrow } = vault();
    h = await createHarness({ arc: escrow });

    const { armed } = await arm();
    const cash = armed.body.cashLeg;

    expect(cash.amountMinor).toBe(armed.body.trade.proceeds);
    expect(cash.settledAmountMinor).toBe(priceOf(BigInt(armed.body.trade.proceeds)).toString(10));
    expect(cash.settledAmountMinor).not.toBe(cash.amountMinor);
  });

  /*
   * A payout that has been locked is not a payout that has been received. Saying "settled"
   * without saying where the money is would report a payment that has not reached anyone.
   */
  it('says the money is in an escrow the seller has still to claim', async () => {
    const { escrow } = vault();
    h = await createHarness({ arc: escrow });

    const { armed } = await arm();

    expect(armed.body.cashLeg.lock.lockId).toBe('0xlock');
    expect(armed.body.cashLeg.lock.status).toBe('locked');
    // Without the preimage nobody can ever claim it, so it has to leave this service.
    expect(armed.body.cashLeg.lock.secret).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('records the rail on the trade rather than leaving it to be inferred', async () => {
    const { escrow } = vault();
    h = await createHarness({ arc: escrow });

    const { armed } = await arm();
    const stored = await h.store.getTrade(armed.body.trade.id);

    expect(stored?.cashRail).toBe('arc-vault');
    expect(stored?.arcLockId).toBe('0xlock');
    expect(stored?.arcSecret).toMatch(/^0x[0-9a-f]{64}$/);
    expect(stored?.status).toBe('settled');
  });

  it('marks the quote taken and the invoice sold, like the other rail', async () => {
    const { escrow } = vault();
    h = await createHarness({ arc: escrow });

    const { invoiceId, quoteId, armed } = await arm();

    expect(armed.status).toBe(200);
    expect((await h.store.getQuote(quoteId))?.status).toBe('accepted');
    expect((await h.store.getInvoice(invoiceId))?.status).toBe('sold');
  });
});

describe('when a vault settlement goes wrong', () => {
  /*
   * The recoverable half-settle, and the reason the order is what it is. The cash is locked
   * in an escrow that returns it to the mandate after a day and the seller keeps their
   * position — so unlike the x402 half-settle, nobody has paid for nothing.
   */
  it('fails loudly and keeps the secret when the paper does not move', async () => {
    const { escrow } = vault();
    h = await createHarness({ arc: escrow });
    h.ats.failExecute = true;

    const { armed } = await arm();

    expect(armed.status).toBe(500);
    expect(armed.body.detail).toContain('locked on Arc');
    expect(armed.body.detail).toContain('seller keeps their position');
  });

  /*
   * THE ONE THAT LOSES MONEY TWICE.
   *
   * The buyer's capital has irreversibly left the vault by the time delivery is attempted,
   * and this rail's whole premise is that no second consent is needed. So if a failed
   * delivery left the invoice quotable, the hold would expire, the seller could take a fresh
   * quote, and a second trade would draw a SECOND payout from the same funded mandate —
   * one receivable, paid for twice, silently. The x402 rail has the same hole and cannot
   * reach it, because a second sale there needs a second signature.
   */
  it('takes the receivable off the market the moment the cash leaves the vault', async () => {
    const { escrow } = vault();
    h = await createHarness({ arc: escrow });
    h.ats.failExecute = true;

    const { invoiceId, armed } = await arm();

    expect(armed.status).toBe(500);
    // Paid for, so not for sale — even though the paper never moved.
    expect((await h.store.getInvoice(invoiceId))?.status).toBe('sold');
  });

  /*
   * The other half of the same defect. `internal_error` is the code both rails reserve for
   * "the money moved and the paper did not"; giving the mandate its capacity back there
   * would let the bid quote against capital sitting in an escrow lock.
   */
  it('keeps the capital committed when the cash moved and the paper did not', async () => {
    const { escrow } = vault();
    h = await createHarness({ arc: escrow });

    const invoiceId = h.seeded.invoiceIds['INV-2041'] ?? '';
    await listInvoice(h.app, invoiceId);
    const quote = await call(h.app, 'GET', `/v1/invoices/${invoiceId}/quote${asOf}`);
    // The mandate is named on the quote itself, not at the top of the response. Reading the
    // wrong path here silently compares an absent mandate with itself and passes.
    const mandateId = quote.body.quote.mandateId as string;
    const before = (await h.store.getMandate(mandateId))?.allocatedMinor ?? 0n;

    h.ats.failExecute = true;
    const armed = await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId, quoteId: quote.body.quoteId },
    });

    expect(armed.status).toBe(500);
    const after = (await h.store.getMandate(mandateId))?.allocatedMinor ?? 0n;
    expect(after).toBeGreaterThan(before);
  });

  /*
   * `reclaimExpired` sweeps `awaiting_payment` on nearly every request, and an Arc trade sits
   * in that state for the whole of its settlement — including after the USDC is in escrow.
   * Unwinding one would release the hold and refund capital that is on chain and gone.
   */
  it('refuses to unwind a trade whose cash leg already moved', async () => {
    const { escrow } = vault();
    h = await createHarness({ arc: escrow });
    h.ats.failExecute = true;

    const { invoiceId, armed } = await arm();
    expect(armed.status).toBe(500);

    // A 500 body is a problem document, so the trade is found through the store instead.
    const stored = await h.store.getTradeForInvoice(invoiceId);
    const tradeId = stored?.id ?? '';
    expect(stored?.arcLockId).toBe('0xlock');

    const unwound = await call(h.app, 'POST', `/v1/trades/${tradeId}/unwind`, { body: {} });
    expect(unwound.status).toBe(409);
    expect(unwound.body.detail).toContain('already moved money');
  });

  /*
   * An Arc trade stuck in `awaiting_payment` after a crash must not accept an x402 payload.
   * The venue would build a fresh Hedera challenge and take a second payment for the same
   * receivable, then overwrite the row's rail and bury the escrow lock under it.
   */
  it('refuses an x402 signature against a trade the vault is paying for', async () => {
    const { escrow } = vault();
    h = await createHarness({ arc: escrow });

    const invoiceId = h.seeded.invoiceIds['INV-2041'] ?? '';
    await listInvoice(h.app, invoiceId);
    const quote = await call(h.app, 'GET', `/v1/invoices/${invoiceId}/quote${asOf}`);
    const armed = await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId, quoteId: quote.body.quoteId },
    });
    expect(armed.status).toBe(200);

    // Force the row back to the state a crash mid-settlement would leave it in.
    await h.store.updateTrade(armed.body.trade.id, { status: 'awaiting_payment' });

    const signed = await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId, quoteId: quote.body.quoteId },
      headers: {
        'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify({ signature: '0x' })).toString('base64'),
      },
    });

    expect(signed.status).toBe(409);
    expect(signed.body.detail).toContain('nothing to sign');
  });

  /*
   * `registerMatch` cannot be called twice — it reverts even from the attester with identical
   * arguments — so a retry has to read the binding rather than re-send it.
   */
  it('does not bind a match twice when one already exists', async () => {
    // The seeded seller's Arc address: the operator's own key, which also holds the paper.
    const seller = '0x2Da63Ac0F6AE2C3059091d8DF38b3175a237ee71';
    h = await createHarness({ arc: vault().escrow });

    // Price the invoice first, so the pre-existing binding can name what this trade expects.
    const invoiceId = h.seeded.invoiceIds['INV-2041'] ?? '';
    await listInvoice(h.app, invoiceId);
    const quote = await call(h.app, 'GET', `/v1/invoices/${invoiceId}/quote${asOf}`);
    const price = priceOf(BigInt(quote.body.quote.proceeds as string));

    const { escrow, calls } = vault({
      payoutFor: () =>
        Promise.resolve({
          matchId: '0xmatch',
          mandateId: 1n,
          seller,
          executed: false,
          price,
        }),
    });
    h.restore();
    h = await createHarness({ arc: escrow });

    const { armed } = await arm();

    expect(armed.status).toBe(200);
    expect(calls.registerMatch).toHaveLength(0);
    expect(calls.executePayout).toHaveLength(1);
  });

  /*
   * `executePayout` takes no amount and no payee — it pays `payout.price` to `payout.seller`
   * off a binding that cannot be corrected. Settling against a binding that does not match
   * this trade would move one amount while the receipt claimed another, which is precisely
   * what the proof view exists to make impossible.
   */
  it('refuses to settle against a binding that names different terms', async () => {
    const { escrow, calls } = vault({
      payoutFor: () =>
        Promise.resolve({
          matchId: '0xmatch',
          mandateId: 1n,
          seller: '0xsomeoneelse',
          executed: false,
          price: 1n,
        }),
    });
    h = await createHarness({ arc: escrow });

    const { armed } = await arm();

    expect(armed.status).toBe(409);
    expect(armed.body.detail).toContain('bound on chain to pay');
    expect(calls.executePayout).toHaveLength(0);
  });

  /*
   * A match whose capital already left can never be paid again: `reclaimPayout` returns the
   * money to the buyer but leaves `executed` true forever. Refusing is the only honest
   * answer — a second payout would revert, and reporting success would promise a payment
   * that cannot happen.
   */
  it('refuses a trade whose payout the vault has already executed', async () => {
    const { escrow } = vault({
      payoutFor: () =>
        Promise.resolve({
          matchId: '0xmatch',
          mandateId: 1n,
          seller: '0xseller',
          executed: true,
          price: 1n,
        }),
    });
    h = await createHarness({ arc: escrow });

    const { armed } = await arm();

    expect(armed.status).toBe(409);
    expect(armed.body.detail).toContain('already drawn its payout');
  });

  /* Arming failed, so nothing is owed and the bid must not be left quoting money it cannot spend. */
  it('gives the mandate its capital back when the payout reverts', async () => {
    const { escrow } = vault({
      executePayout: () => Promise.reject(new Error('InsufficientVaultBalance')),
    });
    h = await createHarness({ arc: escrow });

    const invoiceId = h.seeded.invoiceIds['INV-2041'] ?? '';
    await listInvoice(h.app, invoiceId);
    const quote = await call(h.app, 'GET', `/v1/invoices/${invoiceId}/quote${asOf}`);
    // The mandate is named on the quote itself, not at the top of the response. Reading the
    // wrong path here silently compares an absent mandate with itself and passes.
    const mandateId = quote.body.quote.mandateId as string;
    const before = (await h.store.getMandate(mandateId))?.allocatedMinor;

    const armed = await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId, quoteId: quote.body.quoteId },
    });

    expect(armed.status).toBeGreaterThanOrEqual(400);
    expect((await h.store.getMandate(mandateId))?.allocatedMinor).toBe(before);
  });
});
