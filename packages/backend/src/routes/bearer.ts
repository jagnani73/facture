/**
 * The identity token, out of the Authorization header.
 *
 * One function, in one module, because two actors now sign in the same way — a seller at
 * `POST /v1/sellers` and a buyer at `POST /v1/buyers` — and the shape of the credential is
 * a property of how this venue reads Privy rather than of who is reading it. A second copy
 * would be a second definition of what a presented credential looks like, which is the
 * defect `units.ts` exists to prevent on the money side: *a rule only one caller can find
 * is one the next caller gets wrong.* The specific way it would go wrong here is a drifted
 * regex accepting `Bearer  token extra` on one route and refusing it on the other, so the
 * two actors would disagree about what a valid header is.
 *
 * The refusal is raised here rather than by passing a missing or malformed header through to
 * Privy, so **"you sent no credential" and "your credential did not verify" stay different
 * answers**. Handing an empty string to the verifier would collapse them into one 401 that
 * tells a caller nothing about which half to fix — and on a deployment with Privy
 * unconfigured it would collapse further still, into a 400 about missing environment
 * variables in response to a request that never carried a token at all.
 */

import { unauthorized } from '../errors.js';

export function bearerToken(header: string | undefined): string {
  const raw = header?.trim() ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(raw);
  if (!match?.[1]) {
    throw unauthorized(
      'Signing in needs a Privy identity token, presented as `Authorization: Bearer <token>`.',
    );
  }
  return match[1];
}
