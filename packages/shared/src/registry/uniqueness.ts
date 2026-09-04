import { keccak256, stringToBytes, type Hex } from 'viem';
import type { MinorUnits } from '../types/common.js';

/**
 * The uniqueness hash: one receivable, one instrument, ever.
 *
 * Selling the same invoice to three financiers is the specific fraud factoring has always
 * had, and it is roughly what broke Greensill. A registry does not make an invoice real, but
 * it stops one being sold twice — which is the cheap half of the fraud problem and worth
 * doing on day one.
 *
 * ## Canonicalisation
 *
 * A mismatch here is a double-pledge hole: if `"INV-001"` and `"inv 001"` hash differently,
 * the same receivable mints twice and the registry has done nothing. So the inputs are
 * normalised **aggressively**, and the direction of that choice is deliberate.
 *
 * - **Unicode NFKC** first, on both string fields. Full-width `ＩＮＶ－００１` and ASCII
 *   `INV-001` are the same invoice number typed on a different keyboard.
 * - **All Unicode whitespace removed** from the invoice number, not merely trimmed and
 *   collapsed. An attacker re-listing a paid-out invoice would reach for exactly this — one
 *   extra space — and no honest debtor issues two different invoices whose numbers differ
 *   only by whitespace.
 * - **Case-folded** to lower case. `INV-001` and `inv-001` are the same document.
 * - **Separators are kept.** `INV-001` and `INV001` stay distinct, because stripping
 *   punctuation as well would start colliding genuinely different numbering schemes, and a
 *   false collision refuses an honest invoice with no way for the seller to fix it.
 * - **Debtor id** is trimmed and lower-cased. Ids here are opaque (UUIDs, EVM addresses);
 *   lower-casing is safe for both and makes a checksummed address match its lower-case form.
 * - **Face value** is written as a plain decimal integer of minor units — no separators, no
 *   currency symbol, no scale. `4000000`, never `40,000.00`.
 *
 * ## Encoding
 *
 * Fields are **length-prefixed**, not merely delimited:
 *
 * ```
 *   facture/uniqueness/v1|3:d-9|7:inv-001|7:4000000
 * ```
 *
 * Concatenating `debtor` and `number` with a separator alone is ambiguous the moment a
 * field can contain the separator — `("ab", "c")` and `("a", "bc")` would collide under a
 * naive join, and a collision in this particular hash is a refusal to tokenise a real
 * invoice. Length prefixes make the encoding injective regardless of field content.
 *
 * The domain string is versioned. Changing any rule above changes the hash of every existing
 * invoice, so it requires a new version and a migration, never an edit in place.
 *
 * ## What is deliberately *not* in the hash
 *
 * Currency and due date. The registry key is `(debtor, invoice number, amount)` as specified
 * in the README. Excluding currency makes the hash slightly more likely to collide, which is
 * the safe direction for a duplicate guard: the failure is "this looks like an invoice you
 * already listed", which a human can resolve, rather than a silent second tokenisation.
 */

/** Bump when any canonicalisation rule changes. Old hashes are not recomputable. */
export const UNIQUENESS_VERSION = 1;

export const UNIQUENESS_DOMAIN = `facture/uniqueness/v${UNIQUENESS_VERSION}` as const;

const FIELD_SEPARATOR = '|';
const LENGTH_SEPARATOR = ':';

/** Every Unicode whitespace character, including the ones that survive a naive trim. */
const ALL_WHITESPACE = /\s+/gu;

export interface UniquenessInput {
  readonly debtorId: string;
  readonly invoiceNumber: string;
  readonly faceValue: MinorUnits;
}

/** NFKC, trim, lower case. Applied to the debtor id. */
export function canonicaliseDebtorId(debtorId: string): string {
  return debtorId.normalize('NFKC').trim().toLowerCase();
}

/** NFKC, strip all whitespace, lower case. Applied to the invoice number. */
export function canonicaliseInvoiceNumber(invoiceNumber: string): string {
  return invoiceNumber.normalize('NFKC').replace(ALL_WHITESPACE, '').toLowerCase();
}

/**
 * The exact string that gets hashed. Exported so it can be asserted in a test and shown in a
 * debug view — a hash nobody can reproduce by hand is a hash nobody can audit.
 */
export function canonicalUniquenessInput(
  debtorId: string,
  invoiceNumber: string,
  faceValue: MinorUnits,
): string {
  if (faceValue < 0n) {
    throw new RangeError(`uniquenessHash: faceValue must be non-negative, got ${faceValue}`);
  }

  const debtor = canonicaliseDebtorId(debtorId);
  const number = canonicaliseInvoiceNumber(invoiceNumber);
  const amount = faceValue.toString(10);

  if (debtor.length === 0) {
    throw new RangeError('uniquenessHash: debtorId is empty after canonicalisation.');
  }
  if (number.length === 0) {
    throw new RangeError('uniquenessHash: invoiceNumber is empty after canonicalisation.');
  }

  return [UNIQUENESS_DOMAIN, field(debtor), field(number), field(amount)].join(FIELD_SEPARATOR);
}

/**
 * Length-prefix one field. The length is in **UTF-8 bytes**, not UTF-16 code units, so it
 * matches the byte count that actually reaches keccak256 and stays stable if this encoding
 * is ever reimplemented in Solidity or Go.
 */
function field(value: string): string {
  const bytes = stringToBytes(value).length;
  return `${bytes}${LENGTH_SEPARATOR}${value}`;
}

/**
 * keccak256 over the canonical encoding. This is the registry key: the same receivable
 * always produces the same 32 bytes, and it is also what seeds the invoice's ISIN so the
 * two identifiers can never disagree about which invoice they describe.
 */
export function uniquenessHash(
  debtorId: string,
  invoiceNumber: string,
  faceValue: MinorUnits,
): Hex {
  return keccak256(stringToBytes(canonicalUniquenessInput(debtorId, invoiceNumber, faceValue)));
}

/** Object form, for call sites that already hold the triple. */
export const uniquenessHashOf = (input: UniquenessInput): Hex =>
  uniquenessHash(input.debtorId, input.invoiceNumber, input.faceValue);

/**
 * Do two hashes describe the same receivable? Case-insensitive, because hex from a chain
 * call and hex from `keccak256` here can differ in case and mean the same 32 bytes.
 */
export const sameReceivable = (a: Hex | string, b: Hex | string): boolean =>
  a.toLowerCase() === b.toLowerCase();
