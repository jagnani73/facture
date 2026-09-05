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

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKET_NOW_ISO, seedId } from '../src/db/seed.js';
import { createStoreIssuanceSink, IssuanceQueue } from '../src/services/issuance.js';
import { EXPIRED_AFTER_SECONDS, settlementService } from '../src/services/settlement.js';
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

  it('reports the cash leg as pending, because a scheduled payout is not a payment', async () => {
    const result = await settlementService.settleAtMaturity(h.seeded.invoiceIds['INV-2033'] ?? '');

    expect(result.cashLeg.state).toBe('pending');
    expect(result.cashLeg.transaction).toBeNull();
    expect(result.cashLeg.explorerUrl).toBeNull();

    // And it stays pending even though a payout WAS arranged. The schedule is an
    // obligation waiting on the collection key; nobody has been paid until it executes.
    expect(result.payout).not.toBeNull();
    expect(result.payout?.executed).toBe(false);
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

  it('pays whoever holds the paper NOW, not whoever bought it first', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2033'] ?? '';
    const first = await h.store.getTrade(h.seeded.tradeIds['TRD-4417'] ?? '');
    const firstMandate = first?.mandateId ?? '';
    const secondMandate = h.seeded.mandateIds['MND-02'] ?? '';
    const secondBuyer = h.seeded.buyerIds['BUY-CORDELL'] ?? '';

    /*
     * The paper changes hands on day thirty: a second settled trade on the same
     * receivable, funded by a different buyer's mandate. This is the case the holder
     * lookup exists for — without it a second buyer has no way to be paid, and the
     * secondary market is a screen rather than a market.
     */
    await h.store.allocate(secondMandate, first!.proceedsMinor);
    const resale = await h.store.insertTrade({
      ...first!,
      id: randomUUID(),
      mandateId: secondMandate,
      buyerId: secondBuyer,
      createdAt: new Date(first!.createdAt.getTime() + 30 * 86_400_000),
      settledAt: new Date((first!.settledAt?.getTime() ?? 0) + 30 * 86_400_000),
    });

    const beforeFirst = await h.store.getMandate(firstMandate);
    const beforeSecond = await h.store.getMandate(secondMandate);

    const result = await settlementService.settleAtMaturity(invoiceId);

    expect(result.tradeId).toBe(resale.id);
    expect(result.holder.buyerId).toBe(secondBuyer);
    expect(result.holder.mandateId).toBe(secondMandate);

    // The capital goes back to the mandate actually holding the paper. The first buyer was
    // paid by the second one; maturity owes them nothing.
    const afterFirst = await h.store.getMandate(firstMandate);
    const afterSecond = await h.store.getMandate(secondMandate);
    expect(beforeSecond!.allocatedMinor - afterSecond!.allocatedMinor).toBe(first!.proceedsMinor);
    expect(afterFirst!.allocatedMinor).toBe(beforeFirst!.allocatedMinor);
  });

  it('gives the capital back exactly once, however many times maturity is observed', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2033'] ?? '';
    const mandateId = h.seeded.mandateIds['MND-01'] ?? '';
    const before = await h.store.getMandate(mandateId);

    const first = await settlementService.settleAtMaturity(invoiceId);
    const replay = await settlementService.settleAtMaturity(invoiceId);

    expect(first.alreadyRecorded).toBe(false);
    expect(replay.alreadyRecorded).toBe(true);
    // Released once. A replayed maturity event handing a mandate its capital back twice
    // would let it quote money it never had.
    const after = await h.store.getMandate(mandateId);
    expect(before!.allocatedMinor - after!.allocatedMinor).toBe(9_439_616n);
  });

  it('finishes a maturity that died between the ledger write and the release', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2033'] ?? '';
    const invoice = await h.store.getInvoice(invoiceId);
    const mandateId = h.seeded.mandateIds['MND-01'] ?? '';

    // The outcome landed in the ledger and the process died before the capital came back,
    // so the invoice is still `sold`. A replay has to repair that, not skip it.
    await h.store.recordOutcome({
      debtorId: invoice?.debtorId ?? '',
      invoiceId,
      outcome: 'on_time',
      faceValue: invoice?.faceValue ?? 0n,
      at: new Date(),
    });
    const before = await h.store.getMandate(mandateId);

    const result = await settlementService.settleAtMaturity(invoiceId);

    expect(result.alreadyRecorded).toBe(true);
    const after = await h.store.getMandate(mandateId);
    expect(before!.allocatedMinor - after!.allocatedMinor).toBe(9_439_616n);
    expect((await h.store.getInvoice(invoiceId))?.status).toBe('matured');
  });

  it('counts a payment on the due date itself as on time', async () => {
    // MF-2033 falls due on 2026-09-12. `due_at` is the start of that day, so an hour before
    // midnight is still the day it was due — and a rating mark is permanent.
    vi.setSystemTime(new Date('2026-09-12T23:00:00.000Z'));

    const result = await settlementService.settleAtMaturity(h.seeded.invoiceIds['INV-2033'] ?? '');

    expect(result.outcome).toBe('on_time');
  });

  it('counts the day after the due date as late', async () => {
    vi.setSystemTime(new Date('2026-09-13T00:30:00.000Z'));

    const result = await settlementService.settleAtMaturity(h.seeded.invoiceIds['INV-2033'] ?? '');

    expect(result.outcome).toBe('late');
  });
});

/**
 * The payout rail.
 *
 * A debtor here has no wallet, by design — that is what lets confirmation be a link with
 * one sentence and two buttons. So the payout cannot be a transfer the debtor signs, and
 * what maturity produces instead is an unsigned obligation drawn on the venue's collection
 * account: an on-chain object saying who is owed what against which receivable, which
 * executes when the venue signs to say the money arrived.
 *
 * The line these tests defend is that arranging a payout is not the same event as making
 * one, and nothing on the maturity path may quietly promote the first into the second.
 */
describe('the maturity payout rail', () => {
  it('addresses the obligation to whoever holds the paper now', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2033'] ?? '';
    const result = await settlementService.settleAtMaturity(invoiceId);

    expect(h.schedule.scheduled).toHaveLength(1);
    const request = h.schedule.scheduled[0];
    expect(request?.invoiceId).toBe(invoiceId);
    expect(request?.tradeId).toBe(result.tradeId);

    // The payee is the CURRENT holder's Hedera account, read off the buyer the holding
    // trade names — not the seller, and not whoever was matched first.
    const holder = await h.store.getBuyer(result.holder.buyerId);
    expect(request?.payeeAccount).toBe(holder?.hederaAccountId);
    expect(result.payout?.payeeAccountId).toBe(holder?.hederaAccountId);
  });

  it('is an obligation and not a receipt', async () => {
    const result = await settlementService.settleAtMaturity(h.seeded.invoiceIds['INV-2033'] ?? '');

    /*
     * The whole design in one assertion. A schedule that reported itself executed at the
     * moment of creation would mean the payout fired without anyone signing for the
     * debtor's money — which is what happens if the payout is ever drawn on the operator,
     * since the operator's signature on the ScheduleCreate would already satisfy it.
     */
    expect(result.payout?.executed).toBe(false);
    expect(result.payout?.scheduleId).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.payout?.explorerUrl).toContain(`/schedule/${result.payout?.scheduleId}`);
    expect(result.payoutError).toBeNull();
  });

  it('denominates the payout the way the cash leg denominated the purchase', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2033'] ?? '';
    const invoice = await h.store.getInvoice(invoiceId);

    const result = await settlementService.settleAtMaturity(invoiceId);

    /*
     * Face value is USD minor units (2 decimals) and the settlement asset is HBAR
     * (tinybars, 8), so the payout is the face shifted by six — NOT the minor units passed
     * through unchanged, which would read as tinybars and settle a hundred-millionth of the
     * amount. Both legs go through the same conversion on the x402 client for exactly this
     * reason.
     */
    expect(invoice?.faceValue).toBe(9_500_000n);
    expect(h.schedule.scheduled[0]?.amountMinor).toBe(9_500_000n * 1_000_000n);
    expect(result.payout?.amountMinor).toBe((9_500_000n * 1_000_000n).toString(10));
  });

  it('says there is no rail rather than inventing one, when none is configured', async () => {
    h.schedule.disabled = true;

    const result = await settlementService.settleAtMaturity(h.seeded.invoiceIds['INV-2033'] ?? '');

    // No payout, and no error either: an unconfigured collection account is a deployment
    // choice, not a fault, and the two must not be reported as the same thing.
    expect(result.payout).toBeNull();
    expect(result.payoutError).toBeNull();
    expect(result.cashLeg.state).toBe('pending');
  });

  it('still matures the receivable when the rail is down, and says why', async () => {
    h.schedule.fails = 'SCHEDULE_CREATE refused: INSUFFICIENT_PAYER_BALANCE';
    const invoiceId = h.seeded.invoiceIds['INV-2033'] ?? '';

    const result = await settlementService.settleAtMaturity(invoiceId);

    /*
     * A receivable has matured whether or not a payout could be arranged. The ledger write
     * and the capital release happen before this call, so a broken rail must not be able to
     * un-mature the invoice or strand a mandate's capital — and must not fail silently
     * either, which is why the reason comes back rather than being logged and dropped.
     */
    expect(result.payout).toBeNull();
    expect(result.payoutError).toContain('INSUFFICIENT_PAYER_BALANCE');
    expect((await h.store.getInvoice(invoiceId))?.status).toBe('matured');
  });

  it('gives the mandate its capital back even when the rail is down', async () => {
    h.schedule.fails = 'network unreachable';
    const invoiceId = h.seeded.invoiceIds['INV-2033'] ?? '';
    const trade = await h.store.getTrade(h.seeded.tradeIds['TRD-4417'] ?? '');
    const before = (await h.store.getMandate(trade?.mandateId ?? ''))?.allocatedMinor ?? 0n;

    await settlementService.settleAtMaturity(invoiceId);

    const after = (await h.store.getMandate(trade?.mandateId ?? ''))?.allocatedMinor ?? 0n;
    expect(after).toBe(before - (trade?.proceedsMinor ?? 0n));
  });

  it('does not schedule a second obligation when maturity is observed twice', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2033'] ?? '';

    await settlementService.settleAtMaturity(invoiceId);
    const replay = await settlementService.settleAtMaturity(invoiceId);

    /*
     * Maturity is observable twice — a mirror-node replay, an operator pressing the button
     * again — and two schedules against one receivable is two claims on the same face
     * value. The replay reports the receivable as already recorded; it must not arrange a
     * second payout.
     */
    expect(replay.alreadyRecorded).toBe(true);
    expect(h.schedule.scheduled).toHaveLength(1);
  });
});

describe('POST /v1/invoices/:id/mature', () => {
  const invoiceOf = (label: string): string => h.seeded.invoiceIds[label] ?? '';

  it('runs the path end to end and names the current holder', async () => {
    const res = await call(h.app, 'POST', `/v1/invoices/${invoiceOf('INV-2033')}/mature`);

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('matured');
    expect(res.body.holder.buyerId).toBe(h.seeded.buyerIds['BUY-ASHGROVE']);
    expect(res.body.outcome).toBe('on_time');
    expect(res.body.proofUrl).toBe(`/v1/trades/${h.seeded.tradeIds['TRD-4417']}/proof`);
  });

  it('says the cash leg is pending, because no debtor payment rail exists here', async () => {
    const res = await call(h.app, 'POST', `/v1/invoices/${invoiceOf('INV-2033')}/mature`);

    // The face value is owed to the holder and nobody has paid it. Reporting this as
    // settled would put a payment on the proof view that never happened.
    expect(res.body.cashLeg.state).toBe('pending');
    expect(res.body.cashLeg.amountMinor).toBe('9500000');
    expect(res.body.cashLeg.transaction).toBeNull();
    expect(res.body.cashLeg.explorerUrl).toBeNull();
  });

  it('is safe to press twice', async () => {
    await call(h.app, 'POST', `/v1/invoices/${invoiceOf('INV-2033')}/mature`);
    const again = await call(h.app, 'POST', `/v1/invoices/${invoiceOf('INV-2033')}/mature`);

    expect(again.status).toBe(200);
    expect(again.body.alreadyRecorded).toBe(true);
  });

  it('refuses an invoice that never sold, in words', async () => {
    const res = await call(h.app, 'POST', `/v1/invoices/${invoiceOf('INV-2041')}/mature`);

    expect(res.status).toBe(409);
    expect(res.body.detail).toContain('never settled');
  });
});

describe('the whole position', () => {
  /*
   * The two halves of the model have to agree about how much paper a sale moves. Issuance
   * mints face-value-many units — the live bond `0.0.10316440` carries 6,230,000 against a
   * $62,300 face — so a trade that moved a hardcoded `1` sold one part in millions of the
   * receivable it was paid for, and said so on the proof view.
   */
  async function arm(invoiceLabel = 'INV-2041') {
    const invoiceId = h.seeded.invoiceIds[invoiceLabel] ?? '';
    const quote = await call(h.app, 'GET', `/v1/invoices/${invoiceId}/quote${asOf}`);
    const armed = await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId, quoteId: quote.body.quoteId },
    });
    return { invoiceId, quoteId: quote.body.quoteId as string, armed };
  }

  it('holds the seller’s entire balance, read off the instrument', async () => {
    h.ats.defaultBalance = 6_230_000n;

    const { armed } = await arm();

    expect(h.ats.holds).toHaveLength(1);
    expect(h.ats.holds[0]?.units).toBe(6_230_000n);
    expect(armed.body.assetLeg.unitsMinor).toBe('6230000');
  });

  it('does not assume the position equals the face value', async () => {
    // Same invoice, a position that is nothing like its face. The hold follows the
    // instrument, not the invoice.
    h.ats.defaultBalance = 4_242n;

    const { armed } = await arm();

    expect(h.ats.holds[0]?.units).toBe(4_242n);
    expect(armed.body.trade.assetLeg.unitsMinor).toBe('4242');
  });

  it('delivers the same units it held, and shows them on the proof view', async () => {
    const { invoiceId, quoteId, armed } = await arm();

    await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId, quoteId },
      headers: {
        'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify({ signature: '0x' })).toString('base64'),
      },
    });

    expect(h.ats.executed).toHaveLength(1);
    expect(h.ats.executed[0]?.units).toBe(6_230_000n);

    const proof = await call(h.app, 'GET', `/v1/trades/${armed.body.trade.id}/proof`);
    expect(proof.body.assetLeg.unitsMinor).toBe('6230000');
  });

  it('releases the same units on an unwind', async () => {
    const { armed } = await arm();

    await settlementService.unwind(armed.body.trade.id, 'timed out');

    expect(h.ats.released).toHaveLength(1);
    expect(h.ats.released[0]?.units).toBe(6_230_000n);
  });

  it('refuses a seller who holds nothing, rather than transferring zero units', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2041'] ?? '';
    const invoice = await h.store.getInvoice(invoiceId);
    h.ats.balances.set(invoice?.securityId ?? '', 0n);

    const mandateId = h.seeded.mandateIds['MND-01'] ?? '';
    const before = await h.store.getMandate(mandateId);
    const quote = await call(h.app, 'GET', `/v1/invoices/${invoiceId}/quote${asOf}`);
    const res = await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId, quoteId: quote.body.quoteId },
    });

    expect(res.status).toBe(409);
    expect(res.body.detail).toContain('holds no units');
    // Nothing held, and the capital handed back — arming failed, so nothing is owed.
    expect(h.ats.holds).toHaveLength(0);
    const after = await h.store.getMandate(mandateId);
    expect(after!.allocatedMinor).toBe(before!.allocatedMinor);
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

describe('POST /v1/trades/:id/unwind', () => {
  /*
   * Before this route existed, an armed trade whose buyer never paid held the mandate's
   * capital until somebody edited the database. `allocated_minor` is a real column rather
   * than a derived value, so the release has to go through the store — which is exactly
   * what going around it, by hand, gets wrong.
   */
  async function arm(): Promise<{ tradeId: string; mandateId: string; proceeds: bigint }> {
    const invoiceId = h.seeded.invoiceIds['INV-2041'] ?? '';
    const quote = await call(h.app, 'GET', `/v1/invoices/${invoiceId}/quote${asOf}`);
    const armed = await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId, quoteId: quote.body.quoteId },
    });
    return {
      tradeId: armed.body.trade.id,
      mandateId: armed.body.trade.mandateId,
      proceeds: BigInt(armed.body.trade.proceeds),
    };
  }

  it('gives the mandate its capital back, through the store', async () => {
    const { tradeId, mandateId, proceeds } = await arm();
    const before = await h.store.getMandate(mandateId);

    const res = await call(h.app, 'POST', `/v1/trades/${tradeId}/unwind`, {
      body: { reason: 'the buyer never signed' },
    });

    expect(res.status).toBe(200);
    expect(res.body.trade.status).toBe('unwound');
    expect(res.body.assetLeg.state).toBe('released');
    const after = await h.store.getMandate(mandateId);
    expect(before!.allocatedMinor - after!.allocatedMinor).toBe(proceeds);
    // The position went back too — this is not a bookkeeping change.
    expect(h.ats.released).toHaveLength(1);
  });

  it('takes no body at all, because the reason is optional', async () => {
    const { tradeId } = await arm();

    const res = await call(h.app, 'POST', `/v1/trades/${tradeId}/unwind`);

    expect(res.status).toBe(200);
    expect(res.body.trade.status).toBe('unwound');
  });

  it('refuses to unwind a settled trade — that would take back paid-for paper', async () => {
    const res = await call(h.app, 'POST', `/v1/trades/${h.seeded.tradeIds['TRD-4417']}/unwind`, {
      body: {},
    });

    expect(res.status).toBe(409);
    expect(res.body.detail).toContain('cannot be unwound');
  });

  it('is safe to retry after a dropped connection', async () => {
    const { tradeId, mandateId } = await arm();

    await call(h.app, 'POST', `/v1/trades/${tradeId}/unwind`, { body: {} });
    const before = await h.store.getMandate(mandateId);
    const again = await call(h.app, 'POST', `/v1/trades/${tradeId}/unwind`, { body: {} });
    const after = await h.store.getMandate(mandateId);

    expect(again.status).toBe(200);
    // The second call releases nothing further and does not touch the chain again.
    expect(after!.allocatedMinor).toBe(before!.allocatedMinor);
    expect(h.ats.released).toHaveLength(1);
  });

  it('is a 404 for a trade that does not exist', async () => {
    const res = await call(h.app, 'POST', `/v1/trades/${seedId('TRD-NOWHERE')}/unwind`, {
      body: {},
    });

    expect(res.status).toBe(404);
  });
});

describe('an armed trade nobody pays for', () => {
  const past = (seconds: number): void =>
    vi.setSystemTime(new Date(Date.parse(MARKET_NOW_ISO) + seconds * 1000));

  async function arm(): Promise<{ tradeId: string; mandateId: string; proceeds: bigint }> {
    const invoiceId = h.seeded.invoiceIds['INV-2041'] ?? '';
    const quote = await call(h.app, 'GET', `/v1/invoices/${invoiceId}/quote${asOf}`);
    const armed = await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId, quoteId: quote.body.quoteId },
    });
    return {
      tradeId: armed.body.trade.id,
      mandateId: armed.body.trade.mandateId,
      proceeds: BigInt(armed.body.trade.proceeds),
    };
  }

  it('is reclaimed when the buyer next looks at their positions', async () => {
    const { tradeId, mandateId, proceeds } = await arm();
    const before = await h.store.getMandate(mandateId);
    const buyerId = h.seeded.buyerIds['BUY-ASHGROVE'] ?? '';

    past(EXPIRED_AFTER_SECONDS + 1);
    await call(h.app, 'GET', `/v1/trades?buyerId=${buyerId}`);

    expect((await h.store.getTrade(tradeId))?.status).toBe('unwound');
    const after = await h.store.getMandate(mandateId);
    expect(before!.allocatedMinor - after!.allocatedMinor).toBe(proceeds);
    expect(h.ats.released).toHaveLength(1);
  });

  it('is reclaimed before the capital view reports utilisation', async () => {
    const { mandateId, proceeds } = await arm();
    const before = await h.store.getMandate(mandateId);
    const buyerId = h.seeded.buyerIds['BUY-ASHGROVE'] ?? '';

    past(EXPIRED_AFTER_SECONDS + 1);
    const exposure = await call(h.app, 'GET', `/v1/mandates/exposure?buyerId=${buyerId}`);

    const after = await h.store.getMandate(mandateId);
    expect(before!.allocatedMinor - after!.allocatedMinor).toBe(proceeds);

    // The rollup on the screen is the reclaimed number, not the stale one.
    const book = await h.store.listMandates({ buyerId, limit: 200 });
    const allocated = book
      .filter((row) => row.status !== 'withdrawn')
      .reduce((sum, row) => sum + row.allocatedMinor, 0n);
    expect(exposure.status).toBe(200);
    expect(BigInt(exposure.body.allocated)).toBe(allocated);
  });

  it('frees the capital in time for the next invoice to be priced against it', async () => {
    const { mandateId, proceeds } = await arm();
    const armedAllocation = (await h.store.getMandate(mandateId))!.allocatedMinor;

    past(EXPIRED_AFTER_SECONDS + 1);
    // Arming anything else reclaims first, so a mandate cannot quote wide on capital that
    // is reserved for a trade that will never settle.
    const other = h.seeded.invoiceIds['INV-2044'] ?? '';
    const quote = await call(
      h.app,
      'GET',
      `/v1/invoices/${other}/quote?asOf=${encodeURIComponent(
        new Date(Date.parse(MARKET_NOW_ISO) + (EXPIRED_AFTER_SECONDS + 1) * 1000).toISOString(),
      )}`,
    );
    await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId: other, quoteId: quote.body.quoteId, maxSlippageBps: 25 },
    });

    const after = await h.store.getMandate(mandateId);
    expect(after!.allocatedMinor).toBeLessThanOrEqual(armedAllocation - proceeds);
  });

  it('is left alone while its challenge window is still open', async () => {
    const { tradeId, mandateId } = await arm();
    const armedAllocation = (await h.store.getMandate(mandateId))!.allocatedMinor;
    const buyerId = h.seeded.buyerIds['BUY-ASHGROVE'] ?? '';

    past(EXPIRED_AFTER_SECONDS - 30);
    await call(h.app, 'GET', `/v1/trades?buyerId=${buyerId}`);

    expect((await h.store.getTrade(tradeId))?.status).toBe('awaiting_payment');
    expect((await h.store.getMandate(mandateId))!.allocatedMinor).toBe(armedAllocation);
    expect(h.ats.released).toHaveLength(0);
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
