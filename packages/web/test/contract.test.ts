/**
 * The wire contract.
 *
 * These are not tests of the backend. They are tests of the one rule `src/lib/api/contract.ts`
 * says it lives by — **a decoder never guesses** — because that rule is the sort a build
 * keeps passing after it stops holding. A decoder that reads the wrong field, coerces a
 * number into money, or invents a state for a block that arrived without one produces a
 * screen that renders confidently and wrongly; `tsc` cannot see any of it, because every one
 * of those mistakes is well-typed.
 *
 * So each case below asserts one of two things: the value that came out, or that an
 * `unreadable` `ApiError` came out instead and named the path that was wrong. There is no
 * third outcome the screens are allowed to receive.
 */

import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/problem';
import {
  hasUniquenessHash,
  readConfirmationPrompt,
  readConfirmationRequested,
  readHealth,
  readInvoice,
  readInvoiceDetail,
  readInvoiceRow,
  readLiveQuote,
  readMandate,
  readMandateEscrow,
  readMoney,
  readPage,
  readPaymentRequired,
  readPaymentRequirements,
  readRefusalReceipt,
  readTrade,
  readTradeProof,
  writeMoney,
} from '@/lib/api/contract';

/**
 * The decoder's failure is an `ApiError`, not a `TypeError`, and the path it names is the
 * whole value of failing — "the venue answered in a shape this build cannot read" is only
 * actionable if it says which field.
 */
function refusal(read: () => unknown): ApiError {
  let value: unknown;
  try {
    value = read();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error(`expected an unreadable ApiError, got ${JSON.stringify(value, replacer)}`);
}

const replacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? `${value}n` : value;

/** The real bond this venue issued, in the form a Solidity contract knows it by. */
const EVM_ADDRESS = '0x9cb3468607a359c214cb27159d5d5853d5e83877';

/** A minimally complete invoice: every field `readInvoice` requires and nothing else. */
const INVOICE = {
  id: '9f1c6f1e-0000-4000-8000-000000000001',
  sellerId: '9f1c6f1e-0000-4000-8000-0000000005e1',
  debtorId: '9f1c6f1e-0000-4000-8000-00000000debt',
  faceValue: '6230000',
  currency: 'USD',
  invoiceNumber: 'MF-2051',
  issuedAt: '2026-08-01T00:00:00.000Z',
  dueAt: '2026-11-01T00:00:00.000Z',
  status: 'confirmed',
} as const;

const QUOTE = {
  invoiceId: INVOICE.id,
  mandateId: '9f1c6f1e-0000-4000-8000-00000000ma11',
  annualisedYieldBps: 925,
  tenorDays: 92,
  faceValue: '6230000',
  discount: '145000',
  proceeds: '6085000',
  currency: 'USD',
  asOf: '2026-09-02T10:00:00.000Z',
  expiresAt: '2026-09-02T10:05:00.000Z',
} as const;

/* -------------------------------------------------------------------------- */
/* Money                                                                       */
/* -------------------------------------------------------------------------- */

describe('money', () => {
  it('reads a decimal string of minor units as a bigint', () => {
    expect(readMoney('6230000', 'x')).toBe(6_230_000n);
    expect(readMoney('0', 'x')).toBe(0n);
    expect(readMoney('-4200', 'x')).toBe(-4_200n);
  });

  /*
   * The reason the convention exists. `JSON.parse` would have produced a double here and
   * lost the last digits without anything on screen looking wrong.
   */
  it('keeps a figure past 2^53 exactly', () => {
    const beyondDouble = '90071992547409919';
    expect(readMoney(beyondDouble, 'x')).toBe(90_071_992_547_409_919n);
    expect(writeMoney(readMoney(beyondDouble, 'x'))).toBe(beyondDouble);
    expect(Number(beyondDouble).toString()).not.toBe(beyondDouble);
  });

  /*
   * A `number` here means the service dropped the convention. Coercing it would work for
   * every amount in the demo book and silently corrupt the ones that matter.
   */
  it('refuses a number where a string was owed, rather than coercing it', () => {
    const error = refusal(() => readMoney(6_230_000, 'invoice.faceValue'));
    expect(error.code).toBe('unreadable');
    expect(error.detail).toContain('invoice.faceValue');
    expect(error.detail).toContain('minor units');
  });

  it.each([
    ['a decimal fraction', '62.30'],
    ['exponent notation', '6.23e6'],
    ['a leading zero', '0062'],
    ['an empty string', ''],
    ['whitespace', ' 6230000 '],
    ['a formatted amount', '6,230,000'],
    ['null', null],
    ['a bigint', 6_230_000n],
  ])('refuses %s', (_label, value) => {
    expect(refusal(() => readMoney(value, 'x')).code).toBe('unreadable');
  });
});

/* -------------------------------------------------------------------------- */
/* Invoices and the issuance block                                             */
/* -------------------------------------------------------------------------- */

describe('readInvoice', () => {
  it('reads a complete invoice', () => {
    const invoice = readInvoice(INVOICE);
    expect(invoice.faceValue).toBe(6_230_000n);
    expect(invoice.status).toBe('confirmed');
    expect(invoice.currency).toBe('USD');
    expect(invoice.invoiceNumber).toBe('MF-2051');
  });

  it.each(['id', 'sellerId', 'debtorId', 'faceValue', 'invoiceNumber', 'issuedAt', 'dueAt'])(
    'refuses an invoice missing %s, naming it',
    (missing) => {
      const body: Record<string, unknown> = { ...INVOICE };
      delete body[missing];
      expect(refusal(() => readInvoice(body)).detail).toContain(`invoice.${missing}`);
    },
  );

  it('refuses a status the app has no rendering for', () => {
    const error = refusal(() => readInvoice({ ...INVOICE, status: 'factored' }));
    expect(error.detail).toContain('invoice.status');
    expect(error.detail).toContain('factored');
  });

  /*
   * The stand-in matters: the proof view prints a uniqueness hash as a claim about the
   * receivable, so it has to be able to tell the decoder's placeholder from a real one.
   */
  it('stands in for an absent uniqueness hash without claiming it arrived', () => {
    expect(hasUniquenessHash(readInvoice(INVOICE))).toBe(false);
    expect(readInvoice(INVOICE).uniquenessHash).toBe('0x');
    expect(hasUniquenessHash(readInvoice({ ...INVOICE, uniquenessHash: '0xabc123' }))).toBe(true);
  });

  /*
   * The venue holds two identifiers for one instrument and sends both. They are not
   * interchangeable: `instrumentAddress` is what `deployBond` returned and `securityId` is
   * the account number the same diamond answers to, and neither is computable from the other
   * outside the mirror node. This decoder used to read whichever arrived first into
   * `instrumentAddress`, which is typed `0x${string}` — so a native id type-checked as an
   * EVM address, and would have built an explorer link to nothing the first time anything
   * asked for one.
   */
  it('keeps the two instrument identifiers apart', () => {
    const invoice = readInvoice({
      ...INVOICE,
      instrumentAddress: EVM_ADDRESS,
      securityId: '0.0.10331926',
    });
    expect(invoice.instrumentAddress).toBe(EVM_ADDRESS);
    expect(invoice.securityId).toBe('0.0.10331926');
  });

  /*
   * The native id no longer stands in for the address. `isIssued` reads the address, and the
   * venue writes both in one update — an invoice carrying one and not the other is a
   * half-written row, not a rendering to paper over here.
   */
  it('does not let a native id stand in for an EVM address', () => {
    const invoice = readInvoice({ ...INVOICE, securityId: '0.0.10331926' });
    expect(invoice.instrumentAddress).toBeUndefined();
    expect(invoice.securityId).toBe('0.0.10331926');
  });

  it('refuses an instrument address that is not one', () => {
    const error = refusal(() => readInvoice({ ...INVOICE, instrumentAddress: '0xabc' }));
    expect(error.detail).toContain('invoice.instrumentAddress');
  });

  describe('the issuance block', () => {
    /*
     * Absent is not failed. A payload from before issuance was projected would otherwise
     * put a permanent "could not add" under an invoice that is merely queued.
     */
    it('is undefined when the service did not send one', () => {
      expect(readInvoice(INVOICE).issuance).toBeUndefined();
      expect(readInvoice({ ...INVOICE, issuance: null }).issuance).toBeUndefined();
    });

    it('is undefined when it arrived without a state', () => {
      expect(readInvoice({ ...INVOICE, issuance: { attempts: 3 } }).issuance).toBeUndefined();
    });

    it('reads every state the venue can be in', () => {
      for (const state of ['queued', 'issuing', 'issued', 'failed'] as const) {
        expect(readInvoice({ ...INVOICE, issuance: { state } }).issuance?.state).toBe(state);
      }
    });

    it('reads the attempt count, the transaction and the failure text', () => {
      const invoice = readInvoice({
        ...INVOICE,
        issuance: {
          state: 'failed',
          attempts: 3,
          transactionId: '0.0.10311549@1788000000.000000000',
          error: 'onlyValidISIN',
        },
      });
      expect(invoice.issuance).toEqual({
        state: 'failed',
        attempts: 3,
        transactionId: '0.0.10311549@1788000000.000000000',
        error: 'onlyValidISIN',
      });
    });

    it('refuses a state it does not know, rather than treating it as pending', () => {
      const error = refusal(() => readInvoice({ ...INVOICE, issuance: { state: 'minting' } }));
      expect(error.detail).toContain('invoice.issuance.state');
      expect(error.detail).toContain('minting');
    });
  });
});

describe('readInvoiceRow', () => {
  it('reads the row with its inline price and customer', () => {
    const row = readInvoiceRow({
      ...INVOICE,
      debtor: { id: INVOICE.debtorId, name: 'Meridian Fabrication', rating: 'B' },
      quote: QUOTE,
      tenorDays: 92,
      mandatesMatching: 3,
    });

    expect(row.invoice.id).toBe(INVOICE.id);
    expect(row.debtor?.name).toBe('Meridian Fabrication');
    expect(row.quote?.proceeds).toBe(6_085_000n);
    expect(row.tenorDays).toBe(92);
    expect(row.mandatesMatching).toBe(3);
  });

  /*
   * A row with no bid is the normal case, not a fault: nothing on the curve will take that
   * paper today, and the screen says so in words.
   */
  it('reads an unpriced row without inventing a price', () => {
    const row = readInvoiceRow({ ...INVOICE, quote: null, mandatesMatching: 0 });
    expect(row.quote).toBeNull();
    expect(row.debtor).toBeNull();
    expect(row.tenorDays).toBeNull();
    expect(row.mandatesMatching).toBe(0);
  });
});

describe('readInvoiceDetail', () => {
  it('gathers the flattened price back into one quote shape', () => {
    const detail = readInvoiceDetail({
      invoice: INVOICE,
      debtor: { id: INVOICE.debtorId, name: 'Meridian Fabrication', rating: 'B' },
      tenorDays: 92,
      quote: QUOTE,
      mandatesConsidered: 5,
      mandatesMatching: 3,
      refusals: [],
      pricedAt: '2026-09-02T10:00:00.000Z',
    });

    expect(detail.invoice.id).toBe(INVOICE.id);
    expect(detail.pricing.rating).toBe('B');
    expect(detail.pricing.quote?.annualisedYieldBps).toBe(925);
    // Only the quote route mints a handle to sell at; the detail route does not.
    expect(detail.pricing.quoteId).toBeNull();
  });

  it('reads an invoice that was not nested under a key', () => {
    expect(readInvoiceDetail(INVOICE).invoice.id).toBe(INVOICE.id);
  });

  /*
   * The screen offers a link to the instrument on HashScan off this field, and the book is
   * full of seeded rows naming securities that were never deployed. An absent answer must
   * therefore stay absent: read as `false` it would hide every real instrument, and read as
   * `true` it would publish links to contracts that do not exist.
   */
  it('keeps an unanswered instrument reading as null rather than false', () => {
    const base = {
      invoice: INVOICE,
      tenorDays: 92,
      quote: QUOTE,
      mandatesMatching: 3,
      refusals: [],
      pricedAt: '2026-09-02T10:00:00.000Z',
    };

    expect(readInvoiceDetail(base).pricing.instrumentReadable).toBeNull();
    expect(
      readInvoiceDetail({ ...base, instrumentReadable: null }).pricing.instrumentReadable,
    ).toBeNull();
    expect(
      readInvoiceDetail({ ...base, instrumentReadable: true }).pricing.instrumentReadable,
    ).toBe(true);
    expect(
      readInvoiceDetail({ ...base, instrumentReadable: false }).pricing.instrumentReadable,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The live quote                                                              */
/* -------------------------------------------------------------------------- */

describe('readLiveQuote', () => {
  const LIVE = {
    invoiceId: INVOICE.id,
    rating: 'B',
    tenorDays: 92,
    quote: QUOTE,
    quoteId: '9f1c6f1e-0000-4000-8000-0000000000q1',
    mandatesConsidered: 5,
    mandatesMatching: 3,
    refusals: [],
    pricedAt: '2026-09-02T10:00:00.000Z',
  };

  it('reads a priced answer', () => {
    const live = readLiveQuote(LIVE);
    expect(live.quote?.discount).toBe(145_000n);
    expect(live.quoteId).toBe(LIVE.quoteId);
    expect(live.mandatesConsidered).toBe(5);
  });

  /*
   * "No bid" is an answer. It carries the refusals that explain it, and the screen is owed
   * both — a null price with no reasons is the absence this product exists to stop.
   */
  it('reads a refused answer with its reasons and no price', () => {
    const live = readLiveQuote({
      ...LIVE,
      quote: null,
      quoteId: null,
      mandatesMatching: 0,
      refusals: [
        {
          invoiceId: INVOICE.id,
          mandateId: QUOTE.mandateId,
          code: 'TENOR_EXCEEDS_MANDATE',
          humanReason: 'This invoice runs 92 days and that mandate buys nothing past 60.',
          detail: { tenorDays: 92, maxTenorDays: 60 },
          checkedAt: '2026-09-02T10:00:00.000Z',
        },
      ],
    });

    expect(live.quote).toBeNull();
    expect(live.quoteId).toBeNull();
    expect(live.refusals).toHaveLength(1);
    expect(live.refusals[0]?.detail).toEqual({
      code: 'TENOR_EXCEEDS_MANDATE',
      tenorDays: 92,
      maxTenorDays: 60,
    });
  });

  /** A handle carried inside the quote is still a handle. */
  it('falls back to an id on the quote itself', () => {
    const live = readLiveQuote({ ...LIVE, quoteId: undefined, quote: { ...QUOTE, id: 'q-7' } });
    expect(live.quoteId).toBe('q-7');
  });
});

describe('readRefusalReceipt', () => {
  /*
   * The operands are what make a refusal an explanation rather than a code, and they arrive
   * as decimal strings because they are money. A refusal that lost them would read as
   * "exposure exhausted" with no figures against it.
   */
  it('rebuilds the operands of an exposure refusal as money', () => {
    const receipt = readRefusalReceipt({
      invoiceId: INVOICE.id,
      mandateId: QUOTE.mandateId,
      code: 'EXPOSURE_EXHAUSTED',
      humanReason: 'That mandate has committed everything it holds.',
      detail: { required: '6085000', unallocated: '1200000', currency: 'USD' },
      checkedAt: '2026-09-02T10:00:00.000Z',
    });

    expect(receipt.detail).toEqual({
      code: 'EXPOSURE_EXHAUSTED',
      required: 6_085_000n,
      unallocated: 1_200_000n,
      currency: 'USD',
    });
  });

  it('refuses a refusal code with no rendering behind it', () => {
    const error = refusal(() =>
      readRefusalReceipt({
        invoiceId: INVOICE.id,
        code: 'SANCTIONS_HIT',
        humanReason: 'no',
        checkedAt: '2026-09-02T10:00:00.000Z',
        detail: {},
      }),
    );
    expect(error.detail).toContain('refusal.code');
  });

  it('refuses an operand that arrived as a number', () => {
    const error = refusal(() =>
      readRefusalReceipt({
        invoiceId: INVOICE.id,
        code: 'EXPOSURE_EXHAUSTED',
        humanReason: 'no',
        checkedAt: '2026-09-02T10:00:00.000Z',
        detail: { required: 6_085_000, unallocated: '1200000' },
      }),
    );
    expect(error.detail).toContain('refusal.detail.required');
  });
});

/* -------------------------------------------------------------------------- */
/* Mandates                                                                    */
/* -------------------------------------------------------------------------- */

describe('readMandate', () => {
  const MANDATE = {
    id: QUOTE.mandateId,
    buyerId: '9f1c6f1e-0000-4000-8000-000000000bu1',
    ratingFloor: 'B',
    maxTenorDays: 120,
    annualisedYieldBps: 925,
    committed: '25000000',
    exposureLimit: '90000000',
    allocated: '6085000',
    perDebtorLimit: '10000000',
    status: 'active',
    currency: 'USD',
  };

  /*
   * The distinction this decoder exists to hold: `exposureLimit` is the ceiling the buyer
   * wrote, `committed` is the money they actually escrowed, and only the second bounds a
   * match. Reading the ceiling would make every quote on the book look firmer than it is.
   */
  it('takes the funded commitment, never the declared ceiling', () => {
    const mandate = readMandate(MANDATE);
    expect(mandate.totalCommitted).toBe(25_000_000n);
    expect(mandate.allocated).toBe(6_085_000n);
    expect(mandate.maxPerDebtor).toBe(10_000_000n);
    expect(mandate.minRating).toBe('B');
  });

  /** No concentration cap set means the total commitment is the only cap. */
  it('falls back to the commitment when no per-debtor cap was set', () => {
    const { perDebtorLimit: _omitted, ...withoutCap } = MANDATE;
    expect(readMandate(withoutCap).maxPerDebtor).toBe(25_000_000n);
  });

  /*
   * Both escrow figures are USDC ERC-20 minor units at 6 decimals, and a mandate's own money
   * is minor units at 2. The decoder used to read a field called `deposited` and the screen
   * rendered it with the dollar formatter, so a vault holding 5 USDC — 5,000,000 minor units
   * — was reported as "Backed by $50,000.00". Identical digits, four orders of magnitude
   * apart, which is why the field names now carry the unit.
   */
  it('reads both escrow figures as USDC minor units', () => {
    const escrow = readMandateEscrow(
      { checked: true, depositedUsdcMinor: '5000000', requiredUsdcMinor: '50000', backed: true },
      'mandate.escrow',
    );
    expect(escrow).toEqual({
      checked: true,
      depositedUsdcMinor: 5_000_000n,
      requiredUsdcMinor: 50_000n,
      backed: true,
    });
  });

  /* "We could not read the vault" is a third state, and must not render as "unbacked". */
  it('keeps an unreadable vault balance null rather than zero', () => {
    const escrow = readMandateEscrow(
      { checked: true, depositedUsdcMinor: null, requiredUsdcMinor: '50000', backed: false },
      'mandate.escrow',
    );
    expect(escrow?.depositedUsdcMinor).toBeNull();
    expect(escrow?.requiredUsdcMinor).toBe(50_000n);
  });

  /*
   * The required figure is what makes the deposited one mean anything, so an escrow block
   * arriving without it is unreadable rather than defaulted. A zero here would report every
   * bid as backed — the failure being fixed, arriving through the decoder instead.
   */
  it('refuses an escrow block with no required amount', () => {
    expect(() =>
      readMandateEscrow(
        { checked: true, depositedUsdcMinor: '5000000', backed: true },
        'mandate.escrow',
      ),
    ).toThrow(ApiError);
  });

  /** Absent entirely is the fixture book, which has no vault behind it. Not an error. */
  it('reads an absent escrow block as absent', () => {
    expect(readMandateEscrow(undefined, 'mandate.escrow')).toBeUndefined();
    expect(readMandateEscrow(null, 'mandate.escrow')).toBeUndefined();
  });

  it('reads the per-debtor exposure ladder as money', () => {
    const mandate = readMandate({
      ...MANDATE,
      debtorExposure: { [INVOICE.debtorId]: '6085000' },
    });
    expect(mandate.debtorExposure?.[INVOICE.debtorId]).toBe(6_085_000n);
  });

  it('refuses an exposure ladder entry that arrived as a number', () => {
    const error = refusal(() =>
      readMandate({ ...MANDATE, debtorExposure: { [INVOICE.debtorId]: 6_085_000 } }),
    );
    expect(error.detail).toContain(`mandate.debtorExposure.${INVOICE.debtorId}`);
  });
});

/* -------------------------------------------------------------------------- */
/* Envelopes                                                                   */
/* -------------------------------------------------------------------------- */

describe('readPage', () => {
  it('reads the collection under the key the route names', () => {
    const page = readPage(
      { invoices: [INVOICE], nextCursor: 'c2' },
      'book',
      readInvoice,
      'invoices',
    );
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('c2');
  });

  it('reads a bare array as a page with nothing after it', () => {
    expect(readPage([INVOICE], 'book', readInvoice, 'invoices').nextCursor).toBeNull();
  });

  it('refuses an envelope carrying nothing it can read as a collection', () => {
    const error = refusal(() => readPage({ rows: [] }, 'book', readInvoice, 'invoices'));
    expect(error.detail).toContain('invoices');
  });
});

/* -------------------------------------------------------------------------- */
/* Trades and the x402 challenge                                               */
/* -------------------------------------------------------------------------- */

describe('readTrade', () => {
  const TRADE = {
    id: '9f1c6f1e-0000-4000-8000-000000000t11',
    invoiceId: INVOICE.id,
    mandateId: QUOTE.mandateId,
    sellerId: INVOICE.sellerId,
    buyerId: '9f1c6f1e-0000-4000-8000-000000000bu1',
    faceValue: '6230000',
    annualisedYieldBps: 925,
    tenorDays: 92,
    discountMinor: '145000',
    proceedsMinor: '6085000',
    currency: 'USD',
    createdAt: '2026-09-02T10:00:00.000Z',
  };

  it('reads the trade, taking createdAt as the moment it executed', () => {
    const trade = readTrade(TRADE);
    expect(trade.proceeds).toBe(6_085_000n);
    expect(trade.discount).toBe(145_000n);
    expect(trade.executedAt).toBe(TRADE.createdAt);
    expect(trade.status).toBeUndefined();
  });

  it('defaults absent legs to pending on the chain each one settles on', () => {
    const trade = readTrade(TRADE);
    expect(trade.assetLeg).toEqual({ state: 'pending', chain: 'hedera-testnet' });
    expect(trade.cashLeg).toEqual({ state: 'pending', chain: 'arc-testnet' });
  });

  /*
   * The cash leg is not always Arc. This deployment settles in HBAR, and a leg reconciled to
   * the wrong chain hands the reader an ArcScan link over a Hedera transaction id.
   */
  it('reconciles a cash leg that settled on Hedera', () => {
    const trade = readTrade({
      ...TRADE,
      status: 'settled',
      cashLeg: { state: 'settled', chain: 'hedera', transactionId: '0.0.1@1.2' },
    });
    expect(trade.status).toBe('settled');
    expect(trade.cashLeg.chain).toBe('hedera-testnet');
    expect(trade.cashLeg.reference).toBe('0.0.1@1.2');
  });
});

describe('readPaymentRequirements', () => {
  const ACCEPTS = {
    scheme: 'exact',
    network: 'hedera:testnet',
    asset: '0.0.0',
    amount: '608500000',
    payTo: '0.0.10311549',
    maxTimeoutSeconds: 120,
    extra: { feePayer: '0.0.7162784' },
  };

  it('reads a v2 challenge', () => {
    const req = readPaymentRequirements(ACCEPTS, 'accepts[0]');
    expect(req.amount).toBe('608500000');
    expect(req.network).toBe('hedera:testnet');
    expect(req.extra['feePayer']).toBe('0.0.7162784');
  });

  /*
   * The rename that fails silently. `maxAmountRequired` is a well-formed field carrying the
   * right number, so nothing but this check separates "an older payload" from "a challenge
   * this build can sign".
   */
  it('refuses the pre-2.24 spelling instead of signing against a guess', () => {
    const { amount: _renamed, ...old } = ACCEPTS;
    const error = refusal(() =>
      readPaymentRequirements({ ...old, maxAmountRequired: '608500000' }, 'accepts[0]'),
    );
    expect(error.detail).toContain('accepts[0].amount');
    expect(error.detail).toContain('maxAmountRequired');
  });

  it('reads the whole payment-required body, resource and all', () => {
    const required = readPaymentRequired({
      x402Version: 2,
      accepts: [ACCEPTS],
      resource: { resource: 'https://venue/v1/trades', description: 'DvP', mimeType: null },
    });
    expect(required.accepts).toHaveLength(1);
    expect(required.resource?.mimeType).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The proof view                                                              */
/* -------------------------------------------------------------------------- */

describe('readTradeProof', () => {
  /** The deployed `InvoiceRegistry` this venue reads back from. */
  const REGISTRY = '0x44fe6E29aaDe69085CE53c4694b99EFe4639B7a7';

  const PROOF = {
    tradeId: '9f1c6f1e-0000-4000-8000-000000000t11',
    invoice: {
      id: INVOICE.id,
      invoiceNumber: 'MF-2051',
      uniquenessHash: '0xabc',
      isin: 'USQ72738QUM6',
      securityId: '0.0.10331926',
      securityExplorerUrl: 'https://hashscan.io/testnet/token/0.0.10331926',
      regulation: 'REG_S',
    },
    confirmation: { decision: 'confirmed', decidedAt: '2026-09-01T09:00:00.000Z' },
    registry: {
      checked: true,
      listed: true,
      confirmed: true,
      contractAddress: REGISTRY,
      explorerUrl: `https://hashscan.io/testnet/contract/${REGISTRY}`,
    },
    compliance: {
      decision: {
        allowed: true,
        reason: null,
        checks: [{ name: 'Control list', detail: 'Allowlisted', passed: true }],
      },
      checkedAt: '2026-09-02T10:00:00.000Z',
      hcsTopicId: '0.0.1',
      hcsSequenceNumber: '7',
      hcsExplorerUrl: null,
    },
    pricing: {
      ratingAtQuote: 'B',
      tenorDays: 92,
      annualisedYieldBps: 925,
      faceValue: '6230000',
      discountMinor: '145000',
      proceedsMinor: '6085000',
    },
    assetLeg: { chain: 'hedera', holdId: '1', transactionId: null, consensusAt: null },
    cashLeg: { chain: 'hedera', scheme: 'exact', network: 'hedera:testnet', asset: '0.0.0' },
    refusals: [],
    settledAt: '2026-09-02T10:00:30.000Z',
  };

  it('reads the receipts', () => {
    const proof = readTradeProof(PROOF);
    expect(proof.invoice.isin).toBe('USQ72738QUM6');
    expect(proof.confirmation.decision).toBe('confirmed');
    expect(proof.compliance.allowed).toBe(true);
    expect(proof.compliance.checks).toHaveLength(1);
    expect(proof.settledAt).toBe(PROOF.settledAt);
  });

  /*
   * The offering the instrument was actually deployed under, per invoice.
   *
   * The screen prints `REGULATIONS[key].label` off this, which is a claim about what was
   * offered and to whom — and the venue's row and its deploy calldata disagreed once
   * already. A spelling this build has no label for is refused rather than folded into null,
   * because dropping it silently hides a declaration that was made.
   */
  describe('the regulation the instrument was declared under', () => {
    it('reads the venue’s own declaration', () => {
      expect(readTradeProof(PROOF).invoice.regulation).toBe('REG_S');

      for (const key of ['REG_S', 'REG_D_506_B', 'REG_D_506_C'] as const) {
        const body = { ...PROOF, invoice: { ...PROOF.invoice, regulation: key } };
        expect(readTradeProof(body).invoice.regulation).toBe(key);
      }
    });

    it('is null when the venue did not say', () => {
      const unstated = { ...PROOF, invoice: { ...PROOF.invoice, regulation: null } };
      expect(readTradeProof(unstated).invoice.regulation).toBeNull();

      const { regulation: _dropped, ...invoice } = PROOF.invoice;
      expect(readTradeProof({ ...PROOF, invoice }).invoice.regulation).toBeNull();
    });

    /*
     * `reg-s` is the spelling the venue's own column carries. It is the same offering, and
     * it is still refused: this decoder's job is to say it cannot read a shape, not to guess
     * which of three declarations a lowercase word meant.
     */
    it('refuses a spelling it has no label for', () => {
      const kebab = { ...PROOF, invoice: { ...PROOF.invoice, regulation: 'reg-s' } };
      const error = refusal(() => readTradeProof(kebab));
      expect(error.detail).toContain('invoice.regulation');
      expect(error.detail).toContain('REG_S');
    });
  });

  /*
   * The chain's own account of the invoice, and the reason this block exists: `checked` is
   * not a boolean answer, it is whether there was an answer at all. The screen has to be
   * able to tell "the registry says no" from "nobody asked the registry", and this is where
   * that distinction survives or is lost.
   */
  describe('the public invoice registry', () => {
    const withRegistry = (registry: unknown) => readTradeProof({ ...PROOF, registry }).registry;

    it('reads an answer the venue actually got', () => {
      expect(
        withRegistry({
          checked: true,
          listed: true,
          confirmed: false,
          contractAddress: REGISTRY,
          explorerUrl: null,
        }),
      ).toEqual({
        checked: true,
        listed: true,
        confirmed: false,
        contractAddress: REGISTRY,
        explorerUrl: null,
      });
    });

    /*
     * Unchecked is a third state, and the two answers are null rather than false. A venue
     * that could not read the node has said nothing about this invoice — rendering that as
     * "not confirmed" would contradict, on the same screen, the confirmation the venue is
     * certain of.
     */
    it('keeps “could not ask” apart from “no”', () => {
      const unchecked = withRegistry({
        checked: false,
        listed: null,
        confirmed: null,
        contractAddress: REGISTRY,
        explorerUrl: null,
      });
      expect(unchecked.checked).toBe(false);
      expect(unchecked.listed).toBeNull();
      expect(unchecked.confirmed).toBeNull();
      // The address survives: a registry configured but unreadable is still worth naming.
      expect(unchecked.contractAddress).toBe(REGISTRY);
    });

    /*
     * A stray answer beside `checked: false` did not come from the node, whatever it says.
     * Carrying it through would let the screen print the chain's confirmation on the
     * strength of a field the venue explicitly did not stand behind.
     */
    it('drops an answer that arrived beside “could not ask”', () => {
      const contradictory = withRegistry({
        checked: false,
        listed: true,
        confirmed: true,
        contractAddress: null,
        explorerUrl: null,
      });
      expect(contradictory.listed).toBeNull();
      expect(contradictory.confirmed).toBeNull();
    });

    /** Absent means unchecked. A service from before this field is not an unreadable one. */
    it('reads a missing block as unchecked rather than as a failure', () => {
      const { registry: _dropped, ...body } = PROOF;
      const registry = readTradeProof(body).registry;
      expect(registry.checked).toBe(false);
      expect(registry.listed).toBeNull();
      expect(registry.confirmed).toBeNull();
      expect(registry.contractAddress).toBeNull();
      expect(registry.explorerUrl).toBeNull();
    });

    /*
     * Absent `checked` reads as unchecked and never as `true`: the reading that cannot
     * overclaim. The alternative presents whatever sat beside it as the chain's answer.
     */
    it('reads a missing flag as unchecked', () => {
      expect(withRegistry({ listed: true, confirmed: true }).checked).toBe(false);
      expect(withRegistry({ checked: 'yes', listed: true }).checked).toBe(false);
    });

    /*
     * With `checked: true` the two answers are the point of the block, so a non-boolean is
     * unreadable rather than quietly null — `null` there would render as "not answered" and
     * hide a venue sending a shape this build cannot read.
     */
    it('refuses an answer that is not a boolean', () => {
      const error = refusal(() => withRegistry({ checked: true, listed: 'yes', confirmed: true }));
      expect(error.detail).toContain('registry.listed');
    });

    /*
     * `checked: true` with a null answer is still three states. The venue does not send this
     * today, and a decoder that collapsed it into `false` would invent a chain reading.
     */
    it('keeps a null answer null even when the registry was read', () => {
      const partial = withRegistry({ checked: true, listed: true, confirmed: null });
      expect(partial.listed).toBe(true);
      expect(partial.confirmed).toBeNull();
    });
  });

  /*
   * The venue sends `unitsMinor` so a trade moving one unit of a face-value-many issuance
   * cannot hide. This decoder simply did not declare the field, so it was dropped in
   * silence for as long as anyone looked — the shape of failure a decoder test exists to
   * catch, since a field missing from a type is not a type error anywhere.
   */
  it('reads how many units the asset leg moved', () => {
    expect(
      readTradeProof({ ...PROOF, assetLeg: { ...PROOF.assetLeg, unitsMinor: '890000' } }).assetLeg
        .unitsMinor,
    ).toBe(890_000n);
    expect(readTradeProof(PROOF).assetLeg.unitsMinor).toBeNull();
  });

  it('refuses a unit count that is not a decimal string', () => {
    const error = refusal(() =>
      readTradeProof({ ...PROOF, assetLeg: { ...PROOF.assetLeg, unitsMinor: 890000 } }),
    );
    expect(error.detail).toContain('assetLeg.unitsMinor');
  });

  /*
   * The one documented exception to the "domain name and nothing else" rule: the backend
   * still spells these two with the old suffix and flags the rename as unmade. Both
   * spellings are read, because the rename can land on either side first.
   */
  it('reads the price under either spelling of discount and proceeds', () => {
    expect(readTradeProof(PROOF).pricing?.discount).toBe(145_000n);
    expect(readTradeProof(PROOF).pricing?.proceeds).toBe(6_085_000n);

    const renamed = {
      ...PROOF,
      pricing: {
        ratingAtQuote: 'B',
        tenorDays: 92,
        annualisedYieldBps: 925,
        faceValue: '6230000',
        discount: '145000',
        proceeds: '6085000',
      },
    };
    expect(readTradeProof(renamed).pricing?.discount).toBe(145_000n);
    expect(readTradeProof(renamed).pricing?.proceeds).toBe(6_085_000n);
  });

  it('refuses a price block carrying neither spelling', () => {
    const { discountMinor: _a, proceedsMinor: _b, ...bare } = PROOF.pricing;
    const error = refusal(() => readTradeProof({ ...PROOF, pricing: bare }));
    expect(error.detail).toContain('proof.pricing.discountMinor');
  });

  it('reads an unpriced proof as having no price rather than a zero one', () => {
    const { pricing: _absent, ...withoutPricing } = PROOF;
    expect(readTradeProof(withoutPricing).pricing).toBeNull();
  });

  /*
   * `compliance.decision` is an open bag on the wire. The screen shows the checklist it was
   * given and never one it invented, so an absent bag is an absent checklist — not a
   * passing one.
   */
  it('reads no checklist out of a decision that has none', () => {
    const proof = readTradeProof({ ...PROOF, compliance: { decision: null, checkedAt: null } });
    expect(proof.compliance.allowed).toBeNull();
    expect(proof.compliance.checks).toEqual([]);
  });

  it('carries the refused check in words', () => {
    const proof = readTradeProof({
      ...PROOF,
      compliance: {
        ...PROOF.compliance,
        decision: {
          allowed: false,
          reason: 'Harrow Point is not on this security’s control list.',
          checks: [{ name: 'Control list', detail: 'Not a member', passed: false }],
        },
      },
    });
    expect(proof.compliance.allowed).toBe(false);
    expect(proof.compliance.reason).toContain('control list');
    expect(proof.compliance.checks[0]?.passed).toBe(false);
  });

  /** The network wins over the bare chain word: it is what the payer actually signed against. */
  it('reconciles the cash leg off the network the payment was signed on', () => {
    expect(readTradeProof(PROOF).cashLeg.chain).toBe('hedera-testnet');
    expect(
      readTradeProof({ ...PROOF, cashLeg: { chain: 'arc', network: 'arc:testnet' } }).cashLeg.chain,
    ).toBe('arc-testnet');
    // Nothing said at all falls back to Arc rather than guessing from the asset.
    expect(readTradeProof({ ...PROOF, cashLeg: {} }).cashLeg.chain).toBe('arc-testnet');
  });

  describe('the maturity block', () => {
    const MATURITY = {
      scheduleId: '0.0.10331573',
      scheduleExplorerUrl: 'https://hashscan.io/testnet/schedule/0.0.10331573',
      state: 'pending',
      executedAt: null,
      transactionId: null,
      explorerUrl: null,
      payer: null,
      payee: null,
    };

    /*
     * Absent rather than empty. A present-but-blank block reads as "asked and answered with
     * nothing", which is a different claim from "this has not matured yet".
     */
    it('is null before the receivable has matured', () => {
      expect(readTradeProof(PROOF).maturity).toBeNull();
      expect(readTradeProof({ ...PROOF, maturity: null }).maturity).toBeNull();
    });

    it('reads an obligation that is waiting to be signed', () => {
      const maturity = readTradeProof({ ...PROOF, maturity: MATURITY }).maturity;
      expect(maturity?.state).toBe('pending');
      expect(maturity?.scheduleId).toBe('0.0.10331573');
      expect(maturity?.executedAt).toBeNull();
      expect(maturity?.payee).toBeNull();
    });

    /** Both sides of the transfer come off the executed transaction, not off configuration. */
    it('reads a payout that happened, with both sides of the transfer', () => {
      const maturity = readTradeProof({
        ...PROOF,
        maturity: {
          ...MATURITY,
          state: 'settled',
          executedAt: '2026-09-02T11:00:00.000Z',
          transactionId: '0.0.10331559@1788000000.000000000',
          explorerUrl: 'https://hashscan.io/testnet/transaction/x',
          payer: '0.0.10331559',
          payee: '0.0.10314099',
        },
      }).maturity;

      expect(maturity?.state).toBe('settled');
      expect(maturity?.payer).toBe('0.0.10331559');
      expect(maturity?.payee).toBe('0.0.10314099');
    });

    /*
     * The distinction the block exists to draw. Defaulting a missing state would render an
     * executed payout as an unpaid obligation, or the reverse — and either way the screen
     * would be making the claim rather than reporting one.
     */
    it('refuses a maturity block that arrived without a state', () => {
      const { state: _absent, ...stateless } = MATURITY;
      const error = refusal(() => readTradeProof({ ...PROOF, maturity: stateless }));
      expect(error.detail).toContain('proof.maturity.state');
    });

    it('refuses a state it has no rendering for', () => {
      const error = refusal(() =>
        readTradeProof({ ...PROOF, maturity: { ...MATURITY, state: 'paid' } }),
      );
      expect(error.detail).toContain('proof.maturity.state');
      expect(error.detail).toContain('paid');
    });

    /** No schedule id is no obligation to point at, whatever else the block carried. */
    it('is null when there is no schedule to show', () => {
      const { scheduleId: _absent, ...unscheduled } = MATURITY;
      expect(readTradeProof({ ...PROOF, maturity: unscheduled }).maturity).toBeNull();
    });
  });

  it('reads the refusals recorded against the invoice', () => {
    const proof = readTradeProof({
      ...PROOF,
      refusals: [
        {
          mandateId: QUOTE.mandateId,
          reasonCode: 'RATING_BELOW_MANDATE',
          reasonText: 'That mandate buys nothing below A.',
          hcsExplorerUrl: null,
        },
      ],
    });
    expect(proof.refusals[0]?.reasonCode).toBe('RATING_BELOW_MANDATE');
  });
});

/* -------------------------------------------------------------------------- */
/* Debtor confirmation                                                         */
/* -------------------------------------------------------------------------- */

describe('readConfirmationPrompt', () => {
  it('reads the sentence the customer is shown', () => {
    const prompt = readConfirmationPrompt({
      seller: 'Northgate Tooling',
      debtorName: 'Meridian Fabrication',
      invoiceNumber: 'MF-2051',
      amount: '$62,300.00',
      currency: 'USD',
      dueAt: INVOICE.dueAt,
      decision: null,
    });

    expect(prompt.sellerName).toBe('Northgate Tooling');
    expect(prompt.amount).toBe('$62,300.00');
    expect(prompt.decision).toBeNull();
  });

  /*
   * The debtor acknowledging their own accounts payable must never be shown the market
   * quoting their debt, and the surest guarantee is that no price reaches this screen at
   * all. Pinning the whole key set is what makes that a rule rather than an intention: a
   * rate, a proceeds figure or a mandate cannot be added here without this failing.
   */
  it('carries the operands of one sentence and nothing else', () => {
    const prompt = readConfirmationPrompt({
      seller: 'Northgate Tooling',
      amount: '$62,300.00',
      dueAt: INVOICE.dueAt,
      // Sent by a venue that got carried away. None of it may survive the decoder.
      quote: { annualisedYieldBps: 925, proceeds: '6085000' },
      mandateId: QUOTE.mandateId,
    });

    expect(Object.keys(prompt).sort()).toEqual([
      'amount',
      'currency',
      'debtorName',
      'decision',
      'dueAt',
      'expiresAt',
      'faceValue',
      'invoiceNumber',
      'sellerName',
    ]);
  });

  /** Formatted only where the source keeps minor units, which the demo book does. */
  it('formats the amount itself only when given the figure instead', () => {
    const prompt = readConfirmationPrompt({
      seller: { name: 'Northgate Tooling' },
      invoice: { faceValue: '6230000', currency: 'USD', dueAt: INVOICE.dueAt },
    });
    expect(prompt.faceValue).toBe(6_230_000n);
    expect(prompt.amount).toContain('62,300.00');
  });

  it('refuses a prompt with no amount to ask the customer about', () => {
    const error = refusal(() =>
      readConfirmationPrompt({ seller: 'Northgate Tooling', dueAt: INVOICE.dueAt }),
    );
    expect(error.detail).toContain('confirmation.amount');
  });
});

/* -------------------------------------------------------------------------- */
/* Health                                                                      */
/* -------------------------------------------------------------------------- */

describe('readConfirmationRequested', () => {
  const answered = {
    invoice: { id: INVOICE.id },
    confirmation: {
      sentTo: 'ap@meridian-fabrication.test',
      expiresAt: '2026-09-11T09:32:00.000Z',
      link: 'http://localhost:3000/confirm/abc123',
    },
  };

  it('reads the link the venue handed back', () => {
    const requested = readConfirmationRequested(answered);

    expect(requested.sentTo).toBe('ap@meridian-fabrication.test');
    expect(requested.link).toBe('http://localhost:3000/confirm/abc123');
  });

  /*
   * Production withholds the link, because a seller who can read it can confirm their own
   * invoices. That is a real answer rather than a missing one, so it decodes to null and
   * the screen says something different — it must never become an empty string that reads
   * as a link nobody can see.
   */
  it('keeps a withheld link distinct from a broken one', () => {
    const requested = readConfirmationRequested({
      ...answered,
      confirmation: { ...answered.confirmation, link: null },
    });

    expect(requested.link).toBeNull();
    expect(requested.sentTo).toBe('ap@meridian-fabrication.test');
  });

  it('refuses a link that is not a string', () => {
    expect(() =>
      readConfirmationRequested({
        ...answered,
        confirmation: { ...answered.confirmation, link: 42 },
      }),
    ).toThrow(ApiError);
  });

  it('names the path when the confirmation block is missing', () => {
    expect(() => readConfirmationRequested({ invoice: { id: INVOICE.id } })).toThrow(
      /confirmationRequest\.confirmation/,
    );
  });
});

describe('readHealth', () => {
  it('reads a dependency as healthy only when it said so', () => {
    const health = readHealth({
      status: 'ok',
      environment: 'testnet',
      uptimeSeconds: 42,
      dependencies: { database: { ok: true }, facilitator: { ok: false } },
      issuance: { queued: 3 },
    });

    expect(health.databaseOk).toBe(true);
    expect(health.facilitatorOk).toBe(false);
    expect(health.issuanceQueued).toBe(3);
  });

  it('reads an absent dependency block as not healthy rather than as fine', () => {
    const health = readHealth({ status: 'ok' });
    expect(health.databaseOk).toBe(false);
    expect(health.facilitatorOk).toBe(false);
    expect(health.issuanceQueued).toBeNull();
  });
});
