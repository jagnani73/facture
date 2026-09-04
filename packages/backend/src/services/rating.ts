/**
 * Debtor ratings.
 *
 * Ratings are EARNED, never assigned. There is no external source of truth for SME
 * debtor credit — no feed or oracle says whether a given customer is good for $40k in
 * sixty days — so the market manufactures its own record or prices blind. A debtor
 * starts UNRATED and prices at the wide end of the curve; every invoice they settle on
 * time tightens them; a default marks them permanently and widens their curve for every
 * seller afterwards. That last part is what makes the loop self-correcting rather than
 * merely accumulative: the market prices its own mistakes back in.
 *
 * `Rating` comes from `@facture/shared`, which is canonical: the grades are `A | B | C |
 * D | UNRATED`, and `RATING_RANK` there puts `D` BELOW `UNRATED` — a default is
 * information, an absence of history is not. The ladder below is written to agree with
 * that ranking, and `assertLadderMatchesSharedRanking` fails the module load if it stops
 * agreeing. The grade literals are unannotated on purpose: they are checked against the
 * shared union rather than cast into it, so a rename in shared breaks this file loudly.
 */

import type { Rating } from '@facture/shared';
import { compareRating } from '@facture/shared';
import { toPaymentRecord } from '../db/projections.js';
import { getStore } from '../db/store.js';
import { notFound } from '../errors.js';

/** How a settled receivable resolved. This is the only input a rating ever takes. */
export type SettlementOutcome = 'on_time' | 'late' | 'default';

/** The accumulator. One row per debtor; monotonic except that nothing ever un-defaults. */
export interface DebtorPaymentRecord {
  debtorId: string;
  /** Paid on or before the due date. */
  settledOnTime: number;
  /** Paid, but after the due date. Counts against the score; does not mark. */
  settledLate: number;
  /** Never paid. Permanent. */
  defaulted: number;
  /** Sum of face value settled, minor units. Bounds how far a rating may travel. */
  settledFaceValue: bigint;
  firstSettlementAt: Date | null;
  lastSettlementAt: Date | null;
}

export interface RatingAssessment {
  debtorId: string;
  rating: Rating;
  /** The integer the buckets are read against. Exposed so the UI can show the ladder. */
  score: number;
  record: DebtorPaymentRecord;
  /** One sentence for the seller-facing UI, e.g. "3 invoices paid on time". */
  reason: string;
  /** Score needed for the next grade, or null at the ceiling / when marked. */
  nextGradeAt: number | null;
  /** True once a default has been recorded. No amount of good behaviour clears it. */
  permanentlyMarked: boolean;
}

/**
 * Bucketing.
 *
 *   score = settledOnTime - 2 * settledLate
 *
 * A late payment costs two on-time payments because lateness is the leading indicator
 * of the default the buyer actually cares about, and the sample sizes here are tiny.
 *
 *   any default ever   ->  D        permanent, regardless of score
 *   score >= 8         ->  A
 *   score >= 4         ->  B
 *   score >= 1         ->  C
 *   otherwise          ->  UNRATED  (cold start; prices at the wide end)
 *
 * Ordering is A > B > C > UNRATED > D, matching `RATING_RANK` in `@facture/shared`. A
 * defaulted customer sits below a cold start rather than beside `C`, so a mandate written
 * with the widest floor a buyer can pick — `UNRATED` — still refuses them.
 *
 * Deliberately NOT in v1, in rough order of how much they matter:
 *  - Magnitude weighting. Ten $500 invoices do not prove a debtor good for $50k, so a
 *    grade should be capped by `settledFaceValue` relative to the invoice being priced.
 *  - Recency decay. A clean record from two years ago is weaker than one from March.
 *  - Concentration. All of a debtor's history coming from one seller is worth less.
 */
const BUCKETS: readonly { readonly min: number; readonly rating: Rating }[] = [
  { min: 8, rating: 'A' },
  { min: 4, rating: 'B' },
  { min: 1, rating: 'C' },
];

/** Cold start. Prices at the wide end, and is still above `MARKED` on shared's scale. */
const UNRATED: Rating = 'UNRATED';
/** A default, permanently. Ranks below `UNRATED`, which is the point of having it. */
const MARKED: Rating = 'D';

/**
 * The ladder is written by hand and the ranking lives in `@facture/shared`. Nothing stops
 * the two drifting apart except this check: a higher score must never map to a grade that
 * shared considers worse, and every bucket must beat the cold start it improves on.
 *
 * Runs once at module load. Cheap, and the alternative is a mispriced book that looks fine.
 */
function assertLadderMatchesSharedRanking(): void {
  const ladder: Rating[] = [...BUCKETS].map((b) => b.rating);
  for (const [i, grade] of ladder.entries()) {
    const next = ladder[i + 1];
    if (next !== undefined && compareRating(grade, next) >= 0) {
      throw new Error(
        `rating ladder disagrees with @facture/shared: ${grade} is not above ${next}`,
      );
    }
    if (compareRating(grade, UNRATED) >= 0) {
      throw new Error(
        `rating ladder disagrees with @facture/shared: ${grade} is not above UNRATED`,
      );
    }
  }
  if (compareRating(UNRATED, MARKED) >= 0) {
    throw new Error('rating ladder disagrees with @facture/shared: UNRATED is not above D');
  }
}

assertLadderMatchesSharedRanking();

export function scoreOf(record: DebtorPaymentRecord): number {
  return record.settledOnTime - 2 * record.settledLate;
}

/** Pure. The whole bucketing rule lives here and is unit-testable without a database. */
export function assess(record: DebtorPaymentRecord): RatingAssessment {
  const score = scoreOf(record);
  const marked = record.defaulted > 0;

  if (marked) {
    return {
      debtorId: record.debtorId,
      rating: MARKED,
      score,
      record,
      reason:
        record.defaulted === 1
          ? 'One receivable defaulted. This mark is permanent.'
          : `${record.defaulted} receivables defaulted. This mark is permanent.`,
      nextGradeAt: null,
      permanentlyMarked: true,
    };
  }

  const bucket = BUCKETS.find((b) => score >= b.min);
  const rating = bucket?.rating ?? UNRATED;
  const nextBucket = [...BUCKETS].reverse().find((b) => b.min > score);

  return {
    debtorId: record.debtorId,
    rating,
    score,
    record,
    reason:
      record.settledOnTime === 0 && record.settledLate === 0
        ? 'No settled payment history yet.'
        : `${record.settledOnTime} paid on time, ${record.settledLate} paid late.`,
    nextGradeAt: nextBucket ? nextBucket.min : null,
    permanentlyMarked: false,
  };
}

export function emptyRecord(debtorId: string): DebtorPaymentRecord {
  return {
    debtorId,
    settledOnTime: 0,
    settledLate: 0,
    defaulted: 0,
    settledFaceValue: 0n,
    firstSettlementAt: null,
    lastSettlementAt: null,
  };
}

/** Applies one outcome to a record. Pure — the caller persists the result. */
export function accumulate(
  record: DebtorPaymentRecord,
  outcome: SettlementOutcome,
  faceValue: bigint,
  at: Date,
): DebtorPaymentRecord {
  return {
    ...record,
    settledOnTime: record.settledOnTime + (outcome === 'on_time' ? 1 : 0),
    settledLate: record.settledLate + (outcome === 'late' ? 1 : 0),
    defaulted: record.defaulted + (outcome === 'default' ? 1 : 0),
    settledFaceValue:
      outcome === 'default' ? record.settledFaceValue : record.settledFaceValue + faceValue,
    firstSettlementAt: record.firstSettlementAt ?? at,
    lastSettlementAt: at,
  };
}

// --- persistence-backed surface -------------------------------------------------

export interface RatingService {
  ratingFor(debtorId: string): Promise<RatingAssessment>;
  /** Batched: pricing a book of invoices must not fan out one query per debtor. */
  ratingsFor(debtorIds: readonly string[]): Promise<Map<string, RatingAssessment>>;
  /** Called by settlement and by the maturity watcher. Idempotent per receivable. */
  recordOutcome(input: {
    debtorId: string;
    invoiceId: string;
    outcome: SettlementOutcome;
    faceValue: bigint;
    at: Date;
  }): Promise<RatingAssessment>;
}

export const ratingService: RatingService = {
  async ratingFor(debtorId) {
    const row = await getStore().getDebtor(debtorId);
    if (!row) throw notFound(`Customer ${debtorId}`);
    return assess(toPaymentRecord(row));
  },

  /**
   * One `WHERE id = ANY($1)` read, not one query per debtor. A seller's book screen prices
   * every row at once, and the rating is an input to every one of those prices.
   *
   * A debtor id with no row comes back as an empty record rather than being dropped: an
   * absent customer is a cold start as far as the curve is concerned, and silently omitting
   * them would make the caller's `Map.get` return `undefined` and the invoice unpriceable.
   */
  async ratingsFor(debtorIds) {
    const unique = [...new Set(debtorIds)];
    if (unique.length === 0) return new Map();

    const rows = await getStore().getDebtors(unique);
    const byId = new Map(rows.map((row) => [row.id, row]));

    return new Map(
      unique.map((id) => {
        const row = byId.get(id);
        return [id, assess(row ? toPaymentRecord(row) : emptyRecord(id))];
      }),
    );
  },

  /**
   * Idempotent per receivable. The store writes the outcome and moves the accumulator in
   * one transaction, keyed on `(debtor_id, invoice_id)` — maturity can be observed twice
   * (a mirror-node replay, a retried scheduled transaction) and a rating may only move
   * once for a payment that happened once.
   *
   * The stored `rating` column is refreshed from the recomputed assessment rather than
   * being incremented alongside the counters, so the projection cannot drift from the
   * ladder that produces it.
   */
  async recordOutcome(input) {
    const store = getStore();
    const { debtor, alreadyRecorded } = await store.recordOutcome({
      debtorId: input.debtorId,
      invoiceId: input.invoiceId,
      outcome: input.outcome,
      faceValue: input.faceValue,
      at: input.at,
    });

    const assessment = assess(toPaymentRecord(debtor));
    if (!alreadyRecorded && debtor.rating !== assessment.rating) {
      await store.updateDebtorRating(debtor.id, assessment.rating);
    }
    return assessment;
  },
};
