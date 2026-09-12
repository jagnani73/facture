import Link from 'next/link';
import type { ReactNode } from 'react';

import { isDemoBook } from '@/lib/data';
import { proofExample, proofExampleLabel } from '@/lib/links';
import { FactureMark } from './facture-mark';
import { MarketTicker } from './market-ticker';
import { SignIn } from './sign-in';
import { SiteNav } from './site-nav';
import { ThemeToggle } from './theme-toggle';

/**
 * The masthead is a newspaper masthead on purpose: a wordmark, a rule, and a strip of the
 * day's figures underneath it. This is a page of short-dated paper prices, and it should
 * look like one.
 *
 * The figures themselves are the market's, so they live in a client component that reads
 * it. The chrome stays a server component and renders immediately either way — a masthead
 * that waits on a network call is a masthead that flickers on every navigation.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const demo = isDemoBook();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-rule bg-raised">
        <div className="mx-auto flex max-w-[76rem] items-center justify-between gap-6 px-6 py-3.5">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="flex items-center gap-2.5 font-serif text-[1.4rem] leading-none tracking-tight"
            >
              <FactureMark className="h-[1.2em] w-auto shrink-0" />
              Facture
            </Link>
            <span aria-hidden className="hidden h-4 w-px bg-rule-strong sm:block" />
            <span className="label-micro hidden sm:block">Short-dated receivable paper</span>
          </div>

          <div className="flex items-center gap-4">
            <SiteNav />
            <span aria-hidden className="h-4 w-px bg-rule" />
            <SignIn />
            <ThemeToggle />
          </div>
        </div>

        <MarketTicker />
      </header>

      <main className="mx-auto w-full max-w-[76rem] flex-1 px-6 py-9">{children}</main>

      <footer className="border-t border-rule bg-raised">
        <div className="mx-auto flex max-w-[76rem] flex-wrap items-center justify-between gap-4 px-6 py-5 text-xs text-muted">
          <p className="max-w-lg">
            Facture is a market, not a lender. Every price on this site is a standing bid from a
            funded mandate, and every sale is non-recourse.
          </p>
          <p className="flex items-center gap-4">
            <Link href={proofExample()} className="hover:text-ink">
              {proofExampleLabel()}
            </Link>
            <span aria-hidden className="h-3 w-px bg-rule" />
            <span className="num">{demo ? 'Demo data · frozen clock' : 'Live book'}</span>
          </p>
        </div>
      </footer>
    </div>
  );
}
