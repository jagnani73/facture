'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { bestQuote, isIssued, isQuotable, priceInvoice, settledCount } from '@/lib/domain';
import { formatDate, formatDays, formatDueIn, formatMoney, formatRate } from '@/lib/format';
import {
  debtorFor,
  debtorNameOf,
  getInvoice,
  mandates,
  marketNow,
  metaOf,
  ratingOf,
  seller,
  tokenForInvoice,
  tradeForInvoice,
} from '@/lib/fixtures';
import { curveFrom } from '@/lib/pricing';
import { CurveStrip } from '@/components/curve-strip';
import { driftBps, useMarketTick } from '@/components/market-tick';
import { PriceCell } from '@/components/price-cell';
import { RatingWithRecord } from '@/components/rating-chip';
import { RefusalNotice } from '@/components/refusal-notice';
import { StatusPill, explainStatus } from '@/components/status-pill';
import { Button, Card, CardHead, Label, Row, buttonClasses } from '@/components/ui/primitives';

/**
 * One invoice, and what selling it would actually mean.
 *
 * The breakdown reads the same rate the headline price does, so the two can never disagree
 * while the curve moves under them. Discount and proceeds are derived by the shared
 * pricer, never stored, and the row that says nothing is held back is there because that
 * is the part of the offer a factoring client will not believe until they see it written
 * down.
 */
export function InvoiceDetailView({ invoiceId }: { invoiceId: string }) {
  const invoice = getInvoice(invoiceId);
  const asOf = useMemo(() => marketNow(), []);
  const quotable = invoice !== undefined && isQuotable(invoice);
  const tick = useMarketTick(quotable);

  const model = useMemo(() => {
    if (!invoice) return null;
    const debtor = debtorFor(invoice);
    return {
      debtor,
      result: bestQuote(invoice, mandates, debtor, { asOf }),
      trade: tradeForInvoice(invoice.id),
      token: tokenForInvoice(invoice.id),
      issued: isIssued(invoice),
    };
  }, [invoice, asOf]);

  if (!invoice || !model) {
    return (
      <Card className="px-6 py-10 text-center">
        <p className="text-sm text-muted">No invoice with that reference is in your book.</p>
        <Link href="/book" className={`${buttonClasses('secondary')} mt-4`}>
          Back to the book
        </Link>
      </Card>
    );
  }

  const { debtor, result, trade, token, issued } = model;
  const days = result.tenorDays;
  const baseRate = result.quote?.annualisedYieldBps ?? null;
  const liveRate = baseRate === null ? null : Math.max(1, baseRate + driftBps(invoice.id, tick));
  const terms = liveRate === null ? null : priceInvoice(invoice.faceValue, liveRate, days);
  const best = result.matches[0];
  const nearest = result.refusals[0];

  return (
    <div className="space-y-8">
      <div>
        <Link href="/book" className="text-xs text-muted hover:text-ink">
          ← The book
        </Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-6 border-b border-rule pb-6">
          <div>
            <Label className="mb-2">Invoice {invoice.invoiceNumber}</Label>
            <h1 className="text-3xl leading-tight">{debtorNameOf(invoice)}</h1>
            <p className="mt-2 flex flex-wrap items-center gap-3 text-sm text-muted">
              <StatusPill status={invoice.status} issued={issued} size="md" />
              <span>{explainStatus(invoice.status, issued)}</span>
            </p>
          </div>
          <div className="text-right">
            <Label>Face value</Label>
            <div className="num mt-1 text-3xl leading-none" data-num>
              {formatMoney(invoice.faceValue, { fractionDigits: 0 })}
            </div>
            <div className="mt-1.5 text-xs text-muted">
              due {formatDate(invoice.dueAt)} · {formatDueIn(days)}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_21rem]">
        <div className="space-y-6">
          {terms && liveRate !== null ? (
            <Card>
              <CardHead
                title="Worth today"
                hint="The price is the tightest standing bid that will take this invoice. It moves as the bids move and as the due date comes closer."
              />
              <div className="px-5 py-5">
                <PriceCell
                  seed={invoice.id}
                  faceValue={invoice.faceValue}
                  tenorDays={days}
                  bestRateBps={liveRate}
                  takers={result.matches.length}
                  size="hero"
                  live={false}
                />

                <div className="mt-6 border-t border-rule pt-1">
                  <Row term="Face value" value={formatMoney(invoice.faceValue)} />
                  <Row term="Tenor" value={`${formatDays(days)} to ${formatDate(invoice.dueAt)}`} />
                  <Row term="Annualised rate" value={formatRate(liveRate)} />
                  <Row term="Discount" value={`− ${formatMoney(terms.discount)}`} />
                  <Row term="Held back" value="Nothing — this is a full advance" />
                  <Row term="Proceeds to you" value={formatMoney(terms.proceeds)} emphasis />
                </div>

                <SellPanel
                  proceedsLabel={formatMoney(terms.proceeds)}
                  mandateName={best ? metaOf(best.mandate.id).name : ''}
                  ownerName={best ? metaOf(best.mandate.id).ownerName : ''}
                />
              </div>
            </Card>
          ) : null}

          {quotable && !terms ? (
            <Card>
              <CardHead
                title="No bid reaches this invoice"
                hint="Every standing bid on the book was checked. None of them will take it, and each one says why."
              />
              <div className="space-y-3 px-5 py-5">
                {result.refusals.map((receipt) => (
                  <RefusalNotice
                    key={`${receipt.invoiceId}-${receipt.mandateId ?? 'invoice'}`}
                    receipt={receipt}
                    mandateName={receipt.mandateId ? metaOf(receipt.mandateId).name : undefined}
                    showTime={false}
                  />
                ))}
                <p className="text-xs text-muted">
                  A refusal is an answer, not a failure. When a funder writes a mandate that reaches
                  this invoice, it will be priced without you doing anything.
                </p>
              </div>
            </Card>
          ) : null}

          {invoice.status === 'awaiting_confirmation' ? (
            <Card>
              <CardHead
                title="Waiting on your customer"
                hint={`We asked ${debtorNameOf(invoice)} to confirm the amount and the date. Until they do, this invoice has no price.`}
              />
              <div className="px-5 py-5">
                <p className="text-sm text-muted">
                  Your customer is not being asked to vouch for anyone. They are being asked to
                  acknowledge their own accounts payable, which is why this works and why it is
                  usually answered the same day.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button variant="primary">Send a reminder</Button>
                  {token ? (
                    <Link href={`/confirm/${token}`} className={buttonClasses('secondary')}>
                      Preview what they see
                    </Link>
                  ) : null}
                </div>
              </div>
            </Card>
          ) : null}

          {!issued ? (
            <Card className="px-5 py-6">
              <p className="text-sm text-muted">
                This invoice is still being added to the book. Adding is paced deliberately, and
                nothing waits on it — it becomes quotable the moment it lands, and you can close
                this page.
              </p>
            </Card>
          ) : null}

          {trade ? (
            <Card>
              <CardHead
                title="Sold"
                hint={`Bought by ${metaOf(trade.mandateId).ownerName} on ${formatDate(trade.settledAt ?? trade.executedAt)}.`}
              />
              <div className="px-5 py-5">
                <Row term="Face value" value={formatMoney(trade.faceValue)} />
                <Row term="Tenor at sale" value={formatDays(trade.tenorDays)} />
                <Row term="Annualised rate" value={formatRate(trade.annualisedYieldBps)} />
                <Row term="Discount" value={`− ${formatMoney(trade.discount)}`} />
                <Row term="Proceeds paid to you" value={formatMoney(trade.proceeds)} emphasis />
                <Link href={`/proof/${trade.id}`} className={`${buttonClasses('secondary')} mt-4`}>
                  See the proof of settlement
                </Link>
              </div>
            </Card>
          ) : null}

          {terms && liveRate !== null ? (
            <Card>
              <CardHead title="Where it sits on the curve" />
              <div className="px-5 py-4">
                <CurveStrip
                  points={curveFrom(mandates, (m) => metaOf(m.id).name)}
                  marker={{
                    tenorDays: days,
                    annualisedYieldBps: liveRate,
                    label: invoice.invoiceNumber,
                  }}
                />
              </div>
            </Card>
          ) : null}

          {result.matches.length > 0 ? (
            <Card>
              <CardHead
                title="Who would take it"
                hint="Ranked by price. The tightest bid is the one you are being offered."
              />
              <div className="px-5 py-3">
                {result.matches.map((match, index) => (
                  <div
                    key={match.mandate.id}
                    className="ledger-row flex items-center justify-between gap-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm">
                        {metaOf(match.mandate.id).name}
                        {index === 0 ? (
                          <span className="label-micro ml-2 inline text-accent">best</span>
                        ) : null}
                      </p>
                      <p className="text-xs text-muted">{metaOf(match.mandate.id).ownerName}</p>
                    </div>
                    <div className="text-right">
                      <span className="num block text-sm" data-num>
                        {formatRate(match.quote.annualisedYieldBps)}
                      </span>
                      <span className="num text-xs text-muted" data-num>
                        {formatMoney(match.quote.proceeds)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {nearest ? (
                <div className="border-t border-rule px-5 py-4">
                  <Label className="mb-2">And the nearest that would not</Label>
                  <RefusalNotice
                    variant="quiet"
                    receipt={nearest}
                    mandateName={nearest.mandateId ? metaOf(nearest.mandateId).name : undefined}
                    showTime={false}
                  />
                </div>
              ) : null}
            </Card>
          ) : null}
        </div>

        <aside className="space-y-6">
          <Card>
            <CardHead title="The invoice" />
            <div className="px-5 py-3">
              <Row term="Customer" value={debtorNameOf(invoice)} />
              <Row term="Your reference" value={invoice.invoiceNumber} />
              <Row term="Issued" value={formatDate(invoice.issuedAt)} />
              <Row term="Due" value={formatDate(invoice.dueAt)} />
              <Row term="Face value" value={formatMoney(invoice.faceValue)} />
              <Row term="Seller" value={seller.name} />
            </div>
          </Card>

          <Card>
            <CardHead
              title="Your customer's record"
              hint="Earned here, out of invoices actually settled. Nothing is imported and nothing is modelled."
            />
            <div className="px-5 py-4">
              <RatingWithRecord
                rating={ratingOf(invoice)}
                settled={settledCount(debtor)}
                late={debtor.defaultCount}
              />
              <div className="mt-4">
                <Row term="Invoices settled on time" value={String(debtor.onTimeCount)} />
                <Row term="Invoices unpaid" value={String(debtor.defaultCount)} />
                <Row term="Invoices confirmed" value={String(debtor.confirmedCount)} />
              </div>
              <p className="mt-3 text-xs text-muted">
                Every invoice this customer pays on time tightens their price, permanently. That
                record belongs to you.
              </p>
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}

/**
 * The sale. Three states and no ceremony: an offer, a confirmation, a receipt. Nothing here
 * mentions how settlement happens, because a seller does not need to know and the proof
 * view is one click away when they want to.
 */
function SellPanel({
  proceedsLabel,
  mandateName,
  ownerName,
}: {
  proceedsLabel: string;
  mandateName: string;
  ownerName: string;
}) {
  const [stage, setStage] = useState<'idle' | 'confirm' | 'done'>('idle');

  if (stage === 'done') {
    return (
      <div className="mt-5 rounded-sm border border-pos/40 bg-pos-wash px-4 py-4">
        <p className="text-sm">
          Sold for <span className="num font-medium">{proceedsLabel}</span> to {mandateName}.
        </p>
        <p className="mt-1 text-xs text-muted">
          In the live market the money is with you before this message finishes rendering, and your
          customer still pays on the due date. Nothing moved here — this book is demo data.
        </p>
        <Link href="/proof/TRD-4417" className={`${buttonClasses('secondary', 'sm')} mt-3`}>
          See what a settled trade proves
        </Link>
      </div>
    );
  }

  if (stage === 'confirm') {
    return (
      <div className="mt-5 rounded-sm border border-rule-strong bg-sunken px-4 py-4">
        <p className="text-sm">
          Sell this invoice for <span className="num font-medium">{proceedsLabel}</span>, to{' '}
          {mandateName} ({ownerName}). Non-recourse: if your customer does not pay, that is the
          buyer&rsquo;s loss, not yours.
        </p>
        <div className="mt-3 flex gap-2">
          <Button variant="primary" onClick={() => setStage('done')}>
            Sell for {proceedsLabel}
          </Button>
          <Button variant="quiet" onClick={() => setStage('idle')}>
            Not now
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-5 flex flex-wrap items-center gap-3">
      <Button variant="primary" size="lg" onClick={() => setStage('confirm')}>
        Sell for {proceedsLabel}
      </Button>
      <span className="text-xs text-muted">
        Settles against the best mandate that will take it.
      </span>
    </div>
  );
}
