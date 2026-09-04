/**
 * Confirmation tokens.
 *
 * The token is the only authentication on the debtor's two routes, and there is
 * deliberately no session and no signup wall behind it — the moment a debtor has to create
 * an account, the behavioural argument that makes confirmation work stops holding. So the
 * token itself has to carry its weight.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  confirmationLink,
  isWellFormedToken,
  mintConfirmationToken,
} from '../src/services/confirmation.js';

const SECRET = 'a-secret-that-is-at-least-32-chars!!';

describe('minting', () => {
  it('produces a token that fits the route’s own length bounds', () => {
    const { token } = mintConfirmationToken(SECRET, 168);
    expect(token.length).toBeGreaterThanOrEqual(20);
    expect(token.length).toBeLessThanOrEqual(200);
    // Base64url only: a token that needs escaping breaks the link in an email client.
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('never repeats', () => {
    const tokens = new Set(
      Array.from({ length: 200 }, () => mintConfirmationToken(SECRET, 1).token),
    );
    expect(tokens.size).toBe(200);
  });

  it('stores the SHA-256 and never the token, so a table read yields nothing clickable', () => {
    const { token, tokenHash } = mintConfirmationToken(SECRET, 168);
    expect(tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(tokenHash).not.toContain(token);
    expect(token).not.toContain(tokenHash);
  });

  it('expires the number of hours it was given', () => {
    const now = new Date('2026-09-01T00:00:00.000Z');
    const { expiresAt } = mintConfirmationToken(SECRET, 168, now);
    expect(expiresAt.toISOString()).toBe('2026-09-08T00:00:00.000Z');
  });
});

describe('the HMAC tag', () => {
  it('accepts a token this service minted', () => {
    const { token } = mintConfirmationToken(SECRET, 168);
    expect(isWellFormedToken(token, SECRET)).toBe(true);
  });

  it('rejects a token minted under a different secret', () => {
    const { token } = mintConfirmationToken(SECRET, 168);
    expect(isWellFormedToken(token, 'a-different-secret-of-the-same-len!!')).toBe(false);
  });

  it('rejects a tampered body, which is the point of tagging it at all', () => {
    const { token } = mintConfirmationToken(SECRET, 168);
    const [body = '', tag = ''] = token.split('.');
    const flipped = `${body.slice(0, -1)}${body.at(-1) === 'A' ? 'B' : 'A'}.${tag}`;
    expect(isWellFormedToken(flipped, SECRET)).toBe(false);
  });

  it('rejects rubbish without throwing, so a crawler costs arithmetic and not a query', () => {
    for (const junk of ['', '.', 'nodot', 'a.', '.b', 'a'.repeat(300)]) {
      expect(isWellFormedToken(junk, SECRET)).toBe(false);
    }
  });
});

describe('the emailed link', () => {
  it('is built in one place, and tolerates a trailing slash on the base URL', () => {
    const { token } = mintConfirmationToken(SECRET, 168);
    expect(confirmationLink('http://localhost:8787/', token)).toBe(
      `http://localhost:8787/v1/confirm/${token}`,
    );
    expect(confirmationLink('https://facture.example', token)).toBe(
      `https://facture.example/v1/confirm/${token}`,
    );
  });
});
