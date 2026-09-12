/**
 * A party's own description of itself: what they sign, and where the venue puts it.
 *
 * ## The one route in this venue where the caller is the author
 *
 * Everywhere else the operator key writes and the venue is the party of record — `postMandate`
 * records `buyer = msg.sender` permanently, so every standing bid on the public book belongs to
 * Facture. Here the venue relays and pays, and the EIP-712 signature decides whose record lands.
 * `PartyRegistry` recovers the signer and writes *that* address, so this route cannot put words in
 * anyone's mouth even if it wanted to, and neither can a compromised one.
 *
 * That is also why the party does not need gas. A wallet made from an email address at sign-in
 * holds no HBAR, and it never needs any: signing is arithmetic, and the venue carries the
 * transaction. Proved against the deployed registry with a freshly generated key holding nothing.
 *
 * ## Sign-in and profile are separate acts, deliberately
 *
 * `POST /v1/sellers` and `POST /v1/buyers` answer *who are you* — a verified email, and the UUID
 * every other route is scoped by. They are idempotent and they mint a **provisional** name from the
 * email's domain, because Privy cannot know what a business is called and the venue requires
 * something.
 *
 * This route answers *what do you call yourself*, and it is the route CLAUDE.md has been recording
 * as absent: "the business name is derived from the email domain… correcting it needs a route that
 * can change it, which does not exist." It exists now, and the correction is stronger than a text
 * field would have been — the name the venue stores is the name the party **signed**, and the same
 * string is on a public chain where a counterparty can read it without asking us.
 *
 * ## Roles are claims, and here is where they become rows
 *
 * The bitmask a party signs says what they intend to do on this venue. It authorises nothing — the
 * registry's own header is emphatic about that, and so is `@facture/shared`'s. What it does do is
 * tell this route which venue-side records to make sure exist: a seller row, a buyer row, or both.
 * A party who signs as both gets both, because a business that sells its own receivables and funds
 * other people's is an ordinary thing to be.
 *
 * ## A chain that is down costs the public copy, not the profile
 *
 * {@link recordProfile} never throws, for the reason `publishRefusals` and `ensureMandateRegistered`
 * never throw: an unreachable node must not cost a business the act it just performed. The response
 * carries `recording.state` so the difference between "on chain" and "here only" is stated rather
 * than inferred from a missing field.
 */

import { Hono } from 'hono';
import { isAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { z } from 'zod';

import {
  MAX_DISPLAY_NAME_BYTES,
  MAX_LEGAL_NAME_BYTES,
  MAX_WEBSITE_BYTES,
  PARTY_ROLE_MASK,
  rolesFromBitmask,
} from '@facture/shared';

import { getStore, normaliseEmail } from '../db/store.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { AppEnv } from '../middleware/context.js';
import {
  getPartyRegistry,
  readProfile,
  recordProfile,
  recoverProfileSigner,
} from '../services/party-registry.js';
import { getPrivyVerifier } from '../services/privy.js';
import { readJson, readParams } from '../validate.js';
import { bearerToken } from './bearer.js';

/**
 * A cap in BYTES, which is what the contract counts.
 *
 * Zod's `.max()` compares `value.length`, and that is UTF-16 units. A thirty-character Japanese or
 * Greek business name passes a `.max(64)` at thirty and reverts on chain at ninety bytes — so the
 * venue would accept a name it knows the registry will refuse, and (before the guard below) store
 * it anyway. `packages/web/src/lib/party.ts` measures bytes correctly, so the two halves of one
 * rule disagreed and the correct half was the one a non-web client bypasses.
 *
 * The limits come from `@facture/shared` rather than being retyped, for the reason that module's
 * own header gives: a rule only one caller can find is one the next caller gets wrong.
 */
const withinBytes = (max: number) => (value: string) =>
  new TextEncoder().encode(value).length <= max;

const byteCap = (max: number) => `must be at most ${max} bytes once encoded`;

/**
 * The message, exactly as it was signed.
 *
 * Every field is carried verbatim rather than reconstructed. The signature covers these exact
 * bytes, so a server that helpfully recomputed one of them — the bitmask from a role list, say —
 * would produce a digest the signer never saw, and the contract would refuse it as somebody else's
 * signature. `@facture/shared` holds the encoders both ends use so that cannot drift.
 */
const profileUpdateBody = z.object({
  update: z.object({
    party: z.string().refine(isAddress, 'not an EVM address'),
    roles: z.number().int().min(1).max(PARTY_ROLE_MASK),
    displayName: z
      .string()
      .min(1)
      .refine(withinBytes(MAX_DISPLAY_NAME_BYTES), byteCap(MAX_DISPLAY_NAME_BYTES)),
    legalName: z.string().refine(withinBytes(MAX_LEGAL_NAME_BYTES), byteCap(MAX_LEGAL_NAME_BYTES)),
    country: z.string().regex(/^0x[0-9a-fA-F]{4}$/, 'country is a bytes2 hex string'),
    websiteUri: z.string().refine(withinBytes(MAX_WEBSITE_BYTES), byteCap(MAX_WEBSITE_BYTES)),
    metadataHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'metadataHash is a bytes32 hex string'),
    /**
     * uint64, as a decimal string — JSON has no bigint and a nonce must not round.
     *
     * Bounded as well as shaped. `/^\d+$/` alone accepts a thirty-digit nonce that `BigInt` is
     * happy to build and viem then refuses deep inside the relay, where it would be classified as
     * "Hedera did not confirm" — an outage message for an input that could never work.
     */
    nonce: z.string().regex(/^\d+$/).refine(fitsUint64, 'must fit in a uint64'),
    deadline: z.string().regex(/^\d+$/).refine(fitsUint64, 'must fit in a uint64'),
  }),
  /*
   * Exactly 65 bytes. Every other field here is bounded and this one was not, on a route that
   * spends the operator's gas — so a caller could attach megabytes of hex for the venue to pay to
   * submit. `ecrecover` takes r, s and v and nothing else.
   */
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, 'signature is 65 bytes of hex'),
});

const MAX_UINT64 = 2n ** 64n - 1n;

function fitsUint64(value: string): boolean {
  try {
    return BigInt(value) <= MAX_UINT64;
  } catch {
    return false;
  }
}

const addressParam = z.object({
  address: z.string().refine(isAddress, 'not an EVM address'),
});

export const partyRoutes = new Hono<AppEnv>();

/**
 * What a client needs before it can sign, plus whatever is already recorded.
 *
 * Public, because a profile is public: it is on a chain anyone can read, and a venue that made its
 * own copy harder to reach than the chain's would be pure friction. The nonce comes from the
 * contract rather than from a counter here — there is exactly one authority on what a signature
 * must carry, and it is the contract that will check it.
 *
 * Three states, never two. No registry wired and a node that would not answer are both
 * `checked: false`; an address that has genuinely never written a profile is `checked: true` with a
 * null profile. Folding those together would print a confident absence where there is an
 * unanswered question.
 */
partyRoutes.get('/:address', async (c) => {
  const { address } = readParams(c, addressParam);
  const registry = getPartyRegistry();
  const answer = await registry.profileOf(address as Address);

  /*
   * The nonce is only meaningful when the registry answered at all, and asking for it separately
   * would let the two disagree — a profile read from a healthy node beside a nonce that failed.
   */
  let nonce: string | null = null;
  if (answer.checked) {
    try {
      nonce = (await registry.nonceOf(address as Address)).toString(10);
    } catch (err) {
      /*
       * Logged, unlike before. `profileOf` warns when it cannot read, and this one stayed silent —
       * which left an operator investigating "nobody can publish a profile" with no server-side
       * evidence at all, for the single read that gates the entire write path.
       */
      c.get('log').warn('party registry nonce unreadable', { address, err });
      nonce = null;
    }
  }

  return c.json({
    party: {
      address,
      checked: answer.checked,
      profile: answer.checked ? answer.profile : null,
      nonce,
    },
    /*
     * The domain is published rather than assembled in the browser. It names the chain id and the
     * verifying contract, which is what makes a signature useless anywhere else — and what lets a
     * Privy wallet policy scope signing to this one contract and have the scope mean something. A
     * client that built its own could sign against a registry this venue does not read.
     */
    signing: registry.enabled
      ? { domain: registry.domain(), contractAddress: registry.address }
      : null,
  });
});

/**
 * Relay a profile the caller signed, and make the venue-side records it implies.
 *
 * The identity token is required even though the contract does not need it. The chain is safe
 * without it — only the signer's own record can ever be written — but the venue is paying for the
 * transaction and is about to write its own rows, and neither of those should be open to anyone
 * holding a signed message off the wire.
 */
partyRoutes.post('/me', async (c) => {
  const token = bearerToken(c.req.header('authorization'));
  const verified = await getPrivyVerifier().verify(token);
  const { update, signature } = await readJson(c, profileUpdateBody);

  const email = normaliseEmail(verified.email);
  if (email === '') {
    throw badRequest(
      'That sign-in verified but carried no email address, and a party is identified by email here.',
    );
  }

  /*
   * The wallet on the token against the address in the message.
   *
   * Not a security boundary — the contract is that — but a correctness one. Without it a party who
   * had signed from a wallet they have since replaced would relay successfully, write a record
   * under the old address, and have this venue rename their business on the strength of it. The two
   * halves of an identity have to be the same identity.
   */
  const wallet = verified.walletAddress;
  if (wallet === null) {
    throw badRequest(
      'That sign-in carried no wallet address, so there is no key this profile could have been ' +
        'signed by. Sign in again from the wallet you want the record to belong to.',
    );
  }
  if (wallet.toLowerCase() !== update.party.toLowerCase()) {
    throw conflict(
      'conflict',
      `This profile is signed for ${update.party}, and you are signed in as ${wallet}. A record ` +
        'belongs to the address that signed it, so the venue will not relay one for a different ' +
        'wallet than the one you hold.',
    );
  }

  /*
   * The schema bounds `roles` to 1..PARTY_ROLE_MASK, so this cannot carry an undefined bit and
   * cannot be empty. There was a refusal here for both cases and it was unreachable — a guard the
   * schema already made, with a test that appeared to cover it and was in fact asserting zod's 422.
   */
  const { roles } = rolesFromBitmask(update.roles);

  const message = {
    party: update.party as Address,
    roles: update.roles,
    displayName: update.displayName,
    legalName: update.legalName,
    country: update.country as Hex,
    websiteUri: update.websiteUri,
    metadataHash: update.metadataHash as Hex,
    nonce: BigInt(update.nonce),
    deadline: BigInt(update.deadline),
  };

  const registry = getPartyRegistry();

  /*
   * VERIFY, then relay, then write. The first step is the one that was missing.
   *
   * An earlier version relayed first and argued in a comment that the ordering protected the
   * venue's rows from a refusal. It could not: `recordProfile` never throws, so ordering a call
   * whose failure is a return value accomplishes nothing, and the upserts below ran regardless.
   * Since the contract was also the ONLY verifier, a signed-in caller could present sixty-five
   * bytes of nonsense with any name they liked, watch the chain revert, and still have the venue
   * rename their business and answer 200.
   *
   * Recovering the signer here fixes both halves at once. Authorisation stops depending on whether
   * Hedera is reachable — which is what lets the rows be written even when the relay could not be
   * confirmed — and a signature nobody produced never costs the operator a transaction.
   *
   * With no registry wired there is no domain to verify against, so the name is an authenticated
   * claim rather than a signed one. That is the honest description of that deployment and it is
   * what `recording.state === 'not-configured'` tells the caller.
   */
  const domain = registry.domain();
  if (domain !== null) {
    const signer = await recoverProfileSigner(message, signature as Hex, domain);
    if (signer === null || signer.toLowerCase() !== update.party.toLowerCase()) {
      throw badRequest(
        'That signature was not produced by this wallet for this profile, so the venue will not ' +
          'record it. Sign the details again from the account you are signed in as.',
      );
    }
  }

  const recording = await recordProfile(registry, message, signature as Hex);

  /*
   * A refusal is the chain declining a statement the venue has already verified the signature for
   * — a nonce that moved, a deadline that passed. The signature is good and the write is not, so
   * the right answer is to change nothing here and let the party sign again against a fresh nonce.
   * Writing the rows anyway is what produced a venue record no chain read would ever corroborate.
   */
  if (recording.state === 'refused') {
    return c.json({
      party: { address: update.party, roles, displayName: update.displayName.trim() },
      recording,
      sellerId: null,
      buyerId: null,
    });
  }

  const store = getStore();
  const name = update.displayName.trim();

  /*
   * The name the venue stores is the name the party signed.
   *
   * This is what closes the provisional-name gap. `provisionalName` turns an email domain into a
   * label because a sign-in has nothing better to go on; a signed profile is something better, and
   * it is the same string now sitting on a public chain. Nothing here invents a name and nothing
   * keeps a guess once the party has said otherwise.
   *
   * Written on `unavailable` as well as `recorded`, and that is deliberate: the signature was
   * checked above, so an unreachable node costs the public copy and not the act.
   */
  const seller = roles.includes('seller')
    ? await upsertSeller(store, { email, name, arcAddress: wallet })
    : null;

  const buyer = roles.includes('buyer')
    ? await upsertBuyer(store, { email, name, arcAddress: wallet })
    : null;

  return c.json({
    party: { address: update.party, roles, displayName: name },
    recording,
    sellerId: seller?.id ?? null,
    buyerId: buyer?.id ?? null,
  });
});

/**
 * The address on file must be the address signing, or nothing is written.
 *
 * `POST /v1/sellers` and `POST /v1/buyers` both refuse a sign-in whose wallet differs from the one
 * recorded, because a recorded address is where a seller expects to be paid and where a buyer's
 * deposit is drawn from. This route reached the same rows and did not make the same check: a Privy
 * account with a second linked wallet, or one that has been through recovery, could write a profile
 * under wallet B while the venue's row held wallet A — and the rename landed from a wallet the
 * venue had explicitly decided not to trust for that business.
 *
 * Worse, `lookupByAddress` keys the public join on the row's address, so that party's own profile
 * then reads back as `checked: true, profile: null`: never written one. Refusing here keeps the two
 * halves of an identity together.
 */
function refuseRebind(held: string | null, signing: string, actor: 'business' | 'desk'): void {
  if (held === null || held.toLowerCase() === signing.toLowerCase()) return;
  throw conflict(
    'conflict',
    `This ${actor} already has ${held} on file and you are signing from ${signing}. A recorded ` +
      'address is where money is sent and drawn from, so it is not rebound by writing a profile — ' +
      'and a profile written under a different wallet would not be found by anyone looking this ' +
      `${actor} up.`,
  );
}

/**
 * The seller row this profile implies, created or renamed.
 *
 * Idempotent on email exactly as `POST /v1/sellers` is, and for the same reason: email is the
 * verified identity and a business must not end up with two books. A wallet address only ever
 * fills a field that is currently null, and a different one is refused rather than ignored — see
 * {@link refuseRebind}.
 */
async function upsertSeller(
  store: ReturnType<typeof getStore>,
  input: { email: string; name: string; arcAddress: string },
) {
  const existing = await store.getSellerByEmail(input.email);
  if (existing) refuseRebind(existing.arcAddress, input.arcAddress, 'business');
  if (!existing) {
    return store.insertSeller({
      name: input.name,
      email: input.email,
      arcAddress: input.arcAddress,
      // An alias has no account id until something funds it; that is a fact about Hedera.
      hederaAccountId: null,
    });
  }

  const renamed =
    existing.name === input.name ? existing : await store.updateSellerName(existing.id, input.name);

  return existing.arcAddress === null
    ? store.updateSellerWallet(renamed.id, { arcAddress: input.arcAddress })
    : renamed;
}

/** The buyer row this profile implies. The seller comment applies unchanged. */
async function upsertBuyer(
  store: ReturnType<typeof getStore>,
  input: { email: string; name: string; arcAddress: string },
) {
  const existing = await store.getBuyerByEmail(input.email);
  if (existing) refuseRebind(existing.arcAddress, input.arcAddress, 'desk');
  if (!existing) {
    return store.insertBuyer({
      name: input.name,
      email: input.email,
      arcAddress: input.arcAddress,
      hederaAccountId: null,
      agentPolicy: null,
    });
  }

  const renamed =
    existing.name === input.name ? existing : await store.updateBuyerName(existing.id, input.name);

  return existing.arcAddress === null
    ? store.updateBuyerWallet(renamed.id, { arcAddress: input.arcAddress })
    : renamed;
}

/**
 * A venue-side party by its UUID, with whatever the chain says about the wallet on file.
 *
 * The join the screens actually need: they hold a seller or buyer UUID, and the profile is keyed by
 * an EVM address. A party with no address on file gets `checked: false` rather than an error —
 * having never connected a wallet is a normal state here, not a fault.
 */
partyRoutes.get('/by-seller/:id', async (c) => {
  const { id } = readParams(c, z.object({ id: z.uuid() }));
  const seller = await getStore().getSeller(id);
  if (!seller) throw notFound(`Seller ${id}`);

  const answer = await lookupByAddress(seller.arcAddress);
  return c.json({ party: { name: seller.name, address: seller.arcAddress, ...answer } });
});

partyRoutes.get('/by-buyer/:id', async (c) => {
  const { id } = readParams(c, z.object({ id: z.uuid() }));
  const buyer = await getStore().getBuyer(id);
  if (!buyer) throw notFound(`Buyer ${id}`);

  const answer = await lookupByAddress(buyer.arcAddress);
  return c.json({ party: { name: buyer.name, address: buyer.arcAddress, ...answer } });
});

async function lookupByAddress(address: string | null) {
  /*
   * Through `readProfile` rather than `profileOf`, so the null-address branch lives in one place
   * instead of being re-implemented here. It was exported with a nine-line header arguing the
   * three-state contract and had no caller outside its own test, which is the shape CLAUDE.md
   * tracks by the dozen.
   */
  const usable = address !== null && isAddress(address) ? (address as Address) : null;
  const answer = await readProfile(getPartyRegistry(), usable);
  return {
    checked: answer.checked,
    profile: answer.checked ? answer.profile : null,
  };
}
