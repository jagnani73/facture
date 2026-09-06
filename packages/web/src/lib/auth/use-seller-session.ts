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
 *
 * **The wait is bounded, and it was not.** A session Privy reports as authenticated whose
 * identity token never arrives left this permanently in `signing-in`: no request was ever
 * made, so nothing could fail, and the masthead read "Signing in…" forever. Found by opening
 * the app in a browser carrying a stale session rather than by reading this file, because
 * every test signs in cleanly and never reaches the state.
 *
 * It is a dead end rather than a slow path: `signing-in` offers no way back, the demo book is
 * the signed-out state, and a viewer cannot reach it again without clearing site data. So an
 * identity token that has not arrived within {@link IDENTITY_TOKEN_TIMEOUT_MS} is reported as
 * a failure that names itself, and every failure offers a way out.
 */

/**
 * How long an authenticated session may go without producing an identity token.
 *
 * Generous on purpose. The token genuinely does lag `authenticated` by a render or two on a
 * normal sign-in, and turning that into an error would be worse than the hang. What this
 * bounds is the case where it is never coming.
 */
const IDENTITY_TOKEN_TIMEOUT_MS = 10_000;

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

    /*
     * Authenticated, but the credential has not arrived yet. Not a failure, and not yet a
     * request — but bounded, because a token that is never coming is indistinguishable from
     * one that is late, and only one of the two ends on its own.
     */
    if (identityToken === null) {
      setState({ status: 'signing-in' });
      const timer = setTimeout(() => {
        setState({
          status: 'failed',
          message:
            'Privy reports you as signed in but did not produce an identity token, so the ' +
            'venue was never asked who you are. Signing out returns you to the demo book.',
        });
      }, IDENTITY_TOKEN_TIMEOUT_MS);
      return () => clearTimeout(timer);
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
