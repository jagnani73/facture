/**
 * The eligibility decision, read off a contract instead of out of this process.
 *
 * `AtsComplianceGate.canReceive` is what lets a refused party check the refusal without trusting
 * the venue: a free `eth_call` against a published address, returning a reason code from the same
 * vocabulary the venue's own refusals use. Wiring it is what makes that claim true rather than
 * architectural.
 *
 * The reason it needs its own test file is a defect found on 2026-09-06. The deployed gate probed
 * `isAuthorized`, `getKycAccountStatus` and `isPaused` — three selectors that do not exist on an
 * ATS diamond — so it refused every buyer on every instrument, including ones the instrument
 * affirmatively permits. It looked healthy for as long as nothing called it. The contract is fixed
 * and redeployed; what is tested here is the venue's behaviour if a gate is ever wrong again, which
 * is the case that decides whether handing a contract this decision was safe.
 */

import { describe, expect, it } from 'vitest';
import {
  createOnChainComplianceGate,
  createPermissiveComplianceGate,
  decodeReasonCode,
  type ComplianceDecision,
  type ComplianceGate,
  type ComplianceQuery,
} from '../src/services/compliance.js';

const GATE = '0x9a2c848ab62e715d2b49a4710f6451395978abbb' as const;
const INSTRUMENT = '0xb50567e02baaf768c834b0663f539db43d5b34b0' as const;
const BUYER = '0xa25796399a9b3e8006d2d45ff48a3b830c7f020b' as const;

const query: ComplianceQuery = {
  instrumentAddress: INSTRUMENT,
  buyerEvmAddress: BUYER,
  buyerName: 'Harrow Point',
};

/** A stand-in for the direct facet reads, so both halves of a disagreement are controllable. */
function facetsSaying(decision: 'allowed' | 'refused', unreadable = false): ComplianceGate {
  return {
    check: (): Promise<ComplianceDecision> =>
      Promise.resolve({
        decision,
        checkedAt: new Date().toISOString(),
        checks: [
          {
            name: 'Control list',
            detail: decision === 'allowed' ? 'permitted' : 'not permitted',
            passed: decision === 'allowed',
            ...(unreadable ? { unreadable: true } : {}),
          },
        ],
        reason: decision === 'refused' ? 'not permitted' : null,
        determinate: !unreadable,
      }),
  };
}

const gateWith = (
  answer: OnChainAnswer | Error,
  facets: ComplianceGate = facetsSaying('refused'),
): ComplianceGate =>
  createOnChainComplianceGate({
    gateAddress: GATE,
    facets,
    ask: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
  });

interface OnChainAnswer {
  readonly ok: boolean;
  readonly code: string;
}

describe('decodeReasonCode', () => {
  /**
   * `ReasonCodes` are right-padded ASCII rather than hashes, deliberately: a refused party reading
   * the raw return value sees the name, not a digest they would need a lookup table for. If that
   * ever became a hash the refusal would stop being self-describing, so the spelling is pinned.
   */
  it('reads a bytes32 reason code as the name it spells', () => {
    expect(
      decodeReasonCode('0x434f4e54524f4c5f4c4953545f424c4f434b4544000000000000000000000000'),
    ).toBe('CONTROL_LIST_BLOCKED');
    expect(
      decodeReasonCode('0x434f4d504c49414e43455f50524f42455f4641494c4544000000000000000000'),
    ).toBe('COMPLIANCE_PROBE_FAILED');
  });

  it('reads the zero word as NONE rather than as an empty refusal', () => {
    expect(
      decodeReasonCode('0x0000000000000000000000000000000000000000000000000000000000000000'),
    ).toBe('NONE');
  });
});

describe('createOnChainComplianceGate', () => {
  it('allows on the gate alone, without reading the facets', async () => {
    let facetReads = 0;
    const counting: ComplianceGate = {
      check: () => {
        facetReads += 1;
        return facetsSaying('allowed').check(query);
      },
    };

    const decision = await gateWith({ ok: true, code: 'NONE' }, counting).check(query);

    expect(decision.decision).toBe('allowed');
    expect(decision.determinate).toBe(true);
    expect(facetReads).toBe(0);
  });

  /**
   * One read on the happy path instead of four. `priceOne` runs this per candidate bid, so the
   * saving is on the path the book's whole no-N+1 design exists to protect.
   */
  it('names the call a reader can make themselves', async () => {
    const decision = await gateWith({ ok: true, code: 'NONE' }).check(query);
    const detail = decision.checks[0]?.detail ?? '';

    expect(detail).toContain('canReceive');
    expect(detail).toContain(INSTRUMENT);
    expect(detail).toContain(BUYER);
  });

  it('refuses with the code the chain returned, and the facets supply the sentence', async () => {
    const decision = await gateWith({ ok: false, code: 'CONTROL_LIST_BLOCKED' }).check(query);

    expect(decision.decision).toBe('refused');
    expect(decision.reason).toContain('CONTROL_LIST_BLOCKED');
    // An agreed refusal is a fact about this buyer, so a price may move on it.
    expect(decision.determinate).toBe(true);
    expect(decision.checks.length).toBeGreaterThan(1);
  });

  /**
   * THE ONE THAT MATTERS.
   *
   * The gate refuses and the instrument's own facets say the buyer is fine. That is what a broken
   * gate looks like from here — and it is exactly what the deployed gate did for five days, on
   * every instrument, while this file's direct reads were correct.
   *
   * It must refuse, because settlement cannot move money on a contradiction. It must ALSO be
   * indeterminate, because a contradiction is not a fact about this buyer: marking it determinate
   * would let a single bad gate deployment silently drop every bid from the curve and widen every
   * price on the book, which is the failure `ComplianceDecision.determinate` was introduced for.
   */
  it('refuses INDETERMINATELY when the gate and the instrument disagree', async () => {
    const decision = await gateWith(
      { ok: false, code: 'COMPLIANCE_PROBE_FAILED' },
      facetsSaying('allowed'),
    ).check(query);

    expect(decision.decision).toBe('refused');
    expect(decision.determinate).toBe(false);
    expect(decision.checks[0]?.unreadable).toBe(true);
    expect(decision.reason).toMatch(/say the opposite|One of the two is wrong/);
  });

  it('stays indeterminate when neither side could be read', async () => {
    const decision = await gateWith(
      { ok: false, code: 'COMPLIANCE_PROBE_FAILED' },
      facetsSaying('refused', true),
    ).check(query);

    expect(decision.decision).toBe('refused');
    expect(decision.determinate).toBe(false);
  });

  /**
   * A gate that cannot be reached is not a fact about this buyer either. Refuse, and say the
   * instrument was never asked — the distinction `/health` and the proof view's registry block
   * both make, in a third place.
   */
  it('refuses indeterminately when the gate itself is unreachable', async () => {
    const decision = await gateWith(new Error('relay down')).check(query);

    expect(decision.decision).toBe('refused');
    expect(decision.determinate).toBe(false);
    expect(decision.reason).toContain('COMPLIANCE_PROBE_FAILED');
    expect(decision.reason).toContain('relay down');
  });
});

describe('createPermissiveComplianceGate', () => {
  /** It allows, and the recorded decision says it was not enforced rather than showing a tick. */
  it('records itself as unenforced rather than as a passed check', async () => {
    const decision = await createPermissiveComplianceGate().check(query);

    expect(decision.decision).toBe('allowed');
    expect(decision.checks[0]?.detail).toContain('Not enforced on this deployment');
  });
});
