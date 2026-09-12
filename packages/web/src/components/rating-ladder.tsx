import { formatRate } from '@/lib/format';
import type { LadderRung } from '@/lib/pricing';
import { RatingChip } from './rating-chip';

/**
 * The same paper, at five credits.
 *
 * A rating on this market is not bought from anyone — it is a count of invoices a customer
 * has settled here — so what it is worth has to be shown rather than claimed. Identical
 * paper read against the standing bids at each rating is that number, and the spread between
 * the top rung and the bottom is precisely what a customer earns by paying on time.
 *
 * `D` is on the ladder because nothing takes it. A mandate written at the widest floor still
 * refuses a customer who has actually failed to pay, so the last rung has no bar, and the
 * permanence of a default is a gap on a chart rather than a sentence asking to be believed.
 */
export function RatingLadder({
  rungs,
  atTenorDays,
  className = '',
}: {
  rungs: readonly LadderRung[];
  atTenorDays: number;
  className?: string | undefined;
}) {
  const rates = rungs.map((r) => r.bestRateBps).filter((r): r is number => r !== null);

  if (rates.length === 0) {
    return (
      <p className={`text-sm text-muted ${className}`}>
        Nothing is standing at {atTenorDays} days, so the curve has no price at any rating.
      </p>
    );
  }

  // Widest bid anchors the bar. Floored at a point of headroom so a book whose bids all sit
  // at one rate draws five equal bars rather than dividing by zero and drawing none.
  const widest = Math.max(...rates);
  const scale = Math.max(widest, 1);

  // Whole-percent ticks, thinned so they never collide at a narrow card width.
  const step = scale > 3000 ? 1000 : scale > 1200 ? 500 : 200;
  const ticks: number[] = [];
  for (let bps = 0; bps <= scale; bps += step) ticks.push(bps);

  const takerCount = rungs.reduce((most, rung) => Math.max(most, rung.takers), 0);

  return (
    // A flex column so the closing note can be pushed to the card's baseline by `mt-auto`,
    // which is what keeps this card and the curve beside it ending on one line.
    <div className={`flex flex-1 flex-col ${className}`}>
      <ol className="space-y-2">
        {rungs.map((rung) => {
          const width = rung.bestRateBps === null ? 0 : (rung.bestRateBps / scale) * 100;

          return (
            <li
              key={rung.rating}
              className="grid grid-cols-[2.5rem_1fr_4rem] items-center gap-3"
              title={
                rung.bestRateBps === null
                  ? 'No standing bid will take this credit.'
                  : `${rung.takers} standing bid${rung.takers === 1 ? '' : 's'} would take it.`
              }
            >
              <RatingChip rating={rung.rating} />

              <span className="relative block h-5 rounded-xs bg-inset">
                {rung.bestRateBps === null ? (
                  <span className="absolute inset-y-0 left-2 flex items-center text-xs text-faint">
                    nothing will take it
                  </span>
                ) : (
                  <span
                    className="absolute inset-y-0 left-0 rounded-xs"
                    style={{
                      width: `${width}%`,
                      backgroundColor: 'var(--accent)',
                      opacity: 0.7,
                    }}
                  />
                )}
              </span>

              <span className="num text-right text-xs" data-num>
                {rung.bestRateBps === null ? (
                  <span className="text-faint">&mdash;</span>
                ) : (
                  formatRate(rung.bestRateBps, 2)
                )}
              </span>
            </li>
          );
        })}
      </ol>

      {/*
        An axis, in the bars' own column so the ticks sit under the track rather than under the
        card. The curve beside this one carries one and this did not, which left five bars
        floating against no scale — the rate on the right told you each bar's value and nothing
        told you what its length meant.
      */}
      <div className="mt-2 grid grid-cols-[2.5rem_1fr_4rem] gap-3">
        <span />
        <span className="relative block h-4">
          {ticks.map((bps) => (
            <span
              key={bps}
              className="num absolute top-0 text-[0.625rem] text-faint"
              style={{
                left: `${(bps / scale) * 100}%`,
                transform: bps === 0 ? 'none' : 'translateX(-50%)',
              }}
              data-num
            >
              {formatRate(bps, 0)}
            </span>
          ))}
        </span>
        <span />
      </div>

      <p className="mt-4 text-xs text-muted">
        Read at {atTenorDays} days, across {takerCount} standing{' '}
        {takerCount === 1 ? 'bid' : 'bids'}.
      </p>

      <p className="mt-auto pt-3 text-xs text-muted">
        Each bar is the tightest standing bid that would take this credit, so a shorter bar is
        cheaper money. This reads the curve; it is not a quote. A real price also clears the
        buyer&rsquo;s remaining capital and their limit on this one customer.
      </p>
    </div>
  );
}
