import Link from 'next/link';
import type { ReactNode } from 'react';

import { unallocated } from '@/lib/domain';
import { formatDate, formatMoneyCompact, formatRate, formatTimeUtc } from '@/lib/format';
import { MARKET_NOW_ISO, mandates } from '@/lib/fixtures';
import { SiteNav } from './site-nav';
import { ThemeToggle } from './theme-toggle';

/**
 * The masthead is a newspaper masthead on purpose: a wordmark, a rule, and a strip of the
 * day's figures underneath it. This is a page of short-dated paper prices, and it should
 * look like one.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const active = mandates.filter((m) => m.status === 'active');
  const committed = active.reduce((total, m) => total + m.totalCommitted, 0n);
  const free = active.reduce((total, m) => total + unallocated(m), 0n);
  const tightest = active.reduce(
    (best, m) => Math.min(best, m.annualisedYieldBps),
    Number.POSITIVE_INFINITY,
  );

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-rule bg-raised">
        <div className="mx-auto flex max-w-[76rem] items-center justify-between gap-6 px-6 py-3.5">
          <div className="flex items-baseline gap-4">
            <Link href="/" className="font-serif text-[1.4rem] leading-none tracking-tight">
              Facture
            </Link>
            <span aria-hidden className="hidden h-4 w-px bg-rule-strong sm:block" />
            <span className="label-micro hidden sm:block">Short-dated receivable paper</span>
          </div>

          <div className="flex items-center gap-4">
            <SiteNav />
            <span aria-hidden className="h-4 w-px bg-rule" />
            <ThemeToggle />
          </div>
        </div>

        <div className="border-t border-rule bg-paper">
          <div className="mx-auto flex max-w-[76rem] flex-wrap items-center gap-x-6 gap-y-1 px-6 py-1.5">
            <Ticker
              label="Market"
              value={`${formatDate(MARKET_NOW_ISO)}, ${formatTimeUtc(MARKET_NOW_ISO)}`}
            />
            <Ticker label="Tightest bid" value={formatRate(tightest)} />
            <Ticker label="Mandates funded" value={String(active.length)} />
            <Ticker label="Committed" value={formatMoneyCompact(committed)} />
            <Ticker label="Uncommitted" value={formatMoneyCompact(free)} />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[76rem] flex-1 px-6 py-9">{children}</main>

      <footer className="border-t border-rule bg-raised">
        <div className="mx-auto flex max-w-[76rem] flex-wrap items-center justify-between gap-4 px-6 py-5 text-xs text-muted">
          <p className="max-w-lg">
            Facture is a market, not a lender. Every price on this site is a standing bid from a
            funded mandate, and every sale is non-recourse.
          </p>
          <p className="flex items-center gap-4">
            <Link href="/proof/TRD-4417" className="hover:text-ink">
              How a trade is proven
            </Link>
            <span aria-hidden className="h-3 w-px bg-rule" />
            <span className="num">Demo data · frozen clock</span>
          </p>
        </div>
      </footer>
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
