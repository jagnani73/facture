import type { Rating } from '@/lib/domain';
import { RATING_BLURB } from '@/lib/pricing';

/**
 * A customer's earned rating.
 *
 * Not bought from an agency and not modelled — it is a count of invoices they have settled
 * on this market, so the chip carries that count wherever there is room for it. The scale
 * is A–D rather than borrowed agency notation precisely because it means nothing off this
 * platform, and `D` is a customer who has actually failed to pay.
 */

const TONE: Record<Rating, string> = {
  A: 'border-pos/50 bg-pos-wash text-pos',
  B: 'border-accent/40 bg-accent-wash text-accent-ink',
  C: 'border-warn/45 bg-warn-wash text-warn',
  D: 'border-neg/45 bg-neg-wash text-neg',
  UNRATED: 'border-rule-strong bg-sunken text-muted',
};

const SIZES = {
  sm: 'h-5 min-w-[2.25rem] px-1.5 text-[0.6875rem]',
  md: 'h-6 min-w-[2.5rem] px-2 text-xs',
} as const;

export function RatingChip({
  rating,
  size = 'sm',
  settled,
}: {
  rating: Rating;
  size?: keyof typeof SIZES | undefined;
  /** Invoices this customer has settled. Shown as the reason for the rating. */
  settled?: number | undefined;
}) {
  const label = rating === 'UNRATED' ? 'NR' : rating;
  const blurb = RATING_BLURB[rating];
  const title =
    settled === undefined
      ? blurb
      : `${blurb} ${settled} invoice${settled === 1 ? '' : 's'} settled on time.`;

  return (
    <span
      title={title}
      className={[
        'num inline-flex items-center justify-center rounded-xs border font-medium tracking-wide',
        TONE[rating],
        SIZES[size],
      ].join(' ')}
    >
      {label}
    </span>
  );
}

/** The chip with its record spelled out, for detail pages. */
export function RatingWithRecord({
  rating,
  settled,
  late,
}: {
  rating: Rating;
  settled: number;
  late: number;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <RatingChip rating={rating} size="md" settled={settled} />
      <span className="text-xs text-muted">
        {settled === 0
          ? 'no settled invoices yet'
          : `${settled} settled${late > 0 ? `, ${late} unpaid` : ', none missed'}`}
      </span>
    </span>
  );
}
