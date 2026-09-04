'use client';

import { formatDate, formatMoney } from '@/lib/format';
import type { Invoice } from '@/lib/domain';
import type { Market } from '@/lib/data';
import { isDemoBook } from '@/lib/data';
import { useMarket } from '@/lib/data/hooks';
import { curveFrom } from '@/lib/pricing';
import { CurveStrip } from '@/components/curve-strip';
import { PriceCell } from '@/components/price-cell';
import { RatingChip } from '@/components/rating-chip';
import { FailureLine } from '@/components/ui/async';
import { Label } from '@/components/ui/primitives';

/**
 * The landing page's one live figure.
 *
 * It is the same component the book uses, reading the same market through the same price —
 * the claim on this page is checkable on the next one, which is the only reason to put a
 * number on a landing page at all. A page that quotes a figure it cannot stand behind is
 * exactly the thing this product is arguing against, so when the venue is quiet this says
 * so instead of showing a number.
 */
export function HeroQuote({ invoiceId = 'INV-2041' }: { invoiceId?: string }) {
  const market = useMarket();

  if (market.status === 'loading') {
    return (
      <div className="card ledger-lines px-6 py-6" aria-busy="true">
        <Label>An invoice in the book right now</Label>
        <div className="mt-6 h-9 w-2/3 rounded-xs bg-sunken" aria-hidden />
        <p className="mt-5 text-xs text-faint">Reading the book…</p>
      </div>
    );
  }

  if (market.status === 'failed') {
    return (
      <div className="card px-6 py-6">
        <Label className="mb-2">An invoice in the book right now</Label>
        <FailureLine error={market.error} what="a live price" />
        <p className="mt-3 text-xs text-muted">
          There is no number here while the venue is not answering. A price on this page has to be
          one you can go and check on the next one.
        </p>
      </div>
    );
  }

  const invoice = pickHeadline(market.data, invoiceId);
  if (!invoice) {
    return (
      <div className="card px-6 py-6">
        <Label className="mb-2">An invoice in the book right now</Label>
        <p className="text-sm text-muted">
          Nothing on the book carries a price this morning. Every invoice here is either waiting on
          its customer, or nothing standing will take it yet.
        </p>
      </div>
    );
  }

  const pricing = market.data.pricingFor(invoice.id);

  return (
    <div className="card ledger-lines px-6 py-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Label>An invoice in the book right now</Label>
          <p className="mt-1.5 flex items-center gap-2 text-sm">
            <RatingChip rating={market.data.ratingOf(invoice)} />
            {market.data.debtorNameOf(invoice)}
          </p>
        </div>
        <div className="text-right">
          <span className="num block text-lg leading-none" data-num>
            {formatMoney(invoice.faceValue, { fractionDigits: 0 })}
          </span>
          <span className="mt-1 block text-xs text-muted">due {formatDate(invoice.dueAt)}</span>
        </div>
      </div>

      <div className="mt-6 border-t border-rule pt-5">
        <Label className="mb-2">Worth today</Label>
        <PriceCell
          seed={invoice.id}
          faceValue={invoice.faceValue}
          tenorDays={pricing.tenorDays}
          bestRateBps={pricing.quote?.annualisedYieldBps ?? null}
          takers={pricing.matchCount}
          size="hero"
          live={isDemoBook()}
        />
      </div>

      <p className="mt-5 text-xs text-muted">
        Nobody was called and nobody quoted it. The bids were already standing, and the price is
        what reading them at this rating and this many days gives.
      </p>
    </div>
  );
}

/**
 * Whichever invoice actually has a price. Named ids only exist in the demo book, so the
 * fallback is the largest priced invoice — the honest answer to "show me one".
 */
function pickHeadline(market: Market, preferred?: string): Invoice | undefined {
  if (preferred !== undefined) {
    const named = market.getInvoice(preferred);
    if (named && market.pricingFor(named.id).quote !== null) return named;
  }

  return market.invoices
    .filter((invoice) => market.pricingFor(invoice.id).quote !== null)
    .sort((a, b) => (b.faceValue > a.faceValue ? 1 : b.faceValue < a.faceValue ? -1 : 0))[0];
}

/**
 * The curve on the landing page: nothing but the standing bids, plotted. Same data, same
 * three states, so the front page cannot make a claim the market screens would not.
 */
export function LandingCurve() {
  const market = useMarket();

  if (market.status !== 'ready') {
    return (
      <div className="mt-4">
        {market.status === 'failed' ? (
          <FailureLine error={market.error} what="the curve" />
        ) : (
          <div className="h-[156px] rounded-sm bg-sunken" aria-hidden />
        )}
      </div>
    );
  }

  const active = market.data.mandates.filter((m) => m.status === 'active');

  return (
    <>
      <CurveStrip
        points={curveFrom(market.data.mandates, (m) => market.data.metaOf(m.id).name)}
        className="mt-4"
      />
      <p className="mt-2 text-xs text-muted">
        {active.length} funded {active.length === 1 ? 'mandate' : 'mandates'} in this book.
      </p>
    </>
  );
}
