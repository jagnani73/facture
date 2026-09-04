/**
 * Postgres schema (Drizzle).
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
 */

import type { InvoiceStatus, MandateStatus, Rating } from '@facture/shared';
import {
  bigint,
  char,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

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
 * Postgres orders an enum by declaration, and the predicate this column exists to serve is
 * `debtor.rating >= mandate.rating_floor`. Declaring the grades ascending makes that SQL
 * comparison mean the same thing as `meetsRatingFloor` in `@facture/shared` — including
 * the part that matters most, `D` sorting BELOW `UNRATED`, so a mandate with the widest
 * floor a buyer can write still excludes a customer who has defaulted. Reversing this
 * tuple would silently invert every rating-floor query.
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

export const invoiceStatusEnum = pgEnum('invoice_status', INVOICE_STATUS);
export const ratingEnum = pgEnum('rating_grade', RATING_GRADE);

export const issuanceStateEnum = pgEnum('issuance_state', [
  'queued',
  'issuing',
  'issued',
  'failed',
]);

export const regulationTypeEnum = pgEnum('regulation_type', ['reg-d-506b', 'reg-d-506c', 'reg-s']);

export const confirmationDecisionEnum = pgEnum('confirmation_decision', ['confirmed', 'disputed']);

/**
 * `funding` and `active` are two states, not one `funded`: escrow being initiated is not
 * the same as escrow confirmed, and only the second one quotes. Shared's mandate machine
 * is the authority on the edges between them.
 */
export const mandateStatusEnum = pgEnum('mandate_status', MANDATE_STATUS);

export const quoteStatusEnum = pgEnum('quote_status', [
  'live',
  'accepted',
  'expired',
  'superseded',
]);

export const tradeStatusEnum = pgEnum('trade_status', [
  'preparing',
  'awaiting_payment',
  'settled',
  'unwound',
  'failed',
]);

// --- parties --------------------------------------------------------------------

export const sellers = pgTable(
  'sellers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    /** May be a wallet made from an email address; the seller never needs to know. */
    hederaAccountId: text('hedera_account_id'),
    arcAddress: text('arc_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('sellers_email_key').on(t.email)],
);

export const buyers = pgTable(
  'buyers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    hederaAccountId: text('hedera_account_id'),
    arcAddress: text('arc_address'),
    /** Set for agent-operated desks. Surfaced as exactly that; fake liquidity is the one
     * thing that would undo the whole argument, so an agent is never disguised as a human. */
    agentPolicy: jsonb('agent_policy').$type<{ capsMinor?: string; label?: string } | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('buyers_email_key').on(t.email)],
);

/**
 * Debtors carry the rating accumulator inline. It is one row per debtor, updated inside
 * the settlement transaction, and every column here is an input to `services/rating.ts`.
 *
 * TODO: add a `settlement_outcomes` ledger keyed on (debtor_id, invoice_id) so a replayed
 * maturity event cannot tighten a rating twice. The counters below are the projection.
 */
export const debtors = pgTable(
  'debtors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Where the confirmation link is sent. No wallet, no signup. */
    email: text('email').notNull(),
    taxId: text('tax_id'),

    rating: ratingEnum('rating').notNull().default('UNRATED'),
    settledOnTime: integer('settled_on_time').notNull().default(0),
    settledLate: integer('settled_late').notNull().default(0),
    defaulted: integer('defaulted').notNull().default(0),
    settledFaceValue: bigint('settled_face_value', { mode: 'bigint' }).notNull().default(0n),
    firstSettlementAt: timestamp('first_settlement_at', { withTimezone: true }),
    lastSettlementAt: timestamp('last_settlement_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('debtors_email_key').on(t.email), index('debtors_rating_idx').on(t.rating)],
);

// --- the book -------------------------------------------------------------------

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => sellers.id),
    debtorId: uuid('debtor_id')
      .notNull()
      .references(() => debtors.id),

    invoiceNumber: text('invoice_number').notNull(),
    faceValue: bigint('face_value', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    /**
     * Becomes the bond's maturity. `initializeMaturity` is one-shot: never edit after
     * issuance.
     */
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    /**
     * `draft` until the customer has been asked to confirm. Tokenisation progress is NOT
     * this column — it is `issuanceState`, which moves independently because issuance is
     * paced and an invoice can be confirmed before its instrument exists.
     */
    status: invoiceStatusEnum('status').notNull().default('draft'),

    /**
     * The uniqueness registry, keyed on hash(debtor, invoice number, amount). One
     * receivable mints exactly one instrument, ever. This is the cheap half of the fraud
     * problem: selling the same receivable to three financiers is the specific fraud
     * factoring has always had, and roughly what broke Greensill.
     */
    uniquenessHash: text('uniqueness_hash').notNull(),

    /** Checksum-valid; ATS `onlyValidISIN` rejects arbitrary strings. */
    isin: text('isin'),
    regulationType: regulationTypeEnum('regulation_type').notNull().default('reg-d-506c'),
    securityId: text('security_id'),
    securityEvmAddress: text('security_evm_address'),

    issuanceState: issuanceStateEnum('issuance_state').notNull().default('queued'),
    issuanceAttempts: integer('issuance_attempts').notNull().default(0),
    issuanceTxId: text('issuance_tx_id'),
    issuanceError: text('issuance_error'),

    /** SHA-256 of the emailed token. The token itself is never stored. */
    confirmationTokenHash: text('confirmation_token_hash'),
    confirmationRequestedAt: timestamp('confirmation_requested_at', { withTimezone: true }),
    confirmationExpiresAt: timestamp('confirmation_expires_at', { withTimezone: true }),
    confirmationDecision: confirmationDecisionEnum('confirmation_decision'),
    confirmationDecidedAt: timestamp('confirmation_decided_at', { withTimezone: true }),
    confirmationNote: text('confirmation_note'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
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
export const mandates = pgTable(
  'mandates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => buyers.id),

    ratingFloor: ratingEnum('rating_floor').notNull(),
    maxTenorDays: integer('max_tenor_days').notNull(),
    annualisedYieldBps: integer('annualised_yield_bps').notNull(),
    currency: char('currency', { length: 3 }).notNull(),

    /** Total exposure ceiling, and the per-debtor concentration cap under it. */
    exposureLimitMinor: bigint('exposure_limit_minor', { mode: 'bigint' }).notNull(),
    perDebtorLimitMinor: bigint('per_debtor_limit_minor', { mode: 'bigint' }),

    /** Escrowed at funding. Unallocated balance = funded - allocated. */
    fundedMinor: bigint('funded_minor', { mode: 'bigint' }).notNull().default(0n),
    allocatedMinor: bigint('allocated_minor', { mode: 'bigint' }).notNull().default(0n),
    escrowRef: text('escrow_ref'),

    status: mandateStatusEnum('status').notNull().default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
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
export const quotes = pgTable(
  'quotes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    mandateId: uuid('mandate_id').references(() => mandates.id),

    ratingAtQuote: ratingEnum('rating_at_quote').notNull(),
    tenorDays: integer('tenor_days').notNull(),
    annualisedYieldBps: integer('annualised_yield_bps').notNull(),
    faceValue: bigint('face_value', { mode: 'bigint' }).notNull(),
    discountMinor: bigint('discount_minor', { mode: 'bigint' }).notNull(),
    proceedsMinor: bigint('proceeds_minor', { mode: 'bigint' }).notNull(),

    status: quoteStatusEnum('status').notNull().default('live'),
    pricedAt: timestamp('priced_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('quotes_invoice_priced_idx').on(t.invoiceId, t.pricedAt)],
);

export const trades = pgTable(
  'trades',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    mandateId: uuid('mandate_id')
      .notNull()
      .references(() => mandates.id),
    quoteId: uuid('quote_id')
      .notNull()
      .references(() => quotes.id),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => sellers.id),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => buyers.id),

    faceValue: bigint('face_value', { mode: 'bigint' }).notNull(),
    proceedsMinor: bigint('proceeds_minor', { mode: 'bigint' }).notNull(),
    annualisedYieldBps: integer('annualised_yield_bps').notNull(),
    tenorDays: integer('tenor_days').notNull(),
    status: tradeStatusEnum('status').notNull().default('preparing'),

    // Asset leg — Hedera. The hold is placed before the cash leg and executed after it.
    holdId: text('hold_id'),
    assetTxId: text('asset_tx_id'),
    assetConsensusAt: timestamp('asset_consensus_at', { withTimezone: true }),

    // Cash leg — x402. `cashTransaction` is the facilitator's settlement reference.
    cashScheme: text('cash_scheme'),
    cashNetwork: text('cash_network'),
    cashAsset: text('cash_asset'),
    cashTransaction: text('cash_transaction'),
    cashPayer: text('cash_payer'),

    /** The pre-match ControlList / Kyc decision, kept verbatim for the proof view. */
    complianceDecision: jsonb('compliance_decision').$type<Record<string, unknown> | null>(),
    complianceCheckedAt: timestamp('compliance_checked_at', { withTimezone: true }),

    /** HCS receipt for the match itself. Checkable without trusting the venue. */
    hcsTopicId: text('hcs_topic_id'),
    hcsSequenceNumber: bigint('hcs_sequence_number', { mode: 'bigint' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
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
export const refusalReceipts = pgTable(
  'refusal_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    mandateId: uuid('mandate_id')
      .notNull()
      .references(() => mandates.id),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => buyers.id),

    /** e.g. `regulation_mismatch`, `rating_below_floor`, `tenor_exceeded`, `exposure_exhausted`. */
    reasonCode: text('reason_code').notNull(),
    /** The sentence the funder actually reads. */
    reasonText: text('reason_text').notNull(),

    ratingAtRefusal: ratingEnum('rating_at_refusal').notNull(),
    tenorDaysAtRefusal: integer('tenor_days_at_refusal').notNull(),

    hcsTopicId: text('hcs_topic_id'),
    hcsSequenceNumber: bigint('hcs_sequence_number', { mode: 'bigint' }),
    hcsConsensusAt: timestamp('hcs_consensus_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('refusals_invoice_idx').on(t.invoiceId),
    index('refusals_mandate_idx').on(t.mandateId),
  ],
);

export type SellerRow = typeof sellers.$inferSelect;
export type BuyerRow = typeof buyers.$inferSelect;
export type DebtorRow = typeof debtors.$inferSelect;
export type InvoiceRow = typeof invoices.$inferSelect;
export type MandateRow = typeof mandates.$inferSelect;
export type QuoteRow = typeof quotes.$inferSelect;
export type TradeRow = typeof trades.$inferSelect;
export type RefusalReceiptRow = typeof refusalReceipts.$inferSelect;
