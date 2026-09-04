import type { Bps, Currency, IsoDateTime, MinorUnits } from './common.js';
import type { Rating } from './rating.js';

/**
 * Lifecycle of a standing bid. Legal transitions live in `src/state/mandate-machine.ts`.
 *
 * - `draft`      written, not funded — cannot match, because an unfunded quote is not firm
 * - `funding`    escrow of `totalCommitted` initiated, not yet confirmed
 * - `active`     funded and quoting
 * - `exhausted`  `allocated` has reached `totalCommitted`; nothing left to match against
 * - `withdrawn`  buyer closed it and took the unallocated balance back — terminal
 */
export const MANDATE_STATUSES = ['draft', 'funding', 'active', 'exhausted', 'withdrawn'] as const;

export type MandateStatus = (typeof MANDATE_STATUSES)[number];

export const isMandateStatus = (v: unknown): v is MandateStatus =>
  typeof v === 'string' && (MANDATE_STATUSES as readonly string[]).includes(v);

/**
 * A standing bid over a risk bucket: *any paper rated at least X, no longer than Y days, at
 * Z bps, up to N of exposure and M per debtor.*
 *
 * `totalCommitted` is escrowed at funding. That is what makes the quote firm, and bounding
 * matches by `unallocated()` is what resolves two invoices arriving against one mandate.
 */
export interface Mandate {
  readonly id: string;
  readonly buyerId: string;
  /**
   * Rating floor. A debtor must rank at or above this. `UNRATED` is the widest floor a
   * buyer can write: it accepts cold starts but still refuses `D`, because a default
   * ranks below no history at all. See `RATING_RANK`.
   */
  readonly minRating: Rating;
  /** Tenor ceiling in days, inclusive. An invoice at exactly `maxTenorDays` still matches. */
  readonly maxTenorDays: number;
  /** The bid. Annualised, simple discount, actual/365. */
  readonly annualisedYieldBps: Bps;
  /** Escrowed capital, minor units. */
  readonly totalCommitted: MinorUnits;
  /** Committed capital already spoken for by matched trades. Never exceeds `totalCommitted`. */
  readonly allocated: MinorUnits;
  /** Concentration cap: most this mandate will hold against any single debtor. */
  readonly maxPerDebtor: MinorUnits;
  readonly status: MandateStatus;

  /**
   * Currency the mandate bids in. Optional so a mandate can be built without it, but when
   * present it is enforced: a EUR invoice never matches a USD mandate.
   */
  readonly currency?: Currency | undefined;

  /**
   * Per-debtor allocated exposure, keyed by `Debtor.id`. Absent or missing key means zero.
   * Carried on the mandate rather than passed alongside it so that `bestQuote` stays a pure
   * function of its three documented arguments.
   */
  readonly debtorExposure?: Readonly<Record<string, MinorUnits>> | undefined;

  readonly createdAt?: IsoDateTime | undefined;
  readonly fundedAt?: IsoDateTime | undefined;
}

/**
 * Capital still available to match against. Clamped at zero: an over-allocated mandate is a
 * bug elsewhere, and returning a negative here would let it silently price a trade.
 */
export function unallocated(m: Mandate): MinorUnits {
  const remaining = m.totalCommitted - m.allocated;
  return remaining > 0n ? remaining : 0n;
}

/** Capital already committed against one debtor. Zero when unknown. */
export const debtorExposureOf = (m: Mandate, debtorId: string): MinorUnits =>
  m.debtorExposure?.[debtorId] ?? 0n;

/** Headroom left under the concentration cap for one debtor, clamped at zero. */
export function remainingForDebtor(m: Mandate, debtorId: string): MinorUnits {
  const remaining = m.maxPerDebtor - debtorExposureOf(m, debtorId);
  return remaining > 0n ? remaining : 0n;
}

/**
 * Most this mandate could pay for one invoice against one debtor right now: the lesser of
 * the unallocated balance and the per-debtor headroom.
 */
export function availableFor(m: Mandate, debtorId: string): MinorUnits {
  const pool = unallocated(m);
  const perDebtor = remainingForDebtor(m, debtorId);
  return pool < perDebtor ? pool : perDebtor;
}

/** Only an `active` mandate quotes. `funding` is not yet firm; `exhausted` has nothing left. */
export const isQuotingMandate = (m: Mandate): boolean => m.status === 'active';
