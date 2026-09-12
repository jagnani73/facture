/**
 * Buyer onboarding.
 *
 * The mirror of `POST /v1/sellers`, and it exists for the same reason that one does: until
 * it did, a funding desk could only arrive through `seed.ts`. `Store.insertBuyer` carried a
 * comment saying so outright — *a funder is onboarded by hand and stated as such* — which
 * made the market's two halves unequal in a way the product argument does not allow. The
 * whole claim is that **buyers post standing quotes and any invoice is priced off the
 * resulting curve the moment it appears**; a buyer who cannot sign in is a buyer who cannot
 * post one, so every mandate in the live book belonged to a desk somebody inserted.
 *
 * Everything below is `routes/sellers.ts`'s reasoning applied to the other actor. It is
 * repeated rather than pointed at, because the two routes will be read separately and a
 * rule you have to follow a link to find is a rule the next editor of one file does not
 * know about. What is genuinely shared is shared as code: {@link bearerToken}, the verifier,
 * and `provisionalName`.
 *
 * ## The identity comes from the token, never from the body
 *
 * This route takes **no body at all**. The email and the wallet address are read out of a
 * Privy identity token presented as `Authorization: Bearer <token>` and verified against
 * Privy's signature, so what the venue records is what Privy attested rather than what a
 * caller typed. It matters at least as much here as on the seller side: a mandate is a
 * standing commitment of capital, and a desk's identity is what a refusal receipt, an
 * exposure ladder and an on-chain `postMandate` are all scoped by.
 *
 * With no Privy credentials configured the route refuses and says so, in the same shape as
 * issuance with no ATS factory. Accepting an unverified email so that sign-in still "works"
 * would be reachable only on the deployments that had forgotten to configure it, which is
 * the worst possible place for it.
 *
 * ## Email is the identity, so this is idempotent on it
 *
 * `buyers.email` carries a unique index (`buyers_email_key`, since `0000_init.sql`), and the
 * email is a verified fact. So a repeat call is a sign-in, not a duplicate: the existing row
 * comes back with `200`, a new one is created with `201`. The failure this prevents is
 * sharper on the buyer side than the seller side. A second row for one desk is a second
 * empty set of mandates — so the desk's capital, its committed exposure and its per-debtor
 * concentration caps would all still be attached to the first row while it appeared to have
 * none, and the venue would happily let it commit the same money twice under the new id.
 *
 * ## A wallet address is recorded once and never rebound
 *
 * A verified token proves who signed in; it does not prove that the wallet now attached to
 * that account is the one this desk's capital comes from. Account recovery, a linked second
 * wallet, or a compromised inbox all produce a valid token carrying a different address.
 *
 * The direction of the money is the opposite of a seller's and the rule is the same.
 * `MandateVault.deposit` pulls from `msg.sender`, and `ArcEscrow.buyerOf` binds a mandate to
 * one address **permanently and one-shot**. So a silently rebound address does not redirect
 * a payment — it desynchronises the venue's record of who funds a mandate from the chain's,
 * and the symptom is a mandate that reads as unfunded while its USDC sits in the vault under
 * a binding nothing here can correct. An address therefore only ever fills a field that is
 * currently null: the same address again is a no-op, a different one is a `409`.
 *
 * ## What is deliberately NOT here: the seller wallet policy
 *
 * `routes/sellers.ts` attaches a Privy policy at sign-in, and the obvious thing to do is
 * copy that call. **It would be the wrong policy.** `sellerWalletPolicySpec` permits exactly
 * two things, and a buyer does neither. `claim` on `DvpEscrow` collects a **seller's** payout
 * out of an Arc-rail sale — it checks `msg.sender == beneficiary` and the beneficiary is the
 * seller. The other is signing a `PartyRegistry` profile, which a buyer genuinely may want to
 * do, and its rule would still have to arrive as part of a policy built for a buyer's wallet
 * rather than borrowed from a seller's. What a buyer's wallet does that a seller's never does
 * is fund a mandate, which is `approve` plus `MandateVault.deposit`.
 *
 * Attaching the seller policy to a buyer's wallet would be worse than attaching nothing,
 * because Privy denies by default: the wallet would hold permission for a call it can never
 * legitimately make, and be denied the one it exists to make. That is the README-role-hash
 * trap this codebase has already paid for once — *a grant that succeeds and authorises
 * nothing*.
 *
 * **A buyer-side policy is a separate piece of work**, and a real one: it has to name a
 * different contract, a different function pair, and a spending bound that Privy can
 * actually evaluate. Until it is written, a buyer's wallet is unscoped and this file says so
 * rather than implying otherwise by attaching something that looks like a control.
 *
 * ## The two address fields are not the same kind of thing
 *
 * `arcAddress` is an ordinary EVM address: valid on Arc the moment it exists. A Hedera
 * `hederaAccountId` is a `0.0.x`, and a freshly made wallet does not have one — what it has
 * is an *alias* derived from its public key, and Hedera creates the account behind that
 * alias when it is first funded. So a buyer holding a perfectly good address with no account
 * id is the normal state, and the absence is a fact about Hedera rather than a gap in the
 * record. It bites here specifically: the x402 cash rail needs a Hedera key, which is why
 * six of seven live mandates cannot settle that way.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { getStore, normaliseEmail } from '../db/store.js';
import { conflict, notFound, unauthorized } from '../errors.js';
import type { AppEnv } from '../middleware/context.js';
import { getPrivyVerifier, provisionalName } from '../services/privy.js';
import { readParams } from '../validate.js';
import { wireBuyer } from '../wire.js';
import { bearerToken } from './bearer.js';

const uuidParam = z.object({ id: z.uuid() });

export const buyerRoutes = new Hono<AppEnv>();

buyerRoutes.post('/', async (c) => {
  const token = bearerToken(c.req.header('authorization'));
  /*
   * `VerifiedSeller` is the verifier's return type and it is named for the actor it was
   * written for, not for the only actor it can describe. It carries an email, a wallet
   * address, a wallet id and Privy's DID — nothing seller-shaped — so it is reused rather
   * than duplicated under a second name. Two structurally identical types would be two
   * places to add a field to, and only one of them would get it.
   */
  const verified = await getPrivyVerifier().verify(token);
  const store = getStore();

  /*
   * Checked again here, and not because the verifier is untrusted.
   *
   * `VerifiedSeller.email` is typed as a `string`, so an empty one satisfies the compiler
   * while being unusable: it is the unique key this table is built on, and a row carrying it
   * would claim the identity of every other emailless buyer. The real verifier refuses it
   * already. This is the assertion that stops any future verifier — a different provider, a
   * fake in a test that has drifted — from being able to insert one at all. It lives in the
   * route rather than only in the verifier for exactly that reason; the seller side found
   * this guard living in one place when it needed to be in two.
   */
  const email = normaliseEmail(verified.email);
  if (email === '') {
    throw unauthorized(
      'That sign-in verified but carried no email address, and a buyer is identified by ' +
        'email here.',
    );
  }

  const existing = await store.getBuyerByEmail(email);
  if (!existing) {
    const created = await store.insertBuyer({
      name: provisionalName(email),
      email,
      arcAddress: verified.walletAddress,
      // An alias has no account id until something funds it. See the module note.
      hederaAccountId: null,
      /*
       * A desk that arrived by a person signing in with an email is a human desk. The column
       * marks an agent-operated one and is left null here deliberately: fake liquidity is
       * the one thing that would undo the whole argument, so an agent is never disguised as
       * a human — and, just as much, a human is never labelled an agent by a route that
       * cannot know.
       */
      agentPolicy: null,
    });
    return c.json({ buyer: wireBuyer(created), created: true }, 201);
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
      'This desk already has a wallet address on file, and it is not the one this sign-in ' +
        'carried. A recorded address is where a buyer funds mandates from, and the vault ' +
        'binds a mandate to it permanently, so it is not changed by signing in again.',
    );
  }

  const buyer =
    offered !== null && held === null
      ? await store.updateBuyerWallet(existing.id, { arcAddress: offered })
      : existing;

  return c.json({ buyer: wireBuyer(buyer), created: false }, 200);
});

buyerRoutes.get('/:id', async (c) => {
  const { id } = readParams(c, uuidParam);
  const buyer = await getStore().getBuyer(id);
  if (!buyer) throw notFound(`Buyer ${id}`);
  return c.json({ buyer: wireBuyer(buyer) }, 200);
});
