/**
 * Hedera testnet — where the paper lives.
 *
 * Two rules govern everything that touches this chain, and both fail late and confusingly
 * when broken:
 *
 * 1. **ECDSA keys for anything EVM.** ED25519 accounts hold HBAR and HTS tokens perfectly
 *    well but cannot sign EVM transactions. The failure surfaces as `INVALID_SIGNATURE`
 *    somewhere far from the key that caused it.
 * 2. **Every HTS token must be explicitly associated by the receiver** before it can be
 *    received — USDC on Hedera and every ATS security token included. A transfer to an
 *    unassociated account fails; it does not queue.
 */

/** Native Hedera entity id, `shard.realm.num`. */
export type HederaId = `${number}.${number}.${number}`;

export interface HederaAsset {
  readonly symbol: string;
  /** Native id. x402 `PaymentRequirements` reference HTS assets in this form. */
  readonly id: HederaId;
  readonly decimals: number;
  /** HTS tokens need association; HBAR does not. */
  readonly requiresAssociation: boolean;
}

export interface HederaChainConfig {
  readonly key: 'hedera-testnet';
  readonly name: string;
  readonly network: 'testnet';
  /** EVM chain id exposed by the JSON-RPC relay for Hedera testnet. */
  readonly chainId: number;
  readonly jsonRpcUrl: string;
  readonly mirrorNodeUrl: string;
  readonly explorerUrl: string;
  readonly assets: {
    readonly HBAR: HederaAsset;
    readonly USDC: HederaAsset;
  };
}

export const HEDERA_TESTNET: HederaChainConfig = {
  key: 'hedera-testnet',
  name: 'Hedera Testnet',
  network: 'testnet',
  chainId: 296,
  jsonRpcUrl: 'https://testnet.hashio.io/api',
  mirrorNodeUrl: 'https://testnet.mirrornode.hedera.com',
  explorerUrl: 'https://hashscan.io/testnet',
  assets: {
    /**
     * DECIMALS TRAP. The native ledger accounts for HBAR in tinybars (8 decimals); the
     * JSON-RPC relay scales to 18 to match Ethereum tooling. Never mix native-SDK HBAR
     * arithmetic with EVM `msg.value` arithmetic inside one calculation.
     */
    HBAR: { symbol: 'HBAR', id: '0.0.0', decimals: 8, requiresAssociation: false },
    USDC: { symbol: 'USDC', id: '0.0.429274', decimals: 6, requiresAssociation: true },
  },
};

/** Decimals the JSON-RPC relay reports for HBAR, as distinct from the native ledger's 8. */
export const HEDERA_EVM_HBAR_DECIMALS = 18;

/** System contract address of the Hedera Schedule Service. */
export const HEDERA_SCHEDULE_SERVICE_ADDRESS = '0x000000000000000000000000000000000000016b';

/**
 * Facts about Hedera that shape design decisions, kept next to the config that uses them.
 */
export const HEDERA_CONSTRAINTS = {
  /** ED25519 accounts cannot sign EVM transactions. Provision ECDSA everywhere. */
  requiresEcdsaForEvm: true,
  /** A receiver must associate an HTS token before it can be received. */
  requiresTokenAssociation: true,
  /**
   * `ScheduleCreateTransaction` schedules exactly one transaction pending signatures or
   * expiry. There is no continuous stream primitive; recurrence is app-layer. One-shot
   * maturity settlement is a correct use of it, "streaming" is not.
   */
  scheduledTransactionsAreOneShot: true,
  /**
   * Throttling is on network gas throughput as well as per-transaction gas, so a burst of
   * issuances returns `BUSY` long before any single one is refused. Issuance is paced.
   */
  throttlesOnNetworkGasThroughput: true,
} as const;
