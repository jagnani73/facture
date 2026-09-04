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
 * While the venue is being read, each figure is a rule rather than a zero. A zero here
 * would read as "no mandates are funded", which is a claim about the market rather than a
 * fact about the page.
 */
export function MarketTicker() {
  const market = useMarket();

  if (market.status !== 'ready') {
    const note = market.status === 'failed' ? 'not answering' : 'reading…';
    return (
      <Strip>
        <Ticker label="Market" value={note} />
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
      <Ticker
        label="Market"
        value={`${formatDate(market.data.asOfIso)}, ${formatTimeUtc(market.data.asOfIso)}`}
      />
      <Ticker label="Tightest bid" value={active.length === 0 ? '—' : formatRate(tightest)} />
      <Ticker label="Mandates funded" value={String(active.length)} />
      <Ticker label="Committed" value={formatMoneyCompact(committed)} />
      <Ticker label="Uncommitted" value={formatMoneyCompact(free)} />
    </Strip>
  );
}

function Strip({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-t border-rule bg-paper">
      <div className="mx-auto flex max-w-[76rem] flex-wrap items-center gap-x-6 gap-y-1 px-6 py-1.5">
        {children}
      </div>
    </div>
  );
}

function Ticker({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1.5 text-[0.6875rem]">
      <span className="label-micro">{label}</span>
      <span className="num text-ink" data-num>
        {value}
      </span>
    </span>
  );
}
