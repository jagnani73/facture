/**
 * What a party says about itself, and who is allowed to say it.
 *
 * `PartyRegistry` is the only contract this venue writes to where the venue is not the author.
 * Everywhere else the operator key is the party of record — `postMandate` sets
 * `buyer = msg.sender` permanently, so every standing bid on the public book belongs to Facture
 * rather than to the funder whose capital backs it. The contract itself enforces the difference;
 * what these tests guard is the layer above it, where two rules matter more than the happy path.
 *
 * **A chain that is down must never cost a party their profile.** Writing or correcting what your
 * business is called is an act that has effectively already happened by the time the relay runs,
 * and returning an error because a node was unreachable would lose it for no reason. So
 * `recordProfile` never throws, and says in a `state` what actually happened.
 *
 * **And it must never stay quiet about it.** A profile the venue believes is public and is not
 * would be a claim on a proof screen with nothing behind it — the same overclaim `escrowVerified`
 * made when it told every buyer the capital was escrowed and nothing had checked.
 */

import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';

import { partyRegistryDomain, rolesToBitmask, type ProfileUpdateMessage } from '@facture/shared';

import {
  createDisabledPartyRegistry,
  readProfile,
  recordProfile,
  RegistryRefusal,
  type PartyRegistry,
} from '../src/services/party-registry.js';

/** The registry this venue actually deployed, on Hedera testnet. */
const REGISTRY_ADDRESS = '0x1C9882714e1ae2555531E1a7eb4E83EBeCA8B2ca' as Address;
const PARTY = '0xe52553bd1b0D869b9310E2Ff04a8F5DC58dcE324' as Address;
const SIGNATURE = `0x${'ab'.repeat(65)}` as Hex;

const update = (overrides: Partial<ProfileUpdateMessage> = {}): ProfileUpdateMessage => ({
  party: PARTY,
  roles: rolesToBitmask(['seller']),
  displayName: 'Meridian Fabrication',
  legalName: '',
  country: '0x4742',
  websiteUri: '',
  metadataHash: `0x${'00'.repeat(32)}` as Hex,
  nonce: 0n,
  deadline: 9_999_999_999n,
  ...overrides,
});

/** A registry whose behaviour each test chooses, so the orchestration can be exercised alone. */
function fakeRegistry(behaviour: Partial<PartyRegistry> = {}): PartyRegistry {
  return {
    enabled: true,
    address: REGISTRY_ADDRESS,
    domain: () => partyRegistryDomain(296, REGISTRY_ADDRESS),
    nonceOf: () => Promise.resolve(0n),
    profileOf: () => Promise.resolve({ checked: true, profile: null }),
    relay: () => Promise.resolve({ transactionHash: '0xfeed' }),
    ...behaviour,
  };
}

describe('recording a profile', () => {
  it('reports the transaction when the chain took it', async () => {
    const recording = await recordProfile(fakeRegistry(), update(), SIGNATURE);

    expect(recording.state).toBe('recorded');
    expect(recording.transactionHash).toBe('0xfeed');
  });

  /**
   * The rule, stated as a test. An unreachable node costs the public copy and nothing else, and the
   * sentence has to tell the party that rather than leaving them to guess whether they lost the
   * edit they just made.
   */
  it('never throws when the node is unreachable, and says the profile survived', async () => {
    const recording = await recordProfile(
      fakeRegistry({ relay: () => Promise.reject(new Error('fetch failed')) }),
      update(),
      SIGNATURE,
    );

    expect(recording.state).toBe('unavailable');
    expect(recording.transactionHash).toBeNull();
    expect(recording.detail).toMatch(/saved here/);
    expect(recording.detail).toMatch(/nothing was lost/i);
  });

  /**
   * A revert and an unreachable node are different problems with different fixes, and only one of
   * them is the party's to act on. Collapsing them would send somebody to check their connection
   * when what they actually need is to sign again.
   *
   * The discriminant is the TYPE. This test used to construct the refusal sentence by hand and
   * assert the classifier matched it, so both halves of one contract were compared against
   * independent copies of a string — rewording the prose would have reclassified every refusal as
   * an outage with the suite still green. `party-registry-encoding.test.ts` carries the cases that
   * pin the coupling itself, including an ordinary error quoting the old sentinel verbatim.
   */
  it('separates a refusal from an outage', async () => {
    const recording = await recordProfile(
      fakeRegistry({
        relay: () => Promise.reject(new RegistryRefusal('however this is worded', '0x1')),
      }),
      update(),
      SIGNATURE,
    );

    expect(recording.state).toBe('refused');
    expect(recording.transactionHash).toBe('0x1');
  });

  /**
   * Not configured is its own answer. A deployment with no registry wired has not failed at
   * anything, and rendering it as an outage would send an operator looking for a broken node.
   */
  it('reports a deployment with no registry as exactly that', async () => {
    const recording = await recordProfile(createDisabledPartyRegistry(), update(), SIGNATURE);

    expect(recording.state).toBe('not-configured');
    expect(recording.transactionHash).toBeNull();
    expect(recording.detail).toMatch(/cannot be checked against a chain/);
  });
});

describe('reading a profile', () => {
  /**
   * Three states, never two. "No registry configured", "the node would not answer" and "this
   * address has never written a profile" are different facts, and folding the first two into the
   * third prints a confident absence where there is an unanswered question. The same mistake as
   * the `/health` cursor and `ComplianceDecision.determinate`.
   */
  it('distinguishes never-written from could-not-ask', async () => {
    const written = await readProfile(fakeRegistry(), PARTY);
    expect(written).toEqual({ checked: true, profile: null });

    const unread = await readProfile(
      fakeRegistry({ profileOf: () => Promise.resolve({ checked: false }) }),
      PARTY,
    );
    expect(unread).toEqual({ checked: false });
  });

  /** A party with no wallet on file has not failed a read — there was nothing to read. */
  it('treats a party with no address as unchecked rather than absent', async () => {
    expect(await readProfile(fakeRegistry(), null)).toEqual({ checked: false });
  });

  it('answers unchecked when no registry is wired', async () => {
    expect(await readProfile(createDisabledPartyRegistry(), PARTY)).toEqual({ checked: false });
  });
});

describe('a deployment with no registry', () => {
  const disabled = createDisabledPartyRegistry();

  it('offers no domain to sign against, rather than an unusable one', () => {
    expect(disabled.enabled).toBe(false);
    expect(disabled.address).toBeNull();
    expect(disabled.domain()).toBeNull();
  });

  /**
   * Reads answer the unchecked shape and writes refuse by name. The asymmetry is the house rule:
   * a read that cannot be performed is a question unanswered, and a write that cannot be performed
   * must say what is missing and what it costs rather than resolving into a lie.
   */
  it('refuses a relay by naming what is missing', async () => {
    await expect(disabled.relay(update(), SIGNATURE)).rejects.toThrow(/party registry/i);
    await expect(disabled.nonceOf(PARTY)).rejects.toThrow(/no nonce to sign against/);
  });
});

describe('the signing domain', () => {
  /**
   * The domain is published by the venue rather than assembled in the browser, because it names the
   * chain id and the verifying contract — which is what makes a signature useless anywhere else,
   * and what a Privy wallet policy scopes against. A client that built its own could sign against a
   * registry this venue does not read.
   */
  it('names the deployed registry and the chain it lives on', () => {
    expect(fakeRegistry().domain()).toEqual({
      name: 'Facture Party Registry',
      version: '1',
      chainId: 296,
      /*
       * Lowercased, and that is load-bearing rather than cosmetic. EIP-712 hex-decodes an address
       * to twenty bytes, so the digest is identical either way — but the Privy wallet policy rule
       * that lets a seller's key sign this at all compares `verifyingContract` out of the decoded
       * domain as a **string**, and Privy denies anything no rule allowed. A checksummed domain
       * against a lowercased rule is a seller who cannot sign, failing at the wallet with no
       * transaction to inspect.
       */
      verifyingContract: REGISTRY_ADDRESS.toLowerCase(),
    });
  });
});
