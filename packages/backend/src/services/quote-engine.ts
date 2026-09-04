/**
 * The quote engine.
 *
 * This is the product. A confirmed invoice carries a live price — not a button that
 * requests one — and the number moves as the curve moves and as the due date approaches.
 * Everything else in this service exists to make that screen true.
 *
 * Pricing is a read of the standing-bid curve at the invoice's own (rating, tenor):
 * mandates are loaded, filtered for eligibility, and `bestQuote` from `@facture/shared`
 * picks the tightest one with unallocated balance left.
 *
 * Eligibility is checked BEFORE matching, against the security's own `ControlList` and
 * `Kyc` facets, not at settlement. That ordering is the whole argument against doing this
 * on an AMM: an ineligible counterparty is never matched in the first place, and the
 * refusal is a first-class output rather than a reverted transaction.
 *
 * `bestQuote` is positional — `bestQuote(invoice, mandates, debtor, options)` — and takes
 * the whole `Debtor`, not just a grade: it needs the debtor's id to read per-debtor
 * concentration off each mandate, and their name to write the concentration refusal in
 * words. That is why `loadDebtor` is a seam here alongside `loadInvoice`.
 */

import type {
  Currency,
  Debtor,
  Invoice,
  Mandate,
  MinorUnits,
  Quote,
  Rating,
  RefusalReceipt,
} from '@facture/shared';
import { bestQuote, matchCount, tenorDays } from '@facture/shared';
import { notFound, notImplemented } from '../errors.js';
import type { RatingAssessment } from './rating.js';
import { ratingService } from './rating.js';

export interface LiveQuote {
  invoiceId: string;
  /** null when nothing on the curve will take this paper today. */
  quote: Quote | null;
  /**
   * Why each non-matching mandate declined, in words. Every refusal also writes a receipt
   * to HCS so the rejected party can check it without trusting the venue.
   */
  refusals: readonly RefusalReceipt[];
  rating: Rating;
  tenorDays: number;
  /** How many mandates were screened, matches and refusals together. */
  candidatesConsidered: number;
  /** How many would actually take this paper — the "three mandates would take this" line. */
  matchesAvailable: number;
  pricedAt: string;
}

/**
 * Data access seam. Kept as an interface so the orchestration below is real, reachable
 * code that can be exercised against fakes before Postgres and the mirror node exist.
 */
export interface QuoteEngineDeps {
  loadInvoice(invoiceId: string): Promise<Invoice | null>;
  /** The customer whose credit is being priced. `bestQuote` takes the whole record. */
  loadDebtor(debtorId: string): Promise<Debtor | null>;
  /**
   * Mandates that could plausibly take this paper: funded, unallocated balance above the
   * face value, rating floor at or below the debtor's grade, max tenor at or above this
   * invoice's. Deliberately over-fetches — the fine-grained refusal reasons come from
   * `bestQuote`, which needs to see the near-misses in order to explain them.
   */
  loadCandidateMandates(criteria: MandateCriteria): Promise<Mandate[]>;
  ratingFor(debtorId: string): Promise<RatingAssessment>;
}

export interface MandateCriteria {
  debtorId: string;
  rating: Rating;
  tenorDays: number;
  faceValue: MinorUnits;
  currency: Currency;
}

export const defaultQuoteEngineDeps: QuoteEngineDeps = {
  async loadInvoice(invoiceId) {
    // TODO: SELECT the invoice row, projected onto the shared `Invoice` shape.
    throw notImplemented(`invoice lookup for ${invoiceId}`);
  },

  async loadDebtor(debtorId) {
    // TODO: SELECT the debtor row, projected onto the shared `Debtor` shape. The counters
    // come off the same accumulator `services/rating.ts` reads.
    throw notImplemented(`debtor lookup for ${debtorId}`);
  },

  async loadCandidateMandates(criteria) {
    // TODO: SELECT open, funded mandates for this bucket. Order by annualised yield
    // ascending — the tightest bid that can actually take the whole face value wins.
    // Do NOT filter out the near-misses; a refusal the funder can read is a product
    // output, and it needs the mandate row to explain itself.
    throw notImplemented(`candidate mandate lookup for debtor ${criteria.debtorId}`);
  },

  ratingFor: (debtorId) => ratingService.ratingFor(debtorId),
};

export function createQuoteEngine(deps: QuoteEngineDeps = defaultQuoteEngineDeps) {
  return {
    /** Prices one invoice against the live curve. */
    async priceOne(invoiceId: string, asOf: Date = new Date()): Promise<LiveQuote> {
      const invoice = await deps.loadInvoice(invoiceId);
      if (!invoice) throw notFound(`Invoice ${invoiceId}`);

      const [debtorRow, assessment] = await Promise.all([
        deps.loadDebtor(invoice.debtorId),
        deps.ratingFor(invoice.debtorId),
      ]);
      if (!debtorRow) throw notFound(`Customer ${invoice.debtorId}`);

      /*
       * The assessment wins over the stored grade. `debtors.rating` is a projection of the
       * accumulator that `assess()` reads, and a projection can lag its source — pricing
       * against the stale copy would quote a grade the ladder no longer supports.
       */
      const debtor: Debtor = { ...debtorRow, rating: assessment.rating };
      const tenor = tenorDays(invoice.dueAt, asOf);

      const mandates = await deps.loadCandidateMandates({
        debtorId: invoice.debtorId,
        rating: assessment.rating,
        tenorDays: tenor,
        faceValue: invoice.faceValue,
        currency: invoice.currency,
      });

      const result = bestQuote(invoice, mandates, debtor, { asOf });

      return {
        invoiceId,
        quote: result.quote,
        refusals: result.refusals,
        rating: debtor.rating,
        // `bestQuote` measures the tenor off the same clock; take its answer, not ours.
        tenorDays: result.tenorDays,
        candidatesConsidered: mandates.length,
        matchesAvailable: matchCount(result),
        pricedAt: result.asOf,
      };
    },

    /**
     * Prices a seller's whole book in one pass. The book screen shows a price beside
     * every invoice, so this must not be N round-trips of `priceOne`.
     */
    async priceBook(_invoiceIds: readonly string[], _asOf?: Date): Promise<LiveQuote[]> {
      // TODO: one batched rating read + one batched mandate read, then fan out over
      // `bestQuote` in memory. Same result as mapping `priceOne`, without the N+1.
      throw notImplemented('batched book pricing');
    },
  };
}

export type QuoteEngine = ReturnType<typeof createQuoteEngine>;

export const quoteEngine: QuoteEngine = createQuoteEngine();
