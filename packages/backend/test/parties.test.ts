/**
 * `POST /v1/parties/me` — the one route where the caller is the author.
 *
 * Everywhere else the venue writes and the venue is the party of record. Here it relays and pays,
 * and the record belongs to whoever signed. Three things have to hold, and the first two were both
 * broken when this route first shipped:
 *
 *   - **The venue verifies the signature itself.** The contract used to be the only verifier, so a
 *     signed-in caller could present sixty-five bytes of nonsense with any name they liked, watch
 *     the chain revert, and still have the venue rename their business and answer 200.
 *   - **A refusal writes nothing.** `recordProfile` never throws, so ordering the chain call first
 *     protected nothing; the upserts ran on all four states.
 *   - **A chain that is down still costs nothing but the public copy.** That part was right, and
 *     must stay right now that the other two are guarded.
 *
 * Every signature below is real. They were `'ab'.repeat(65)` against a fake that accepted anything,
 * which is precisely why the missing verification was invisible here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { partyRegistryDomain, PROFILE_UPDATE_TYPES, rolesToBitmask } from '@facture/shared';

import { call, createHarness, signedIn, stubPrivy, type Harness } from './helpers.js';
import {
  createDisabledPartyRegistry,
  setPartyRegistry,
  RegistryRefusal,
  type PartyRegistry,
} from '../src/services/party-registry.js';
import { setPrivyVerifier } from '../src/services/privy.js';

const REGISTRY = '0x1C9882714e1ae2555531E1a7eb4E83EBeCA8B2ca' as Address;
const DOMAIN = partyRegistryDomain(296, REGISTRY);

/** The party. A fixed key, so the address is stable across runs and can be seeded against. */
const PARTY = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

/** Somebody else entirely, for the forgery and rebind cases. */
const STRANGER = privateKeyToAccount(
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
);

/** The email `stubPrivy()` attests by default. */
const SIGNED_IN_EMAIL = 'ada@meridian.example';

interface Fields {
  party: Address;
  roles: number;
  displayName: string;
  legalName: string;
  country: Hex;
  websiteUri: string;
  metadataHash: Hex;
  nonce: bigint;
  deadline: bigint;
}

const fields = (overrides: Partial<Fields> = {}): Fields => ({
  party: PARTY.address,
  roles: rolesToBitmask(['seller']),
  displayName: 'Meridian Fabrication',
  legalName: '',
  country: '0x4742',
  websiteUri: '',
  metadataHash: `0x${'00'.repeat(32)}`,
  nonce: 0n,
  deadline: 9_999_999_999n,
  ...overrides,
});

/** The wire shape: uint64s as decimal strings, because JSON has no bigint. */
const onTheWire = (f: Fields) => ({
  ...f,
  nonce: f.nonce.toString(10),
  deadline: f.deadline.toString(10),
});

/** A genuinely signed body, which is what the route now requires. */
async function signedBody(overrides: Partial<Fields> = {}, signer = PARTY) {
  const f = fields(overrides);
  const signature = await signer.signTypedData({
    domain: DOMAIN,
    types: PROFILE_UPDATE_TYPES,
    primaryType: 'ProfileUpdate',
    message: f,
  });
  return { update: onTheWire(f), signature };
}

function recordingRegistry(relay?: PartyRegistry['relay']): {
  registry: PartyRegistry;
  seen: { parties: string[] };
} {
  const seen = { parties: [] as string[] };
  const registry: PartyRegistry = {
    enabled: true,
    address: REGISTRY,
    domain: () => DOMAIN,
    nonceOf: () => Promise.resolve(0n),
    profileOf: () => Promise.resolve({ checked: true, profile: null }),
    relay:
      relay ??
      ((update) => {
        seen.parties.push(update.party);
        return Promise.resolve({ transactionHash: '0xfeed' });
      }),
  };
  return { registry, seen };
}

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
  // The token's wallet must be the address that signs, or the route refuses before verifying.
  setPrivyVerifier(stubPrivy({ walletAddress: PARTY.address }));
});

afterEach(() => {
  setPartyRegistry(undefined);
  h.restore();
});

describe('POST /v1/parties/me', () => {
  it('relays the signed profile and opens the rows the roles imply', async () => {
    const { registry, seen } = recordingRegistry();
    setPartyRegistry(registry);

    const res = await call(h.app, 'POST', '/v1/parties/me', {
      headers: signedIn(),
      body: await signedBody(),
    });

    expect(res.status).toBe(200);
    expect(seen.parties).toEqual([PARTY.address]);
    expect(res.body.recording).toMatchObject({ state: 'recorded', transactionHash: '0xfeed' });
    expect(res.body.sellerId).toEqual(expect.any(String));
    // A seller-only profile opens no desk. Roles decide which records exist.
    expect(res.body.buyerId).toBeNull();
  });

  /**
   * The name the venue stores is the name the party signed.
   *
   * This is what closes the provisional-name gap: `provisionalName` turns an email domain into a
   * label because a sign-in has nothing better to go on, and a signed profile is something better.
   */
  it('stores the signed name rather than the one guessed from the email domain', async () => {
    setPartyRegistry(recordingRegistry().registry);

    await call(h.app, 'POST', '/v1/parties/me', {
      headers: signedIn(),
      body: await signedBody({ displayName: 'Meridian Fabrication' }),
    });

    const seller = await h.store.getSellerByEmail(SIGNED_IN_EMAIL);
    expect(seller?.name).toBe('Meridian Fabrication');

    // A correction replaces it, because a name is a label whose authority is the signature behind
    // it — unlike a wallet address, which is never rebound.
    await call(h.app, 'POST', '/v1/parties/me', {
      headers: signedIn(),
      body: await signedBody({ displayName: 'Meridian Fabrication & Co', nonce: 1n }),
    });

    const renamed = await h.store.getSellerByEmail(SIGNED_IN_EMAIL);
    expect(renamed?.name).toBe('Meridian Fabrication & Co');
    expect(renamed?.id).toBe(seller?.id);
  });

  it('opens both records when a party claims both roles', async () => {
    setPartyRegistry(recordingRegistry().registry);

    const res = await call(h.app, 'POST', '/v1/parties/me', {
      headers: signedIn(),
      body: await signedBody({ roles: rolesToBitmask(['seller', 'buyer']) }),
    });

    expect(res.status).toBe(200);
    expect(res.body.sellerId).toEqual(expect.any(String));
    expect(res.body.buyerId).toEqual(expect.any(String));
  });

  /* ---------------------------------------------------------------------- */
  /* The signature is the authorisation                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * The hole this route shipped with.
   *
   * The contract was the only verifier, so nonsense reverted on chain and the venue renamed the
   * business anyway. The relay must not even be attempted: a signature nobody produced should cost
   * the operator no gas at all.
   */
  it('refuses a signature nobody produced, and does not relay it', async () => {
    const { registry, seen } = recordingRegistry();
    setPartyRegistry(registry);

    const res = await call(h.app, 'POST', '/v1/parties/me', {
      headers: signedIn(),
      body: { update: onTheWire(fields()), signature: `0x${'ab'.repeat(65)}` },
    });

    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/was not produced by this wallet/);
    expect(seen.parties).toEqual([]);
    expect(await h.store.getSellerByEmail(SIGNED_IN_EMAIL)).toBeNull();
  });

  /** A real signature over a different message. Valid bytes, wrong statement. */
  it('refuses a signature whose contents were altered afterwards', async () => {
    const { registry, seen } = recordingRegistry();
    setPartyRegistry(registry);

    const signed = await signedBody();
    const res = await call(h.app, 'POST', '/v1/parties/me', {
      headers: signedIn(),
      body: {
        update: { ...signed.update, displayName: 'Northwind Traders' },
        signature: signed.signature,
      },
    });

    expect(res.status).toBe(400);
    expect(seen.parties).toEqual([]);
  });

  /** Signed by a different key for this party's own address. */
  it('refuses a signature from a key that is not the party', async () => {
    const { registry, seen } = recordingRegistry();
    setPartyRegistry(registry);

    const res = await call(h.app, 'POST', '/v1/parties/me', {
      headers: signedIn(),
      body: await signedBody({}, STRANGER),
    });

    expect(res.status).toBe(400);
    expect(seen.parties).toEqual([]);
  });

  /* ---------------------------------------------------------------------- */
  /* Identity                                                                */
  /* ---------------------------------------------------------------------- */

  it('refuses to relay a profile for a wallet the caller is not signed in as', async () => {
    setPartyRegistry(recordingRegistry().registry);

    const res = await call(h.app, 'POST', '/v1/parties/me', {
      headers: signedIn(),
      body: await signedBody({ party: STRANGER.address }, STRANGER),
    });

    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/belongs to the address that signed it/);
  });

  it('refuses when the sign-in carried no wallet at all', async () => {
    setPartyRegistry(recordingRegistry().registry);
    setPrivyVerifier(stubPrivy({ walletAddress: null }));

    const res = await call(h.app, 'POST', '/v1/parties/me', {
      headers: signedIn(),
      body: await signedBody(),
    });

    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/no wallet address/);
  });

  it('needs a credential', async () => {
    setPartyRegistry(recordingRegistry().registry);

    const res = await call(h.app, 'POST', '/v1/parties/me', { body: await signedBody() });
    expect(res.status).toBe(401);
  });

  /**
   * `POST /v1/sellers` refuses a sign-in whose wallet differs from the one on file. This route
   * reached the same rows and did not make the same check, so a second linked wallet could rename
   * a business the venue had decided not to trust it for — and the profile would then be written
   * under an address the public join does not look up.
   */
  it('refuses to write against a business whose wallet on file is a different one', async () => {
    setPartyRegistry(recordingRegistry().registry);
    await h.store.insertSeller({
      name: 'Meridian Fabrication',
      email: SIGNED_IN_EMAIL,
      arcAddress: STRANGER.address,
      hederaAccountId: null,
    });

    const res = await call(h.app, 'POST', '/v1/parties/me', {
      headers: signedIn(),
      body: await signedBody(),
    });

    expect(res.status).toBe(409);
    const seller = await h.store.getSellerByEmail(SIGNED_IN_EMAIL);
    expect(seller?.arcAddress).toBe(STRANGER.address);
    expect(seller?.name).toBe('Meridian Fabrication');
  });

  /* ---------------------------------------------------------------------- */
  /* What the chain says, and what it costs                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * A node that would not answer costs the public copy and nothing else. The signature was already
   * verified, so there is no reason to lose an edit the party has made.
   */
  it('saves the profile even when the chain could not be reached', async () => {
    const { registry } = recordingRegistry(() => Promise.reject(new Error('fetch failed')));
    setPartyRegistry(registry);

    const res = await call(h.app, 'POST', '/v1/parties/me', {
      headers: signedIn(),
      body: await signedBody(),
    });

    expect(res.status).toBe(200);
    expect(res.body.recording).toMatchObject({ state: 'unavailable', transactionHash: null });
    expect(res.body.sellerId).toEqual(expect.any(String));

    const seller = await h.store.getSellerByEmail(SIGNED_IN_EMAIL);
    expect(seller?.name).toBe('Meridian Fabrication');
  });

  /**
   * A refusal writes nothing, and this is the test whose absence let the original defect ship.
   *
   * The chain declining a statement the venue verified means the nonce moved or the deadline
   * passed. The signature is good and the write is not, so the right answer is to change nothing
   * and let the party sign again — not to store a name no chain read will ever corroborate.
   */
  it('writes no rows when the chain refuses', async () => {
    const { registry } = recordingRegistry(() =>
      Promise.reject(new RegistryRefusal('the registry refused it', '0xdead')),
    );
    setPartyRegistry(registry);

    const res = await call(h.app, 'POST', '/v1/parties/me', {
      headers: signedIn(),
      body: await signedBody(),
    });

    expect(res.status).toBe(200);
    expect(res.body.recording).toMatchObject({ state: 'refused', transactionHash: '0xdead' });
    expect(res.body.sellerId).toBeNull();
    expect(res.body.buyerId).toBeNull();

    expect(await h.store.getSellerByEmail(SIGNED_IN_EMAIL)).toBeNull();
  });

  /**
   * A deployment with no registry has no domain to verify against, so the name is an authenticated
   * claim rather than a signed one — which is exactly what `not-configured` tells the caller.
   */
  it('works on a deployment with no registry, and says so', async () => {
    setPartyRegistry(createDisabledPartyRegistry());

    const res = await call(h.app, 'POST', '/v1/parties/me', {
      headers: signedIn(),
      body: await signedBody(),
    });

    expect(res.status).toBe(200);
    expect(res.body.recording).toMatchObject({ state: 'not-configured' });
    expect(res.body.sellerId).toEqual(expect.any(String));
  });

  /* ---------------------------------------------------------------------- */
  /* What the schema refuses                                                 */
  /* ---------------------------------------------------------------------- */

  it('refuses a roles bitmask outside the range this venue defines', async () => {
    setPartyRegistry(recordingRegistry().registry);

    const res = await call(h.app, 'POST', '/v1/parties/me', {
      headers: signedIn(),
      body: { update: onTheWire(fields({ roles: 5 })), signature: `0x${'ab'.repeat(65)}` },
    });

    // Zod's bound, not a hand-written guard — there used to be an unreachable one underneath it.
    expect(res.status).toBe(422);
  });

  /**
   * The caps are in BYTES because the contract counts bytes. Thirty-three Greek characters is
   * sixty-six bytes: comfortably inside a `.max(64)` on string length, and over the contract's cap.
   */
  it('measures the name cap in bytes rather than characters', async () => {
    setPartyRegistry(recordingRegistry().registry);
    const greek = 'α'.repeat(33);
    expect(greek.length).toBeLessThan(64);

    const res = await call(h.app, 'POST', '/v1/parties/me', {
      headers: signedIn(),
      body: {
        update: onTheWire(fields({ displayName: greek })),
        signature: `0x${'ab'.repeat(65)}`,
      },
    });

    expect(res.status).toBe(422);
  });

  /** 65 bytes, because `ecrecover` takes r, s and v. This route spends the operator's gas. */
  it('refuses a signature that is not 65 bytes', async () => {
    setPartyRegistry(recordingRegistry().registry);

    const res = await call(h.app, 'POST', '/v1/parties/me', {
      headers: signedIn(),
      body: { update: onTheWire(fields()), signature: `0x${'ab'.repeat(400)}` },
    });

    expect(res.status).toBe(422);
  });

  /** A nonce past uint64 would be refused by viem deep inside the relay, reported as an outage. */
  it('refuses a nonce that cannot fit in a uint64', async () => {
    setPartyRegistry(recordingRegistry().registry);

    const res = await call(h.app, 'POST', '/v1/parties/me', {
      headers: signedIn(),
      body: {
        update: { ...onTheWire(fields()), nonce: '99999999999999999999999999' },
        signature: `0x${'ab'.repeat(65)}`,
      },
    });

    expect(res.status).toBe(422);
  });
});

describe('GET /v1/parties/:address', () => {
  it('publishes the domain a client must sign against', async () => {
    setPartyRegistry(recordingRegistry().registry);

    const res = await call(h.app, 'GET', `/v1/parties/${PARTY.address}`);

    expect(res.status).toBe(200);
    expect(res.body.signing).toMatchObject({
      contractAddress: REGISTRY,
      domain: { name: 'Facture Party Registry', version: '1', chainId: 296 },
    });
    // Lowercased, because the Privy wallet policy compares it as a string. Digest-neutral.
    expect(
      (res.body.signing as { domain: { verifyingContract: string } }).domain.verifyingContract,
    ).toBe(REGISTRY.toLowerCase());
  });

  /**
   * Three states, never two. A node that would not answer is not an address without a profile, and
   * printing the second where the first is true is a confident absence nobody established.
   */
  it('separates never-written from could-not-ask', async () => {
    const { registry } = recordingRegistry();
    setPartyRegistry({
      ...registry,
      profileOf: () => Promise.resolve({ checked: true, profile: null }),
    });

    const written = await call(h.app, 'GET', `/v1/parties/${PARTY.address}`);
    expect(written.body.party).toMatchObject({ checked: true, profile: null });

    setPartyRegistry({ ...registry, profileOf: () => Promise.resolve({ checked: false }) });
    const unread = await call(h.app, 'GET', `/v1/parties/${PARTY.address}`);
    expect(unread.body.party).toMatchObject({ checked: false, profile: null, nonce: null });
  });

  /** A nonce the node would not give is null beside a profile it did, and is logged rather than silent. */
  it('answers a null nonce when the profile read succeeded and the nonce did not', async () => {
    const { registry } = recordingRegistry();
    setPartyRegistry({ ...registry, nonceOf: () => Promise.reject(new Error('node down')) });

    const res = await call(h.app, 'GET', `/v1/parties/${PARTY.address}`);
    expect(res.body.party).toMatchObject({ checked: true, nonce: null });
  });

  it('offers no domain when no registry is wired', async () => {
    setPartyRegistry(createDisabledPartyRegistry());

    const res = await call(h.app, 'GET', `/v1/parties/${PARTY.address}`);
    expect(res.status).toBe(200);
    expect(res.body.signing).toBeNull();
  });

  it('refuses something that is not an address', async () => {
    setPartyRegistry(recordingRegistry().registry);
    const res = await call(h.app, 'GET', '/v1/parties/not-an-address');
    expect(res.status).toBe(422);
  });
});

describe('GET /v1/parties/by-seller/:id', () => {
  /**
   * The join the screens need: they hold a UUID, and a profile is keyed by an address. The venue's
   * own name comes back beside the chain's, because it exists even when no profile does — which is
   * the whole reason `/book` could say "Your business" for so long.
   */
  it('answers the venue name beside whatever the chain says', async () => {
    setPartyRegistry(recordingRegistry().registry);
    const seeded = await h.store.getSeller(h.seeded.sellerId);

    const res = await call(h.app, 'GET', `/v1/parties/by-seller/${h.seeded.sellerId}`);

    expect(res.status).toBe(200);
    expect(res.body.party).toMatchObject({ name: seeded?.name });
  });

  /** Never having connected a wallet is a normal state, not a fault, and must not read as one. */
  it('reports a party with no address as unchecked rather than as an error', async () => {
    setPartyRegistry(recordingRegistry().registry);
    const seller = await h.store.insertSeller({
      name: 'Walletless Ltd',
      email: 'ops@walletless.example',
      arcAddress: null,
      hederaAccountId: null,
    });

    const res = await call(h.app, 'GET', `/v1/parties/by-seller/${seller.id}`);

    expect(res.status).toBe(200);
    expect(res.body.party).toMatchObject({ name: 'Walletless Ltd', checked: false, profile: null });
  });

  it('404s an unknown seller', async () => {
    setPartyRegistry(recordingRegistry().registry);
    const res = await call(
      h.app,
      'GET',
      '/v1/parties/by-seller/00000000-0000-4000-8000-000000000000',
    );
    expect(res.status).toBe(404);
  });
});
