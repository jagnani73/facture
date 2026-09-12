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
import { accountIdToEvmAddress } from './ats.js';
import { getComplianceGate } from './compliance.js';
import { toDebtor, toInvoice, toMandate } from '../db/projections.js';
import { getStore } from '../db/store.js';
import { notFound } from '../errors.js';
import { rootLogger } from '../logger.js';
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
  /**
   * Whether this invoice's instrument answered when it was read: `true` yes, `false` asked
   * and got nothing, `null` never asked.
   *
   * **`priceBook` always reports `null`, and that is the point.** The book screen prices a
   * whole seller's book in one pass with no chain reads, and asking per row is the N+1 this
   * engine exists to avoid. Only `priceOne` can answer it, because only `priceOne` already
   * pays for the read it takes.
   *
   * What reads this is the invoice screen, deciding whether to offer a link to the
   * instrument on HashScan. A seeded row points at a security that was never deployed, and
   * linking one sends a reader to a page that does not exist — which is a worse claim than
   * making none.
   */
  instrumentReadable: boolean | null;
  /**
   * Bids dropped because the instrument itself will not let that buyer hold it.
   *
   * Not counted as refusals. A refusal is a bid declining paper on its own terms — rating,
   * tenor, exposure — and the funder is owed a receipt for it. This is the instrument
   * declining the *buyer*, which is not a statement about the invoice at all, and the
   * vocabulary in `@facture/shared` has no code for it because the contracts do not either.
   *
   * Zero on the book screen, always: see `priceBook`.
   */
  excludedByCompliance: number;
  pricedAt: string;
}

/**
 * Data access seam. Kept as an interface so the orchestration below is real, reachable
 * code that can be exercised against fakes before a database and the mirror node exist.
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

  /**
   * Can this mandate's buyer legally hold this instrument?
   *
   * A seam rather than a direct call to the compliance gate, because this is the one place
   * the pricing path touches a chain and a fake has to be able to answer it without one.
   * Absent means "do not ask" — a deployment with no gate prices exactly as it did before.
   */
  canHold?(input: {
    invoice: Invoice;
    mandate: Mandate;
  }): Promise<{
    allowed: boolean;
    reason: string | null;
    /**
     * Whether the instrument itself could be read: `true` read fine, `false` asked and got
     * nothing back, `null` never asked.
     *
     * Three states because two would collapse "there is no instrument yet" into "this
     * instrument is unreachable", and a screen deciding whether to offer an explorer link
     * has to tell those apart. Reported separately from `allowed` because an unreadable
     * instrument still answers `allowed: true` here by design — pricing must not move on an
     * indeterminate answer, which is the rule the comment in the default implementation
     * protects.
     */
    readable: boolean | null;
  }>;
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

  /**
   * Reads the instrument's own `ControlList` and `Kyc` facets, through the same gate that
   * decides at arm time — so a price and the trade it leads to cannot disagree about who is
   * allowed to hold the paper.
   *
   * Answers `allowed` when there is nothing to ask: an invoice with no instrument yet has no
   * control list, and a buyer with no Hedera account on file cannot be looked up. Neither is
   * evidence of ineligibility, and refusing on "unknown" would drop every bid on an invoice
   * that is merely still being issued.
   */
  async canHold({ invoice, mandate }) {
    const instrument = invoice.instrumentAddress;
    if (instrument === undefined) return { allowed: true, reason: null, readable: null };

    const buyer = await getStore().getBuyer(mandate.buyerId);
    if (!buyer?.hederaAccountId) return { allowed: true, reason: null, readable: null };

    const decision = await getComplianceGate().check({
      instrumentAddress: instrument,
      buyerEvmAddress: accountIdToEvmAddress(buyer.hederaAccountId),
      buyerName: buyer.name,
    });

    /*
     * An indeterminate answer does not move a price.
     *
     * The gate refuses when it cannot read the instrument, which is right for settlement —
     * money must not move on an unknown. It is wrong here: a relay outage, or a demo book
     * whose fixtures point at securities that were never deployed, would drop the three
     * tightest bids on every invoice and quietly widen the whole curve. Arming still refuses,
     * so nothing settles against an instrument nobody can read; it just does not reprice.
     */
    /*
     * `instrumentRead` rather than `determinate`. They answer different questions and come
     * apart in both directions: a gate that could not be reached is indeterminate without
     * that being a statement about the instrument, and the permissive gate is determinate
     * having read nothing at all. Deriving readability from `determinate` reported a real
     * deployed bond as unreadable on a relay blip, and would have reported a contract
     * nobody looked at as readable.
     */
    if (!decision.determinate) {
      return { allowed: true, reason: null, readable: decision.instrumentRead };
    }
    return {
      allowed: decision.decision === 'allowed',
      reason: decision.reason,
      readable: decision.instrumentRead,
    };
  },
};

/**
 * How many times pricing will drop the winning bid and look again.
 *
 * Bounded because each pass costs an on-chain read. Three is generous: it takes a book where
 * the three tightest bids are all barred from one instrument before a seller sees a price
 * that is merely the best of what remains rather than the best that could hold it.
 */
const MAX_COMPLIANCE_FALLTHROUGH = 3;

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

      /*
       * Price, then check that the winner can actually hold this instrument, and drop it and
       * look again if it cannot.
       *
       * The gate used to run only when a trade was armed, so the book could show a price from
       * a bid whose buyer that security bars — a 403 with a good sentence, arriving after the
       * seller had already decided to sell. Observed live: MF-2051 quoted 925 bps from a buyer
       * that instrument does not permit.
       *
       * Only the WINNER is checked, and only up to {@link MAX_COMPLIANCE_FALLTHROUGH} times.
       * Screening every candidate first would be an on-chain read per bid, which is the cost
       * this whole design avoids; screening the one bid about to be quoted is normally exactly
       * one read, and it is the only bid whose eligibility the answer depends on.
       *
       * If the cap is exhausted the last price stands and the arm-time gate is still the
       * backstop — a seller can then still meet a 403, which is the old behaviour rather than a
       * new failure. Quoting `null` instead would hide a bid that a fourth pass might have
       * found, and this path is meant to improve the common case without inventing a worse one.
       */
      let pool = mandates;
      let excludedByCompliance = 0;
      /*
       * Stays `null` when no pass ever reached the gate — no quote to screen, no gate
       * configured, no instrument yet. "Nobody asked" is not "the answer was no", and the
       * screen that reads this renders the two differently.
       */
      let instrumentReadable: boolean | null = null;
      let result = bestQuote(invoice, pool, debtor, { asOf });

      for (let pass = 0; pass < MAX_COMPLIANCE_FALLTHROUGH; pass += 1) {
        const winner = result.mandate;
        if (result.quote === null || winner === null || deps.canHold === undefined) break;

        const verdict = await deps.canHold({ invoice, mandate: winner });
        /*
         * Sticky on `true`, because this loop can read the same instrument up to three
         * times and the question is whether it EVER answered. Last-write-wins let a
         * transient failure on pass two erase a definitive read from pass one, reporting a
         * contract that had just answered as unreadable.
         */
        if (verdict.readable === true) instrumentReadable = true;
        else if (verdict.readable === false && instrumentReadable === null) {
          instrumentReadable = false;
        }
        if (verdict.allowed) break;

        rootLogger.info('bid cannot hold this instrument, looking again', {
          invoiceId,
          mandateId: winner.id,
          reason: verdict.reason,
        });
        excludedByCompliance += 1;
        pool = pool.filter((candidate) => candidate.id !== winner.id);
        result = bestQuote(invoice, pool, debtor, { asOf });
      }

      return {
        invoiceId,
        quote: result.quote,
        refusals: result.refusals,
        rating: debtor.rating,
        // `bestQuote` measures the tenor off the same clock; take its answer, not ours.
        tenorDays: result.tenorDays,
        candidatesConsidered: mandates.length,
        matchesAvailable: matchCount(result),
        instrumentReadable,
        excludedByCompliance,
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
          /*
           * Always zero here, deliberately. This method prices a whole book in one pass, so
           * checking the winning bid per row would be an on-chain read per row — the same N+1
           * it exists to avoid, moved from the database to the mirror node. A book price is
           * indicative; `priceOne` is the one a seller acts on, and that one is checked.
           */
          excludedByCompliance: 0,
          /* Null for the same reason, and never `false`: nothing here asked the instrument. */
          instrumentReadable: null,
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
