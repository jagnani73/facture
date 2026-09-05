'use client';

import { useIdentityToken, usePrivy } from '@privy-io/react-auth';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api/client';
import { signInAvailable } from '@/lib/api/config';
import type { SellerRecord } from '@/lib/api/contract';
import { setSignedInSeller } from '@/lib/api/identity';
import { ApiError } from '@/lib/api/problem';

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
 * ## The identity token, and why the wait matters
 *
 * All this sends is `Authorization: Bearer <identity token>`. The email and wallet come out
 * of that token at the venue, verified against Privy's signature — nothing this file knows is
 * trusted, because nothing it knows is proof.
 *
 * The **identity** token is the one carrying linked accounts; the access token carries a DID
 * and would make the venue call Privy's API for the email on every sign-in. They arrive
 * separately, and the identity token can still be `null` on the render where `authenticated`
 * first turns true — so this waits for the token rather than firing a request that would be
 * refused for having no credential.
 */

export type SellerSessionState =
  | { status: 'unavailable' }
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signing-in' }
  | { status: 'signed-in'; seller: SellerRecord; created: boolean }
  | { status: 'failed'; message: string };

export interface SellerSession {
  state: SellerSessionState;
  signIn: () => void;
  signOut: () => void;
}

export function useSellerSession(): SellerSession {
  const available = signInAvailable();
  const { ready, authenticated, login, logout } = usePrivy();
  const { identityToken } = useIdentityToken();
  const [state, setState] = useState<SellerSessionState>(
    available ? { status: 'loading' } : { status: 'unavailable' },
  );

  /*
   * Which token the venue has already been asked about. Privy re-renders on wallet creation
   * and on token refresh, so without this one sign-in fires several POSTs — harmless at the
   * venue, because the route is idempotent, and still three requests where one was meant.
   */
  const asked = useRef<string | null>(null);

  useEffect(() => {
    if (!available) return;

    if (!ready) {
      setState({ status: 'loading' });
      return;
    }

    if (!authenticated) {
      asked.current = null;
      setSignedInSeller(null);
      setState({ status: 'signed-out' });
      return;
    }

    // Authenticated, but the credential has not arrived yet. Not a failure; not yet a request.
    if (identityToken === null) {
      setState({ status: 'signing-in' });
      return;
    }

    if (asked.current === identityToken) return;
    asked.current = identityToken;

    const controller = new AbortController();
    setState({ status: 'signing-in' });

    void (async () => {
      try {
        const result = await api.signInSeller(identityToken, controller.signal);
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
          message:
            error instanceof ApiError
              ? (error.detail ?? error.title)
              : 'The venue could not be reached.',
        });
      }
    })();

    return () => controller.abort();
  }, [available, ready, authenticated, identityToken]);

  const signOut = useCallback(() => {
    setSignedInSeller(null);
    void logout();
  }, [logout]);

  return { state, signIn: login, signOut };
}
