/**
 * SQLite schema (Drizzle).
 *
 * Money is stored as `bigint` minor units, never float and never `numeric`. Discounts are
 * computed off day counts and basis points, and a rounding disagreement between the
 * quote a seller saw and the proceeds they received is the kind of bug nobody finds until
 * a demo. bigint makes the arithmetic exact and forces the units into the column name.
 *
 * Chain identifiers are stored in whichever form the API that consumes them wants —
 * `0.0.x` native ids for anything the Hedera SDK or an x402 `PaymentRequirements` touches,
 * `0x…` EVM addresses for anything viem touches. Both are kept where both are needed
 * rather than converting at read time.
 *
 * ## Three decisions this dialect forces, and how they were taken
 *
 * 1. **Money is `TEXT`, decoded to `bigint` — see `bigintText` below.** SQLite's INTEGER is
 *    64-bit, but `better-sqlite3` hands 64-bit integers back as JS `number` unless the
 *    connection is put in a mode that returns them all as BigInt, and a `number` silently
 *    loses precision past 2^53. On a money column that failure is invisible and permanent,
 *    so the amount never becomes a `number` at any point: it is written as a decimal string
 *    and read straight into `BigInt`.
 * 2. **Instants are `INTEGER` epoch milliseconds** (`integer({ mode: 'timestamp_ms' })`).
 *    An epoch is absolute, which is what `timestamp with time zone` meant here; Drizzle maps
 *    it to and from `Date` so `projections.ts` is untouched; it sorts numerically, so
 *    `ORDER BY created_at` and the keyset cursor in `sqlite-store.ts` keep working; and
 *    ~1.7e12 is nowhere near 2^53, so unlike money it is safe as a `number` on the wire.
 *    ISO text would sort too, but would put a string parse on every read path for nothing.
 * 3. **Enums are `TEXT` with a Drizzle-level member list.** SQLite has no enum type. The
 *    tuples below are unchanged and the `Expect<Drift<…>>` guards still bind to them, so the
 *    domain unions and the columns still cannot drift apart at compile time.
 *
 * There is likewise no native `uuid`: ids are `TEXT` holding the same UUID strings, and the
 * `gen_random_uuid()` default becomes a Drizzle `$defaultFn` calling `randomUUID()`.
 */

import type { InvoiceStatus, IssuanceState, MandateStatus, Rating } from '@facture/shared';
import type { SettlementOutcome } from '../services/rating.js';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  customType,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// --- column helpers -------------------------------------------------------------

/**
 * A 64-bit-and-wider integer held as TEXT and read back as `bigint`.
 *
 * This is the money column type, and TEXT is deliberate rather than a shortcoming.
 * `better-sqlite3` returns SQLite INTEGERs as JS `number`s, so an amount above 2^53 minor
 * units would come back rounded with nothing to indicate it — the one failure mode a
 * receivables ledger cannot tolerate, since it corrupts the number rather than refusing it.
 * A decimal string round-trips exactly at any magnitude and `BigInt(…)` throws on anything
 * that is not one, so a corrupt row is loud.
 *
 * The cost is that SQL cannot do arithmetic on these columns: `sum()` over TEXT would coerce
 * to a float and reintroduce the very loss this avoids. `sqlite-store.ts` therefore sums and
 * increments money in JS, inside a transaction — see `debtorExposure` and `recordOutcome`.
 */
const bigintText = customType<{ data: bigint; driverData: string }>({
  dataType: () => 'text',
  toDriver: (value: bigint): string => value.toString(),
  fromDriver: (value: string): bigint => BigInt(value),
});

/** Epoch-ms `INTEGER`, mapped to and from `Date` by Drizzle. See the header note. */
const instant = (name: string) => integer(name, { mode: 'timestamp_ms' });

/** SQLite has no `now()`; `unixepoch('subsec')` is seconds with a fraction. */
const NOW_MS = sql`(cast(unixepoch('subsec') * 1000 as integer))`;

/** Written as a string so the DDL default matches what `bigintText` stores. */
const ZERO_MINOR = sql`'0'`;

// --- enums ----------------------------------------------------------------------

/** Members and order both mirror `INVOICE_STATUSES` in `@facture/shared`. */
export const INVOICE_STATUS = [
  'draft',
  'awaiting_confirmation',
  'confirmed',
  'listed',
  'sold',
  'matured',
  'defaulted',
  'disputed',
] as const;

/**
 * Ordered WORST CREDIT FIRST, which is the reverse of shared's `RATINGS` array.
 *
 * Under Postgres this tuple was load-bearing: an enum sorts by declaration, so declaring the
 * grades ascending made `debtor.rating >= mandate.rating_floor` mean in SQL what
 * `meetsRatingFloor` means in `@facture/shared` — including the part that matters most, `D`
 * sorting BELOW `UNRATED`, so a mandate with the widest floor a buyer can write still
 * excludes a customer who has defaulted.
 *
 * SQLite has no enum and compares TEXT lexicographically, where `'D' > 'C' > 'B' > 'A'` and
 * `'UNRATED'` sorts last — the reverse of the ladder in two places at once. **So nothing may
 * compare this column in SQL.** Nothing does: `listQuotableMandates` over-fetches on purpose
 * and every rating-floor decision is taken by `meetsRatingFloor` in shared, over projected
 * rows. The order is kept here because it is the ladder, and reading it as anything else is
 * how the rule gets quietly reintroduced.
 */
export const RATING_GRADE = ['D', 'UNRATED', 'C', 'B', 'A'] as const;

/** Members and order both mirror `MANDATE_STATUSES` in `@facture/shared`. */
export const MANDATE_STATUS = ['draft', 'funding', 'active', 'exhausted', 'withdrawn'] as const;

/**
 * Compile-time guard: the DB enum and the domain union must not drift. If
 * `@facture/shared` adds a member this file does not know about, `Drift` resolves to a
 * tuple naming it, `Expect` rejects it, and the typecheck fails here rather than an
 * `INSERT` failing in production.
 *
 * Widen the tuples above if shared gains a member — do not loosen these assertions.
 */
type Expect<T extends true> = T;
type Drift<Domain extends string, Db extends string> =
  Exclude<Domain, Db> extends never ? true : ['DB enum is missing', Exclude<Domain, Db>];

type _AssertInvoiceStatus = Expect<Drift<InvoiceStatus, (typeof INVOICE_STATUS)[number]>>;
type _AssertRating = Expect<Drift<Rating, (typeof RATING_GRADE)[number]>>;
type _AssertMandateStatus = Expect<Drift<MandateStatus, (typeof MANDATE_STATUS)[number]>>;
type _AssertSettlementOutcome = Expect<
  Drift<SettlementOutcome, (typeof SETTLEMENT_OUTCOMES)[number]>
>;
type _AssertIssuanceState = Expect<Drift<IssuanceState, (typeof ISSUANCE_STATE)[number]>>;

/** Members and order both mirror `ISSUANCE_STATES` in `@facture/shared`. */
export const ISSUANCE_STATE = ['queued', 'issuing', 'issued', 'failed'] as const;

export const REGULATION_TYPE = ['reg-d-506b', 'reg-d-506c', 'reg-s'] as const;

export const CONFIRMATION_DECISION = ['confirmed', 'disputed'] as const;

export const QUOTE_STATUS = ['live', 'accepted', 'expired', 'superseded'] as const;

export const TRADE_STATUS = [
  'preparing',
  'awaiting_payment',
  'settled',
  'unwound',
  'failed',
] as const;

/** How a settled receivable resolved. Mirrors `SettlementOutcome` in `services/rating.ts`. */
export const SETTLEMENT_OUTCOMES = ['on_time', 'late', 'default'] as const;

// --- parties --------------------------------------------------------------------

export const sellers = sqliteTable(
  'sellers',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    name: text('name').notNull(),
    email: text('email').notNull(),
    /** May be a wallet made from an email address; the seller never needs to know. */
    hederaAccountId: text('hedera_account_id'),
    arcAddress: text('arc_address'),
    createdAt: instant('created_at').notNull().default(NOW_MS),
  },
  (t) => [uniqueIndex('sellers_email_key').on(t.email)],
);

export const buyers = sqliteTable(
  'buyers',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    name: text('name').notNull(),
    email: text('email').notNull(),
    hederaAccountId: text('hedera_account_id'),
    arcAddress: text('arc_address'),
    /** Set for agent-operated desks. Surfaced as exactly that; fake liquidity is the one
     * thing that would undo the whole argument, so an agent is never disguised as a human. */
    agentPolicy: text('agent_policy', { mode: 'json' }).$type<{
      capsMinor?: string;
      label?: string;
    } | null>(),
    createdAt: instant('created_at').notNull().default(NOW_MS),
  },
  (t) => [uniqueIndex('buyers_email_key').on(t.email)],
);

/**
 * Debtors carry the rating accumulator inline. It is one row per debtor, updated inside
 * the settlement transaction, and every column here is an input to `services/rating.ts`.
 *
 * The counters are a **projection**. `settlement_outcomes` below is the append-only fact
 * they are derived from, keyed on `(debtor_id, invoice_id)` so a replayed maturity cannot
 * tighten a rating twice. `rating` is likewise recomputed from the counters rather than
 * being incremented alongside them, so the stored grade cannot drift from the ladder.
 */
export const debtors = sqliteTable(
  'debtors',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    name: text('name').notNull(),
    /** Where the confirmation link is sent. No wallet, no signup. */
    email: text('email').notNull(),
    taxId: text('tax_id'),

    rating: text('rating', { enum: RATING_GRADE }).notNull().default('UNRATED'),
    settledOnTime: integer('settled_on_time').notNull().default(0),
    settledLate: integer('settled_late').notNull().default(0),
    defaulted: integer('defaulted').notNull().default(0),
    settledFaceValue: bigintText('settled_face_value').notNull().default(ZERO_MINOR),
    firstSettlementAt: instant('first_settlement_at'),
    lastSettlementAt: instant('last_settlement_at'),

    createdAt: instant('created_at').notNull().default(NOW_MS),
  },
  (t) => [uniqueIndex('debtors_email_key').on(t.email), index('debtors_rating_idx').on(t.rating)],
);

// --- the book -------------------------------------------------------------------

export const invoices = sqliteTable(
  'invoices',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    sellerId: text('seller_id')
      .notNull()
      .references(() => sellers.id),
    debtorId: text('debtor_id')
      .notNull()
      .references(() => debtors.id),

    invoiceNumber: text('invoice_number').notNull(),
    faceValue: bigintText('face_value').notNull(),
    currency: text('currency', { length: 3 }).notNull(),
    issuedAt: instant('issued_at').notNull(),
    /**
     * Becomes the bond's maturity. `initializeMaturity` is one-shot: never edit after
     * issuance.
     */
    dueAt: instant('due_at').notNull(),
    /**
     * `draft` until the customer has been asked to confirm. Tokenisation progress is NOT
     * this column — it is `issuanceState`, which moves independently because issuance is
     * paced and an invoice can be confirmed before its instrument exists.
     */
    status: text('status', { enum: INVOICE_STATUS }).notNull().default('draft'),

    /**
     * The uniqueness registry, keyed on hash(debtor, invoice number, amount). One
     * receivable mints exactly one instrument, ever. This is the cheap half of the fraud
     * problem: selling the same receivable to three financiers is the specific fraud
     * factoring has always had, and roughly what broke Greensill.
     */
    uniquenessHash: text('uniqueness_hash').notNull(),

    /** Checksum-valid; ATS `onlyValidISIN` rejects arbitrary strings. */
    isin: text('isin'),
    regulationType: text('regulation_type', { enum: REGULATION_TYPE })
      .notNull()
      .default('reg-d-506c'),
    securityId: text('security_id'),
    securityEvmAddress: text('security_evm_address'),

    issuanceState: text('issuance_state', { enum: ISSUANCE_STATE }).notNull().default('queued'),
    issuanceAttempts: integer('issuance_attempts').notNull().default(0),
    issuanceTxId: text('issuance_tx_id'),
    issuanceError: text('issuance_error'),

    /** SHA-256 of the emailed token. The token itself is never stored. */
    confirmationTokenHash: text('confirmation_token_hash'),
    confirmationRequestedAt: instant('confirmation_requested_at'),
    confirmationExpiresAt: instant('confirmation_expires_at'),
    confirmationDecision: text('confirmation_decision', { enum: CONFIRMATION_DECISION }),
    confirmationDecidedAt: instant('confirmation_decided_at'),
    confirmationNote: text('confirmation_note'),

    createdAt: instant('created_at').notNull().default(NOW_MS),
    updatedAt: instant('updated_at').notNull().default(NOW_MS),
  },
  (t) => [
    uniqueIndex('invoices_uniqueness_hash_key').on(t.uniquenessHash),
    uniqueIndex('invoices_isin_key').on(t.isin),
    index('invoices_seller_status_idx').on(t.sellerId, t.status),
    index('invoices_debtor_idx').on(t.debtorId),
    index('invoices_due_at_idx').on(t.dueAt),
    index('invoices_confirmation_token_idx').on(t.confirmationTokenHash),
  ],
);

/**
 * Standing bids. A buyer never browses invoices; they write a mandate, fund it, and walk
 * away. Funding is what makes a quote firm: `fundedMinor - allocatedMinor` is the hard
 * ceiling on what this mandate can take, which is also what resolves two invoices
 * arriving against one mandate.
 */
export const mandates = sqliteTable(
  'mandates',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    buyerId: text('buyer_id')
      .notNull()
      .references(() => buyers.id),

    ratingFloor: text('rating_floor', { enum: RATING_GRADE }).notNull(),
    maxTenorDays: integer('max_tenor_days').notNull(),
    annualisedYieldBps: integer('annualised_yield_bps').notNull(),
    currency: text('currency', { length: 3 }).notNull(),

    /** Total exposure ceiling, and the per-debtor concentration cap under it. */
    exposureLimitMinor: bigintText('exposure_limit_minor').notNull(),
    perDebtorLimitMinor: bigintText('per_debtor_limit_minor'),

    /** Escrowed at funding. Unallocated balance = funded - allocated. */
    fundedMinor: bigintText('funded_minor').notNull().default(ZERO_MINOR),
    allocatedMinor: bigintText('allocated_minor').notNull().default(ZERO_MINOR),
    escrowRef: text('escrow_ref'),

    status: text('status', { enum: MANDATE_STATUS }).notNull().default('draft'),
    createdAt: instant('created_at').notNull().default(NOW_MS),
    updatedAt: instant('updated_at').notNull().default(NOW_MS),
  },
  (t) => [
    index('mandates_buyer_status_idx').on(t.buyerId, t.status),
    /** The curve read: status + bucket, ordered by price. */
    index('mandates_curve_idx').on(t.status, t.ratingFloor, t.maxTenorDays, t.annualisedYieldBps),
  ],
);

/**
 * Quotes are live and derived, but the accepted one is persisted so a trade can prove
 * what price was shown and reject a stale acceptance.
 */
export const quotes = sqliteTable(
  'quotes',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id),
    mandateId: text('mandate_id').references(() => mandates.id),

    ratingAtQuote: text('rating_at_quote', { enum: RATING_GRADE }).notNull(),
    tenorDays: integer('tenor_days').notNull(),
    annualisedYieldBps: integer('annualised_yield_bps').notNull(),
    faceValue: bigintText('face_value').notNull(),
    discountMinor: bigintText('discount_minor').notNull(),
    proceedsMinor: bigintText('proceeds_minor').notNull(),

    status: text('status', { enum: QUOTE_STATUS }).notNull().default('live'),
    pricedAt: instant('priced_at').notNull().default(NOW_MS),
    expiresAt: instant('expires_at').notNull(),
  },
  (t) => [index('quotes_invoice_priced_idx').on(t.invoiceId, t.pricedAt)],
);

export const trades = sqliteTable(
  'trades',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id),
    mandateId: text('mandate_id')
      .notNull()
      .references(() => mandates.id),
    quoteId: text('quote_id')
      .notNull()
      .references(() => quotes.id),
    sellerId: text('seller_id')
      .notNull()
      .references(() => sellers.id),
    buyerId: text('buyer_id')
      .notNull()
      .references(() => buyers.id),

    faceValue: bigintText('face_value').notNull(),
    proceedsMinor: bigintText('proceeds_minor').notNull(),
    annualisedYieldBps: integer('annualised_yield_bps').notNull(),
    tenorDays: integer('tenor_days').notNull(),
    status: text('status', { enum: TRADE_STATUS }).notNull().default('preparing'),

    /**
     * How many units of the security this trade moves: the seller's WHOLE position, read
     * off the instrument with `balanceOf` when the trade is armed.
     *
     * Not derived from the face value, even though issuance currently mints one unit per
     * minor unit of face — the two are separate facts, and the one that decides what the
     * hold moves is the balance. It is stored rather than re-read because
     * `executeHoldByPartition` and `releaseHoldByPartition` must name the same amount the
     * hold was created for, and a balance re-read after the hold exists is a different
     * number.
     *
     * Nullable only for rows written before this column existed; every trade this build
     * arms carries it, and settlement refuses to execute or release a hold whose amount it
     * cannot name.
     */
    unitsMinor: bigintText('units_minor'),

    // Asset leg — Hedera. The hold is placed before the cash leg and executed after it.
    holdId: text('hold_id'),
    assetTxId: text('asset_tx_id'),
    assetConsensusAt: instant('asset_consensus_at'),

    // Cash leg — x402. `cashTransaction` is the facilitator's settlement reference.
    cashScheme: text('cash_scheme'),
    cashNetwork: text('cash_network'),
    cashAsset: text('cash_asset'),
    cashTransaction: text('cash_transaction'),
    cashPayer: text('cash_payer'),

    /** The pre-match ControlList / Kyc decision, kept verbatim for the proof view. */
    complianceDecision: text('compliance_decision', { mode: 'json' }).$type<Record<
      string,
      unknown
    > | null>(),
    complianceCheckedAt: instant('compliance_checked_at'),

    /** HCS receipt for the match itself. Checkable without trusting the venue. */
    hcsTopicId: text('hcs_topic_id'),
    hcsSequenceNumber: bigintText('hcs_sequence_number'),

    /**
     * The Hedera Scheduled Transaction that pays this trade's holder at maturity, `0.0.x`.
     *
     * Stored because the schedule is an obligation that exists on the ledger whether or not
     * this service remembers it. Without a record, a second call to maturity would create a
     * second schedule — two claims on one face value — and the venue would have no way to
     * find the first one to sign or delete it. This column is what makes the payout
     * idempotent, and it is set only on the call that actually matured the receivable.
     */
    maturityScheduleId: text('maturity_schedule_id'),

    createdAt: instant('created_at').notNull().default(NOW_MS),
    settledAt: instant('settled_at'),
  },
  (t) => [
    index('trades_invoice_idx').on(t.invoiceId),
    index('trades_buyer_idx').on(t.buyerId, t.status),
    index('trades_seller_idx').on(t.sellerId, t.status),
  ],
);

/**
 * A mandate that is not eligible for an instrument does not match, and the funder is told
 * why in words rather than by a reverted transaction. Each refusal writes a receipt to
 * HCS that the rejected party can verify independently.
 */
export const refusalReceipts = sqliteTable(
  'refusal_receipts',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id),
    mandateId: text('mandate_id')
      .notNull()
      .references(() => mandates.id),
    buyerId: text('buyer_id')
      .notNull()
      .references(() => buyers.id),

    /** e.g. `regulation_mismatch`, `rating_below_floor`, `tenor_exceeded`, `exposure_exhausted`. */
    reasonCode: text('reason_code').notNull(),
    /** The sentence the funder actually reads. */
    reasonText: text('reason_text').notNull(),

    ratingAtRefusal: text('rating_at_refusal', { enum: RATING_GRADE }).notNull(),
    tenorDaysAtRefusal: integer('tenor_days_at_refusal').notNull(),

    hcsTopicId: text('hcs_topic_id'),
    hcsSequenceNumber: bigintText('hcs_sequence_number'),
    hcsConsensusAt: instant('hcs_consensus_at'),

    createdAt: instant('created_at').notNull().default(NOW_MS),
  },
  (t) => [
    index('refusals_invoice_idx').on(t.invoiceId),
    index('refusals_mandate_idx').on(t.mandateId),
  ],
);

/**
 * Every confirmation the seller has ever asked for, in order.
 *
 * The current token also lives inline on `invoices` because that is what the hot path
 * reads — one indexed lookup on `confirmation_token_hash`, no join. This table is the
 * ledger behind that projection: re-requesting confirmation invalidates the previous
 * token, and "invalidates" has to leave a trace or a debtor who clicks a stale link gets
 * an unexplained refusal. Both are written in one transaction.
 */
export const confirmationRequests = sqliteTable(
  'confirmation_requests',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id),

    /** SHA-256 of the emailed token. The token itself is never stored, here or anywhere. */
    tokenHash: text('token_hash').notNull(),
    requestedAt: instant('requested_at').notNull().default(NOW_MS),
    expiresAt: instant('expires_at').notNull(),

    /** Single-use: set in the same transaction that writes the decision. */
    consumedAt: instant('consumed_at'),
    /** Set when a later request superseded this one before the debtor answered. */
    supersededAt: instant('superseded_at'),

    decision: text('decision', { enum: CONFIRMATION_DECISION }),
    decidedAt: instant('decided_at'),
    note: text('note'),
  },
  (t) => [
    uniqueIndex('confirmation_requests_token_key').on(t.tokenHash),
    index('confirmation_requests_invoice_idx').on(t.invoiceId, t.requestedAt),
  ],
);

/**
 * The rating ledger.
 *
 * `debtors` carries the accumulator as a projection — that is what the curve reads — and
 * this is the append-only fact behind it, one row per settled receivable. The unique index
 * is the whole point: maturity can be observed twice (a mirror-node replay, a retried
 * scheduled transaction), and without it a second observation would tighten a rating for a
 * payment that happened once.
 */
export const settlementOutcomes = sqliteTable(
  'settlement_outcomes',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    debtorId: text('debtor_id')
      .notNull()
      .references(() => debtors.id),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id),

    outcome: text('outcome', { enum: SETTLEMENT_OUTCOMES }).notNull(),
    faceValue: bigintText('face_value').notNull(),
    occurredAt: instant('occurred_at').notNull(),
    createdAt: instant('created_at').notNull().default(NOW_MS),
  },
  (t) => [
    uniqueIndex('settlement_outcomes_receivable_key').on(t.debtorId, t.invoiceId),
    index('settlement_outcomes_debtor_idx').on(t.debtorId),
  ],
);

/**
 * Durable issuance queue state, one row per invoice.
 *
 * `invoices.issuance_state` stays the projection the book renders — "being added" is an
 * invoice-level fact and the book must not join to learn it. The timing fields that only
 * the worker needs live here, so a restart can rebuild the queue instead of losing every
 * job that was mid-backoff.
 */
export const issuanceJobs = sqliteTable(
  'issuance_jobs',
  {
    invoiceId: text('invoice_id')
      .primaryKey()
      .references(() => invoices.id),
    state: text('state', { enum: ISSUANCE_STATE }).notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    queuedAt: instant('queued_at').notNull().default(NOW_MS),
    startedAt: instant('started_at'),
    completedAt: instant('completed_at'),
    /** Set while backing off. Null means "runnable now". */
    nextAttemptAt: instant('next_attempt_at'),
    lastError: text('last_error'),
  },
  (t) => [index('issuance_jobs_state_idx').on(t.state, t.nextAttemptAt)],
);

/**
 * Indexer cursors, one row per chain.
 *
 * In memory a cursor resets to null on every restart, which reads on `/health` as "we have
 * never polled" rather than "we are 4,000 blocks behind" — the two look identical and only
 * one of them is fine.
 */
export const indexerCursors = sqliteTable('indexer_cursors', {
  chain: text('chain').primaryKey(),
  /** Block number or consensus position, as a string: Arc's exceeds 2^53 eventually. */
  cursor: text('cursor').notNull(),
  updatedAt: instant('updated_at').notNull().default(NOW_MS),
});

export type SellerRow = typeof sellers.$inferSelect;
export type BuyerRow = typeof buyers.$inferSelect;
export type DebtorRow = typeof debtors.$inferSelect;
export type InvoiceRow = typeof invoices.$inferSelect;
export type MandateRow = typeof mandates.$inferSelect;
export type QuoteRow = typeof quotes.$inferSelect;
export type TradeRow = typeof trades.$inferSelect;
export type RefusalReceiptRow = typeof refusalReceipts.$inferSelect;
export type ConfirmationRequestRow = typeof confirmationRequests.$inferSelect;
export type SettlementOutcomeRow = typeof settlementOutcomes.$inferSelect;
export type IssuanceJobRow = typeof issuanceJobs.$inferSelect;
export type IndexerCursorRow = typeof indexerCursors.$inferSelect;

export type NewSellerRow = typeof sellers.$inferInsert;
export type NewBuyerRow = typeof buyers.$inferInsert;
export type NewDebtorRow = typeof debtors.$inferInsert;
export type NewInvoiceRow = typeof invoices.$inferInsert;
export type NewMandateRow = typeof mandates.$inferInsert;
export type NewQuoteRow = typeof quotes.$inferInsert;
export type NewTradeRow = typeof trades.$inferInsert;
export type NewRefusalReceiptRow = typeof refusalReceipts.$inferInsert;
export type NewConfirmationRequestRow = typeof confirmationRequests.$inferInsert;
export type NewSettlementOutcomeRow = typeof settlementOutcomes.$inferInsert;
