import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import hre from 'hardhat';
import { keccak256, toHex, zeroAddress, zeroHash } from 'viem';

const { viem } = await hre.network.getOrCreate();

/**
 * The registry's whole job is that a receivable can be bound exactly once, and that the binding is
 * then permanent. Everything below is a restatement of that one property from a different angle.
 */
describe('UniquenessRegistry', () => {
  async function deploy() {
    const [owner, issuer, stranger] = await viem.getWalletClients();
    assert.ok(owner && issuer && stranger, 'expected at least three funded accounts');

    const registry = await viem.deployContract('UniquenessRegistry', [owner.account.address]);
    await registry.write.setIssuer([issuer.account.address, true]);

    return { registry, owner, issuer, stranger };
  }

  const DEBTOR = keccak256(toHex('debtor:meridian-fabrication'));
  const INVOICE_REF = keccak256(toHex('INV-2026-0041'));
  const FACE = 40_000_000_000n; // $40,000.000000 at six decimals

  const INSTRUMENT_A = '0x1111111111111111111111111111111111111111' as const;
  const INSTRUMENT_B = '0x2222222222222222222222222222222222222222' as const;

  it('binds a receivable to an instrument and reports it as claimed', async () => {
    const { registry, issuer } = await deploy();
    const hash = await registry.read.computeHash([DEBTOR, INVOICE_REF, FACE]);

    assert.equal(await registry.read.isClaimed([hash]), false);
    assert.equal(await registry.read.instrumentOf([hash]), zeroAddress);

    await viem.assertions.emitWithArgs(
      registry.write.claim([hash, INSTRUMENT_A], { account: issuer.account }),
      registry,
      'Claimed',
      [hash, INSTRUMENT_A, issuer.account.address],
    );

    assert.equal(await registry.read.isClaimed([hash]), true);
    assert.equal(
      (await registry.read.instrumentOf([hash])).toLowerCase(),
      INSTRUMENT_A.toLowerCase(),
    );
  });

  /**
   * The anti-double-pledge control, stated directly. This is the test that would have to fail for
   * the same receivable to be sold to two financiers.
   */
  it('rejects a second claim on the same receivable', async () => {
    const { registry, issuer } = await deploy();
    const hash = await registry.read.computeHash([DEBTOR, INVOICE_REF, FACE]);

    await registry.write.claim([hash, INSTRUMENT_A], { account: issuer.account });

    await viem.assertions.revertWithCustomError(
      registry.write.claim([hash, INSTRUMENT_B], { account: issuer.account }),
      registry,
      'AlreadyClaimed',
    );

    // The binding is unchanged. This is the assertion that matters more than the revert: a failed
    // second claim must not have partially written anything.
    assert.equal(
      (await registry.read.instrumentOf([hash])).toLowerCase(),
      INSTRUMENT_A.toLowerCase(),
    );
  });

  /**
   * A repeat of an identical (hash, instrument) pair is still refused. Letting it through would mean
   * a duplicated issuance run looks indistinguishable from a fresh one.
   */
  it('rejects a repeat claim even when the instrument is identical', async () => {
    const { registry, issuer } = await deploy();
    const hash = await registry.read.computeHash([DEBTOR, INVOICE_REF, FACE]);

    await registry.write.claim([hash, INSTRUMENT_A], { account: issuer.account });

    await viem.assertions.revertWithCustomError(
      registry.write.claim([hash, INSTRUMENT_A], { account: issuer.account }),
      registry,
      'AlreadyClaimed',
    );
  });

  /**
   * Correcting any of the three committed fields produces a different receivable, which is the
   * escape hatch that makes an irreversible registry tolerable. A $40,000 invoice and a $41,000 one
   * are not the same claim, so a corrected amount is not blocked by the original.
   */
  it('treats a different face value as a different receivable', async () => {
    const { registry, issuer } = await deploy();
    const hash = await registry.read.computeHash([DEBTOR, INVOICE_REF, FACE]);
    const corrected = await registry.read.computeHash([DEBTOR, INVOICE_REF, FACE + 1_000_000_000n]);

    assert.notEqual(hash, corrected);

    await registry.write.claim([hash, INSTRUMENT_A], { account: issuer.account });
    await registry.write.claim([corrected, INSTRUMENT_B], { account: issuer.account });

    assert.equal(await registry.read.isClaimed([corrected]), true);
  });

  /**
   * Writes are permissioned precisely because the binding is permanent: an open registry could be
   * front-run to burn a hash forever. See {IUniquenessRegistry-setIssuer}.
   */
  it('refuses claims from an address that is not an issuer', async () => {
    const { registry, stranger } = await deploy();
    const hash = await registry.read.computeHash([DEBTOR, INVOICE_REF, FACE]);

    await viem.assertions.revertWithCustomError(
      registry.write.claim([hash, INSTRUMENT_A], { account: stranger.account }),
      registry,
      'NotIssuer',
    );
  });

  it('rejects the zero hash and the zero instrument', async () => {
    const { registry, issuer } = await deploy();
    const hash = await registry.read.computeHash([DEBTOR, INVOICE_REF, FACE]);

    await viem.assertions.revertWithCustomError(
      registry.write.claim([zeroHash, INSTRUMENT_A], { account: issuer.account }),
      registry,
      'ZeroHash',
    );

    await viem.assertions.revertWithCustomError(
      registry.write.claim([hash, zeroAddress], { account: issuer.account }),
      registry,
      'ZeroInstrument',
    );
  });

  it('domain-separates its commitment', async () => {
    const { registry } = await deploy();
    const hash = await registry.read.computeHash([DEBTOR, INVOICE_REF, FACE]);

    // An undomained keccak over the same three fields must not collide with the registry's.
    const naive = keccak256(
      `0x${DEBTOR.slice(2)}${INVOICE_REF.slice(2)}${FACE.toString(16).padStart(64, '0')}`,
    );
    assert.notEqual(hash, naive);
  });

  it('requires two steps to move ownership', async () => {
    const { registry, owner, stranger } = await deploy();

    await registry.write.transferOwnership([stranger.account.address]);
    // Nomination alone changes nothing.
    assert.equal((await registry.read.owner()).toLowerCase(), owner.account.address.toLowerCase());

    await registry.write.acceptOwnership({ account: stranger.account });
    assert.equal(
      (await registry.read.owner()).toLowerCase(),
      stranger.account.address.toLowerCase(),
    );
  });
});
