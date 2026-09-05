/**
 * The five endings of a sale, and the two that arrive on different HTTP statuses.
 *
 * `sellInvoice` is the single funnel every sale goes through, and until now **nothing tested
 * it at all** — not the 402 branch, not the 200 branch, not the refusal handling. That gap
 * mattered the moment the venue grew a second rail, because a settled-on-arrival 200 was
 * already *accepted* by this code: it rendered as a sale while silently discarding the trade,
 * naming the wrong protocol, and saying nothing about proceeds sitting in an escrow the
 * seller still has to claim. A wrong answer that renders confidently is exactly what the
 * decoder rule elsewhere in this package exists to prevent, and this path had no guard.
 *
 * So these are tests of what the seller is *told*, not of plumbing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/client', () => ({
  api: { executeTrade: vi.fn() },
}));

/*
 * `usingApi` lives in `@/lib/api/config`, not the client — mocking the wrong module leaves
 * the demo branch running and every assertion below passes against fixture data instead of
 * the code under test.
 */
vi.mock('@/lib/api/config', () => ({
  DATA_SOURCE: 'api',
  usingApi: () => true,
}));

import { api } from '@/lib/api/client';
import { usingApi } from '@/lib/api/config';
import { readTrade } from '@/lib/api/contract';
import { sellInvoice } from '@/lib/data';
import { SETTLED_FROM_ESCROW_SENTENCE, SETTLEMENT_STATE_SENTENCE } from '@/lib/settlement';

const INVOICE_ID = '9f1c6f1e-0000-4000-8000-000000000001';
const QUOTE_ID = '9f1c6f1e-0000-4000-8000-0000000000q1';
const TRADE_ID = '9f1c6f1e-0000-4000-8000-000000000t11';

/** A settled trade as the venue publishes it, with the rail it settled on. */
const settledTrade = (rail: 'x402' | 'arc-vault') =>
  readTrade({
    id: TRADE_ID,
    invoiceId: INVOICE_ID,
    mandateId: '9f1c6f1e-0000-4000-8000-00000000ma11',
    sellerId: '9f1c6f1e-0000-4000-8000-0000000005e1',
    buyerId: '9f1c6f1e-0000-4000-8000-000000000bu1',
    faceValue: '6230000',
    annualisedYieldBps: 925,
    tenorDays: 92,
    discountMinor: '145000',
    proceedsMinor: '6085000',
    currency: 'USD',
    status: 'settled',
    createdAt: '2026-09-02T10:00:00.000Z',
    cashLeg: {
      state: 'settled',
      chain: rail === 'arc-vault' ? 'arc' : 'hedera',
      rail,
      transaction: '0xabc',
    },
  });

beforeEach(() => {
  vi.mocked(api.executeTrade).mockReset();
  expect(usingApi()).toBe(true);
});

describe('a sale that settles on arrival', () => {
  /*
   * The Arc rail returns 200 with both legs already done, because the buyer escrowed the
   * capital before the invoice existed and had nothing to sign. The seller must be told that
   * — not the x402 sentence, which describes a challenge that never happened.
   */
  it('names the rail that actually paid', async () => {
    vi.mocked(api.executeTrade).mockResolvedValue({
      status: 'settled',
      trade: settledTrade('arc-vault'),
    });

    const outcome = await sellInvoice(INVOICE_ID, QUOTE_ID);

    expect(outcome).toMatchObject({ ok: true, state: 'settled', rail: 'arc-vault' });
    expect(outcome.ok && outcome.state === 'settled' && outcome.note).toBe(
      SETTLED_FROM_ESCROW_SENTENCE,
    );
  });

  it('keeps the x402 sentence for a trade that was actually signed for', async () => {
    vi.mocked(api.executeTrade).mockResolvedValue({
      status: 'settled',
      trade: settledTrade('x402'),
    });

    const outcome = await sellInvoice(INVOICE_ID, QUOTE_ID);

    expect(outcome).toMatchObject({ ok: true, state: 'settled', rail: 'x402' });
    expect(outcome.ok && outcome.state === 'settled' && outcome.note).toBe(
      SETTLEMENT_STATE_SENTENCE.settled,
    );
  });

  /*
   * The trade used to be thrown away here, so the settled panel had nothing to link to —
   * while the half-settled panel, the ending nobody wants, linked to its proof. A seller who
   * has just sold a receivable is the person most entitled to check both legs.
   */
  it('carries the trade, so the seller can be shown its proof', async () => {
    vi.mocked(api.executeTrade).mockResolvedValue({
      status: 'settled',
      trade: settledTrade('arc-vault'),
    });

    const outcome = await sellInvoice(INVOICE_ID, QUOTE_ID);

    expect(outcome.ok && outcome.state === 'settled' && outcome.trade?.id).toBe(TRADE_ID);
  });

  /*
   * A rail this build does not recognise must not be quietly reported as x402. The sentence
   * a seller reads turns on it, and naming the wrong settlement protocol on the screen where
   * they decide whether to trust the venue is worse than naming none.
   */
  it('does not invent a rail the venue did not name', async () => {
    const trade = settledTrade('x402');
    vi.mocked(api.executeTrade).mockResolvedValue({
      status: 'settled',
      trade: { ...trade, cashRail: undefined },
    });

    const outcome = await sellInvoice(INVOICE_ID, QUOTE_ID);

    expect(outcome.ok && outcome.state === 'settled' && outcome.rail).toBeNull();
  });
});

describe('a sale that still needs paying for', () => {
  /*
   * The 402 is the success case of the first half of an x402 exchange. Rendering it as sold
   * would claim a settlement that has not happened, and the paper is held rather than moved.
   */
  it('reports the challenge rather than a sale', async () => {
    const challenge = { trade: null, quote: null, assetLeg: null, compliance: null } as never;
    vi.mocked(api.executeTrade).mockResolvedValue({
      status: 'payment_required',
      challenge,
    });

    const outcome = await sellInvoice(INVOICE_ID, QUOTE_ID);

    expect(outcome).toMatchObject({ ok: true, state: 'awaiting_payment' });
    expect(outcome.ok && outcome.state === 'awaiting_payment' && outcome.note).toBe(
      SETTLEMENT_STATE_SENTENCE.awaiting_payment,
    );
  });
});

describe('a sale that cannot proceed', () => {
  /*
   * The curve moves, and a seller must never be filled at a price they were not shown. No
   * quote reference means no sale, and the venue is never asked.
   */
  it('refuses to sell without the quote the seller was shown', async () => {
    const outcome = await sellInvoice(INVOICE_ID, null);

    expect(outcome.ok).toBe(false);
    expect(api.executeTrade).not.toHaveBeenCalled();
  });
});
