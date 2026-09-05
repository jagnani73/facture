'use client';

import Link from 'next/link';
import { useState } from 'react';

import type { Invoice } from '@/lib/domain';
import { isIssued, isQuotable, priceInvoice, settledCount } from '@/lib/domain';
import {
  formatDate,
  formatDateTime,
  formatDays,
  formatDueIn,
  formatMoney,
  formatRate,
} from '@/lib/format';
import type { InvoicePricing, Market, SaleOutcome, TradeRecord } from '@/lib/data';
import { isDemoBook, requestConfirmation, sellInvoice } from '@/lib/data';
import { useMarket } from '@/lib/data/hooks';
import { SETTLEMENT_STATE_SENTENCE, settlementStateOf } from '@/lib/settlement';
import { curveFrom } from '@/lib/pricing';
import { CurveStrip } from '@/components/curve-strip';
import { driftBps, useMarketTick } from '@/components/market-tick';
import { PriceCell } from '@/components/price-cell';
import { RatingChip, RatingWithRecord } from '@/components/rating-chip';
import { RefusalNotice } from '@/components/refusal-notice';
import { StatusPill, explainStatus } from '@/components/status-pill';
import { Failure, Pending } from '@/components/ui/async';
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
  const market = useMarket();

  if (market.status === 'loading') return <Pending what="this invoice" lines={5} />;
  if (market.status === 'failed') {
    return (
      <Failure error={market.error} what="this invoice" onRetry={market.reload}>
        <Link href="/book" className="text-accent underline underline-offset-2">
          Back to the book
        </Link>
      </Failure>
    );
  }

  const invoice = market.data.getInvoice(invoiceId);
  if (!invoice) {
    return (
      <Card className="px-6 py-10 text-center">
        <p className="text-sm text-muted">No invoice with that reference is in your book.</p>
        <Link href="/book" className={`${buttonClasses('secondary')} mt-4`}>
          Back to the book
        </Link>
      </Card>
    );
  }

  return <InvoiceDetail market={market.data} invoice={invoice} />;
}

function InvoiceDetail({ market, invoice }: { market: Market; invoice: Invoice }) {
  const debtor = market.debtorFor(invoice);
  const pricing: InvoicePricing = market.pricingFor(invoice.id);
  const trade = market.tradeForInvoice(invoice.id);
  const token = market.tokenForInvoice(invoice.id);
  const issued = isIssued(invoice);
  const quotable = isQuotable(invoice);

  // The wobble is the demo book's stand-in for a curve that moves. Against a live venue
  // the number on screen is the venue's and nothing here perturbs it.
  const tick = useMarketTick(quotable && isDemoBook());
  const days = pricing.tenorDays;
  const baseRate = pricing.quote?.annualisedYieldBps ?? null;
  const liveRate = baseRate === null ? null : Math.max(1, baseRate + driftBps(invoice.id, tick));
  /*
   * The venue's own discount and proceeds while the rate on screen is the rate it named.
   * The local pricer only takes over once the demo book's wobble has moved the rate off it,
   * which is the only moment there is no venue figure to show.
   */
  const terms =
    liveRate === null
      ? null
      : liveRate === baseRate && pricing.quote !== null
        ? { discount: pricing.quote.discount, proceeds: pricing.quote.proceeds }
        : priceInvoice(invoice.faceValue, liveRate, days);
  const best = pricing.matches[0];
  const nearest = pricing.refusals[0];

  return (
    <div className="space-y-8">
      <div>
        <Link href="/book" className="text-xs text-muted hover:text-ink">
          ← The book
        </Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-6 border-b border-rule pb-6">
          <div>
            <Label className="mb-2">Invoice {invoice.invoiceNumber}</Label>
            <h1 className="text-3xl leading-tight">{market.debtorNameOf(invoice)}</h1>
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
                  quotedProceeds={liveRate === baseRate ? pricing.quote?.proceeds : undefined}
                  takers={pricing.matchCount}
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
                  invoiceId={invoice.id}
                  quoteId={pricing.quoteId}
                  proceedsLabel={formatMoney(terms.proceeds)}
                  mandateName={best ? market.metaOf(best.mandate.id).name : 'the best standing bid'}
                  ownerName={best ? market.metaOf(best.mandate.id).ownerName : ''}
                  takers={pricing.matchCount}
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
                {pricing.refusals.map((receipt) => (
                  <RefusalNotice
                    key={`${receipt.invoiceId}-${receipt.mandateId ?? 'invoice'}`}
                    receipt={receipt}
                    mandateName={
                      receipt.mandateId ? market.metaOf(receipt.mandateId).name : undefined
                    }
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
            <AwaitingCustomer
              invoiceId={invoice.id}
              customer={market.debtorNameOf(invoice)}
              token={token}
            />
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

          {trade ? <TradeCard market={market} trade={trade} /> : null}

          {terms && liveRate !== null ? (
            <Card>
              <CardHead title="Where it sits on the curve" />
              <div className="px-5 py-4">
                <CurveStrip
                  points={curveFrom(market.mandates, (m) => market.metaOf(m.id).name)}
                  marker={{
                    tenorDays: days,
                    annualisedYieldBps: liveRate,
                    label: invoice.invoiceNumber,
                  }}
                />
              </div>
            </Card>
          ) : null}

          {pricing.matches.length > 0 ? (
            <Card>
              <CardHead
                title="Who would take it"
                hint="Ranked by price. The tightest bid is the one you are being offered."
              />
              <div className="px-5 py-3">
                {pricing.matches.map((match, index) => (
                  <div
                    key={match.mandate.id}
                    className="ledger-row flex items-center justify-between gap-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm">
                        {market.metaOf(match.mandate.id).name}
                        {index === 0 ? (
                          <span className="label-micro ml-2 inline text-accent">best</span>
                        ) : null}
                      </p>
                      <p className="text-xs text-muted">
                        {market.metaOf(match.mandate.id).ownerName}
                      </p>
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
                    mandateName={
                      nearest.mandateId ? market.metaOf(nearest.mandateId).name : undefined
                    }
                    showTime={false}
                  />
                </div>
              ) : null}
            </Card>
          ) : pricing.matchCount > 0 ? (
            <Card>
              <CardHead
                title="Who would take it"
                hint="A seller does not choose a counterparty, so the venue answers how many mandates would take this invoice rather than naming them."
              />
              <div className="px-5 py-5">
                <p className="text-sm">
                  <span className="num text-2xl font-medium" data-num>
                    {pricing.matchCount}
                  </span>
                  <span className="ml-2 text-muted">
                    of {pricing.candidatesConsidered} mandates screened would take this invoice. It
                    settles against the tightest of them.
                  </span>
                </p>
                {nearest ? (
                  <div className="mt-4">
                    <Label className="mb-2">And the nearest that would not</Label>
                    <RefusalNotice
                      variant="quiet"
                      receipt={nearest}
                      mandateName={
                        nearest.mandateId ? market.metaOf(nearest.mandateId).name : undefined
                      }
                      showTime={false}
                    />
                  </div>
                ) : null}
              </div>
            </Card>
          ) : null}
        </div>

        <aside className="space-y-6">
          <Card>
            <CardHead title="The invoice" />
            <div className="px-5 py-3">
              <Row term="Customer" value={market.debtorNameOf(invoice)} />
              <Row term="Your reference" value={invoice.invoiceNumber} />
              <Row term="Issued" value={formatDate(invoice.issuedAt)} />
              <Row term="Due" value={formatDate(invoice.dueAt)} />
              <Row term="Face value" value={formatMoney(invoice.faceValue)} />
              <Row term="Seller" value={market.seller.name} />
            </div>
          </Card>

          <Card>
            <CardHead
              title="Your customer's record"
              hint="Earned here, out of invoices actually settled. Nothing is imported and nothing is modelled."
            />
            <div className="px-5 py-4">
              {market.debtorHistoryKnown ? (
                <>
                  <RatingWithRecord
                    rating={market.ratingOf(invoice)}
                    settled={settledCount(debtor)}
                    late={debtor.defaultCount}
                  />
                  <div className="mt-4">
                    <Row term="Invoices settled on time" value={String(debtor.onTimeCount)} />
                    <Row term="Invoices unpaid" value={String(debtor.defaultCount)} />
                    <Row term="Invoices confirmed" value={String(debtor.confirmedCount)} />
                  </div>
                </>
              ) : (
                <>
                  <RatingChip rating={market.ratingOf(invoice)} size="md" />
                  {/* "0 settled" beside an A would be a claim about this customer, not a gap
                      in what the venue publishes. So the count is left out entirely. */}
                  <p className="mt-3 text-xs text-muted">
                    The grade is what this market publishes. The invoices behind it are counted
                    here, not shown.
                  </p>
                </>
              )}
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

/* -------------------------------------------------------------------------- */

/**
 * The trade behind an invoice, headed by what actually happened to it.
 *
 * "Sold" is a claim about both legs, and an invoice can carry a trade that is none of the
 * things a sale is: still awaiting a signature, unwound, failed, or half-settled. Heading
 * every one of them "Sold" would tell a seller they had been paid when they had not — and
 * in the half-settled case, tell them nothing had happened when the money had actually
 * moved.
 */
function TradeCard({ market, trade }: { market: Market; trade: TradeRecord }) {
  const state = settlementStateOf(trade);
  const owner = market.metaOf(trade.mandateId).ownerName;
  const half = state === 'half_settled';

  const title =
    state === 'settled'
      ? 'Sold'
      : state === 'half_settled'
        ? 'Half-settled — being reconciled'
        : state === 'awaiting_payment'
          ? 'Held, awaiting the cash leg'
          : state === 'unwound'
            ? 'Unwound — nothing moved'
            : state === 'failed'
              ? 'Did not go through'
              : 'Being arranged';

  return (
    <Card className={half ? 'border-neg/45' : ''}>
      <CardHead
        title={title}
        hint={
          state === 'settled'
            ? `Bought by ${owner} on ${formatDate(trade.settledAt ?? trade.executedAt)}.`
            : SETTLEMENT_STATE_SENTENCE[state]
        }
      />
      <div className="px-5 py-5">
        <Row term="Face value" value={formatMoney(trade.faceValue)} />
        <Row term="Tenor at sale" value={formatDays(trade.tenorDays)} />
        <Row term="Annualised rate" value={formatRate(trade.annualisedYieldBps)} />
        <Row term="Discount" value={`− ${formatMoney(trade.discount)}`} />
        <Row
          term={state === 'settled' ? 'Proceeds paid to you' : 'Proceeds if it settles'}
          value={formatMoney(trade.proceeds)}
          emphasis={state === 'settled'}
        />
        {half ? (
          <p className="mt-3 text-sm text-ink">
            The payment settled and the security did not transfer. Quote{' '}
            <span className="num">{trade.id}</span> — the hold is deliberately not released while
            this is reconciled.
          </p>
        ) : null}
        <Link
          href={`/proof/${encodeURIComponent(trade.id)}`}
          className={`${buttonClasses('secondary')} mt-4`}
        >
          {state === 'settled' ? 'See the proof of settlement' : 'See both legs'}
        </Link>
      </div>
    </Card>
  );
}

function AwaitingCustomer({
  invoiceId,
  customer,
  token,
}: {
  invoiceId: string;
  customer: string;
  token: string | undefined;
}) {
  const [state, setState] = useState<{ busy: boolean; message: string | null; failed: boolean }>({
    busy: false,
    message: null,
    failed: false,
  });

  return (
    <Card>
      <CardHead
        title="Waiting on your customer"
        hint={`We asked ${customer} to confirm the amount and the date. Until they do, this invoice has no price.`}
      />
      <div className="px-5 py-5">
        <p className="text-sm text-muted">
          Your customer is not being asked to vouch for anyone. They are being asked to acknowledge
          their own accounts payable, which is why this works and why it is usually answered the
          same day.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={state.busy}
            onClick={async () => {
              setState({ busy: true, message: null, failed: false });
              const result = await requestConfirmation(invoiceId);
              setState({
                busy: false,
                message: result.ok ? result.note : result.reason,
                failed: !result.ok,
              });
            }}
          >
            {state.busy ? 'Sending…' : 'Send a reminder'}
          </Button>
          {token ? (
            <Link href={`/confirm/${token}`} className={buttonClasses('secondary')}>
              Preview what they see
            </Link>
          ) : null}
        </div>
        {state.message ? (
          <p className={`mt-3 text-xs ${state.failed ? 'text-warn' : 'text-muted'}`}>
            {state.message}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * The sale. An offer, a confirmation, a receipt — and three endings that are not a receipt
 * and must not look like one.
 *
 * The venue's trade path has five outcomes and only one of them is a sale. A 402 means the
 * paper is **held** and the cash leg is unsigned, so nothing has moved; a 403 means the
 * buyer was refused by the security's own control list *before* anything was matched; and a
 * 500 carrying "half-settled" means the payment went through and the security did not. The
 * first is not a sale, the second is not a failure, and the third is not "nothing happened".
 * Each gets its own panel, in words, and none of them says a transaction reverted.
 */
function SellPanel({
  invoiceId,
  quoteId,
  proceedsLabel,
  mandateName,
  ownerName,
  takers,
}: {
  invoiceId: string;
  quoteId: string | null;
  proceedsLabel: string;
  mandateName: string;
  ownerName: string;
  takers: number;
}) {
  const [stage, setStage] = useState<'idle' | 'confirm' | 'working'>('idle');
  const [outcome, setOutcome] = useState<SaleOutcome | null>(null);

  if (outcome !== null && outcome.ok === false && outcome.state === 'refused') {
    return (
      <SaleRefused
        outcome={outcome}
        onBack={() => {
          setOutcome(null);
          setStage('idle');
        }}
      />
    );
  }

  if (outcome !== null && outcome.ok === false && outcome.state === 'half_settled') {
    return <SaleHalfSettled outcome={outcome} />;
  }

  if (outcome !== null && outcome.ok === false) {
    return (
      <div className="mt-5 rounded-sm border border-warn/40 bg-warn-wash px-4 py-4">
        <Label className="mb-1">Not sold</Label>
        <p className="text-sm text-ink">{outcome.reason}</p>
        <p className="mt-2 text-xs text-muted">Nothing moved. The invoice is still yours.</p>
        <Button
          variant="quiet"
          size="sm"
          className="mt-3"
          onClick={() => {
            setOutcome(null);
            setStage('idle');
          }}
        >
          Back
        </Button>
      </div>
    );
  }

  if (outcome !== null && outcome.ok && outcome.state === 'awaiting_payment') {
    return <SaleAwaitingPayment outcome={outcome} proceedsLabel={proceedsLabel} />;
  }

  if (outcome !== null && outcome.ok) {
    return (
      <div className="mt-5 rounded-sm border border-pos/40 bg-pos-wash px-4 py-4">
        <p className="text-sm">
          Sold for <span className="num font-medium">{proceedsLabel}</span> to {mandateName}.
        </p>
        <p className="mt-1 text-xs text-muted">{outcome.note}</p>
        <Link
          href={`/book/${encodeURIComponent(invoiceId)}`}
          className={`${buttonClasses('secondary', 'sm')} mt-3`}
        >
          See this invoice again
        </Link>
      </div>
    );
  }

  if (stage === 'confirm' || stage === 'working') {
    return (
      <div className="mt-5 rounded-sm border border-rule-strong bg-sunken px-4 py-4">
        <p className="text-sm">
          Sell this invoice for <span className="num font-medium">{proceedsLabel}</span>, to{' '}
          {mandateName}
          {ownerName ? ` (${ownerName})` : ''}. Non-recourse: if your customer does not pay, that is
          the buyer&rsquo;s loss, not yours.
        </p>
        <div className="mt-3 flex gap-2">
          <Button
            variant="primary"
            disabled={stage === 'working'}
            onClick={async () => {
              setStage('working');
              setOutcome(await sellInvoice(invoiceId, quoteId));
            }}
          >
            {stage === 'working' ? 'Selling…' : `Sell for ${proceedsLabel}`}
          </Button>
          <Button variant="quiet" disabled={stage === 'working'} onClick={() => setStage('idle')}>
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
        Settles against the best mandate that will take it
        {takers > 0 ? `, of the ${takers} that would` : ''}.
      </span>
    </div>
  );
}

/**
 * The refusal.
 *
 * This is the product's distinguishing claim on a screen, so it is not styled as a failure
 * and it does not use the word. Eligibility was read from the security's own control list
 * and KYC facets *before* anything was matched, which is why the sentence exists at all —
 * an automated market maker has no point of trade at which to ask, so the same fact reaches
 * a seller there as a reverted transaction with no reason attached.
 *
 * The venue's `detail` can carry a whole contract-call trace inline, because the probe fails
 * closed and reports what it could not read. That is true and it is not the answer, so it
 * sits behind a disclosure and the sentence stands on its own.
 */
function SaleRefused({
  outcome,
  onBack,
}: {
  outcome: Extract<SaleOutcome, { state: 'refused' }>;
  onBack: () => void;
}) {
  return (
    <div className="mt-5 rounded-sm border border-rule-strong bg-sunken px-4 py-4">
      <Label className="mb-1">Refused before matching</Label>
      <p className="text-sm text-ink">{outcome.reason}</p>

      {outcome.checks.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {outcome.checks.map((check) => (
            <li key={check.name} className="flex gap-2.5">
              <span
                aria-hidden
                className={`mt-0.5 select-none text-xs ${check.passed ? 'text-pos' : 'text-neg'}`}
              >
                {check.passed ? '✓' : '✕'}
              </span>
              <span className="min-w-0">
                <span className="block text-xs">{check.name}</span>
                <span className="block text-xs text-muted">{check.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="mt-3 text-xs text-muted">
        Nothing was reserved, nothing was held and nothing moved. Eligibility is read before the
        match rather than at settlement, which is why this is a sentence with a reason attached
        rather than a transaction that came back rejected.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="quiet" size="sm" onClick={onBack}>
          Back
        </Button>
        {outcome.code ? (
          <span className="num text-[0.6875rem] text-faint">{outcome.code}</span>
        ) : null}
      </div>

      {outcome.technical ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-[0.6875rem] text-faint hover:text-muted">
            What the venue could not read
          </summary>
          <pre className="num mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xs bg-raised p-3 text-[0.6875rem] leading-relaxed text-faint">
            {outcome.technical}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

/**
 * The 402. The paper is held and the cash leg is unsigned.
 *
 * Deliberately not the green "Sold" panel: this is the middle of a delivery-versus-payment
 * and the money has not moved. It is also not a failure — if the buyer never signs, the hold
 * expires on its own and the seller's position was never encumbered for longer than the
 * challenge window.
 *
 * The challenge itself is shown because a seller watching a sale stall is owed the terms the
 * other side was handed, and because this is the one place the two chains are visible from a
 * market screen: the amount is in the settlement asset's own smallest unit on
 * `hedera:testnet`, not in the invoice's currency.
 */
function SaleAwaitingPayment({
  outcome,
  proceedsLabel,
}: {
  outcome: Extract<SaleOutcome, { state: 'awaiting_payment' }>;
  proceedsLabel: string;
}) {
  const terms = outcome.challenge.payment.accepts[0];
  const held = outcome.challenge.assetLeg?.state === 'held';

  return (
    <div className="mt-5 rounded-sm border border-accent/40 bg-sunken px-4 py-4">
      <Label className="mb-1">
        {held ? 'Paper held · awaiting the cash leg' : 'Awaiting the cash leg'}
      </Label>
      <p className="text-sm text-ink">
        The buyer has been asked to sign <span className="num font-medium">{proceedsLabel}</span>{' '}
        against this invoice. Neither leg settles unless both do.
      </p>
      <p className="mt-2 text-xs text-muted">{outcome.note}</p>

      {terms ? (
        <div className="mt-3 border-t border-rule pt-1">
          <Row term="Scheme" value={terms.scheme} />
          <Row term="Network" value={terms.network} />
          <Row term="Asset" value={terms.asset} />
          <Row term="Amount" value={terms.amount} />
          <Row term="Paid to" value={terms.payTo} />
          {outcome.challenge.expiresAt ? (
            <Row term="Hold expires" value={formatDateTime(outcome.challenge.expiresAt)} />
          ) : null}
        </div>
      ) : null}

      <p className="mt-3 text-xs text-faint">
        The amount above is the settlement asset&rsquo;s own smallest unit, not this invoice&rsquo;s
        currency. If the signature never arrives, the hold expires and your position was never
        encumbered.
      </p>
    </div>
  );
}

/**
 * The half-settled trade.
 *
 * The cash leg settled and the security did not transfer, which means **the money moved**.
 * The venue answers 500 here and deliberately does not unwind, because releasing a hold
 * against a payment that actually happened turns a reconcilable state into a lost one — so
 * this cannot render as "nothing happened", and there is no Back button pretending the sale
 * can simply be retried.
 */
function SaleHalfSettled({
  outcome,
}: {
  outcome: Extract<SaleOutcome, { state: 'half_settled' }>;
}) {
  return (
    <div className="mt-5 rounded-sm border-2 border-neg/50 bg-neg-wash px-4 py-4" role="alert">
      <Label className="mb-1">The payment went through — the paper did not</Label>
      <p className="text-sm text-ink">{outcome.reason}</p>
      <p className="mt-2 text-sm text-ink">
        This is not a failed sale and it is not something to retry. One leg of the settlement
        completed and the other did not, so it is being reconciled by hand rather than unwound —
        releasing the hold against a payment that actually happened would turn a recoverable state
        into a lost one.
      </p>

      {outcome.tradeId ? (
        <div className="mt-3 border-t border-neg/30 pt-3">
          <Label className="mb-1">Quote this reference</Label>
          <p className="num text-sm" data-num>
            {outcome.tradeId}
          </p>
          <Link
            href={`/proof/${encodeURIComponent(outcome.tradeId)}`}
            className={`${buttonClasses('secondary', 'sm')} mt-3`}
          >
            See both legs
          </Link>
        </div>
      ) : null}
    </div>
  );
}
