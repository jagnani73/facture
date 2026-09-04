/**
 * Debtor confirmation tokens.
 *
 * The lightest thing in the product, and load-bearing: the customer gets a link carrying
 * one sentence and two buttons, with no wallet, no signup and no account. Confirmation is
 * what gives an invoice a price, and it is also what removes the dispute risk a 10–20%
 * holdback exists to cover — which is what buys the seller a full advance.
 *
 * ## The token
 *
 * ```
 *   <32 bytes of entropy, base64url> . <HMAC-SHA256 of that, truncated, base64url>
 * ```
 *
 * Two layers, doing two different jobs:
 *
 * - **The HMAC tag** is checked before any database work. A crawler hitting `/v1/confirm/…`
 *   with rubbish is rejected on arithmetic, not on a query, and the comparison is
 *   constant-time so the tag cannot be recovered a byte at a time.
 * - **The stored value is SHA-256 of the whole token, never the token.** A read of the
 *   `confirmation_requests` table therefore yields nothing that can be clicked. The token
 *   exists in exactly two places: the email, and this process's memory for the length of
 *   one request.
 *
 * The tag is truncated to 16 bytes. It is an anti-noise check on a value that already
 * carries 256 bits of entropy, not the thing keeping the link secret, and a shorter token
 * survives an email client's line wrapping.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Bytes of entropy in the token body. */
const ENTROPY_BYTES = 32;
/** Bytes of the HMAC kept as the tag. */
const TAG_BYTES = 16;
const SEPARATOR = '.';

const base64url = (buffer: Buffer): string => buffer.toString('base64url');

const tagFor = (body: string, secret: string): string =>
  base64url(createHmac('sha256', secret).update(body).digest().subarray(0, TAG_BYTES));

export interface MintedToken {
  /** Goes in the email. Never stored, never logged. */
  readonly token: string;
  /** SHA-256 hex of `token`. This is what the database holds. */
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export function mintConfirmationToken(
  secret: string,
  ttlHours: number,
  now: Date = new Date(),
): MintedToken {
  const body = base64url(randomBytes(ENTROPY_BYTES));
  const token = `${body}${SEPARATOR}${tagFor(body, secret)}`;
  return {
    token,
    tokenHash: confirmationTokenHash(token),
    expiresAt: new Date(now.getTime() + ttlHours * 3_600_000),
  };
}

/** SHA-256 hex of a token. The only form that ever reaches persistence. */
export const confirmationTokenHash = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/**
 * Does this token carry our own HMAC tag? Constant-time, and cheap enough to run before
 * touching the database.
 *
 * A `true` here says only that we minted it — not that it is unexpired, unconsumed, or
 * attached to an invoice. Those are the store's answers, and this check exists so that a
 * scan for valid links costs the scanner rather than the database.
 */
export function isWellFormedToken(token: string, secret: string): boolean {
  const at = token.indexOf(SEPARATOR);
  if (at <= 0 || at === token.length - 1) return false;

  const body = token.slice(0, at);
  const provided = Buffer.from(token.slice(at + 1), 'base64url');
  const expected = Buffer.from(tagFor(body, secret), 'base64url');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/** The URL that goes in the email. Built here so nothing else concatenates a token. */
export const confirmationLink = (baseUrl: string, token: string): string =>
  `${baseUrl.replace(/\/$/, '')}/v1/confirm/${token}`;
