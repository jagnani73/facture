/**
 * Debtor credit ratings.
 *
 * These grades are **earned from settled payment behaviour on Facture itself**. No agency
 * issues them, no bureau feeds them, and nothing outside this platform recognises them.
 *
 * That is why the scale is `A`/`B`/`C`/`D` and not `AAA`/`AA`/`BBB`. Borrowing S&P notation
 * would claim an authority the score does not have — eight invoices paid on time is not
 * AAA, and a reader who has priced corporate paper would reasonably assume it meant
 * something comparable. The notation stays plainly platform-scoped so that nobody has to
 * be told what it is not.
 *
 * A debtor starts `UNRATED` and tightens as invoices settle on time; a default marks them
 * `D` permanently. The bucketing that produces these values lives in the backend's
 * `services/rating.ts`.
 */

/**
 * Ordered best credit first. The array order *is* the ranking, which is why `D` sits at the
 * end rather than between `C` and `UNRATED` — see `RATING_RANK`.
 */
export const RATINGS = ['A', 'B', 'C', 'UNRATED', 'D'] as const;

export type Rating = (typeof RATINGS)[number];

/**
 * Higher number = better credit.
 *
 * **`D` ranks below `UNRATED`, and that is a real product decision rather than an ordering
 * accident.** A default is information; an absence of history is not. A customer who has
 * failed to pay is strictly worse than one nobody has traded with yet, so they must not be
 * reachable by any floor that is willing to accept a cold start.
 *
 * The two floors a buyer actually writes therefore read as:
 *
 * - floor `C` — excludes unrated *and* defaulted customers; proven payers only.
 * - floor `UNRATED` — accepts everything except defaulted customers. That is the natural
 *   reading of "no rating floor": a buyer willing to price the cold start is not thereby
 *   volunteering to buy paper on a customer already known to default.
 */
export const RATING_RANK: Record<Rating, number> = {
  A: 4,
  B: 3,
  C: 2,
  UNRATED: 1,
  D: 0,
};

export const isRating = (value: unknown): value is Rating =>
  typeof value === 'string' && (RATINGS as readonly string[]).includes(value);

/** True when `rating` is at least as good as `floor`. */
export const meetsRatingFloor = (rating: Rating, floor: Rating): boolean =>
  RATING_RANK[rating] >= RATING_RANK[floor];

/** Negative when `a` is worse than `b`; sorts best-credit-first when used directly. */
export const compareRating = (a: Rating, b: Rating): number => RATING_RANK[b] - RATING_RANK[a];
