/**
 * Primitives shared by every other module in this package.
 *
 * Two conventions matter here and are enforced everywhere downstream:
 *
 * 1. **Money is `bigint` minor units.** Never a `number`, never a decimal string in
 *    arithmetic. `40_000.00 USD` is `4_000_000n`. Floats do not appear anywhere on the
 *    money path — see `src/pricing/curve.ts`.
 * 2. **Instants are ISO-8601 strings**, not `Date`. They cross an HTTP boundary and a
 *    database in this system, and a string survives both round trips unchanged.
 */

/** ISO-8601 instant, e.g. `2026-11-30T00:00:00.000Z`. Always store UTC. */
export type IsoDateTime = string;

/** Anything that can be read as an instant by the pricing helpers. */
export type InstantLike = Date | IsoDateTime | number;

/**
 * An amount in the minor units of its currency (cents for USD/EUR).
 *
 * Alias rather than a brand: a brand would force every parallel package to import a
 * constructor before it could build a fixture, and the friction is not worth the safety
 * at this size.
 */
export type MinorUnits = bigint;

/** Basis points. 1250 bps = 12.50% annualised. */
export type Bps = number;

/** Denomination of an invoice's face value. Not the settlement asset — see `src/chains`. */
export const CURRENCIES = ['USD', 'EUR'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Minor-unit exponent per currency. USD/EUR are both 2 (cents). */
export const CURRENCY_DECIMALS: Record<Currency, number> = {
  USD: 2,
  EUR: 2,
};

/** Symbol used when rendering a currency in a human-readable refusal or quote. */
export const CURRENCY_SYMBOL: Record<Currency, string> = {
  USD: '$',
  EUR: '€',
};

/**
 * Explicit success/failure, returned instead of throwing wherever the failure is a
 * *domain outcome* rather than a bug. A refused transition and an unpriceable invoice are
 * outcomes; a negative face value is a bug and throws.
 */
export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Narrowing helpers, so call sites read as predicates rather than property access. */
export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;

/** Unwrap or throw. For tests and for call sites that have already checked a precondition. */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  // JSON.stringify throws on bigint, and errors in this package carry bigint amounts.
  const detail = JSON.stringify(r.error, (_k, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
  throw new Error(`unwrap() on an error Result: ${detail}`);
}
