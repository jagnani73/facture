import type { MinorUnits } from '@/lib/domain';
import type { MoneyOptions } from '@/lib/format';
import { formatBpsDelta, formatMoney, formatMoneyCompact, formatRate } from '@/lib/format';

/**
 * The only sanctioned way to put an amount on screen. `bigint` never leaves the
 * data layer as a number and never reaches the DOM as a raw value.
 */
export function Money({
  minor,
  compact = false,
  className = '',
  ...options
}: MoneyOptions & {
  minor: MinorUnits;
  /** Drop the cents: `$250k` rather than `$250,000.00`. */
  compact?: boolean | undefined;
  className?: string | undefined;
}) {
  const text = compact ? formatMoneyCompact(minor, options.currency) : formatMoney(minor, options);
  return (
    <span className={`num ${className}`} data-num>
      {text}
    </span>
  );
}

/** An annualised rate in basis points. */
export function Rate({
  bps,
  fractionDigits = 2,
  className = '',
}: {
  bps: number;
  fractionDigits?: number | undefined;
  className?: string | undefined;
}) {
  return (
    <span className={`num ${className}`} data-num>
      {formatRate(bps, fractionDigits)}
    </span>
  );
}

/** A move in the curve. Green tighter, red wider — from the seller's side. */
export function BpsDelta({ bps, className = '' }: { bps: number; className?: string | undefined }) {
  const tone = bps === 0 ? 'text-faint' : bps < 0 ? 'text-pos' : 'text-neg';
  return (
    <span className={`num ${tone} ${className}`} data-num>
      {formatBpsDelta(bps)}
    </span>
  );
}
