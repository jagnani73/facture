'use client';

import Link from 'next/link';

import type { RefusalReceipt } from '@/lib/domain';
import { unallocated } from '@/lib/domain';
import { formatMoney, formatMoneyCompact, formatRate } from '@/lib/format';
import type { Market } from '@/lib/data';
import { useMarket } from '@/lib/data/hooks';
import { maturityLadder, sumFace, sumOutlay, weightedAverageRateBps } from '@/lib/pricing';
import { MandateCard, OperatorBadge, describeMandate } from '@/components/mandate-card';
import { MaturityLadder } from '@/components/maturity-ladder';
import { RatingChip } from '@/components/rating-chip';
import { RefusalNotice } from '@/components/refusal-notice';
import { Failure, Pending } from '@/components/ui/async';
import { Card, CardHead, Label, PageHeader, buttonClasses } from '@/components/ui/primitives';

/**
 * The buyer's side.
 *
 * A funder never scrolls through invoices deciding one at a time, so there is no list of
 * invoices anywhere on this page. There is a policy, how much of it is working, what it
 * earned, and when the money comes back.
 *
 * The refusals below are not authored. They are the refusals the market actually produced
 * against these mandates this morning, taken from the same pricing pass that put a number
 * beside every row of the book — which is the only way the screen can be trusted to say
 * the same thing the venue would.
 */
export function MandatesView() {
  const market = useMarket();

  if (market.status === 'loading') {
    return (
      <div className="space-y-8">
        <PageHeader
          title="Mandates"
          lede="Standing bids, exposure used, and when the money comes back."
        />
        <Pending what="your mandates" lines={5} />
      </div>
    );
  }

  if (market.status === 'failed') {
    return (
      <div className="space-y-8">
        <PageHeader
          title="Mandates"
          lede="Standing bids, exposure used, and when the money comes back."
        />
        <Failure error={market.error} what="your mandates" onRetry={market.reload} />
      </div>
    );
  }

  return <Mandates market={market.data} />;
}

function Mandates({ market }: { market: Market }) {
  const owned = market.ownedMandates();
  const others = market.otherMandates();
  const mine = market.ownedPositions().filter((p) => p.state === 'open');

  const ownedIds = new Set(owned.map((m) => m.id));
  const collected: RefusalReceipt[] = [];
  for (const invoice of market.invoices) {
    for (const receipt of market.pricingFor(invoice.id).refusals) {
      if (receipt.mandateId !== null && ownedIds.has(receipt.mandateId)) collected.push(receipt);
    }
  }

  // Concentration and exhaustion first: those are the ones a funder can do something about
  // by moving a cap, rather than facts about the paper.
  const priority: Record<string, number> = {
    DEBTOR_CONCENTRATION: 0,
    EXPOSURE_EXHAUSTED: 1,
    TENOR_EXCEEDS_MANDATE: 2,
  };
  const refusals = collected
    .sort((a, b) => (priority[a.code] ?? 3) - (priority[b.code] ?? 3))
    .slice(0, 4);

  const committed = owned.reduce((total, m) => total + m.totalCommitted, 0n);
  const deployed = owned.reduce((total, m) => total + m.allocated, 0n);
  const ladder = maturityLadder(mine, market.asOf);
  const sample = owned[0] ?? others[0];
  const carry = sumFace(mine) - sumOutlay(mine);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={market.viewer.name}
        title="Mandates"
        lede="You do not browse invoices. You write the policy you would have applied anyway, fund it, and let anything that fits come to you."
        actions={
          <Link href="/mandates/new" className={buttonClasses('primary')}>
            Write a mandate
          </Link>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_24rem]">
        <Card className="grid grid-cols-2 gap-px bg-rule sm:grid-cols-4">
          <Figure
            label="Committed"
            value={formatMoney(committed, { fractionDigits: 0 })}
            note={`${owned.length} ${owned.length === 1 ? 'mandate' : 'mandates'}`}
          />
          <Figure
            label="Deployed"
            value={formatMoney(deployed, { fractionDigits: 0 })}
            note={`${mine.length} invoices held`}
          />
          <Figure
            label="Weighted yield"
            value={formatRate(weightedAverageRateBps(mine))}
            note="on capital actually out"
            emphasis
          />
          <Figure label="Carry to come" value={formatMoney(carry)} note="face less what you paid" />
        </Card>

        <Card>
          <CardHead title="Maturity ladder" hint="When the money comes back." />
          <div className="px-5 py-4">
            <MaturityLadder buckets={ladder} />
          </div>
        </Card>
      </div>

      {owned.length === 0 ? (
        <Card className="px-5 py-8 text-center">
          <p className="text-sm text-muted">
            You have no mandates yet. Until one is written and funded, nothing on the book can be
            matched to you.
          </p>
          <Link href="/mandates/new" className={`${buttonClasses('primary')} mt-4`}>
            Write a mandate
          </Link>
        </Card>
      ) : (
        <div className="grid gap-5 xl:grid-cols-2">
          {owned.map((mandate) => (
            <MandateCard
              key={mandate.id}
              mandate={mandate}
              meta={market.metaOf(mandate.id)}
              positions={market.positionsOf(mandate.id)}
            />
          ))}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
        <Card>
          <CardHead
            title="Not taken this morning"
            hint="Invoices on the book right now that your mandates will not take, and why. Never a failed transaction — the check runs before anything is matched."
          />
          <div className="space-y-3 px-5 py-5">
            {refusals.map((receipt) => {
              const invoice = market.getInvoice(receipt.invoiceId);
              const trade = market.tradeForInvoice(receipt.invoiceId);
              return (
                <RefusalNotice
                  key={`${receipt.invoiceId}-${receipt.mandateId ?? 'invoice'}`}
                  receipt={receipt}
                  mandateName={
                    receipt.mandateId ? market.metaOf(receipt.mandateId).name : undefined
                  }
                  invoiceLabel={invoice?.invoiceNumber ?? receipt.invoiceId}
                  {...(trade ? { receiptHref: `/proof/${encodeURIComponent(trade.id)}` } : {})}
                />
              );
            })}
            {refusals.length === 0 ? (
              <p className="text-sm text-muted">Nothing on the book has been refused.</p>
            ) : null}
          </div>
        </Card>

        <Card>
          <CardHead
            title="Also bidding"
            hint="Bids are public in this market. What anyone has deployed behind them is not."
          />
          <div className="px-5 py-3">
            {others.map((mandate) => {
              const meta = market.metaOf(mandate.id);
              return (
                <div key={mandate.id} className="ledger-row py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm">{meta.name}</p>
                      <p className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                        <span className="truncate">{meta.ownerName}</span>
                        {/*
                          No escrow badge here, deliberately. This card's own hint says bids
                          are public and what stands behind them is not, and whether a rival
                          has posted capital is exactly that. The venue does not send it
                          either — `/v1/mandates` is scoped to one buyer — so this is the
                          principle and the plumbing agreeing rather than only the plumbing.
                        */}
                        <OperatorBadge operator={meta.operator} />
                      </p>
                    </div>
                    <span className="num shrink-0 text-sm" data-num>
                      {formatRate(mandate.annualisedYieldBps)}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    <RatingChip rating={mandate.minRating} />
                    <span className="num">{mandate.maxTenorDays}d max</span>
                    <span className="num">
                      {formatMoneyCompact(mandate.totalCommitted)} committed
                    </span>
                  </div>
                </div>
              );
            })}
            {others.length === 0
              ? market.notices.map((notice) => (
                  <p key={notice} className="py-3 text-sm text-muted">
                    {notice}
                  </p>
                ))
              : null}
            {others.length === 0 && market.notices.length === 0 ? (
              <p className="py-3 text-sm text-muted">Nobody else is bidding into this book yet.</p>
            ) : null}
          </div>
        </Card>
      </div>

      <Card className="px-5 py-4">
        <Label className="mb-2">What a mandate commits you to</Label>
        <p className="max-w-3xl text-sm text-muted">
          {sample ? `${describeMandate(sample)} ` : ''}Capital is escrowed when the mandate is
          funded, which is what makes the quote firm rather than merely indicative, and matching is
          bounded by the unallocated balance — so two invoices arriving at once can never overcommit
          it.{' '}
          {sample ? (
            <>
              This one has <span className="num text-ink">{formatMoney(unallocated(sample))}</span>{' '}
              still uncommitted.
            </>
          ) : null}
        </p>
      </Card>
    </div>
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
