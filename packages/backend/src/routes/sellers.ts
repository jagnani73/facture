/**
 * Seller onboarding.
 *
 * The one route a business needs before it has a book: present a verified identity and get
 * back the id every other seller-side route is scoped by. Until this existed a seller could
 * only arrive through `seed.ts`, which meant the product's opening claim — *a seller connects
 * a wallet, or has one made from an email address* — was true of the argument and not of the
 * build.
 *
 * ## The identity comes from the token, never from the body
 *
 * This route takes **no body at all**. The email and the wallet address are read out of a
 * Privy identity token presented as `Authorization: Bearer <token>` and verified against
 * Privy's signature, so what the venue records is what Privy attested rather than what a
 * caller typed. The first version of this route did read them from a body, and anyone could
 * have claimed any business's email address.
 *
 * With no Privy credentials configured the route refuses and says so, in the same shape as
 * issuance with no ATS factory. Accepting an unverified email so that sign-in still "works"
 * is the exact behaviour being removed here, and it would be reachable only on the
 * deployments that had forgotten to configure it.
 *
 * ## Email is the identity, so this is idempotent on it
 *
 * `sellers.email` carries a unique index, and the email is now a verified fact. So a repeat
 * call is a sign-in, not a duplicate: the existing row comes back with `200`, a new one is
 * created with `201`, and a business cannot end up with two books.
 *
 * ## A wallet address is recorded once and never rebound
 *
 * A verified token proves who signed in; it does not prove that the wallet now attached to
 * that account is the one the business expects to be paid at. Account recovery, a linked
 * second wallet, or a compromised inbox all produce a valid token carrying a different
 * address. Since a recorded address is where a seller's money is expected to go, an address
 * only ever fills a field that is currently null: the same address again is a no-op, and a
 * different one is a `409` rather than a silent rebind. Changing it deliberately needs a
 * route that says that is what it is doing.
 *
 * ## The two address fields are not the same kind of thing
 *
 * `arcAddress` is an ordinary EVM address: valid on Arc the moment it exists. A Hedera
 * `hederaAccountId` is a `0.0.x`, and a freshly made wallet does not have one — what it has
 * is an *alias* derived from its public key, and Hedera creates the account behind that alias
 * when it is first funded. So a seller holding a perfectly good address with no account id is
 * the normal state, and the absence is a fact about Hedera rather than a gap in the record.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { getStore } from '../db/store.js';
import { conflict, notFound, unauthorized } from '../errors.js';
import type { AppEnv } from '../middleware/context.js';
import { getPrivyVerifier, provisionalName } from '../services/privy.js';
import { readParams } from '../validate.js';
import { wireSeller } from '../wire.js';

const uuidParam = z.object({ id: z.uuid() });

/**
 * The identity token, out of the Authorization header.
 *
 * Rejected here rather than passed to Privy when it is missing or malformed, so "you sent no
 * credential" and "your credential did not verify" stay different answers.
 */
function bearerToken(header: string | undefined): string {
  const raw = header?.trim() ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(raw);
  if (!match?.[1]) {
    throw unauthorized(
      'Signing in needs a Privy identity token, presented as `Authorization: Bearer <token>`.',
    );
  }
  return match[1];
}

export const sellerRoutes = new Hono<AppEnv>();

sellerRoutes.post('/', async (c) => {
  const token = bearerToken(c.req.header('authorization'));
  const verified = await getPrivyVerifier().verify(token);
  const store = getStore();

  /*
   * Checked again here, and not because the verifier is untrusted.
   *
   * `VerifiedSeller.email` is typed as a `string`, so an empty one satisfies the compiler
   * while being unusable: it is the unique key this table is built on, and a row carrying it
   * would claim the identity of every other emailless seller. The real verifier refuses it
   * already. This is the assertion that stops any future verifier — a different provider, a
   * fake in a test that has drifted — from being able to insert one at all.
   */
  const email = verified.email.trim().toLowerCase();
  if (email === '') {
    throw unauthorized(
      'That sign-in verified but carried no email address, and a seller is identified by ' +
        'email here.',
    );
  }

  const existing = await store.getSellerByEmail(email);
  if (!existing) {
    const created = await store.insertSeller({
      name: provisionalName(email),
      email,
      arcAddress: verified.walletAddress,
      // An alias has no account id until something funds it. See the module note.
      hederaAccountId: null,
    });
    return c.json({ seller: wireSeller(created), created: true }, 201);
  }

  /*
   * Fill what is missing, refuse what would move. A token with no wallet on it says nothing
   * about the address on file and must not be read as an instruction to clear it.
   */
  const offered = verified.walletAddress;
  const held = existing.arcAddress;

  if (offered !== null && held !== null && held.toLowerCase() !== offered.toLowerCase()) {
    throw conflict(
      'conflict',
      'This business already has a wallet address on file, and it is not the one this ' +
        'sign-in carried. A recorded address is where a seller expects to be paid, so it is ' +
        'not changed by signing in again.',
    );
  }

  const seller =
    offered !== null && held === null
      ? await store.updateSellerWallet(existing.id, { arcAddress: offered })
      : existing;

  return c.json({ seller: wireSeller(seller), created: false }, 200);
});

sellerRoutes.get('/:id', async (c) => {
  const { id } = readParams(c, uuidParam);
  const seller = await getStore().getSeller(id);
  if (!seller) throw notFound(`Seller ${id}`);
  return c.json({ seller: wireSeller(seller) }, 200);
});
