import type { Address } from 'viem';

/**
 * Arc testnet — where the cash leg lives.
 *
 * Testnet only. Public mainnet lands after the submission deadline, so nothing in this
 * build may depend on it.
 */

export interface Erc20Token {
  readonly symbol: string;
  readonly address: Address;
  /**
   * Decimals **on the ERC-20 interface**. Use these for every balance and transfer
   * calculation.
   */
  readonly decimals: number;
}

export interface ArcChainConfig {
  readonly key: 'arc-testnet';
  readonly name: string;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  readonly faucetUrl: string;
  /** Circle CCTP domain id for this chain. */
  readonly cctpDomain: number;
  /**
   * Floor for `maxFeePerGas`, in wei. Anything below this is rejected as "transaction
   * underpriced" — it is not a soft suggestion.
   */
  readonly minMaxFeePerGasWei: bigint;
  readonly tokens: {
    readonly USDC: Erc20Token;
    readonly EURC: Erc20Token;
  };
}

export const ARC_TESTNET: ArcChainConfig = {
  key: 'arc-testnet',
  name: 'Arc Testnet',
  chainId: 5042002,
  rpcUrl: 'https://rpc.testnet.arc.io',
  explorerUrl: 'https://testnet.arcscan.app',
  faucetUrl: 'https://faucet.circle.com',
  cctpDomain: 26,
  // 20 gwei. Below this the node rejects the transaction outright.
  minMaxFeePerGasWei: 20_000_000_000n,
  tokens: {
    /**
     * DECIMALS TRAP. Gas on Arc is natively USDC and the *gas accounting* is 18 decimals,
     * while this ERC-20 interface is 6 — same underlying balance, two scales. Mixing them
     * is a 10^12 error, which is large enough to look like a different asset rather than a
     * rounding bug. All balance and transfer logic uses the ERC-20 interface, i.e. 6.
     */
    USDC: {
      symbol: 'USDC',
      address: '0x3600000000000000000000000000000000000000',
      decimals: 6,
    },
    EURC: {
      symbol: 'EURC',
      address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
      decimals: 6,
    },
  },
};

/** Decimals used by Arc's *native gas accounting*, as distinct from the ERC-20 interface. */
export const ARC_NATIVE_GAS_DECIMALS = 18;

/**
 * Products deliberately not used on Arc, recorded so they are not rediscovered mid-build.
 *
 * - StableFX is KYB/AML-gated and not self-serve; EURC is on testnet, so App Kit's swap
 *   covers any FX demo without it.
 * - Paymaster is redundant when gas is already natively USDC.
 */
export const ARC_UNUSED = ['StableFX', 'Paymaster'] as const;
