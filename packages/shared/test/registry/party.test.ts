import { readFileSync } from 'node:fs';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  MAX_DISPLAY_NAME_BYTES,
  PARTY_REGISTRY_DOMAIN_NAME,
  PARTY_REGISTRY_DOMAIN_VERSION,
  PARTY_ROLE_MASK,
  PROFILE_UPDATE_TYPES,
  PROFILE_UPDATE_PRIMARY_TYPE,
  countryFromBytes2,
  countryToBytes2,
  partyRegistryDomain,
  rolesFromBitmask,
  rolesToBitmask,
  UNSTATED_COUNTRY,
} from '../../src/registry/party.js';

/**
 * The Solidity half of the EIP-712 type, read out of the contract rather than restated here.
 *
 * This file used to carry the type string as a hand-typed literal while claiming to guard against
 * a Solidity rename. It did not, and could not: a literal is a second copy of the thing under
 * test, so renaming a field in `PartyRegistry.sol` would move the contract and leave the test
 * agreeing with the copy. Two implementations that agree because one was transcribed from the
 * other is the split-vocabulary failure this repo has now paid for several times over — most
 * expensively as a `deployBond` tuple that compiled, typechecked and encoded a selector the
 * deployed diamond did not have.
 *
 * So the contract source is the input. `packages/agent/test/reason-codes.test.ts` established the
 * idiom — resolve the path relative to this module, read it, and compare against what the file
 * actually declares — and this is the same check pointed at a different cross-layer promise.
 */
const PARTY_REGISTRY_SOL = new URL(
  '../../../contracts/contracts/PartyRegistry.sol',
  import.meta.url,
);

/** `bytes32 public constant PROFILE_UPDATE_TYPEHASH = keccak256( <argument> );` */
const TYPEHASH_CALL = /PROFILE_UPDATE_TYPEHASH\s*=\s*keccak256\(([\s\S]*?)\)\s*;/;

/** Every quoted chunk inside that argument. See {@link solidityTypeString}. */
const STRING_CHUNK = /"([^"]*)"/g;

/**
 * The type string `PartyRegistry` hashes, exactly as it spells it.
 *
 * Adjacent string literals concatenate in Solidity, so the argument is joined from every quoted
 * chunk rather than taken from the first one. That is not hypothetical tidiness: the literal is a
 * long line that a future reformat would plausibly wrap, and a reader of a one-chunk regex would
 * see this test start failing on a change that altered nothing about the type.
 *
 * Throws rather than returning an empty string when the pattern misses, because the whole point of
 * reading the contract is defeated by a test that silently compares one side against nothing.
 */
function solidityTypeString(): string {
  const source = readFileSync(PARTY_REGISTRY_SOL, 'utf8');
  const call = TYPEHASH_CALL.exec(source);
  if (call?.[1] === undefined) {
    throw new Error(
      `PROFILE_UPDATE_TYPEHASH was not found in ${PARTY_REGISTRY_SOL.pathname}. Either the ` +
        'constant was renamed or the declaration was reshaped; fix this reader rather than ' +
        'dropping the check, which is the only thing watching the Solidity side of the type.',
    );
  }
  return [...call[1].matchAll(STRING_CHUNK)].map((m) => m[1] ?? '').join('');
}

describe('the ProfileUpdate typed data', () => {
  /**
   * The guard on the reader itself.
   *
   * A regex that had stopped matching the way the author intended — matching an empty argument,
   * say — would make the assertion below pass by comparing two things that are both nearly
   * nothing. So the extracted string is checked for being a real type declaration first, for the
   * same reason `reason-codes.test.ts` asserts its constant set is non-trivial before believing
   * anything derived from it.
   */
  it('reads a real type declaration out of PartyRegistry.sol', () => {
    const solidity = solidityTypeString();

    expect(solidity.startsWith(`${PROFILE_UPDATE_PRIMARY_TYPE}(`)).toBe(true);
    expect(solidity.endsWith(')')).toBe(true);
    expect(solidity).toContain('address party');
  });

  /**
   * The one test in this file that matters.
   *
   * Three implementations have to agree on this ordering — Solidity verifies it, the browser signs
   * it, the backend relays it — and a disagreement is not a type error anywhere. It is a signature
   * that recovers to an unrelated address, which the contract then happily refuses while nobody can
   * see why. TypeScript cannot observe a Solidity rename, so the Solidity side is read off disk and
   * the TypeScript side is derived from the table the browser actually signs from.
   *
   * If this fails, do not reconcile the two by editing whichever side is easier to reach. Check
   * which one moved, because one of them has invalidated every signature in flight and every
   * `recordHash` the contract has already emitted.
   */
  it('encodes exactly as the contract declares it', () => {
    const fields = PROFILE_UPDATE_TYPES.ProfileUpdate.map((f) => `${f.type} ${f.name}`).join(',');

    expect(`${PROFILE_UPDATE_PRIMARY_TYPE}(${fields})`).toBe(solidityTypeString());
  });

  /**
   * The domain is what stops a signature being replayed onto another chain or onto a superseded
   * deployment of this same contract, and it is what a wallet policy scopes against. A changed name
   * or version invalidates everything already signed.
   */
  it('pins the domain', () => {
    const domain = partyRegistryDomain(296, '0x1C9882714e1ae2555531E1a7eb4E83EBeCA8B2ca');

    expect(domain).toEqual({
      name: 'Facture Party Registry',
      version: '1',
      chainId: 296,
      // Lowercased deliberately. Digest-neutral, and the Privy policy compares it as a string.
      verifyingContract: '0x1c9882714e1ae2555531e1a7eb4e83ebeca8b2ca',
    });
    expect(PARTY_REGISTRY_DOMAIN_NAME).toBe('Facture Party Registry');
    expect(PARTY_REGISTRY_DOMAIN_VERSION).toBe('1');
  });
});

describe('roles', () => {
  it('encodes each role to the bit the contract reads', () => {
    expect(rolesToBitmask(['seller'])).toBe(1);
    expect(rolesToBitmask(['buyer'])).toBe(2);
    expect(rolesToBitmask(['seller', 'buyer'])).toBe(3);
    expect(PARTY_ROLE_MASK).toBe(3);
  });

  /**
   * Zero is what the contract reads as "no roles" and refuses. Catching it here means a party gets
   * a sentence naming the problem rather than a reverted transaction after they have already signed.
   */
  it('refuses an empty set rather than encoding zero', () => {
    expect(() => rolesToBitmask([])).toThrow(/at least one role/);
  });

  it('round-trips', () => {
    expect(rolesFromBitmask(3)).toEqual({ roles: ['seller', 'buyer'], unknownBits: 0 });
    expect(rolesFromBitmask(1)).toEqual({ roles: ['seller'], unknownBits: 0 });
    expect(rolesFromBitmask(0)).toEqual({ roles: [], unknownBits: 0 });
  });

  /**
   * A registry that knows a role this build does not is a real possibility, and rendering such a
   * party as holding fewer roles than they signed for would present an answer we could not read as
   * one we could. So the bit is reported rather than dropped.
   */
  it('reports a role bit it does not know instead of dropping it', () => {
    expect(rolesFromBitmask(5)).toEqual({ roles: ['seller'], unknownBits: 4 });
  });
});

describe('country', () => {
  it('encodes an alpha-2 code as the contract stores it', () => {
    expect(countryToBytes2('GB')).toBe('0x4742');
    expect(countryToBytes2('IE')).toBe('0x4945');
  });

  /**
   * Uppercased here, before the signature, because the contract refuses lowercase rather than
   * rewriting it — editing what somebody signed would make the stored record differ from the
   * message they authorised.
   */
  it('uppercases before signing rather than leaving the contract to refuse it', () => {
    expect(countryToBytes2('gb')).toBe(countryToBytes2('GB'));
    expect(countryToBytes2('  ie  ')).toBe(countryToBytes2('IE'));
  });

  it('treats an empty country as unstated, which is a real answer', () => {
    expect(countryToBytes2('')).toBe(UNSTATED_COUNTRY);
    expect(countryToBytes2('   ')).toBe(UNSTATED_COUNTRY);
    expect(countryFromBytes2(UNSTATED_COUNTRY)).toBeNull();
  });

  it('refuses anything that is not an alpha-2 code', () => {
    expect(() => countryToBytes2('GBR')).toThrow(/alpha-2/);
    expect(() => countryToBytes2('G1')).toThrow(/alpha-2/);
  });

  it('round-trips', () => {
    for (const code of ['GB', 'IE', 'US', 'DE']) {
      expect(countryFromBytes2(countryToBytes2(code))).toBe(code);
    }
  });

  /**
   * The decode side reads a chain, and a chain is not obliged to hold what this build wrote.
   *
   * `countryFromBytes2` takes whatever `profileOf` returned, and a `bytes2` that is neither
   * `0x0000` nor two uppercase letters can arrive from a registry deployed at a different version,
   * from a relay that truncated, or from a caller passing the wrong field. Both refusal branches
   * answer `null` — the same answer as "the party declined to say" — which is the weaker of the
   * two readings and deliberately so: inventing a jurisdiction out of bytes we cannot interpret is
   * how an instrument gets scoped against a country nobody stated.
   *
   * Untested until now, which meant either branch could have been deleted without a failure.
   */
  it('answers null for a value that is not two bytes', () => {
    expect(countryFromBytes2('0x47' as Hex)).toBeNull();
    expect(countryFromBytes2('0x474245' as Hex)).toBeNull();
    expect(countryFromBytes2('0x' as Hex)).toBeNull();
  });

  it('answers null for two bytes that are not uppercase letters', () => {
    // The contract refuses these on the way in rather than normalising them, so a lowercase or
    // numeric pair on the way out is a record this build did not write.
    expect(countryFromBytes2('0x6762' as Hex)).toBeNull(); // "gb"
    expect(countryFromBytes2('0x3132' as Hex)).toBeNull(); // "12"
    expect(countryFromBytes2('0x4700' as Hex)).toBeNull(); // "G\0", half-written
  });

  it('keeps the caps the contract enforces', () => {
    expect(MAX_DISPLAY_NAME_BYTES).toBe(64);
  });
});
