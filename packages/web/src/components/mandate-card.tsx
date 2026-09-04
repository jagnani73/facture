import Link from 'next/link';

import type { Mandate } from '@/lib/domain';
import { unallocated } from '@/lib/domain';
import { formatMoney, formatMoneyCompact, formatRate } from '@/lib/format';
import type { MandateMeta } from '@/lib/fixtures';
import type { Position } from '@/lib/pricing';
import { sumFace, weightedAverageRateBps } from '@/lib/pricing';
import { ExposureMeter } from './exposure-meter';
import { RatingChip } from './rating-chip';

/**
 * A standing bid, as its owner reads it.
 *
 * A funder does not browse invoices, so this card is the whole of their interface with the
 * market: the policy they wrote, how much of it is working, and what it has actually
 * earned as against what it bid.
 */

/** The mandate restated as the sentence a funder would say out loud. */
export function describeMandate(mandate: Mandate): string {
  const rating =
    mandate.minRating === 'UNRATED'
      ? 'any customer with no default on record'
      : mandate.minRating === 'D'
        ? 'any customer at all'
        : `any customer rated ${mandate.minRating} or better`;

  return [
    `Any invoice from ${rating},`,
    `${mandate.maxTenorDays} days or less,`,
    `at ${formatRate(mandate.annualisedYieldBps)} annualised,`,
    `up to ${formatMoney(mandate.totalCommitted, { fractionDigits: 0 })} in total`,
    `and ${formatMoney(mandate.maxPerDebtor, { fractionDigits: 0 })} against any one customer.`,
  ].join(' ');
}

export function OperatorBadge({ operator }: { operator: MandateMeta['operator'] }) {
  const agent = operator === 'agent';
  return (
    <span
      title={
        agent
          ? 'A software agent runs this mandate under a fixed policy, from an account capped at the commitment. It is not simulated liquidity.'
          : 'A person at a credit desk runs this mandate.'
      }
      className="label-micro inline-flex h-5 items-center rounded-xs border border-rule-strong bg-sunken px-1.5"
    >
      {agent ? 'Agent-run' : 'Desk-run'}
    </span>
  );
}

export interface MandateCardProps {
  mandate: Mandate;
  meta: MandateMeta;
  positions: readonly Position[];
  /** Optional: mandates have no detail route of their own yet. */
  href?: string | undefined;
}

export function MandateCard({ mandate, meta, positions, href }: MandateCardProps) {
  const open = positions.filter((p) => p.state === 'open');
  const realisedBps = weightedAverageRateBps(open);
  const faceOut = sumFace(open);
  const drift = realisedBps - mandate.annualisedYieldBps;

  return (
    <article className="card flex flex-col">
      <header className="flex items-start justify-between gap-4 border-b border-rule px-5 py-4">
        <div className="min-w-0">
          <h3 className="truncate text-base leading-tight font-medium">
            {href ? (
              <Link href={href} className="hover:text-accent">
                {meta.name}
              </Link>
            ) : (
              meta.name
            )}
          </h3>
          <p className="mt-1 flex items-center gap-2 text-xs text-muted">
            <span className="truncate">{meta.ownerName}</span>
            <OperatorBadge operator={meta.operator} />
          </p>
        </div>

        <div className="shrink-0 text-right">
          <span className="num block text-2xl leading-none font-medium" data-num>
            {formatRate(mandate.annualisedYieldBps)}
          </span>
          <span className="label-micro mt-1">Bid, annualised</span>
        </div>
      </header>

      <div className="border-b border-rule px-5 py-3.5">
        <p className="text-sm text-muted">{describeMandate(mandate)}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
          <span className="inline-flex items-center gap-1.5">
            Floor <RatingChip rating={mandate.minRating} />
          </span>
          <span>
            Max tenor <span className="num text-ink">{mandate.maxTenorDays}d</span>
          </span>
          <span>
            Per customer{' '}
            <span className="num text-ink">{formatMoneyCompact(mandate.maxPerDebtor)}</span>
          </span>
        </div>
      </div>

      <div className="px-5 py-4">
        <ExposureMeter
          totalCommitted={mandate.totalCommitted}
          allocated={mandate.allocated}
          maxPerDebtor={mandate.maxPerDebtor}
          positions={open}
          compact
        />
      </div>

      <div className="mt-auto grid grid-cols-3 gap-px border-t border-rule bg-rule">
        <Cell label="Weighted yield" value={formatRate(realisedBps)} note={driftNote(drift)} />
        <Cell
          label="Face outstanding"
          value={formatMoneyCompact(faceOut)}
          note={`${open.length} invoice${open.length === 1 ? '' : 's'}`}
        />
        <Cell
          label="Uncommitted"
          value={formatMoneyCompact(unallocated(mandate))}
          note="ready to match"
        />
      </div>
    </article>
  );
}

function driftNote(drift: number): string {
  if (drift === 0) return 'exactly at the bid';
  return drift > 0 ? `${drift} bps over the bid` : `${Math.abs(drift)} bps under the bid`;
}

function Cell({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="bg-raised px-4 py-3">
      <span className="label-micro">{label}</span>
      <span className="num mt-1 block text-sm font-medium" data-num>
        {value}
      </span>
      <span className="mt-0.5 block text-[0.6875rem] text-faint">{note}</span>
    </div>
  );
}
