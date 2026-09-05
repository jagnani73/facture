/**
 * The API, end to end.
 *
 * Every route in the service is exercised here against the real handlers, the real quote
 * engine and the real settlement orchestration — only the database, Hedera and the x402
 * facilitator are replaced, and each of those with something that behaves the way the real
 * one is documented to.
 *
 * The one thing these tests are really for: a handler that has never executed is written,
 * not implemented.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKET_NOW_ISO } from '../src/db/seed.js';
import { settlementService } from '../src/services/settlement.js';
import { X402_HEADERS } from '../src/services/x402.js';
import { call, createHarness, createRefusingGate, type Harness } from './helpers.js';

let h: Harness;

/*
 * Freeze the clock at the market's own `asOf`.
 *
 * The seeded book is priced at MARKET_NOW_ISO and a quote lives five minutes, but the trade
 * route checks expiry against the real `Date.now()`. Without a frozen clock the suite passes
 * only while wall-clock UTC happens to sit inside that five-minute window and fails for
 * everyone afterwards — which is exactly what it started doing. Freezing here makes the
 * expiry check deterministic without weakening it: the route still refuses a genuinely
 * expired quote, and there is a test below that advances time to prove it.
 */
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

describe('POST /v1/invoices', () => {
  const body = () => ({
    sellerId: h.seeded.sellerId,
    debtor: { name: 'Kestrel Provisioning', email: 'ap@kestrel.example' },
    invoiceNumber: 'MF-3001',
    faceValue: '5500000',
    currency: 'usd',
    issuedAt: '2026-09-01T00:00:00.000Z',
    dueAt: '2026-11-01T00:00:00.000Z',
  });

  it('accepts with 202, because the instrument does not exist yet', async () => {
    const res = await call(h.app, 'POST', '/v1/invoices', { body: body() });

    expect(res.status).toBe(202);
    expect(res.body.invoice.status).toBe('draft');
    expect(res.body.invoice.faceValue).toBe('5500000');
    expect(res.body.invoice.currency).toBe('USD');
    expect(res.body.issuance.state).toBe('queued');
  });

  it('registers the receivable and seeds the ISIN from the same hash', async () => {
    const res = await call(h.app, 'POST', '/v1/invoices', { body: body() });

    expect(res.body.invoice.uniquenessHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(res.body.invoice.isin).toMatch(/^US[0-9A-Z]{9}\d$/);
  });

  it('refuses the same receivable twice — one receivable, one instrument, ever', async () => {
    await call(h.app, 'POST', '/v1/invoices', { body: body() });
    const second = await call(h.app, 'POST', '/v1/invoices', { body: body() });

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('duplicate_receivable');
    expect(second.body.detail).toContain('already been tokenised');
  });

  it('rejects a major-unit amount rather than guessing the scale', async () => {
    const res = await call(h.app, 'POST', '/v1/invoices', {
      body: { ...body(), faceValue: '55000.00' },
    });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.errors[0].path).toBe('faceValue');
  });

  it('rejects an invoice that falls due before it was issued', async () => {
    const res = await call(h.app, 'POST', '/v1/invoices', {
      body: { ...body(), dueAt: '2026-08-01T00:00:00.000Z' },
    });

    expect(res.status).toBe(400);
  });
});

describe('GET /v1/invoices', () => {
  it('prices the whole page in one pass, with a live quote beside each row', async () => {
    const res = await call(h.app, 'GET', `/v1/invoices?sellerId=${h.seeded.sellerId}&limit=200`);

    expect(res.status).toBe(200);
    const rows = res.body.invoices;
    expect(rows.length).toBeGreaterThan(10);

    const mf2046 = rows.find((r) => r.invoiceNumber === 'MF-2046');
    expect(mf2046.quote.annualisedYieldBps).toBe(1850);
    expect(mf2046.debtor.rating).toBe('C');

    const mf2047 = rows.find((r) => r.invoiceNumber === 'MF-2047');
    expect(mf2047.quote).toBeNull();
    expect(mf2047.mandatesMatching).toBe(0);
  });

  it('shows an unissued invoice as still being added', async () => {
    const res = await call(h.app, 'GET', `/v1/invoices?sellerId=${h.seeded.sellerId}&limit=200`);
    const beingAdded = res.body.invoices.find((r) => r.invoiceNumber === 'MF-2051');

    expect(beingAdded.issuance.state).toBe('queued');
    expect(beingAdded.securityId).toBeNull();
  });

  it('pages by keyset', async () => {
    const first = await call(h.app, 'GET', `/v1/invoices?sellerId=${h.seeded.sellerId}&limit=5`);
    expect(first.body.invoices).toHaveLength(5);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await call(
      h.app,
      'GET',
      `/v1/invoices?sellerId=${h.seeded.sellerId}&limit=5&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    const firstIds = new Set(first.body.invoices.map((r) => r.id));
    expect(second.body.invoices.some((r) => firstIds.has(r.id))).toBe(false);
  });
});

describe('GET /v1/invoices/:id/quote', () => {
  it('returns the price that is already there, plus the reasons it is not better', async () => {
    const res = await call(
      h.app,
      'GET',
      `/v1/invoices/${h.seeded.invoiceIds['INV-2046']}/quote${asOf}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.quote.proceeds).toBe('5933178');
    expect(res.body.quoteId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.mandatesConsidered).toBe(6);
    expect(res.body.mandatesMatching).toBe(1);
    expect(res.body.refusals).toHaveLength(5);
  });

  it('renders every amount as a decimal string, which is why c.json does not throw', async () => {
    const res = await call(
      h.app,
      'GET',
      `/v1/invoices/${h.seeded.invoiceIds['INV-2046']}/quote${asOf}`,
    );
    const concentration = res.body.refusals.find((r) => r.code === 'DEBTOR_CONCENTRATION');

    expect(typeof res.body.quote.faceValue).toBe('string');
    expect(concentration.detail.required).toBe('6029445');
    expect(concentration.detail.maxPerDebtor).toBe('4000000');
  });

  it('reuses the same quote id while the price has not moved', async () => {
    const path = `/v1/invoices/${h.seeded.invoiceIds['INV-2046']}/quote${asOf}`;
    const first = await call(h.app, 'GET', path);
    const second = await call(h.app, 'GET', path);

    expect(second.body.quoteId).toBe(first.body.quoteId);
    expect(h.store.quotes.size).toBe(h.seeded.counts.trades + 1);
  });

  it('omits refusals when the caller says so', async () => {
    const res = await call(
      h.app,
      'GET',
      `/v1/invoices/${h.seeded.invoiceIds['INV-2046']}/quote${asOf}&includeRefusals=false`,
    );
    expect(res.body.refusals).toBeUndefined();
  });
});

describe('debtor confirmation', () => {
  async function requestLink(invoiceLabel: string) {
    const invoiceId = h.seeded.invoiceIds[invoiceLabel] ?? '';
    const res = await call(h.app, 'POST', `/v1/invoices/${invoiceId}/confirmation-request`, {
      body: {},
    });
    const token = String(res.body.confirmation.link).split('/').at(-1) ?? '';
    return { invoiceId, res, token };
  }

  it('sends a link and moves the invoice to awaiting_confirmation', async () => {
    const { res } = await requestLink('INV-2051');

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('awaiting_confirmation');
    expect(res.body.confirmation.sentTo).toBe('accounts@northwind.example');
  });

  it('shows the debtor one sentence and two buttons, and nothing about the market', async () => {
    const { token } = await requestLink('INV-2051');
    const res = await call(h.app, 'GET', `/v1/confirm/${token}`);

    expect(res.status).toBe(200);
    expect(res.body.sentence).toBe(
      'Meridian Fabrication says you owe them $12,250.00, due 30 September. Is that right?',
    );
    expect(res.body.actions).toEqual(['confirmed', 'disputed']);
    expect(JSON.stringify(res.body)).not.toContain('mandate');
    expect(JSON.stringify(res.body)).not.toContain('isin');
  });

  it('turns the invoice green on confirmation — now it has a price', async () => {
    const { invoiceId, token } = await requestLink('INV-2051');
    const res = await call(h.app, 'POST', `/v1/confirm/${token}`, {
      body: { decision: 'confirmed' },
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('confirmed');
    expect((await h.store.getInvoice(invoiceId))?.status).toBe('confirmed');
  });

  it('is single-use', async () => {
    const { token } = await requestLink('INV-2051');
    await call(h.app, 'POST', `/v1/confirm/${token}`, { body: { decision: 'confirmed' } });
    const again = await call(h.app, 'POST', `/v1/confirm/${token}`, {
      body: { decision: 'disputed', note: 'changed my mind' },
    });

    expect(again.status).toBe(409);
    expect(again.body.detail).toContain('already been used');
  });

  it('invalidates the previous link when a new one is requested', async () => {
    const first = await requestLink('INV-2051');
    await requestLink('INV-2051');
    const res = await call(h.app, 'GET', `/v1/confirm/${first.token}`);

    expect(res.status).toBe(409);
    expect(res.body.detail).toContain('newer confirmation link');
  });

  it('rejects a forged token on arithmetic, before touching the database', async () => {
    const res = await call(h.app, 'GET', `/v1/confirm/${'x'.repeat(40)}.${'y'.repeat(22)}`);
    expect(res.status).toBe(404);
  });

  it('makes a disputed invoice unquotable, and says why', async () => {
    const { invoiceId, token } = await requestLink('INV-2051');
    await call(h.app, 'POST', `/v1/confirm/${token}`, {
      body: { decision: 'disputed', note: 'we paid this in August' },
    });

    const quote = await call(h.app, 'GET', `/v1/invoices/${invoiceId}/quote${asOf}`);
    expect(quote.body.quote).toBeNull();
    expect(quote.body.refusals[0].code).toBe('INVOICE_NOT_CONFIRMED');
    expect(quote.body.refusals[0].humanReason).toContain('disputed by the customer');
  });

  it('will not re-ask a customer who has already answered', async () => {
    const { invoiceId, token } = await requestLink('INV-2051');
    await call(h.app, 'POST', `/v1/confirm/${token}`, { body: { decision: 'confirmed' } });
    const res = await call(h.app, 'POST', `/v1/invoices/${invoiceId}/confirmation-request`, {
      body: {},
    });

    expect(res.status).toBe(409);
  });
});

describe('mandates', () => {
  const buyerId = () => h.seeded.buyerIds['BUY-ASHGROVE'] ?? '';

  const draft = () => ({
    buyerId: buyerId(),
    ratingFloor: 'B' as const,
    maxTenorDays: 75,
    annualisedYieldBps: 1000,
    currency: 'usd',
    exposureLimitMinor: '10000000',
    perDebtorLimitMinor: '4000000',
  });

  it('creates a mandate as a draft — it is not on the curve until it is funded', async () => {
    const res = await call(h.app, 'POST', '/v1/mandates', { body: draft() });

    expect(res.status).toBe(201);
    expect(res.body.mandate.status).toBe('draft');
    expect(res.body.quoting).toBe(false);
    expect(res.body.mandate.committed).toBe('0');
  });

  it('refuses a per-customer cap above the pool it sits under', async () => {
    const res = await call(h.app, 'POST', '/v1/mandates', {
      body: { ...draft(), perDebtorLimitMinor: '20000000' },
    });
    expect(res.status).toBe(400);
  });

  it('makes the bid firm at funding, and only then', async () => {
    const created = await call(h.app, 'POST', '/v1/mandates', { body: draft() });
    const id = created.body.mandate.id;

    const before = await call(
      h.app,
      'GET',
      `/v1/invoices/${h.seeded.invoiceIds['INV-2044']}/quote${asOf}`,
    );

    const funded = await call(h.app, 'POST', `/v1/mandates/${id}/fund`, {
      body: { amountMinor: '10000000', escrowRef: 'escrow:test-1' },
    });
    expect(funded.body.mandate.status).toBe('active');
    expect(funded.body.quoting).toBe(true);

    const after = await call(
      h.app,
      'GET',
      `/v1/invoices/${h.seeded.invoiceIds['INV-2044']}/quote${asOf}`,
    );
    expect(after.body.mandatesConsidered).toBe(before.body.mandatesConsidered + 1);
  });

  it('refuses funding beyond the exposure limit the buyer wrote', async () => {
    const created = await call(h.app, 'POST', '/v1/mandates', { body: draft() });
    const res = await call(h.app, 'POST', `/v1/mandates/${created.body.mandate.id}/fund`, {
      body: { amountMinor: '20000000', escrowRef: 'escrow:test-2' },
    });
    expect(res.status).toBe(409);
  });

  it('withdraws only unallocated capital', async () => {
    const id = h.seeded.mandateIds['MND-03'] ?? '';
    const mandate = await h.store.getMandate(id);
    const allocated = mandate?.allocatedMinor ?? 0n;

    const tooMuch = await call(h.app, 'POST', `/v1/mandates/${id}/withdraw`, {
      body: { amountMinor: '15000000' },
    });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.code).toBe('insufficient_mandate_balance');

    const all = await call(h.app, 'POST', `/v1/mandates/${id}/withdraw`, { body: {} });
    expect(all.status).toBe(200);
    expect(BigInt(all.body.withdrawn)).toBe(15_000_000n - allocated);
    // Allocated capital is committed against trades and stays put; that is what firm means.
    expect(BigInt(all.body.mandate.committed)).toBe(allocated);
  });

  it('reports exposure across the buyer’s whole book, by customer and by bucket', async () => {
    const res = await call(h.app, 'GET', `/v1/mandates/exposure?buyerId=${buyerId()}`);

    expect(res.status).toBe(200);
    expect(BigInt(res.body.committed)).toBe(50_000_000n + 40_000_000n + 6_000_000n);
    expect(res.body.byDebtor.length).toBeGreaterThan(0);
    expect(res.body.byBucket.map((b) => b.bucket)).toContain('A/60d');
    expect(res.body.utilisationBps).toBeGreaterThan(0);
  });

  it('reports one mandate’s concentration against its own cap', async () => {
    const id = h.seeded.mandateIds['MND-03'] ?? '';
    const res = await call(h.app, 'GET', `/v1/mandates/${id}/exposure`);

    const petra = res.body.byDebtor.find((d) => d.debtorName === 'Petra Foods Group');
    expect(res.body.perDebtorLimit).toBe('4000000');
    expect(petra.committed).toBe('3496438');
    expect(petra.remaining).toBe('503562');
  });

  it('lists a buyer’s mandates with their capital broken out', async () => {
    const res = await call(h.app, 'GET', `/v1/mandates?buyerId=${buyerId()}`);
    expect(res.body.mandates).toHaveLength(3);
    expect(res.body.mandates.every((m) => m.quoting)).toBe(true);
  });
});

describe('POST /v1/trades — cross-chain DvP', () => {
  async function armTrade(invoiceLabel = 'INV-2041') {
    const invoiceId = h.seeded.invoiceIds[invoiceLabel] ?? '';
    const quote = await call(h.app, 'GET', `/v1/invoices/${invoiceId}/quote${asOf}`);
    const armed = await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId, quoteId: quote.body.quoteId, maxSlippageBps: 25 },
    });
    return { invoiceId, quoteId: quote.body.quoteId, armed };
  }

  it('answers 402 with the challenge, holding the asset leg and moving nothing', async () => {
    const { armed } = await armTrade();

    expect(armed.status).toBe(402);
    expect(armed.body.assetLeg.state).toBe('held');
    expect(armed.body.trade.status).toBe('awaiting_payment');
    expect(armed.body.accepts[0].scheme).toBe('exact');
    expect(armed.body.accepts[0].asset).toBe('0.0.0');
    expect(armed.headers.get(X402_HEADERS.required)).toBeTruthy();
    expect(h.ats.holds).toHaveLength(1);
    expect(h.ats.executed).toHaveLength(0);
  });

  it('reads extra.feePayer off the facilitator instead of hardcoding it', async () => {
    const { armed } = await armTrade();

    expect(armed.body.accepts[0].extra.feePayer).toBe('0.0.98');
    expect(h.facilitatorCalls.some((url) => url.endsWith('/supported'))).toBe(true);
  });

  it('reserves the proceeds against the mandate before placing the hold', async () => {
    const before = await h.store.getMandate(h.seeded.mandateIds['MND-01'] ?? '');
    const { armed } = await armTrade();
    const after = await h.store.getMandate(h.seeded.mandateIds['MND-01'] ?? '');

    expect(after!.allocatedMinor - before!.allocatedMinor).toBe(BigInt(armed.body.quote.proceeds));
  });

  it('settles both legs when the buyer returns with a signature', async () => {
    const { invoiceId, quoteId } = await armTrade();
    const settled = await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId, quoteId },
      headers: {
        [X402_HEADERS.signature]: Buffer.from(JSON.stringify({ signature: '0xdead' })).toString(
          'base64',
        ),
      },
    });

    expect(settled.status).toBe(200);
    expect(settled.body.assetLeg.state).toBe('settled');
    expect(settled.body.cashLeg.state).toBe('settled');
    expect(settled.body.cashLeg.transaction).toBe('0.0.6098467@1756000150.000000001');
    expect(settled.headers.get(X402_HEADERS.response)).toBeTruthy();
    expect(h.ats.executed).toHaveLength(1);
    expect((await h.store.getInvoice(invoiceId))?.status).toBe('sold');
  });

  it('verifies before it settles, never the other way round', async () => {
    const { invoiceId, quoteId } = await armTrade();
    await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId, quoteId },
      headers: {
        [X402_HEADERS.signature]: Buffer.from(JSON.stringify({ signature: '0xdead' })).toString(
          'base64',
        ),
      },
    });

    const verifyAt = h.facilitatorCalls.findIndex((u) => u.endsWith('/verify'));
    const settleAt = h.facilitatorCalls.findIndex((u) => u.endsWith('/settle'));
    expect(verifyAt).toBeGreaterThanOrEqual(0);
    expect(settleAt).toBeGreaterThan(verifyAt);
  });

  it('refuses an ineligible buyer in words, before anything is reserved', async () => {
    h.restore();
    h = await createHarness({
      gate: createRefusingGate('Ashgrove Treasury does not hold a KYC grant on this security.'),
    });

    const invoiceId = h.seeded.invoiceIds['INV-2041'] ?? '';
    const quote = await call(h.app, 'GET', `/v1/invoices/${invoiceId}/quote${asOf}`);
    const res = await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId, quoteId: quote.body.quoteId },
    });

    expect(res.status).toBe(403);
    expect(res.body.detail).toContain('KYC grant');
    // Nothing was reserved and no hold was placed — the refusal is not a failed settlement.
    expect(h.ats.holds).toHaveLength(0);
    expect(h.store.trades.size).toBe(h.seeded.counts.trades);
  });

  it('unwinds and gives the capital back when the cash leg does not settle', async () => {
    h.restore();
    h = await createHarness({ settleFails: 'INSUFFICIENT_PAYER_BALANCE' });

    const invoiceId = h.seeded.invoiceIds['INV-2041'] ?? '';
    const quote = await call(h.app, 'GET', `/v1/invoices/${invoiceId}/quote${asOf}`);
    const before = await h.store.getMandate(h.seeded.mandateIds['MND-01'] ?? '');
    await call(h.app, 'POST', '/v1/trades', { body: { invoiceId, quoteId: quote.body.quoteId } });

    const failed = await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId, quoteId: quote.body.quoteId },
      headers: {
        [X402_HEADERS.signature]: Buffer.from(JSON.stringify({ signature: '0xdead' })).toString(
          'base64',
        ),
      },
    });

    expect(failed.status).toBe(503);
    expect(h.ats.released).toHaveLength(1);
    const after = await h.store.getMandate(h.seeded.mandateIds['MND-01'] ?? '');
    expect(after!.allocatedMinor).toBe(before!.allocatedMinor);
  });

  it('will not sell an invoice whose instrument has not landed yet', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2051'] ?? '';
    const res = await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId, quoteId: h.seeded.tradeIds['POS-02'] ?? '' },
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('issuance_pending');
  });

  it('rejects a quote from another invoice', async () => {
    const quote = await call(
      h.app,
      'GET',
      `/v1/invoices/${h.seeded.invoiceIds['INV-2041']}/quote${asOf}`,
    );
    const res = await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId: h.seeded.invoiceIds['INV-2044'], quoteId: quote.body.quoteId },
    });

    expect(res.status).toBe(404);
  });

  it('records a refusal receipt for every mandate that would not take the paper', async () => {
    await armTrade('INV-2046');
    const refusals = await h.store.listRefusalsForInvoice(h.seeded.invoiceIds['INV-2046'] ?? '');

    expect(refusals).toHaveLength(5);
    expect(refusals.every((r) => r.reasonText.length > 0)).toBe(true);
    expect(refusals.map((r) => r.reasonCode)).toContain('DEBTOR_CONCENTRATION');
  });

  it('rejects a malformed payment header, naming the header the SDK actually uses', async () => {
    const { invoiceId, quoteId } = await armTrade();
    const res = await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId, quoteId },
      headers: { [X402_HEADERS.signature]: 'not-base64-json' },
    });

    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('X-PAYMENT');
  });
});

describe('trades and the proof view', () => {
  it('lists trades for whichever side asked', async () => {
    const res = await call(h.app, 'GET', `/v1/trades?buyerId=${h.seeded.buyerIds['BUY-CORDELL']}`);
    expect(res.status).toBe(200);
    expect(res.body.trades).toHaveLength(3);
    expect(res.body.trades.every((t) => t.status === 'settled')).toBe(true);
  });

  it('requires a side', async () => {
    const res = await call(h.app, 'GET', '/v1/trades');
    expect(res.status).toBe(422);
  });

  it('shows one trade with both legs', async () => {
    const res = await call(h.app, 'GET', `/v1/trades/${h.seeded.tradeIds['TRD-4417']}`);

    expect(res.status).toBe(200);
    expect(res.body.trade.assetLeg.state).toBe('settled');
    expect(res.body.trade.cashLeg.state).toBe('settled');
    expect(res.body.trade.faceValue).toBe('9500000');
    expect(res.body.proofUrl).toContain('/proof');
  });

  it('serves the audit view with a checkable link behind every identifier', async () => {
    const res = await call(h.app, 'GET', `/v1/trades/${h.seeded.tradeIds['TRD-4417']}/proof`);

    expect(res.status).toBe(200);
    expect(res.body.invoice.invoiceNumber).toBe('MF-2033');
    expect(res.body.invoice.securityExplorerUrl).toContain('hashscan.io');
    expect(res.body.assetLeg.explorerUrl).toContain('/transaction/');
    expect(res.body.compliance.hcsExplorerUrl).toContain('/topic/0.0.6741301/message/4400');
    expect(res.body.pricing.faceValue).toBe('9500000');
    expect(res.body.pricing.proceedsMinor).toBe('9439616');
    expect(res.body.confirmation.decision).toBe('confirmed');
  });

  it('shows no maturity block until the receivable has matured', async () => {
    const res = await call(h.app, 'GET', `/v1/trades/${h.seeded.tradeIds['TRD-4417']}/proof`);

    // Null rather than an empty block: nothing has been arranged, and a present-but-empty
    // maturity would imply the question had been asked and answered.
    expect(res.body.maturity).toBeNull();
  });

  it('shows maturity as an obligation before anyone has been paid', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2033'] ?? '';
    await settlementService.settleAtMaturity(invoiceId);

    const res = await call(h.app, 'GET', `/v1/trades/${h.seeded.tradeIds['TRD-4417']}/proof`);

    expect(res.body.maturity.state).toBe('pending');
    expect(res.body.maturity.scheduleExplorerUrl).toContain('/schedule/');
    // No transfer to point at, so no link is invented for one.
    expect(res.body.maturity.transactionId).toBeNull();
    expect(res.body.maturity.explorerUrl).toBeNull();
  });

  it('shows maturity as a receipt once the holder has actually been paid', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2033'] ?? '';
    const matured = await settlementService.settleAtMaturity(invoiceId);
    // Signed by someone, somewhere outside this service. That is what makes it a payment.
    h.schedule.executedSchedules.add(matured.payout?.scheduleId ?? '');

    const res = await call(h.app, 'GET', `/v1/trades/${h.seeded.tradeIds['TRD-4417']}/proof`);

    expect(res.body.maturity.state).toBe('settled');
    expect(res.body.maturity.transactionId).toBe('0.0.5512@1788337866.334186498');
    expect(res.body.maturity.explorerUrl).toContain('/transaction/');
    expect(res.body.maturity.payer).toBe('0.0.5599');
    expect(res.body.maturity.payee).toBe('0.0.6098431');
  });

  it('never synthesises a link whose identifier is null', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2041'] ?? '';
    const quote = await call(h.app, 'GET', `/v1/invoices/${invoiceId}/quote${asOf}`);
    const armed = await call(h.app, 'POST', '/v1/trades', {
      body: { invoiceId, quoteId: quote.body.quoteId },
    });

    const res = await call(h.app, 'GET', `/v1/trades/${armed.body.trade.id}/proof`);
    expect(res.body.cashLeg.transaction).toBeNull();
    expect(res.body.cashLeg.explorerUrl).toBeNull();
    expect(res.body.settledAt).toBeNull();
  });
});

describe('problem responses', () => {
  it('are application/problem+json with a stable code and the request id', async () => {
    const res = await call(h.app, 'GET', '/v1/invoices/00000000-0000-4000-8000-000000000000', {
      headers: { 'x-request-id': 'req-under-test' },
    });

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(res.body.code).toBe('not_found');
    expect(res.body.type).toBe('urn:facture:error:not_found');
    expect(res.body.requestId).toBe('req-under-test');
  });

  it('names the field on a validation failure', async () => {
    const res = await call(h.app, 'GET', '/v1/invoices?sellerId=not-a-uuid');
    expect(res.status).toBe(422);
    expect(res.body.errors[0].path).toBe('sellerId');
  });
});
