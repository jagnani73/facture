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
import {
  createPublicClient,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
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
  /*
   * The real `deployBond`, transcribed from the deployed factory rather than from a doc.
   *
   * The previous shape here was a plausible-looking flattening of it and encoded to selector
   * `0x58a038dd`, which the diamond does not have — so every call reverted with
   * `FunctionNotFound(bytes4)` (`0x5416eb98`) after 45,540 gas. That failure is quiet in the
   * worst way: it looks like a contract problem rather than an encoding one, and it means
   * backend issuance had never once succeeded. {@link DEPLOY_BOND_SELECTOR} exists so the
   * next drift of this kind is caught before a transaction is paid for.
   */
  {
    type: 'function',
    name: 'deployBond',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: '_bondData',
        type: 'tuple',
        components: [
          {
            name: 'security',
            type: 'tuple',
            components: [
              { name: 'resolver', type: 'address' },
              { name: 'maxSupply', type: 'uint256' },
              {
                name: 'resolverProxyConfiguration',
                type: 'tuple',
                components: [
                  { name: 'key', type: 'bytes32' },
                  { name: 'version', type: 'uint256' },
                ],
              },
              {
                name: 'erc20MetadataInfo',
                type: 'tuple',
                components: [
                  { name: 'name', type: 'string' },
                  { name: 'symbol', type: 'string' },
                  { name: 'isin', type: 'string' },
                  { name: 'decimals', type: 'uint8' },
                ],
              },
              {
                name: 'rbacs',
                type: 'tuple[]',
                components: [
                  { name: 'role', type: 'bytes32' },
                  { name: 'members', type: 'address[]' },
                ],
              },
              { name: 'externalPauses', type: 'address[]' },
              { name: 'externalControlLists', type: 'address[]' },
              { name: 'externalKycLists', type: 'address[]' },
              { name: 'compliance', type: 'address' },
              { name: 'identityRegistry', type: 'address' },
              { name: 'arePartitionsProtected', type: 'bool' },
              { name: 'isMultiPartition', type: 'bool' },
              { name: 'isControllable', type: 'bool' },
              { name: 'isWhiteList', type: 'bool' },
              { name: 'clearingActive', type: 'bool' },
              { name: 'internalKycActivated', type: 'bool' },
              { name: 'erc20VotesActivated', type: 'bool' },
            ],
          },
          {
            name: 'bondDetails',
            type: 'tuple',
            components: [
              { name: 'currency', type: 'bytes3' },
              { name: 'nominalValue', type: 'uint256' },
              { name: 'nominalValueDecimals', type: 'uint8' },
              { name: 'startingDate', type: 'uint256' },
              { name: 'maturityDate', type: 'uint256' },
            ],
          },
          { name: 'proceedRecipients', type: 'address[]' },
          { name: 'proceedRecipientsData', type: 'bytes[]' },
        ],
      },
      {
        name: '_factoryRegulationData',
        type: 'tuple',
        components: [
          { name: 'regulationType', type: 'uint8' },
          { name: 'regulationSubType', type: 'uint8' },
          {
            name: 'additionalSecurityData',
            type: 'tuple',
            components: [
              { name: 'countriesControlListType', type: 'bool' },
              { name: 'listOfCountries', type: 'string' },
              { name: 'info', type: 'string' },
            ],
          },
        ],
      },
    ],
    outputs: [{ name: 'bondAddress_', type: 'address' }],
  },
  /**
   * The position size. `view`, so it is an `eth_call` over the relay and costs nothing.
   *
   * A security's total balance for a holder, across partitions. Facture only ever uses
   * {@link DEFAULT_PARTITION}, so this and `balanceOfByPartition` are the same number
   * here — and this is the one reported present on the deployed security.
   *
   * Read BEFORE a hold is placed. An ATS hold moves units out of the free balance into a
   * held balance, so the same call after `createHoldByPartition` answers a smaller number.
   */
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
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
  /*
   * Both of these take a `HoldIdentifier` STRUCT, not flat arguments. Passing the three
   * fields flat produces a different selector, so the diamond answers
   * `FunctionNotFound(bytes4)` rather than a revert that names anything useful — and it
   * does so only at execution, which on this path is *after* the cash leg has settled.
   * Confirmed against the ATS SDK's own call sites and a live security.
   */
  {
    type: 'function',
    name: 'executeHoldByPartition',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'holdIdentifier',
        type: 'tuple',
        components: [
          { name: 'partition', type: 'bytes32' },
          { name: 'tokenHolder', type: 'address' },
          { name: 'holdId', type: 'uint256' },
        ],
      },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'releaseHoldByPartition',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'holdIdentifier',
        type: 'tuple',
        components: [
          { name: 'partition', type: 'bytes32' },
          { name: 'tokenHolder', type: 'address' },
          { name: 'holdId', type: 'uint256' },
        ],
      },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
] as const;

/** ATS's default partition. Lockup/clearing segmentation, never a sub-instrument. */
export const DEFAULT_PARTITION: Hex = `0x${'0'.repeat(63)}1`;

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/**
 * Indivisible units — `decimals = 0`, so a unit is never split.
 *
 * NOT "one invoice, one unit", which is what this used to say and what a hardcoded hold of
 * `1` was built on. Supply is whatever is issued against the security, and issuance mints
 * face-value-many units: `0.0.10316440` carries 6,230,000 for a $62,300 receivable. The
 * size of a position is read with `balanceOf`, never inferred from this constant.
 */
const SECURITY_DECIMALS = 0;

/**
 * The Business Logic Resolver proxy every ATS security is deployed against, and the resolver
 * configuration that selects the *bond* facet set.
 *
 * Both are properties of the deployed infrastructure rather than of this instrument, taken
 * from the ATS deployment record and confirmed by a successful `deployBond` on this factory.
 * Only version 1 is registered on this resolver.
 */
const BLR_PROXY_EVM: Address = '0xBA2D5FC2083A0b8f164c50e65d782087fBA18E0a';
const BOND_CONFIG_KEY: Hex = `0x${'0'.repeat(63)}2`;
const BOND_CONFIG_VERSION = 1n;

/**
 * AccessControl's `DEFAULT_ADMIN_ROLE`, which is 32 zero bytes.
 *
 * The factory requires at least one non-zero admin member: it grants itself the role for the
 * duration of the deployment and renounces it before returning, so the address named here is
 * the one left holding it afterwards.
 */
const DEFAULT_ADMIN_ROLE: Hex = `0x${'0'.repeat(64)}`;

/**
 * Reg S is scoped geographically rather than by accreditation, and this is that scope.
 *
 * `countriesControlListType: false` makes the list a BLOCK list — these countries are
 * excluded — which is the opposite reading from `true`. Getting it backwards would publish an
 * instrument offered *only* to sanctioned jurisdictions.
 */
const EXCLUDED_COUNTRIES = 'AF,CU,KP,IR,SY';

/**
 * The selector the deployed factory answers on, checked before anything is submitted.
 *
 * This exists because its absence cost every issuance this service ever attempted. A tuple
 * that looks right but encodes to a different selector produces `FunctionNotFound` at
 * execution — after the gas is spent, with a status that reads like a contract fault rather
 * than a calldata one. Comparing the selector is free and catches the whole class.
 */
export const DEPLOY_BOND_SELECTOR = '0x29002951';

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
  /**
   * Units of `securityId` held by `ownerEvmAddress`, read off the instrument.
   *
   * This is what makes "whole position" true rather than assumed. Issuance mints
   * face-value-many units — the live bond `0.0.10316440` carries 6,230,000 against a
   * $62,300 face — so a trade that hardcodes one unit moves one part in six million of the
   * paper it claims to sell. The balance is a fact about the instrument and is read from
   * it, never inferred from the invoice.
   */
  balanceOf(input: { securityId: string; ownerEvmAddress: Address }): Promise<bigint>;
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
  readonly gasLimit: number;
  readonly network: string;
  readonly logger?: Logger | undefined;
}

/** Map the stored spelling onto shared's regulation table, which owns the ATS enum values. */
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
    balanceOf: (input) => refuse(`Reading the position in ${input.securityId}`),
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

  /*
   * Reads go over the JSON-RPC relay, writes go through the SDK client above.
   *
   * Not fastidiousness: a `ContractCallQuery` through the SDK is a paid query — the
   * operator funds every read — while `eth_call` on the relay is free and answers from the
   * same state. `services/compliance.ts` already reads this diamond the same way, so
   * "reads are viem, writes are the SDK" is one rule for the whole Hedera surface rather
   * than two conventions for one contract.
   */
  const reader: PublicClient = createPublicClient({ transport: http(hedera.jsonRpcUrl) });

  async function submit(
    contractId: string,
    calldata: Hex,
    what: string,
  ): Promise<{
    transactionId: string;
    consensusAt: string;
    gasUsed: number;
    returned: Uint8Array;
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
      const regulation = REGULATIONS[regulationKeyFor(job.regulationType)];
      const nowSeconds = BigInt(Math.floor(Date.now() / 1000));

      const calldata = encodeFunctionData({
        abi: ATS_ABI,
        functionName: 'deployBond',
        args: [
          {
            security: {
              resolver: BLR_PROXY_EVM,
              /*
               * The receivable cannot represent more than itself. Face value in minor units
               * is exactly what issuance mints, so capping supply there means the instrument
               * structurally cannot be over-issued against the invoice behind it.
               */
              maxSupply: job.faceValue,
              resolverProxyConfiguration: { key: BOND_CONFIG_KEY, version: BOND_CONFIG_VERSION },
              erc20MetadataInfo: {
                name: job.name,
                symbol: job.symbol,
                isin: job.isin,
                decimals: SECURITY_DECIMALS,
              },
              rbacs: [
                { role: DEFAULT_ADMIN_ROLE, members: [operatorEvmAddress(config.operatorKey)] },
              ],
              externalPauses: [],
              externalControlLists: [],
              externalKycLists: [],
              /** Per-security `ControlList` and `Kyc`, never the ERC-3643 registry. */
              compliance: ZERO_ADDRESS,
              identityRegistry: ZERO_ADDRESS,
              arePartitionsProtected: false,
              isMultiPartition: false,
              isControllable: true,
              isWhiteList: true,
              /*
               * OFF. `clearingActive: true` blocks direct holds with `ClearingIsActivated()`,
               * and a hold is the asset leg of every trade this venue settles — the probe
               * bond had to have clearing deactivated afterwards to be tradeable at all.
               */
              clearingActive: false,
              /** The security's own Kyc facet, which is what the pre-match check reads. */
              internalKycActivated: true,
              erc20VotesActivated: false,
            },
            bondDetails: {
              currency: currencyBytes3(job.currency),
              /*
               * One unit is one minor unit of the invoice currency, so the nominal value of a
               * unit is 1 with no decimals. The instrument's size lives in supply, not here.
               */
              nominalValue: 1n,
              nominalValueDecimals: 0,
              startingDate: nowSeconds,
              maturityDate: BigInt(Math.floor(job.maturityAt.getTime() / 1000)),
            },
            proceedRecipients: [],
            proceedRecipientsData: [],
          },
          {
            regulationType: regulation.regulationType,
            regulationSubType: regulation.regulationSubType,
            additionalSecurityData: {
              countriesControlListType: false,
              listOfCountries: EXCLUDED_COUNTRIES,
              info: '',
            },
          },
        ],
      });

      /*
       * Checked before a transaction is paid for. See {@link DEPLOY_BOND_SELECTOR}: the
       * failure this guards against is indistinguishable from a contract fault once it has
       * happened, and it silently defeated every issuance until it was found.
       */
      if (!calldata.startsWith(DEPLOY_BOND_SELECTOR)) {
        throw upstreamUnavailable(
          'Hedera',
          `deployBond encodes to ${calldata.slice(0, 10)}, but the factory answers on ` +
            `${DEPLOY_BOND_SELECTOR}. The ABI has drifted from the deployed contract; ` +
            'nothing was submitted.',
        );
      }

      const receipt = await submit(factoryId, calldata, `deployBond ${job.invoiceId}`);
      const evmAddress = decodeAddress(receipt.returned);

      /*
       * The security's id comes from the address the function RETURNED, never from
       * `contractFunctionResult.contractId` — that is the contract which was *called*, so
       * using it recorded the factory `0.0.9213391` as the instrument for every invoice.
       * Silent, and wrong in a way that reads as plausible until two invoices claim the same
       * security.
       *
       * ATS does not deploy to a long-zero address, so the number cannot be derived from the
       * address arithmetically and the mirror node is the only thing that knows it.
       */
      const securityId = await resolveContractId(evmAddress);

      log.info('bond deployed', {
        invoiceId: job.invoiceId,
        securityId,
        gasUsed: receipt.gasUsed,
        isin: job.isin,
      });

      return {
        securityId,
        evmAddress,
        isin: job.isin,
        transactionId: receipt.transactionId,
        gasUsed: receipt.gasUsed,
      };
    },

    async balanceOf(input) {
      /*
       * A read that cannot be read is not a zero. Zero is a refusal with a sentence
       * attached — "this seller holds none of this instrument" — and answering it for an
       * unreachable relay would turn an outage into a false statement about a position.
       */
      try {
        const units = await reader.readContract({
          address: accountIdToEvmAddress(input.securityId),
          abi: ATS_ABI,
          functionName: 'balanceOf',
          args: [input.ownerEvmAddress],
        });
        return units;
      } catch (err) {
        log.warn('balanceOf failed', { securityId: input.securityId, err });
        throw upstreamUnavailable(
          'Hedera',
          `The position in ${input.securityId} could not be read, so the size of the ` +
            'trade is unknown. Nothing was held.',
        );
      }
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
          {
            partition: DEFAULT_PARTITION,
            tokenHolder: input.holderEvmAddress,
            holdId: BigInt(input.holdId),
          },
          input.toEvmAddress,
          input.units,
        ],
      });
      const receipt = await submit(input.securityId, calldata, 'executeHoldByPartition');
      return { transactionId: receipt.transactionId, consensusAt: receipt.consensusAt };
    },

    async releaseHold(input) {
      const calldata = encodeFunctionData({
        abi: ATS_ABI,
        functionName: 'releaseHoldByPartition',
        args: [
          {
            partition: DEFAULT_PARTITION,
            tokenHolder: input.holderEvmAddress,
            holdId: BigInt(input.holdId),
          },
          input.units,
        ],
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
 * `0.0.x` for a contract that has just been created, by asking the mirror node.
 *
 * Retried, because the mirror node trails consensus by a second or two and this runs
 * immediately after the deployment record comes back. Ten seconds is generous for that lag
 * and short enough that a genuinely missing contract fails while the operator is still
 * looking.
 *
 * Failing here is deliberate rather than falling back to something plausible. The bond does
 * exist at this point — the gas is spent either way — but a security recorded under the wrong
 * id is worse than one recorded as failed: the invoice would look tradeable and every hold
 * against it would go to the wrong contract. The EVM address is in the log line above, so a
 * failure is reconcilable by hand.
 */
async function resolveContractId(evmAddress: Address): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
    try {
      const response = await fetch(`${hedera.mirrorNodeUrl}/api/v1/contracts/${evmAddress}`);
      if (!response.ok) continue;
      const body: unknown = await response.json();
      const id = (body as { contract_id?: unknown }).contract_id;
      if (typeof id === 'string' && /^\d+\.\d+\.\d+$/.test(id)) return id;
    } catch {
      // Retry: an unreachable mirror node is not evidence the contract is absent.
    }
  }

  throw upstreamUnavailable(
    'Hedera',
    `Deployed a security at ${evmAddress} but the mirror node did not resolve its 0.0.x id. ` +
      'The bond exists and can be reconciled from that address.',
  );
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
/**
 * The operator's EVM address as the **alias** derived from its ECDSA public key, not the
 * long-zero form derived from its account number.
 *
 * A Hedera account with an ECDSA key has both. To the ledger they are the same account; to
 * a Solidity contract holding an internal mapping they are unrelated keys. So when the
 * venue names itself as a hold's escrow, it must use the address it will actually call
 * from — the alias — or `executeHold` reverts because `msg.sender` is not the escrow the
 * hold recorded. That failure lands *after* the cash leg has settled, which is the
 * expensive half of a DvP to get wrong.
 */
export function operatorEvmAddress(operatorKey: string): Address {
  const raw = PrivateKey.fromStringECDSA(operatorKey).publicKey.toEvmAddress();
  const body = raw.startsWith('0x') ? raw.slice(2) : raw;
  return `0x${body.toLowerCase()}`;
}

export function accountIdToEvmAddress(accountId: string | null | undefined): Address {
  if (accountId === null || accountId === undefined) return ZERO_ADDRESS;
  if (/^0x[0-9a-fA-F]{40}$/.test(accountId)) return accountId as Address;
  if (!/^\d+\.\d+\.\d+$/.test(accountId)) return ZERO_ADDRESS;
  const raw = AccountId.fromString(accountId).toEvmAddress();
  const body = raw.startsWith('0x') ? raw.slice(2) : raw;
  return `0x${body.toLowerCase()}`;
}

export { ZERO_ADDRESS };
