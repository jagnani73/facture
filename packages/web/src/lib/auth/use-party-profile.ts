'use client';

import {
  getEmbeddedConnectedWallet,
  useIdentityToken,
  usePrivy,
  useSignTypedData,
  useWallets,
} from '@privy-io/react-auth';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api/client';
import { signInAvailable } from '@/lib/api/config';
import type { PartyLookup, ProfileSaved, SignedProfileUpdate } from '@/lib/api/contract';
import { ApiError } from '@/lib/api/problem';
import { buildProfileUpdate, typedDataFor, type ProfileDraft } from '@/lib/party';

/**
 * Writing what a business calls itself onto a chain, from a wallet that holds no money.
 *
 * This is the one thing in the whole product a user signs that is not about moving money, and it
 * is the only record here the venue does not author. `PartyRegistry` recovers the signer from an
 * EIP-712 signature and writes *that* address, so the venue relays and pays and cannot forge — the
 * exact opposite of `MandateBook`, which records the venue as the buyer of every standing bid
 * because the funders behind them hold no Hedera key.
 *
 * ## Why the wallet needs no gas
 *
 * Signing is arithmetic. The transaction is the venue's, on Hedera, paid from the operator key.
 * That was proved against the deployed registry with a freshly generated key that held nothing:
 * it signed, the operator relayed, and the record landed under the signer's address. A seller's
 * Privy wallet is in exactly that position — it has USDC on Arc only after someone tops it up, and
 * it never needs HBAR at all.
 *
 * ## What can be denied, and where
 *
 * Privy evaluates a wallet policy and **denies any RPC method no rule allows**. The seller's key
 * carries one policy covering two things: sending `claim` to `DvpEscrow` on Arc, and signing typed
 * data whose domain names this registry on this chain. If that second rule is missing — a
 * deployment whose policy predates it — the signature is refused at the wallet, before anything
 * reaches the venue, with no transaction to inspect. So a failure here is reported verbatim rather
 * than summarised: the wallet's own words are the only clue to that particular state.
 *
 * ## A 200 is not "it is on chain"
 *
 * The venue relays and then tells you what happened in `recording.state`. A node that would not
 * answer costs the public copy and nothing else — the venue's own record is written either way —
 * and a contract refusal is the party's to fix by signing again. Reading the status code alone
 * would tell somebody their profile is public when only half of it is.
 *
 * ## And a failure is not "nothing happened"
 *
 * The same asymmetry, pointed the other way. The venue relays and then answers, so a save that
 * fails at the HTTP layer may already have moved the nonce — which makes a failure the moment the
 * local copy is *most* likely to be stale, not the moment it is safest to keep. So the registry is
 * re-read on both exits, and a failure the venue did not articulate says the outcome is unknown
 * rather than claiming nothing was saved.
 */

export type ProfileState =
  | { status: 'unavailable' }
  | { status: 'loading' }
  | { status: 'no-wallet' }
  | { status: 'ready'; lookup: PartyLookup }
  | { status: 'failed'; message: string };

export type SaveState =
  | { status: 'idle' }
  | { status: 'signing' }
  | { status: 'relaying' }
  | { status: 'saved'; result: ProfileSaved }
  | { status: 'failed'; message: string; outcome: SaveOutcome };

/**
 * Whether a failed save is known not to have happened, or merely not known to have happened.
 *
 * Everything that fails before the relay is `not-saved` and can say so flatly: no registry wired,
 * no nonce, no identity token, a wallet that would not sign, a draft that cannot be encoded. In
 * each of those nothing left the browser.
 *
 * Past that point the venue relays to `PartyRegistry` and *then* answers, so a proxy giving up, a
 * dropped connection or a 500 raised after the chain write all arrive as failures with the
 * signature already spent. **A request timeout is not a rollback** — the lesson `POST /v1/trades`
 * taught this repo, where the agent's client gave up at ten seconds, the venue kept working, and
 * the trade was armed with nothing on the client's side knowing. Telling somebody "not saved"
 * there is a claim nobody is in a position to make.
 */
export type SaveOutcome = 'not-saved' | 'unknown';

export interface PartyProfileSession {
  state: ProfileState;
  save: SaveState;
  /** The address whose record this is, once a wallet exists. */
  address: string | null;
  submit: (draft: ProfileDraft) => Promise<void>;
  reload: () => void;
}

export function usePartyProfile(): PartyProfileSession {
  const available = signInAvailable();
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const { identityToken } = useIdentityToken();
  const { signTypedData } = useSignTypedData();

  const [state, setState] = useState<ProfileState>(
    available ? { status: 'loading' } : { status: 'unavailable' },
  );
  const [save, setSave] = useState<SaveState>({ status: 'idle' });
  const [nudge, setNudge] = useState(0);

  /*
   * The EMBEDDED wallet, and only once Privy has authenticated somebody.
   *
   * This read `wallets[0]` until the page was opened in a browser with an injected wallet
   * connected to localhost. `useWallets()` returns those too, so the screen offered to publish a
   * profile for an address with no Privy session behind it at all — and the venue would then have
   * refused the relay for want of an identity token, after the person had filled in the form and
   * signed. Caught in a browser rather than by a test, because every test signs in cleanly and
   * none of them has a second wallet lying around.
   *
   * `authenticated` is the gate because the venue authenticates a relay by identity token, not by
   * address, and an address nobody signed in as cannot produce one. `getEmbeddedConnectedWallet`
   * is the other half: of the wallets a session may carry, the embedded one is what Privy made
   * from the email and the one the venue has on file.
   *
   * Keying the effect on the address rather than on `wallets` is what stops Privy's re-render on
   * token refresh from turning one profile read into a dozen.
   */
  const address = authenticated ? (getEmbeddedConnectedWallet(wallets)?.address ?? null) : null;
  const asked = useRef<string | null>(null);

  useEffect(() => {
    if (!available) return;

    /*
     * Privy has not finished starting up. Deliberately not `no-wallet`: reporting that would flash
     * "sign in first" at somebody who is signed in, on every single load, before their session
     * resolves.
     */
    if (!ready) {
      setState({ status: 'loading' });
      return;
    }

    if (address === null) {
      /*
       * Not a failure. A viewer who is signed out is here, and so is a session Privy has
       * authenticated but not yet made an embedded wallet for.
       */
      setState({ status: 'no-wallet' });
      return;
    }

    const key = `${address}:${nudge}`;
    if (asked.current === key) return;
    asked.current = key;

    const controller = new AbortController();
    setState({ status: 'loading' });

    void (async () => {
      try {
        const lookup = await api.getParty(address, controller.signal);
        setState({ status: 'ready', lookup });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
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
  }, [available, ready, address, nudge]);

  const reload = useCallback(() => setNudge((n) => n + 1), []);

  const submit = useCallback(
    async (draft: ProfileDraft) => {
      if (state.status !== 'ready' || address === null) return;

      const { lookup } = state;

      /*
       * Both of these are the registry being unreachable rather than the party being wrong, and
       * they are different from each other: no registry wired at all, versus a node that would not
       * say what nonce comes next. Signing against a guessed nonce would produce a signature the
       * contract refuses, so neither is worked around.
       */
      if (lookup.signing === null) {
        setSave({
          status: 'failed',
          outcome: 'not-saved',
          message:
            'This deployment has no party registry wired, so there is nothing to sign against. ' +
            'Your details would live only in the venue’s own records.',
        });
        return;
      }
      if (lookup.nonce === null) {
        setSave({
          status: 'failed',
          outcome: 'not-saved',
          message:
            'The registry could not be read just now, so the venue does not know which nonce your ' +
            'signature needs. Nothing is wrong with your details — try again in a moment.',
        });
        return;
      }
      if (identityToken === null) {
        setSave({
          status: 'failed',
          outcome: 'not-saved',
          message: 'Your session has no identity token yet. Sign in again and retry.',
        });
        return;
      }

      /*
       * Inside a try, which it was not.
       *
       * `rolesToBitmask` throws on an empty role set and `countryToBytes2` throws on anything that
       * is not two letters, and this call sat between the guards above and the first `setSave`.
       * Nothing could reach it, because the form disables the button while `validateDraft` finds
       * either — which is precisely the shape this repo keeps paying for: a guard that is
       * load-bearing only because some other constraint happens to hold, with nothing in the guard
       * naming the constraint. The other caller of `submit` is a test, and the next one will not
       * be. Unhandled, the throw escapes an async callback nobody awaits and the screen sits on
       * "Check your wallet…" for a wallet that was never asked.
       *
       * Its own try rather than the signing one below, because the two failures have different
       * fixes and different words: this is a draft that cannot be encoded, not a wallet refusing.
       */
      let update: SignedProfileUpdate;
      try {
        update = buildProfileUpdate({
          party: address as `0x${string}`,
          draft,
          nonce: lookup.nonce,
        });
      } catch (error) {
        setSave({
          status: 'failed',
          outcome: 'not-saved',
          message:
            error instanceof Error
              ? `These details cannot be put into a signable message: ${error.message}`
              : 'These details cannot be put into a signable message.',
        });
        return;
      }

      setSave({ status: 'signing' });
      let signature: string;
      try {
        const payload = typedDataFor(update, lookup.signing.domain);
        const result = await signTypedData(payload as never, { address });
        signature = result.signature;
      } catch (error) {
        /*
         * Verbatim, not summarised. A wallet policy that has no rule for `eth_signTypedData_v4`
         * denies this before anything leaves the browser, and Privy's own message is the only
         * evidence that is what happened — there is no transaction and no venue log to check.
         */
        setSave({
          status: 'failed',
          outcome: 'not-saved',
          message:
            error instanceof Error
              ? `Your wallet did not sign: ${error.message}`
              : 'Your wallet did not sign.',
        });
        return;
      }

      setSave({ status: 'relaying' });
      try {
        const result = await api.saveProfile(identityToken, { update, signature });
        setSave({ status: 'saved', result });
        // The nonce has moved, so the next edit needs a fresh read. Asking again is cheap and is
        // the only answer that cannot be stale.
        reload();
      } catch (error) {
        /*
         * Re-read on the way out too, and this half was missing.
         *
         * **A failed save is exactly when the nonce is most likely to have moved.** The venue
         * relays to the registry and then answers, so a proxy 504, a dropped connection or a 500
         * raised after the chain write all land here with the signature already consumed and
         * `lookup.nonce` a number the contract will never accept again. Reloading only on success
         * left the next attempt re-signing that stale nonce, being refused, and being told by the
         * refusal that signing again resolves it — which is false until the page is reloaded. A
         * guaranteed-refused retry loop, entered at the worst possible moment.
         *
         * Before the message, so the fresh read is already in flight by the time anybody reads it.
         */
        reload();
        setSave({ status: 'failed', ...describeRelayFailure(error) });
      }
    },
    [state, address, identityToken, signTypedData, reload],
  );

  return { state, save, address, submit, reload };
}

/**
 * What to say about a relay that did not come back, and how sure to sound saying it.
 *
 * A 4xx is the venue answering. It read the request, declined it, and wrote a sentence — so it
 * knows nothing was relayed and that sentence is the one to show.
 *
 * Everything else is a question this browser cannot answer: no reply at all, a 5xx which may have
 * been raised after the chain write, or a 200 in a shape the decoder refused, where the save almost
 * certainly did happen. Each of those gets the {@link SaveOutcome} note rather than "not saved",
 * for the reason that type gives — and the venue's own words are kept in front of it, because "no
 * answer" and "the venue crashed" are different things to go looking for.
 */
function describeRelayFailure(error: unknown): { message: string; outcome: SaveOutcome } {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return { outcome: 'not-saved', message: error.detail ?? error.title };
  }

  const said = error instanceof ApiError ? `${error.detail ?? error.title}. ` : '';
  return {
    outcome: 'unknown',
    message:
      `${said}The venue did not answer, so whether your profile reached the registry is unknown — ` +
      'a timeout is not a rollback. This page has re-read what is recorded; check it above before ' +
      'signing again.',
  };
}
