import { formatRate } from '@/lib/format';
import type { CurvePoint } from '@/lib/pricing';

/**
 * The curve.
 *
 * There is no model behind this line. It is the standing bids, plotted at the
 * longest tenor each will hold and the rate each pays — which is the whole
 * argument of the market drawn in one shape: nobody had to price this invoice,
 * because the prices were already sitting there.
 */

const W = 480;
const H = 156;
const PAD = { top: 14, right: 14, bottom: 26, left: 38 };

export interface CurveStripProps {
  points: readonly CurvePoint[];
  /** Where one particular invoice sits on the curve. */
  marker?: { tenorDays: number; annualisedYieldBps: number; label: string } | undefined;
  className?: string | undefined;
}

export function CurveStrip({ points, marker, className = '' }: CurveStripProps) {
  if (points.length === 0) {
    return <p className={`text-sm text-muted ${className}`}>No standing bids.</p>;
  }

  const maxDays = Math.max(120, ...points.map((p) => p.tenorDays), marker?.tenorDays ?? 0);
  const rates = [
    ...points.map((p) => p.annualisedYieldBps),
    marker?.annualisedYieldBps ?? 0,
  ].filter((r) => r > 0);
  const minRate = Math.min(...rates);
  const maxRate = Math.max(...rates);
  const span = Math.max(maxRate - minRate, 100);
  const lo = minRate - span * 0.18;
  const hi = maxRate + span * 0.18;

  const x = (days: number) => PAD.left + (days / maxDays) * (W - PAD.left - PAD.right);
  const y = (bps: number) => PAD.top + (1 - (bps - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);

  const sorted = [...points].sort((a, b) => a.tenorDays - b.tenorDays);
  const path = sorted
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.tenorDays)},${y(p.annualisedYieldBps)}`)
    .join(' ');
  const area = `${path} L${x(sorted[sorted.length - 1]?.tenorDays ?? 0)},${H - PAD.bottom} L${x(sorted[0]?.tenorDays ?? 0)},${H - PAD.bottom} Z`;

  const dayTicks = [0, 30, 60, 90, 120].filter((d) => d <= maxDays);

  return (
    <figure className={className}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Standing bids from ${formatRate(minRate)} to ${formatRate(maxRate)} annualised across ${maxDays} days`}
      >
        {/* horizontal rules */}
        {[0, 0.5, 1].map((t) => {
          const bps = lo + (hi - lo) * t;
          return (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y(bps)}
                y2={y(bps)}
                stroke="var(--rule)"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 6}
                y={y(bps) + 3}
                textAnchor="end"
                fill="var(--ink-faint)"
                fontSize={9}
                fontFamily="var(--stack-mono)"
              >
                {formatRate(bps, 1)}
              </text>
            </g>
          );
        })}

        <path d={area} fill="var(--accent)" opacity={0.08} />
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth={1.5} />

        {sorted.map((point) => (
          <g key={point.mandateId}>
            <circle
              cx={x(point.tenorDays)}
              cy={y(point.annualisedYieldBps)}
              r={3.5}
              fill="var(--paper-raised)"
              stroke="var(--accent)"
              strokeWidth={1.5}
            />
            {/*
              One string child, not an interpolated fragment. React 19 treats `<title>` as a
              hoistable element and accepts only a single text node, so a multi-child title
              renders empty on the server and populated in the browser — a hydration mismatch
              that took the whole book with it.
            */}
            <title>
              {`${point.label} · ${
                point.minRating === 'UNRATED' ? 'any rating' : `${point.minRating}+`
              } · ${point.tenorDays}d · ${formatRate(point.annualisedYieldBps)}`}
            </title>
          </g>
        ))}

        {marker ? (
          <g>
            <line
              x1={x(marker.tenorDays)}
              x2={x(marker.tenorDays)}
              y1={PAD.top}
              y2={H - PAD.bottom}
              stroke="var(--ink)"
              strokeWidth={1}
              strokeDasharray="2 3"
              opacity={0.5}
            />
            <circle
              cx={x(marker.tenorDays)}
              cy={y(marker.annualisedYieldBps)}
              r={4}
              fill="var(--ink)"
            />
            <text
              x={x(marker.tenorDays) + 7}
              y={y(marker.annualisedYieldBps) - 6}
              fill="var(--ink)"
              fontSize={10}
              fontFamily="var(--stack-mono)"
            >
              {marker.label}
            </text>
          </g>
        ) : null}

        {dayTicks.map((d) => (
          <text
            key={d}
            x={x(d)}
            y={H - 8}
            textAnchor={d === 0 ? 'start' : 'middle'}
            fill="var(--ink-faint)"
            fontSize={9}
            fontFamily="var(--stack-mono)"
          >
            {d}d
          </text>
        ))}
      </svg>
    </figure>
  );
}
