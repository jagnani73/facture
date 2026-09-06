/**
 * The decimals boundary.
 *
 * Circle speaks decimal strings; this package speaks `bigint` minor units. Everything that
 * can go wrong on the money path in this repo goes wrong here — USDC is 6 decimals on the
 * ERC-20 interface and 18 in Arc's native gas accounting over the same balance, and a
 * conversion that quietly split the difference is a 10^12 error that looks like a different
 * asset rather than a rounding bug.
 */

import { describe, expect, it } from 'vitest';
import { ARC_TESTNET } from '@facture/shared';
import {
  ARC_MIN_MAX_FEE_GWEI,
  ARC_TESTNET_BLOCKCHAIN,
  arcAbsoluteFee,
  classifyTransactionState,
  createWalletClient,
  formatTokenAmount,
  parseTokenAmount,
  pollTransaction,
  selectUsdcBalance,
  USDC_DECIMALS,
  type TransactionOutcome,
} from '../src/wallet.js';

describe('constants come from @facture/shared, not from a second copy', () => {
  it('uses the ERC-20 scale, never the 18-decimal native gas scale', () => {
    expect(USDC_DECIMALS).toBe(6);
    expect(USDC_DECIMALS).toBe(ARC_TESTNET.tokens.USDC.decimals);
    expect(USDC_DECIMALS).not.toBe(18);
  });

  it('settles on Arc testnet', () => {
    expect(ARC_TESTNET_BLOCKCHAIN).toBe('ARC-TESTNET');
    expect(ARC_TESTNET.chainId).toBe(5042002);
  });
});

describe('parseTokenAmount', () => {
  it.each([
    ['5', 5_000_000n],
    ['5.0', 5_000_000n],
    ['5.000000', 5_000_000n],
    ['0', 0n],
    ['0.000001', 1n],
    ['39178.08', 39_178_080_000n],
    ['1000000', 1_000_000_000_000n],
  ])('reads %s as %s minor units', (input, expected) => {
    expect(parseTokenAmount(input, 6)).toBe(expected);
  });

  it('returns a bigint, never a number', () => {
    expect(typeof parseTokenAmount('5', 6)).toBe('bigint');
  });

  it('is exact for an amount a double could not hold', () => {
    // 10^13 USDC. At 6 decimals that is 10^19 minor units, past Number.MAX_SAFE_INTEGER.
    const parsed = parseTokenAmount('10000000000000.000001', 6);
    expect(parsed).toBe(10_000_000_000_000_000_001n);
    expect(parsed).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it('throws rather than truncating excess precision — that is a scale mismatch', () => {
    // Seven decimals on a six-decimal token: the caller and the token disagree, and
    // dropping the digit would turn the disagreement into a plausible-looking amount.
    expect(() => parseTokenAmount('5.0000001', 6)).toThrow(/more than 6 decimal places/);
    // The 18-decimal form of 5 USDC, handed to the 6-decimal interface.
    expect(() => parseTokenAmount('0.000000000000000005', 6)).toThrow(/decimals mismatch/);
  });

  it('rejects anything that is not a plain decimal', () => {
    for (const bad of ['', '5e6', '0x5', 'five', '5,000', '.5', '5.']) {
      expect(() => parseTokenAmount(bad, 6)).toThrow();
    }
  });
});

describe('formatTokenAmount', () => {
  it.each([
    [5_000_000n, '5'],
    [0n, '0'],
    [1n, '0.000001'],
    [3_917_808n, '3.917808'],
    [39_178_080_000n, '39178.08'],
  ])('renders %s as %s', (amount, expected) => {
    expect(formatTokenAmount(amount, 6)).toBe(expected);
  });

  it('round-trips through parse for every amount', () => {
    for (const amount of [0n, 1n, 999_999n, 5_000_000n, 3_917_808n, 10n ** 20n]) {
      expect(parseTokenAmount(formatTokenAmount(amount, 6), 6)).toBe(amount);
    }
  });

  it('never emits grouping separators — this is a wire value, not a display string', () => {
    expect(formatTokenAmount(1_234_567_890_000n, 6)).toBe('1234567.89');
  });
});

describe('scale conversion is not symmetric, and that is the point', () => {
  it('a 6-decimal balance scaled to cents truncates against spending', () => {
    // 5.009999 USDC is 500 cents of spendable money, not 501.
    const usdc = parseTokenAmount('5.009999', 6);
    expect(usdc / 10_000n).toBe(500n);
  });

  it('cents scaled up to 6 decimals is exact — the amount actually sent loses nothing', () => {
    expect(3_917_808n * 10_000n).toBe(39_178_080_000n);
    expect(formatTokenAmount(3_917_808n * 10_000n, 6)).toBe('39178.08');
  });
});

describe('arcAbsoluteFee', () => {
  it('pins Arc’s 20 gwei floor, taken from @facture/shared', () => {
    expect(ARC_MIN_MAX_FEE_GWEI).toBe(20);
    expect(BigInt(ARC_MIN_MAX_FEE_GWEI) * 1_000_000_000n).toBe(ARC_TESTNET.minMaxFeePerGasWei);
  });

  it('is absolute, not a fee level — a dynamic level does not know about the floor', () => {
    const fee = arcAbsoluteFee();
    expect(fee.type).toBe('absolute');
    if (fee.type !== 'absolute') return;
    expect(fee.config.maxFee).toBe('20');
    expect(Number(fee.config.maxFee)).toBeGreaterThanOrEqual(ARC_MIN_MAX_FEE_GWEI);
    expect(Number(fee.config.priorityFee)).toBeLessThanOrEqual(Number(fee.config.maxFee));
  });
});

describe('selectUsdcBalance', () => {
  /**
   * Exactly what Circle returned for the Arc-testnet wallet holding 5 USDC. The same money
   * appears twice, at 18 decimals as the native gas token and at 6 as the ERC-20 — the
   * 18-vs-6 trap, live in the API response rather than only in the docs.
   */
  const LIVE_RESPONSE = [
    {
      amount: '5',
      updateDate: '2026-09-01T00:00:00.000Z',
      token: {
        id: '15dc2b5d-0994-58b0-bf8c-3a0501148ee8',
        blockchain: 'ARC-TESTNET' as const,
        symbol: 'USDC',
        decimals: 18,
        isNative: true,
        updateDate: '2026-09-01T00:00:00.000Z',
        createDate: '2026-09-01T00:00:00.000Z',
      },
    },
    {
      amount: '5',
      updateDate: '2026-09-01T00:00:00.000Z',
      token: {
        id: 'ef87c8c3-85de-598a-af50-c5135eecfa74',
        blockchain: 'ARC-TESTNET' as const,
        symbol: 'USDC',
        decimals: 6,
        isNative: false,
        tokenAddress: '0x3600000000000000000000000000000000000000',
        updateDate: '2026-09-01T00:00:00.000Z',
        createDate: '2026-09-01T00:00:00.000Z',
      },
    },
  ];

  const USDC_ADDRESS = ARC_TESTNET.tokens.USDC.address;

  it('picks the 6-decimal ERC-20 entry, not the 18-decimal native one', () => {
    const balance = selectUsdcBalance(LIVE_RESPONSE, USDC_ADDRESS);
    expect(balance?.decimals).toBe(6);
    expect(balance?.amount).toBe(5_000_000n);
    // The native entry would have read as 5×10^18 — a 10^12 error in every comparison.
    expect(balance?.amount).not.toBe(5_000_000_000_000_000_000n);
  });

  it('picks by contract address regardless of the order Circle returns them in', () => {
    const reversed = [...LIVE_RESPONSE].reverse();
    expect(selectUsdcBalance(reversed, USDC_ADDRESS)?.amount).toBe(5_000_000n);
  });

  it('is case-insensitive about the address', () => {
    expect(selectUsdcBalance(LIVE_RESPONSE, USDC_ADDRESS.toUpperCase())?.amount).toBe(5_000_000n);
  });

  it('ignores an impostor token that merely calls itself USDC', () => {
    const impostor = [
      {
        ...LIVE_RESPONSE[1]!,
        token: {
          ...LIVE_RESPONSE[1]!.token,
          tokenAddress: '0xdead000000000000000000000000000000000000',
        },
      },
    ];
    expect(selectUsdcBalance(impostor, USDC_ADDRESS)).toBeNull();
  });

  it('returns null rather than zero when the wallet has no USDC record', () => {
    // "No balance record" and "a balance of zero" are the same amount but not the same
    // fact when the question is whether a mandate is funded.
    expect(selectUsdcBalance([], USDC_ADDRESS)).toBeNull();
  });

  it('refuses to guess a scale when Circle omits decimals', () => {
    // The field is optional on Circle's own type. Falling back to 6 would be a guess about
    // a scale, and a wrong guess is a 10^n error in an amount.
    const erc20 = LIVE_RESPONSE[1]!;
    const { decimals: _dropped, ...tokenWithoutDecimals } = erc20.token;
    const noDecimals = [{ ...erc20, token: tokenWithoutDecimals }];

    expect(() => selectUsdcBalance(noDecimals, USDC_ADDRESS)).toThrow(/refusing to guess a scale/);
  });
});

describe('createWalletClient', () => {
  it('refuses to start without credentials rather than failing at the first call', () => {
    expect(() => createWalletClient({ apiKey: '', entitySecret: 'a'.repeat(64) })).toThrow(
      /CIRCLE_API_KEY/,
    );
    expect(() => createWalletClient({ apiKey: 'k', entitySecret: '' })).toThrow(
      /CIRCLE_ENTITY_SECRET/,
    );
  });

  it('defaults to Arc testnet USDC from shared, and lets it be overridden', () => {
    const client = createWalletClient({ apiKey: 'k', entitySecret: 'a'.repeat(64) });
    expect(client.blockchain).toBe('ARC-TESTNET');
    expect(client.usdcAddress).toBe(ARC_TESTNET.tokens.USDC.address);
    expect(client.usdcAddress).toBe('0x3600000000000000000000000000000000000000');
  });
});

/* ── a write is not a receipt ────────────────────────────────────────────────────────── */

/**
 * The three-way reading of Circle's transaction states.
 *
 * This repo has shipped "the call succeeded so the transaction succeeded" twice — a
 * `deployBond` selector and a uniqueness claim — and the money path here is the agent's own
 * capital. What these guard is the opposite mistake, which is newer and worse: reporting a
 * transaction that has not answered yet as one that failed.
 */
describe('classifyTransactionState', () => {
  it('counts only a mined transaction as a success', () => {
    expect(classifyTransactionState('CONFIRMED')).toBe('succeeded');
    expect(classifyTransactionState('COMPLETE')).toBe('succeeded');
  });

  it('counts only a terminal refusal as a failure', () => {
    expect(classifyTransactionState('FAILED')).toBe('failed');
    expect(classifyTransactionState('DENIED')).toBe('failed');
    expect(classifyTransactionState('CANCELLED')).toBe('failed');
  });

  it('reads everything in flight as unknown, not as failure', () => {
    for (const state of ['INITIATED', 'QUEUED', 'CLEARED', 'SENT']) {
      expect(classifyTransactionState(state)).toBe('unknown');
    }
  });

  /*
   * STUCK is a transaction Circle has broadcast and cannot get mined at the fee it bid. It
   * can still confirm, or be accelerated. Calling it failed would be a false negative on the
   * one path where a false negative costs real money twice.
   */
  it('does not call a stuck transaction a failed one', () => {
    expect(classifyTransactionState('STUCK')).toBe('unknown');
    expect(classifyTransactionState('STUCK')).not.toBe('failed');
  });
});

const outcome = (over: Partial<TransactionOutcome> = {}): TransactionOutcome => ({
  id: 'tx-1',
  state: 'INITIATED',
  result: 'unknown',
  txHash: null,
  errorReason: null,
  errorDetails: null,
  timedOut: false,
  ...over,
});

/** Replies with each queued outcome in turn, then repeats the last one. */
const replies = (
  queue: readonly (TransactionOutcome | Error)[],
): ((id: string) => Promise<TransactionOutcome>) => {
  let i = 0;
  return async () => {
    const next = queue[Math.min(i, queue.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error('nothing queued');
    return next;
  };
};

const noWait = { pollIntervalMs: 0, sleep: async (): Promise<void> => {} };

describe('pollTransaction', () => {
  it('waits through the in-flight states and returns the answer', async () => {
    const result = await pollTransaction(
      replies([
        outcome({ state: 'INITIATED' }),
        outcome({ state: 'SENT' }),
        outcome({ state: 'CONFIRMED', result: 'succeeded', txHash: '0xabc' }),
      ]),
      'tx-1',
      { ...noWait, timeoutMs: 1_000 },
    );
    expect(result.result).toBe('succeeded');
    expect(result.txHash).toBe('0xabc');
    expect(result.timedOut).toBe(false);
  });

  it('returns a failure as soon as it is terminal', async () => {
    const result = await pollTransaction(
      replies([outcome({ state: 'FAILED', result: 'failed', errorReason: 'reverted' })]),
      'tx-1',
      { ...noWait, timeoutMs: 1_000 },
    );
    expect(result.result).toBe('failed');
    expect(result.errorReason).toBe('reverted');
  });

  it('stops asking about a stuck transaction without calling it failed', async () => {
    const result = await pollTransaction(replies([outcome({ state: 'STUCK' })]), 'tx-1', {
      ...noWait,
      timeoutMs: 1_000,
    });
    expect(result.state).toBe('STUCK');
    expect(result.result).toBe('unknown');
    expect(result.timedOut).toBe(false);
  });

  it('gives up as unknown, never as failed', async () => {
    const result = await pollTransaction(replies([outcome({ state: 'SENT' })]), 'tx-1', {
      ...noWait,
      timeoutMs: 0,
    });
    expect(result.result).toBe('unknown');
    expect(result.timedOut).toBe(true);
  });

  /*
   * A read that throws says nothing about the transaction. Letting it propagate would turn a
   * transient network fault into a report that the agent's capital did not move.
   */
  it('keeps polling through a read that throws', async () => {
    const result = await pollTransaction(
      replies([new Error('socket hang up'), outcome({ state: 'CONFIRMED', result: 'succeeded' })]),
      'tx-1',
      { ...noWait, timeoutMs: 1_000 },
    );
    expect(result.result).toBe('succeeded');
  });

  it('reports unknown rather than throwing when every read fails', async () => {
    const result = await pollTransaction(replies([new Error('socket hang up')]), 'tx-1', {
      ...noWait,
      timeoutMs: 0,
    });
    expect(result.result).toBe('unknown');
    expect(result.timedOut).toBe(true);
    expect(result.id).toBe('tx-1');
  });
});
