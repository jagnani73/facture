/**
 * Whose book renders.
 *
 * The rule this module exists to hold is an ordering one — **a signed-in seller beats the
 * configured one, and signing out restores the configured one rather than clearing it** —
 * and getting it backwards fails in a way nobody would report as a bug. The screens would
 * simply keep showing the demo seller's book to someone who had signed in, which looks like
 * a working page.
 *
 * `SELLER_ID` and `BUYER_ID` come from `NEXT_PUBLIC_*` at build time. Under vitest they are
 * unset, so the configured identity here is the empty string — which is itself worth
 * asserting against, because it is exactly the state `explainMissingIdentity` has to explain
 * rather than pass through to the venue as a 422.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUYER_ID, SELLER_ID } from '@/lib/api/config';
import {
  buyerId,
  explainMissingIdentity,
  isSignedIn,
  sellerId,
  setSignedInSeller,
  subscribe,
} from '@/lib/api/identity';

const A_SELLER = 'e37a8422-960d-5a77-9825-8964df79ed49';
const ANOTHER = 'f888dd62-6df0-5600-925e-06469ef0aef6';

afterEach(() => {
  setSignedInSeller(null);
});

describe('resolution order', () => {
  it('falls back to the configured seller when nobody is signed in', () => {
    expect(isSignedIn()).toBe(false);
    expect(sellerId()).toBe(SELLER_ID);
  });

  it('prefers a signed-in seller over the configured one', () => {
    setSignedInSeller(A_SELLER);

    expect(isSignedIn()).toBe(true);
    expect(sellerId()).toBe(A_SELLER);
    expect(sellerId()).not.toBe(SELLER_ID);
  });

  /* Signing out restores configuration; it does not leave the app with no identity. */
  it('returns to the configured seller on sign-out', () => {
    setSignedInSeller(A_SELLER);
    setSignedInSeller(null);

    expect(isSignedIn()).toBe(false);
    expect(sellerId()).toBe(SELLER_ID);
  });

  it('treats a blank id as signed out rather than as a seller called ""', () => {
    setSignedInSeller('   ');
    expect(isSignedIn()).toBe(false);
    expect(sellerId()).toBe(SELLER_ID);
  });

  /*
   * The buyer side has no session because there is no `POST /v1/buyers` for one to come
   * from. Pinned so that shipping half of it later is a deliberate act.
   */
  it('leaves the buyer on configuration', () => {
    setSignedInSeller(A_SELLER);
    expect(buyerId()).toBe(BUYER_ID);
  });
});

describe('subscription', () => {
  it('notifies on a change so a render can follow it', () => {
    const seen = vi.fn();
    const stop = subscribe(seen);

    setSignedInSeller(A_SELLER);
    expect(seen).toHaveBeenCalledTimes(1);

    setSignedInSeller(ANOTHER);
    expect(seen).toHaveBeenCalledTimes(2);

    stop();
  });

  /* Setting the same id again is not a change. Notifying would be a render loop. */
  it('says nothing when the identity did not actually move', () => {
    setSignedInSeller(A_SELLER);
    const seen = vi.fn();
    const stop = subscribe(seen);

    setSignedInSeller(A_SELLER);
    expect(seen).not.toHaveBeenCalled();

    stop();
  });

  it('stops notifying once unsubscribed', () => {
    const seen = vi.fn();
    subscribe(seen)();

    setSignedInSeller(A_SELLER);
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('explainMissingIdentity', () => {
  it('names the environment variable when nothing is configured or signed in', () => {
    const message = explainMissingIdentity('seller');
    expect(message).toContain('NEXT_PUBLIC_SELLER_ID');
  });

  it('says nothing once a signed-in seller supplies a usable id', () => {
    setSignedInSeller(A_SELLER);
    expect(explainMissingIdentity('seller')).toBeNull();
  });

  /*
   * The message must follow the identity that is actually in use. Still naming the
   * environment variable after someone has signed in would send them to fix a setting that
   * is no longer being read.
   */
  it('blames the venue, not the environment, when a session id is unusable', () => {
    setSignedInSeller('not-a-uuid');

    const message = explainMissingIdentity('seller');
    expect(message).toContain('Signed in');
    expect(message).not.toContain('NEXT_PUBLIC_SELLER_ID');
  });

  it('still explains the buyer from configuration', () => {
    setSignedInSeller(A_SELLER);
    expect(explainMissingIdentity('buyer')).toContain('NEXT_PUBLIC_BUYER_ID');
  });
});
