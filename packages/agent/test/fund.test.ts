/**
 * The funding run.
 *
 * Everything here is about the two ways this script could hurt someone: spending when
 * nobody asked it to, and spending the same dollar twice because two mandates were each
 * told it was free.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env.js';
import { fund, parseArgs, summarise, type FundArgs } from '../src/fund.js';
import { createLogger, type Logger } from '../src/logger.js';
import type { MandateAllocations, MandateTerms } from '../src/mandate.js';
import type { ArmedTrade, BookRow, LiveQuote, VenueClient, VenueMandate } from '../src/venue.js';
import type { VaultReader } from '../src/vault.js';
import type {
  ContractCallInput,
  SubmittedTransaction,
  TokenBalance,
  TransactionOutcome,
  TransferInput,
  WalletClient,
  WalletSetSummary,
  WalletSummary,
} from '../src/wallet.js';
import type { Address } from 'viem';

/* ── arguments ───────────────────────────────────────────────────────────────────────── */

describe('parseArgs', () => {
  /*
   * The single most important default in this file. A parser that read `execute` as true
   * when nobody typed it would make every invocation a live spend, and the first sign of it
   * would be a Circle transaction.
   */
  it('does not execute unless --execute is typed', () => {
    expect(parseArgs([]).execute).toBe(false);
    expect(parseArgs(['--mandate', 'a']).execute).toBe(false);
    expect(parseArgs(['--execute']).execute).toBe(true);
  });

  it('takes mandates one at a time or comma-separated', () => {
    expect(parseArgs(['--mandate', 'a', '--mandate', 'b']).mandateIds).toEqual(['a', 'b']);
    expect(parseArgs(['--mandate', 'a, b ,']).mandateIds).toEqual(['a', 'b']);
  });

  it('carries an amount and an idempotency key through untouched', () => {
    const args = parseArgs(['--amount', '2.5', '--idempotency-key', 'k-1']);
    expect(args.amount).toBe('2.5');
    expect(args.idempotencyKey).toBe('k-1');
  });

  it('refuses an argument it does not know rather than ignoring it', () => {
    expect(() => parseArgs(['--exeucte'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--amount'])).toThrow(/needs a decimal/);
  });
});

/* ── fixtures ────────────────────────────────────────────────────────────────────────── */

const WALLET: Address = '0x1111111111111111111111111111111111111111';
const USDC: Address = '0x3600000000000000000000000000000000000000';
const VAULT: Address = '0x217256d0FDF83ffd81bbC6884Ad44f5C02501102';
const A = '8b879d02-4593-4d66-82bf-52d4833401b6';
const B = 'c0c8ed97-b01d-4c30-b9b2-0ddf7472fa3d';

const env = (over: Partial<Env> = {}): Env =>
  ({
    LOG_LEVEL: 'error',
    CIRCLE_API_KEY: 'k',
    CIRCLE_ENTITY_SECRET: 'a'.repeat(64),
    ARC_BLOCKCHAIN: 'ARC-TESTNET',
    ARC_USDC_ADDRESS: USDC,
    ARC_MANDATE_VAULT_ADDRESS: VAULT,
    ARC_RPC_URL: 'https://rpc.testnet.arc.io',
    FACTURE_API_URL: 'http://localhost:8787',
    FACTURE_API_TIMEOUT_MS: 10_000,
    FACTURE_API_TRADE_TIMEOUT_MS: 60_000,
    AGENT_BUYER_ID: 'buyer-1',
    AGENT_SELLER_IDS: ['seller-1'],
    AGENT_WALLET_ID: 'wallet-1',
    AGENT_HEDERA_NETWORK: 'hedera:testnet',
    AGENT_POLL_INTERVAL_MS: 15_000,
    AGENT_MAX_SLIPPAGE_BPS: 0,
    AGENT_DRY_RUN: true,
    AGENT_ONCE: false,
    ...over,
  }) as Env;

const args = (over: Partial<FundArgs> = {}): FundArgs => ({
  execute: false,
  mandateIds: [],
  amount: null,
  idempotencyKey: null,
  ...over,
});

const terms = (id: string): MandateTerms => ({
  id,
  buyerId: 'buyer-1',
  currency: 'USD',
  minRating: 'A',
  maxTenorDays: 90,
  annualisedYieldBps: 850,
  totalCommitted: 5_000_000n,
  maxPerDebtor: 5_000_000n,
  status: 'active',
});

const allocations: MandateAllocations = { total: 0n, byDebtor: {} };

const venueMandate = (id: string, requiredUsdcMinor: bigint): VenueMandate => ({
  terms: terms(id),
  allocations,
  exposureLimit: 5_000_000n,
  escrowedCapital: 5_000_000n,
  vault: {
    checked: true,
    depositedUsdcMinor: 0n,
    requiredUsdcMinor,
    backed: false,
  },
});

function fakeVenue(mandates: readonly VenueMandate[]): VenueClient {
  const notUsed = (name: string) => async (): Promise<never> => {
    throw new Error(`${name} must not be called by a funding run`);
  };
  return {
    async mandates() {
      return mandates;
    },
    book: notUsed('book') as unknown as (s: readonly string[]) => Promise<readonly BookRow[]>,
    quote: notUsed('quote') as unknown as (id: string) => Promise<LiveQuote>,
    armTrade: notUsed('armTrade') as unknown as (i: {
      invoiceId: string;
      quoteId: string;
    }) => Promise<ArmedTrade>,
    settleTrade: notUsed('settleTrade') as unknown as (i: {
      invoiceId: string;
      quoteId: string;
    }) => Promise<ArmedTrade>,
  } as unknown as VenueClient;
}

interface FakeWallet extends WalletClient {
  readonly calls: ContractCallInput[];
}

function fakeWallet(usdcMinor: bigint, walletSetId = 'set-1'): FakeWallet {
  const calls: ContractCallInput[] = [];
  const notUsed = (name: string) => async (): Promise<never> => {
    throw new Error(`${name} must not be called by a funding run`);
  };
  return {
    blockchain: 'ARC-TESTNET',
    usdcAddress: USDC,
    calls,
    async getWallet(walletId): Promise<WalletSummary> {
      return {
        id: walletId,
        address: WALLET,
        blockchain: 'ARC-TESTNET',
        walletSetId,
        state: 'LIVE',
        accountType: 'EOA',
      };
    },
    async usdcBalance(): Promise<TokenBalance | null> {
      return {
        tokenId: 'token-usdc',
        symbol: 'USDC',
        tokenAddress: USDC,
        decimals: 6,
        amount: usdcMinor,
        raw: String(usdcMinor),
        updatedAt: '2026-09-04T00:00:00.000Z',
      };
    },
    async executeContract(input): Promise<SubmittedTransaction> {
      calls.push(input);
      return { id: `tx-${calls.length}`, state: 'INITIATED' };
    },
    async awaitTransaction(transactionId): Promise<TransactionOutcome> {
      return {
        id: transactionId,
        state: 'CONFIRMED',
        result: 'succeeded',
        txHash: `0x${transactionId}`,
        errorReason: null,
        errorDetails: null,
        timedOut: false,
      };
    },
    transaction: notUsed('transaction') as unknown as (id: string) => Promise<TransactionOutcome>,
    transferUsdc: notUsed('transferUsdc') as unknown as (
      i: TransferInput,
    ) => Promise<SubmittedTransaction>,
    createWalletSet: notUsed('createWalletSet') as unknown as (
      n: string,
    ) => Promise<WalletSetSummary>,
    listWalletSets: notUsed('listWalletSets') as unknown as () => Promise<
      readonly WalletSetSummary[]
    >,
    createWallets: notUsed('createWallets') as unknown as (i: {
      walletSetId: string;
      count: number;
    }) => Promise<readonly WalletSummary[]>,
    listWallets: notUsed('listWallets') as unknown as () => Promise<readonly WalletSummary[]>,
    tokenBalances: notUsed('tokenBalances') as unknown as (
      id: string,
    ) => Promise<readonly TokenBalance[]>,
  };
}

function fakeReader(over: Partial<VaultReader> = {}): VaultReader {
  return {
    vaultAddress: VAULT,
    usdcAddress: USDC,
    async buyerOf(): Promise<Address> {
      return WALLET;
    },
    async depositedFor(): Promise<bigint> {
      return 0n;
    },
    async allowance(): Promise<bigint> {
      return 0n;
    },
    async usdcBalanceOf(): Promise<bigint> {
      return 6_000_000n;
    },
    async settlementToken(): Promise<Address> {
      return USDC;
    },
    ...over,
  };
}

let logger: Logger;
beforeEach(() => {
  logger = createLogger({ level: 'error', write: () => {} });
});

/* ── the run ─────────────────────────────────────────────────────────────────────────── */

describe('fund', () => {
  it('submits nothing without --execute, and still reports exactly what it would do', async () => {
    const wallet = fakeWallet(6_000_000n);
    const outcomes = await fund({
      env: env(),
      args: args(),
      venue: fakeVenue([venueMandate(A, 50_000n)]),
      reader: fakeReader(),
      wallet,
      logger,
    });

    expect(wallet.calls).toHaveLength(0);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.kind).toBe('planned');
    if (outcomes[0]?.kind !== 'planned') return;
    expect(outcomes[0].plan.amountUsdcMinor).toBe(50_000n);
  });

  it('approves and deposits with --execute', async () => {
    const wallet = fakeWallet(6_000_000n);
    const outcomes = await fund({
      env: env(),
      args: args({ execute: true }),
      venue: fakeVenue([venueMandate(A, 50_000n)]),
      reader: fakeReader({ depositedFor: async () => 0n }),
      wallet,
      logger,
    });

    expect(wallet.calls.map((c) => c.abiFunctionSignature)).toEqual([
      'approve(address,uint256)',
      'deposit(uint256,uint128)',
    ]);
    expect(outcomes[0]?.kind).toBe('done');
  });

  /*
   * One wallet, two mandates. Without a running budget the second would be told the whole
   * balance is free — the same defect `agent.ts` keeps a per-tick budget to avoid, in a
   * place where the money leaves in one call rather than after a challenge.
   */
  it('does not offer the same dollar to two mandates', async () => {
    const outcomes = await fund({
      env: env(),
      args: args(),
      venue: fakeVenue([venueMandate(A, 4_000_000n), venueMandate(B, 4_000_000n)]),
      reader: fakeReader(),
      wallet: fakeWallet(5_000_000n),
      logger,
    });

    expect(outcomes[0]?.kind).toBe('planned');
    expect(outcomes[1]?.kind).toBe('refused');
    if (outcomes[1]?.kind !== 'refused') return;
    expect(outcomes[1].refusal.code).toBe('INSUFFICIENT_WALLET_USDC');
  });

  it('refuses to spend from a wallet outside the configured wallet set', async () => {
    await expect(
      fund({
        env: env({ AGENT_WALLET_SET_ID: 'set-expected' }),
        args: args({ execute: true }),
        venue: fakeVenue([venueMandate(A, 50_000n)]),
        reader: fakeReader(),
        wallet: fakeWallet(6_000_000n, 'set-actual'),
        logger,
      }),
    ).rejects.toThrow(/AGENT_WALLET_SET_ID/);
  });

  it('accepts a wallet that is in the configured set', async () => {
    const outcomes = await fund({
      env: env({ AGENT_WALLET_SET_ID: 'set-1' }),
      args: args(),
      venue: fakeVenue([venueMandate(A, 50_000n)]),
      reader: fakeReader(),
      wallet: fakeWallet(6_000_000n),
      logger,
    });
    expect(outcomes[0]?.kind).toBe('planned');
  });

  it('reports an unreadable vault as unreadable rather than as unbacked', async () => {
    const outcomes = await fund({
      env: env(),
      args: args(),
      venue: fakeVenue([venueMandate(A, 50_000n)]),
      reader: fakeReader({
        buyerOf: async () => {
          throw new Error('rpc down');
        },
      }),
      wallet: fakeWallet(6_000_000n),
      logger,
    });
    expect(outcomes[0]?.kind).toBe('refused');
    if (outcomes[0]?.kind !== 'refused') return;
    expect(outcomes[0].refusal.code).toBe('VAULT_UNREADABLE');
  });

  it('targets only the mandates named, and refuses one that is not the buyer’s', async () => {
    const outcomes = await fund({
      env: env(),
      args: args({ mandateIds: [B] }),
      venue: fakeVenue([venueMandate(A, 50_000n), venueMandate(B, 40_000n)]),
      reader: fakeReader(),
      wallet: fakeWallet(6_000_000n),
      logger,
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.mandateId).toBe(B);

    await expect(
      fund({
        env: env(),
        args: args({ mandateIds: ['not-a-mandate'] }),
        venue: fakeVenue([venueMandate(A, 50_000n)]),
        reader: fakeReader(),
        wallet: fakeWallet(6_000_000n),
        logger,
      }),
    ).rejects.toThrow(/not one of buyer/);
  });

  /*
   * `--amount` names one deposit. Spread over several it is either per-mandate or a total,
   * and an operator could reasonably have meant either — so it is refused rather than
   * guessed at.
   */
  it('will not spread --amount over more than one mandate', async () => {
    await expect(
      fund({
        env: env(),
        args: args({ amount: '1' }),
        venue: fakeVenue([venueMandate(A, 50_000n), venueMandate(B, 40_000n)]),
        reader: fakeReader(),
        wallet: fakeWallet(6_000_000n),
        logger,
      }),
    ).rejects.toThrow(/single mandate/);
  });

  it('reads --amount as USDC, at the ERC-20 scale', async () => {
    const outcomes = await fund({
      env: env(),
      args: args({ mandateIds: [A], amount: '2.5' }),
      venue: fakeVenue([venueMandate(A, 50_000n)]),
      reader: fakeReader(),
      wallet: fakeWallet(6_000_000n),
      logger,
    });
    if (outcomes[0]?.kind !== 'planned') throw new Error('expected a plan');
    expect(outcomes[0].plan.amountUsdcMinor).toBe(2_500_000n);
  });
});

describe('summarise', () => {
  it('says plainly that a run without --execute moved nothing', () => {
    expect(summarise([], args())).toContain('Dry run');
    expect(summarise([], args())).toContain('--execute');
  });

  it('does not say "dry run" once capital could have moved', () => {
    expect(summarise([], args({ execute: true }))).not.toContain('Dry run');
  });
});
