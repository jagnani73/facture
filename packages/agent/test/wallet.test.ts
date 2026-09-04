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
  createWalletClient,
  formatTokenAmount,
  parseTokenAmount,
  selectUsdcBalance,
  USDC_DECIMALS,
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
