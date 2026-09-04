import { formatMoney, formatMoneyCompact, formatRate, toMajor } from '@/lib/format';
import type { LadderBucket } from '@/lib/pricing';
import { Money } from './money';

/**
 * When the money comes back.
 *
 * A buyer's question is never "how much is out" on its own — it is "how much,
 * and when". The ladder answers both in one shape, and the colour ramp runs
 * cool to warm as tenor lengthens so the weight of a book sitting at the long
 * end is visible without reading a single figure.
 */

const RAMP = [
  'var(--ramp-1)',
  'var(--ramp-2)',
  'var(--ramp-3)',
  'var(--ramp-4)',
  'var(--ramp-5)',
  'var(--ramp-6)',
];

export function MaturityLadder({
  buckets,
  className = '',
}: {
  buckets: readonly LadderBucket[];
  className?: string;
}) {
  const peak = buckets.reduce((max, b) => (b.faceValue > max ? b.faceValue : max), 0n);
  const total = buckets.reduce((sum, b) => sum + b.faceValue, 0n);

  if (total === 0n) {
    return (
      <p className={`text-sm text-muted ${className}`}>
        Nothing outstanding. Every position in this mandate has settled.
      </p>
    );
  }

  const peakMajor = toMajor(peak);

  return (
    <div className={className}>
      <ol className="space-y-2">
        {buckets.map((bucket, index) => {
          const width = peakMajor === 0 ? 0 : (toMajor(bucket.faceValue) / peakMajor) * 100;
          const empty = bucket.count === 0;

          return (
            <li
              key={bucket.label}
              className="grid grid-cols-[3.75rem_1fr_5.5rem] items-center gap-3"
            >
              <span className="num text-xs text-muted" data-num>
                {bucket.label}
              </span>

              <span className="relative block h-5 rounded-xs bg-inset">
                <span
                  className="absolute inset-y-0 left-0 rounded-xs"
                  style={{
                    width: `${Math.max(width, empty ? 0 : 1.5)}%`,
                    backgroundColor: RAMP[index % RAMP.length],
                    opacity: empty ? 0 : 1,
                  }}
                />
                {empty ? null : (
                  <span className="num absolute inset-y-0 right-2 flex items-center text-[0.6875rem] text-muted">
                    {bucket.count} {bucket.count === 1 ? 'invoice' : 'invoices'} ·{' '}
                    {formatRate(bucket.averageRateBps)}
                  </span>
                )}
              </span>

              <span
                className={`num text-right text-xs ${empty ? 'text-faint' : 'text-ink'}`}
                data-num
                title={empty ? undefined : formatMoney(bucket.faceValue)}
              >
                {empty ? '—' : formatMoneyCompact(bucket.faceValue)}
              </span>
            </li>
          );
        })}
      </ol>

      <p className="mt-3 border-t border-rule pt-2.5 text-xs text-muted">
        <Money minor={total} className="text-ink" /> due back across{' '}
        {buckets.reduce((n, b) => n + b.count, 0)} outstanding invoices.
      </p>
    </div>
  );
}
