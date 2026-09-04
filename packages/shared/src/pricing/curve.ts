import type { Bps, InstantLike, MinorUnits } from '../types/common.js';
import { err, ok, type Result } from '../types/common.js';
import { ceilDiv, floorDiv } from '../types/money.js';

/**
 * Simple-discount pricing for zero-coupon paper.
 *
 * ```
 *   discount = faceValue × (annualisedYieldBps / 10 000) × (tenorDays / 365)
 *   proceeds = faceValue − discount
 * ```
 *
 * ## Conventions, and why each one
 *
 * **Simple discount, not compound.** Money-market paper under a year is quoted this way, and
 * an invoice is money-market paper. Compounding a 60-day discount would be both unfamiliar
 * to the desks this is aimed at and wrong by roughly a basis point on a 12.5% quote.
 *
 * **Actual/365 fixed.** One denominator, no leap-year branch, no 30/360 fiction about month
 * lengths. Tenor is real UTC calendar days, which is also what the debtor experiences.
 *
 * **Integers only.** Every amount is `bigint` minor units and the entire calculation is one
 * exact rational: multiply first, divide once. There is no intermediate float, so there is
 * no accumulated representation error and the result is reproducible on any machine.
 *
 * ```
 *   discount = ceil( faceValue × yieldBps × tenorDays / (10 000 × 365) )
 * ```
 *
 * **The single division rounds UP, in the buyer's favour.** A sub-cent remainder has to go
 * somewhere, and it goes to the buyer, so the realised yield is never *below* the yield the
 * mandate published. That direction is chosen deliberately: a mandate is a standing
 * commitment to buy at a stated yield, and a venue that occasionally delivered a hundredth
 * of a basis point less than advertised would be making the bid soft. The seller can see
 * the exact proceeds before confirming, so nothing is hidden by the choice — at most one
 * minor unit moves, and it moves predictably.
 */

/** Basis points in one whole. */
export const BPS_DENOMINATOR = 10_000n;

/** Day count denominator. Actual/365 fixed. */
export const DAY_COUNT_BASIS = 365n;

const MS_PER_DAY = 86_400_000;

export interface PriceBreakdown {
  readonly faceValue: MinorUnits;
  readonly annualisedYieldBps: Bps;
  readonly tenorDays: number;
  readonly discount: MinorUnits;
  readonly proceeds: MinorUnits;
}

/**
 * UTC calendar days from `asOf` to `dueAt`.
 *
 * Both instants are collapsed to their UTC date before subtracting, so the answer does not
 * depend on the time of day a quote is requested — an invoice due tomorrow is 1 day away at
 * 09:00 and still 1 day away at 23:00. Working in UTC also removes any DST discontinuity.
 *
 * Past-due clamps to 0 rather than going negative. A negative tenor would produce a negative
 * discount, i.e. proceeds above face, which is never a price this venue should offer. An
 * overdue invoice is worth at most its face value, and it is the state machine's job — not
 * the pricer's — to notice it should be in default.
 */
export function tenorDays(dueAt: InstantLike, asOf: InstantLike = new Date()): number {
  const due = utcMidnight(dueAt);
  const from = utcMidnight(asOf);
  const days = Math.round((due - from) / MS_PER_DAY);
  return days > 0 ? days : 0;
}

/** Same day count without the clamp, for diagnostics — negative means overdue. */
export function tenorDaysSigned(dueAt: InstantLike, asOf: InstantLike = new Date()): number {
  return Math.round((utcMidnight(dueAt) - utcMidnight(asOf)) / MS_PER_DAY);
}

function utcMidnight(value: InstantLike): number {
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (Number.isNaN(ms)) {
    throw new RangeError(`tenorDays: not a valid instant: ${String(value)}`);
  }
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Price one invoice at one yield.
 *
 * Throws `RangeError` on a negative face value, a negative yield or a negative tenor. Those
 * are precondition violations — bugs in the caller — and not domain outcomes; a domain
 * refusal comes back as a `RefusalReceipt` from `bestQuote`, never as an exception.
 *
 * A zero tenor is legal and prices at face: an invoice due today is worth exactly what it
 * pays today.
 */
export function priceInvoice(
  faceValue: MinorUnits,
  annualisedYieldBps: Bps,
  days: number,
): PriceBreakdown {
  if (faceValue < 0n) {
    throw new RangeError(`priceInvoice: faceValue must be non-negative, got ${faceValue}`);
  }
  if (!Number.isFinite(annualisedYieldBps) || annualisedYieldBps < 0) {
    throw new RangeError(
      `priceInvoice: annualisedYieldBps must be a non-negative finite number, got ${annualisedYieldBps}`,
    );
  }
  if (!Number.isInteger(annualisedYieldBps)) {
    throw new RangeError(
      `priceInvoice: annualisedYieldBps must be an integer number of basis points, got ${annualisedYieldBps}`,
    );
  }
  if (!Number.isInteger(days) || days < 0) {
    throw new RangeError(`priceInvoice: tenorDays must be a non-negative integer, got ${days}`);
  }

  // One exact rational. Numerator first so nothing is lost before the single division.
  const numerator = faceValue * BigInt(annualisedYieldBps) * BigInt(days);
  const denominator = BPS_DENOMINATOR * DAY_COUNT_BASIS;
  const rawDiscount = ceilDiv(numerator, denominator);

  /*
   * A yield high enough to discount past zero would imply paying nothing for the paper and
   * is outside anything the book should quote, but clamping is cheaper than a caller
   * discovering negative proceeds. Reachable only above ~6000% annualised on a 60-day
   * tenor, so it is a guard rather than a case.
   */
  const discount = rawDiscount > faceValue ? faceValue : rawDiscount;

  return {
    faceValue,
    annualisedYieldBps,
    tenorDays: days,
    discount,
    proceeds: faceValue - discount,
  };
}

export type ImpliedYieldError =
  | { readonly code: 'ZERO_TENOR'; readonly reason: string }
  | { readonly code: 'NON_POSITIVE_FACE'; readonly faceValue: MinorUnits; readonly reason: string }
  | {
      readonly code: 'PROCEEDS_OUT_OF_RANGE';
      readonly faceValue: MinorUnits;
      readonly proceeds: MinorUnits;
      readonly reason: string;
    };

/**
 * The inverse: what annualised yield does a given price imply?
 *
 * ```
 *   yieldBps = floor( (faceValue − proceeds) × 10 000 × 365 / (faceValue × tenorDays) )
 * ```
 *
 * **This division rounds DOWN**, which is the opposite direction to `priceInvoice`, and
 * deliberately so. Together the two directions make the round trip exact: pricing at `y`
 * rounds the discount up by a fraction of a minor unit, and reading that price back rounds
 * the implied yield down past the same fraction, so
 * `impliedYieldBps(face, priceInvoice(face, y, t).proceeds, t) === y`. Rounding both the
 * same way would drift a basis point on every re-quote of seasoned paper. Rounding down
 * also means the number shown to a buyer never overstates what they earned.
 *
 * The round trip is exact whenever `faceValue × tenorDays >= 10 000 × 365`, which is the
 * point at which one minor unit of discount is worth less than one basis point. Below it —
 * a hundred-dollar invoice with a day to run — the quantum of a single cent genuinely is
 * worth more than a basis point, and the implied yield reports that rather than hiding it.
 *
 * Returns a `Result` rather than throwing: a zero tenor is a legitimate runtime condition
 * (an invoice due today), and it has no defined yield rather than a bad one.
 */
export function impliedYieldBps(
  faceValue: MinorUnits,
  proceeds: MinorUnits,
  days: number,
): Result<Bps, ImpliedYieldError> {
  if (faceValue <= 0n) {
    return err({
      code: 'NON_POSITIVE_FACE',
      faceValue,
      reason: 'A face value of zero or less has no yield.',
    });
  }
  if (proceeds < 0n || proceeds > faceValue) {
    return err({
      code: 'PROCEEDS_OUT_OF_RANGE',
      faceValue,
      proceeds,
      reason: 'Proceeds must be between zero and the face value.',
    });
  }
  if (!Number.isInteger(days) || days <= 0) {
    return err({
      code: 'ZERO_TENOR',
      reason: 'An invoice with no time left to run has no annualised yield.',
    });
  }

  const discount = faceValue - proceeds;
  const numerator = discount * BPS_DENOMINATOR * DAY_COUNT_BASIS;
  const denominator = faceValue * BigInt(days);
  return ok(Number(floorDiv(numerator, denominator)));
}

/**
 * Price directly from a due date, which is what a live book actually needs: the number on
 * screen moves as the curve moves *and* as the due date approaches.
 */
export function priceInvoiceAt(
  faceValue: MinorUnits,
  annualisedYieldBps: Bps,
  dueAt: InstantLike,
  asOf: InstantLike = new Date(),
): PriceBreakdown {
  return priceInvoice(faceValue, annualisedYieldBps, tenorDays(dueAt, asOf));
}
