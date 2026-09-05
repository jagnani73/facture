/**
 * The seller-session decoder.
 *
 * The hook itself is glue over Privy and is not worth a fake Privy to exercise. What is
 * worth pinning is the shape the venue answers with, since a decoder reading the wrong field
 * is well-typed and silent.
 *
 * The business name is no longer derived here. It is derived at the venue, beside the
 * verified email it comes from, so that two callers cannot disagree about what a business is
 * called - `packages/backend/test/sellers.test.ts` covers it.
 */

import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/problem';
import { readSeller, readSellerSignIn } from '@/lib/api/contract';

function refusal(read: () => unknown): ApiError {
  try {
    read();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected an unreadable ApiError');
}

const SELLER = {
  id: 'adee1c64-4ba9-46be-9c04-3a37c1ddc895',
  name: 'Meridian Fabrication',
  email: 'ada@meridian.example',
  hederaAccountId: null,
  arcAddress: '0x1c755e95cb11e5d5af498bb0ea595b56e1adb035',
};

describe('readSeller', () => {
  it('reads the record the venue returns', () => {
    const seller = readSeller(SELLER);
    expect(seller.id).toBe(SELLER.id);
    expect(seller.email).toBe('ada@meridian.example');
    expect(seller.arcAddress).toBe(SELLER.arcAddress);
  });

  /*
   * A wallet made from an email has an address and no Hedera account: the address is an
   * alias and the account behind it exists only once something funds it. Null here is a
   * fact, and reading it as one is the difference between "not yet" and "broken".
   */
  it('reads a null Hedera account as absent rather than refusing the record', () => {
    expect(readSeller(SELLER).hederaAccountId).toBeNull();
    expect(readSeller({ ...SELLER, hederaAccountId: '0.0.10331559' }).hederaAccountId).toBe(
      '0.0.10331559',
    );
  });

  it.each(['id', 'name', 'email'])('refuses a record missing %s, naming it', (missing) => {
    const body: Record<string, unknown> = { ...SELLER };
    delete body[missing];
    expect(refusal(() => readSeller(body)).detail).toContain(`seller.${missing}`);
  });
});

describe('readSellerSignIn', () => {
  it('reads a new business as created', () => {
    expect(readSellerSignIn({ seller: SELLER, created: true }).created).toBe(true);
  });

  /*
   * Absent means returning, not new. Defaulting the other way would greet an existing
   * business as a first-timer on every single sign-in.
   */
  it('reads a missing flag as a returning business', () => {
    expect(readSellerSignIn({ seller: SELLER }).created).toBe(false);
    expect(readSellerSignIn({ seller: SELLER, created: 'yes' }).created).toBe(false);
  });

  it('refuses a sign-in with no seller in it', () => {
    expect(refusal(() => readSellerSignIn({ created: true })).detail).toContain('signIn.seller');
  });
});
