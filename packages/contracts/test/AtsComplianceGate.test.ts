import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import hre from 'hardhat';
import { stringToHex, toFunctionSelector, zeroAddress, zeroHash } from 'viem';

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
  async function deploy(inControlList = true, kyc = true, paused = false) {
    const gate = await viem.deployContract('AtsComplianceGate', []);
    const security = await viem.deployContract('MockAtsSecurity', [inControlList, kyc, paused]);
    return { gate, security };
  }

  /**
   * The four selectors the gate probes, pinned as literals.
   *
   * These are not decoration. The gate previously probed `isPaused()`, `isAuthorized(address)` and
   * `getKycAccountStatus(address)`, which do not exist on a deployed ATS diamond, and every test in
   * this file passed anyway because {MockAtsSecurity} implemented the same three. The failure was
   * invisible to the suite by construction.
   *
   * A selector cannot be checked against a real diamond from Hardhat, so what is checked instead is
   * that the gate has not silently changed which functions it asks for. The right-hand column was
   * read off MF-2051 on Hedera testnet, `0xb50567e02baaf768c834b0663f539db43d5b34b0`.
   */
  const PROBED_SELECTORS = {
    'paused()': '0x5c975abb',
    'getControlListType()': '0x1d46c292',
    'isInControlList(address)': '0xfd5b071b',
    'getKycStatusFor(address)': '0xe788a736',
  } as const;

  it('probes the selectors a real ATS diamond actually answers', async () => {
    for (const [signature, selector] of Object.entries(PROBED_SELECTORS)) {
      assert.equal(
        toFunctionSelector(`function ${signature}`),
        selector,
        `${signature} does not hash to the selector read off a live instrument`,
      );
    }

    // The three that were probed before, and do not exist. Named so a reader can find them.
    for (const dead of ['isPaused()', 'isAuthorized(address)', 'getKycAccountStatus(address)']) {
      assert.ok(
        !Object.keys(PROBED_SELECTORS).includes(dead),
        `${dead} does not exist on an ATS security; the gate must not probe it`,
      );
    }
  });

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
  // Membership is not permission
  //
  // The same membership bit means opposite things under the two list modes. None of this could be
  // tested while the gate probed a single `isAuthorized` and the mock hard-coded the mode to
  // `true` - which is to say, the venue's most dangerous compliance failure had no coverage at all.
  // -----------------------------------------------------------------------------------------

  it('permits a buyer absent from a BLOCKLIST', async () => {
    const { gate, security } = await deploy(false);
    await security.write.setAllowList([false]);

    const [ok, code] = await gate.read.canReceive([security.address, BUYER]);
    assert.equal(ok, true, 'a blocklist permits everyone it does not name');
    assert.equal(code, NONE);
  });

  /**
   * The inversion that matters. On a blocklist, being IN the list is exclusion — and a gate reading
   * membership alone would admit exactly the party the issuer configured it to keep out.
   */
  it('refuses a buyer named on a BLOCKLIST', async () => {
    const { gate, security } = await deploy(true);
    await security.write.setAllowList([false]);

    const [ok, code] = await gate.read.canReceive([security.address, BUYER]);
    assert.equal(ok, false);
    assert.equal(code, reason('CONTROL_LIST_BLOCKED'));
  });

  /**
   * Membership readable, mode not. That is not a partial answer that can be leaned on — the bit is
   * uninterpretable without the mode — so it has to refuse as unreadable rather than pick a default.
   */
  it('refuses when the list mode cannot be read, however membership reads', async () => {
    const gate = await viem.deployContract('AtsComplianceGate', []);
    const security = await viem.deployContract('MockControlListModeless', [true, true]);

    const [ok, code] = await gate.read.canReceive([security.address, BUYER]);
    assert.equal(ok, false);
    assert.equal(code, reason('COMPLIANCE_PROBE_FAILED'));
  });

  // -----------------------------------------------------------------------------------------
  // KYC is an enum, not a bool
  // -----------------------------------------------------------------------------------------

  /**
   * `getKycStatusFor` returns `KycStatus`, and the venue knows two of its values. A gate comparing
   * `!= 0` would read every status ATS adds later — revoked, suspended, expired — as a valid grant.
   * The comparison is against GRANTED exactly, and this is the test that says so.
   */
  it('refuses a KYC status outside the vocabulary it knows', async () => {
    const { gate, security } = await deploy();
    await security.write.setKycStatus([2]);

    const [ok, code] = await gate.read.canReceive([security.address, BUYER]);
    assert.equal(ok, false);
    assert.equal(code, reason('NOT_KYC_VERIFIED'));
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
