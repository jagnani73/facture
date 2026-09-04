/**
 * The decision, and the refusals.
 *
 * The point of these tests is not that `decide` computes a price — `@facture/shared` is
 * tested for that. It is that **every way a mandate can say no is reachable, named, and
 * says the same thing the venue would say**, and that the two caps genuinely bind. Those
 * are the checks standing between a mandate and an overspend, because Circle enforces
 * nothing on this path.
 */

import { describe, expect, it } from 'vitest';
import {
  bestQuote,
  explainRefusal,
  priceInvoice,
  REFUSAL_CODES,
  type Debtor,
  type Invoice,
  type Rating,
  type RefusalCode,
} from '@facture/shared';
import {
  AGENT_EMITTED_REFUSAL_CODES,
  assertWellFormed,
  availableFor,
  checkWalletFunded,
  debtorHeadroom,
  decide,
  explainAgentRefusal,
  exposureTo,
  isQuoting,
  isWalletBalanceShort,
  NO_ALLOCATIONS,
  ON_CHAIN_REASON_CODE,
  toSharedMandate,
  unallocated,
  withAllocation,
  type InvoiceCandidate,
  type MandateAllocations,
  type MandateTerms,
} from '../src/mandate.js';

/** $200,000 committed, $50,000 per customer, A or better, 90 days, 12.5% annualised. */
const TERMS: MandateTerms = {
  id: 'mandate-a',
  buyerId: 'buyer-1',
  currency: 'USD',
  minRating: 'A',
  maxTenorDays: 90,
  annualisedYieldBps: 1250,
  totalCommitted: 20_000_000n,
  maxPerDebtor: 5_000_000n,
  status: 'active',
};

/** $40,000 face, 60 days, A-rated customer. */
const CANDIDATE: InvoiceCandidate = {
  invoiceId: 'invoice-1',
  debtorId: 'debtor-1',
  debtorName: 'Northwind Trading',
  rating: 'A',
  tenorDays: 60,
  faceValue: 4_000_000n,
  currency: 'USD',
};

const terms = (over: Partial<MandateTerms> = {}): MandateTerms => ({ ...TERMS, ...over });
const candidate = (over: Partial<InvoiceCandidate> = {}): InvoiceCandidate => ({
  ...CANDIDATE,
  ...over,
});
const allocated = (total: bigint, byDebtor: Record<string, bigint> = {}): MandateAllocations => ({
  total,
  byDebtor,
});

/** The proceeds the mandate would have to pay for the default candidate. */
const PROCEEDS = priceInvoice(
  CANDIDATE.faceValue,
  TERMS.annualisedYieldBps,
  CANDIDATE.tenorDays,
).proceeds;

describe('decide — acceptance', () => {
  it('takes paper inside every bound and prices it off the mandate yield', () => {
    const outcome = decide(terms(), NO_ALLOCATIONS, candidate());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.mandateId).toBe('mandate-a');
    expect(outcome.value.invoiceId).toBe('invoice-1');
    expect(outcome.value.annualisedYieldBps).toBe(1250);
    expect(outcome.value.faceValue).toBe(4_000_000n);
    // 4_000_000 × 1250 × 60 / (10 000 × 365), rounded up in the buyer's favour.
    expect(outcome.value.discount).toBe(82_192n);
    expect(outcome.value.proceeds).toBe(3_917_808n);
    expect(outcome.value.discount + outcome.value.proceeds).toBe(outcome.value.faceValue);
  });

  it('accepts a tenor exactly at the ceiling — "ninety days or less" includes ninety', () => {
    expect(decide(terms(), NO_ALLOCATIONS, candidate({ tenorDays: 90 })).ok).toBe(true);
    expect(decide(terms(), NO_ALLOCATIONS, candidate({ tenorDays: 91 })).ok).toBe(false);
  });

  it('accepts proceeds exactly equal to the unallocated balance', () => {
    const exact = allocated(TERMS.totalCommitted - PROCEEDS);
    expect(decide(terms(), exact, candidate()).ok).toBe(true);

    const oneShort = allocated(TERMS.totalCommitted - PROCEEDS + 1n);
    expect(decide(terms(), oneShort, candidate()).ok).toBe(false);
  });
});

describe('decide — every refusal is reachable and named', () => {
  /** Each case names the code, and a mandate/candidate pair that provokes exactly it. */
  const cases: ReadonlyArray<{
    readonly code: RefusalCode;
    readonly terms: MandateTerms;
    readonly allocations: MandateAllocations;
    readonly candidate: InvoiceCandidate;
    readonly says: RegExp;
  }> = [
    {
      code: 'MANDATE_NOT_ACTIVE',
      terms: terms({ status: 'funding' }),
      allocations: NO_ALLOCATIONS,
      candidate: candidate(),
      says: /still being funded/i,
    },
    {
      code: 'CURRENCY_MISMATCH',
      terms: terms({ currency: 'EUR' }),
      allocations: NO_ALLOCATIONS,
      candidate: candidate({ currency: 'USD' }),
      says: /denominated in USD.*bids in EUR/i,
    },
    {
      code: 'RATING_BELOW_MANDATE',
      terms: terms({ minRating: 'A' }),
      allocations: NO_ALLOCATIONS,
      candidate: candidate({ rating: 'C' }),
      says: /rated C.*takes A or better/i,
    },
    {
      code: 'TENOR_EXCEEDS_MANDATE',
      terms: terms({ maxTenorDays: 90 }),
      allocations: NO_ALLOCATIONS,
      candidate: candidate({ tenorDays: 120 }),
      says: /matures in 120 days.*90 days or less/i,
    },
    {
      code: 'EXPOSURE_EXHAUSTED',
      terms: terms(),
      // $199,000 of $200,000 already spoken for: room for nothing like a $39k invoice.
      allocations: allocated(19_900_000n),
      candidate: candidate(),
      says: /committed capital left/i,
    },
    {
      code: 'DEBTOR_CONCENTRATION',
      terms: terms(),
      // Plenty in the pool; $49,000 of the $50,000 per-customer cap already used.
      allocations: allocated(4_900_000n, { 'debtor-1': 4_900_000n }),
      candidate: candidate(),
      says: /caps exposure to Northwind Trading/i,
    },
  ];

  for (const c of cases) {
    it(`refuses with ${c.code}`, () => {
      const outcome = decide(c.terms, c.allocations, c.candidate);

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;

      expect(outcome.error.code).toBe(c.code);
      // Named is not enough — the sentence has to name both sides of the comparison.
      expect(explainAgentRefusal(outcome.error)).toMatch(c.says);
      expect(explainAgentRefusal(outcome.error)).toBe(explainRefusal(outcome.error));
    });
  }

  it('covers every refusal `decide` is capable of producing', () => {
    const produced = new Set(cases.map((c) => c.code));
    const decidable = AGENT_EMITTED_REFUSAL_CODES.filter(
      // `decide` sees neither the invoice's status nor the wallet; those two are refused
      // by the agent loop, and are covered in agent.test.ts.
      (code) => code !== 'INVOICE_NOT_CONFIRMED' && code !== 'WALLET_BALANCE_SHORT',
    );
    expect([...produced].sort()).toEqual([...decidable].sort());
  });

  it('does not claim refusals only a compliance gate can decide', () => {
    const notOurs = REFUSAL_CODES.filter(
      (code) => !(AGENT_EMITTED_REFUSAL_CODES as readonly string[]).includes(code),
    );
    expect(notOurs).toEqual(['INELIGIBLE_JURISDICTION', 'NOT_KYC_VERIFIED']);
  });
});

describe('decide — the caps bind', () => {
  it('refuses an allocation that would breach the total exposure ceiling', () => {
    // $200,000 committed, $180,000 allocated: $20,000 left against a $39,178 invoice.
    const outcome = decide(terms(), allocated(18_000_000n), candidate());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('EXPOSURE_EXHAUSTED');
    if (outcome.error.code !== 'EXPOSURE_EXHAUSTED') return;
    expect(outcome.error.required).toBe(PROCEEDS);
    expect(outcome.error.unallocated).toBe(2_000_000n);
  });

  it('refuses an allocation that would breach the per-debtor cap while the pool is deep', () => {
    // Nothing else allocated at all, but this customer already sits at $30,000 of $50,000.
    const outcome = decide(terms(), allocated(3_000_000n, { 'debtor-1': 3_000_000n }), candidate());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('DEBTOR_CONCENTRATION');
    if (outcome.error.code !== 'DEBTOR_CONCENTRATION') return;
    expect(outcome.error.required).toBe(PROCEEDS);
    expect(outcome.error.remainingForDebtor).toBe(2_000_000n);
    expect(outcome.error.maxPerDebtor).toBe(5_000_000n);
    // The pool is emphatically not the binding constraint here.
    expect(unallocated(terms(), allocated(3_000_000n))).toBeGreaterThan(PROCEEDS);
  });

  it('reports the pool before the concentration cap when both are breached', () => {
    // Both are short. The pool is the more important fact: the mandate is out of money,
    // not merely out of room on one customer.
    const outcome = decide(
      terms(),
      allocated(19_990_000n, { 'debtor-1': 4_990_000n }),
      candidate(),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('EXPOSURE_EXHAUSTED');
  });

  it('exposure to one debtor does not consume another debtor’s headroom', () => {
    const allocations = allocated(4_900_000n, { 'debtor-9': 4_900_000n });
    expect(decide(terms(), allocations, candidate({ debtorId: 'debtor-1' })).ok).toBe(true);
    expect(decide(terms(), allocations, candidate({ debtorId: 'debtor-9' })).ok).toBe(false);
  });

  it('ranks D below UNRATED, so the widest floor still refuses a defaulter', () => {
    const widest = terms({ minRating: 'UNRATED' });
    expect(decide(widest, NO_ALLOCATIONS, candidate({ rating: 'UNRATED' })).ok).toBe(true);
    expect(decide(widest, NO_ALLOCATIONS, candidate({ rating: 'D' })).ok).toBe(false);
  });
});

describe('money stays in bigint', () => {
  it('never returns a number on the money path', () => {
    const outcome = decide(terms(), NO_ALLOCATIONS, candidate());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    for (const field of ['faceValue', 'discount', 'proceeds'] as const) {
      expect(typeof outcome.value[field]).toBe('bigint');
    }
    // The two that genuinely are counts, not amounts.
    expect(typeof outcome.value.tenorDays).toBe('number');
    expect(typeof outcome.value.annualisedYieldBps).toBe('number');
  });

  it('is exact past 2^53, where a double would already have drifted', () => {
    // 10^17 cents of face — a thousand trillion dollars, well past Number.MAX_SAFE_INTEGER.
    const huge = 100_000_000_000_000_000n;
    expect(huge).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));

    const outcome = decide(
      terms({ totalCommitted: huge * 2n, maxPerDebtor: huge * 2n }),
      NO_ALLOCATIONS,
      candidate({ faceValue: huge }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // ceil(10^17 × 1250 × 60 / 3_650_000) — one exact rational, not a float. The trailing
    // `…946` is the round-up: a double would have landed on `…945.2` and lost the cent.
    expect(outcome.value.discount).toBe(2_054_794_520_547_946n);
    expect(outcome.value.proceeds).toBe(97_945_205_479_452_054n);
    expect(outcome.value.proceeds + outcome.value.discount).toBe(huge);
  });

  it('carries bigint operands into the refusal rather than rendering them early', () => {
    const outcome = decide(terms(), allocated(19_900_000n), candidate());
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.error.code !== 'EXPOSURE_EXHAUSTED') return;
    expect(typeof outcome.error.required).toBe('bigint');
    expect(typeof outcome.error.unallocated).toBe('bigint');
  });
});

describe('checkWalletFunded', () => {
  it('passes when the wallet covers the proceeds, and reports what is left', () => {
    const result = checkWalletFunded({
      walletId: 'wallet-1',
      required: 3_917_808n,
      available: 5_000_000n,
      currency: 'USD',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(1_082_192n);
    expect(typeof result.value).toBe('bigint');
  });

  it('refuses one minor unit short, and says so in words', () => {
    const result = checkWalletFunded({
      walletId: 'wallet-1',
      required: 3_917_808n,
      available: 3_917_807n,
      currency: 'USD',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('WALLET_BALANCE_SHORT');
    expect(isWalletBalanceShort(result.error)).toBe(true);
    const sentence = explainAgentRefusal(result.error);
    expect(sentence).toContain('$39,178.07');
    expect(sentence).toContain('$39,178.08');
    expect(sentence).toMatch(/not funded/i);
  });

  it('is a distinct code from EXPOSURE_EXHAUSTED — books and chain are different questions', () => {
    // The mandate's books say there is room; the wallet that has to pay is empty.
    const bookOutcome = decide(terms(), NO_ALLOCATIONS, candidate());
    expect(bookOutcome.ok).toBe(true);

    const chainOutcome = checkWalletFunded({
      walletId: 'wallet-1',
      required: PROCEEDS,
      available: 0n,
      currency: 'USD',
    });
    expect(chainOutcome.ok).toBe(false);
    if (chainOutcome.ok) return;
    expect(chainOutcome.error.code).not.toBe('EXPOSURE_EXHAUSTED');
  });
});

describe('running allocations within one pass', () => {
  it('stops a mandate spending the same balance on two invoices', () => {
    // $50,000 committed and no per-customer cap in the way. One $39,178 invoice fits;
    // two do not, and the second must be refused rather than double-counted.
    const small = terms({ totalCommitted: 5_000_000n, maxPerDebtor: 5_000_000n });

    const first = decide(small, NO_ALLOCATIONS, candidate({ invoiceId: 'a' }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const after = withAllocation(NO_ALLOCATIONS, first.value);
    expect(after.total).toBe(PROCEEDS);
    expect(after.byDebtor['debtor-1']).toBe(PROCEEDS);

    const second = decide(small, after, candidate({ invoiceId: 'b' }));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('EXPOSURE_EXHAUSTED');
  });

  it('accumulates per-debtor exposure across several fills', () => {
    // $80,000 per customer: two $39,178 fills fit, the third does not.
    const wider = terms({ maxPerDebtor: 8_000_000n });

    let allocations = NO_ALLOCATIONS;
    for (const id of ['a', 'b']) {
      const outcome = decide(wider, allocations, candidate({ invoiceId: id }));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      allocations = withAllocation(allocations, outcome.value);
    }

    expect(exposureTo(allocations, 'debtor-1')).toBe(PROCEEDS * 2n);
    expect(debtorHeadroom(wider, allocations, 'debtor-1')).toBe(8_000_000n - PROCEEDS * 2n);

    const third = decide(wider, allocations, candidate({ invoiceId: 'c' }));
    expect(third.ok).toBe(false);
    if (third.ok) return;
    // The pool is untouched at $200,000; it is the customer cap that stops it.
    expect(third.error.code).toBe('DEBTOR_CONCENTRATION');
  });
});

describe('headroom helpers', () => {
  it('clamps at zero rather than reporting negative capacity', () => {
    const over = allocated(25_000_000n, { 'debtor-1': 9_000_000n });
    expect(unallocated(terms(), over)).toBe(0n);
    expect(debtorHeadroom(terms(), over, 'debtor-1')).toBe(0n);
    expect(availableFor(terms(), over, 'debtor-1')).toBe(0n);
  });

  it('availableFor takes the lesser of the pool and the concentration cap', () => {
    expect(availableFor(terms(), NO_ALLOCATIONS, 'debtor-1')).toBe(5_000_000n);
    expect(availableFor(terms({ totalCommitted: 1_000_000n }), NO_ALLOCATIONS, 'x')).toBe(
      1_000_000n,
    );
  });

  it('only an active mandate quotes', () => {
    expect(isQuoting(terms())).toBe(true);
    for (const status of ['draft', 'funding', 'exhausted', 'withdrawn'] as const) {
      expect(isQuoting(terms({ status }))).toBe(false);
    }
  });
});

describe('agreement with the venue', () => {
  /**
   * The agent must refuse for the same reason the venue would, or the receipt the seller
   * reads will not match the one the buyer reads. Rather than asserting that by eye, the
   * same mandate is run through `@facture/shared`'s `bestQuote` — the code the backend
   * itself calls — and the two answers are compared.
   */
  const invoice = (over: Partial<Invoice> = {}): Invoice => ({
    id: 'invoice-1',
    sellerId: 'seller-1',
    debtorId: 'debtor-1',
    faceValue: 4_000_000n,
    currency: 'USD',
    invoiceNumber: 'INV-1',
    issuedAt: '2026-09-01T00:00:00.000Z',
    dueAt: '2026-10-31T00:00:00.000Z',
    status: 'listed',
    uniquenessHash: `0x${'11'.repeat(32)}`,
    ...over,
  });

  const debtorAt = (rating: Rating): Debtor => ({
    id: 'debtor-1',
    name: 'Northwind Trading',
    rating,
    onTimeCount: 4,
    defaultCount: 0,
    confirmedCount: 4,
  });

  const asOf = '2026-09-01T00:00:00.000Z';

  it('prices an accepted invoice to the same proceeds the venue would', () => {
    const outcome = decide(terms(), NO_ALLOCATIONS, candidate({ tenorDays: 60 }));
    const venue = bestQuote(invoice(), [toSharedMandate(terms(), NO_ALLOCATIONS)], debtorAt('A'), {
      asOf,
    });

    expect(outcome.ok).toBe(true);
    expect(venue.quote).not.toBeNull();
    if (!outcome.ok || venue.quote === null) return;
    expect(venue.tenorDays).toBe(60);
    expect(outcome.value.proceeds).toBe(venue.quote.proceeds);
    expect(outcome.value.discount).toBe(venue.quote.discount);
  });

  it.each([
    { label: 'rating', rating: 'C' as Rating, allocations: NO_ALLOCATIONS },
    { label: 'pool', rating: 'A' as Rating, allocations: allocated(19_900_000n) },
    {
      label: 'concentration',
      rating: 'A' as Rating,
      allocations: allocated(4_900_000n, { 'debtor-1': 4_900_000n }),
    },
  ])('refuses with the same code the venue records ($label)', ({ rating, allocations }) => {
    const outcome = decide(terms(), allocations, candidate({ rating, tenorDays: 60 }));
    const venue = bestQuote(invoice(), [toSharedMandate(terms(), allocations)], debtorAt(rating), {
      asOf,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(venue.refusals.map((r) => r.code)).toEqual([outcome.error.code]);
    expect(venue.refusals[0]?.humanReason).toBe(explainAgentRefusal(outcome.error));
  });
});

describe('on-chain reason codes', () => {
  it('names an equivalent, or `null`, for every code the agent can emit', () => {
    for (const code of AGENT_EMITTED_REFUSAL_CODES) {
      expect(ON_CHAIN_REASON_CODE).toHaveProperty(code);
    }
    for (const code of REFUSAL_CODES) {
      expect(ON_CHAIN_REASON_CODE).toHaveProperty(code);
    }
  });

  it('maps the four the book spells differently', () => {
    // MandateBook.sol and @facture/shared are both canonical for their own layer, and they
    // disagree on wording for the same four refusals. Written down so it is not rediscovered.
    expect(ON_CHAIN_REASON_CODE.EXPOSURE_EXHAUSTED).toBe('INSUFFICIENT_UNALLOCATED');
    expect(ON_CHAIN_REASON_CODE.DEBTOR_CONCENTRATION).toBe('DEBTOR_LIMIT_EXCEEDED');
    expect(ON_CHAIN_REASON_CODE.RATING_BELOW_MANDATE).toBe('RATING_BELOW_FLOOR');
    expect(ON_CHAIN_REASON_CODE.TENOR_EXCEEDS_MANDATE).toBe('TENOR_ABOVE_CEILING');
  });

  it('admits the book has no equivalent for a currency or funding refusal', () => {
    expect(ON_CHAIN_REASON_CODE.CURRENCY_MISMATCH).toBeNull();
    expect(ON_CHAIN_REASON_CODE.WALLET_BALANCE_SHORT).toBeNull();
  });
});

describe('assertWellFormed', () => {
  it('accepts a partially funded mandate whose per-customer cap is not yet binding', () => {
    // Written for $200,000 total and $50,000 per customer, funded to $30,000 so far.
    expect(() =>
      assertWellFormed(terms({ totalCommitted: 3_000_000n, maxPerDebtor: 5_000_000n })),
    ).not.toThrow();
  });

  it('rejects a floor of D, which would buy paper on a known defaulter', () => {
    expect(() => assertWellFormed(terms({ minRating: 'D' }))).toThrow(/known to default/i);
  });

  it('rejects negative capital and a non-integer tenor ceiling', () => {
    expect(() => assertWellFormed(terms({ totalCommitted: -1n }))).toThrow(/non-negative/);
    expect(() => assertWellFormed(terms({ maxPerDebtor: -1n }))).toThrow(/non-negative/);
    expect(() => assertWellFormed(terms({ maxTenorDays: 0 }))).toThrow(/positive integer/);
    expect(() => assertWellFormed(terms({ annualisedYieldBps: 12.5 }))).toThrow(/whole number/);
  });
});
