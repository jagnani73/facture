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
import { isinForInvoice } from '@facture/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKET_NOW_ISO, seedId } from '../src/db/seed.js';
import type { IssuanceJob } from '../src/services/issuance.js';
import {
  createStoreIssuanceSink,
  initIssuanceQueue,
  IssuanceQueue,
  resumeIssuance,
  symbolFor,
} from '../src/services/issuance.js';
import { ratingService } from '../src/services/rating.js';
import { EXPIRED_AFTER_SECONDS, settlementService } from '../src/services/settlement.js';
import { call, createHarness, listInvoice, type Harness } from './helpers.js';

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

/*
 * MF-2033 falls due on 2026-09-12 and the grace is the rest of that day, so these three
 * instants are the whole on-time/late question: a venue maturing the receivable long after
 * it fell due, a payment made on the day, and a payment made after it. They are named
 * because the point of every test below is WHICH of them the outcome is computed from —
 * the answer used to be the first one, which is a fact about the venue's admin rather than
 * about the customer.
 */
const WELL_AFTER_DUE = '2026-10-03T11:00:00.000Z';
const PAID_ON_THE_DAY = '2026-09-12T09:00:00.000Z';
const PAID_LATE = '2026-09-19T09:00:00.000Z';

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

  it('counts a payment the day after the due date as late', async () => {
    vi.setSystemTime(new Date('2026-09-13T00:30:00.000Z'));

    /*
     * The stated payment date, not the clock. This test used to pass without the second
     * argument, which meant it asserted that maturing a receivable half an hour past the
     * deadline recorded the customer as having paid late — with nothing on the path
     * establishing that they had paid at all. See `when a payment counts as late` below.
     */
    const result = await settlementService.settleAtMaturity(h.seeded.invoiceIds['INV-2033'] ?? '', {
      paidAt: new Date('2026-09-13T00:15:00.000Z'),
    });

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

  it('reports the payment once the obligation has actually executed', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2033'] ?? '';
    const first = await settlementService.settleAtMaturity(invoiceId);
    expect(first.cashLeg.state).toBe('pending');

    // Someone signs. That happens outside this service, so the test makes it true of the
    // ledger rather than asking the service to do it.
    h.schedule.executedSchedules.add(first.payout?.scheduleId ?? '');

    const after = await settlementService.settleAtMaturity(invoiceId);

    expect(after.payout?.executed).toBe(true);
    expect(after.payout?.executedTransactionId).toBe('0.0.5512@1788337866.334186498');
    expect(after.cashLeg.state).toBe('settled');
    expect(after.cashLeg.transaction).toBe('0.0.5512@1788337866.334186498');
    expect(after.cashLeg.explorerUrl).toContain('0.0.5512@1788337866.334186498');
  });

  it('asks the ledger every time rather than remembering it was paid', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2033'] ?? '';
    const first = await settlementService.settleAtMaturity(invoiceId);
    const scheduleId = first.payout?.scheduleId ?? '';

    h.schedule.executedSchedules.add(scheduleId);
    expect((await settlementService.settleAtMaturity(invoiceId)).cashLeg.state).toBe('settled');

    /*
     * A payout that stops reading as executed is not a case anyone expects, but the point
     * is that nothing here caches the answer: the service holds no "paid" flag it could be
     * wrong about, and the ledger is asked on every call.
     */
    h.schedule.executedSchedules.delete(scheduleId);
    expect((await settlementService.settleAtMaturity(invoiceId)).cashLeg.state).toBe('pending');
  });

  it('names the account the money actually left, not the one configured', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2033'] ?? '';
    const first = await settlementService.settleAtMaturity(invoiceId);
    h.schedule.executedSchedules.add(first.payout?.scheduleId ?? '');

    const after = await settlementService.settleAtMaturity(invoiceId);

    // Read off the executed transfer, so a schedule created under an earlier collection
    // account is not reported against the current one.
    expect(after.cashLeg.payer).toBe('0.0.5599');
    expect(after.payout?.payerAccountId).toBe('0.0.5599');

    /*
     * And the payee likewise. A buyer's Hedera account is on file in either of its two
     * forms — three of the seeded buyers carry `0.0.x` and one carries its EVM address —
     * so the credited account is taken from the transfer rather than from the row.
     */
    expect(after.payout?.payeeAccountId).toBe('0.0.6098431');
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

  it('takes the payment date on the wire and prices the outcome off it', async () => {
    vi.setSystemTime(new Date(WELL_AFTER_DUE));

    const res = await call(h.app, 'POST', `/v1/invoices/${invoiceOf('INV-2033')}/mature`, {
      body: { paidAt: PAID_LATE },
    });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('late');
    // Echoed back, so a reader can see what the on-time call was made against rather than
    // assuming it was made against the clock — which is what it used to be made against.
    expect(res.body.paidAt).toBe(PAID_LATE);
  });

  it('refuses to guess when a past-due receivable arrives with no payment date', async () => {
    vi.setSystemTime(new Date(WELL_AFTER_DUE));

    const res = await call(h.app, 'POST', `/v1/invoices/${invoiceOf('INV-2033')}/mature`);

    expect(res.status).toBe(409);
    expect(res.body.detail).toContain('past due');
    expect(res.body.detail).toContain('paidAt');
  });
});

/**
 * The on-time / late distinction, which used to be a statement about the venue's admin.
 *
 * `late` was decided by comparing the DUE DATE against the moment the operator pressed the
 * maturity button. Nothing on that path establishes that the debtor paid at all, so an
 * overdue receivable matured after the fact — including one that was never going to be paid
 * — was written to the rating ledger as a customer who paid late. That is a permanent
 * widening of their curve for every seller afterwards, sourced from when someone got round
 * to clicking.
 *
 * The debtor pays into the venue's collection account off chain, so the date the money
 * landed is stated rather than observed. Everything below is about that one input.
 */
describe('when a payment counts as late', () => {
  /** MF-2033 falls due on the 12th; the grace is the rest of that day and no more. */
  const invoiceId = (): string => h.seeded.invoiceIds['INV-2033'] ?? '';
  const debtorId = (): string => h.seeded.debtorIds['DBT-LUMEN'] ?? '';

  it('is late only when the venue says the money landed after the due date', async () => {
    vi.setSystemTime(new Date(WELL_AFTER_DUE));
    const before = await h.store.getDebtor(debtorId());

    const result = await settlementService.settleAtMaturity(invoiceId(), {
      paidAt: new Date(PAID_LATE),
    });

    expect(result.outcome).toBe('late');
    expect((await h.store.getDebtor(debtorId()))?.settledLate).toBe((before?.settledLate ?? 0) + 1);
  });

  it('is on time for a payment made on the due date, however late the venue records it', async () => {
    vi.setSystemTime(new Date(WELL_AFTER_DUE));
    const before = await h.store.getDebtor(debtorId());

    /*
     * The case the old comparison got wrong every time. The debtor paid at nine in the
     * morning on the day the invoice fell due; the venue matured it three weeks later. The
     * customer paid on time and the ledger has to say so.
     */
    const result = await settlementService.settleAtMaturity(invoiceId(), {
      paidAt: new Date(PAID_ON_THE_DAY),
    });

    expect(result.outcome).toBe('on_time');
    const after = await h.store.getDebtor(debtorId());
    expect(after?.settledOnTime).toBe((before?.settledOnTime ?? 0) + 1);
    expect(after?.settledLate).toBe(before?.settledLate);
  });

  it('refuses a past-due receivable with no payment date rather than calling it late', async () => {
    vi.setSystemTime(new Date(WELL_AFTER_DUE));
    const before = await h.store.getDebtor(debtorId());

    await expect(settlementService.settleAtMaturity(invoiceId())).rejects.toThrow(/past due/);

    /*
     * And it refuses before writing anything. "We do not know whether this was paid" is not
     * a rating input, and half-recording one would be worse than the guess it replaced:
     * the ledger is written once per receivable and the first write is the one that stands.
     */
    const after = await h.store.getDebtor(debtorId());
    expect(after?.settledLate).toBe(before?.settledLate);
    expect(after?.settledOnTime).toBe(before?.settledOnTime);
    expect((await h.store.getInvoice(invoiceId()))?.status).toBe('sold');
  });

  it('still needs no payment date while the receivable is not yet past due', async () => {
    // Unchanged, and it is the ordinary case: there is no instant left at which the payment
    // could have been late, so nothing has to be stated for the answer to be sound.
    const result = await settlementService.settleAtMaturity(invoiceId());

    expect(result.outcome).toBe('on_time');
  });

  it('refuses a payment date that has not happened yet', async () => {
    await expect(
      settlementService.settleAtMaturity(invoiceId(), { paidAt: new Date(WELL_AFTER_DUE) }),
    ).rejects.toThrow(/in the future/);
  });

  it('refuses a payment date from before the invoice was raised', async () => {
    vi.setSystemTime(new Date(WELL_AFTER_DUE));

    await expect(
      settlementService.settleAtMaturity(invoiceId(), {
        paidAt: new Date('2026-07-01T00:00:00.000Z'),
      }),
    ).rejects.toThrow(/before invoice/);
  });

  it('reports what the ledger holds, not what the second call worked out', async () => {
    await settlementService.settleAtMaturity(invoiceId());

    vi.setSystemTime(new Date(WELL_AFTER_DUE));
    const replay = await settlementService.settleAtMaturity(invoiceId(), {
      paidAt: new Date(PAID_LATE),
    });

    /*
     * The ledger is written once per receivable and is the authority afterwards, because it
     * is what the curve reads. A replay that reported its own recomputed answer would tell a
     * seller their customer paid late on a call that wrote nothing.
     */
    expect(replay.alreadyRecorded).toBe(true);
    expect(replay.outcome).toBe('on_time');
    expect((await h.store.getDebtor(debtorId()))?.settledLate).toBe(0);
  });
});

/**
 * Writing a receivable off.
 *
 * The other end of the rating loop, and the half that makes the rest of it worth reading: a
 * grade earned from settled history prices nothing unless the bad history is in it. Before
 * this existed `SettlementOutcome: 'default'` had no producer and no route wrote
 * `invoices.status = 'defaulted'`, so the permanent mark the whole self-correcting argument
 * rests on was unreachable — and maturing an overdue unpaid receivable recorded it as
 * `late`, which is a write-off entered in the ledger as a payment.
 */
describe('default', () => {
  const invoiceId = (): string => h.seeded.invoiceIds['INV-2033'] ?? '';
  const debtorId = (): string => h.seeded.debtorIds['DBT-LUMEN'] ?? '';

  /** Nothing may be written off before it has actually failed to be paid. */
  beforeEach(() => {
    vi.setSystemTime(new Date(WELL_AFTER_DUE));
  });

  it('marks the customer permanently and moves the invoice to defaulted', async () => {
    const result = await settlementService.recordDefault(invoiceId());

    expect(result.outcome).toBe('default');
    expect(result.rating.grade).toBe('D');
    expect(result.rating.permanentlyMarked).toBe(true);
    expect((await h.store.getInvoice(invoiceId()))?.status).toBe('defaulted');
    expect((await h.store.getDebtor(debtorId()))?.defaulted).toBe(1);
  });

  it('names who took the loss, and how much of it', async () => {
    const trade = await h.store.getTrade(h.seeded.tradeIds['TRD-4417'] ?? '');

    const result = await settlementService.recordDefault(invoiceId());

    expect(result.holder.buyerId).toBe(h.seeded.buyerIds['BUY-ASHGROVE']);
    expect(result.lossMinor).toBe(trade?.proceedsMinor.toString(10));
    expect(result.faceValueMinor).toBe('9500000');
  });

  it('marks the customer once, however many times it is declared', async () => {
    await settlementService.recordDefault(invoiceId());
    const once = await h.store.getDebtor(debtorId());

    /*
     * A default is declared by a person pressing a button, and a person presses a button
     * twice. Idempotency here is the same unique index maturity relies on — `(debtor_id,
     * invoice_id)` on the settlement-outcome ledger — so the second declaration finds the
     * fact already written and moves nothing.
     */
    const replay = await settlementService.recordDefault(invoiceId());
    const twice = await h.store.getDebtor(debtorId());

    expect(replay.alreadyRecorded).toBe(true);
    expect(replay.outcome).toBe('default');
    expect(twice?.defaulted).toBe(once?.defaulted);
    expect(twice?.defaulted).toBe(1);
    expect((await h.store.getInvoice(invoiceId()))?.status).toBe('defaulted');
  });

  it('does not hand the mandate back capital the buyer lost', async () => {
    const trade = await h.store.getTrade(h.seeded.tradeIds['TRD-4417'] ?? '');
    const before = await h.store.getMandate(trade?.mandateId ?? '');

    await settlementService.recordDefault(invoiceId());

    /*
     * The opposite of maturity, deliberately. Maturity releases because the face value came
     * in and the position closed whole; here it closes at zero and the buyer takes the loss,
     * so releasing would let the bid quote again on money that is gone.
     */
    const after = await h.store.getMandate(trade?.mandateId ?? '');
    expect(after?.allocatedMinor).toBe(before?.allocatedMinor);
  });

  it('refuses a receivable that has already matured', async () => {
    await settlementService.settleAtMaturity(invoiceId(), { paidAt: new Date(PAID_ON_THE_DAY) });

    await expect(settlementService.recordDefault(invoiceId())).rejects.toThrow(
      /already matured — the debtor paid it/,
    );
    expect((await h.store.getDebtor(debtorId()))?.defaulted).toBe(0);
    expect((await h.store.getInvoice(invoiceId()))?.status).toBe('matured');
  });

  it('refuses to overwrite a settlement already on the rating ledger', async () => {
    /*
     * The case only the ledger can distinguish. A maturity that wrote its outcome and died
     * before moving the invoice leaves `on_time` on the ledger and `sold` on the row — from
     * outside, identical to a default that tore in the same place. Going ahead would move
     * the invoice to `defaulted` over a ledger saying the customer paid, and the accumulator
     * would side with the payment for ever.
     */
    await h.store.recordOutcome({
      debtorId: debtorId(),
      invoiceId: invoiceId(),
      outcome: 'on_time',
      faceValue: 9_500_000n,
      at: new Date(PAID_ON_THE_DAY),
    });

    await expect(settlementService.recordDefault(invoiceId())).rejects.toThrow(
      /already recorded on the rating ledger as paid on time/,
    );
    expect((await h.store.getInvoice(invoiceId()))?.status).toBe('sold');
    expect((await h.store.getDebtor(debtorId()))?.defaulted).toBe(0);
  });

  it('refuses a receivable that is not yet overdue', async () => {
    vi.setSystemTime(new Date(MARKET_NOW_ISO));

    await expect(settlementService.recordDefault(invoiceId())).rejects.toThrow(/not due until/);
    expect((await h.store.getDebtor(debtorId()))?.defaulted).toBe(0);
  });

  it('refuses an invoice the lifecycle does not allow to be written off', async () => {
    /*
     * MF-2041 is confirmed and unsold. The refusal comes from the invoice machine in
     * `@facture/shared` rather than a list of statuses copied into this service — a copy is
     * how the two come to disagree, and the disagreement shows up as a permanent mark on a
     * customer whose invoice nobody ever bought.
     */
    await expect(
      settlementService.recordDefault(h.seeded.invoiceIds['INV-2041'] ?? ''),
    ).rejects.toThrow(/cannot go from confirmed to defaulted/);
  });

  it('refuses a receivable that never settled', async () => {
    /*
     * MF-2043 is disputed, which the lifecycle DOES allow to default — a dispute resolved
     * against the seller, or simply never paid. It was never sold, so there is no position
     * to write off: the rating ledger is one row per settled receivable, and a grade built
     * from invoices the venue never priced or delivered would be a record of the seller's
     * collections rather than of the customer.
     */
    await expect(
      settlementService.recordDefault(h.seeded.invoiceIds['INV-2043'] ?? ''),
    ).rejects.toThrow(/never settled/);
  });

  it('will not let a written-off receivable be matured afterwards', async () => {
    await settlementService.recordDefault(invoiceId());

    /*
     * The reverse guard, and it has to be the ledger's rather than the invoice status's: a
     * maturity that got past it would release the mandate's capital and replace a permanent
     * mark with a payment, which is the same corruption in the other direction.
     */
    await expect(
      settlementService.settleAtMaturity(invoiceId(), { paidAt: new Date(PAID_LATE) }),
    ).rejects.toThrow(/recorded as defaulted/);
    expect((await h.store.getInvoice(invoiceId()))?.status).toBe('defaulted');
    expect((await h.store.getDebtor(debtorId()))?.settledLate).toBe(0);
  });

  it('widens the customer for every seller afterwards, not just this one', async () => {
    await settlementService.recordDefault(invoiceId());

    // The mark is on the customer, and `D` ranks BELOW `UNRATED` in `@facture/shared` — so a
    // mandate written with the widest floor a buyer can pick still refuses them.
    const assessment = await ratingService.ratingFor(debtorId());
    expect(assessment.rating).toBe('D');
    expect(assessment.permanentlyMarked).toBe(true);
    expect(assessment.nextGradeAt).toBeNull();

    // And the stored projection moved with it. The book's list screen renders that column
    // rather than recomputing per row, so a grade left behind there is a customer still
    // being quoted at their old price on the one screen a seller actually looks at.
    expect((await h.store.getDebtor(debtorId()))?.rating).toBe('D');
  });
});

describe('POST /v1/invoices/:id/default', () => {
  const invoiceOf = (label: string): string => h.seeded.invoiceIds[label] ?? '';

  beforeEach(() => {
    vi.setSystemTime(new Date(WELL_AFTER_DUE));
  });

  it('runs the path end to end and reports the mark', async () => {
    const res = await call(h.app, 'POST', `/v1/invoices/${invoiceOf('INV-2033')}/default`);

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('defaulted');
    expect(res.body.outcome).toBe('default');
    expect(res.body.holder.buyerId).toBe(h.seeded.buyerIds['BUY-ASHGROVE']);
    expect(res.body.rating.grade).toBe('D');
    expect(res.body.rating.permanentlyMarked).toBe(true);
    expect(res.body.proofUrl).toBe(`/v1/trades/${h.seeded.tradeIds['TRD-4417']}/proof`);
  });

  it('is safe to press twice', async () => {
    await call(h.app, 'POST', `/v1/invoices/${invoiceOf('INV-2033')}/default`);
    const again = await call(h.app, 'POST', `/v1/invoices/${invoiceOf('INV-2033')}/default`);

    expect(again.status).toBe(200);
    expect(again.body.alreadyRecorded).toBe(true);
    expect((await h.store.getDebtor(h.seeded.debtorIds['DBT-LUMEN'] ?? ''))?.defaulted).toBe(1);
  });

  it('refuses a matured receivable in words, not a bare error', async () => {
    await call(h.app, 'POST', `/v1/invoices/${invoiceOf('INV-2033')}/mature`, {
      body: { paidAt: PAID_ON_THE_DAY },
    });

    const res = await call(h.app, 'POST', `/v1/invoices/${invoiceOf('INV-2033')}/default`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('conflict');
    expect(res.body.detail).toContain('the debtor paid it');
  });

  it('refuses an invoice that never sold, in words', async () => {
    const res = await call(h.app, 'POST', `/v1/invoices/${invoiceOf('INV-2043')}/default`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('conflict');
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
    // A sale needs an offer, and the seeded book is confirmed rather than listed.
    await listInvoice(h.app, invoiceId);
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
    await listInvoice(h.app, invoiceId);
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
    await listInvoice(h.app, invoiceId);
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
    await listInvoice(h.app, invoiceId);
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
    await listInvoice(h.app, invoiceId);
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
  const past = (seconds: number): void => {
    vi.setSystemTime(new Date(Date.parse(MARKET_NOW_ISO) + seconds * 1000));
  };

  async function arm(): Promise<{ tradeId: string; mandateId: string; proceeds: bigint }> {
    const invoiceId = h.seeded.invoiceIds['INV-2041'] ?? '';
    await listInvoice(h.app, invoiceId);
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

/**
 * Work queued before the process stopped.
 *
 * The durable `issuance_jobs` row existed and nothing ever read it: `enqueue` was only called
 * when an invoice was created, so an invoice queued before a restart stayed queued forever.
 * The book reported it as "being added", which to a seller is indistinguishable from issuance
 * that is genuinely in progress — the work had simply been dropped.
 */
describe('resuming issuance after a restart', () => {
  it('re-enqueues work that was queued before the process stopped', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2051'] ?? '';

    /*
     * The demo book seeds two invoices as `queued` with NO durable job behind them, which is
     * precisely the disagreement this reads through: the projection says "being added" and the
     * job table has never heard of them. Resuming from `issuance_jobs` alone would leave both
     * saying that forever.
     */
    const deployed: string[] = [];
    initIssuanceQueue({
      minIntervalMs: 0,
      maxAttempts: 2,
      backoffBaseMs: 1,
      sink: createStoreIssuanceSink(),
      deploy: (job) => {
        deployed.push(job.invoiceId);
        return Promise.resolve({
          securityId: '0.0.777777',
          evmAddress: `0x${'cd'.repeat(20)}` as const,
          isin: 'US0000000000',
          transactionId: '0.0.5512@1756000400.000000001',
          gasUsed: 6_978_091,
        });
      },
    });

    const resumed = await resumeIssuance();
    expect(resumed).toBe(2);

    /*
     * Polls the STORE, not the queue's in-memory status. The queue marks a job issued before
     * its sink write lands, so watching the queue and asserting on the row is a race the test
     * would lose intermittently.
     */
    for (let i = 0; i < 400; i += 1) {
      if ((await h.store.getInvoice(invoiceId))?.issuanceState === 'issued') break;
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(deployed).toContain(invoiceId);
    expect((await h.store.getInvoice(invoiceId))?.issuanceState).toBe('issued');
  });

  it('deploys the instrument the seller was originally told about', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2051'] ?? '';
    const invoice = await h.store.getInvoice(invoiceId);

    const jobs: IssuanceJob[] = [];
    initIssuanceQueue({
      minIntervalMs: 0,
      maxAttempts: 2,
      backoffBaseMs: 1,
      sink: createStoreIssuanceSink(),
      deploy: (job) => {
        jobs.push(job);
        return Promise.resolve({
          securityId: '0.0.777777',
          evmAddress: `0x${'cd'.repeat(20)}` as const,
          isin: 'US0000000000',
          transactionId: '0.0.5512@1756000400.000000001',
          gasUsed: 6_978_091,
        });
      },
    });

    await resumeIssuance();
    for (let i = 0; i < 400; i += 1) {
      if ((await h.store.getInvoice(invoiceId))?.issuanceState === 'issued') break;
      await new Promise((r) => setTimeout(r, 5));
    }

    /*
     * A resumed job has to rebuild the same instrument the original enqueue described. The
     * ISIN is the invoice's own — deterministic from its uniqueness hash, which is what stops
     * one receivable acquiring two instruments across a restart — and the symbol comes from
     * the shared `symbolFor` rather than a second copy of the rule.
     */
    const resumedJob = jobs.find((j) => j.invoiceId === invoiceId);
    expect(resumedJob).toBeDefined();
    /*
     * The invoice's own ISIN when it has one, and otherwise the same value derived from its
     * uniqueness hash — `isinForInvoice` is deterministic, so a receivable queued before a
     * restart cannot come back describing a different instrument. This seeded draft has no
     * stored ISIN yet, which is exactly the case the fallback exists for.
     */
    expect(resumedJob?.isin).toBe(invoice?.isin ?? isinForInvoice(invoice?.uniquenessHash ?? '0x'));
    expect(resumedJob?.symbol).toBe(symbolFor(invoice?.invoiceNumber ?? ''));
    expect(resumedJob?.maturityAt.getTime()).toBe(invoice?.dueAt.getTime());
    expect(resumedJob?.faceValue).toBe(invoice?.faceValue);
  });

  it('does not retry an issuance that already gave up', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2052'] ?? '';
    /*
     * `failed` has exhausted its attempts and its reason is usually deterministic —
     * `onlyValidISIN` does not become valid on the seventh try. Resuming it on every restart
     * would be a permanent retry loop against a testnet.
     */
    await h.store.updateInvoice(invoiceId, {
      issuanceState: 'failed',
      issuanceAttempts: 6,
      issuanceError: 'CONTRACT_REVERT_EXECUTED: onlyValidISIN',
    });

    const deployed: string[] = [];
    initIssuanceQueue({
      minIntervalMs: 0,
      maxAttempts: 2,
      backoffBaseMs: 1,
      sink: createStoreIssuanceSink(),
      deploy: (job) => {
        deployed.push(job.invoiceId);
        return Promise.resolve({
          securityId: '0.0.777777',
          evmAddress: `0x${'cd'.repeat(20)}` as const,
          isin: 'US0000000000',
          transactionId: '0.0.5512@1756000400.000000001',
          gasUsed: 6_978_091,
        });
      },
    });

    await resumeIssuance();
    expect(deployed).not.toContain(invoiceId);
  });

  it('is a no-op when nothing was left queued', async () => {
    for (const key of ['INV-2051', 'INV-2052']) {
      await h.store.updateInvoice(h.seeded.invoiceIds[key] ?? '', { issuanceState: 'issued' });
    }

    initIssuanceQueue({ minIntervalMs: 0, maxAttempts: 2, backoffBaseMs: 1 });
    expect(await resumeIssuance()).toBe(0);
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
          isin: 'US0000000000',
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
