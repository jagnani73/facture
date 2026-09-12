/**
 * Turning what somebody typed into a form into the exact bytes their wallet will sign.
 *
 * This file is pure on purpose. The signature is over a digest, and a digest is unforgiving: a
 * field stringified differently, a bigint that became a number, a domain assembled locally instead
 * of taken from the venue — any of those produces a signature that recovers to an unrelated
 * address, and `PartyRegistry` then refuses it for a reason nothing on screen can explain. So the
 * assembly happens here, once, where a test can hash the result and compare it against viem's own
 * encoder rather than against a second copy of these same assumptions.
 *
 * The three implementations that have to agree are Solidity, the browser and the relay. The type
 * table they agree on lives in `@facture/shared` and is pinned there against the contract's own
 * type string. Nothing in this file redefines it.
 */

import type { Address, Hex } from 'viem';

import {
  MAX_DISPLAY_NAME_BYTES,
  MAX_LEGAL_NAME_BYTES,
  MAX_WEBSITE_BYTES,
  PROFILE_UPDATE_PRIMARY_TYPE,
  PROFILE_UPDATE_TYPES,
  countryToBytes2,
  rolesToBitmask,
  type PartyRole,
} from '@/lib/domain';
import type { PartySigningDomain, SignedProfileUpdate } from '@/lib/api/contract';

/** How long a profile signature stays good for. */
const SIGNATURE_TTL_SECONDS = 15 * 60;

/** The zero `bytes32`, which is how the contract stores "no off-chain remainder". */
const NO_METADATA = `0x${'00'.repeat(32)}` as Hex;

/**
 * The EIP-712 domain type, which viem infers and eth-sig-util does not.
 *
 * Privy's `signTypedData` takes the eth-sig-util `TypedMessage` shape, where `EIP712Domain` has to
 * be declared alongside the message type rather than derived from the domain object. It is spelled
 * out here for that reason and for no other — the four fields and their order are fixed by EIP-712
 * itself, so this is a restatement of the spec rather than a choice this product is making.
 */
const EIP712_DOMAIN_TYPE = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
] as const;

/** What a person actually filled in. Everything else on the wire is derived from this. */
export interface ProfileDraft {
  roles: readonly PartyRole[];
  displayName: string;
  legalName: string;
  /** ISO 3166-1 alpha-2, or empty for "would rather not say", which is a real answer. */
  country: string;
  websiteUri: string;
}

export interface ProfileProblem {
  field: keyof ProfileDraft;
  message: string;
}

/**
 * What the contract would refuse, said in advance and in the field it belongs to.
 *
 * The caps are the contract's, imported rather than retyped. Checking them here is not a second
 * enforcement — the chain is the enforcement — it is so that a refusal arrives beside the input
 * that caused it instead of as a reverted transaction after somebody has already signed.
 *
 * Lengths are measured in **bytes**, because that is what the contract counts. A name in Greek or
 * Japanese hits the cap sooner than its character count suggests, and a form that counted
 * characters would let it through and then fail on chain.
 */
export function validateDraft(draft: ProfileDraft): ProfileProblem[] {
  const problems: ProfileProblem[] = [];
  const bytes = (value: string) => new TextEncoder().encode(value).length;

  if (draft.roles.length === 0) {
    problems.push({
      field: 'roles',
      message: 'Pick at least one. A profile that claims nothing says nothing.',
    });
  }

  const name = draft.displayName.trim();
  if (name === '') {
    problems.push({ field: 'displayName', message: 'A business needs a name here.' });
  } else if (bytes(name) > MAX_DISPLAY_NAME_BYTES) {
    problems.push({
      field: 'displayName',
      message: `Too long — ${MAX_DISPLAY_NAME_BYTES} bytes is the limit on chain.`,
    });
  }

  if (bytes(draft.legalName.trim()) > MAX_LEGAL_NAME_BYTES) {
    problems.push({
      field: 'legalName',
      message: `Too long — ${MAX_LEGAL_NAME_BYTES} bytes is the limit on chain.`,
    });
  }

  if (bytes(draft.websiteUri.trim()) > MAX_WEBSITE_BYTES) {
    problems.push({
      field: 'websiteUri',
      message: `Too long — ${MAX_WEBSITE_BYTES} bytes is the limit on chain.`,
    });
  }

  const country = draft.country.trim();
  if (country !== '' && !/^[A-Za-z]{2}$/.test(country)) {
    problems.push({
      field: 'country',
      message: 'Two letters, as in GB or IE. Leave it blank to say nothing.',
    });
  }

  return problems;
}

/**
 * The message, in the shape that crosses the wire.
 *
 * `nonce` comes from the venue, which read it off the contract. It is **not** derived from a
 * profile's current nonce here: there is one authority on what the next signature must carry, and
 * it is the contract that will check it.
 *
 * `deadline` is short by design. A profile update is something a person does in a browser in the
 * next few minutes, and a signature that stayed valid forever would be a credential nobody meant
 * to issue — anyone who later got hold of it could put an old description back.
 */
export function buildProfileUpdate(input: {
  party: Address;
  draft: ProfileDraft;
  nonce: string;
  now?: Date;
}): SignedProfileUpdate {
  const { party, draft, nonce } = input;
  const now = input.now ?? new Date();
  const deadline = Math.floor(now.getTime() / 1000) + SIGNATURE_TTL_SECONDS;

  return {
    party,
    roles: rolesToBitmask([...draft.roles]),
    displayName: draft.displayName.trim(),
    legalName: draft.legalName.trim(),
    country: countryToBytes2(draft.country),
    websiteUri: draft.websiteUri.trim(),
    // Nothing off-chain is committed to yet. The contract reads zero as "there is no remainder",
    // which is the honest value while the venue holds no private half of this record.
    metadataHash: NO_METADATA,
    nonce,
    deadline: String(deadline),
  };
}

/**
 * The payload for Privy's `signTypedData`.
 *
 * The domain is the venue's, passed through untouched. Assembling one here would let this app sign
 * against a registry the venue does not read — and the failure would not look like a failure, it
 * would look like a signature that verifies nowhere.
 *
 * `nonce` and `deadline` stay strings. They are `uint64` on chain, and a `uint64` past 2^53 rounds
 * silently through a JavaScript number; EIP-712 encoders take decimal strings for integer types
 * precisely so that cannot happen.
 */
export function typedDataFor(update: SignedProfileUpdate, domain: PartySigningDomain) {
  return {
    types: {
      EIP712Domain: [...EIP712_DOMAIN_TYPE],
      [PROFILE_UPDATE_PRIMARY_TYPE]: [...PROFILE_UPDATE_TYPES.ProfileUpdate],
    },
    primaryType: PROFILE_UPDATE_PRIMARY_TYPE,
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    message: {
      party: update.party,
      roles: update.roles,
      displayName: update.displayName,
      legalName: update.legalName,
      country: update.country,
      websiteUri: update.websiteUri,
      metadataHash: update.metadataHash,
      nonce: update.nonce,
      deadline: update.deadline,
    },
  };
}

/**
 * A recorded profile back into the form a person edits.
 *
 * Nulls become empty strings because the form has no third state for a text input, and the
 * contract reads an empty string as "not stated" anyway — so the round trip is lossless in the
 * direction that matters. The country is the one field where "not stated" is a real answer rather
 * than an omission, which is why `countryToBytes2` treats blank as `0x0000` rather than refusing it.
 */
export function draftFrom(profile: {
  roles: readonly PartyRole[];
  displayName: string;
  legalName: string | null;
  country: string | null;
  websiteUri: string | null;
}): ProfileDraft {
  return {
    roles: [...profile.roles],
    displayName: profile.displayName,
    legalName: profile.legalName ?? '',
    country: profile.country ?? '',
    websiteUri: profile.websiteUri ?? '',
  };
}
