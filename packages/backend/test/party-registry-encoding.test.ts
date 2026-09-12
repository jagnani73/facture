/**
 * The parts of the registry client a fake cannot check.
 *
 * `createPartyRegistry` — the real client holding the ABI, the gas, the receipt check and the
 * profile decoder — is constructed by no other test in this repo. Everything in
 * `party-registry.test.ts` runs against a hand-written object implementing the `PartyRegistry`
 * interface, and that fake cannot contradict an ABI it does not have. So the encodings, the
 * refusal discriminant and the signature recovery are pinned here instead.
 *
 * All of it is pure. No network, no chain, no fixtures — which is the point: these are exactly the
 * checks that were missing when `deployBond`'s tuple compiled, typechecked, produced calldata, and
 * named a selector the deployed diamond did not have.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeFunctionResult,
  encodeAbiParameters,
  getAbiItem,
  toFunctionSelector,
  type AbiFunction,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import {
  partyRegistryDomain,
  PROFILE_UPDATE_TYPES,
  rolesToBitmask,
  type ProfileUpdateMessage,
} from '@facture/shared';

import {
  recordProfile,
  recoverProfileSigner,
  REGISTRY_ABI,
  RegistryRefusal,
  type PartyRegistry,
} from '../src/services/party-registry.js';

const REGISTRY_ADDRESS = '0x1C9882714e1ae2555531E1a7eb4E83EBeCA8B2ca' as Address;
const DOMAIN = partyRegistryDomain(296, REGISTRY_ADDRESS);

const update = (overrides: Partial<ProfileUpdateMessage> = {}): ProfileUpdateMessage => ({
  party: '0xe52553bd1b0D869b9310E2Ff04a8F5DC58dcE324' as Address,
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

/** Only what each test bends; every other member is never reached by these cases. */
const fakeRegistry = (relay: PartyRegistry['relay']): PartyRegistry => ({
  enabled: true,
  address: REGISTRY_ADDRESS,
  domain: () => DOMAIN,
  nonceOf: () => Promise.resolve(0n),
  profileOf: () => Promise.resolve({ checked: true, profile: null }),
  relay,
});

describe('the ABI, against the Solidity it must match', () => {
  /**
   * The write side. A wrong tuple order produces calldata the contract decodes into a different
   * message, so the recovered signer is a stranger, the write reverts, and the party is told a
   * nonce or a deadline is at fault — advice that can never work.
   */
  it('encodes updateProfileFor as the contract declares it', () => {
    const fromAbi = toFunctionSelector(
      getAbiItem({ abi: REGISTRY_ABI, name: 'updateProfileFor' }) as AbiFunction,
    );

    // Spelled out from `IPartyRegistry.sol`'s ProfileUpdate, independently of the ABI above.
    const fromSolidity = toFunctionSelector(
      'updateProfileFor((address,uint8,string,string,bytes2,string,bytes32,uint64,uint64),bytes)',
    );

    expect(fromAbi).toBe(fromSolidity);
  });

  /**
   * The read side, and the worse of the two.
   *
   * `Profile` ends in three consecutive strings and carries two adjacent `uint64`s. viem decodes
   * positionally and names fields from whatever this ABI says, so transposing any neighbouring
   * pair decodes cleanly. Swap the strings and the venue renders a lie on the one screen whose
   * pitch is "what a counterparty can read without asking us"; swap `updatedAt` and `nonce` and
   * `toProfile` reads `updatedAt === 0n` for every party who has written exactly one profile and
   * answers "never written one" — a confident absence, nothing thrown, nothing logged.
   */
  it('lands each Profile field in its own slot', () => {
    const encoded = encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'roles', type: 'uint8' },
            { name: 'country', type: 'bytes2' },
            { name: 'updatedAt', type: 'uint64' },
            { name: 'nonce', type: 'uint64' },
            { name: 'metadataHash', type: 'bytes32' },
            { name: 'displayName', type: 'string' },
            { name: 'legalName', type: 'string' },
            { name: 'websiteUri', type: 'string' },
          ],
        },
      ],
      [
        {
          roles: 1,
          country: '0x4742',
          updatedAt: 1_700_000_000n,
          nonce: 7n,
          metadataHash: `0x${'11'.repeat(32)}`,
          displayName: 'display',
          legalName: 'legal',
          websiteUri: 'website',
        },
      ],
    );

    const decoded = decodeFunctionResult({
      abi: REGISTRY_ABI,
      functionName: 'profileOf',
      data: encoded,
    }) as unknown as {
      roles: number;
      country: Hex;
      updatedAt: bigint;
      nonce: bigint;
      displayName: string;
      legalName: string;
      websiteUri: string;
    };

    // Each asserted by name, so a transposition fails here rather than on a screen.
    expect(decoded.roles).toBe(1);
    expect(decoded.country).toBe('0x4742');
    expect(decoded.updatedAt).toBe(1_700_000_000n);
    expect(decoded.nonce).toBe(7n);
    expect(decoded.displayName).toBe('display');
    expect(decoded.legalName).toBe('legal');
    expect(decoded.websiteUri).toBe('website');
  });
});

/**
 * The refusal discriminant, pinned by type rather than by prose.
 *
 * This was `detail.includes('refused that profile update')` against a user-facing sentence thrown
 * one function away, and the test for it constructed that sentence by hand — so both halves of one
 * contract were compared against independent copies of a string. Rewording the prose would have
 * reclassified every contract refusal as an outage, with the whole suite still green.
 */
describe('a refusal is a type, not a sentence', () => {
  it('classifies RegistryRefusal as refused however it is worded', async () => {
    const recording = await recordProfile(
      fakeRegistry(() => Promise.reject(new RegistryRefusal('any wording at all', '0xbeef'))),
      update(),
      `0x${'ab'.repeat(65)}`,
    );

    expect(recording.state).toBe('refused');
    expect(recording.detail).toBe('any wording at all');
  });

  /**
   * A refusal is the one state where a reader most wants to open the transaction, and it was the
   * one state where the field built for that was null.
   */
  it('carries the transaction hash off a reverted receipt', async () => {
    const recording = await recordProfile(
      fakeRegistry(() => Promise.reject(new RegistryRefusal('reverted', '0xbeef'))),
      update(),
      `0x${'ab'.repeat(65)}`,
    );

    expect(recording.transactionHash).toBe('0xbeef');
  });

  /** A node that rejected the call outright has no hash to give, and must not invent one. */
  it('reports no hash when the call never reached a receipt', async () => {
    const recording = await recordProfile(
      fakeRegistry(() => Promise.reject(new RegistryRefusal('reverted', null))),
      update(),
      `0x${'ab'.repeat(65)}`,
    );

    expect(recording.state).toBe('refused');
    expect(recording.transactionHash).toBeNull();
  });

  /**
   * The half that proves the coupling is gone: an ordinary error carrying the old sentinel text
   * verbatim is still an outage, because the discriminant is the type.
   */
  it('does not read an ordinary error as a refusal, even one quoting the old sentence', async () => {
    const recording = await recordProfile(
      fakeRegistry(() => Promise.reject(new Error('refused that profile update'))),
      update(),
      `0x${'ab'.repeat(65)}`,
    );

    expect(recording.state).toBe('unavailable');
  });
});

/**
 * Local signature recovery, which is the venue's own authorisation check.
 *
 * Until this existed the contract was the only verifier, so a signed-in caller could present
 * sixty-five bytes of nonsense with any name they liked: the chain reverted, and the venue renamed
 * the business anyway and answered 200.
 */
describe('recovering the signer without a chain', () => {
  it('recovers the address that actually signed', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const message = update({ party: account.address });
    const signature = await account.signTypedData({
      domain: DOMAIN,
      types: PROFILE_UPDATE_TYPES,
      primaryType: 'ProfileUpdate',
      message,
    });

    expect(await recoverProfileSigner(message, signature, DOMAIN)).toBe(account.address);
  });

  /** The forgery the route refuses: a real signature over a different message. */
  it('does not recover the party when a field was altered after signing', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signed = update({ party: account.address });
    const signature = await account.signTypedData({
      domain: DOMAIN,
      types: PROFILE_UPDATE_TYPES,
      primaryType: 'ProfileUpdate',
      message: signed,
    });

    const tampered = { ...signed, displayName: 'Someone Else Entirely' };
    expect(await recoverProfileSigner(tampered, signature, DOMAIN)).not.toBe(account.address);
  });

  /**
   * A signature for the right message but the wrong domain recovers to a stranger. That is what
   * makes the domain's `chainId` and `verifyingContract` load-bearing rather than decorative.
   */
  it('does not recover the party against a different registry', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const message = update({ party: account.address });
    const signature = await account.signTypedData({
      domain: partyRegistryDomain(296, '0x0000000000000000000000000000000000000001'),
      types: PROFILE_UPDATE_TYPES,
      primaryType: 'ProfileUpdate',
      message,
    });

    expect(await recoverProfileSigner(message, signature, DOMAIN)).not.toBe(account.address);
  });

  /** Nonsense is an answer — nobody signed this — rather than an exception to handle upstream. */
  it('answers null for a malformed signature', async () => {
    expect(await recoverProfileSigner(update(), `0x${'ab'.repeat(65)}`, DOMAIN)).toBeNull();
  });
});
