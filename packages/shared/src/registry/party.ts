import type { Address, Hex } from 'viem';

/**
 * The EIP-712 message a party signs to describe itself, and the vocabulary around it.
 *
 * `PartyRegistry` on Hedera stores what each address says about itself, and it stores only what
 * the address's own key signed — the venue relays and pays, and cannot author. That makes the
 * typed-data definition below a **contract between three independent implementations**: Solidity
 * verifies it, the browser signs it, and the backend relays it. If any two of them disagree about
 * a single field name, an ordering, or a type, the signature recovers to some unrelated address
 * and the venue writes a stranger's profile rather than the one it was asked to.
 *
 * So it lives here, once. This is the same rule `units.ts` exists for: a conversion only one
 * caller can find is one the next caller gets wrong. It cost this repo every issuance it ever
 * attempted when `deployBond`'s tuple was a plausible flattening of the real one — it compiled,
 * it typechecked, it produced calldata, and the selector did not exist.
 *
 * ## Field order is a promise
 *
 * {@link PROFILE_UPDATE_TYPES} determines the EIP-712 type hash. Reordering it silently
 * invalidates every signature in flight and every `recordHash` the contract has already emitted,
 * and nothing about that is visible at compile time on either side. Appending a field is the only
 * compatible change, and even that needs {@link PARTY_REGISTRY_DOMAIN_VERSION} bumped.
 *
 * A test **reads `PartyRegistry.sol` off disk**, pulls the string argument out of
 * `PROFILE_UPDATE_TYPEHASH`'s `keccak256(...)`, and compares it against the type string derived
 * from {@link PROFILE_UPDATE_TYPES}. That is the reason the HCS receipt ordering is pinned too:
 * TypeScript cannot see a Solidity rename, and that is the direction that breaks quietly.
 *
 * It is worth being precise about *how* it is pinned, because the first version of that test wrote
 * the Solidity side out as a hand-typed literal while claiming to guard against exactly this. A
 * literal is a transcription of the contract, not an observation of it: rename a field on chain and
 * the test keeps agreeing with the copy. Reading the source is what makes the claim true.
 */

/* -------------------------------------------------------------------------- */
/* Roles                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What a party does on this venue.
 *
 * A **claim**, never a permission. The registry's own header says so and it is worth repeating
 * wherever this type is imported: holding `'buyer'` authorises nothing. Eligibility to hold paper
 * is `ControlList` and `Kyc` on each instrument's diamond, capital is the Arc vault's, and every
 * real capability is still checked by whatever grants it. This exists so a screen can render the
 * right thing and a counterparty can see what an address says it is here for.
 *
 * A party may hold both. A business that sells its own receivables and funds other people's is an
 * ordinary thing to be, and forcing a choice would make the record a lie the contract could not
 * correct.
 */
export const PARTY_ROLES = ['seller', 'buyer'] as const;

export type PartyRole = (typeof PARTY_ROLES)[number];

/**
 * The bit each role occupies in the contract's `uint8 roles`.
 *
 * Mirrors `PartyRegistry.ROLE_SELLER` and `ROLE_BUYER`. An unknown bit is **refused** on chain
 * rather than masked off, so adding a role here without deploying a registry that knows it turns
 * every write carrying it into a revert — which is the loud failure, and the right one.
 */
export const PARTY_ROLE_BITS: Readonly<Record<PartyRole, number>> = {
  seller: 1,
  buyer: 2,
};

/** Every bit this version defines. Matches `PartyRegistry.ROLE_MASK`. */
export const PARTY_ROLE_MASK = 3;

/**
 * Roles to the bitmask the contract stores.
 *
 * Throws on an empty set rather than encoding zero, because zero is what the contract reads as
 * "no roles" and refuses. Catching it here means the refusal names the actual problem instead of
 * arriving as a reverted transaction after a signature was collected.
 */
export function rolesToBitmask(roles: readonly PartyRole[]): number {
  if (roles.length === 0) {
    throw new Error('A party must claim at least one role; the registry refuses an empty bitmask.');
  }
  let mask = 0;
  for (const role of roles) mask |= PARTY_ROLE_BITS[role];
  return mask;
}

/**
 * The bitmask back to roles.
 *
 * An undefined bit is **reported, not dropped**. A registry deployment that understands a role
 * this build does not is a real possibility, and silently rendering such a party as holding fewer
 * roles than they signed for would be the reading `ComplianceDecision.determinate` exists to stop
 * elsewhere: an answer we could not interpret presented as an answer we could.
 */
export function rolesFromBitmask(mask: number): { roles: PartyRole[]; unknownBits: number } {
  const roles = PARTY_ROLES.filter((role) => (mask & PARTY_ROLE_BITS[role]) !== 0);
  return { roles, unknownBits: mask & ~PARTY_ROLE_MASK };
}

/* -------------------------------------------------------------------------- */
/* Country                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * ISO 3166-1 alpha-2 as the contract's `bytes2`, or `0x0000` for unstated.
 *
 * Fixed-width rather than a string because the field is compared against jurisdiction lists — Reg
 * S scopes an instrument by `AdditionalSecurityData.listOfCountries` — and a comparison wants one
 * spelling rather than three.
 *
 * **Case is not normalised on chain.** The contract refuses lowercase rather than rewriting it,
 * because silently altering what somebody signed would make the stored record differ from the
 * message they authorised. So the uppercasing happens here, before the signature, where it is the
 * party's own input being tidied rather than their statement being edited.
 */
export const UNSTATED_COUNTRY: Hex = '0x0000';

export function countryToBytes2(country: string): Hex {
  const trimmed = country.trim().toUpperCase();
  if (trimmed === '') return UNSTATED_COUNTRY;
  if (!/^[A-Z]{2}$/.test(trimmed)) {
    throw new Error(`"${country}" is not an ISO 3166-1 alpha-2 country code.`);
  }
  const hex = [...trimmed].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return `0x${hex}`;
}

/** `0x0000` answers `null` — the party declined to say, which is a real answer and not a gap. */
export function countryFromBytes2(value: Hex): string | null {
  if (value === UNSTATED_COUNTRY) return null;
  const body = value.replace(/^0x/, '');
  if (body.length !== 4) return null;
  const decoded = String.fromCharCode(
    parseInt(body.slice(0, 2), 16),
    parseInt(body.slice(2, 4), 16),
  );
  return /^[A-Z]{2}$/.test(decoded) ? decoded : null;
}

/* -------------------------------------------------------------------------- */
/* The typed data                                                              */
/* -------------------------------------------------------------------------- */

/** Caps the contract enforces, in bytes. Checked before signing so a refusal names the field. */
export const MAX_DISPLAY_NAME_BYTES = 64;
export const MAX_LEGAL_NAME_BYTES = 128;
export const MAX_WEBSITE_BYTES = 128;

export const PARTY_REGISTRY_DOMAIN_NAME = 'Facture Party Registry';
export const PARTY_REGISTRY_DOMAIN_VERSION = '1';
export const PROFILE_UPDATE_PRIMARY_TYPE = 'ProfileUpdate';

/**
 * The type, in the order the contract hashes it. See the module header before touching this.
 */
export const PROFILE_UPDATE_TYPES = {
  ProfileUpdate: [
    { name: 'party', type: 'address' },
    { name: 'roles', type: 'uint8' },
    { name: 'displayName', type: 'string' },
    { name: 'legalName', type: 'string' },
    { name: 'country', type: 'bytes2' },
    { name: 'websiteUri', type: 'string' },
    { name: 'metadataHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint64' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

/** The message itself, in the shape viem's `signTypedData` and the contract both take. */
export interface ProfileUpdateMessage {
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

/**
 * The EIP-712 domain.
 *
 * `chainId` and `verifyingContract` are what make a signature useless anywhere but the registry it
 * was meant for — including a superseded deployment of this same contract. That is also what lets
 * a Privy wallet policy scope signing to this one contract on this one chain and have the scope
 * mean something, which is the whole reason the seller's key can be allowed to sign this at all
 * without becoming a general-purpose key.
 */
export function partyRegistryDomain(chainId: number, verifyingContract: Address) {
  return {
    name: PARTY_REGISTRY_DOMAIN_NAME,
    version: PARTY_REGISTRY_DOMAIN_VERSION,
    chainId,
    /*
     * Lowercased, and it is not cosmetic.
     *
     * EIP-712 hex-decodes an `address` to twenty bytes, so case cannot affect the digest — the
     * signature is identical either way, and that was confirmed against the deployed contract's
     * own `hashUpdate` with a checksummed address.
     *
     * What case DOES affect is the Privy wallet policy. The rule that lets a seller's key sign
     * this at all compares `verifyingContract` out of the decoded domain as a **string**, and
     * Privy denies anything no rule allowed. A checksummed domain against a lowercased rule is
     * therefore a seller who cannot sign, failing at the wallet with no revert to read. The same
     * trap the `to` condition on the claim rule already documents, one field over.
     */
    verifyingContract: verifyingContract.toLowerCase() as Address,
  } as const;
}

/* -------------------------------------------------------------------------- */
/* The record as it is read back                                               */
/* -------------------------------------------------------------------------- */

/**
 * A profile as anything outside the chain layer reads it.
 *
 * Deliberately not the contract's tuple. `roles` is a named set rather than a bitmask, `country`
 * is a code or `null` rather than `0x0000`, and `updatedAt` is an instant rather than a uint64 —
 * because every consumer of this would otherwise perform the same three conversions, and the
 * third one to do it would get one of them wrong.
 */
export interface PartyProfile {
  readonly address: Address;
  readonly roles: readonly PartyRole[];
  /** Set when the record claims a role this build does not know. Rendered, never dropped. */
  readonly unknownRoleBits: number;
  readonly displayName: string;
  readonly legalName: string | null;
  readonly country: string | null;
  readonly websiteUri: string | null;
  /** Commitment to the off-chain remainder of the record, or `null` when there is none. */
  readonly metadataHash: Hex | null;
  readonly nonce: number;
  readonly updatedAt: string;
}
