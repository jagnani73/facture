import type { Hex } from 'viem';
import { err, ok, type Result } from '../types/common.js';

/**
 * ISIN generation and validation.
 *
 * ATS rejects any `deployBond` whose ISIN is not syntactically and checksum valid
 * (`onlyValidISIN`), so every invoice needs one before it can be issued. These are
 * **synthetic identifiers**: no National Numbering Agency allocated them, and nothing here
 * should be presented to a user as a registered security identifier. They exist to satisfy
 * a contract modifier and to give each instrument a stable, human-quotable handle.
 *
 * ## Structure
 *
 * ```
 *   US 037833100 5
 *   ^^ ^^^^^^^^^ ^
 *   |  |         └ check digit, mod-10
 *   |  └ NSIN, 9 alphanumeric characters
 *   └ ISO 3166-1 alpha-2 country code
 * ```
 *
 * ## Check digit
 *
 * Each of the first 11 characters is expanded to digits — `0`–`9` stay as they are, `A`–`Z`
 * become 10–35 written as two digits — and the mod-10 Luhn algorithm runs over the
 * resulting digit string, doubling every second digit counting from the right. The check
 * digit is whatever makes the total a multiple of ten.
 *
 * The expansion-before-Luhn ordering is the part implementations get wrong: doubling has to
 * happen on the expanded digits, not on the letter values, so `U` (30) contributes a `3` and
 * a `0` that fall in different doubling positions. The test suite checks this against
 * nineteen real ISINs rather than against a restatement of the same algorithm.
 */

export const ISIN_LENGTH = 12;
export const NSIN_LENGTH = 9;

/** Characters legal in an NSIN, and the alphabet the deterministic generator encodes into. */
const BASE36_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const ISIN_PATTERN = /^[A-Z]{2}[0-9A-Z]{9}[0-9]$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const NSIN_PATTERN = /^[0-9A-Z]{1,9}$/;

export type IsinErrorCode =
  | 'INVALID_LENGTH'
  | 'INVALID_FORMAT'
  | 'INVALID_COUNTRY_CODE'
  | 'INVALID_NSIN'
  | 'CHECKSUM_MISMATCH';

export interface IsinError {
  readonly code: IsinErrorCode;
  readonly value: string;
  readonly reason: string;
  /** Present on `CHECKSUM_MISMATCH`: the digit the value should have ended with. */
  readonly expectedCheckDigit?: number | undefined;
}

/**
 * Expand an ISIN body to the digit string the Luhn step runs over.
 * `US0378331` -> `3028` + `0378331`.
 */
function expandToDigits(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code >= 48 && code <= 57) {
      out += char; // '0'-'9'
    } else if (code >= 65 && code <= 90) {
      out += String(code - 55); // 'A' -> 10 ... 'Z' -> 35, always two digits
    } else {
      throw new RangeError(`ISIN body contains a character outside [0-9A-Z]: ${char}`);
    }
  }
  return out;
}

/**
 * Mod-10 check digit for the 11-character body of an ISIN.
 *
 * Exported because the tests exercise it directly against real ISINs, which is a stronger
 * check than round-tripping our own generator.
 */
export function isinCheckDigit(body11: string): number {
  const digits = expandToDigits(body11);
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    const positionFromRight = digits.length - i;
    let value = digits.charCodeAt(i) - 48;
    // The check digit will sit at position 0 from the right, so the rightmost body digit is
    // an odd position and is doubled.
    if (positionFromRight % 2 === 1) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Build a checksum-valid ISIN.
 *
 * An NSIN shorter than nine characters is left-padded with `0`, which is what numbering
 * agencies do and keeps short synthetic identifiers readable.
 */
export function generateIsin(countryCode: string, nsin: string): Result<string, IsinError> {
  const country = countryCode.trim().toUpperCase();
  if (!COUNTRY_PATTERN.test(country)) {
    return err({
      code: 'INVALID_COUNTRY_CODE',
      value: countryCode,
      reason: 'Country code must be two letters (ISO 3166-1 alpha-2).',
    });
  }

  const rawNsin = nsin.trim().toUpperCase();
  if (!NSIN_PATTERN.test(rawNsin)) {
    return err({
      code: 'INVALID_NSIN',
      value: nsin,
      reason: `NSIN must be 1-${NSIN_LENGTH} characters from [0-9A-Z].`,
    });
  }

  const body = country + rawNsin.padStart(NSIN_LENGTH, '0');
  return ok(body + String(isinCheckDigit(body)));
}

/** Validate an ISIN, returning it normalised to upper case on success. */
export function validateIsin(value: string): Result<string, IsinError> {
  const candidate = value.trim().toUpperCase();

  if (candidate.length !== ISIN_LENGTH) {
    return err({
      code: 'INVALID_LENGTH',
      value,
      reason: `An ISIN is ${ISIN_LENGTH} characters; this one is ${candidate.length}.`,
    });
  }
  if (!ISIN_PATTERN.test(candidate)) {
    return err({
      code: 'INVALID_FORMAT',
      value,
      reason: 'An ISIN is two letters, nine alphanumerics, then one digit.',
    });
  }

  const expected = isinCheckDigit(candidate.slice(0, ISIN_LENGTH - 1));
  const actual = Number(candidate.slice(ISIN_LENGTH - 1));
  if (expected !== actual) {
    return err({
      code: 'CHECKSUM_MISMATCH',
      value,
      reason: `Check digit is ${actual}; it should be ${expected}.`,
      expectedCheckDigit: expected,
    });
  }

  return ok(candidate);
}

/** Boolean form, for guards and filters. */
export const isValidIsin = (value: string): boolean => validateIsin(value).ok;

/**
 * Default country code for synthetic ISINs in this build.
 *
 * `US` because the paper is issued under a US regulation (Reg D / Reg S), so any other code
 * would be misleading about where the offering sits. It is not a claim that a US NNA issued
 * the number — see the note at the top of this file.
 */
export const DEFAULT_ISIN_COUNTRY = 'US';

/** 36^9 — the size of the 9-character base-36 NSIN space. */
const NSIN_SPACE = 36n ** BigInt(NSIN_LENGTH);

/**
 * Derive a stable NSIN from an invoice's uniqueness hash.
 *
 * The same receivable must always produce the same identifier: issuance is retried, paced
 * and occasionally replayed after a `BUSY`, and an ISIN that drifted between attempts would
 * let one invoice acquire two instruments — precisely the failure the uniqueness registry
 * exists to prevent.
 *
 * The hash is reduced modulo 36^9 and written in base 36. That is about 46.5 bits of the
 * 256-bit hash, so this is an *identifier*, not a commitment: two different invoices could
 * in principle land on the same NSIN. Collisions are caught upstream by the uniqueness hash
 * itself, which is the full 256 bits and is what actually gates issuance.
 */
export function nsinFromHash(uniquenessHash: Hex | string): string {
  const hex = uniquenessHash.startsWith('0x') ? uniquenessHash.slice(2) : uniquenessHash;
  if (hex.length === 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new RangeError(`nsinFromHash: not a hex string: ${uniquenessHash}`);
  }

  let remainder = BigInt(`0x${hex}`) % NSIN_SPACE;
  let out = '';
  for (let i = 0; i < NSIN_LENGTH; i += 1) {
    // charAt rather than [] so the result is `string` under noUncheckedIndexedAccess.
    out = BASE36_ALPHABET.charAt(Number(remainder % 36n)) + out;
    remainder /= 36n;
  }
  return out;
}

/**
 * The ISIN for an invoice: deterministic in its uniqueness hash, valid by construction.
 *
 * Throws rather than returning a `Result`, because both failure modes — a malformed hash or
 * a malformed country code — are programming errors at a call site that has already been
 * given a valid invoice.
 */
export function isinForInvoice(
  uniquenessHash: Hex | string,
  countryCode: string = DEFAULT_ISIN_COUNTRY,
): string {
  const generated = generateIsin(countryCode, nsinFromHash(uniquenessHash));
  if (!generated.ok) {
    throw new RangeError(`isinForInvoice: ${generated.error.reason}`);
  }
  return generated.value;
}

/** Split a validated ISIN into its parts, for a proof view or a debug panel. */
export function parseIsin(
  value: string,
): Result<
  { readonly countryCode: string; readonly nsin: string; readonly checkDigit: number },
  IsinError
> {
  const validated = validateIsin(value);
  if (!validated.ok) return validated;
  const isin = validated.value;
  return ok({
    countryCode: isin.slice(0, 2),
    nsin: isin.slice(2, 11),
    checkDigit: Number(isin.slice(11)),
  });
}
