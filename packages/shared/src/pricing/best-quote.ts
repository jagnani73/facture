import type { InstantLike, IsoDateTime } from '../types/common.js';
import type { Debtor } from '../types/debtor.js';
import type { Invoice } from '../types/invoice.js';
import { isQuotable } from '../types/invoice.js';
import type { Mandate } from '../types/mandate.js';
import { remainingForDebtor, unallocated } from '../types/mandate.js';
import { meetsRatingFloor } from '../types/rating.js';
import type { Quote } from '../types/quote.js';
import type { Refusal, RefusalReceipt } from '../types/refusal.js';
import { refusalReceipt } from '../types/refusal.js';
import { priceInvoice, tenorDays } from './curve.js';

/**
 * Read the curve for one invoice.
 *
 * This is the screen described in the README — *"$40,000 · due in 60 days · worth $39,180
 * today · three mandates would take this"* — expressed as a function. The seller never asks
 * for a price; the price is a pure function of the book.
 *
 * Two properties matter more than the selection itself:
 *
 * 1. **Eligibility is checked before matching, never at settlement.** Every mandate that
 *    does not match produces a `RefusalReceipt` explaining which comparison failed, in
 *    words. That is the difference from an AMM, which matches first and discovers the
 *    transfer was illegal afterwards.
 * 2. **The best quote is the *lowest* yield.** Lowest yield is the smallest discount, which
 *    is the most money for the seller. A book that sorted the other way would be running an
 *    auction for the buyer's benefit.
 */

const DEFAULT_QUOTE_TTL_SECONDS = 300;

export interface BestQuoteOptions {
  /** Clock. Defaults to now. Injectable so a quote is reproducible in a test. */
  readonly asOf?: InstantLike | undefined;
  /** How long the returned quote stays firm. Defaults to five minutes. */
  readonly quoteTtlSeconds?: number | undefined;
}

export interface BestQuoteResult {
  /** The best available price, or `null` when nothing on the book will take this paper. */
  readonly quote: Quote | null;
  /** The mandate behind `quote`. `null` whenever `quote` is. */
  readonly mandate: Mandate | null;
  /**
   * Every mandate that was considered and did not match, with the reason. A mandate-level
   * refusal carries that mandate's id; a refusal about the invoice itself carries `null`,
   * because an unconfirmed invoice is refused once rather than once per bid on the book.
   */
  readonly refusals: readonly RefusalReceipt[];
  /** Mandates that matched, best first. `matches[0]` is the one behind `quote`. */
  readonly matches: readonly { readonly mandate: Mandate; readonly quote: Quote }[];
  readonly tenorDays: number;
  readonly asOf: IsoDateTime;
}

interface Candidate {
  readonly mandate: Mandate;
  readonly quote: Quote;
}

export function bestQuote(
  invoice: Invoice,
  mandates: readonly Mandate[],
  debtor: Debtor,
  options: BestQuoteOptions = {},
): BestQuoteResult {
  const asOfDate = toDate(options.asOf);
  const asOf = asOfDate.toISOString();
  const ttlSeconds = options.quoteTtlSeconds ?? DEFAULT_QUOTE_TTL_SECONDS;
  const expiresAt = new Date(asOfDate.getTime() + ttlSeconds * 1000).toISOString();
  const days = tenorDays(invoice.dueAt, asOfDate);

  // An invoice that may not be priced is refused once, against the invoice rather than
  // against every mandate on the book. Returning N identical receipts would be noise.
  if (!isQuotable(invoice)) {
    return {
      quote: null,
      mandate: null,
      refusals: [
        refusalReceipt(
          invoice.id,
          null,
          { code: 'INVOICE_NOT_CONFIRMED', status: invoice.status },
          asOf,
        ),
      ],
      matches: [],
      tenorDays: days,
      asOf,
    };
  }

  const refusals: RefusalReceipt[] = [];
  const candidates: Candidate[] = [];

  for (const mandate of mandates) {
    const refusal = screen(invoice, mandate, debtor, days);
    if (refusal !== null) {
      refusals.push(refusalReceipt(invoice.id, mandate.id, refusal, asOf));
      continue;
    }

    const breakdown = priceInvoice(invoice.faceValue, mandate.annualisedYieldBps, days);

    /*
     * Capacity is tested against the *proceeds*, not the face value: the mandate pays the
     * discounted price today and is repaid face at maturity, so the cash it must have on
     * hand is the proceeds. Testing against face would reject mandates that can afford the
     * trade, which on a wide-tenor book is a meaningful amount of liquidity to lose.
     */
    const required = breakdown.proceeds;
    const capacityRefusal = screenCapacity(mandate, debtor, required, invoice);
    if (capacityRefusal !== null) {
      refusals.push(refusalReceipt(invoice.id, mandate.id, capacityRefusal, asOf));
      continue;
    }

    candidates.push({
      mandate,
      quote: {
        invoiceId: invoice.id,
        mandateId: mandate.id,
        annualisedYieldBps: mandate.annualisedYieldBps,
        tenorDays: days,
        faceValue: invoice.faceValue,
        discount: breakdown.discount,
        proceeds: breakdown.proceeds,
        currency: invoice.currency,
        asOf,
        expiresAt,
      },
    });
  }

  candidates.sort(compareCandidates(debtor.id));

  const best = candidates[0];
  return {
    quote: best?.quote ?? null,
    mandate: best?.mandate ?? null,
    refusals,
    matches: candidates,
    tenorDays: days,
    asOf,
  };
}

/**
 * Ordering, best for the seller first:
 *
 * 1. **Lowest annualised yield.** The whole point — the smallest discount off face.
 * 2. **Deepest unallocated balance.** A tie on price goes to the mandate with the most room
 *    left, which spreads the book's exposure instead of exhausting one bid at a time.
 * 3. **Lowest mandate id.** Purely to make the result deterministic. Two identical bids must
 *    not select differently between two calls, or the same invoice would show two different
 *    counterparties on two refreshes.
 */
const compareCandidates =
  (debtorId: string) =>
  (a: Candidate, b: Candidate): number => {
    const byYield = a.quote.annualisedYieldBps - b.quote.annualisedYieldBps;
    if (byYield !== 0) return byYield;

    const depthA = unallocated(a.mandate);
    const depthB = unallocated(b.mandate);
    if (depthA !== depthB) return depthA > depthB ? -1 : 1;

    const roomA = remainingForDebtor(a.mandate, debtorId);
    const roomB = remainingForDebtor(b.mandate, debtorId);
    if (roomA !== roomB) return roomA > roomB ? -1 : 1;

    return a.mandate.id < b.mandate.id ? -1 : a.mandate.id > b.mandate.id ? 1 : 0;
  };

/**
 * The checks that do not depend on price. Ordered cheapest and most explanatory first: a
 * buyer whose mandate is unfunded should be told that, not told about a rating floor.
 */
function screen(invoice: Invoice, mandate: Mandate, debtor: Debtor, days: number): Refusal | null {
  if (mandate.status !== 'active') {
    return { code: 'MANDATE_NOT_ACTIVE', status: mandate.status };
  }

  if (mandate.currency !== undefined && mandate.currency !== invoice.currency) {
    return {
      code: 'CURRENCY_MISMATCH',
      invoiceCurrency: invoice.currency,
      mandateCurrency: mandate.currency,
    };
  }

  if (!meetsRatingFloor(debtor.rating, mandate.minRating)) {
    return {
      code: 'RATING_BELOW_MANDATE',
      debtorId: debtor.id,
      debtorRating: debtor.rating,
      minRating: mandate.minRating,
    };
  }

  // Inclusive: an invoice at exactly `maxTenorDays` is inside a "ninety days or less" bid.
  if (days > mandate.maxTenorDays) {
    return { code: 'TENOR_EXCEEDS_MANDATE', tenorDays: days, maxTenorDays: mandate.maxTenorDays };
  }

  return null;
}

/** The two capacity checks, which need the priced proceeds. */
function screenCapacity(
  mandate: Mandate,
  debtor: Debtor,
  required: bigint,
  invoice: Invoice,
): Refusal | null {
  const pool = unallocated(mandate);
  if (pool < required) {
    return {
      code: 'EXPOSURE_EXHAUSTED',
      required,
      unallocated: pool,
      currency: invoice.currency,
    };
  }

  const perDebtor = remainingForDebtor(mandate, debtor.id);
  if (perDebtor < required) {
    return {
      code: 'DEBTOR_CONCENTRATION',
      debtorId: debtor.id,
      debtorName: debtor.name,
      required,
      remainingForDebtor: perDebtor,
      maxPerDebtor: mandate.maxPerDebtor,
      currency: invoice.currency,
    };
  }

  return null;
}

function toDate(value: InstantLike | undefined): Date {
  if (value === undefined) return new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`bestQuote: asOf is not a valid instant: ${String(value)}`);
  }
  return date;
}

/**
 * How many mandates would take this invoice — the "three mandates would take this" line
 * under the price. A count, not a list, because the seller does not choose a counterparty.
 */
export const matchCount = (result: BestQuoteResult): number => result.matches.length;
