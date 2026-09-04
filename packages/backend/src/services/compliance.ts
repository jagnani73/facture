/**
 * The pre-match compliance check.
 *
 * This is the ordering the whole venue argument rests on. An AMM matches first and
 * discovers the transfer was illegal afterwards, so non-compliance surfaces as a revert
 * nobody can read. Here the check runs **before** the match: an ineligible counterparty is
 * never matched, and the refusal is a first-class output with a sentence attached.
 *
 * Three reads, against the security's own diamond and nothing else:
 *
 * - `isAuthorized(address)` on the instrument's `ControlList`
 * - `getKycAccountStatus(address)` on the instrument's `Kyc`
 * - `isPaused()` — a paused instrument would refuse delivery whoever the buyer is, so
 *   catching it here turns a failed settlement into a named refusal
 *
 * **Not the ERC-3643 `IdentityRegistry`.** Its interface is `isVerified(address)` with no
 * token parameter, so many securities pointing at one registry share a single global
 * allowlist and per-invoice cohorts would need a registry deployment each. `ControlList`
 * and `Kyc` live on the security's own diamond, cost no extra deployment, and are already
 * scoped per instrument.
 *
 * **It fails closed.** A probe that reverts, times out or returns undecodable data is
 * `COMPLIANCE_PROBE_FAILED` and the trade is refused. A selector that has drifted between
 * ATS releases therefore produces a named refusal, never a silent `true`.
 */

import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { hedera } from '../chain.js';
import type { Logger } from '../logger.js';
import { rootLogger } from '../logger.js';

export interface ComplianceCheck {
  readonly name: string;
  readonly detail: string;
  readonly passed: boolean;
}

export interface ComplianceDecision {
  readonly decision: 'allowed' | 'refused';
  readonly checkedAt: string;
  readonly checks: readonly ComplianceCheck[];
  /** Set when refused: the first check that failed, in words. */
  readonly reason: string | null;
}

export interface ComplianceQuery {
  /** EVM address of the ATS security diamond. */
  readonly instrumentAddress: Address;
  /** The prospective holder, as an EVM address. */
  readonly buyerEvmAddress: Address;
  /** For the sentence only — a buyer reads a name, not an address. */
  readonly buyerName?: string | undefined;
}

export interface ComplianceGate {
  check(query: ComplianceQuery): Promise<ComplianceDecision>;
}

const CONTROL_LIST_ABI = [
  {
    type: 'function',
    name: 'isAuthorized',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
] as const;

const KYC_ABI = [
  {
    type: 'function',
    name: 'getKycAccountStatus',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
] as const;

const PAUSE_ABI = [
  {
    type: 'function',
    name: 'isPaused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
] as const;

const decide = (checks: readonly ComplianceCheck[], checkedAt: string): ComplianceDecision => {
  const failed = checks.find((c) => !c.passed);
  return {
    decision: failed ? 'refused' : 'allowed',
    checkedAt,
    checks,
    reason: failed ? failed.detail : null,
  };
};

/** Reads the three facets over Hedera's JSON-RPC relay. */
export function createAtsComplianceGate(options: { logger?: Logger } = {}): ComplianceGate {
  const log = (options.logger ?? rootLogger).child({ svc: 'compliance' });
  const client: PublicClient = createPublicClient({ transport: http(hedera.jsonRpcUrl) });

  return {
    async check(query) {
      const checkedAt = new Date().toISOString();
      const who = query.buyerName ?? query.buyerEvmAddress;

      const probe = async (
        name: string,
        read: () => Promise<boolean>,
        onTrue: string,
        onFalse: string,
      ): Promise<ComplianceCheck> => {
        try {
          const value = await read();
          return { name, detail: value ? onTrue : onFalse, passed: value };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn('compliance probe failed', { name, instrument: query.instrumentAddress, err });
          return {
            name,
            detail:
              `COMPLIANCE_PROBE_FAILED: ${name} could not be read on this instrument ` +
              `(${message}). The trade is refused rather than assumed eligible.`,
            passed: false,
          };
        }
      };

      const [controlList, kyc, paused] = await Promise.all([
        probe(
          'Control list',
          () =>
            client.readContract({
              address: query.instrumentAddress,
              abi: CONTROL_LIST_ABI,
              functionName: 'isAuthorized',
              args: [query.buyerEvmAddress],
            }) as Promise<boolean>,
          `${who} is permitted to hold this security.`,
          `${who} is not permitted to hold this security by its control list.`,
        ),
        probe(
          'KYC status',
          () =>
            client.readContract({
              address: query.instrumentAddress,
              abi: KYC_ABI,
              functionName: 'getKycAccountStatus',
              args: [query.buyerEvmAddress],
            }) as Promise<boolean>,
          `${who} holds a valid KYC grant on this security.`,
          `${who} does not hold a KYC grant on this security, so it cannot receive it.`,
        ),
        probe(
          'Transfers enabled',
          async () =>
            !((await client.readContract({
              address: query.instrumentAddress,
              abi: PAUSE_ABI,
              functionName: 'isPaused',
            })) as boolean),
          'Transfers of this security are not paused.',
          'Transfers of this security are paused, so delivery would fail.',
        ),
      ]);

      return decide([controlList, kyc, paused], checkedAt);
    },
  };
}

/**
 * Always allows, and says so in the recorded decision.
 *
 * For a deployment with no instrument on chain yet. The decision it writes names itself as
 * unenforced, so the proof view shows "not enforced on this deployment" rather than a row
 * of green ticks nobody performed.
 */
export function createPermissiveComplianceGate(): ComplianceGate {
  return {
    check(query) {
      return Promise.resolve(
        decide(
          [
            {
              name: 'Control list',
              detail:
                `Not enforced on this deployment: no instrument is deployed for this invoice, ` +
                `so ${query.buyerEvmAddress} was not checked against a control list.`,
              passed: true,
            },
          ],
          new Date().toISOString(),
        ),
      );
    },
  };
}

let gate: ComplianceGate | undefined;

export function setComplianceGate(next: ComplianceGate | undefined): void {
  gate = next;
}

export function getComplianceGate(): ComplianceGate {
  gate ??= createAtsComplianceGate();
  return gate;
}
