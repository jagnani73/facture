/**
 * Chain constants, sourced from `@facture/shared` so that backend, web and agent read
 * one table. Nothing here comes from the environment: a chain id that can be overridden
 * per-deployment is a chain id that will eventually disagree with the frontend's.
 *
 * `@facture/shared` exports whole chain *objects* — `ARC_TESTNET`, `HEDERA_TESTNET`,
 * `CHAINS` keyed by `ChainKey` — rather than flat scalars, and it owns the explorer URL
 * builders too. This file is the single adapter from those objects onto the flattened
 * shape the rest of the backend reads, so nothing downstream needs to know either.
 */

import { defineChain } from 'viem';
import {
  ARC_NATIVE_GAS_DECIMALS,
  ARC_TESTNET,
  ASSET_CHAIN,
  CASH_CHAIN,
  explorerAddressUrl,
  explorerTxUrl,
  HEDERA_TESTNET,
} from '@facture/shared';

/** Where the cash leg settles, and where the paper lives. From shared, not from here. */
export const cashChainKey = CASH_CHAIN;
export const assetChainKey = ASSET_CHAIN;

export const arc = {
  key: ARC_TESTNET.key,
  chainId: ARC_TESTNET.chainId,
  rpcUrl: ARC_TESTNET.rpcUrl,
  explorerUrl: ARC_TESTNET.explorerUrl,
  /** ERC-20 interface. Use this for every balance and transfer calculation. */
  usdcAddress: ARC_TESTNET.tokens.USDC.address,
  /** The ERC-20 view (6). Native gas accounting on Arc is 18 — never mix the two. */
  usdcDecimals: ARC_TESTNET.tokens.USDC.decimals,
  eurcAddress: ARC_TESTNET.tokens.EURC.address,
  eurcDecimals: ARC_TESTNET.tokens.EURC.decimals,
  /**
   * Hard floor for `maxFeePerGas`. Below this the node rejects the transaction as
   * "underpriced" — it is not a soft suggestion, which is why `env.ts` validates against
   * it rather than carrying its own copy of the number.
   */
  minMaxFeePerGasWei: ARC_TESTNET.minMaxFeePerGasWei,
  minMaxFeePerGasGwei: Number(ARC_TESTNET.minMaxFeePerGasWei / 1_000_000_000n),
} as const;

export const hedera = {
  key: HEDERA_TESTNET.key,
  network: HEDERA_TESTNET.network,
  chainId: HEDERA_TESTNET.chainId,
  jsonRpcUrl: HEDERA_TESTNET.jsonRpcUrl,
  mirrorNodeUrl: HEDERA_TESTNET.mirrorNodeUrl,
  explorerUrl: HEDERA_TESTNET.explorerUrl,
  /** Native ledger decimals (tinybars, 8). The JSON-RPC relay scales HBAR to 18. */
  hbarDecimals: HEDERA_TESTNET.assets.HBAR.decimals,
  /** HBAR as an x402 asset reference: `0.0.0`. */
  hbarAssetId: HEDERA_TESTNET.assets.HBAR.id,
  usdcAssetId: HEDERA_TESTNET.assets.USDC.id,
  usdcDecimals: HEDERA_TESTNET.assets.USDC.decimals,
} as const;

/**
 * viem chain for Arc testnet. Gas is natively USDC, so `nativeCurrency` is USDC at the
 * 18-decimal gas-accounting precision — distinct from `arc.usdcDecimals` (6), which is
 * what the ERC-20 interface reports and what all transfer logic uses.
 */
export const arcChain = defineChain({
  id: arc.chainId,
  name: ARC_TESTNET.name,
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: ARC_NATIVE_GAS_DECIMALS },
  rpcUrls: { default: { http: [arc.rpcUrl] } },
  blockExplorers: { default: { name: 'Arcscan', url: arc.explorerUrl } },
  testnet: true,
});

/**
 * HashScan's path for a deployed contract, in either identity a Hedera contract has —
 * `0.0.x` or `0x…`. Written once because two callers want it for the same reason: an ATS
 * security and the venue's own registries are contracts in exactly the same sense, and a
 * second copy of this template is how one of them ends up on a path that 404s.
 */
const hederaContractUrl = (idOrAddress: string): string =>
  `${hedera.explorerUrl}/contract/${idOrAddress}`;

/**
 * Explorer links. The tx and address forms come straight from shared so the backend and
 * the web app cannot build different URLs for the same receipt; the token and topic forms
 * are HashScan paths shared does not model, built off its explorer base rather than a
 * hostname written here.
 */
export const explorer = {
  arcTx: (hash: string): string => explorerTxUrl(cashChainKey, hash),
  arcAddress: (address: string): string => explorerAddressUrl(cashChainKey, address),
  hederaTx: (id: string): string => explorerTxUrl(assetChainKey, id),
  hederaAccount: (id: string): string => explorerAddressUrl(assetChainKey, id),
  /**
   * An ATS security, which is a **contract** and not an HTS token.
   *
   * It was `/token/` until 2026-09-02, and that link went nowhere: the mirror node answers
   * `/api/v1/contracts/0.0.10331928` and 404s on `/api/v1/tokens/0.0.10331928`. The security
   * is a diamond the factory deployed, so nothing about it was ever a token — the name of the
   * field is what made the wrong path look right. This is the link on the proof view, whose
   * whole job is being checkable somewhere that is not us.
   */
  hederaSecurity: hederaContractUrl,
  /**
   * One of the venue's own contracts — the registries a reader goes to when they decline to
   * take a claim on this service's word, which is the whole premise of the proof view.
   */
  hederaContract: hederaContractUrl,
  /** A scheduled transaction, which is how a maturity payout is visible before it executes. */
  hederaSchedule: (id: string): string => `${hedera.explorerUrl}/schedule/${id}`,
  hederaTopicMessage: (topicId: string, seq: number): string =>
    `${hedera.explorerUrl}/topic/${topicId}/message/${seq}`,
} as const;
