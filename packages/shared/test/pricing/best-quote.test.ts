import { describe, expect, it } from 'vitest';
import { bestQuote, matchCount } from '../../src/pricing/best-quote.js';
import type { Debtor } from '../../src/types/debtor.js';
import type { Invoice, InvoiceStatus } from '../../src/types/invoice.js';
import type { Mandate } from '../../src/types/mandate.js';
import type { RefusalCode } from '../../src/types/refusal.js';

const AS_OF = '2026-10-01T09:00:00.000Z';
const DUE = '2026-11-30T00:00:00.000Z'; // 60 days out

const invoice = (overrides: Partial<Invoice> = {}): Invoice => ({
  id: 'inv-1',
  sellerId: 'seller-1',
  debtorId: 'debtor-1',
  faceValue: 4_000_000n,
  currency: 'USD',
  invoiceNumber: 'INV-001',
  issuedAt: '2026-09-30T00:00:00.000Z',
  dueAt: DUE,
  status: 'confirmed',
  uniquenessHash: '0xabababababababababababababababababababababababababababababababab',
  ...overrides,
});

const debtor = (overrides: Partial<Debtor> = {}): Debtor => ({
  id: 'debtor-1',
  name: 'Northwind Components',
  rating: 'B',
  onTimeCount: 4,
  defaultCount: 0,
  confirmedCount: 5,
  ...overrides,
});

const mandate = (overrides: Partial<Mandate> = {}): Mandate => ({
  id: 'm-1',
  buyerId: 'buyer-1',
  minRating: 'C',
  maxTenorDays: 90,
  annualisedYieldBps: 800,
  totalCommitted: 20_000_000n,
  allocated: 0n,
  maxPerDebtor: 5_000_000n,
  status: 'active',
  ...overrides,
});

const codes = (result: { refusals: readonly { code: RefusalCode }[] }): RefusalCode[] =>
  result.refusals.map((r) => r.code);

describe('bestQuote — selection', () => {
  it('picks the lowest yield, because that is the most money for the seller', () => {
    const result = bestQuote(
      invoice(),
      [
        mandate({ id: 'm-wide', annualisedYieldBps: 1250 }),
        mandate({ id: 'm-tight', annualisedYieldBps: 800 }),
        mandate({ id: 'm-middle', annualisedYieldBps: 950 }),
      ],
      debtor(),
      { asOf: AS_OF },
    );

    expect(result.mandate?.id).toBe('m-tight');
    expect(result.quote?.annualisedYieldBps).toBe(800);
    expect(result.quote?.proceeds).toBe(3_947_397n);
    expect(result.quote?.discount).toBe(52_603n);
    expect(matchCount(result)).toBe(3);
    expect(result.refusals).toHaveLength(0);
  });

  it('returns every match ordered best first', () => {
    const result = bestQuote(
      invoice(),
      [
        mandate({ id: 'm-wide', annualisedYieldBps: 1250 }),
        mandate({ id: 'm-tight', annualisedYieldBps: 800 }),
      ],
      debtor(),
      { asOf: AS_OF },
    );
    expect(result.matches.map((m) => m.mandate.id)).toEqual(['m-tight', 'm-wide']);
  });

  it('breaks a tie on price by depth, then deterministically by id', () => {
    const deep = mandate({ id: 'm-z', totalCommitted: 50_000_000n });
    const shallow = mandate({ id: 'm-a', totalCommitted: 10_000_000n });

    expect(bestQuote(invoice(), [shallow, deep], debtor(), { asOf: AS_OF }).mandate?.id).toBe(
      'm-z',
    );
    expect(bestQuote(invoice(), [deep, shallow], debtor(), { asOf: AS_OF }).mandate?.id).toBe(
      'm-z',
    );

    const twinA = mandate({ id: 'm-a' });
    const twinB = mandate({ id: 'm-b' });
    expect(bestQuote(invoice(), [twinB, twinA], debtor(), { asOf: AS_OF }).mandate?.id).toBe('m-a');
    expect(bestQuote(invoice(), [twinA, twinB], debtor(), { asOf: AS_OF }).mandate?.id).toBe('m-a');
  });

  it('returns no quote and no mandate when nothing on the book will take it', () => {
    const result = bestQuote(invoice(), [mandate({ minRating: 'A' })], debtor(), { asOf: AS_OF });
    expect(result.quote).toBeNull();
    expect(result.mandate).toBeNull();
    expect(result.refusals).toHaveLength(1);
  });

  it('returns no quote and no refusals against an empty book', () => {
    const result = bestQuote(invoice(), [], debtor(), { asOf: AS_OF });
    expect(result.quote).toBeNull();
    expect(result.refusals).toHaveLength(0);
    expect(result.tenorDays).toBe(60);
  });
});

describe('bestQuote — the quote it builds', () => {
  it('carries everything needed to render the price without a second lookup', () => {
    const result = bestQuote(invoice(), [mandate()], debtor(), {
      asOf: AS_OF,
      quoteTtlSeconds: 120,
    });

    expect(result.quote).toEqual({
      invoiceId: 'inv-1',
      mandateId: 'm-1',
      annualisedYieldBps: 800,
      tenorDays: 60,
      faceValue: 4_000_000n,
      discount: 52_603n,
      proceeds: 3_947_397n,
      currency: 'USD',
      asOf: AS_OF,
      expiresAt: '2026-10-01T09:02:00.000Z',
    });
  });

  it('shortens as the due date approaches, which is why a quote expires', () => {
    const early = bestQuote(invoice(), [mandate()], debtor(), { asOf: AS_OF });
    const later = bestQuote(invoice(), [mandate()], debtor(), { asOf: '2026-10-31T09:00:00.000Z' });

    expect(early.tenorDays).toBe(60);
    expect(later.tenorDays).toBe(30);
    // Seasoned paper clears tighter: less time left means a smaller discount.
    expect(later.quote?.proceeds).toBeGreaterThan(early.quote?.proceeds ?? 0n);
  });
});

describe('bestQuote — refusals', () => {
  it('refuses a debtor below the rating floor, and says both ratings', () => {
    const result = bestQuote(invoice(), [mandate({ minRating: 'A' })], debtor({ rating: 'C' }), {
      asOf: AS_OF,
    });

    expect(codes(result)).toEqual(['RATING_BELOW_MANDATE']);
    expect(result.refusals[0]?.humanReason).toBe(
      'The customer is rated C, and this mandate takes A or better.',
    );
    expect(result.refusals[0]?.mandateId).toBe('m-1');
    expect(result.refusals[0]?.checkedAt).toBe(AS_OF);
  });

  it('refuses a defaulted customer even at the widest floor a buyer can write', () => {
    // `UNRATED` is "no rating floor", and it still refuses `D`: a default is information
    // and an absence of history is not, so `D` ranks below `UNRATED` rather than above it.
    const wideOpen = mandate({ minRating: 'UNRATED' });

    expect(
      bestQuote(invoice(), [wideOpen], debtor({ rating: 'UNRATED' }), { asOf: AS_OF }).quote,
    ).not.toBeNull();

    const defaulted = bestQuote(invoice(), [wideOpen], debtor({ rating: 'D', defaultCount: 1 }), {
      asOf: AS_OF,
    });
    expect(codes(defaulted)).toEqual(['RATING_BELOW_MANDATE']);
    expect(defaulted.refusals[0]?.humanReason).toBe(
      'The customer is rated D, and this mandate takes UNRATED or better.',
    );
  });

  it('refuses paper longer than the mandate takes, inclusively at the boundary', () => {
    const tooLong = bestQuote(invoice(), [mandate({ maxTenorDays: 59 })], debtor(), {
      asOf: AS_OF,
    });
    expect(codes(tooLong)).toEqual(['TENOR_EXCEEDS_MANDATE']);
    expect(tooLong.refusals[0]?.humanReason).toBe(
      'This invoice matures in 60 days, and this mandate takes 59 days or less.',
    );

    // Exactly at the ceiling still matches — "ninety days or less" includes ninety.
    const exact = bestQuote(invoice(), [mandate({ maxTenorDays: 60 })], debtor(), { asOf: AS_OF });
    expect(exact.quote).not.toBeNull();
  });

  it('refuses a mandate with no committed capital left', () => {
    const result = bestQuote(
      invoice(),
      [mandate({ totalCommitted: 5_000_000n, allocated: 4_000_000n })],
      debtor(),
      { asOf: AS_OF },
    );
    expect(codes(result)).toEqual(['EXPOSURE_EXHAUSTED']);
    expect(result.refusals[0]?.humanReason).toBe(
      'This invoice needs $39,473.97, and this mandate has $10,000.00 of committed capital left.',
    );
  });

  it('tests capacity against the proceeds, not the face value', () => {
    // The mandate pays the discounted price today and is repaid face at maturity, so cash on
    // hand only has to cover the proceeds. Anything else strands usable liquidity.
    const exactlyEnough = bestQuote(
      invoice(),
      [mandate({ totalCommitted: 3_947_397n, maxPerDebtor: 5_000_000n })],
      debtor(),
      { asOf: AS_OF },
    );
    expect(exactlyEnough.quote).not.toBeNull();

    const oneShort = bestQuote(
      invoice(),
      [mandate({ totalCommitted: 3_947_396n, maxPerDebtor: 5_000_000n })],
      debtor(),
      { asOf: AS_OF },
    );
    expect(codes(oneShort)).toEqual(['EXPOSURE_EXHAUSTED']);
  });

  it('refuses on concentration even when the mandate has room overall', () => {
    const result = bestQuote(
      invoice(),
      [
        mandate({
          totalCommitted: 20_000_000n,
          maxPerDebtor: 5_000_000n,
          debtorExposure: { 'debtor-1': 4_000_000n },
        }),
      ],
      debtor(),
      { asOf: AS_OF },
    );

    expect(codes(result)).toEqual(['DEBTOR_CONCENTRATION']);
    expect(result.refusals[0]?.humanReason).toContain('Northwind Components');
    expect(result.refusals[0]?.humanReason).toContain('$10,000.00');
  });

  it('counts exposure per debtor, so another debtor is unaffected', () => {
    const m = mandate({
      maxPerDebtor: 5_000_000n,
      debtorExposure: { 'debtor-2': 5_000_000n },
    });
    expect(bestQuote(invoice(), [m], debtor(), { asOf: AS_OF }).quote).not.toBeNull();
  });

  it('refuses a mandate that is not funded, because an unfunded bid is not a price', () => {
    for (const status of ['draft', 'funding', 'exhausted', 'withdrawn'] as const) {
      const result = bestQuote(invoice(), [mandate({ status })], debtor(), { asOf: AS_OF });
      expect(codes(result)).toEqual(['MANDATE_NOT_ACTIVE']);
    }
  });

  it('refuses a currency mismatch when the mandate declares one', () => {
    const result = bestQuote(invoice(), [mandate({ currency: 'EUR' })], debtor(), { asOf: AS_OF });
    expect(codes(result)).toEqual(['CURRENCY_MISMATCH']);
    expect(result.refusals[0]?.humanReason).toBe(
      'This invoice is denominated in USD, and this mandate bids in EUR.',
    );
  });

  it('does not enforce a currency the mandate has not declared', () => {
    expect(bestQuote(invoice(), [mandate()], debtor(), { asOf: AS_OF }).quote).not.toBeNull();
  });

  it('refuses an unconfirmed invoice once, not once per mandate', () => {
    const unquotable: InvoiceStatus[] = [
      'draft',
      'awaiting_confirmation',
      'disputed',
      'sold',
      'matured',
      'defaulted',
    ];
    for (const status of unquotable) {
      const result = bestQuote(
        invoice({ status }),
        [mandate({ id: 'm-1' }), mandate({ id: 'm-2' }), mandate({ id: 'm-3' })],
        debtor(),
        { asOf: AS_OF },
      );
      expect(result.quote).toBeNull();
      expect(result.refusals).toHaveLength(1);
      expect(result.refusals[0]?.code).toBe('INVOICE_NOT_CONFIRMED');
      // Null mandate id: the refusal is about the invoice, not about any one bid.
      expect(result.refusals[0]?.mandateId).toBeNull();
    }
  });

  it('quotes listed paper as well as confirmed paper', () => {
    // A listed invoice is re-priced continuously; quoting must not require de-listing.
    expect(
      bestQuote(invoice({ status: 'listed' }), [mandate()], debtor(), { asOf: AS_OF }).quote,
    ).not.toBeNull();
  });

  it('gives every refusal a sentence naming both sides of the failed comparison', () => {
    const result = bestQuote(
      invoice(),
      [
        mandate({ id: 'm-rating', minRating: 'A' }),
        mandate({ id: 'm-tenor', maxTenorDays: 10 }),
        mandate({ id: 'm-exposure', totalCommitted: 100n }),
        mandate({ id: 'm-concentration', maxPerDebtor: 100n }),
        mandate({ id: 'm-status', status: 'funding' }),
        mandate({ id: 'm-currency', currency: 'EUR' }),
      ],
      debtor(),
      { asOf: AS_OF },
    );

    expect(result.refusals).toHaveLength(6);
    for (const receipt of result.refusals) {
      expect(receipt.humanReason.length).toBeGreaterThan(20);
      expect(receipt.humanReason.endsWith('.')).toBe(true);
      expect(receipt.detail.code).toBe(receipt.code);
      expect(receipt.invoiceId).toBe('inv-1');
      expect(receipt.hcsMessageId).toBeUndefined();
    }
    expect(codes(result).sort()).toEqual(
      [
        'CURRENCY_MISMATCH',
        'DEBTOR_CONCENTRATION',
        'EXPOSURE_EXHAUSTED',
        'MANDATE_NOT_ACTIVE',
        'RATING_BELOW_MANDATE',
        'TENOR_EXCEEDS_MANDATE',
      ].sort(),
    );
  });

  it('reports matches and refusals side by side from a mixed book', () => {
    const result = bestQuote(
      invoice(),
      [
        mandate({ id: 'm-ok-1', annualisedYieldBps: 900 }),
        mandate({ id: 'm-no', minRating: 'A' }),
        mandate({ id: 'm-ok-2', annualisedYieldBps: 750 }),
      ],
      debtor(),
      { asOf: AS_OF },
    );

    expect(result.mandate?.id).toBe('m-ok-2');
    expect(matchCount(result)).toBe(2);
    expect(result.refusals.map((r) => r.mandateId)).toEqual(['m-no']);
  });
});

describe('bestQuote — clock', () => {
  it('rejects an unparseable asOf rather than pricing against NaN', () => {
    expect(() => bestQuote(invoice(), [mandate()], debtor(), { asOf: 'yesterday' })).toThrow(
      RangeError,
    );
  });

  it('prices overdue paper at face rather than above it', () => {
    const result = bestQuote(invoice(), [mandate()], debtor(), {
      asOf: '2026-12-25T00:00:00.000Z',
    });
    expect(result.tenorDays).toBe(0);
    expect(result.quote?.proceeds).toBe(4_000_000n);
  });
});
