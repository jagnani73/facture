import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import hre from 'hardhat';
import { stringToHex, zeroAddress, zeroHash } from 'viem';

const { viem } = await hre.network.getOrCreate();

const reason = (code: string) => stringToHex(code, { size: 32 });
const NONE = zeroHash;

const BUYER = '0x2222222222222222222222222222222222222222' as const;

/**
 * The gate's contract with the rest of the venue is narrow but strict: it must ANSWER, always, and
 * it must fail closed. Most of what follows is therefore about misbehaviour rather than about the
 * happy path, because a gate that reverts would take down `previewMatch` for every invoice on the
 * venue, and a gate that returns `true` when it could not reach the instrument would let an illegal
 * trade through.
 */
describe('AtsComplianceGate', () => {
  async function deploy(authorized = true, kyc = true, paused = false) {
    const gate = await viem.deployContract('AtsComplianceGate', []);
    const security = await viem.deployContract('MockAtsSecurity', [authorized, kyc, paused]);
    return { gate, security };
  }

  it('permits a buyer the instrument authorises and has KYC-ed', async () => {
    const { gate, security } = await deploy();
    const [ok, code] = await gate.read.canReceive([security.address, BUYER]);
    assert.equal(ok, true);
    assert.equal(code, NONE);
  });

  it('refuses a buyer the control list blocks', async () => {
    const { gate, security } = await deploy(false, true, false);
    const [ok, code] = await gate.read.canReceive([security.address, BUYER]);
    assert.equal(ok, false);
    assert.equal(code, reason('CONTROL_LIST_BLOCKED'));
  });

  it('refuses a buyer without a KYC grant on this security', async () => {
    const { gate, security } = await deploy(true, false, false);
    const [ok, code] = await gate.read.canReceive([security.address, BUYER]);
    assert.equal(ok, false);
    assert.equal(code, reason('NOT_KYC_VERIFIED'));
  });

  /**
   * Checked before the buyer-specific probes so an eligible buyer is never told they are the
   * problem when in fact no transfer to anyone would succeed.
   */
  it('reports a paused instrument ahead of any buyer-specific refusal', async () => {
    const { gate, security } = await deploy(false, false, true);
    const [ok, code] = await gate.read.canReceive([security.address, BUYER]);
    assert.equal(ok, false);
    assert.equal(code, reason('INSTRUMENT_PAUSED'));
  });

  // -----------------------------------------------------------------------------------------
  // Failing closed
  // -----------------------------------------------------------------------------------------

  /** An address with no facets at all - the commonest wiring mistake - must refuse, not revert. */
  it('refuses an address that is not a contract', async () => {
    const { gate } = await deploy();
    const [ok, code] = await gate.read.canReceive([BUYER, BUYER]);
    assert.equal(ok, false);
    assert.equal(code, reason('COMPLIANCE_PROBE_FAILED'));
  });

  it('refuses when a facet reverts', async () => {
    const { gate, security } = await deploy();
    await security.write.setRevertMode([true]);

    const [ok, code] = await gate.read.canReceive([security.address, BUYER]);
    assert.equal(ok, false);
    assert.equal(code, reason('COMPLIANCE_PROBE_FAILED'));
  });

  /**
   * The probe gas cap exists so a pathological instrument cannot burn the matcher's gas. Running out
   * of the cap has to look like any other unanswerable probe.
   */
  it('refuses when a facet exhausts the probe gas allowance', async () => {
    const { gate, security } = await deploy();
    await security.write.setGasBurnMode([true]);

    const [ok, code] = await gate.read.canReceive([security.address, BUYER]);
    assert.equal(ok, false);
    assert.equal(code, reason('COMPLIANCE_PROBE_FAILED'));
  });

  /**
   * A facet returning a word that is neither 0 nor 1 would make `abi.decode(_, (bool))` revert. The
   * gate decodes as a word and compares specifically so that it does not. The assertion that matters
   * is that the call RETURNS - what it decides about a garbage word is secondary.
   */
  it('does not revert on an undecodable boolean', async () => {
    const { gate, security } = await deploy();
    await security.write.setGarbageMode([true]);

    const [ok] = await gate.read.canReceive([security.address, BUYER]);
    assert.equal(typeof ok, 'boolean');
  });

  it('refuses zero addresses without reverting', async () => {
    const { gate, security } = await deploy();

    const [okA, codeA] = await gate.read.canReceive([zeroAddress, BUYER]);
    assert.equal(okA, false);
    assert.equal(codeA, reason('COMPLIANCE_PROBE_FAILED'));

    const [okB, codeB] = await gate.read.canReceive([security.address, zeroAddress]);
    assert.equal(okB, false);
    assert.equal(codeB, reason('COMPLIANCE_PROBE_FAILED'));
  });
});
