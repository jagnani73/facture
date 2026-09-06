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
  SettlementOutcomeRow,
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
  /**
   * Whether this funding may make the bid firm — i.e. whether the mandate lands in `active`
   * or stops at `funding`.
   *
   * The store never asks a chain, so the caller answers it. `services/arc.ts` is where the
   * question is decided (`backingMakesBidFirm`), and it is deliberately NOT the same question
   * as "is the capital escrowed": a deployment with no vault has nothing to verify and goes
   * firm anyway, while a vault that could not be read does not.
   */
  readonly firm: boolean;
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
  /**
   * The outcome that actually stands on the ledger for this receivable — the one this call
   * wrote, or the one that was already there.
   *
   * Without it `alreadyRecorded` is the only thing a caller learns from a conflict, and
   * "some outcome exists" is not enough to tell a replayed default from a default landing
   * on top of a payment. Those two look identical from outside and one of them is the
   * ledger being contradicted, so declaring a default has to be able to see which it is
   * before it moves the invoice. `settlement_outcomes` had no reader at all until this.
   */
  readonly recorded: SettlementOutcome;
  /**
   * When the settlement the ledger holds actually happened — the debtor's payment date for
   * `on_time` / `late`, the moment of declaration for a `default`.
   *
   * From the row that WON, so on a replay it is the first call's date and not this one's.
   * Without it a receipt reported the outcome off the ledger beside a date echoed from the
   * request, which is how a replay came to answer `on_time` next to a `paidAt` that would
   * have produced `late` — the one pairing the field exists to make checkable.
   */
  readonly occurredAt: Date;
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
  /**
   * Take capital off the book. **It does not close the mandate**, even when the book reaches
   * zero — see {@link Store.closeEmptiedMandate}.
   */
  withdrawFromMandate(input: WithdrawInput): Promise<WithdrawResult>;
  /**
   * Close a mandate whose book is empty, permanently.
   *
   * Separate from the withdrawal because `withdrawn` is terminal and `fundMandate` refuses a
   * withdrawn mandate, so closing one is what makes any capital still sitting in the Arc vault
   * unreachable: a replacement mandate is a new UUID and therefore a new vault bucket. The
   * caller closes only once the money's whereabouts are settled.
   *
   * Refuses a mandate that still has capital on the book, and answers the row unchanged when it
   * is already closed.
   */
  closeEmptiedMandate(mandateId: string, at: Date): Promise<MandateRow>;
  /** Reserve against the unallocated balance. Fails if the balance moved underneath. */
  allocate(mandateId: string, amount: MinorUnits): Promise<MandateRow>;
  /** Give capacity back after an unwind or a maturity. Clamped at zero. */
  release(mandateId: string, amount: MinorUnits): Promise<MandateRow>;
  /**
   * Give the allocation back AND retire the committed capital that paid for it.
   *
   * **The Arc rail's maturity, where {@link Store.release} alone is the x402 rail's.** A trade
   * settled out of `MandateVault` is paid with the mandate's escrowed USDC — `executePayout`
   * debits the vault — and nothing here ever decremented `fundedMinor` for it. So after settle
   * then mature the book stood at its full committed total while the vault was short by the
   * proceeds, every withdrawal against it was refused as `insufficient`, and the mandate quoted
   * capital that had already left. On the x402 rail the buyer pays in their own HBAR and the
   * vault is untouched, so `release` is right there and this would be wrong.
   *
   * Both figures fall by the same amount, which leaves the unallocated balance where it was:
   * the money did not come back to the mandate, it went to the seller.
   */
  retireAllocatedCapital(mandateId: string, amount: MinorUnits): Promise<MandateRow>;
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
  /**
   * Attach the consensus coordinates once a receipt's commitment is on the topic.
   *
   * Separate from the insert because the two happen at different times and only the first
   * one is owed to the funder: the reason is recorded immediately, and the independently
   * checkable copy lands when consensus does. See `services/hcs.ts`.
   */
  recordRefusalConsensus(
    id: string,
    consensus: { topicId: string; sequenceNumber: bigint; consensusAt: Date },
  ): Promise<RefusalReceiptRow>;
  listRefusalsForInvoice(invoiceId: string): Promise<RefusalReceiptRow[]>;

  // --- ratings ------------------------------------------------------------------
  /** Idempotent per (debtor, invoice): a replayed maturity cannot tighten a rating twice. */
  recordOutcome(input: RecordOutcomeInput): Promise<RecordOutcomeResult>;
  /**
   * The settlement already on the ledger for one receivable, or `null` if there is none.
   *
   * The read half of `recordOutcome`, and the thing that distinguishes **recording a new
   * settlement** from **reading back one already recorded**. Maturity refuses to guess an
   * on-time/late call for a past-due receivable with no stated payment date — a refusal that
   * is right for a first write and wrong for a replay, which decides nothing and must
   * succeed whatever the clock says. Only the ledger can tell those two apart: the invoice's
   * own status cannot, because a row can carry `matured` or `defaulted` with nothing behind
   * it on the ledger, and the seeded book contains exactly that.
   */
  getOutcome(debtorId: string, invoiceId: string): Promise<SettlementOutcomeRow | null>;

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
