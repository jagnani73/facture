/**
 * Formatting for money, rates and dates.
 *
 * Two rules this module exists to enforce:
 *   1. A raw `bigint` is never rendered. Money stays in minor units everywhere in the
 *      app and becomes a string only here, on top of the shared package's own
 *      `formatMinorUnits` so the venue and the screen never disagree about a figure.
 *   2. Nothing depends on `Intl` locale data or on the machine's timezone, so a number
 *      rendered on the server is byte-identical to the same number rendered in the
 *      browser and hydration is quiet.
 */

import type { Currency, MinorUnits } from './domain';
import { CURRENCY_SYMBOL, formatMinorUnits } from './domain';

/** Minor-unit exponent for USD. Cents, matching `CURRENCY_DECIMALS` in the shared package. */
export const USD_DECIMALS = 2;

const SCALE = 10n ** BigInt(USD_DECIMALS);

/** Build minor units from a major-unit number. Fixture and form-input helper. */
export function toMinor(major: number): MinorUnits {
  return BigInt(Math.round(major * 100));
}

/** Lossy on purpose — only for bar widths and ratios, never for display of an amount. */
export function toMajor(minor: MinorUnits): number {
  return Number(minor) / Number(SCALE);
}

export interface MoneyOptions {
  /** `2` for an exact figure, `0` for a headline. Default 2. */
  fractionDigits?: 0 | 2;
  currency?: Currency;
  /** Show the currency symbol. Default true. */
  symbol?: boolean;
}

/** `formatMoney(3_947_397n)` -> `"$39,473.97"` */
export function formatMoney(minor: MinorUnits, options: MoneyOptions = {}): string {
  const { fractionDigits = 2, currency = 'USD', symbol = true } = options;

  if (fractionDigits === 2) {
    return formatMinorUnits(minor, currency, { symbol, grouping: true });
  }

  // Whole units, rounded half-up, for headline figures where cents are noise.
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = (abs + SCALE / 2n) / SCALE;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${symbol ? CURRENCY_SYMBOL[currency] : ''}${grouped}`;
}

/** Column headers and meters, where two decimals are noise: `"$250k"`, `"$1.25m"`. */
export function formatMoneyCompact(minor: MinorUnits, currency: Currency = 'USD'): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const major = abs / SCALE;
  const sign = negative ? '-' : '';
  const symbol = CURRENCY_SYMBOL[currency];

  if (major >= 1_000_000n) {
    const hundredths = (major * 100n) / 1_000_000n;
    return `${sign}${symbol}${(Number(hundredths) / 100).toFixed(2)}m`;
  }
  if (major >= 1_000n) {
    const tenths = (major * 10n) / 1_000n;
    const value = Number(tenths) / 10;
    return `${sign}${symbol}${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}k`;
  }
  return formatMoney(minor, { fractionDigits: 0, currency });
}

/** Basis points to a percentage string. `formatRate(800)` -> `"8.00%"` */
export function formatRate(bps: number, fractionDigits = 2): string {
  const pct = bps / 100;
  const sign = pct < 0 ? '-' : '';
  return `${sign}${Math.abs(pct).toFixed(fractionDigits)}%`;
}

/** A move in the curve, always signed. `formatBpsDelta(-12)` -> `"-12 bps"` */
export function formatBpsDelta(bps: number): string {
  if (bps === 0) return 'unchanged';
  return `${bps < 0 ? '-' : '+'}${Math.abs(Math.round(bps))} bps`;
}

/** A 0–1 ratio as a percentage. */
export function formatPercent(ratio: number, fractionDigits = 1): string {
  return `${(ratio * 100).toFixed(fractionDigits)}%`;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function parts(iso: string): { y: number; m: number; d: number } {
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth(), d: date.getUTCDate() };
}

/** `"30 Nov 2026"` — UTC, unambiguous, and identical on both sides of hydration. */
export function formatDate(iso: string): string {
  const { y, m, d } = parts(iso);
  return `${d} ${MONTHS[m] ?? '???'} ${y}`;
}

/** `"30 November"` — for prose, where the year is obvious from context. */
export function formatDateProse(iso: string): string {
  const { m, d } = parts(iso);
  return `${d} ${MONTHS_LONG[m] ?? '???'}`;
}

/** `"30 Nov 26"` — dense table column. */
export function formatDateShort(iso: string): string {
  const { y, m, d } = parts(iso);
  return `${d.toString().padStart(2, '0')} ${MONTHS[m] ?? '???'} ${(y % 100).toString().padStart(2, '0')}`;
}

/** `"14:32 UTC"` on a timestamp. */
export function formatTimeUtc(iso: string): string {
  const date = new Date(iso);
  const hh = date.getUTCHours().toString().padStart(2, '0');
  const mm = date.getUTCMinutes().toString().padStart(2, '0');
  return `${hh}:${mm} UTC`;
}

export function formatDateTime(iso: string): string {
  return `${formatDate(iso)}, ${formatTimeUtc(iso)}`;
}

/** `"60 days"`, `"1 day"`, `"today"`. */
export function formatDays(days: number): string {
  if (days === 0) return 'today';
  const n = Math.abs(days);
  return `${n} ${n === 1 ? 'day' : 'days'}`;
}

/** `"in 60 days"`, `"due today"`, `"14 days overdue"`. */
export function formatDueIn(days: number): string {
  if (days === 0) return 'due today';
  if (days < 0) return `${formatDays(days)} overdue`;
  return `in ${formatDays(days)}`;
}

/** Long identifiers, elided in the middle so both ends stay checkable. */
export function elide(value: string, head = 10, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
