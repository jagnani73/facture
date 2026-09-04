'use client';

import { bestQuote } from '@/lib/domain';
import { formatDate, formatMoney } from '@/lib/format';
import { debtorFor, debtorNameOf, getInvoice, mandates, marketNow, ratingOf } from '@/lib/fixtures';
import { PriceCell } from '@/components/price-cell';
import { RatingChip } from '@/components/rating-chip';
import { Label } from '@/components/ui/primitives';

/**
 * The landing page's one live figure. It is the same component the book uses, reading the
 * same standing bids through the same `bestQuote` — the claim on this page is checkable on
 * the next one, which is the only reason to put a number on a landing page at all.
 */
export function HeroQuote({ invoiceId = 'INV-2041' }: { invoiceId?: string }) {
  const invoice = getInvoice(invoiceId);
  if (!invoice) return null;

  const result = bestQuote(invoice, mandates, debtorFor(invoice), { asOf: marketNow() });

  return (
    <div className="card ledger-lines px-6 py-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Label>An invoice in the book right now</Label>
          <p className="mt-1.5 flex items-center gap-2 text-sm">
            <RatingChip rating={ratingOf(invoice)} />
            {debtorNameOf(invoice)}
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
          tenorDays={result.tenorDays}
          bestRateBps={result.quote?.annualisedYieldBps ?? null}
          takers={result.matches.length}
          size="hero"
        />
      </div>

      <p className="mt-5 text-xs text-muted">
        Nobody was called and nobody quoted it. The bids were already standing, and the price is
        what reading them at this rating and this many days gives.
      </p>
    </div>
  );
}
