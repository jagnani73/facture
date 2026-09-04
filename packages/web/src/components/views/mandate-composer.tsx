'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import type { Mandate, Rating } from '@/lib/domain';
import { RATINGS, bestQuote, priceInvoice } from '@/lib/domain';
import { formatDays, formatMoney, formatRate, toMinor } from '@/lib/format';
import { debtorFor, debtorNameOf, invoices, marketNow, ratingOf, viewer } from '@/lib/fixtures';
import { describeMandate } from '@/components/mandate-card';
import { RatingChip } from '@/components/rating-chip';
import { refusalShort } from '@/components/refusal-notice';
import {
  Button,
  Card,
  CardHead,
  Field,
  Label,
  PageHeader,
  Row,
  Select,
  TextInput,
  buttonClasses,
} from '@/components/ui/primitives';

/** A floor, said the way a funder would say it. */
const RATING_FLOOR_LABEL: Record<Rating, string> = {
  A: 'A only — the longest settled records',
  B: 'B or better',
  C: 'C or better — excludes unrated and defaulted',
  UNRATED: 'Anything without a default on record',
  D: 'Anything at all, defaults included',
};

/**
 * Writing a mandate.
 *
 * The point of this screen is that the consequence of every field is visible while it is
 * being typed: the sentence the policy becomes, what it would pay for a sample invoice,
 * and exactly which of the invoices already on the book it would take this morning — run
 * through the same `bestQuote` that would match it for real. A funder should never have to
 * fund something to find out what it does.
 */
export function MandateComposer() {
  const asOf = useMemo(() => marketNow(), []);

  const [name, setName] = useState('Investment grade, 90 days');
  const [minRating, setMinRating] = useState<Rating>('A');
  const [maxTenor, setMaxTenor] = useState(90);
  const [ratePct, setRatePct] = useState('8.50');
  const [commitment, setCommitment] = useState('200000');
  const [perDebtor, setPerDebtor] = useState('50000');
  const [sampleFace, setSampleFace] = useState('40000');
  const [sampleTenor, setSampleTenor] = useState(60);
  const [funded, setFunded] = useState(false);

  const annualisedYieldBps = Math.max(0, Math.round((Number.parseFloat(ratePct) || 0) * 100));
  const totalCommitted = toMinor(Math.max(0, Number.parseFloat(commitment) || 0));
  const maxPerDebtor = toMinor(Math.max(0, Number.parseFloat(perDebtor) || 0));
  const sampleFaceValue = toMinor(Math.max(0, Number.parseFloat(sampleFace) || 0));

  const draft: Mandate = useMemo(
    () => ({
      id: 'MND-DRAFT',
      buyerId: viewer.buyerId,
      minRating,
      maxTenorDays: maxTenor,
      annualisedYieldBps,
      totalCommitted,
      allocated: 0n,
      maxPerDebtor,
      status: 'active',
      currency: 'USD',
      debtorExposure: {},
    }),
    [minRating, maxTenor, annualisedYieldBps, totalCommitted, maxPerDebtor],
  );

  const sample =
    annualisedYieldBps > 0 && sampleFaceValue > 0n
      ? priceInvoice(sampleFaceValue, annualisedYieldBps, sampleTenor)
      : null;
  const sampleAccepted = sampleTenor <= maxTenor;

  const assessed = useMemo(
    () =>
      invoices
        .map((invoice) => ({
          invoice,
          result: bestQuote(invoice, [draft], debtorFor(invoice), { asOf }),
        }))
        .filter(({ result }) => result.refusals[0]?.code !== 'INVOICE_NOT_CONFIRMED')
        .sort((a, b) => {
          const takenA = a.result.quote !== null ? 0 : 1;
          const takenB = b.result.quote !== null ? 0 : 1;
          return takenA !== takenB ? takenA - takenB : a.result.tenorDays - b.result.tenorDays;
        }),
    [draft, asOf],
  );

  const takes = assessed.filter((a) => a.result.quote !== null);
  const wouldDeploy = takes.reduce((total, a) => total + (a.result.quote?.proceeds ?? 0n), 0n);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Mandates"
        title="Write a mandate"
        lede="A standing bid over a bucket of risk. Anything that fits is matched to it without you looking at it, up to the capital you have put behind it."
        actions={
          <Link href="/mandates" className={buttonClasses('secondary')}>
            Back to mandates
          </Link>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_26rem]">
        <Card>
          <CardHead
            title="The policy"
            hint="Five decisions. Nothing else is negotiable afterwards."
          />
          <div className="space-y-5 px-5 py-5">
            <Field label="Name it" htmlFor="name" hint="For your own book. Nobody else sees this.">
              <TextInput id="name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                label="Minimum customer rating"
                htmlFor="rating"
                hint="Earned here, out of invoices actually settled. A defaulted customer sits below unrated, so no floor short of D reaches them."
              >
                <Select
                  id="rating"
                  value={minRating}
                  onChange={(e) => setMinRating(e.target.value as Rating)}
                >
                  {RATINGS.map((rating) => (
                    <option key={rating} value={rating}>
                      {RATING_FLOOR_LABEL[rating]}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Maximum tenor" htmlFor="tenor" hint={`${maxTenor} days`}>
                <input
                  id="tenor"
                  type="range"
                  min={15}
                  max={180}
                  step={15}
                  value={maxTenor}
                  onChange={(e) => setMaxTenor(Number(e.target.value))}
                  className="mt-2 w-full accent-[var(--accent)]"
                />
              </Field>
            </div>

            <div className="grid gap-5 sm:grid-cols-3">
              <Field label="Annualised yield" htmlFor="rate">
                <div className="relative">
                  <TextInput
                    id="rate"
                    value={ratePct}
                    inputMode="decimal"
                    onChange={(e) => setRatePct(e.target.value)}
                    className="num pr-7"
                  />
                  <span className="absolute top-1/2 right-3 -translate-y-1/2 text-sm text-faint">
                    %
                  </span>
                </div>
              </Field>

              <Field label="Total commitment" htmlFor="commitment">
                <TextInput
                  id="commitment"
                  value={commitment}
                  inputMode="decimal"
                  onChange={(e) => setCommitment(e.target.value)}
                  className="num"
                />
              </Field>

              <Field label="Cap per customer" htmlFor="cap">
                <TextInput
                  id="cap"
                  value={perDebtor}
                  inputMode="decimal"
                  onChange={(e) => setPerDebtor(e.target.value)}
                  className="num"
                />
              </Field>
            </div>

            <div className="rounded-sm border border-rule bg-sunken px-4 py-3.5">
              <Label className="mb-1.5">In a sentence</Label>
              <p className="text-sm">{describeMandate(draft)}</p>
            </div>

            {funded ? (
              <div className="rounded-sm border border-pos/40 bg-pos-wash px-4 py-4">
                <p className="text-sm">
                  {name} funded for{' '}
                  <span className="num font-medium">
                    {formatMoney(totalCommitted, { fractionDigits: 0 })}
                  </span>
                  .
                </p>
                <p className="mt-1 text-xs text-muted">
                  The capital is escrowed, which is what makes your bid firm rather than indicative.
                  Matching is bounded by the unallocated balance, so it can never be overcommitted.
                  Nothing moved here — this is demo data.
                </p>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="primary"
                  size="lg"
                  disabled={annualisedYieldBps <= 0 || totalCommitted <= 0n}
                  onClick={() => setFunded(true)}
                >
                  Fund {formatMoney(totalCommitted, { fractionDigits: 0 })}
                </Button>
                <span className="text-xs text-muted">
                  Funding is what makes the quote firm. Until it is funded it is not a bid.
                </span>
              </div>
            )}
          </div>
        </Card>

        <aside className="space-y-6">
          <Card>
            <CardHead
              title="What it pays"
              hint="A sample invoice, priced by this policy as you type."
            />
            <div className="px-5 py-4">
              <div className="grid grid-cols-2 gap-4">
                <Field label="Sample face" htmlFor="sample-face">
                  <TextInput
                    id="sample-face"
                    value={sampleFace}
                    inputMode="decimal"
                    onChange={(e) => setSampleFace(e.target.value)}
                    className="num"
                  />
                </Field>
                <Field label="Sample tenor" htmlFor="sample-tenor" hint={formatDays(sampleTenor)}>
                  <input
                    id="sample-tenor"
                    type="range"
                    min={7}
                    max={180}
                    step={1}
                    value={sampleTenor}
                    onChange={(e) => setSampleTenor(Number(e.target.value))}
                    className="mt-2 w-full accent-[var(--accent)]"
                  />
                </Field>
              </div>

              {sample ? (
                <div className="mt-2">
                  <Row term="Face value" value={formatMoney(sample.faceValue)} />
                  <Row term="Tenor" value={formatDays(sample.tenorDays)} />
                  <Row term="Annualised" value={formatRate(sample.annualisedYieldBps)} />
                  <Row term="Discount you earn" value={formatMoney(sample.discount)} />
                  <Row term="You would pay" value={formatMoney(sample.proceeds)} emphasis />
                </div>
              ) : (
                <p className="mt-3 text-sm text-muted">Set a yield and a face value.</p>
              )}

              {!sampleAccepted ? (
                <p className="mt-3 rounded-sm border border-warn/40 bg-warn-wash px-3 py-2 text-xs">
                  This sample runs {sampleTenor} days and your mandate stops at {maxTenor}. As
                  written, it would not take this invoice at all.
                </p>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHead
              title="What it would take today"
              hint="Run against the invoices quotable on the book right now."
            />
            <div className="px-5 py-4">
              <div className="flex items-baseline justify-between">
                <span className="num text-2xl leading-none" data-num>
                  {takes.length}
                </span>
                <span className="text-xs text-muted">
                  of {assessed.length} quotable invoices ·{' '}
                  <span className="num">{formatMoney(wouldDeploy, { fractionDigits: 0 })}</span>{' '}
                  deployed
                </span>
              </div>

              <div className="mt-4">
                {assessed.slice(0, 7).map(({ invoice, result }) => {
                  const refusal = result.refusals[0];
                  return (
                    <div
                      key={invoice.id}
                      className="ledger-row flex items-center justify-between gap-3 py-2.5"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <RatingChip rating={ratingOf(invoice)} />
                        <span className="min-w-0 truncate text-xs">{debtorNameOf(invoice)}</span>
                        <span className="num shrink-0 text-xs text-faint">{result.tenorDays}d</span>
                      </div>
                      <span className="shrink-0 text-right text-xs">
                        {result.quote ? (
                          <span className="num text-pos">
                            {formatMoney(result.quote.proceeds, { fractionDigits: 0 })}
                          </span>
                        ) : (
                          <span className="text-faint">
                            {refusal ? refusalShort(refusal.code) : 'not taken'}
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>

              <p className="mt-3 text-xs text-muted">
                Widen the rating floor or lengthen the tenor and this list grows. That is the whole
                trade-off, and it is the only one a funder has to make.
              </p>
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}
