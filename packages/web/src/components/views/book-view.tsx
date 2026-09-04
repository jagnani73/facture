'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useState } from 'react';

import type { Invoice, InvoiceStatus } from '@/lib/domain';
import { isIssued, isQuotable } from '@/lib/domain';
import { formatDateShort, formatDueIn, formatMoney } from '@/lib/format';
import type { InvoicePricing, Market } from '@/lib/data';
import { isDemoBook } from '@/lib/data';
import { useMarket } from '@/lib/data/hooks';
import { curveFrom } from '@/lib/pricing';
import { CurveStrip } from '@/components/curve-strip';
import { PriceCell } from '@/components/price-cell';
import { RatingChip } from '@/components/rating-chip';
import { StatusPill } from '@/components/status-pill';
import { refusalShort } from '@/components/refusal-notice';
import { Failure, Pending } from '@/components/ui/async';
import { Card, Label, PageHeader, buttonClasses } from '@/components/ui/primitives';

/**
 * The book.
 *
 * Every other screen in this product exists to make this one true. An invoice a customer
 * has confirmed carries a price sitting in the row — not a button that fetches one, not a
 * form, not a callback. The number is there, it moves, and it is the number a seller would
 * actually be paid.
 *
 * The price is read from the market, which against the live venue means it was computed
 * against every funded mandate on the book by the same engine that would match it. Nothing
 * on this screen is a display approximation of a figure computed somewhere else.
 *
 * The page waits for the whole book rather than filling rows in as prices arrive. A table
 * where some rows have a price and others are still thinking is a table that reads as if
 * the market is unsure about a particular invoice, which is precisely the impression this
 * product exists to remove.
 */

type Lens = 'all' | 'priced' | 'waiting' | 'closed';

const LENSES: ReadonlyArray<{ id: Lens; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'priced', label: 'Priced now' },
  { id: 'waiting', label: 'Awaiting customer' },
  { id: 'closed', label: 'Closed' },
];

const OPEN: ReadonlyArray<InvoiceStatus> = [
  'draft',
  'awaiting_confirmation',
  'confirmed',
  'listed',
];

const SORT_ORDER: Record<InvoiceStatus, number> = {
  confirmed: 0,
  listed: 0,
  awaiting_confirmation: 1,
  draft: 2,
  sold: 3,
  disputed: 4,
  matured: 5,
  defaulted: 6,
};

interface Row {
  invoice: Invoice;
  pricing: InvoicePricing;
  customer: string;
  settled: number;
  issued: boolean;
  noBidReason: string;
}

export function BookView() {
  const market = useMarket();

  if (market.status === 'loading') {
    return (
      <div className="space-y-8">
        <PageHeader
          title="The book"
          lede="Every invoice you are owed, with what it is worth today beside it."
        />
        <Pending what="your book" lines={6} />
      </div>
    );
  }

  if (market.status === 'failed') {
    return (
      <div className="space-y-8">
        <PageHeader
          title="The book"
          lede="Every invoice you are owed, with what it is worth today beside it."
        />
        <Failure error={market.error} what="your book" onRetry={market.reload}>
          No price is shown while the venue is silent. A number here has to be one a buyer would
          actually pay.
        </Failure>
      </div>
    );
  }

  return <Book market={market.data} onReload={market.reload} />;
}

function Book({ market, onReload }: { market: Market; onReload: () => void }) {
  const [lens, setLens] = useState<Lens>('all');

  const rows: Row[] = market.invoices
    .map((invoice) => {
      const pricing = market.pricingFor(invoice.id);
      const debtor = market.debtorFor(invoice);
      const nearest = pricing.refusals[0];

      return {
        invoice,
        pricing,
        customer: debtor.name,
        settled: debtor.onTimeCount,
        issued: isIssued(invoice),
        noBidReason: nearest
          ? `Nearest bid: ${refusalShort(nearest.code)}`
          : 'No standing bid reaches this invoice',
      };
    })
    .sort((a, b) => {
      const byStatus = SORT_ORDER[a.invoice.status] - SORT_ORDER[b.invoice.status];
      return byStatus !== 0 ? byStatus : a.pricing.tenorDays - b.pricing.tenorDays;
    });

  const visible = rows.filter((row) => {
    switch (lens) {
      case 'priced':
        return row.pricing.quote !== null;
      case 'waiting':
        return row.invoice.status === 'awaiting_confirmation' || row.invoice.status === 'draft';
      case 'closed':
        return !OPEN.includes(row.invoice.status);
      default:
        return true;
    }
  });

  const open = rows.filter((r) => OPEN.includes(r.invoice.status));
  const faceOpen = open.reduce((total, r) => total + r.invoice.faceValue, 0n);
  const worthNow = rows.reduce((total, r) => total + (r.pricing.quote?.proceeds ?? 0n), 0n);
  const pricedCount = rows.filter((r) => r.pricing.quote !== null).length;
  const waitingCount = rows.filter(
    (r) => r.invoice.status === 'awaiting_confirmation' || r.invoice.status === 'draft',
  ).length;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={market.seller.name}
        title="The book"
        lede={`${open.length} invoices outstanding. ${pricedCount} of them have a price right now, and it moves as the bids move and as the due dates come closer.`}
        actions={
          <>
            {/* Nothing to re-read when the book is already in this process. */}
            {isDemoBook() ? null : (
              <button
                type="button"
                onClick={onReload}
                className={buttonClasses('quiet')}
                title="Read the book again"
              >
                Refresh
              </button>
            )}
            <Link href="/book/new" className={buttonClasses('primary')}>
              Add invoices
            </Link>
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <Card className="grid grid-cols-2 gap-px bg-rule sm:grid-cols-4">
          <Figure
            label="Face outstanding"
            value={formatMoney(faceOpen, { fractionDigits: 0 })}
            note={`${open.length} invoices`}
          />
          <Figure
            label="Worth today"
            value={formatMoney(worthNow, { fractionDigits: 0 })}
            note="at the tightest standing bid"
            emphasis
          />
          <Figure label="Priced now" value={String(pricedCount)} note="ready to sell" />
          <Figure
            label="Awaiting customer"
            value={String(waitingCount)}
            note="no price until confirmed"
          />
        </Card>

        <Card className="px-5 py-4">
          <div className="flex items-baseline justify-between">
            <Label>Standing bids</Label>
            <span className="text-[0.6875rem] text-faint">rate by longest tenor held</span>
          </div>
          <CurveStrip
            points={curveFrom(market.mandates, (m) => market.metaOf(m.id).name)}
            className="mt-2"
          />
          {market.notices.map((notice) => (
            <p key={notice} className="mt-2 text-[0.6875rem] text-faint">
              {notice}
            </p>
          ))}
        </Card>
      </div>

      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1 rounded-sm border border-rule bg-raised p-0.5">
            {LENSES.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setLens(option.id)}
                aria-pressed={lens === option.id}
                className={[
                  'rounded-xs px-3 py-1.5 text-xs transition-colors',
                  lens === option.id ? 'bg-sunken text-ink' : 'text-muted hover:text-ink',
                ].join(' ')}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted">
            Showing {visible.length} of {rows.length}
          </p>
        </div>

        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[54rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-rule-strong bg-sunken">
                  <Th>Customer</Th>
                  <Th>Invoice</Th>
                  <Th>Due</Th>
                  <Th align="right">Face</Th>
                  <Th>Status</Th>
                  <Th align="right" className="w-[15rem]">
                    Worth today
                  </Th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr
                    key={row.invoice.id}
                    className="group border-b border-rule last:border-0 hover:bg-sunken"
                  >
                    <Td>
                      <Link
                        href={`/book/${encodeURIComponent(row.invoice.id)}`}
                        className="flex items-center gap-2 group-hover:text-accent"
                      >
                        <RatingChip rating={market.ratingOf(row.invoice)} settled={row.settled} />
                        <span className="truncate">{row.customer}</span>
                      </Link>
                    </Td>
                    <Td className="num text-muted">{row.invoice.invoiceNumber}</Td>
                    <Td>
                      <span className="num">{formatDateShort(row.invoice.dueAt)}</span>
                      <span className="ml-2 text-xs text-faint">
                        {formatDueIn(row.pricing.tenorDays)}
                      </span>
                    </Td>
                    <Td align="right" className="num">
                      {formatMoney(row.invoice.faceValue, { fractionDigits: 0 })}
                    </Td>
                    <Td>
                      <StatusPill status={row.invoice.status} issued={row.issued} />
                    </Td>
                    <Td align="right">
                      <PriceRow row={row} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {visible.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted">Nothing in this view.</p>
          ) : null}
        </Card>

        <p className="mt-3 text-xs text-muted">
          An invoice has no price until your customer confirms the amount and the date. That
          confirmation is what removes dispute risk, and it is why the sale is a full advance with
          nothing held back.
        </p>
      </div>
    </div>
  );
}

function PriceRow({ row }: { row: Row }) {
  const { invoice, pricing, issued, noBidReason } = row;

  if (!issued) return <span className="text-xs text-faint">Being added to the book</span>;

  if (!isQuotable(invoice)) {
    switch (invoice.status) {
      case 'draft':
      case 'awaiting_confirmation':
        return <span className="text-xs text-faint">Priced the moment it is confirmed</span>;
      case 'sold':
        return <span className="text-xs text-muted">Sold — you have been paid</span>;
      case 'matured':
        return <span className="text-xs text-muted">Settled in full</span>;
      case 'disputed':
        return <span className="text-xs text-neg">Disputed — not sellable</span>;
      case 'defaulted':
        return <span className="text-xs text-neg">Unpaid at maturity</span>;
      default:
        return <span className="text-xs text-faint">—</span>;
    }
  }

  return (
    <PriceCell
      seed={invoice.id}
      faceValue={invoice.faceValue}
      tenorDays={pricing.tenorDays}
      bestRateBps={pricing.quote?.annualisedYieldBps ?? null}
      takers={pricing.matchCount}
      noBidReason={noBidReason}
      live={isDemoBook()}
    />
  );
}

function Figure({
  label,
  value,
  note,
  emphasis = false,
}: {
  label: string;
  value: string;
  note: string;
  emphasis?: boolean;
}) {
  return (
    <div className="bg-raised px-5 py-4">
      <Label>{label}</Label>
      <div
        className={`num mt-1.5 text-2xl leading-none ${emphasis ? 'font-medium text-accent' : ''}`}
        data-num
      >
        {value}
      </div>
      <div className="mt-1.5 text-xs text-muted">{note}</div>
    </div>
  );
}

function Th({
  children,
  align = 'left',
  className = '',
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`label-micro px-4 py-2.5 ${align === 'right' ? 'text-right' : 'text-left'} ${className}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = 'left',
  className = '',
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <td className={`px-4 py-3 align-middle ${align === 'right' ? 'text-right' : ''} ${className}`}>
      {children}
    </td>
  );
}
