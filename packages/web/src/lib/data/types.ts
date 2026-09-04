/**
 * The seam.
 *
 * `src/lib/fixtures.ts` used to be the only thing behind every screen, and its own header
 * promised that "when the backend lands, this module keeps its exported shape and its
 * bodies become fetches". This is that shape, lifted into a type so there can be two
 * implementations of it rather than one file that quietly changed meaning: the demo book,
 * and the real service over HTTP.
 *
 * A screen asks a `Market` for what it needs and never learns which one it got. The accessors
 * below are deliberately the same names the fixture module exported — `getInvoice`,
 * `debtorFor`, `metaOf`, `positionsOf` — because keeping them identical is what makes
 * swapping back a one-line change in `src/lib/api/config.ts`.
 */

import type {
  Debtor,
  Invoice,
  Mandate,
  Quote,
  Rating,
  RefusalReceipt,
  RegulationKey,
  Trade,
} from '@/lib/domain';
import type { MinorUnits } from '@/lib/domain';
import type { MandateMeta } from '@/lib/fixtures';
import type { Position } from '@/lib/pricing';
import type { DataSource } from '@/lib/api/config';

export type { MandateMeta };

export interface Party {
  id: string;
  name: string;
}

/** One mandate that would take an invoice, and at what. */
export interface MandateMatch {
  mandate: Mandate;
  quote: Quote;
}

/**
 * A live price, and everything that went into not having one.
 *
 * Deliberately not `BestQuoteResult` from the shared package. The venue's own quote route
 * returns how many mandates matched but not *which* — the seller does not choose a
 * counterparty — so `matches` is populated when the price was computed locally against
 * mandates the screen can see, and empty when the venue priced it. `matchCount` is
 * authoritative either way, and it is the number under the price on screen.
 */
export interface InvoicePricing {
  invoiceId: string;
  rating: Rating;
  tenorDays: number;
  /** `null` when nothing on the curve will take this paper today. */
  quote: Quote | null;
  /** The venue's handle on the price the seller was shown. Required to sell. */
  quoteId: string | null;
  matches: readonly MandateMatch[];
  matchCount: number;
  candidatesConsidered: number;
  /** A refusal is a first-class output. Never an omission and never an error. */
  refusals: readonly RefusalReceipt[];
  pricedAt: string;
}

export const NO_PRICING = (invoiceId: string, asOf: string): InvoicePricing => ({
  invoiceId,
  rating: 'UNRATED',
  tenorDays: 0,
  quote: null,
  quoteId: null,
  matches: [],
  matchCount: 0,
  candidatesConsidered: 0,
  refusals: [],
  pricedAt: asOf,
});

/**
 * Everything the market screens read.
 *
 * `notices` carries anything this particular source genuinely cannot show — the API
 * exposes only the buyer's own mandates, for instance, so the "also bidding" panel has
 * nothing to draw. It is a sentence on screen rather than an empty panel, on the same
 * principle as a refusal: an absence with no reason is the thing this product exists to
 * stop happening.
 */
export interface Market {
  readonly source: DataSource;
  readonly asOf: Date;
  readonly asOfIso: string;
  readonly seller: Party;
  readonly viewer: Party;
  readonly invoices: readonly Invoice[];
  readonly debtors: readonly Debtor[];
  readonly mandates: readonly Mandate[];
  readonly positions: readonly Position[];
  readonly trades: readonly Trade[];
  readonly notices: readonly string[];
  /**
   * Whether a customer's settled/unpaid/confirmed counters are published by this source.
   * The venue's debtor projection carries the earned grade but not the counts behind it, and
   * printing "0 settled" beside an `A` would be a claim, not a gap.
   */
  readonly debtorHistoryKnown: boolean;

  getInvoice(id: string): Invoice | undefined;
  getDebtor(id: string): Debtor | undefined;
  getDebtorByName(name: string): Debtor | undefined;
  debtorFor(invoice: Invoice): Debtor;
  debtorNameOf(invoice: Invoice): string;
  ratingOf(invoice: Invoice): Rating;

  /** The price beside the row. Always present for every invoice in `invoices`. */
  pricingFor(invoiceId: string): InvoicePricing;

  getMandate(id: string): Mandate | undefined;
  metaOf(mandateId: string): MandateMeta;
  ownedMandates(): Mandate[];
  otherMandates(): Mandate[];
  positionsOf(mandateId: string): Position[];
  ownedPositions(): Position[];

  getTrade(id: string): Trade | undefined;
  tradeForInvoice(invoiceId: string): Trade | undefined;
  /** The confirmation link for an invoice, where this source can produce one. */
  tokenForInvoice(invoiceId: string): string | undefined;
}

export interface MarketInput {
  source: DataSource;
  asOf: Date;
  seller: Party;
  viewer: Party;
  invoices: readonly Invoice[];
  debtors: readonly Debtor[];
  mandates: readonly Mandate[];
  positions: readonly Position[];
  trades: readonly Trade[];
  pricing: ReadonlyMap<string, InvoicePricing>;
  meta: ReadonlyMap<string, MandateMeta>;
  tokens: ReadonlyMap<string, string>;
  notices: readonly string[];
  debtorHistoryKnown: boolean;
}

const UNKNOWN_DEBTOR: Debtor = {
  id: 'unknown',
  name: 'Unknown customer',
  rating: 'UNRATED',
  onTimeCount: 0,
  defaultCount: 0,
  confirmedCount: 0,
};

/**
 * A mandate nobody named.
 *
 * The venue has no notion of what a funder calls their own bid, so in API mode the label is
 * the policy restated: "A or better, 60 days". That is not a placeholder — it is the only
 * honest name for a standing bid the screen has never been told the name of.
 */
export function derivedMeta(mandate: Mandate): MandateMeta {
  const floor =
    mandate.minRating === 'UNRATED' ? 'No default on record' : `${mandate.minRating} or better`;
  return {
    name: `${floor}, ${mandate.maxTenorDays} days`,
    ownerName: 'This desk',
    operator: 'desk',
  };
}

export function buildMarket(input: MarketInput): Market {
  const invoicesById = new Map(input.invoices.map((invoice) => [invoice.id, invoice]));
  const debtorsById = new Map(input.debtors.map((debtor) => [debtor.id, debtor]));
  const mandatesById = new Map(input.mandates.map((mandate) => [mandate.id, mandate]));
  const tradesById = new Map(input.trades.map((trade) => [trade.id, trade]));

  const debtorFor = (invoice: Invoice): Debtor =>
    debtorsById.get(invoice.debtorId) ?? UNKNOWN_DEBTOR;

  return {
    source: input.source,
    asOf: input.asOf,
    asOfIso: input.asOf.toISOString(),
    seller: input.seller,
    viewer: input.viewer,
    invoices: input.invoices,
    debtors: input.debtors,
    mandates: input.mandates,
    positions: input.positions,
    trades: input.trades,
    notices: input.notices,
    debtorHistoryKnown: input.debtorHistoryKnown,

    getInvoice: (id) => invoicesById.get(id),
    getDebtor: (id) => debtorsById.get(id),
    getDebtorByName: (name) => {
      const wanted = name.trim().toLowerCase();
      return input.debtors.find((debtor) => debtor.name.toLowerCase() === wanted);
    },
    debtorFor,
    debtorNameOf: (invoice) => debtorFor(invoice).name,
    ratingOf: (invoice) => debtorFor(invoice).rating,

    pricingFor: (invoiceId) =>
      input.pricing.get(invoiceId) ?? NO_PRICING(invoiceId, input.asOf.toISOString()),

    getMandate: (id) => mandatesById.get(id),
    metaOf: (mandateId) => {
      const named = input.meta.get(mandateId);
      if (named) return named;
      const mandate = mandatesById.get(mandateId);
      return mandate
        ? derivedMeta(mandate)
        : { name: 'A mandate', ownerName: 'A funder', operator: 'desk' };
    },
    ownedMandates: () => input.mandates.filter((m) => m.buyerId === input.viewer.id),
    otherMandates: () => input.mandates.filter((m) => m.buyerId !== input.viewer.id),
    positionsOf: (mandateId) => input.positions.filter((p) => p.mandateId === mandateId),
    ownedPositions: () => {
      const mine = new Set(
        input.mandates.filter((m) => m.buyerId === input.viewer.id).map((m) => m.id),
      );
      return input.positions.filter((p) => mine.has(p.mandateId));
    },

    getTrade: (id) => tradesById.get(id),
    tradeForInvoice: (invoiceId) => input.trades.find((t) => t.invoiceId === invoiceId),
    tokenForInvoice: (invoiceId) => input.tokens.get(invoiceId),
  };
}

/* -------------------------------------------------------------------------- */
/* The debtor confirmation record                                              */
/* -------------------------------------------------------------------------- */

/**
 * What the customer is shown, and nothing else.
 *
 * There is no price on this type, no rate, no mandate and no buyer, and that is the point:
 * the debtor acknowledging their own accounts payable must never be shown the market
 * quoting their debt. Making it unavailable to the component is a stronger guarantee than
 * remembering not to render it.
 */
export interface ConfirmationRecord {
  sellerName: string;
  debtorName: string | null;
  invoiceNumber: string | null;
  /**
   * The amount, already rendered by whoever owns the figure — the venue formats it with the
   * invoice's own currency, and a page asking someone to agree to a number has no business
   * re-deriving it.
   */
  amount: string;
  /** Minor units, when the source keeps them. `null` over the wire. */
  faceValue: MinorUnits | null;
  dueAt: string;
  decision: 'confirmed' | 'disputed' | null;
}

/* -------------------------------------------------------------------------- */
/* The proof record                                                            */
/* -------------------------------------------------------------------------- */

export interface ProofCheck {
  name: string;
  detail: string;
  passed: boolean;
}

/**
 * The audit view, one click from any trade — the only screen in this product where the
 * machinery is named.
 *
 * Every field is nullable that the venue is allowed to leave null, and the screen omits a
 * row rather than printing a dash where an identifier should be. That follows the
 * backend's own rule in `routes/proof.ts`: do not synthesise a link whose underlying
 * identifier is null, because an explorer URL that 404s is worse than an absent one.
 */
export interface ProofRecord {
  tradeId: string;
  trade: Trade;
  instrument: {
    tokenId: string | null;
    isin: string | null;
    uniquenessHash: string | null;
    regulation: RegulationKey | null;
    maturity: string | null;
    issuedAt: string | null;
    issuedTxId: string | null;
    explorerUrl: string | null;
  };
  confirmation: {
    decision: 'confirmed' | 'disputed' | null;
    decidedAt: string | null;
  };
  compliance: {
    allowed: boolean | null;
    checkedAt: string | null;
    checks: readonly ProofCheck[];
    hcsTopicId: string | null;
    hcsSequenceNumber: string | null;
    hcsExplorerUrl: string | null;
  };
  assetLeg: {
    from: string | null;
    to: string | null;
    quantity: string | null;
    transactionId: string | null;
    holdId: string | null;
    consensusAt: string | null;
    explorerUrl: string | null;
  };
  cashLeg: {
    from: string | null;
    to: string | null;
    asset: string | null;
    scheme: string | null;
    network: string | null;
    transaction: string | null;
    explorerUrl: string | null;
  };
  /** What binds the two legs. Absent when the venue does not publish it. */
  settlement: {
    protocol: string;
    facilitator: string | null;
    challengeNonce: string | null;
    boundAt: string | null;
    note: string;
  } | null;
  refusals: readonly {
    mandateId: string;
    mandateName: string | null;
    reasonCode: string;
    reasonText: string;
    hcsExplorerUrl: string | null;
  }[];
  invoiceNumber: string | null;
  debtorName: string | null;
  sellerName: string | null;
  buyerName: string | null;
  settledAt: string | null;
}
