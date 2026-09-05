/**
 * Rendering an amount in the unit it is actually denominated in.
 *
 * `formatMoney` renders minor units at 2 decimals with a dollar sign. USDC on its ERC-20
 * interface has 6, and the two were confused: the mandate screen rendered a vault balance
 * with the dollar formatter, so 5,000,000 USDC minor units — five dollars of USDC — read as
 * "Backed by $50,000.00". Nothing type-checks that mistake, because both are `bigint`.
 *
 * `formatUsdc` exists so the two are separate functions rather than an option on one, and
 * these cases pin the boundary between them.
 */

import { describe, expect, it } from 'vitest';
import { formatMoney, formatUsdc } from '@/lib/format';

describe('formatUsdc', () => {
  it('renders the amount the demo vault actually holds', () => {
    expect(formatUsdc(5_000_000n)).toBe('5 USDC');
  });

  /* What $50,000.00 converts to at the deployment's 1 ppm scale. */
  it('renders a testnet-scaled requirement', () => {
    expect(formatUsdc(50_000n)).toBe('0.05 USDC');
  });

  it('drops trailing zeroes rather than claiming precision', () => {
    expect(formatUsdc(1_500_000n)).toBe('1.5 USDC');
    expect(formatUsdc(1_000_000n)).toBe('1 USDC');
  });

  it('keeps significant digits all the way down to a minor unit', () => {
    expect(formatUsdc(1n)).toBe('0.000001 USDC');
    expect(formatUsdc(59_331n)).toBe('0.059331 USDC');
  });

  it('groups thousands and handles zero and negatives', () => {
    expect(formatUsdc(1_234_567_000_000n)).toBe('1,234,567 USDC');
    expect(formatUsdc(0n)).toBe('0 USDC');
    expect(formatUsdc(-2_500_000n)).toBe('-2.5 USDC');
  });

  /*
   * The confusion itself, written down. The same bigint through the two formatters differs
   * by four orders of magnitude, and only one of them is true of a vault balance.
   */
  it('disagrees with formatMoney by the factor that caused the bug', () => {
    expect(formatMoney(5_000_000n)).toBe('$50,000.00');
    expect(formatUsdc(5_000_000n)).toBe('5 USDC');
  });
});
