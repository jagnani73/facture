/**
 * The Hedera side of the paper: ATS issuance and the ATS hold that carries the asset leg.
 *
 * One adapter, two consumers — `services/issuance.ts` deploys, `services/settlement.ts`
 * holds, executes and releases. Both go through this interface so there is exactly one
 * place that knows how a Hedera transaction is built, signed and read back.
 *
 * ## Read this before pointing it at a real factory
 *
 * **The ABI fragments below are transcribed, not generated from a deployed factory.** ATS
 * is a ~94-facet diamond that Facture neither deploys nor controls, and a facet upgrade can
 * reorder a struct or change a selector. Nothing here guesses quietly:
 *
 * - `ATS_FACTORY_ID` unset means issuance is **disabled**, not simulated. Every call fails
 *   naming the variable. A plausible-looking security id for an instrument that does not
 *   exist would survive exactly as far as the proof view, which is the one screen whose
 *   whole job is to be checkable.
 * - When it is set, calldata is encoded from {@link ATS_ABI} and submitted for real. A
 *   drifted selector comes back as `CONTRACT_REVERT_EXECUTED`, which `isRetryable`
 *   classifies as terminal, so the invoice fails visibly on the first attempt instead of
 *   burning six.
 *
 * ## Two decisions that are not adjustable
 *
 * - **`identityRegistry` and `compliance` stay at `address(0)`.** Compliance lives on each
 *   security's own `ControlList` and `Kyc` facets. The ERC-3643 registry interface is
 *   `isVerified(address)` with no token parameter, so many securities pointing at one
 *   registry share a single global allowlist — and per-invoice cohorts would need a
 *   registry deployment each.
 * - **The coupon rate stays at the `0` it initialises to.** The instrument is a
 *   zero-coupon bond by construction: maturity is the invoice due date, principal is the
 *   face value, and the discount is the yield.
 */

import {
  AccountId,
  Client,
  ContractExecuteTransaction,
  ContractId,
  PrivateKey,
} from '@hiero-ledger/sdk';
import { REGULATIONS, type RegulationKey } from '@facture/shared';
import { encodeFunctionData, type Address, type Hex } from 'viem';
import { hedera } from '../chain.js';
import { badRequest, upstreamUnavailable } from '../errors.js';
import type { Logger } from '../logger.js';
import { rootLogger } from '../logger.js';
import type { DeployedSecurity, IssuanceJob } from './issuance.js';

/**
 * Transcribed ATS surface. Verify every entry against the pinned release before the first
 * real submission — see the module header for why this is a warning and not a note.
 *
 * `deployBond` takes the two structs ATS calls `SecurityData` and `BondDetailsData`. Only
 * the members Facture sets are named here; the tuple order is what matters to the encoder,
 * and it is the thing most likely to drift.
 */
export const ATS_ABI = [
  {
    type: 'function',
    name: 'deployBond',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'security',
        type: 'tuple',
        components: [
          { name: 'isin', type: 'string' },
          { name: 'name', type: 'string' },
          { name: 'symbol', type: 'string' },
          { name: 'decimals', type: 'uint8' },
          { name: 'isWhiteList', type: 'bool' },
          { name: 'isControllable', type: 'bool' },
          { name: 'arePartitionsProtected', type: 'bool' },
          { name: 'clearingActive', type: 'bool' },
          { name: 'internalKycActivated', type: 'bool' },
          { name: 'identityRegistry', type: 'address' },
          { name: 'compliance', type: 'address' },
          { name: 'regulationType', type: 'uint8' },
          { name: 'regulationSubType', type: 'uint8' },
        ],
      },
      {
        name: 'bond',
        type: 'tuple',
        components: [
          { name: 'currency', type: 'bytes3' },
          { name: 'nominalValue', type: 'uint256' },
          { name: 'startingDate', type: 'uint256' },
          { name: 'maturityDate', type: 'uint256' },
          { name: 'couponFrequency', type: 'uint256' },
          { name: 'couponRate', type: 'uint256' },
          { name: 'firstCouponDate', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'security', type: 'address' }],
  },
  {
    type: 'function',
    name: 'createHoldByPartition',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'partition', type: 'bytes32' },
      {
        name: 'hold',
        type: 'tuple',
        components: [
          { name: 'amount', type: 'uint256' },
          { name: 'expirationTimestamp', type: 'uint256' },
          { name: 'escrow', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      { name: 'success', type: 'bool' },
      { name: 'holdId', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'executeHoldByPartition',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'partition', type: 'bytes32' },
      { name: 'tokenHolder', type: 'address' },
      { name: 'holdId', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'releaseHoldByPartition',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'partition', type: 'bytes32' },
      { name: 'tokenHolder', type: 'address' },
      { name: 'holdId', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
] as const;

/** ATS's default partition. Lockup/clearing segmentation, never a sub-instrument. */
export const DEFAULT_PARTITION: Hex = `0x${'0'.repeat(63)}1`;

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/** Bond units are whole receivables: one invoice, one unit, no fractions. */
const SECURITY_DECIMALS = 0;

export interface HoldRequest {
  readonly securityId: string;
  readonly holderEvmAddress: Address;
  readonly toEvmAddress: Address;
  readonly escrowEvmAddress: Address;
  readonly units: bigint;
  readonly expiresAt: Date;
}

export interface HoldReceipt {
  readonly holdId: string;
  readonly transactionId: string;
  readonly consensusAt: string;
}

export interface AtsAdapter {
  deployBond(job: IssuanceJob): Promise<DeployedSecurity>;
  createHold(request: HoldRequest): Promise<HoldReceipt>;
  executeHold(input: {
    securityId: string;
    holderEvmAddress: Address;
    toEvmAddress: Address;
    holdId: string;
    units: bigint;
  }): Promise<{ transactionId: string; consensusAt: string }>;
  releaseHold(input: {
    securityId: string;
    holderEvmAddress: Address;
    holdId: string;
    units: bigint;
  }): Promise<{ transactionId: string; consensusAt: string }>;
}

export interface AtsAdapterConfig {
  readonly operatorId: string;
  readonly operatorKey: string;
  readonly factoryId: string | undefined;
  readonly regulation: RegulationKey;
  readonly gasLimit: number;
  readonly network: string;
  readonly logger?: Logger | undefined;
}

/** Map the env spelling onto shared's regulation table, which owns the ATS enum values. */
export function regulationKeyFor(value: 'reg-d-506b' | 'reg-d-506c' | 'reg-s'): RegulationKey {
  switch (value) {
    case 'reg-d-506b':
      return 'REG_D_506_B';
    case 'reg-d-506c':
      return 'REG_D_506_C';
    case 'reg-s':
      return 'REG_S';
  }
}

/**
 * Issuance and settlement with no factory configured.
 *
 * Every method fails naming `ATS_FACTORY_ID`, which is what `.env.example` promises the
 * variable does. The alternative — synthesising an instrument so the demo looks complete —
 * would put an unverifiable token id on the one screen whose whole purpose is to be
 * verified.
 */
export function createDisabledAtsAdapter(): AtsAdapter {
  const refuse = (what: string): never => {
    throw badRequest(
      `${what} needs an ATS factory. ATS_FACTORY_ID is not set, so issuance and asset-leg ` +
        'settlement are disabled on this deployment.',
    );
  };
  return {
    deployBond: (job) => refuse(`Issuing invoice ${job.invoiceId}`),
    createHold: (request) => refuse(`Holding ${request.securityId}`),
    executeHold: (input) => refuse(`Executing the hold on ${input.securityId}`),
    releaseHold: (input) => refuse(`Releasing the hold on ${input.securityId}`),
  };
}

export function createHederaAtsAdapter(config: AtsAdapterConfig): AtsAdapter {
  if (config.factoryId === undefined) return createDisabledAtsAdapter();

  const factoryId = config.factoryId;
  const log = (config.logger ?? rootLogger).child({ svc: 'ats' });

  /*
   * ECDSA explicitly, never `fromString`. An ED25519 key holds HBAR and HTS perfectly well
   * and then cannot sign an EVM transaction, and the failure surfaces late as
   * INVALID_SIGNATURE from inside the relay. `env.ts` rejects an ED25519 key at boot; this
   * is the second half of the same guard.
   */
  const client = Client.forName(config.network).setOperator(
    AccountId.fromString(config.operatorId),
    PrivateKey.fromStringECDSA(config.operatorKey),
  );

  async function submit(
    contractId: string,
    calldata: Hex,
    what: string,
  ): Promise<{
    transactionId: string;
    consensusAt: string;
    gasUsed: number;
    returned: Uint8Array;
    createdContract: string | null;
  }> {
    try {
      const response = await new ContractExecuteTransaction()
        .setContractId(ContractId.fromString(contractId))
        .setGas(config.gasLimit)
        .setFunctionParameters(hexToBytes(calldata))
        .execute(client);

      const record = await response.getRecord(client);
      const result = record.contractFunctionResult;

      return {
        transactionId: record.transactionId.toString(),
        consensusAt: record.consensusTimestamp.toDate().toISOString(),
        gasUsed: result ? Number(result.gasUsed.toString()) : 0,
        returned: result?.bytes ?? new Uint8Array(),
        createdContract: result?.contractId?.toString() ?? null,
      };
    } catch (err) {
      // Rethrown unchanged: the issuance queue classifies BUSY and friends as retryable by
      // reading the message, and wrapping it here would hide the status it reads.
      log.warn('hedera submission failed', { what, contractId, err });
      throw err;
    }
  }

  return {
    async deployBond(job) {
      const regulation = REGULATIONS[config.regulation];
      const calldata = encodeFunctionData({
        abi: ATS_ABI,
        functionName: 'deployBond',
        args: [
          {
            isin: job.isin,
            name: job.name,
            symbol: job.symbol,
            decimals: SECURITY_DECIMALS,
            isWhiteList: true,
            isControllable: true,
            arePartitionsProtected: false,
            clearingActive: false,
            /** The security's own Kyc facet, which is what the pre-match check reads. */
            internalKycActivated: true,
            identityRegistry: ZERO_ADDRESS,
            compliance: ZERO_ADDRESS,
            regulationType: regulation.regulationType,
            regulationSubType: regulation.regulationSubType,
          },
          {
            currency: currencyBytes3(job.currency),
            nominalValue: job.faceValue,
            startingDate: BigInt(Math.floor(Date.now() / 1000)),
            maturityDate: BigInt(Math.floor(job.maturityAt.getTime() / 1000)),
            // Zero-coupon: no schedule, no rate, no first coupon date. The coupon-listing
            // path in ATS also has a known regression, so there is nothing to lean on here.
            couponFrequency: 0n,
            couponRate: 0n,
            firstCouponDate: 0n,
          },
        ],
      });

      const receipt = await submit(factoryId, calldata, `deployBond ${job.invoiceId}`);
      const evmAddress = decodeAddress(receipt.returned);
      const securityId = receipt.createdContract ?? evmAddressToAccountId(evmAddress);

      log.info('bond deployed', {
        invoiceId: job.invoiceId,
        securityId,
        gasUsed: receipt.gasUsed,
        isin: job.isin,
      });

      return {
        securityId,
        evmAddress,
        transactionId: receipt.transactionId,
        gasUsed: receipt.gasUsed,
      };
    },

    async createHold(request) {
      const calldata = encodeFunctionData({
        abi: ATS_ABI,
        functionName: 'createHoldByPartition',
        args: [
          DEFAULT_PARTITION,
          {
            amount: request.units,
            expirationTimestamp: BigInt(Math.floor(request.expiresAt.getTime() / 1000)),
            escrow: request.escrowEvmAddress,
            to: request.toEvmAddress,
            data: '0x',
          },
        ],
      });

      const receipt = await submit(request.securityId, calldata, 'createHoldByPartition');
      return {
        holdId: decodeHoldId(receipt.returned),
        transactionId: receipt.transactionId,
        consensusAt: receipt.consensusAt,
      };
    },

    async executeHold(input) {
      const calldata = encodeFunctionData({
        abi: ATS_ABI,
        functionName: 'executeHoldByPartition',
        args: [
          DEFAULT_PARTITION,
          input.holderEvmAddress,
          BigInt(input.holdId),
          input.units,
          input.toEvmAddress,
        ],
      });
      const receipt = await submit(input.securityId, calldata, 'executeHoldByPartition');
      return { transactionId: receipt.transactionId, consensusAt: receipt.consensusAt };
    },

    async releaseHold(input) {
      const calldata = encodeFunctionData({
        abi: ATS_ABI,
        functionName: 'releaseHoldByPartition',
        args: [DEFAULT_PARTITION, input.holderEvmAddress, BigInt(input.holdId), input.units],
      });
      const receipt = await submit(input.securityId, calldata, 'releaseHoldByPartition');
      return { transactionId: receipt.transactionId, consensusAt: receipt.consensusAt };
    },
  };
}

let adapter: AtsAdapter | undefined;

export function initAtsAdapter(config: AtsAdapterConfig): AtsAdapter {
  adapter = createHederaAtsAdapter(config);
  return adapter;
}

/** Tests and the offline demo swap the whole adapter rather than stubbing the SDK. */
export function setAtsAdapter(next: AtsAdapter | undefined): void {
  adapter = next;
}

export function getAtsAdapter(): AtsAdapter {
  adapter ??= createDisabledAtsAdapter();
  return adapter;
}

// --- encoding helpers -------------------------------------------------------------

function hexToBytes(hex: Hex): Uint8Array {
  const body = hex.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1)
    out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** ATS stores the currency as `bytes3` — `USD`, not a code table lookup. */
function currencyBytes3(currency: string): Hex {
  if (currency.length !== 3) {
    throw badRequest(`Currency must be a three-letter code; got "${currency}".`);
  }
  return `0x${[...currency].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')}`;
}

/** Last 20 bytes of a 32-byte ABI word. */
function decodeAddress(returned: Uint8Array): Address {
  if (returned.length < 32) {
    throw upstreamUnavailable('Hedera', 'deployBond returned no security address.');
  }
  return `0x${toHex(returned.subarray(12, 32))}`;
}

/**
 * `createHoldByPartition` returns `(bool success, uint256 holdId)`; the id is the second
 * word. Kept as a decimal string because it goes straight onto the trade row and into a
 * later `executeHoldByPartition` — a `number` would silently round past 2^53.
 */
function decodeHoldId(returned: Uint8Array): string {
  if (returned.length < 64) {
    throw upstreamUnavailable('Hedera', 'createHoldByPartition returned no hold id.');
  }
  return BigInt(`0x${toHex(returned.subarray(32, 64))}`).toString(10);
}

/**
 * Fallback when the record carries no created-contract id. A long-zero EVM address encodes
 * the entity number directly, which is the only case where the conversion is exact —
 * anything else needs a mirror-node lookup and is reported as unknown rather than guessed.
 */
function evmAddressToAccountId(evmAddress: Address): string {
  const body = evmAddress.slice(2).toLowerCase();
  if (!body.startsWith('0'.repeat(24))) {
    throw upstreamUnavailable(
      'Hedera',
      `Security deployed at ${evmAddress}, which is not a long-zero address; its 0.0.x id ` +
        'must be read from the mirror node.',
    );
  }
  return `0.0.${BigInt(`0x${body.slice(24)}`).toString(10)}`;
}

export const hederaNetworkName = (): string => hedera.network;

/**
 * `0.0.x` -> the EVM address the JSON-RPC relay and the ATS facets speak.
 *
 * Accounts and contracts on Hedera carry both forms and different APIs want different
 * ones: x402 `PaymentRequirements` reference HTS assets by `0.0.x`, while every ATS facet
 * argument is an `address`. Converting in one place is what stops the two drifting.
 *
 * A missing or malformed id returns the zero address rather than something plausible. The
 * ATS call then reverts, which is the correct outcome for a counterparty with no Hedera
 * account on file — inventing an address would move a security to nobody.
 */
export function accountIdToEvmAddress(accountId: string | null | undefined): Address {
  if (accountId === null || accountId === undefined) return ZERO_ADDRESS;
  if (/^0x[0-9a-fA-F]{40}$/.test(accountId)) return accountId as Address;
  if (!/^\d+\.\d+\.\d+$/.test(accountId)) return ZERO_ADDRESS;
  const raw = AccountId.fromString(accountId).toEvmAddress();
  const body = raw.startsWith('0x') ? raw.slice(2) : raw;
  return `0x${body.toLowerCase()}`;
}

export { ZERO_ADDRESS };
