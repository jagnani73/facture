/**
 * The live source's mapping, with the network taken out.
 *
 * `apiProof` is the half of `src/lib/data/api-source.ts` that can be exercised honestly
 * without a server: two calls in, one `ProofRecord` out, and everything between them is a
 * decision this file makes rather than one the venue makes. `apiMarket` is deliberately not
 * covered — it fans out over four routes and reads the seller and buyer identity out of the
 * environment at module load, so standing it up means stubbing more than it asserts.
 *
 * What is worth pinning here is the shaping the proof screen depends on and `tsc` cannot
 * see: the same refusal said once with a count beside it, a maturity receipt passed through
 * untouched, and a settlement block that is absent rather than empty when the venue named
 * neither scheme nor network.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/client', () => ({
  api: { getTrade: vi.fn(), getTradeProof: vi.fn() },
}));

import { api } from '@/lib/api/client';
import { readTrade, type TradeProofResponse } from '@/lib/api/contract';
import { apiProof } from '@/lib/data/api-source';

const TRADE_ID = '9f1c6f1e-0000-4000-8000-000000000t11';

const trade = readTrade({
  id: TRADE_ID,
  invoiceId: '9f1c6f1e-0000-4000-8000-000000000001',
  mandateId: '9f1c6f1e-0000-4000-8000-00000000ma11',
  sellerId: '9f1c6f1e-0000-4000-8000-0000000005e1',
  buyerId: '9f1c6f1e-0000-4000-8000-000000000bu1',
  faceValue: '6230000',
  annualisedYieldBps: 925,
  tenorDays: 92,
  discountMinor: '145000',
  proceedsMinor: '6085000',
  currency: 'USD',
  createdAt: '2026-09-02T10:00:00.000Z',
});

const proof = (over: Partial<TradeProofResponse> = {}): TradeProofResponse => ({
  tradeId: TRADE_ID,
  invoice: {
    id: trade.invoiceId,
    invoiceNumber: 'MF-2051',
    uniquenessHash: '0xabc',
    isin: 'USQ72738QUM6',
    securityId: '0.0.10331926',
    securityExplorerUrl: null,
  },
  confirmation: { decision: 'confirmed', decidedAt: '2026-09-01T09:00:00.000Z' },
  compliance: {
    allowed: true,
    checks: [],
    reason: null,
    checkedAt: '2026-09-02T10:00:00.000Z',
    hcsTopicId: '0.0.1',
    hcsSequenceNumber: '7',
    hcsExplorerUrl: null,
  },
  pricing: null,
  assetLeg: {
    chain: 'hedera',
    holdId: '1',
    transactionId: null,
    consensusAt: null,
    explorerUrl: null,
  },
  cashLeg: {
    chain: 'hedera-testnet',
    scheme: 'exact',
    network: 'hedera:testnet',
    asset: '0.0.0',
    transaction: null,
    payer: '0.0.10314099',
    explorerUrl: null,
  },
  maturity: null,
  refusals: [],
  settledAt: '2026-09-02T10:00:30.000Z',
  ...over,
});

const answer = (body: TradeProofResponse): void => {
  vi.mocked(api.getTrade).mockResolvedValue(trade);
  vi.mocked(api.getTradeProof).mockResolvedValue(body);
};

beforeEach(() => {
  vi.mocked(api.getTrade).mockReset();
  vi.mocked(api.getTradeProof).mockReset();
});

describe('apiProof', () => {
  it('asks for the trade and its proof under the same id', async () => {
    answer(proof());
    const record = await apiProof(TRADE_ID);

    expect(vi.mocked(api.getTrade).mock.calls[0]?.[0]).toBe(TRADE_ID);
    expect(vi.mocked(api.getTradeProof).mock.calls[0]?.[0]).toBe(TRADE_ID);
    expect(record.tradeId).toBe(TRADE_ID);
    expect(record.trade.proceeds).toBe(6_085_000n);
  });

  /*
   * The venue decides whether a receivable matured and whether anyone was paid. This source
   * gets no vote on either, so the block arrives on screen exactly as it was published.
   */
  it('passes the maturity receipt through untouched', async () => {
    const maturity = {
      scheduleId: '0.0.10331573',
      scheduleExplorerUrl: 'https://hashscan.io/testnet/schedule/0.0.10331573',
      state: 'settled' as const,
      executedAt: '2026-09-02T11:00:00.000Z',
      transactionId: '0.0.10331559@1788000000.000000000',
      explorerUrl: 'https://hashscan.io/testnet/transaction/x',
      payer: '0.0.10331559',
      payee: '0.0.10314099',
    };

    answer(proof({ maturity }));
    expect((await apiProof(TRADE_ID)).payout).toEqual(maturity);

    answer(proof());
    expect((await apiProof(TRADE_ID)).payout).toBeNull();
  });

  /*
   * A refusal receipt is written on every pricing pass, so an invoice quoted ten times
   * carries the same four refusals ten times over. Every one is real and none is new
   * information; the rejected funder is owed the reason, not forty copies of it.
   */
  describe('the refusals a funder is owed', () => {
    const refusal = (over: Partial<TradeProofResponse['refusals'][number]> = {}) => ({
      mandateId: 'm-1',
      reasonCode: 'RATING_BELOW_MANDATE',
      reasonText: 'That mandate buys nothing below A.',
      hcsExplorerUrl: null,
      ...over,
    });

    it('says the same refusal once, with how many times it was recorded', async () => {
      answer(proof({ refusals: [refusal(), refusal(), refusal()] }));
      const record = await apiProof(TRADE_ID);

      expect(record.refusals).toHaveLength(1);
      expect(record.refusals[0]?.times).toBe(3);
    });

    it('keeps refusals apart when the mandate or the reason differs', async () => {
      answer(
        proof({
          refusals: [
            refusal(),
            refusal({ mandateId: 'm-2' }),
            refusal({ reasonCode: 'TENOR_EXCEEDS_MANDATE', reasonText: 'Past 60 days.' }),
          ],
        }),
      );
      const record = await apiProof(TRADE_ID);

      expect(record.refusals).toHaveLength(3);
      expect(record.refusals.every((row) => row.times === 1)).toBe(true);
    });

    /** The venue returns them in the order they were written, and that order is the record. */
    it('keeps the first occurrence in its original position', async () => {
      answer(
        proof({
          refusals: [
            refusal({ mandateId: 'm-1' }),
            refusal({ mandateId: 'm-2' }),
            refusal({ mandateId: 'm-1' }),
          ],
        }),
      );
      expect((await apiProof(TRADE_ID)).refusals.map((row) => row.mandateId)).toEqual([
        'm-1',
        'm-2',
      ]);
    });

    /*
     * The HCS receipt only exists once the venue has written one, and the copies of a
     * refusal need not agree about that. Collapsing must not throw away the link that a
     * later copy carried.
     */
    it('keeps the first receipt link any copy of the refusal had', async () => {
      answer(
        proof({
          refusals: [
            refusal(),
            refusal({ hcsExplorerUrl: 'https://hashscan.io/testnet/topic/0.0.1/message/7' }),
          ],
        }),
      );
      expect((await apiProof(TRADE_ID)).refusals[0]?.hcsExplorerUrl).toBe(
        'https://hashscan.io/testnet/topic/0.0.1/message/7',
      );
    });
  });

  /*
   * Not assumed to be Arc. This build settles the cash leg in HBAR, and a screen that
   * hardcoded Arc would print an ArcScan link over a Hedera transaction id on the one page
   * whose entire job is being checkable somewhere else.
   */
  it('takes the cash leg chain from the venue rather than assuming one', async () => {
    answer(proof());
    expect((await apiProof(TRADE_ID)).cashLeg.chain).toBe('hedera-testnet');

    answer(
      proof({
        cashLeg: {
          chain: 'arc-testnet',
          scheme: 'exact',
          network: 'arc:testnet',
          asset: '0xusdc',
          transaction: null,
          payer: null,
          explorerUrl: null,
        },
      }),
    );
    expect((await apiProof(TRADE_ID)).cashLeg.chain).toBe('arc-testnet');
  });

  /** A settlement block with nothing in it would claim the legs were bound when they were not. */
  it('omits the settlement block when the venue named neither scheme nor network', async () => {
    answer(
      proof({
        cashLeg: {
          chain: 'arc-testnet',
          scheme: null,
          network: null,
          asset: null,
          transaction: null,
          payer: null,
          explorerUrl: null,
        },
      }),
    );
    expect((await apiProof(TRADE_ID)).settlement).toBeNull();

    answer(proof());
    expect((await apiProof(TRADE_ID)).settlement?.scheme).toBe('exact');
  });

  /*
   * A link is built only from an identifier this build actually holds. An explorer URL that
   * 404s is worse than an absent one on the screen whose whole purpose is being checkable.
   */
  it('builds a security link only when there is a security to link to', async () => {
    answer(proof());
    expect((await apiProof(TRADE_ID)).instrument.explorerUrl).toContain('/token/0.0.10331926');

    answer(
      proof({
        invoice: {
          id: trade.invoiceId,
          invoiceNumber: 'MF-2051',
          uniquenessHash: null,
          isin: null,
          securityId: null,
          securityExplorerUrl: null,
        },
      }),
    );
    expect((await apiProof(TRADE_ID)).instrument.explorerUrl).toBeNull();
  });

  it('prefers the venue’s own security link over one it built', async () => {
    answer(
      proof({
        invoice: {
          id: trade.invoiceId,
          invoiceNumber: 'MF-2051',
          uniquenessHash: '0xabc',
          isin: 'USQ72738QUM6',
          securityId: '0.0.10331926',
          securityExplorerUrl: 'https://example.test/security',
        },
      }),
    );
    expect((await apiProof(TRADE_ID)).instrument.explorerUrl).toBe('https://example.test/security');
  });

  /** An empty invoice number is an absent one; the screen should not print a blank label. */
  it('reads a blank invoice number as no invoice number', async () => {
    answer(
      proof({
        invoice: {
          id: trade.invoiceId,
          invoiceNumber: '',
          uniquenessHash: null,
          isin: null,
          securityId: null,
          securityExplorerUrl: null,
        },
      }),
    );
    expect((await apiProof(TRADE_ID)).invoiceNumber).toBeNull();
  });
});
