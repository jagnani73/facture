/**
 * The persistence seam.
 *
 * Everything in `routes/` and `services/` reads and writes through this interface, and
 * there are two implementations: `sqlite-store.ts` (Drizzle over `better-sqlite3`, what
 * runs) and `memory-store.ts` (what the tests run against). The seam is not indirection for
 * its own sake — it is the reason the orchestration in the routes is real, exercised code
 * rather than something that first executes on a stage with a database behind it. It is
 * also why the engine underneath is a decision and not a commitment: a Postgres
 * implementation was deleted here rather than carried, and can come back as one file.
 *
 * Two rules the interface enforces on both implementations:
 *
 * - **Money in and out is `bigint` minor units.** No implementation may hand back a
 *   `number` for an amount. `src/wire.ts` owns the string boundary; nothing below it does.
 * - **Contended writes are atomic.** `fundMandate`, `withdrawFromMandate`, `allocate`,
 *   `decideConfirmation` and `recordOutcome` are single operations here precisely because
 *   read-modify-write across two calls is where a withdrawal races a match. The SQLite
 *   implementation puts each in one `BEGIN IMMEDIATE` transaction, which is a whole-database
 *   write lock and so needs no row lock; the in-memory one is single-threaded by
 *   construction.
 */

import type { MinorUnits } from '@facture/shared';
import type { SettlementOutcome } from '../services/rating.js';
import type {
  BuyerRow,
  ConfirmationRequestRow,
  DebtorRow,
  InvoiceRow,
  IssuanceJobRow,
  MandateRow,
  NewBuyerRow,
  NewDebtorRow,
  NewInvoiceRow,
  NewMandateRow,
  NewQuoteRow,
  NewRefusalReceiptRow,
  NewSellerRow,
  NewTradeRow,
  QuoteRow,
  RefusalReceiptRow,
  SellerRow,
  TradeRow,
} from './schema.js';

export type InvoiceStatusValue = InvoiceRow['status'];
export type RatingValue = DebtorRow['rating'];
export type MandateStatusValue = MandateRow['status'];
export type TradeStatusValue = TradeRow['status'];
export type QuoteStatusValue = QuoteRow['status'];
export type IssuanceStateValue = IssuanceJobRow['state'];

export interface Page<T> {
  readonly rows: readonly T[];
  /** Opaque keyset cursor; absent when this is the last page. */
  readonly nextCursor: string | undefined;
}

export interface ListInvoicesCriteria {
  readonly sellerId: string;
  readonly status?: InvoiceStatusValue | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface ListMandatesCriteria {
  readonly buyerId: string;
  readonly status?: MandateStatusValue | undefined;
  readonly limit: number;
}

export interface ListTradesCriteria {
  readonly sellerId?: string | undefined;
  readonly buyerId?: string | undefined;
  /**
   * Scopes the read to one receivable. Maturity needs every settled trade on an invoice
   * and nothing else — filtering a page of the whole book in memory finds the current
   * holder only while the book is small enough to fit in that page.
   */
  readonly invoiceId?: string | undefined;
  readonly status?: TradeStatusValue | undefined;
  readonly limit: number;
}

export interface UpsertDebtorInput {
  readonly name: string;
  readonly email: string;
  readonly taxId?: string | undefined;
}

export interface ConfirmationRequestInput {
  readonly invoiceId: string;
  /** SHA-256 of the emailed token. The token itself never reaches this layer. */
  readonly tokenHash: string;
  readonly requestedAt: Date;
  readonly expiresAt: Date;
}

export interface ConfirmationLookup {
  readonly request: ConfirmationRequestRow;
  readonly invoice: InvoiceRow;
}

export interface ConfirmationDecisionInput {
  readonly tokenHash: string;
  readonly decision: 'confirmed' | 'disputed';
  readonly note?: string | undefined;
  readonly at: Date;
}

export interface FundMandateInput {
  readonly mandateId: string;
  readonly amount: MinorUnits;
  readonly escrowRef: string;
  readonly at: Date;
}

export interface WithdrawInput {
  readonly mandateId: string;
  /** Absent withdraws the whole unallocated balance. Allocated capital never moves. */
  readonly amount?: MinorUnits | undefined;
  readonly at: Date;
}

export interface WithdrawResult {
  readonly mandate: MandateRow;
  readonly withdrawn: MinorUnits;
}

export interface RecordOutcomeInput {
  readonly debtorId: string;
  readonly invoiceId: string;
  readonly outcome: SettlementOutcome;
  readonly faceValue: MinorUnits;
  readonly at: Date;
}

export interface RecordOutcomeResult {
  readonly debtor: DebtorRow;
  /**
   * True when this receivable had already been recorded, so nothing changed. Maturity can
   * be observed twice; a rating may only move once per receivable.
   */
  readonly alreadyRecorded: boolean;
}

export interface IssuanceJobPatch {
  readonly invoiceId: string;
  readonly state: IssuanceStateValue;
  readonly attempts: number;
  readonly startedAt?: Date | null | undefined;
  readonly completedAt?: Date | null | undefined;
  readonly nextAttemptAt?: Date | null | undefined;
  readonly lastError?: string | null | undefined;
}

/** Per-mandate, per-debtor committed exposure. Missing key means zero. */
export type DebtorExposureMap = ReadonlyMap<string, Readonly<Record<string, MinorUnits>>>;

export interface Store {
  // --- parties ------------------------------------------------------------------
  /*
   * `insertBuyer` still has no route behind it — a funder is onboarded by hand and stated
   * as such. Sellers now have one: `POST /v1/sellers`, which is how a wallet made from an
   * email address gets recorded against the business it belongs to. These exist so
   * `seed.ts` can fill either implementation from one script, and so a party can be created
   * with its accumulator intact rather than only through `upsertDebtor`, which deliberately
   * refuses to touch a rating.
   */
  insertSeller(row: NewSellerRow): Promise<SellerRow>;
  insertBuyer(row: NewBuyerRow): Promise<BuyerRow>;
  insertDebtor(row: NewDebtorRow): Promise<DebtorRow>;
  getSeller(id: string): Promise<SellerRow | null>;
  /**
   * By email, which is the seller's identity rather than a convenience lookup: the column
   * carries a unique index, and signing in with an email address is the only way a seller
   * is identified at all. Normalised the way `upsertDebtor` normalises — trimmed and
   * lowercased — so `Ada@example.com` and `ada@example.com` cannot become two businesses.
   */
  getSellerByEmail(email: string): Promise<SellerRow | null>;
  /**
   * Record the wallet addresses for a seller that had none.
   *
   * Deliberately not an overwrite. See `routes/sellers.ts`: rebinding an address that is
   * already set is how a seller's money would be redirected, and nothing authenticates the
   * caller here.
   */
  updateSellerWallet(
    id: string,
    wallet: { hederaAccountId?: string | null; arcAddress?: string | null },
  ): Promise<SellerRow>;
  getBuyer(id: string): Promise<BuyerRow | null>;
  /** Ratings are per debtor, so an existing email is reused rather than duplicated. */
  upsertDebtor(input: UpsertDebtorInput): Promise<DebtorRow>;
  getDebtor(id: string): Promise<DebtorRow | null>;
  getDebtors(ids: readonly string[]): Promise<DebtorRow[]>;
  /**
   * Refresh the stored grade. It is a projection of the accumulator, recomputed by
   * `services/rating.ts` rather than incremented alongside the counters, so it cannot
   * drift from the ladder that produces it.
   */
  updateDebtorRating(id: string, rating: RatingValue): Promise<DebtorRow>;

  // --- the book -----------------------------------------------------------------
  /** Throws `duplicateReceivable` when the uniqueness hash is already registered. */
  insertInvoice(row: NewInvoiceRow): Promise<InvoiceRow>;
  getInvoice(id: string): Promise<InvoiceRow | null>;
  getInvoices(ids: readonly string[]): Promise<InvoiceRow[]>;
  getInvoiceByUniquenessHash(hash: string): Promise<InvoiceRow | null>;
  listInvoices(criteria: ListInvoicesCriteria): Promise<Page<InvoiceRow>>;
  updateInvoice(id: string, patch: Partial<NewInvoiceRow>): Promise<InvoiceRow>;

  // --- confirmation -------------------------------------------------------------
  /** Supersedes any open request for the invoice, in the same transaction. */
  requestConfirmation(input: ConfirmationRequestInput): Promise<ConfirmationLookup>;
  findConfirmationByTokenHash(tokenHash: string): Promise<ConfirmationLookup | null>;
  /** Single-use: consumes the token and writes the decision atomically. */
  decideConfirmation(input: ConfirmationDecisionInput): Promise<ConfirmationLookup>;

  // --- standing bids ------------------------------------------------------------
  insertMandate(row: NewMandateRow): Promise<MandateRow>;
  getMandate(id: string): Promise<MandateRow | null>;
  listMandates(criteria: ListMandatesCriteria): Promise<MandateRow[]>;
  /**
   * Every mandate that could plausibly quote: funded and active, in this currency.
   * Deliberately over-fetches — the near-misses are what `bestQuote` explains.
   */
  listQuotableMandates(currency: string): Promise<MandateRow[]>;
  fundMandate(input: FundMandateInput): Promise<MandateRow>;
  withdrawFromMandate(input: WithdrawInput): Promise<WithdrawResult>;
  /** Reserve against the unallocated balance. Fails if the balance moved underneath. */
  allocate(mandateId: string, amount: MinorUnits): Promise<MandateRow>;
  /** Give capacity back after an unwind or a maturity. Clamped at zero. */
  release(mandateId: string, amount: MinorUnits): Promise<MandateRow>;
  /** One aggregate for a page of mandates, never one query per mandate. */
  debtorExposure(mandateIds: readonly string[]): Promise<DebtorExposureMap>;

  // --- quotes, trades, refusals -------------------------------------------------
  insertQuote(row: NewQuoteRow): Promise<QuoteRow>;
  getQuote(id: string): Promise<QuoteRow | null>;
  /**
   * The newest unexpired `live` quote for an invoice, if there is one.
   *
   * The quote route is safe to poll, so a row per poll would be a write per refresh of the
   * product's main screen. An identical quote is reused instead, and only a quote that has
   * actually moved writes a new row.
   */
  findLiveQuote(invoiceId: string, at: Date): Promise<QuoteRow | null>;
  setQuoteStatus(id: string, status: QuoteStatusValue): Promise<QuoteRow>;

  insertTrade(row: NewTradeRow): Promise<TradeRow>;
  getTrade(id: string): Promise<TradeRow | null>;
  getTradeForInvoice(invoiceId: string): Promise<TradeRow | null>;
  listTrades(criteria: ListTradesCriteria): Promise<TradeRow[]>;
  /**
   * Trades still armed — `preparing` or `awaiting_payment` — created at or before
   * `before`, oldest first.
   *
   * The read behind expiry. An armed trade holds mandate capital and encumbers the
   * seller's position, so one whose challenge window has passed has to be findable without
   * scanning the book: `before` is the arming time the window has already run out from.
   * Oldest first so a backlog is worked off in the order it accumulated.
   */
  listArmedTradesOlderThan(before: Date, limit: number): Promise<TradeRow[]>;
  updateTrade(id: string, patch: Partial<NewTradeRow>): Promise<TradeRow>;

  insertRefusals(rows: readonly NewRefusalReceiptRow[]): Promise<RefusalReceiptRow[]>;
  listRefusalsForInvoice(invoiceId: string): Promise<RefusalReceiptRow[]>;

  // --- ratings ------------------------------------------------------------------
  /** Idempotent per (debtor, invoice): a replayed maturity cannot tighten a rating twice. */
  recordOutcome(input: RecordOutcomeInput): Promise<RecordOutcomeResult>;

  // --- issuance and indexing ----------------------------------------------------
  saveIssuanceJob(patch: IssuanceJobPatch): Promise<IssuanceJobRow>;
  listUnfinishedIssuanceJobs(): Promise<IssuanceJobRow[]>;
  /**
   * Every invoice the book is currently showing as being added.
   *
   * Driven off `invoices.issuance_state` rather than the job table, because that column is
   * what a page of the book renders and is therefore what a seller is actually being told.
   * The two can disagree — a seeded row carries the projection with no job behind it — and in
   * that disagreement the projection is the one with a person looking at it.
   */
  listInvoicesAwaitingIssuance(limit?: number): Promise<InvoiceRow[]>;
  getCursor(chain: string): Promise<string | null>;
  setCursor(chain: string, position: string): Promise<void>;
}

let active: Store | undefined;
let factory: (() => Store) | undefined;

/**
 * Registers how to build the production store. Called from the entrypoint so that
 * importing a route does not open the database file — the health check and every unit test
 * need the module graph without one.
 */
export function setStoreFactory(build: () => Store): void {
  factory = build;
  active = undefined;
}

/** Replaces the store outright. Tests use this; nothing in `src/` should. */
export function setStore(store: Store | undefined): void {
  active = store;
}

export function getStore(): Store {
  if (active) return active;
  if (!factory) {
    throw new Error('Store accessed before setStoreFactory() — call it first in the entrypoint.');
  }
  active = factory();
  return active;
}
