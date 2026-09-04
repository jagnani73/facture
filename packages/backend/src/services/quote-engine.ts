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
import { toDebtor, toInvoice, toMandate } from '../db/projections.js';
import { getStore } from '../db/store.js';
import { notFound } from '../errors.js';
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

  /*
   * Batched forms, used by `priceBook`. Optional so a fake only has to implement the
   * single-record seams above; when one is absent the batch falls back to fanning out over
   * its singular counterpart, which is correct but is the N+1 this exists to avoid.
   */
  loadInvoices?(invoiceIds: readonly string[]): Promise<Invoice[]>;
  loadDebtors?(debtorIds: readonly string[]): Promise<Debtor[]>;
  ratingsFor?(debtorIds: readonly string[]): Promise<Map<string, RatingAssessment>>;
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
    const row = await getStore().getInvoice(invoiceId);
    return row === null ? null : toInvoice(row);
  },

  async loadDebtor(debtorId) {
    const row = await getStore().getDebtor(debtorId);
    return row === null ? null : toDebtor(row);
  },

  /**
   * Every active mandate bidding in this invoice's currency, with per-debtor exposure
   * attached.
   *
   * Deliberately unfiltered beyond currency and status. The rating floor, the tenor
   * ceiling and both capacity checks are `bestQuote`'s to apply, because each one it
   * applies produces a refusal the funder can read — filtering a near-miss out in SQL
   * would turn "this mandate takes A or better and your customer is C" into silence.
   */
  async loadCandidateMandates(criteria) {
    const store = getStore();
    const rows = await store.listQuotableMandates(criteria.currency);
    const exposure = await store.debtorExposure(rows.map((row) => row.id));
    return rows.map((row) => toMandate(row, exposure.get(row.id) ?? {}));
  },

  ratingFor: (debtorId) => ratingService.ratingFor(debtorId),

  async loadInvoices(invoiceIds) {
    const rows = await getStore().getInvoices(invoiceIds);
    return rows.map(toInvoice);
  },

  async loadDebtors(debtorIds) {
    const rows = await getStore().getDebtors(debtorIds);
    return rows.map((row) => toDebtor(row));
  },

  ratingsFor: (debtorIds) => ratingService.ratingsFor(debtorIds),
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
    async priceBook(invoiceIds: readonly string[], asOf: Date = new Date()): Promise<LiveQuote[]> {
      if (invoiceIds.length === 0) return [];

      const invoices = deps.loadInvoices
        ? await deps.loadInvoices(invoiceIds)
        : (await Promise.all(invoiceIds.map((id) => deps.loadInvoice(id)))).filter(
            (invoice): invoice is Invoice => invoice !== null,
          );

      // An id with no row is skipped rather than throwing. The book screen asks for the
      // page it just listed; one invoice deleted between the two reads should cost that
      // row, not the whole screen.
      const byId = new Map(invoices.map((invoice) => [invoice.id, invoice]));
      const ordered = invoiceIds
        .map((id) => byId.get(id))
        .filter((invoice): invoice is Invoice => invoice !== undefined);
      if (ordered.length === 0) return [];

      const debtorIds = [...new Set(ordered.map((invoice) => invoice.debtorId))];

      const [debtorRows, assessments] = await Promise.all([
        deps.loadDebtors
          ? deps.loadDebtors(debtorIds)
          : Promise.all(debtorIds.map((id) => deps.loadDebtor(id))).then((rows) =>
              rows.filter((row): row is Debtor => row !== null),
            ),
        deps.ratingsFor
          ? deps.ratingsFor(debtorIds)
          : Promise.all(debtorIds.map((id) => deps.ratingFor(id))).then(
              (list) => new Map(list.map((a) => [a.debtorId, a])),
            ),
      ]);
      const debtorsById = new Map(debtorRows.map((row) => [row.id, row]));

      /*
       * One mandate read per distinct currency, not per invoice. `MandateCriteria` beyond
       * `currency` is advisory — the data seam deliberately over-fetches so that the
       * near-misses survive to be explained — so a representative invoice's criteria is
       * enough to describe the read.
       */
      const currencies = [...new Set(ordered.map((invoice) => invoice.currency))];
      const curves = new Map<Currency, Mandate[]>();
      await Promise.all(
        currencies.map(async (currency) => {
          const sample = ordered.find((invoice) => invoice.currency === currency);
          if (!sample) return;
          const assessment = assessments.get(sample.debtorId);
          curves.set(
            currency,
            await deps.loadCandidateMandates({
              debtorId: sample.debtorId,
              rating: assessment?.rating ?? 'UNRATED',
              tenorDays: tenorDays(sample.dueAt, asOf),
              faceValue: sample.faceValue,
              currency,
            }),
          );
        }),
      );

      const priced: LiveQuote[] = [];
      for (const invoice of ordered) {
        const debtorRow = debtorsById.get(invoice.debtorId);
        const assessment = assessments.get(invoice.debtorId);
        if (!debtorRow || !assessment) continue;

        const debtor: Debtor = { ...debtorRow, rating: assessment.rating };
        const mandates = curves.get(invoice.currency) ?? [];
        const result = bestQuote(invoice, mandates, debtor, { asOf });

        priced.push({
          invoiceId: invoice.id,
          quote: result.quote,
          refusals: result.refusals,
          rating: debtor.rating,
          tenorDays: result.tenorDays,
          candidatesConsidered: mandates.length,
          matchesAvailable: matchCount(result),
          pricedAt: result.asOf,
        });
      }
      return priced;
    },
  };
}

export type QuoteEngine = ReturnType<typeof createQuoteEngine>;

export const quoteEngine: QuoteEngine = createQuoteEngine();

/**
 * Give a live quote an id the seller can come back with.
 *
 * A quote is derived — a pure function of the invoice, the curve and the clock — so it is
 * not stored as a source of truth. But a trade has to be able to prove *which* price the
 * seller was shown and reject a stale acceptance, and that needs a handle.
 *
 * An identical unexpired quote is reused rather than re-written. The quote route is safe
 * to poll, so writing a row per poll would be a write per refresh of the product's main
 * screen; a price that has actually moved supersedes the old row and gets a new one, which
 * is also what makes `quote_expired` mean something at execution time.
 */
export async function materialiseQuote(
  invoiceId: string,
  rating: Rating,
  quote: Quote,
  asOf: Date = new Date(),
): Promise<string> {
  const store = getStore();
  const existing = await store.findLiveQuote(invoiceId, asOf);

  const unchanged =
    existing !== null &&
    existing.mandateId === quote.mandateId &&
    existing.annualisedYieldBps === quote.annualisedYieldBps &&
    existing.tenorDays === quote.tenorDays &&
    existing.proceedsMinor === quote.proceeds;
  if (unchanged && existing) return existing.id;

  if (existing) await store.setQuoteStatus(existing.id, 'superseded');

  const row = await store.insertQuote({
    invoiceId,
    mandateId: quote.mandateId,
    ratingAtQuote: rating,
    tenorDays: quote.tenorDays,
    annualisedYieldBps: quote.annualisedYieldBps,
    faceValue: quote.faceValue,
    discountMinor: quote.discount,
    proceedsMinor: quote.proceeds,
    status: 'live',
    pricedAt: new Date(quote.asOf),
    expiresAt: new Date(quote.expiresAt),
  });
  return row.id;
}
