import type { Bps, Currency, IsoDateTime, MinorUnits } from './common.js';

/**
 * A firm price for one invoice from one mandate.
 *
 * A quote is derived, never stored as a source of truth: it is a pure function of the
 * invoice, the mandate and the clock. It carries `expiresAt` because tenor shortens every
 * day, so yesterday's proceeds are simply the wrong number rather than a stale one.
 */
export interface Quote {
  readonly invoiceId: string;
  readonly mandateId: string;
  /** The mandate's bid, unchanged. Copied here so the quote is self-contained. */
  readonly annualisedYieldBps: Bps;
  /** UTC calendar days from `asOf` to the due date. */
  readonly tenorDays: number;
  readonly faceValue: MinorUnits;
  /** Rounded up, in the buyer's favour — see `src/pricing/curve.ts`. */
  readonly discount: MinorUnits;
  /** `faceValue - discount`. What the seller receives, in full, on the day. */
  readonly proceeds: MinorUnits;
  readonly currency: Currency;
  readonly asOf: IsoDateTime;
  readonly expiresAt: IsoDateTime;
}

/** True when `now` is at or past the quote's expiry. */
export const isQuoteExpired = (q: Quote, now: Date = new Date()): boolean =>
  now.getTime() >= Date.parse(q.expiresAt);

/**
 * The discount as a fraction of face, in basis points — the number a seller reads as
 * "2.05% off face". Distinct from `annualisedYieldBps`, which is annualised; over a 60-day
 * tenor the two differ by roughly a factor of six. Presentation only.
 */
export function discountBps(q: Quote): number {
  if (q.faceValue <= 0n) return 0;
  return Number((q.discount * 10_000n) / q.faceValue);
}
