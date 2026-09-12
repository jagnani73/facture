import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import hre from 'hardhat';
import { keccak256, stringToHex, toHex, zeroAddress, zeroHash } from 'viem';
import type { Address, Hex, WalletClient } from 'viem';

const { viem, networkHelpers } = await hre.network.getOrCreate();

/**
 * The registry makes exactly one claim: the key controlling an address signed this description of
 * itself, at this nonce. Everything below is that claim approached from a different angle, plus the
 * two encodings it depends on — the EIP-712 type and the nonce — pinned so they cannot drift.
 */
describe('PartyRegistry', () => {
  /**
   * The type, transcribed here.
   *
   * What this buys is real but narrower than it first said. Checking the contract's `hashUpdate`
   * against viem's encoding of this array compares two independent EIP-712 **encoders** — Solidity's
   * `abi.encode` against viem's — and that is worth having.
   *
   * It is **not** a check against what clients sign from. This array is a third hand-typed copy;
   * the backend relay and the browser both build from `PROFILE_UPDATE_TYPES` in `@facture/shared`,
   * which this package deliberately does not depend on. The comment here used to claim it was
   * "two real implementations rather than a restatement of one", and of the shared table it was
   * exactly a restatement.
   *
   * The check that closes that gap lives in `packages/shared/test/registry/party.test.ts`, which
   * reads `PartyRegistry.sol` off disk and compares the declared type string against the table
   * clients actually use. Between the two, a Solidity rename is now visible from both directions.
   */
  const TYPES = {
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

  const ROLE_SELLER = 1;
  const ROLE_BUYER = 2;

  const GB = stringToHex('GB', { size: 2 });
  const METADATA = keccak256(toHex('facture.party-metadata:meridian'));

  interface Update {
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

  async function deploy() {
    const [party, relayer, stranger] = await viem.getWalletClients();
    assert.ok(party && relayer && stranger, 'expected at least three funded accounts');

    const registry = await viem.deployContract('PartyRegistry', []);
    const publicClient = await viem.getPublicClient();
    const chainId = await publicClient.getChainId();

    const domain = {
      name: 'Facture Party Registry',
      version: '1',
      chainId,
      verifyingContract: registry.address,
    } as const;

    /** A deadline comfortably ahead of the chain's own clock, which is not the wall clock. */
    const soon = async (): Promise<bigint> => {
      const block = await publicClient.getBlock();
      return block.timestamp + 3600n;
    };

    const sign = (signer: WalletClient, update: Update): Promise<Hex> =>
      signer.signTypedData({
        account: signer.account!,
        domain,
        types: TYPES,
        primaryType: 'ProfileUpdate',
        message: update,
      });

    return { registry, publicClient, domain, party, relayer, stranger, soon, sign };
  }

  /** A complete, valid update for `party`, which individual tests bend one field at a time. */
  const updateFor = (
    party: Address,
    deadline: bigint,
    overrides: Partial<Update> = {},
  ): Update => ({
    party,
    roles: ROLE_SELLER,
    displayName: 'Meridian Fabrication',
    legalName: 'Meridian Fabrication Ltd',
    country: GB,
    websiteUri: 'https://meridian.example',
    metadataHash: METADATA,
    nonce: 0n,
    deadline,
    ...overrides,
  });

  // -------------------------------------------------------------------------------------------
  // The encoding
  // -------------------------------------------------------------------------------------------

  /**
   * The type hash, against the type string spelled out here.
   *
   * Reordering {ProfileUpdate} invalidates every signature any client has ever produced and every
   * `recordHash` already emitted, and nothing about that is visible at compile time. This is the
   * test that fails first when someone tidies the struct.
   */
  it('pins the EIP-712 type hash', async () => {
    const { registry } = await deploy();

    const expected = keccak256(
      toHex(
        'ProfileUpdate(address party,uint8 roles,string displayName,string legalName,' +
          'bytes2 country,string websiteUri,bytes32 metadataHash,uint64 nonce,uint64 deadline)',
      ),
    );

    assert.equal(await registry.read.PROFILE_UPDATE_TYPEHASH(), expected);
  });

  /**
   * The contract's digest against viem's, for the same message.
   *
   * Two independent encoders of the same spec. If the Solidity `abi.encode` order in `hashUpdate`
   * ever stops matching the declared type, this fails — and it fails here rather than as a
   * signature that recovers to a stranger's address in production.
   */
  it('agrees with an independent EIP-712 encoder', async () => {
    const { registry, domain, party, soon } = await deploy();
    const { hashTypedData } = await import('viem');

    const update = updateFor(party.account.address, await soon());

    assert.equal(
      await registry.read.hashUpdate([update]),
      hashTypedData({ domain, types: TYPES, primaryType: 'ProfileUpdate', message: update }),
    );
  });

  // -------------------------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------------------------

  it('has no profile, and a zero nonce, before the first write', async () => {
    const { registry, party } = await deploy();
    const who = party.account.address;

    assert.equal(await registry.read.hasProfile([who]), false);
    assert.equal(await registry.read.nonceOf([who]), 0n);
    assert.equal(await registry.read.hasRole([who, ROLE_SELLER]), false);

    const empty = await registry.read.profileOf([who]);
    assert.equal(empty.updatedAt, 0n);
    assert.equal(empty.displayName, '');
  });

  it('writes a profile the party sent itself', async () => {
    const { registry, party, soon } = await deploy();
    const update = updateFor(party.account.address, await soon());
    const digest = await registry.read.hashUpdate([update]);

    await viem.assertions.emitWithArgs(
      registry.write.updateProfile([update], { account: party.account }),
      registry,
      'ProfileUpdated',
      [party.account.address, 0n, ROLE_SELLER, digest, party.account.address],
    );

    const profile = await registry.read.profileOf([party.account.address]);
    assert.equal(profile.displayName, 'Meridian Fabrication');
    assert.equal(profile.legalName, 'Meridian Fabrication Ltd');
    assert.equal(profile.country, GB);
    assert.equal(profile.websiteUri, 'https://meridian.example');
    assert.equal(profile.metadataHash, METADATA);
    assert.equal(profile.roles, ROLE_SELLER);
    assert.equal(profile.nonce, 0n);
    assert.ok(profile.updatedAt > 0n, 'updatedAt is the existence sentinel and must be set');

    assert.equal(await registry.read.hasProfile([party.account.address]), true);
    assert.equal(await registry.read.nonceOf([party.account.address]), 1n);
  });

  /**
   * The path that actually runs in this product. A wallet made from an email address holds no gas
   * on any chain, so the venue pays and the signature decides whose record is written.
   */
  it('writes the signer’s profile when somebody else relays it', async () => {
    const { registry, party, relayer, soon, sign } = await deploy();
    const update = updateFor(party.account.address, await soon());
    const signature = await sign(party, update);
    const digest = await registry.read.hashUpdate([update]);

    await viem.assertions.emitWithArgs(
      registry.write.updateProfileFor([update, signature], { account: relayer.account }),
      registry,
      'ProfileUpdated',
      [party.account.address, 0n, ROLE_SELLER, digest, relayer.account.address],
    );

    // The record belongs to the signer, and the relayer got nothing at all out of paying for it.
    assert.equal(await registry.read.hasProfile([party.account.address]), true);
    assert.equal(await registry.read.hasProfile([relayer.account.address]), false);
  });

  it('lets a party correct its profile in place', async () => {
    const { registry, party, relayer, soon, sign } = await deploy();
    const who = party.account.address;

    const first = updateFor(who, await soon());
    await registry.write.updateProfileFor([first, await sign(party, first)], {
      account: relayer.account,
    });

    const second = updateFor(who, await soon(), {
      nonce: 1n,
      displayName: 'Meridian Fabrication & Co',
      roles: ROLE_SELLER | ROLE_BUYER,
      country: stringToHex('IE', { size: 2 }),
    });
    await registry.write.updateProfileFor([second, await sign(party, second)], {
      account: relayer.account,
    });

    const profile = await registry.read.profileOf([who]);
    assert.equal(profile.displayName, 'Meridian Fabrication & Co');
    assert.equal(profile.country, stringToHex('IE', { size: 2 }));
    assert.equal(profile.nonce, 1n);
    assert.equal(await registry.read.nonceOf([who]), 2n);

    assert.equal(await registry.read.hasRole([who, ROLE_SELLER]), true);
    assert.equal(await registry.read.hasRole([who, ROLE_BUYER]), true);
  });

  // -------------------------------------------------------------------------------------------
  // What the signature is worth
  // -------------------------------------------------------------------------------------------

  /**
   * The property the whole design rests on. A relayer that edits the message does not write a lie
   * about the party — it writes a record for whichever address the altered message happens to
   * recover to, and the mismatch against `party` stops even that.
   */
  it('refuses a relayed update whose contents were altered', async () => {
    const { registry, party, relayer, soon, sign } = await deploy();
    const signed = updateFor(party.account.address, await soon());
    const signature = await sign(party, signed);

    const tampered = { ...signed, displayName: 'Definitely Not Meridian' };

    await viem.assertions.revertWithCustomError(
      registry.write.updateProfileFor([tampered, signature], { account: relayer.account }),
      registry,
      'BadSignature',
    );

    assert.equal(await registry.read.hasProfile([party.account.address]), false);
  });

  it('refuses a signature from someone other than the party', async () => {
    const { registry, party, relayer, stranger, soon, sign } = await deploy();
    const update = updateFor(party.account.address, await soon());

    await viem.assertions.revertWithCustomError(
      registry.write.updateProfileFor([update, await sign(stranger, update)], {
        account: relayer.account,
      }),
      registry,
      'BadSignature',
    );
  });

  it('refuses a malformed signature by name rather than by library error', async () => {
    const { registry, party, relayer, soon } = await deploy();
    const update = updateFor(party.account.address, await soon());

    await viem.assertions.revertWithCustomError(
      registry.write.updateProfileFor([update, '0xdeadbeef'], { account: relayer.account }),
      registry,
      'BadSignature',
    );
  });

  it('refuses a direct write for somebody else', async () => {
    const { registry, party, stranger, soon } = await deploy();
    const update = updateFor(party.account.address, await soon());

    await viem.assertions.revertWithCustomError(
      registry.write.updateProfile([update], { account: stranger.account }),
      registry,
      'NotParty',
    );
  });

  // -------------------------------------------------------------------------------------------
  // Replay
  // -------------------------------------------------------------------------------------------

  /**
   * A signature is single-use. Without this, a relayer holding an old message could put a stale
   * description back over a newer one at any point in the future — which is the difference between
   * an editable record and one whose history anyone can rewind.
   */
  it('refuses to replay a signature', async () => {
    const { registry, party, relayer, soon, sign } = await deploy();
    const update = updateFor(party.account.address, await soon());
    const signature = await sign(party, update);

    await registry.write.updateProfileFor([update, signature], { account: relayer.account });

    await viem.assertions.revertWithCustomError(
      registry.write.updateProfileFor([update, signature], { account: relayer.account }),
      registry,
      'WrongNonce',
    );
  });

  /** The nonce is the party's, not the path's: a self-sent write consumes one exactly as a relay does. */
  it('consumes a nonce on a self-sent write too', async () => {
    const { registry, party, relayer, soon, sign } = await deploy();
    const who = party.account.address;

    await registry.write.updateProfile([updateFor(who, await soon())], { account: party.account });

    const replayed = updateFor(who, await soon());
    await viem.assertions.revertWithCustomError(
      registry.write.updateProfileFor([replayed, await sign(party, replayed)], {
        account: relayer.account,
      }),
      registry,
      'WrongNonce',
    );
  });

  it('refuses a nonce from the future', async () => {
    const { registry, party, soon } = await deploy();
    const update = updateFor(party.account.address, await soon(), { nonce: 7n });

    await viem.assertions.revertWithCustomError(
      registry.write.updateProfile([update], { account: party.account }),
      registry,
      'WrongNonce',
    );
  });

  it('refuses an expired signature', async () => {
    const { registry, publicClient, party } = await deploy();
    const block = await publicClient.getBlock();
    const update = updateFor(party.account.address, block.timestamp - 60n);

    await viem.assertions.revertWithCustomError(
      registry.write.updateProfile([update], { account: party.account }),
      registry,
      'SignatureExpired',
    );
  });

  /**
   * The deadline boundary, from the accepting side.
   *
   * The contract refuses on `deadline < block.timestamp`, so a signature whose deadline is the
   * mining block's own timestamp is still good. Nothing tested that: the expiry test is sixty
   * seconds past, which passes identically under `<` and `<=`, so the contract could have been
   * tightened to `<=` — or a client could have been written assuming it was — with no failure
   * anywhere. That matters because the party is not the sender here. A seller signs, the venue
   * relays, and the gap between the two is where a deadline lands exactly on the block: refusing
   * it would make a signature that was valid when it was produced expire in transit, reported as
   * `SignatureExpired` against a deadline that has not passed.
   *
   * `setNextBlockTimestamp` is what makes the case reachable at all. Left to the node's own clock
   * the mining block is a second or more after whatever `getBlock` just reported, so "exactly on
   * the deadline" is not a state a test can otherwise arrive at.
   */
  it('accepts a deadline of exactly the mining block’s timestamp', async () => {
    const { registry, publicClient, party } = await deploy();
    const who = party.account.address;

    const at = (await publicClient.getBlock()).timestamp + 60n;
    await networkHelpers.time.setNextBlockTimestamp(at);

    await registry.write.updateProfile([updateFor(who, at)], { account: party.account });

    // Written, and written in the block whose timestamp the deadline names.
    const profile = await registry.read.profileOf([who]);
    assert.equal(profile.updatedAt, at);
    assert.equal(await registry.read.nonceOf([who]), 1n);
  });

  // -------------------------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------------------------

  it('refuses an empty roles bitmask', async () => {
    const { registry, party, soon } = await deploy();
    const update = updateFor(party.account.address, await soon(), { roles: 0 });

    await viem.assertions.revertWithCustomError(
      registry.write.updateProfile([update], { account: party.account }),
      registry,
      'InvalidRoles',
    );
  });

  /**
   * An undefined bit is refused rather than masked off. Recording a narrower claim than the party
   * signed would be this contract silently disagreeing with its own signature.
   */
  it('refuses a role bit this version does not define', async () => {
    const { registry, party, soon } = await deploy();
    const update = updateFor(party.account.address, await soon(), { roles: 4 });

    await viem.assertions.revertWithCustomError(
      registry.write.updateProfile([update], { account: party.account }),
      registry,
      'InvalidRoles',
    );
  });

  it('refuses an empty display name', async () => {
    const { registry, party, soon } = await deploy();
    const update = updateFor(party.account.address, await soon(), { displayName: '' });

    await viem.assertions.revertWithCustomError(
      registry.write.updateProfile([update], { account: party.account }),
      registry,
      'EmptyDisplayName',
    );
  });

  /**
   * Each cap, refused by name and by number.
   *
   * `StringTooLong(string field, uint256 length, uint256 maximum)` carries three arguments for a
   * reason: a relayer holding a rejected update has to know which of three strings to shorten and
   * by how much, and "StringTooLong" alone says none of that. Asserting only the error name lets
   * the arguments be wrong — the wrong field label copied between branches, `maximum` and `length`
   * transposed — and the test would keep passing while every refusal sent the caller to trim the
   * wrong field. This repo has the same defect on record one layer down, where the README's role
   * hashes were granted successfully and authorised nothing.
   */
  it('caps each string, and says which one and by how much', async () => {
    const { registry, party, soon } = await deploy();
    const deadline = await soon();
    const who = party.account.address;

    const cases: ReadonlyArray<{
      readonly override: Partial<Update>;
      readonly args: readonly [string, bigint, bigint];
    }> = [
      { override: { displayName: 'x'.repeat(65) }, args: ['displayName', 65n, 64n] },
      { override: { legalName: 'x'.repeat(129) }, args: ['legalName', 129n, 128n] },
      { override: { websiteUri: 'x'.repeat(129) }, args: ['websiteUri', 129n, 128n] },
    ];

    for (const { override, args } of cases) {
      await viem.assertions.revertWithCustomErrorWithArgs(
        registry.write.updateProfile([updateFor(who, deadline, override)], {
          account: party.account,
        }),
        registry,
        'StringTooLong',
        [...args],
      );
    }
  });

  /**
   * The other side of every cap, which is where `>` and `>=` become distinguishable.
   *
   * Without this, a string of exactly the documented length is an untested input and the caps
   * could silently be one byte tighter than `MAX_DISPLAY_NAME_BYTES` says. A cap is a promise
   * about what is allowed as much as about what is refused, and the value at the boundary is the
   * one a client generates when it truncates to the published limit before signing — so the byte
   * that would be rejected is precisely the byte a well-behaved client produces.
   *
   * All three at once, deliberately: a single accepted write proves no cap is off by one, and the
   * error's `field` argument names the culprit if one ever is.
   */
  it('accepts strings of exactly the cap', async () => {
    const { registry, party, soon } = await deploy();
    const who = party.account.address;

    // ASCII, so one character is one byte and these lengths are the caps as the contract counts
    // them. The contract measures `bytes(...).length`, not characters.
    const update = updateFor(who, await soon(), {
      displayName: 'd'.repeat(64),
      legalName: 'l'.repeat(128),
      websiteUri: 'w'.repeat(128),
    });

    await registry.write.updateProfile([update], { account: party.account });

    const profile = await registry.read.profileOf([who]);
    assert.equal(profile.displayName.length, 64);
    assert.equal(profile.legalName.length, 128);
    assert.equal(profile.websiteUri.length, 128);
  });

  it('accepts an unstated country and refuses a malformed one', async () => {
    const { registry, party, stranger, soon } = await deploy();

    // Unstated is a real answer, and the only one a party who declined to say has.
    const unstated = updateFor(party.account.address, await soon(), { country: '0x0000' });
    await registry.write.updateProfile([unstated], { account: party.account });
    assert.equal((await registry.read.profileOf([party.account.address])).country, '0x0000');

    // Lowercase is refused rather than normalised: rewriting what somebody signed would make the
    // stored record differ from the message they authorised.
    const lower = updateFor(stranger.account.address, await soon(), {
      country: stringToHex('gb', { size: 2 }),
    });
    await viem.assertions.revertWithCustomError(
      registry.write.updateProfile([lower], { account: stranger.account }),
      registry,
      'InvalidCountry',
    );
  });

  /**
   * The zero address is refused at the signature, and `ZeroParty` is never what refuses it.
   *
   * This test used to be called "refuses a profile for the zero address" while asserting
   * `BadSignature`, which read as though it were exercising `_write`'s `ZeroParty` guard. It is
   * not, and nothing can be: **`ZeroParty` is unreachable from both entry points.**
   *
   * - `updateProfile` requires `msg.sender == update.party`, and no transaction is ever sent from
   *   the zero address.
   * - `updateProfileFor` recovers first. OpenZeppelin's `tryRecover` returns `address(0)` only
   *   alongside a non-`NoError` `RecoverError`, so a zero recovery always trips the `err` half of
   *   the check, and a successful recovery is never zero — either way the mismatch against
   *   `update.party` produces `BadSignature` before `_write` is entered.
   *
   * So the guard is defence-in-depth for a future caller that does not exist yet, and it is worth
   * saying so here rather than leaving the next reader to hunt for the test that covers it. The
   * name of this test now describes what it establishes: the zero address gets nowhere, and the
   * reason it gets nowhere is that nobody can sign for it.
   */
  it('refuses a relayed update naming the zero address, at the signature', async () => {
    const { registry, relayer, soon } = await deploy();
    const update = updateFor(zeroAddress, await soon());

    // Recovered is `address(0)` here too, which is what the second argument records: the refusal
    // names what it got, so a caller can tell a malformed signature from a wrong-key one.
    await viem.assertions.revertWithCustomErrorWithArgs(
      registry.write.updateProfileFor([update, '0xdeadbeef'], { account: relayer.account }),
      registry,
      'BadSignature',
      [zeroAddress, zeroAddress],
    );

    assert.equal(await registry.read.hasProfile([zeroAddress]), false);
  });

  // -------------------------------------------------------------------------------------------
  // Roles are claims
  // -------------------------------------------------------------------------------------------

  /** A mask with several bits set asks whether the party claims all of them, not any of them. */
  it('reads a multi-bit role mask as "all of these"', async () => {
    const { registry, party, soon } = await deploy();
    const who = party.account.address;

    await registry.write.updateProfile([updateFor(who, await soon(), { roles: ROLE_SELLER })], {
      account: party.account,
    });

    assert.equal(await registry.read.hasRole([who, ROLE_SELLER]), true);
    assert.equal(await registry.read.hasRole([who, ROLE_BUYER]), false);
    assert.equal(await registry.read.hasRole([who, ROLE_SELLER | ROLE_BUYER]), false);

    // Zero is not "no requirement". Answering true would make an empty check look satisfied.
    assert.equal(await registry.read.hasRole([who, 0]), false);
  });

  it('reports nothing for an address that never wrote', async () => {
    const { registry, stranger } = await deploy();

    assert.equal(await registry.read.hasProfile([stranger.account.address]), false);
    assert.equal(await registry.read.hasRole([stranger.account.address, ROLE_BUYER]), false);
    assert.equal(
      (await registry.read.profileOf([stranger.account.address])).metadataHash,
      zeroHash,
    );
  });
});
