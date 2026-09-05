/**
 * The cash leg's escrow, on Arc.
 *
 * `POST /v1/mandates/:id/fund` takes an `escrowRef` and credits whatever amount the request
 * asked for. Its own comment says what it wants to be — *"the escrow record is the authority
 * on how much landed, never the request body"* — and then says there is no escrow provider
 * wired, so the reference is recorded and believed. This is that provider.
 *
 * `MandateVault` on Arc holds the USDC. `balanceOf(mandateId)` is a **view**, so verifying a
 * mandate's capital costs no key, no gas and no signature — the venue can simply ask the
 * chain how much is actually there and refuse to count more than that. A funding request can
 * then be wrong without being believed, which is the same class of fix as taking a seller's
 * email from a signed token rather than from a request body.
 *
 * ## The mandate id is derived, and this is the load-bearing detail
 *
 * The vault keys capital by `uint256 mandateId`. `MandateBook` mints those sequentially, and
 * **the venue's mandates have never been posted to MandateBook** — they are UUIDs in a
 * database. So the id used here is derived from the UUID rather than taken from the book.
 *
 * That is sound because to the vault a mandate id is only a key: it needs to be unique and
 * stable, not meaningful. It is `uint256(keccak256(uuid))`, which is both. But it does mean
 * **the vault's id space and MandateBook's id space are different**, and anything that later
 * posts these mandates to the book must reconcile them rather than assume they match. Two
 * systems silently disagreeing about which mandate is which is exactly how capital ends up
 * credited to the wrong one.
 *
 * ## What this does not do
 *
 * It does not move money. Depositing pulls USDC from `msg.sender`, so a deposit is the
 * buyer's own transaction from the buyer's own wallet — the venue holds the attester key, not
 * the buyer's. All the venue does is `registerMandate`, which names who a release may be paid
 * to, and then read what arrived.
 */

import { createPublicClient, createWalletClient, http, keccak256, parseAbi, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcChain } from '../chain.js';
import { badRequest } from '../errors.js';
import type { Logger } from '../logger.js';
import { rootLogger } from '../logger.js';

/**
 * A venue mandate UUID as the vault's key.
 *
 * Deterministic, so the same mandate always resolves to the same slot, and collision-free in
 * any sense that matters — a keccak collision is not the failure mode to design against here.
 */
export function vaultMandateId(mandateUuid: string): bigint {
  return BigInt(keccak256(toHex(mandateUuid)));
}

const VAULT_ABI = parseAbi([
  'function balanceOf(uint256 mandateId) view returns (uint128)',
  'function buyerOf(uint256 mandateId) view returns (address)',
  'function settlementToken() view returns (address)',
  'function registerMandate(uint256 mandateId, address buyer)',
]);

export interface ArcEscrow {
  /** Whether a vault is configured at all. False means funding is recorded, not verified. */
  readonly enabled: boolean;
  /** USDC actually held for this mandate, in ERC-20 minor units (6dp). */
  depositedFor(mandateUuid: string): Promise<bigint>;
  /** The address a release would pay, or `null` when the mandate was never registered. */
  buyerOf(mandateUuid: string): Promise<string | null>;
  /** Attester-only. Must happen before any deposit can land against the mandate. */
  registerMandate(mandateUuid: string, buyer: string): Promise<{ transactionHash: string }>;
}

export interface ArcEscrowConfig {
  readonly vaultAddress: string | undefined;
  readonly settlementPrivateKey: string;
  readonly maxFeePerGasGwei: number;
  readonly logger?: Logger | undefined;
}

/**
 * No vault configured.
 *
 * Reads answer "nothing is escrowed" rather than throwing, because the funding route has to
 * be able to ask without a vault present — this deployment's honest answer is that it does
 * not know, and `enabled` is how the route tells the two apart. Writing still refuses,
 * naming the variable, in the same shape as issuance with no ATS factory.
 */
export function createDisabledArcEscrow(): ArcEscrow {
  return {
    enabled: false,
    depositedFor: () => Promise.resolve(0n),
    buyerOf: () => Promise.resolve(null),
    registerMandate: () =>
      Promise.reject(
        badRequest(
          'Registering a mandate needs the Arc vault. ARC_MANDATE_VAULT_ADDRESS is not set, ' +
            'so mandate capital is not escrowed on this deployment.',
        ),
      ),
  };
}

export function createArcEscrow(config: ArcEscrowConfig): ArcEscrow {
  if (config.vaultAddress === undefined) return createDisabledArcEscrow();

  const address = config.vaultAddress as `0x${string}`;
  const log = (config.logger ?? rootLogger).child({ svc: 'arc' });
  const reader = createPublicClient({ chain: arcChain, transport: http() });

  const read = <T>(fn: 'balanceOf' | 'buyerOf', mandateUuid: string): Promise<T> =>
    reader.readContract({
      address,
      abi: VAULT_ABI,
      functionName: fn,
      args: [vaultMandateId(mandateUuid)],
    }) as Promise<T>;

  return {
    enabled: true,

    async depositedFor(mandateUuid) {
      return read<bigint>('balanceOf', mandateUuid);
    },

    async buyerOf(mandateUuid) {
      const buyer = await read<string>('buyerOf', mandateUuid);
      // The vault returns the zero address for a mandate it has never seen.
      return /^0x0{40}$/i.test(buyer) ? null : buyer;
    },

    async registerMandate(mandateUuid, buyer) {
      const account = privateKeyToAccount(config.settlementPrivateKey as `0x${string}`);
      const wallet = createWalletClient({ account, chain: arcChain, transport: http() });

      /*
       * Arc rejects anything under its floor as "underpriced", so the fee is set explicitly
       * rather than left to estimation. `env.ts` validates the configured value against the
       * same floor, so this cannot be configured below it.
       */
      const maxFeePerGas = BigInt(config.maxFeePerGasGwei) * 1_000_000_000n;

      const hash = await wallet.writeContract({
        address,
        abi: VAULT_ABI,
        functionName: 'registerMandate',
        args: [vaultMandateId(mandateUuid), buyer as `0x${string}`],
        maxFeePerGas,
        maxPriorityFeePerGas: 0n,
      });

      log.info('mandate registered on Arc', { mandateUuid, buyer, hash });
      return { transactionHash: hash };
    },
  };
}

let escrow: ArcEscrow | undefined;

export function initArcEscrow(config: ArcEscrowConfig): ArcEscrow {
  escrow = createArcEscrow(config);
  return escrow;
}

/** Test seam, matching the other services. `undefined` clears it. */
export function setArcEscrow(next: ArcEscrow | undefined): void {
  escrow = next;
}

export function getArcEscrow(): ArcEscrow {
  if (!escrow) throw new Error('Arc escrow accessed before initArcEscrow().');
  return escrow;
}
