import type { MinorUnits } from '@/lib/domain';
import { formatMoney, formatPercent, toMajor } from '@/lib/format';
import type { Position } from '@/lib/pricing';
import { Money } from './money';

/**
 * How much of a mandate's committed capital is out, and against whom.
 *
 * Stacked by customer rather than shown as one bar, because the number a funder
 * actually worries about is concentration, not utilisation. The per-customer cap
 * is drawn as a tick so a segment approaching it is visible at a glance.
 */

const RAMP = [
  'var(--ramp-1)',
  'var(--ramp-2)',
  'var(--ramp-3)',
  'var(--ramp-4)',
  'var(--ramp-5)',
  'var(--ramp-6)',
];

export interface ExposureMeterProps {
  totalCommitted: MinorUnits;
  allocated: MinorUnits;
  maxPerDebtor: MinorUnits;
  positions: readonly Position[];
  compact?: boolean;
}

export function ExposureMeter({
  totalCommitted,
  allocated,
  maxPerDebtor,
  positions,
  compact = false,
}: ExposureMeterProps) {
  const commitment = toMajor(totalCommitted);
  const used = commitment === 0 ? 0 : toMajor(allocated) / commitment;
  const headroom = totalCommitted - allocated;

  const byDebtor = new Map<string, { name: string; minor: MinorUnits }>();
  for (const position of positions) {
    if (position.state !== 'open') continue;
    const entry = byDebtor.get(position.debtorId);
    if (entry) entry.minor += position.outlay;
    else byDebtor.set(position.debtorId, { name: position.debtorName, minor: position.outlay });
  }
  const segments = [...byDebtor.values()].sort((a, b) => (b.minor > a.minor ? 1 : -1));
  const capShare = commitment === 0 ? 0 : toMajor(maxPerDebtor) / commitment;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <span className="label-micro">Exposure used</span>
        <span className="num text-xs text-muted" data-num>
          {formatPercent(used, 0)}
        </span>
      </div>

      <div className="relative mt-2 h-2.5 w-full overflow-hidden rounded-xs bg-inset">
        <div className="flex h-full">
          {segments.map((segment, index) => (
            <div
              key={segment.name}
              title={`${segment.name} · ${formatMoney(segment.minor)}`}
              style={{
                width: `${commitment === 0 ? 0 : (toMajor(segment.minor) / commitment) * 100}%`,
                backgroundColor: RAMP[index % RAMP.length],
              }}
            />
          ))}
        </div>
        {capShare > 0 && capShare < 1 ? (
          <span
            aria-hidden
            title="Per-customer cap"
            className="absolute top-0 h-full w-px bg-ink/40"
            style={{ left: `${capShare * 100}%` }}
          />
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs">
        <span className="text-muted">
          <Money minor={allocated} className="text-ink" /> of{' '}
          <Money minor={totalCommitted} fractionDigits={0} />
        </span>
        <span className="text-muted">
          <Money minor={headroom} className="text-ink" /> still to deploy
        </span>
      </div>

      {compact ? null : (
        <ul className="mt-3 space-y-1">
          {segments.map((segment, index) => {
            const overCap = segment.minor > maxPerDebtor;
            return (
              <li key={segment.name} className="flex items-center gap-2 text-xs">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-xs"
                  style={{ backgroundColor: RAMP[index % RAMP.length] }}
                />
                <span className="min-w-0 flex-1 truncate text-muted">{segment.name}</span>
                <Money minor={segment.minor} className={overCap ? 'text-neg' : 'text-ink'} />
              </li>
            );
          })}
          {segments.length === 0 ? (
            <li className="text-xs text-faint">Nothing deployed yet.</li>
          ) : null}
        </ul>
      )}
    </div>
  );
}
