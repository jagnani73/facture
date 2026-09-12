/**
 * The presentation layer over `@facture/shared`'s market logic.
 *
 * Eligibility, ranking, refusals and the curve maths all live in the shared package —
 * `bestQuote` is the same function the backend will match on, so the screen and the
 * venue cannot disagree about who would take an invoice or at what price. What lives
 * here is only what a screen needs and the domain does not: the portfolio views a buyer
 * reads, and the copy that turns a rating into a sentence.
 */

import type { Invoice, Mandate, MinorUnits, Rating } from './domain';
import { RATINGS, meetsRatingFloor, tenorDays } from './domain';

/* -------------------------------------------------------------------------- */
/* Rating copy                                                                 */
/* -------------------------------------------------------------------------- */

/** How an earned rating is explained in one line, in the seller's own terms. */
export const RATING_BLURB: Record<Rating, string> = {
  A: 'A long record of settling on time here, nothing missed.',
  B: 'A solid record of settling on time.',
  C: 'A shorter record, or the odd late payment.',
  D: 'Has failed to pay an invoice on this market. The mark is permanent.',
  UNRATED: 'No settled invoices yet. Prices at the wide end of the curve.',
};

/**
 * These grades are earned here and mean nothing anywhere else, which is why the scale is
 * A–D rather than borrowed agency notation. `D` ranks below `UNRATED` on purpose: a
 * default is information, an absence of history is not.
 */

/* -------------------------------------------------------------------------- */
/* The curve                                                                   */
/* -------------------------------------------------------------------------- */

export interface CurvePoint {
  mandateId: string;
  tenorDays: number;
  annualisedYieldBps: number;
  minRating: Rating;
  label: string;
}

/**
 * The visible curve is nothing more than the standing bids, plotted at the longest tenor
 * each will hold and the rate each pays. There is no model behind it, which is the point.
 */
export function curveFrom(
  mandates: readonly Mandate[],
  labelOf: (mandate: Mandate) => string,
): CurvePoint[] {
  return mandates
    .filter((m) => m.status === 'active')
    .map((m) => ({
      mandateId: m.id,
      tenorDays: m.maxTenorDays,
      annualisedYieldBps: m.annualisedYieldBps,
      minRating: m.minRating,
      label: labelOf(m),
    }))
    .sort((a, b) => a.tenorDays - b.tenorDays);
}

/* -------------------------------------------------------------------------- */
/* The book, in figures                                                        */
/* -------------------------------------------------------------------------- */

export interface BookSummary {
  /** Receivables outstanding: listed or confirmed, not yet sold, matured or defaulted. */
  live: number;
  /** Distinct customers behind them. The reason the paper is not one asset. */
  debtors: number;
  faceValue: MinorUnits;
  /** What the standing bids would pay for the ones they will take, today. */
  proceeds: MinorUnits;
  /** How many of `live` nothing on the curve will take. */
  unpriced: number;
}

/**
 * The book in five numbers.
 *
 * Deliberately not a chart. These are headline figures rather than a distribution, and the
 * shape that answers "what is outstanding and what is it worth" is a row of figures — a plot
 * of two dozen unrelated receivables is a cloud that has to be decoded before it says
 * anything, which is the opposite of the claim being made beside it.
 *
 * `proceeds` sums only the invoices that actually carry a price. Adding face value for the
 * ones nothing will take would report capital the book cannot raise.
 */
export function summariseBook(
  invoices: readonly Invoice[],
  quoteFor: (invoiceId: string) => { proceeds: MinorUnits } | null,
  debtorIdOf: (invoice: Invoice) => string,
): BookSummary {
  const live = invoices.filter(
    (invoice) =>
      invoice.status !== 'matured' && invoice.status !== 'defaulted' && invoice.status !== 'sold',
  );

  let faceValue = 0n;
  let proceeds = 0n;
  let unpriced = 0;
  const debtors = new Set<string>();

  for (const invoice of live) {
    faceValue += invoice.faceValue;
    debtors.add(debtorIdOf(invoice));
    const quote = quoteFor(invoice.id);
    if (quote) proceeds += quote.proceeds;
    else unpriced += 1;
  }

  return { live: live.length, debtors: debtors.size, faceValue, proceeds, unpriced };
}

export interface BidSummary {
  standing: number;
  /** Tightest bid on the curve, in bps. `null` when nothing is standing. */
  tightestBps: number | null;
  longestTenorDays: number;
  committed: MinorUnits;
}

/**
 * The demand side in three numbers, mirroring {@link summariseBook} on the supply side.
 *
 * The pair is what makes the argument: a book of unique receivables on one side, a handful of
 * standing bids on the other, and every invoice priced off the second without anyone quoting
 * the first.
 */
export function summariseBids(mandates: readonly Mandate[]): BidSummary {
  const standing = mandates.filter((m) => m.status === 'active');

  return {
    standing: standing.length,
    tightestBps: standing.reduce<number | null>(
      (best, m) => (best === null || m.annualisedYieldBps < best ? m.annualisedYieldBps : best),
      null,
    ),
    longestTenorDays: standing.reduce((max, m) => Math.max(max, m.maxTenorDays), 0),
    committed: standing.reduce((total, m) => total + m.totalCommitted, 0n),
  };
}

export interface LadderRung {
  rating: Rating;
  /** Tightest standing bid that would take this rating at this tenor. `null` when none will. */
  bestRateBps: number | null;
  /** How many standing bids would take it. */
  takers: number;
}

/**
 * What the curve pays for identical paper at each rating.
 *
 * Read off the standing bids on two dimensions only — the rating floor and the tenor
 * ceiling — which is what makes it a reading of the curve rather than a quote. A real quote
 * also clears capital headroom, concentration and currency against one specific invoice,
 * so a rung here says "the bid exists and would take this rating", never "you would get
 * this price". The screen has to say so too.
 *
 * `D` is included precisely because nothing takes it: a mandate written at the widest floor
 * accepts a cold start and still refuses a customer who has actually failed to pay, so the
 * ladder ending in a rung with no bar is the permanence of a default made visible.
 */
export function ratingLadderFrom(
  mandates: readonly Mandate[],
  atTenorDays: number,
): LadderRung[] {
  const standing = mandates.filter(
    (m) => m.status === 'active' && m.maxTenorDays >= atTenorDays,
  );

  return RATINGS.map((rating) => {
    const takers = standing.filter((m) => meetsRatingFloor(rating, m.minRating));
    const best = takers.reduce<number | null>(
      (tightest, m) =>
        tightest === null || m.annualisedYieldBps < tightest ? m.annualisedYieldBps : tightest,
      null,
    );
    return { rating, bestRateBps: best, takers: takers.length };
  });
}

/* -------------------------------------------------------------------------- */
/* Portfolio views                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A holding. Not a shared domain type — it is the buyer-side view over settled trades,
 * which is a reporting concern rather than a settlement one.
 */
export interface Position {
  id: string;
  mandateId: string;
  invoiceId: string;
  invoiceNumber: string;
  debtorId: string;
  debtorName: string;
  rating: Rating;
  faceValue: MinorUnits;
  /** What the mandate actually paid. This, not face, is the capital at risk. */
  outlay: MinorUnits;
  annualisedYieldBps: number;
  boughtAt: string;
  dueAt: string;
  state: 'open' | 'settled' | 'defaulted';
}

/** Outlay-weighted average yield, in basis points. */
export function weightedAverageRateBps(positions: readonly Position[]): number {
  let outlay = 0n;
  let weighted = 0n;
  for (const p of positions) {
    outlay += p.outlay;
    weighted += p.outlay * BigInt(p.annualisedYieldBps);
  }
  if (outlay === 0n) return 0;
  return Number(weighted / outlay);
}

export function sumFace(positions: readonly Position[]): MinorUnits {
  return positions.reduce((total, p) => total + p.faceValue, 0n);
}

export function sumOutlay(positions: readonly Position[]): MinorUnits {
  return positions.reduce((total, p) => total + p.outlay, 0n);
}

export interface LadderBucket {
  label: string;
  /** Inclusive upper bound in days; `Infinity` on the last bucket. */
  maxDays: number;
  faceValue: MinorUnits;
  count: number;
  averageRateBps: number;
}

const LADDER_BOUNDS: ReadonlyArray<{ label: string; maxDays: number }> = [
  { label: '0–15d', maxDays: 15 },
  { label: '16–30d', maxDays: 30 },
  { label: '31–45d', maxDays: 45 },
  { label: '46–60d', maxDays: 60 },
  { label: '61–90d', maxDays: 90 },
  { label: '90d+', maxDays: Number.POSITIVE_INFINITY },
];

/**
 * When the money comes back. A ladder rather than a total, because a buyer's question is
 * never "how much is out" on its own — it is "how much, and when".
 */
export function maturityLadder(positions: readonly Position[], asOf: Date): LadderBucket[] {
  const buckets: LadderBucket[] = LADDER_BOUNDS.map((b) => ({
    label: b.label,
    maxDays: b.maxDays,
    faceValue: 0n,
    count: 0,
    averageRateBps: 0,
  }));
  const weighted = new Array<bigint>(buckets.length).fill(0n);

  for (const position of positions) {
    if (position.state !== 'open') continue;
    const days = tenorDays(position.dueAt, asOf);
    const found = LADDER_BOUNDS.findIndex((b) => days <= b.maxDays);
    const slot = found === -1 ? buckets.length - 1 : found;
    const bucket = buckets[slot];
    if (!bucket) continue;
    bucket.faceValue += position.faceValue;
    bucket.count += 1;
    weighted[slot] =
      (weighted[slot] ?? 0n) + position.faceValue * BigInt(position.annualisedYieldBps);
  }

  for (let i = 0; i < buckets.length; i += 1) {
    const bucket = buckets[i];
    if (!bucket || bucket.faceValue === 0n) continue;
    bucket.averageRateBps = Number((weighted[i] ?? 0n) / bucket.faceValue);
  }

  return buckets;
}
