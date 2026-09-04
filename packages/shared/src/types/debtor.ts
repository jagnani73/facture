import type { Rating } from './rating.js';

/**
 * The customer who owes the money. The asset being priced is *their* credit, which is why
 * a mandate's rating floor is read against the debtor and never against the seller.
 *
 * The three counters are the whole rating input. They are facts the platform observed, not
 * a score anyone assigned, and they are deliberately public: a seller's debtor book is an
 * asset the seller accumulates.
 */
export interface Debtor {
  readonly id: string;
  readonly name: string;
  /** Current earned rating. Starts `UNRATED`; a default marks it `D` permanently. */
  readonly rating: Rating;
  /** Invoices this debtor paid in full on or before the due date. */
  readonly onTimeCount: number;
  /** Invoices this debtor failed to pay. Permanent — a default never ages off. */
  readonly defaultCount: number;
  /** Invoices this debtor acknowledged when asked. Confirmation is what makes paper listable. */
  readonly confirmedCount: number;
  readonly createdAt?: string | undefined;
}

/** Total settled invoices with a known outcome. The denominator for any rate. */
export const settledCount = (d: Debtor): number => d.onTimeCount + d.defaultCount;

/**
 * On-time rate in the range 0..1, or `null` when nothing has settled yet.
 * `null` rather than 0 or 1 — an unproven debtor is unknown, not perfect and not bad.
 */
export function onTimeRate(d: Debtor): number | null {
  const total = settledCount(d);
  return total === 0 ? null : d.onTimeCount / total;
}

/** A debtor with no settled history at all. Prices at the wide end by construction. */
export const isColdStart = (d: Debtor): boolean => settledCount(d) === 0;
