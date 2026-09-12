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
  setSignedInBuyer,
  setSignedInSeller,
  subscribe,
} from '@/lib/api/identity';

const A_SELLER = 'e37a8422-960d-5a77-9825-8964df79ed49';
const ANOTHER = 'f888dd62-6df0-5600-925e-06469ef0aef6';
const A_DESK = '2b6f0cc9-04a1-5e35-8f7c-3d1f9f0b1a2e';

afterEach(() => {
  setSignedInSeller(null);
  setSignedInBuyer(null);
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
   * The buyer half, which used to be pinned as ABSENT.
   *
   * The test that stood here asserted that signing a seller in left `buyerId()` on
   * configuration, with a comment saying there was no `POST /v1/buyers` for a session to come
   * from — "pinned so that shipping half of it later is a deliberate act". That route shipped
   * and `buyerId()` reads a session first, and the test kept passing, because it never called
   * `setSignedInBuyer` and so pinned nothing at all. A test describing a world that no longer
   * exists is worse than no test: it reads as coverage.
   *
   * What is worth holding is the same ordering rule the seller side has, plus the property the
   * split setters exist for — the two halves move independently, so a seller who resolved
   * without a desk is a real state rather than a signed-out one.
   */
  it('prefers a signed-in buyer over the configured desk', () => {
    setSignedInBuyer(A_DESK);

    expect(buyerId()).toBe(A_DESK);
    expect(buyerId()).not.toBe(BUYER_ID);
  });

  it('leaves the buyer on configuration while only the seller has resolved', () => {
    setSignedInSeller(A_SELLER);

    expect(sellerId()).toBe(A_SELLER);
    expect(buyerId()).toBe(BUYER_ID);
  });

  it('returns to the configured desk on sign-out', () => {
    setSignedInBuyer(A_DESK);
    setSignedInBuyer(null);

    expect(buyerId()).toBe(BUYER_ID);
  });

  /* The seller side's blank rule, which has to hold identically or the halves diverge. */
  it('treats a blank desk id as signed out rather than as a desk called ""', () => {
    setSignedInBuyer('   ');
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

/*
 * `useMarket` reads the seller through `useSyncExternalStore(subscribe, sellerId, …)`, so
 * these three properties are what make signing in actually re-fetch the book. They were all
 * true and unused for a while: the subscription existed and nothing subscribed, so the
 * identity changed and the screen kept showing the previous seller's invoices until the next
 * navigation — the feature failing silently rather than loudly.
 */
describe('the store contract useSyncExternalStore depends on', () => {
  it('returns a snapshot that changes identity when the seller changes', () => {
    const before = sellerId();
    setSignedInSeller(A_SELLER);
    expect(sellerId()).not.toBe(before);
  });

  /* A snapshot that allocated a new value each call would re-render forever. */
  it('returns a stable snapshot while nothing changes', () => {
    setSignedInSeller(A_SELLER);
    expect(sellerId()).toBe(sellerId());
  });

  it('notifies subscribers in the same tick the snapshot changes', () => {
    let snapshotAtNotify: string | null = null;
    const stop = subscribe(() => {
      snapshotAtNotify = sellerId();
    });

    setSignedInSeller(A_SELLER);
    expect(snapshotAtNotify).toBe(A_SELLER);

    stop();
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

  it('says nothing once a signed-in buyer supplies a usable id', () => {
    setSignedInBuyer(A_DESK);
    expect(explainMissingIdentity('buyer')).toBeNull();
  });

  /*
   * The buyer half of the same rule, and the branch that arrived with `POST /v1/buyers`. A desk
   * resolved from a session that the venue answered with something unusable must not send its
   * owner to fix an environment variable nothing is reading.
   */
  it('blames the venue, not the environment, when a session desk id is unusable', () => {
    setSignedInBuyer('not-a-uuid');

    const message = explainMissingIdentity('buyer');
    expect(message).toContain('Signed in');
    expect(message).toContain('desk');
    expect(message).not.toContain('NEXT_PUBLIC_BUYER_ID');
  });
});
