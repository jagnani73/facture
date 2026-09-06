/**
 * Turning a Privy identity token into a verified seller.
 *
 * `POST /v1/sellers` used to take an email address out of a request body and believe it.
 * Nothing stopped anyone claiming any address, which made the venue's record of who a
 * business is a record of what someone typed. This is what closes that: the email arrives
 * signed by Privy or it does not arrive at all.
 *
 * ## The identity token, not the access token
 *
 * Privy issues two. The **access token** proves a session is live and carries a DID and
 * nothing else, so using it would mean calling Privy's API for the email on every sign-in —
 * `getUser(userId)` is deprecated and rate-limited for exactly that reason. The **identity
 * token** carries the linked accounts inside the signed payload, so `getUser({ idToken })`
 * verifies the signature and reads the email out of it with no network call at all.
 *
 * They are easy to confuse and the wrong one fails at the signature check rather than at
 * anything that names the mistake, so the refusal below says which token was expected.
 *
 * It is presented as `Authorization: Bearer <identity token>`. Privy's own convention is a
 * `privy-id-token` cookie, which cannot be used here: the app and the venue are different
 * origins, so nothing would send it.
 *
 * ## What the token may not contain
 *
 * Privy documents the identity token's payload as possibly incomplete, because it is size
 * constrained. So a token that verifies but carries no email is a real case and it is
 * refused rather than worked around — a seller with no email cannot be identified by the
 * one field this venue identifies sellers by.
 */

import { PrivyClient } from '@privy-io/server-auth';
import { badRequest, unauthorized } from '../errors.js';
import type { Logger } from '../logger.js';
import { rootLogger } from '../logger.js';

export interface VerifiedSeller {
  /** Verified by Privy, not supplied by the caller. Lowercased here so callers cannot differ. */
  email: string;
  /** The embedded wallet's address, when the token carried one. */
  walletAddress: string | null;
  /**
   * Privy's own id for that wallet, which is a different thing from its address.
   *
   * A policy is attached to a wallet id and never to an address, so this is what
   * `services/privy-policy.ts` needs — and Privy's type documents it as null unless the
   * wallet is delegated or on the unified wallets stack, so an ordinary embedded wallet
   * arrives here with an address and no id. That is a normal state rather than a gap: the
   * id is then resolved from the address, and this field only saves the round trip.
   */
  walletId: string | null;
  /** Privy's DID for this user. Recorded in logs only; the venue keys sellers by email. */
  privyUserId: string;
}

export interface PrivyVerifier {
  verify(idToken: string): Promise<VerifiedSeller>;
}

export interface PrivyVerifierConfig {
  readonly appId: string | undefined;
  readonly appSecret: string | undefined;
  readonly logger?: Logger | undefined;
}

/**
 * Sign-in with no Privy credentials configured.
 *
 * Refuses naming the variables, in the same shape as the ATS adapter with no factory. The
 * alternative — accepting an unverified email so the route still "works" — is precisely the
 * behaviour this module exists to remove, and it would be worse for being reachable only on
 * the deployments that forgot to configure it.
 */
export function createDisabledPrivyVerifier(): PrivyVerifier {
  return {
    verify: () =>
      Promise.reject(
        badRequest(
          'Signing in needs Privy credentials. PRIVY_APP_ID and PRIVY_APP_SECRET are not ' +
            'set, so seller sign-in is disabled on this deployment.',
        ),
      ),
  };
}

export function createPrivyVerifier(config: PrivyVerifierConfig): PrivyVerifier {
  if (config.appId === undefined || config.appSecret === undefined) {
    return createDisabledPrivyVerifier();
  }

  const log = (config.logger ?? rootLogger).child({ svc: 'privy' });
  const client = new PrivyClient(config.appId, config.appSecret);

  return {
    async verify(idToken) {
      let user: Awaited<ReturnType<typeof client.getUser>>;
      try {
        user = await client.getUser({ idToken });
      } catch (err) {
        log.warn('identity token rejected', { err });
        throw unauthorized(
          'That sign-in could not be verified. The Authorization header must carry a Privy ' +
            'identity token — the access token is a different token and will not verify here.',
        );
      }

      const email = user.email?.address?.trim().toLowerCase();
      if (email === undefined || email === '') {
        throw unauthorized(
          'That sign-in verified but carried no email address, and a seller is identified ' +
            'by email here. Sign in with an email address rather than another method.',
        );
      }

      return {
        email,
        walletAddress: user.wallet?.address ?? null,
        walletId: user.wallet?.id ?? null,
        privyUserId: user.id,
      };
    },
  };
}

let verifier: PrivyVerifier | undefined;

export function initPrivyVerifier(config: PrivyVerifierConfig): PrivyVerifier {
  verifier = createPrivyVerifier(config);
  return verifier;
}

/** Test seam, matching the other services. `undefined` clears it. */
export function setPrivyVerifier(next: PrivyVerifier | undefined): void {
  verifier = next;
}

export function getPrivyVerifier(): PrivyVerifier {
  if (!verifier) throw new Error('Privy verifier accessed before initPrivyVerifier().');
  return verifier;
}

/**
 * `ada@meridian-fabrication.example` → `Meridian Fabrication`.
 *
 * The venue requires a name, Privy cannot know what a business is called, and there is no
 * route to correct one. So this is a label rather than a record, and it lives here — beside
 * the verified email it is derived from — rather than in the client, which would let two
 * callers disagree about a business's name.
 *
 * Total by construction: a sign-in must not fail validation on a field nobody typed.
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
