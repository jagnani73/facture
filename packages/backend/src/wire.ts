/**
 * The money serialisation boundary. One module, so there is exactly one answer.
 *
 * Two rules, and they are not in tension:
 *
 * 1. **Internally, money is `bigint` minor units.** That is `@facture/shared`'s
 *    `MinorUnits`, it is what `pricing/curve.ts` does arithmetic on, and it is what the
 *    `bigint` Drizzle columns read back. No `number` ever touches an amount.
 * 2. **On the wire, money is a decimal string.** `JSON.parse` produces a `number`, and a
 *    `number` is an IEEE-754 double: exact only below 2^53. A €100m invoice in cents is
 *    10_000_000_000n, which is fine — but a mandate's committed capital, a per-debtor
 *    exposure ladder, or any HBAR-denominated leg at 8 decimals passes 2^53 without
 *    anything looking wrong, and the corruption is silent. `JSON.stringify` also simply
 *    throws on a `bigint` rather than guessing, which is how the crash this module fixes
 *    was reachable at all.
 *
 * So: parse inbound money with {@link moneyString}, and render outbound money with
 * {@link money}. Neither direction is allowed to be open-coded elsewhere in this package
 * — a second regex is a second definition of what an amount is.
 *
 * **Field naming.** A wire field carries the *domain* name and nothing else:
 * `faceValue`, not `faceMinor`. The domain type in `@facture/shared` is
 * `Invoice.faceValue`, the DB column is `face_value`, and the JSON key is `faceValue`.
 * The scale is not encoded in the name because it is not a property of the field — it is
 * the invariant this module enforces at both ends. A name that has to be translated
 * between layers is a translation layer, and someone eventually forgets to apply it.
 */

import type { Quote, RefusalReceipt } from '@facture/shared';
import { z } from 'zod';

/**
 * Inbound money: a positive integer in minor units, as a decimal string.
 *
 * Deliberately strict. No sign, no decimal point, no leading zero, no exponent — a client
 * sending `"40000.00"` or `4e7` has misunderstood the unit, and accepting it quietly
 * would be a hundredfold error in whichever direction the guess went. Rejecting is the
 * only safe read.
 */
export const moneyString = z
  .string()
  .regex(/^[1-9]\d*$/, 'must be a positive integer in minor units, as a decimal string')
  .transform((v) => BigInt(v));

/** Same, but permits zero — for balances and accumulators rather than prices. */
export const moneyStringOrZero = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, 'must be a non-negative integer in minor units, as a decimal string')
  .transform((v) => BigInt(v));

/** Outbound money: the only sanctioned way an amount leaves this service. */
export const money = (amount: bigint): string => amount.toString(10);

/** `Quote` with every `MinorUnits` field rendered as a decimal string. */
export interface WireQuote extends Omit<Quote, 'faceValue' | 'discount' | 'proceeds'> {
  faceValue: string;
  discount: string;
  proceeds: string;
}

export const wireQuote = (q: Quote): WireQuote => ({
  ...q,
  faceValue: money(q.faceValue),
  discount: money(q.discount),
  proceeds: money(q.proceeds),
});

/**
 * A refusal receipt, safe to `JSON.stringify`.
 *
 * `detail` is a discriminated union and two of its variants (`EXPOSURE_EXHAUSTED`,
 * `DEBTOR_CONCENTRATION`) carry `MinorUnits`. They are converted structurally rather than
 * by naming each field, so a new refusal variant that carries an amount cannot slip
 * through and reintroduce the throw.
 */
export interface WireRefusalReceipt extends Omit<RefusalReceipt, 'detail'> {
  detail: Record<string, unknown>;
}

export const wireRefusalReceipt = (r: RefusalReceipt): WireRefusalReceipt => ({
  ...r,
  detail: Object.fromEntries(
    Object.entries(r.detail).map(([k, v]) => [k, typeof v === 'bigint' ? money(v) : v]),
  ),
});
