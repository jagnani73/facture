'use client';

import { unallocated } from '@/lib/domain';
import { formatDate, formatMoneyCompact, formatRate, formatTimeUtc } from '@/lib/format';
import { useMarket } from '@/lib/data/hooks';

/**
 * The strip of figures under the masthead.
 *
 * A newspaper masthead carries the day's numbers, and these are the market's: when it was
 * read, the tightest bid standing, how many mandates are funded and how much of their
 * capital is still uncommitted. They are the market's own summary, so they come from the
 * market rather than being assembled out of anything the chrome knows on its own.
 *
 * **The strip keeps its shape in all three states, and only the figures change.** It used to
 * collapse to a single "Market — reading…" while the venue was being read, so the masthead
 * went from five labelled figures to one unlabelled sentence and back, reflowing the page
 * under the reader on every navigation. The labels are known before the venue answers, so
 * there is no reason to withhold them; what is not known is each value, and that is what
 * renders as a ruled gap.
 *
 * A gap rather than a zero, still. A zero here would read as "no mandates are funded", which
 * is a claim about the market rather than a fact about the page.
 */

/**
 * Each figure's slot, in characters of the mono face.
 *
 * The values are set in `--stack-mono` with `tabular-nums`, so one `ch` is one glyph exactly
 * and these are counted from the longest string each slot can hold: `12 Sep 2026, 08:09 UTC`
 * is 22, `18.50%` is 6, `$123.45m` is 8.
 *
 * Reserving the space is what stops the masthead resizing under the reader. It was doing so
 * twice: once when the skeleton gave way to a value, and again between two perfectly good
 * values, because `$1.56m` and `$237.5k` are different widths and the strip is laid out by its
 * content. Sizing the skeletons to match the values would have fixed only the first.
 */
const FIGURES = [
  { label: 'Market', ch: 22 },
  { label: 'Tightest bid', ch: 6 },
  { label: 'Mandates funded', ch: 3 },
  { label: 'Committed', ch: 8 },
  { label: 'Uncommitted', ch: 8 },
] as const;

export function MarketTicker() {
  const market = useMarket();

  if (market.status !== 'ready') {
    const failed = market.status === 'failed';
    return (
      <Strip busy={!failed}>
        {FIGURES.map((figure) => (
          <Ticker key={figure.label} label={figure.label} ch={figure.ch}>
            {failed ? (
              <span className="text-warn">&mdash;</span>
            ) : (
              <span
                aria-hidden
                className="block h-2.5 animate-pulse rounded-xs bg-sunken"
              />
            )}
          </Ticker>
        ))}
      </Strip>
    );
  }

  const active = market.data.mandates.filter((m) => m.status === 'active');
  const committed = active.reduce((total, m) => total + m.totalCommitted, 0n);
  const free = active.reduce((total, m) => total + unallocated(m), 0n);
  const tightest = active.reduce(
    (best, m) => Math.min(best, m.annualisedYieldBps),
    Number.POSITIVE_INFINITY,
  );

  return (
    <Strip>
      <Ticker label="Market" ch={FIGURES[0].ch}>
        {`${formatDate(market.data.asOfIso)}, ${formatTimeUtc(market.data.asOfIso)}`}
      </Ticker>
      <Ticker label="Tightest bid" ch={FIGURES[1].ch}>
        {active.length === 0 ? '—' : formatRate(tightest)}
      </Ticker>
      <Ticker label="Mandates funded" ch={FIGURES[2].ch}>
        {String(active.length)}
      </Ticker>
      <Ticker label="Committed" ch={FIGURES[3].ch}>
        {formatMoneyCompact(committed)}
      </Ticker>
      <Ticker label="Uncommitted" ch={FIGURES[4].ch}>
        {formatMoneyCompact(free)}
      </Ticker>
    </Strip>
  );
}

function Strip({ children, busy = false }: { children: React.ReactNode; busy?: boolean }) {
  return (
    <div className="border-t border-rule bg-paper">
      <div
        className="mx-auto flex max-w-[76rem] flex-wrap items-center gap-x-6 gap-y-1 px-6 py-1.5"
        aria-busy={busy || undefined}
      >
        {children}
      </div>
    </div>
  );
}

function Ticker({
  label,
  ch,
  children,
}: {
  label: string;
  /** Reserved width in mono characters. See {@link FIGURES}. */
  ch: number;
  children: React.ReactNode;
}) {
  return (
    <span className="flex items-baseline gap-1.5 text-[0.6875rem]">
      <span className="label-micro">{label}</span>
      <span className="num text-ink" data-num style={{ minWidth: `${ch}ch` }}>
        {children}
      </span>
    </span>
  );
}
