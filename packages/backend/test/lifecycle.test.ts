/**
 * The two lifecycles, as the product actually performs them.
 *
 * `@facture/shared/state` had exactly one production caller — `settlement.ts` guarding
 * `sold -> defaulted` — and the running service performed edges the machines refuse: every
 * trade went `confirmed -> sold`, every re-sent confirmation link went
 * `awaiting_confirmation -> awaiting_confirmation`, and every funding went `draft -> active`.
 * `listed` and `funding` were written by the seed and by nothing else.
 *
 * These are the tests for the closure of that gap, and they are deliberately written as much
 * about the **refusals** as about the happy paths: a transition table nothing consults is
 * documentation, and the only proof it is not is a forbidden edge that actually gets refused.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKET_NOW_ISO } from '../src/db/seed.js';
import { call, createHarness, listInvoice, RESALE_SIGNER, type Harness } from './helpers.js';

let h: Harness;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(MARKET_NOW_ISO));
  h = await createHarness();
});

afterEach(() => {
  vi.useRealTimers();
  h.restore();
});

const asOf = `?asOf=${encodeURIComponent(MARKET_NOW_ISO)}`;
const invoice = (label: string): string => h.seeded.invoiceIds[label] ?? '';

describe('POST /v1/invoices/:id/list', () => {
  it('offers a confirmed invoice into the book', async () => {
    const id = invoice('INV-2041');

    const res = await call(h.app, 'POST', `/v1/invoices/${id}/list`);

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('listed');
    expect(res.body.listed).toBe(true);
    expect(res.body.alreadyListed).toBe(false);
    expect((await h.store.getInvoice(id))?.status).toBe('listed');
  });

  /*
   * A double-clicked button is not an error worth failing a seller over, and answering 200
   * having written nothing is also the only shape that does not perform `listed -> listed`.
   * It matches how `POST /:id/confirmation-request` treats a repeat.
   */
  it('is idempotent, and writes nothing the second time', async () => {
    const id = invoice('INV-2041');
    await listInvoice(h.app, id);
    const after = await h.store.getInvoice(id);

    const again = await call(h.app, 'POST', `/v1/invoices/${id}/list`);

    expect(again.status).toBe(200);
    expect(again.body.alreadyListed).toBe(true);
    expect((await h.store.getInvoice(id))?.updatedAt).toEqual(after?.updatedAt);
  });

  it('refuses an invoice the customer has not confirmed', async () => {
    const res = await call(h.app, 'POST', `/v1/invoices/${invoice('INV-2049')}/list`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('invoice_not_confirmed');
    expect(res.body.detail).toContain('has not confirmed');
  });

  /*
   * The status is checked before the instrument, and the other way round from `prepareTrade`.
   * A seller whose customer has not answered must not be sent to wait on a deployment.
   */
  it('names the missing confirmation, not the missing instrument, when both are missing', async () => {
    const res = await call(h.app, 'POST', `/v1/invoices/${invoice('INV-2051')}/list`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('invoice_not_confirmed');
  });

  /*
   * The machine's own comment says this is a guard at the call site rather than a state,
   * because issuance is paced and an invoice can sit confirmed-but-not-yet-issued for
   * minutes. It is a wait, not a refusal, and it says so with the same code `prepareTrade`
   * uses for it.
   */
  it('refuses an invoice whose instrument has not landed yet', async () => {
    const id = invoice('INV-2041');
    await h.store.updateInvoice(id, { securityId: null, securityEvmAddress: null });

    const res = await call(h.app, 'POST', `/v1/invoices/${id}/list`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('issuance_pending');
    expect((await h.store.getInvoice(id))?.status).toBe('confirmed');
  });

  it('refuses every status the machine has no edge from', async () => {
    for (const label of ['INV-2029', 'INV-2031', 'INV-2043']) {
      const res = await call(h.app, 'POST', `/v1/invoices/${invoice(label)}/list`);
      expect(res.status).toBe(409);
    }
  });

  /*
   * The secondary market. `sold -> listed` used to be vetoed here outright; what is left of
   * that veto is a check about the ASSET leg, because a resale's hold has to be signed by
   * whoever holds the paper and the venue may hold no key for them.
   */
  it('refuses to relist when no resale signer is configured', async () => {
    const res = await call(h.app, 'POST', `/v1/invoices/${invoice('INV-2033')}/list`);

    expect(res.status).toBe(409);
    expect(res.body.detail).toContain('resale signer');
  });

  it('refuses to relist paper the venue holds no key for, naming the holder', async () => {
    // A signer that is a real account, but not the one holding INV-2033.
    const other = await createHarness({ env: RESALE_SIGNER('0.0.6098455') });
    try {
      const id = other.seeded.invoiceIds['INV-2033'] ?? '';
      const res = await call(other.app, 'POST', `/v1/invoices/${id}/list`);

      expect(res.status).toBe(409);
      expect(res.body.detail).toContain('Ashgrove Treasury');
      expect(res.body.detail).toContain('no key');
    } finally {
      other.restore();
    }
  });

  it('relists sold paper when the holder is one the venue can sign for', async () => {
    // Ashgrove holds INV-2033, and this is Ashgrove's account.
    const resale = await createHarness({ env: RESALE_SIGNER('0.0.6098431') });
    try {
      const id = resale.seeded.invoiceIds['INV-2033'] ?? '';
      const res = await call(resale.app, 'POST', `/v1/invoices/${id}/list`);

      expect(res.status).toBe(200);
      expect(res.body.invoice.status).toBe('listed');
      expect(res.body.listed).toBe(true);
    } finally {
      resale.restore();
    }
  });

  it('refuses an invoice that does not exist', async () => {
    const res = await call(h.app, 'POST', '/v1/invoices/00000000-0000-4000-8000-000000000000/list');
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/invoices/:id/delist', () => {
  it('takes a listed invoice back off the book without disputing anything', async () => {
    const id = invoice('INV-2038');

    const res = await call(h.app, 'POST', `/v1/invoices/${id}/delist`);

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('confirmed');
    expect(res.body.listed).toBe(false);
    expect(res.body.alreadyDelisted).toBe(false);
  });

  it('is idempotent, and writes nothing when it is already off the book', async () => {
    const id = invoice('INV-2041');
    const before = await h.store.getInvoice(id);

    const res = await call(h.app, 'POST', `/v1/invoices/${id}/delist`);

    expect(res.status).toBe(200);
    expect(res.body.alreadyDelisted).toBe(true);
    expect((await h.store.getInvoice(id))?.updatedAt).toEqual(before?.updatedAt);
  });

  /*
   * Un-selling is not a status change. It has to reverse two settlement legs on two chains,
   * which belongs to the trade record — so the refusal says so rather than reporting the
   * machine's bare "no edge from sold to confirmed".
   */
  it('reports a sold invoice as already off the book rather than delisting it', async () => {
    const res = await call(h.app, 'POST', `/v1/invoices/${invoice('INV-2033')}/delist`);

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('sold');
    expect(res.body.alreadyDelisted).toBe(true);
  });

  /*
   * Withdrawing a RESALE offer puts the paper back to `sold`, not to `confirmed`. The holder
   * still holds it — `confirmed` would say the receivable is unowned, and maturity resolves
   * who to pay from the newest live settled trade.
   */
  it('returns relisted paper to sold when its holder withdraws the offer', async () => {
    const resale = await createHarness({ env: RESALE_SIGNER('0.0.6098431') });
    try {
      const id = resale.seeded.invoiceIds['INV-2033'] ?? '';
      const listed = await call(resale.app, 'POST', `/v1/invoices/${id}/list`);
      expect(listed.body.invoice.status).toBe('listed');

      const res = await call(resale.app, 'POST', `/v1/invoices/${id}/delist`);

      expect(res.status).toBe(200);
      expect(res.body.invoice.status).toBe('sold');
      expect(res.body.listed).toBe(false);
    } finally {
      resale.restore();
    }
  });

  /*
   * The hole this closes, and the reason arming alone was not enough. Arming requires
   * `listed`, but the x402 rail leaves a gap between the challenge and the signature: delist
   * in that window and the buyer's payment writes `sold` onto a `confirmed` invoice —
   * `confirmed -> sold`, the forbidden edge, on a trade whose cash has already moved.
   */
  it('refuses to withdraw an offer a buyer is in the middle of filling', async () => {
    const id = invoice('INV-2041');
    await listInvoice(h.app, id);
    const quote = await call(h.app, 'GET', `/v1/invoices/${id}/quote${asOf}`);
    const armed = await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId: id, quoteId: quote.body.quoteId },
    });
    expect(armed.status).toBe(402);

    const res = await call(h.app, 'POST', `/v1/invoices/${id}/delist`);

    expect(res.status).toBe(409);
    expect(res.body.detail).toContain('unwind the trade first');
    expect((await h.store.getInvoice(id))?.status).toBe('listed');
  });

  it('lets the offer be withdrawn once the armed trade is unwound', async () => {
    const id = invoice('INV-2041');
    await listInvoice(h.app, id);
    const quote = await call(h.app, 'GET', `/v1/invoices/${id}/quote${asOf}`);
    const armed = await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId: id, quoteId: quote.body.quoteId },
    });
    await call(h.app, 'POST', `/v1/trades/${armed.body.trade.id}/unwind`, { body: {} });

    const res = await call(h.app, 'POST', `/v1/invoices/${id}/delist`);

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('confirmed');
  });

  it('leaves the invoice quotable, because withdrawing an offer is not withdrawing a price', async () => {
    const id = invoice('INV-2038');
    await call(h.app, 'POST', `/v1/invoices/${id}/delist`);

    const quote = await call(h.app, 'GET', `/v1/invoices/${id}/quote${asOf}`);

    expect(quote.status).toBe(200);
    expect(quote.body.quote).not.toBeNull();
  });
});

describe('arming requires an offer', () => {
  /*
   * The edge this closes. Every trade this service ever settled performed `confirmed -> sold`,
   * which the invoice machine refuses — because the venue treated "the customer confirmed it"
   * and "the seller offered it for sale" as one fact.
   */
  it('refuses to arm a confirmed invoice nobody listed', async () => {
    const id = invoice('INV-2041');
    const quote = await call(h.app, 'GET', `/v1/invoices/${id}/quote${asOf}`);

    const res = await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId: id, quoteId: quote.body.quoteId },
    });

    expect(res.status).toBe(409);
    expect(res.body.detail).toContain('has not been offered for sale');
    // Nothing reserved and no hold placed: this is a refusal, not a failed settlement.
    expect(h.ats.holds).toHaveLength(0);
    expect(h.store.trades.size).toBe(h.seeded.counts.trades);
  });

  /*
   * The other half of the split, and the reason `QUOTABLE_INVOICE_STATUSES` was left alone.
   * The book renders a live price beside every confirmed line the moment it loads; requiring
   * a listing to quote would leave it blank until a seller clicked through every row.
   */
  it('still prices a confirmed invoice nobody listed', async () => {
    const quote = await call(h.app, 'GET', `/v1/invoices/${invoice('INV-2041')}/quote${asOf}`);

    expect(quote.status).toBe(200);
    expect(quote.body.quote).not.toBeNull();
  });

  it('arms once the seller lists it', async () => {
    const id = invoice('INV-2041');
    await listInvoice(h.app, id);
    const quote = await call(h.app, 'GET', `/v1/invoices/${id}/quote${asOf}`);

    const res = await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId: id, quoteId: quote.body.quoteId },
    });

    expect(res.status).toBe(402);
  });

  /*
   * Ordering, asserted rather than assumed. An unissued invoice is told about its instrument
   * even though it is also unlisted, because "it is still being added" is the fact that will
   * change on its own and the seller has nothing to do about it.
   */
  it('reports issuance before listing, because only one of the two is a wait', async () => {
    const res = await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId: invoice('INV-2051'), quoteId: h.seeded.tradeIds['POS-02'] ?? '' },
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('issuance_pending');
  });
});

describe('re-requesting a confirmation link', () => {
  const request = (id: string) =>
    call(h.app, 'POST', `/v1/invoices/${id}/confirmation-request`, { body: {} });

  /*
   * `awaiting_confirmation -> awaiting_confirmation` is a self-edge, and the machine refuses
   * one deliberately: a no-op status write is almost always a caller that has not worked out
   * whether anything happened. Re-sending a link is the ordinary case — a lost email, an
   * expired link — so the fix is to stop writing the status, never to stop re-sending.
   */
  it('does not rewrite the status of an invoice already awaiting an answer', async () => {
    const id = invoice('INV-2049');
    const before = await h.store.getInvoice(id);
    expect(before?.status).toBe('awaiting_confirmation');

    const res = await request(id);

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('awaiting_confirmation');
  });

  /*
   * The half that must keep working. Superseding the previous link is what a re-request
   * really does, and it happens in the same transaction whether the status moves or not —
   * otherwise a stale link would silently still work.
   */
  it('still supersedes the previous link', async () => {
    const id = invoice('INV-2049');
    const first = await request(id);
    const staleToken = String(first.body.confirmation.link).split('/').at(-1) ?? '';

    await request(id);

    const stale = await call(h.app, 'GET', `/v1/confirm/${staleToken}`);
    expect(stale.status).toBe(409);
    expect(stale.body.detail).toContain('newer confirmation link');
  });

  it('still moves a draft invoice to awaiting_confirmation', async () => {
    const res = await request(invoice('INV-2051'));

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('awaiting_confirmation');
  });
});

describe('a mandate goes through funding', () => {
  const draftMandate = async (): Promise<string> => {
    const res = await call(h.app, 'POST', '/v1/mandates', {
      body: {
        buyerId: h.seeded.buyerIds['BUY-ASHGROVE'] ?? '',
        ratingFloor: 'B',
        maxTenorDays: 60,
        annualisedYieldBps: 850,
        currency: 'USD',
        exposureLimitMinor: '50000000',
      },
    });
    expect(res.status).toBe(201);
    return res.body.mandate.id as string;
  };

  /*
   * With no vault there is nothing to verify, so the mandate passes through `funding` and
   * comes out `active`. Refusing instead would stop a venue that never escrows from trading
   * at all — the same trade `chooseRail` makes for an absent vault.
   */
  it('promotes straight through when no vault is configured', async () => {
    const id = await draftMandate();

    const res = await call(h.app, 'POST', `/v1/mandates/${id}/fund`, {
      body: { amountMinor: '5000000', escrowRef: 'escrow:somewhere' },
    });

    expect(res.status).toBe(200);
    expect(res.body.mandate.status).toBe('active');
    expect(res.body.quoting).toBe(true);
    // Firm is not the same claim as escrowed, and the response keeps them apart.
    expect(res.body.escrowVerified).toBe(false);
    expect(res.body.escrow.state).toBe('not-required');
  });

  it('never leaves a mandate in draft once it has been funded', async () => {
    const id = await draftMandate();
    await call(h.app, 'POST', `/v1/mandates/${id}/fund`, {
      body: { amountMinor: '5000000', escrowRef: 'escrow:somewhere' },
    });

    expect((await h.store.getMandate(id))?.status).not.toBe('draft');
  });

  /* `listQuotableMandates` selects `active` alone, which is what parks an unbacked bid. */
  it('does not quote a mandate that is still funding', async () => {
    const id = await draftMandate();
    await h.store.fundMandate({
      mandateId: id,
      amount: 5_000_000n,
      escrowRef: 'escrow:pending',
      at: new Date(),
      firm: false,
    });

    const quotable = await h.store.listQuotableMandates('USD');

    expect((await h.store.getMandate(id))?.status).toBe('funding');
    expect(quotable.map((m) => m.id)).not.toContain(id);
  });

  /*
   * The backstop under the pricing filter above. `funding -> exhausted` is not an edge, so
   * an allocation that would move a parked bid's status is refused rather than quietly
   * writing a status the machine has no path to. It is deliberately not the whole guard: a
   * partial allocation moves no status and passes, and what actually keeps a parked bid out
   * of a match is that `listQuotableMandates` never offers it.
   */
  it('refuses an allocation that would exhaust a mandate still in funding', async () => {
    const id = await draftMandate();
    await h.store.fundMandate({
      mandateId: id,
      amount: 5_000_000n,
      escrowRef: 'escrow:pending',
      at: new Date(),
      firm: false,
    });

    await expect(h.store.allocate(id, 5_000_000n)).rejects.toThrow(/cannot go from funding/);
  });
});

describe('mandate status writes that are not transitions', () => {
  const mandate = (label: string): string => h.seeded.mandateIds[label] ?? '';

  it('does not touch the status when an allocation leaves headroom', async () => {
    const id = mandate('MND-01');
    const before = await h.store.getMandate(id);

    const after = await h.store.allocate(id, 1n);

    expect(after.status).toBe(before?.status);
    expect(after.status).toBe('active');
  });

  it('does not touch the status when a release changes nothing', async () => {
    const id = mandate('MND-01');

    const after = await h.store.release(id, 1n);

    expect(after.status).toBe('active');
  });

  /* `active -> exhausted` and back are real edges, and both still happen. */
  it('exhausts a mandate whose capital is fully allocated, and revives it', async () => {
    const id = mandate('MND-01');
    const row = await h.store.getMandate(id);
    const headroom = (row?.fundedMinor ?? 0n) - (row?.allocatedMinor ?? 0n);

    const exhausted = await h.store.allocate(id, headroom);
    expect(exhausted.status).toBe('exhausted');

    const revived = await h.store.release(id, headroom);
    expect(revived.status).toBe('active');
  });

  it('does not touch the status when a withdrawal leaves capital behind', async () => {
    const id = mandate('MND-01');

    const { mandate: after } = await h.store.withdrawFromMandate({
      mandateId: id,
      amount: 1n,
      at: new Date(),
    });

    expect(after.status).toBe('active');
  });

  /*
   * Emptying and closing are two acts now, and the split is what makes a stranded release
   * recoverable: `withdrawn` is terminal and `fundMandate` refuses it, so a mandate closed
   * before its capital was known to have left the Arc vault could never be funded again — and
   * funding again is the only route back to money still sitting in there.
   */
  it('closes a mandate emptied to zero, once', async () => {
    // Written and funded here rather than seeded, because every seeded mandate carries
    // allocations and an allocated mandate cannot be emptied — that is what "firm" means.
    const row = await h.store.insertMandate({
      buyerId: h.seeded.buyerIds['BUY-ASHGROVE'] ?? '',
      ratingFloor: 'B',
      maxTenorDays: 60,
      annualisedYieldBps: 850,
      currency: 'USD',
      exposureLimitMinor: 5_000_000n,
      perDebtorLimitMinor: null,
      status: 'draft',
    });
    const id = row.id;
    await h.store.fundMandate({
      mandateId: id,
      amount: 5_000_000n,
      escrowRef: 'escrow:somewhere',
      at: new Date(),
      firm: true,
    });

    // The book alone: an emptied mandate is still open, because whether the capital behind it
    // actually reached the buyer is not known here.
    const emptied = await h.store.withdrawFromMandate({ mandateId: id, at: new Date() });
    expect(emptied.mandate.fundedMinor).toBe(0n);
    expect(emptied.mandate.status).toBe('active');

    const first = await h.store.closeEmptiedMandate(id, new Date());
    expect(first.status).toBe('withdrawn');

    // `withdrawn` is terminal, so re-asserting it is the one self-edge that would throw.
    const second = await h.store.closeEmptiedMandate(id, new Date());
    expect(second.status).toBe('withdrawn');
  });
});
