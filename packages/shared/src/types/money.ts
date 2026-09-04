/**
 * Integer money helpers. Every amount in Facture is a `bigint` in minor units, and these
 * are the only division primitives the money path is allowed to use — `Number` never
 * touches an amount.
 */

import { CURRENCY_DECIMALS, CURRENCY_SYMBOL, type Currency, type MinorUnits } from './common.js';

/** Division rounding towards +infinity. `b` must be positive. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError(`ceilDiv: divisor must be positive, got ${b}`);
  const q = a / b;
  // bigint division truncates towards zero, so only a positive remainder needs a bump.
  return a % b === 0n || a < 0n ? q : q + 1n;
}

/** Division rounding towards -infinity. `b` must be positive. */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError(`floorDiv: divisor must be positive, got ${b}`);
  const q = a / b;
  return a % b === 0n || a > 0n ? q : q - 1n;
}

export const maxBigInt = (a: bigint, b: bigint): bigint => (a > b ? a : b);
export const minBigInt = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const absBigInt = (a: bigint): bigint => (a < 0n ? -a : a);

/**
 * Rescale minor units between two decimal exponents — e.g. invoice cents (2dp) to USDC
 * ERC-20 units (6dp). Scaling down truncates, so the caller must decide whether that
 * rounding belongs to the payer or the payee; scaling up is exact.
 */
export function scaleMinorUnits(
  amount: MinorUnits,
  fromDecimals: number,
  toDecimals: number,
): MinorUnits {
  if (!Number.isInteger(fromDecimals) || !Number.isInteger(toDecimals)) {
    throw new RangeError('scaleMinorUnits: decimals must be integers');
  }
  if (fromDecimals < 0 || toDecimals < 0) {
    throw new RangeError('scaleMinorUnits: decimals must be non-negative');
  }
  const delta = toDecimals - fromDecimals;
  if (delta === 0) return amount;
  const factor = 10n ** BigInt(Math.abs(delta));
  return delta > 0 ? amount * factor : amount / factor;
}

/**
 * `4_000_000n, 'USD'` -> `"40,000.00"`. Presentation only — never feed the output back
 * into arithmetic.
 */
export function formatMinorUnits(
  amount: MinorUnits,
  currency: Currency,
  options: { readonly symbol?: boolean; readonly grouping?: boolean } = {},
): string {
  const { symbol = false, grouping = true } = options;
  const decimals = CURRENCY_DECIMALS[currency];
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals > 0 ? digits.slice(digits.length - decimals) : '';
  const grouped = grouping ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole;
  const body = fraction === '' ? grouped : `${grouped}.${fraction}`;
  return `${negative ? '-' : ''}${symbol ? CURRENCY_SYMBOL[currency] : ''}${body}`;
}

/** `"40,000.00", 'USD'` -> `4_000_000n`. Rejects anything with excess precision. */
export function parseDecimalToMinorUnits(input: string, currency: Currency): MinorUnits {
  const decimals = CURRENCY_DECIMALS[currency];
  const cleaned = input.trim().replace(/[,_\s]/g, '');
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(cleaned);
  if (match === null) throw new RangeError(`parseDecimalToMinorUnits: not a decimal: ${input}`);
  const [, sign = '', whole = '0', fraction = ''] = match;
  if (fraction.length > decimals) {
    throw new RangeError(
      `parseDecimalToMinorUnits: ${input} has more than ${decimals} decimal places for ${currency}`,
    );
  }
  const scaled = BigInt(whole + fraction.padEnd(decimals, '0'));
  return sign === '-' ? -scaled : scaled;
}

/** Basis points as a human percentage string: `1250 -> "12.50%"`. */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}
