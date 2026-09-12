/**
 * Typed chain configuration. Nothing outside this directory should contain a chain id, an
 * RPC URL, a token address or a regulation number as a literal.
 */

import { ARC_TESTNET, type ArcChainConfig } from './arc.js';
import { HEDERA_TESTNET, type HederaChainConfig } from './hedera.js';

export * from './arc.js';
export * from './hedera.js';
export * from './x402.js';
export * from './ats.js';
export * from './deployments.js';

/** Every chain this build touches. Two, deliberately: paper on one, cash on the other. */
export const CHAINS = {
  'arc-testnet': ARC_TESTNET,
  'hedera-testnet': HEDERA_TESTNET,
} as const;

export type ChainKey = keyof typeof CHAINS;

export type ChainConfig = ArcChainConfig | HederaChainConfig;

export const CHAIN_KEYS = ['arc-testnet', 'hedera-testnet'] as const;

export const isChainKey = (v: unknown): v is ChainKey =>
  typeof v === 'string' && (CHAIN_KEYS as readonly string[]).includes(v);

export function getChain(key: ChainKey): ChainConfig {
  return CHAINS[key];
}

/** Where the cash leg settles. */
export const CASH_CHAIN: ChainKey = 'arc-testnet';

/** Where the paper is issued and delivered. */
export const ASSET_CHAIN: ChainKey = 'hedera-testnet';

/** Block explorer link for a transaction, so no view builds one by hand. */
export function explorerTxUrl(key: ChainKey, txHashOrId: string): string {
  const chain = CHAINS[key];
  return key === 'hedera-testnet'
    ? `${chain.explorerUrl}/transaction/${txHashOrId}`
    : `${chain.explorerUrl}/tx/${txHashOrId}`;
}

/** Block explorer link for an address or contract. */
export function explorerAddressUrl(key: ChainKey, address: string): string {
  const chain = CHAINS[key];
  return key === 'hedera-testnet'
    ? `${chain.explorerUrl}/account/${address}`
    : `${chain.explorerUrl}/address/${address}`;
}
