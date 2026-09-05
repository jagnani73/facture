'use client';

import { usePrivy } from '@privy-io/react-auth';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api/client';
import { signInAvailable } from '@/lib/api/config';
import { setSignedInSeller } from '@/lib/api/identity';
import { ApiError } from '@/lib/api/problem';
import type { SellerRecord } from '@/lib/api/contract';

/**
 * Turning a Privy login into a seller the venue knows about.
 *
 * Privy answers "who is this person" with an email address and a wallet. It does not and
 * cannot answer "whose book is this", because the venue scopes every seller-side route by a
 * UUID that only the venue mints. So a login is only half a sign-in: the other half is
 * `POST /v1/sellers`, which is idempotent on email precisely so this can be called on every
 * login without asking whether the business already exists.
 *
 * That idempotency is also why nothing is cached. The venue's id is recovered by asking
 * again, and a copy kept in localStorage would be a second answer that can go stale while
 * looking authoritative.
 *
 * ## The business name is provisional, and that is a real limitation
 *
 * The venue requires a name and Privy has no idea what a business is called, so one is
 * derived from the email domain. This is tolerable rather than good, and only because of
 * three specific facts: no screen renders it (`api-source.ts` says "Your business"), the
 * venue keeps the first name it was given and never overwrites it, and a business signing in
 * is not a business telling us its trading name. Making it correct needs a route that can
 * change it, which does not exist. That is a gap, stated rather than hidden behind a
 * plausible-looking string.
 */

/**
 * `ada@meridian-fabrication.example` → `Meridian Fabrication`.
 *
 * Total by construction, because the venue requires a non-empty name and rejects the
 * request otherwise: a sign-in that fails validation on a field the person never typed
 * would be unexplainable to them. The last resort says it is unnamed rather than dressing
 * up an empty string, which is the one outcome that would be worse than a placeholder.
 */
export function provisionalName(email: string): string {
  const domain = email.split('@')[1] ?? '';
  const label = domain.split('.')[0] ?? '';
  const words = label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));

  if (words.length > 0) return words.join(' ');
  return email.trim() === '' ? 'Unnamed business' : email.trim();
}

export type SellerSessionState =
  | { status: 'unavailable' }
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signing-in'; email: string }
  | { status: 'signed-in'; seller: SellerRecord; created: boolean }
  | { status: 'failed'; email: string; message: string };

export interface SellerSession {
  state: SellerSessionState;
  signIn: () => void;
  signOut: () => void;
}

export function useSellerSession(): SellerSession {
  const available = signInAvailable();
  const { ready, authenticated, user, login, logout } = usePrivy();
  const [state, setState] = useState<SellerSessionState>(
    available ? { status: 'loading' } : { status: 'unavailable' },
  );

  /*
   * Which email the venue has already been asked about. Privy re-renders on wallet
   * creation, so without this the same sign-in fires several POSTs — harmless at the venue,
   * because the route is idempotent, and still three requests where one was meant.
   */
  const asked = useRef<string | null>(null);

  /*
   * Blank counts as absent. A logged-in Privy user with no usable email cannot be turned
   * into a seller — the venue identifies one by email — so this reads as signed out rather
   * than being sent on to fail validation on a field nobody typed.
   */
  const rawEmail = user?.email?.address?.trim();
  const email = rawEmail === undefined || rawEmail === '' ? null : rawEmail;
  const walletAddress = user?.wallet?.address ?? null;

  useEffect(() => {
    if (!available) return;

    if (!ready) {
      setState({ status: 'loading' });
      return;
    }

    if (!authenticated || email === null) {
      asked.current = null;
      setSignedInSeller(null);
      setState({ status: 'signed-out' });
      return;
    }

    if (asked.current === email) return;
    asked.current = email;

    const controller = new AbortController();
    setState({ status: 'signing-in', email });

    void (async () => {
      try {
        const result = await api.signInSeller(
          {
            name: provisionalName(email),
            email,
            ...(walletAddress ? { arcAddress: walletAddress } : {}),
          },
          controller.signal,
        );
        setSignedInSeller(result.seller.id);
        setState({ status: 'signed-in', seller: result.seller, created: result.created });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        /*
         * A failed sign-in must not leave the app quietly rendering the configured seller's
         * book as though it were this person's. Clearing is what makes the failure visible.
         */
        setSignedInSeller(null);
        asked.current = null;
        setState({
          status: 'failed',
          email,
          message:
            error instanceof ApiError
              ? (error.detail ?? error.title)
              : 'The venue could not be reached.',
        });
      }
    })();

    return () => controller.abort();
  }, [available, ready, authenticated, email, walletAddress]);

  const signOut = useCallback(() => {
    setSignedInSeller(null);
    void logout();
  }, [logout]);

  return { state, signIn: login, signOut };
}
