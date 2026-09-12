import { describe, expect, it } from 'vitest';
import { hashTypedData } from 'viem';
import type { Address } from 'viem';

import { buildProfileUpdate, draftFrom, typedDataFor, validateDraft } from '@/lib/party';
import type { ProfileDraft } from '@/lib/party';
import type { PartySigningDomain } from '@/lib/api/contract';

/**
 * What a wallet is about to sign.
 *
 * `tsc --noEmit` cannot see any of the failures that matter here. A bigint that became a number, a
 * field stringified differently, a domain assembled locally instead of taken from the venue — each
 * of those is well-typed and produces a signature that recovers to an unrelated address, which
 * `PartyRegistry` then refuses for a reason nothing on screen could explain. So these tests hash
 * the payload and compare it against a digest **written down as a constant**, which is the only
 * check that can see the difference. A second derivation from the same type table cannot: it moves
 * whenever the table moves, which is the one event worth catching.
 */

const PARTY = '0xe52553bd1b0D869b9310E2Ff04a8F5DC58dcE324' as Address;

/** The venue's domain, as `GET /v1/parties/:address` publishes it — lowercased, as it arrives. */
const DOMAIN: PartySigningDomain = {
  name: 'Facture Party Registry',
  version: '1',
  chainId: 296,
  verifyingContract: '0x1c9882714e1ae2555531e1a7eb4e83ebeca8b2ca',
};

const draft = (overrides: Partial<ProfileDraft> = {}): ProfileDraft => ({
  roles: ['seller'],
  displayName: 'Meridian Fabrication',
  legalName: 'Meridian Fabrication Ltd',
  country: 'GB',
  websiteUri: 'https://meridian.example',
  ...overrides,
});

/* ── the pin ─────────────────────────────────────────────────────────────────────────── */

/**
 * One fixed message, so the digest below is a constant rather than an opinion.
 *
 * `buildProfileUpdate` derives the deadline from the clock, so `now` is supplied: a payload with a
 * moving field cannot be pinned to anything.
 */
const PINNED_AT = new Date('2026-09-12T12:00:00.000Z');

const PINNED_DRAFT: ProfileDraft = {
  roles: ['seller', 'buyer'],
  displayName: 'Smoke Test Industries',
  legalName: 'Smoke Test Industries Ltd',
  country: 'GB',
  websiteUri: 'https://smoke.example',
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE PIN. IT IS A LITERAL ON PURPOSE, AND REGENERATING IT DEFEATS THE TEST.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The digest of {@link PINNED_DRAFT} at nonce 0 against {@link DOMAIN}, computed once with viem
 * and written down. It replaces a test that hashed the payload twice — once through
 * `typedDataFor` and once through `PROFILE_UPDATE_TYPES` directly — and compared the two. Both
 * sides read the same type table, so the comparison could not see a change to that table, which
 * is the single thing its comment claimed it guarded. `claim-payout.test.tsx` states the rule it
 * broke: *a test that re-derives the value from the code under test agrees with it no matter what
 * it says.*
 *
 * What a frozen literal sees that the old test could not: a field renamed, reordered, retyped or
 * added in `@facture/shared`'s `PROFILE_UPDATE_TYPES`; the domain's name or version drifting; a
 * value silently coerced on the way into the message. Each of those is well-typed, produces a
 * signature that recovers to an unrelated address, and is refused by `PartyRegistry` for a reason
 * nothing on screen can explain.
 *
 * **So if this assertion fails, the question is what moved, not what the new digest is.** The
 * contract's `hashUpdate` is the authority — the deployed registry was read for exactly this
 * during the smoke test — and a genuine, intended change to the signed struct is a change every
 * already-issued signature stops verifying under. Pasting in whatever the code now produces turns
 * this file back into the thing it was written to replace.
 */
const PINNED_DIGEST = '0x9a5e1a75814d3396bae63d437d131fd6dad0fb509f241026ffb49fd6af638020';

describe('the signing payload', () => {
  /**
   * The test this file exists for.
   *
   * The payload `typedDataFor` hands Privy is hashed the way a verifier hashes it, and compared
   * against a constant. The wallet signs this digest and the contract recovers from it, so an
   * encoder that drifts from either produces a signature that verifies nowhere while everything
   * on screen still looks fine.
   */
  it('hashes to the digest pinned in this file', () => {
    const update = buildProfileUpdate({
      party: PARTY,
      draft: PINNED_DRAFT,
      nonce: '0',
      now: PINNED_AT,
    });

    /*
     * The values the digest is over, asserted beside it so a failure can be read. Without these a
     * broken pin says only "two hashes differ", which is the least useful thing a hash can say.
     */
    expect(update.roles).toBe(3);
    expect(update.country).toBe('0x4742');
    expect(update.metadataHash).toBe(`0x${'00'.repeat(32)}`);
    expect(update.nonce).toBe('0');
    expect(update.deadline).toBe('1789215300');

    const payload = typedDataFor(update, DOMAIN);

    const digest = hashTypedData({
      domain: payload.domain,
      // The payload carries EIP712Domain for Privy's encoder; viem builds its own from the domain
      // object, so it is dropped here and asserted separately below. Every other type is the one
      // being checked.
      types: { ProfileUpdate: payload.types.ProfileUpdate },
      primaryType: 'ProfileUpdate',
      message: {
        ...payload.message,
        nonce: BigInt(payload.message.nonce),
        deadline: BigInt(payload.message.deadline),
      },
    } as Parameters<typeof hashTypedData>[0]);

    expect(digest).toBe(PINNED_DIGEST);
  });

  /**
   * The four fields viem never looks at, and Privy always does.
   *
   * viem derives `EIP712Domain` from the domain object it is given, so the digest above is
   * computed without ever reading this array — it could be empty, misordered or wrong and that
   * test would still pass. eth-sig-util, which is the shape Privy's `signTypedData` takes, does
   * the opposite: it encodes the domain from exactly this declaration. So what a wallet actually
   * signs depends on an array nothing was checking.
   *
   * Order is part of it. The domain separator is `keccak256` over the fields in the order they are
   * declared, so a reordering here is a different separator, a signature that recovers to an
   * unrelated address, and a contract refusal with nothing on screen able to explain it.
   */
  it('declares the EIP-712 domain type Privy encodes from, in order', () => {
    const payload = typedDataFor(
      buildProfileUpdate({ party: PARTY, draft: draft(), nonce: '0' }),
      DOMAIN,
    );

    expect(payload.types.EIP712Domain).toEqual([
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ]);
  });

  /**
   * `uint64` past 2^53 rounds silently through a JavaScript number, and a rounded nonce is a
   * signature the contract refuses while the screen has nothing to show for it.
   */
  it('keeps uint64 fields as decimal strings', () => {
    const update = buildProfileUpdate({
      party: PARTY,
      draft: draft(),
      nonce: '18446744073709551610',
    });

    expect(update.nonce).toBe('18446744073709551610');
    expect(typeof typedDataFor(update, DOMAIN).message.nonce).toBe('string');
    expect(typeof typedDataFor(update, DOMAIN).message.deadline).toBe('string');
  });

  /** The nonce is the contract's answer, relayed. Deriving one here would be a second authority. */
  it('carries the venue-supplied nonce rather than inventing one', () => {
    expect(buildProfileUpdate({ party: PARTY, draft: draft(), nonce: '7' }).nonce).toBe('7');
  });

  it('passes the venue domain through untouched', () => {
    const payload = typedDataFor(
      buildProfileUpdate({ party: PARTY, draft: draft(), nonce: '0' }),
      DOMAIN,
    );
    expect(payload.domain).toEqual(DOMAIN);
  });

  it('gives the signature a short life', () => {
    const now = new Date('2026-09-12T12:00:00Z');
    const update = buildProfileUpdate({ party: PARTY, draft: draft(), nonce: '0', now });

    const deadline = Number(update.deadline);
    expect(deadline).toBeGreaterThan(now.getTime() / 1000);
    expect(deadline - now.getTime() / 1000).toBeLessThanOrEqual(15 * 60);
  });

  it('encodes roles as the bitmask the contract stores', () => {
    expect(
      buildProfileUpdate({ party: PARTY, draft: draft({ roles: ['seller'] }), nonce: '0' }).roles,
    ).toBe(1);
    expect(
      buildProfileUpdate({ party: PARTY, draft: draft({ roles: ['buyer'] }), nonce: '0' }).roles,
    ).toBe(2);
    expect(
      buildProfileUpdate({ party: PARTY, draft: draft({ roles: ['seller', 'buyer'] }), nonce: '0' })
        .roles,
    ).toBe(3);
  });

  it('trims what a person typed, and treats a blank country as unstated', () => {
    const update = buildProfileUpdate({
      party: PARTY,
      draft: draft({ displayName: '  Meridian  ', country: '  ', websiteUri: '' }),
      nonce: '0',
    });

    expect(update.displayName).toBe('Meridian');
    expect(update.country).toBe('0x0000');
    expect(update.websiteUri).toBe('');
  });
});

describe('saying in advance what the contract would refuse', () => {
  it('accepts a complete draft', () => {
    expect(validateDraft(draft())).toEqual([]);
  });

  it('requires a name and at least one role', () => {
    expect(validateDraft(draft({ displayName: '   ' }))).toContainEqual(
      expect.objectContaining({ field: 'displayName' }),
    );
    expect(validateDraft(draft({ roles: [] }))).toContainEqual(
      expect.objectContaining({ field: 'roles' }),
    );
  });

  /**
   * The contract counts bytes, so the form must too. A name in Greek or Japanese reaches the cap
   * well before its character count suggests, and counting characters would let it through and fail
   * on chain — after the signature, where the refusal is least useful.
   */
  it('measures the caps in bytes rather than characters', () => {
    // 33 characters, 66 bytes: inside a 64-character budget and past a 64-byte one.
    const greek = 'α'.repeat(33);
    expect(greek.length).toBeLessThan(64);

    expect(validateDraft(draft({ displayName: greek }))).toContainEqual(
      expect.objectContaining({ field: 'displayName' }),
    );
  });

  it('accepts a blank country and refuses a malformed one', () => {
    expect(validateDraft(draft({ country: '' }))).toEqual([]);
    expect(validateDraft(draft({ country: 'GBR' }))).toContainEqual(
      expect.objectContaining({ field: 'country' }),
    );
  });
});

describe('editing a recorded profile', () => {
  /**
   * Nulls become empty strings because a text input has no third state, and the contract reads an
   * empty string as "not stated" anyway — so the round trip is lossless where it matters.
   */
  it('round-trips a record into a form and back', () => {
    const recovered = draftFrom({
      roles: ['seller', 'buyer'],
      displayName: 'Meridian Fabrication',
      legalName: null,
      country: null,
      websiteUri: null,
    });

    expect(recovered).toEqual({
      roles: ['seller', 'buyer'],
      displayName: 'Meridian Fabrication',
      legalName: '',
      country: '',
      websiteUri: '',
    });

    const update = buildProfileUpdate({ party: PARTY, draft: recovered, nonce: '1' });
    expect(update.legalName).toBe('');
    expect(update.country).toBe('0x0000');
    expect(update.roles).toBe(3);
  });
});
