/**
 * The presentation layer over `@facture/shared`'s market logic.
 *
 * Eligibility, ranking, refusals and the curve maths all live in the shared package —
 * `bestQuote` is the same function the backend will match on, so the screen and the
 * venue cannot disagree about who would take an invoice or at what price. What lives
 * here is only what a screen needs and the domain does not: the portfolio views a buyer
 * reads, and the copy that turns a rating into a sentence.
 */

import type { Mandate, MinorUnits, Rating } from './domain';
import { tenorDays } from './domain';

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
