/**
 * SQLite `Store`, over Drizzle and `better-sqlite3`.
 *
 * ## Why there is no `SELECT … FOR UPDATE` here
 *
 * The Postgres implementation this replaces took a row lock on the mandate in `allocate`,
 * `fundMandate`, `withdrawFromMandate` and `release`, so that two invoices arriving against
 * one mandate serialised and a withdrawal racing a match lost to the match.
 *
 * **Those locks are unnecessary here, not missing.** SQLite has no `FOR UPDATE` and needs
 * none: it admits exactly one writer at a time for the whole database, so the interleaving
 * the row lock existed to prevent — read the balance, have another transaction move it,
 * write a figure derived from the stale read — cannot occur once the read and the write are
 * in one write transaction. Every contended method below is therefore
 * `db.transaction(…, { behavior: 'immediate' })`: `BEGIN IMMEDIATE` takes the write lock on
 * the first statement rather than on the first write, so the read that decides the outcome
 * is already inside the lock. A plain `BEGIN` would start deferred, take a read snapshot,
 * and only then try to upgrade — which under WAL fails as `SQLITE_BUSY_SNAPSHOT` if someone
 * else wrote in between. Do not "restore" the row locks; add the missing transaction.
 *
 * `better-sqlite3` is synchronous, and its transactions cannot contain an `await` — the
 * driver rejects a callback that returns a promise, because the COMMIT would otherwise run
 * before the body finished. So inside `transaction(…)` the queries use Drizzle's sync
 * runners (`.get()`, `.all()`, `.run()`); outside one they are awaited as usual.
 *
 * ## Money never touches SQL arithmetic
 *
 * Amounts are TEXT columns decoded to `bigint` (see `bigintText` in `schema.ts`). SQLite
 * would happily `sum()` them by coercing to a float, which is exactly the precision loss the
 * TEXT column exists to avoid. `debtorExposure` therefore aggregates in JS over `bigint`, and
 * `recordOutcome` increments the accumulator in JS inside its transaction rather than with a
 * `col + ?` expression.
 *
 * ## Uniqueness is still the index, not a pre-check
 *
 * `insertInvoice` leans on the unique index rather than a `SELECT` then `INSERT`. That
 * sequence has a window in which the same receivable can be listed twice, and that window is
 * exactly the fraud the uniqueness registry exists to close.
 */

import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, notInArray, or } from 'drizzle-orm';
import { conflict, duplicateReceivable, notFound } from '../errors.js';
import type { Database } from './index.js';
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
import {
  buyers,
  confirmationRequests,
  debtors,
  indexerCursors,
  invoices,
  issuanceJobs,
  mandates,
  quotes,
  refusalReceipts,
  sellers,
  settlementOutcomes,
  trades,
} from './schema.js';
import type {
  ConfirmationDecisionInput,
  ConfirmationLookup,
  ConfirmationRequestInput,
  DebtorExposureMap,
  FundMandateInput,
  IssuanceJobPatch,
  ListInvoicesCriteria,
  ListMandatesCriteria,
  ListTradesCriteria,
  Page,
  QuoteStatusValue,
  RecordOutcomeInput,
  RecordOutcomeResult,
  Store,
  UpsertDebtorInput,
  WithdrawInput,
  WithdrawResult,
} from './store.js';

/**
 * SQLite reports a violated unique index and a violated primary key under two different
 * extended codes, and both mean the same thing to this layer.
 */
const UNIQUE_VIOLATION_CODES = new Set([
  'SQLITE_CONSTRAINT_UNIQUE',
  'SQLITE_CONSTRAINT_PRIMARYKEY',
]);

/** Drizzle wraps driver errors in `DrizzleQueryError`, so the real code is on `.cause`. */
function isUniqueViolation(err: unknown): boolean {
  let cursor: unknown = err;
  for (let depth = 0; depth < 8 && typeof cursor === 'object' && cursor !== null; depth += 1) {
    const { code, cause } = cursor as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && UNIQUE_VIOLATION_CODES.has(code)) return true;
    if (cause === undefined || cause === cursor) return false;
    cursor = cause;
  }
  return false;
}

/**
 * Exposure counts capital that is committed and has not come back. A trade against an
 * invoice that has matured or defaulted is over — the capital was released, and leaving it
 * in the concentration figure would refuse a debtor the mandate has room for.
 */
const EXPOSING_TRADE_STATUSES = ['preparing', 'awaiting_payment', 'settled'] as const;
const CLOSED_INVOICE_STATUSES = ['matured', 'defaulted'] as const;

/** Every write transaction here reads before it writes. See the header. */
const IMMEDIATE = { behavior: 'immediate' } as const;

/**
 * Runs a synchronous transaction body and hands the result back as a promise.
 *
 * `better-sqlite3` has no async mode: `db.transaction(...)` runs, commits and *throws* at
 * call time. `Store` is an asynchronous interface, so a caller doing
 * `store.allocate(x).catch(...)` -- or collecting several calls into `Promise.allSettled` --
 * must receive a rejected promise rather than an exception thrown out of the expression that
 * built the array. This is the single place that converts, and it is why none of the
 * transactional methods below are `async` themselves.
 */
function asPromise<T>(run: () => T): Promise<T> {
  try {
    return Promise.resolve(run());
  } catch (err) {
    return Promise.reject(err);
  }
}

export class SqliteStore implements Store {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  // --- parties ------------------------------------------------------------------

  async insertSeller(row: NewSellerRow): Promise<SellerRow> {
    const [inserted] = await this.#db.insert(sellers).values(row).returning();
    if (!inserted) throw new Error('insertSeller returned no row');
    return inserted;
  }

  async insertBuyer(row: NewBuyerRow): Promise<BuyerRow> {
    const [inserted] = await this.#db.insert(buyers).values(row).returning();
    if (!inserted) throw new Error('insertBuyer returned no row');
    return inserted;
  }

  async insertDebtor(row: NewDebtorRow): Promise<DebtorRow> {
    const [inserted] = await this.#db.insert(debtors).values(row).returning();
    if (!inserted) throw new Error('insertDebtor returned no row');
    return inserted;
  }

  async getSeller(id: string): Promise<SellerRow | null> {
    const [row] = await this.#db.select().from(sellers).where(eq(sellers.id, id)).limit(1);
    return row ?? null;
  }

  async getBuyer(id: string): Promise<BuyerRow | null> {
    const [row] = await this.#db.select().from(buyers).where(eq(buyers.id, id)).limit(1);
    return row ?? null;
  }

  async upsertDebtor(input: UpsertDebtorInput): Promise<DebtorRow> {
    const email = input.email.trim().toLowerCase();
    const [row] = await this.#db
      .insert(debtors)
      .values({ name: input.name, email, taxId: input.taxId ?? null })
      .onConflictDoUpdate({
        target: debtors.email,
        // Reuse rather than overwrite: the rating accumulator belongs to the debtor, and a
        // seller re-typing a customer's name must not touch anything but the name.
        set: { name: input.name },
      })
      .returning();
    if (!row) throw new Error('upsertDebtor returned no row');
    return row;
  }

  async getDebtor(id: string): Promise<DebtorRow | null> {
    const [row] = await this.#db.select().from(debtors).where(eq(debtors.id, id)).limit(1);
    return row ?? null;
  }

  async updateDebtorRating(id: string, rating: DebtorRow['rating']): Promise<DebtorRow> {
    const [row] = await this.#db
      .update(debtors)
      .set({ rating })
      .where(eq(debtors.id, id))
      .returning();
    if (!row) throw notFound(`Customer ${id}`);
    return row;
  }

  async getDebtors(ids: readonly string[]): Promise<DebtorRow[]> {
    if (ids.length === 0) return [];
    return this.#db
      .select()
      .from(debtors)
      .where(inArray(debtors.id, [...ids]));
  }

  // --- the book -----------------------------------------------------------------

  async insertInvoice(row: NewInvoiceRow): Promise<InvoiceRow> {
    try {
      const [inserted] = await this.#db.insert(invoices).values(row).returning();
      if (!inserted) throw new Error('insertInvoice returned no row');
      return inserted;
    } catch (err) {
      if (isUniqueViolation(err)) throw duplicateReceivable(row.uniquenessHash);
      throw err;
    }
  }

  async getInvoice(id: string): Promise<InvoiceRow | null> {
    const [row] = await this.#db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    return row ?? null;
  }

  async getInvoices(ids: readonly string[]): Promise<InvoiceRow[]> {
    if (ids.length === 0) return [];
    return this.#db
      .select()
      .from(invoices)
      .where(inArray(invoices.id, [...ids]));
  }

  async getInvoiceByUniquenessHash(hash: string): Promise<InvoiceRow | null> {
    const [row] = await this.#db
      .select()
      .from(invoices)
      .where(eq(invoices.uniquenessHash, hash))
      .limit(1);
    return row ?? null;
  }

  async listInvoices(criteria: ListInvoicesCriteria): Promise<Page<InvoiceRow>> {
    const parsed = parseCursor(criteria.cursor);
    const rows = await this.#db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.sellerId, criteria.sellerId),
          criteria.status === undefined ? undefined : eq(invoices.status, criteria.status),
          // The Postgres row-value comparison `(created_at, id) < (…)` spelled out with
          // operators, so Drizzle encodes the `Date` through the column's own mapping
          // rather than binding it raw into a `sql` template, which SQLite cannot take.
          parsed === null
            ? undefined
            : or(
                lt(invoices.createdAt, parsed.createdAt),
                and(eq(invoices.createdAt, parsed.createdAt), lt(invoices.id, parsed.id)),
              ),
        ),
      )
      .orderBy(desc(invoices.createdAt), desc(invoices.id))
      // One extra row answers "is there a next page" without a second count query.
      .limit(criteria.limit + 1);

    const window = rows.slice(0, criteria.limit);
    const last = window.at(-1);
    return {
      rows: window,
      nextCursor: rows.length > criteria.limit && last ? cursorOf(last) : undefined,
    };
  }

  async updateInvoice(id: string, patch: Partial<NewInvoiceRow>): Promise<InvoiceRow> {
    const [row] = await this.#db
      .update(invoices)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(invoices.id, id))
      .returning();
    if (!row) throw notFound(`Invoice ${id}`);
    return row;
  }

  // --- confirmation -------------------------------------------------------------

  requestConfirmation(input: ConfirmationRequestInput): Promise<ConfirmationLookup> {
    return asPromise(() =>
      this.#db.transaction((tx) => {
        const invoice = tx
          .select()
          .from(invoices)
          .where(eq(invoices.id, input.invoiceId))
          .limit(1)
          .get();
        if (!invoice) throw notFound(`Invoice ${input.invoiceId}`);

        // Re-requesting invalidates the previous link, and "invalidates" has to leave a
        // trace or a debtor clicking a stale link gets an unexplained refusal.
        tx.update(confirmationRequests)
          .set({ supersededAt: input.requestedAt })
          .where(
            and(
              eq(confirmationRequests.invoiceId, input.invoiceId),
              isNull(confirmationRequests.decision),
              isNull(confirmationRequests.supersededAt),
            ),
          )
          .run();

        const request = tx
          .insert(confirmationRequests)
          .values({
            invoiceId: input.invoiceId,
            tokenHash: input.tokenHash,
            requestedAt: input.requestedAt,
            expiresAt: input.expiresAt,
          })
          .returning()
          .get();
        if (!request) throw new Error('requestConfirmation returned no row');

        const updated = tx
          .update(invoices)
          .set({
            status: 'awaiting_confirmation',
            confirmationTokenHash: input.tokenHash,
            confirmationRequestedAt: input.requestedAt,
            confirmationExpiresAt: input.expiresAt,
            confirmationDecision: null,
            confirmationDecidedAt: null,
            confirmationNote: null,
            updatedAt: input.requestedAt,
          })
          .where(eq(invoices.id, input.invoiceId))
          .returning()
          .get();
        if (!updated) throw notFound(`Invoice ${input.invoiceId}`);

        return { request, invoice: updated };
      }, IMMEDIATE),
    );
  }

  async findConfirmationByTokenHash(tokenHash: string): Promise<ConfirmationLookup | null> {
    const [row] = await this.#db
      .select({ request: confirmationRequests, invoice: invoices })
      .from(confirmationRequests)
      .innerJoin(invoices, eq(invoices.id, confirmationRequests.invoiceId))
      .where(eq(confirmationRequests.tokenHash, tokenHash))
      .limit(1);
    return row ?? null;
  }

  decideConfirmation(input: ConfirmationDecisionInput): Promise<ConfirmationLookup> {
    return asPromise(() =>
      this.#db.transaction((tx) => {
        // Single-use lives in this WHERE clause: the update matches nothing the second time,
        // so a double-clicked email cannot record two answers.
        const request = tx
          .update(confirmationRequests)
          .set({
            consumedAt: input.at,
            decision: input.decision,
            decidedAt: input.at,
            note: input.note ?? null,
          })
          .where(
            and(
              eq(confirmationRequests.tokenHash, input.tokenHash),
              isNull(confirmationRequests.consumedAt),
            ),
          )
          .returning()
          .get();

        if (!request) {
          const existing: ConfirmationRequestRow | undefined = tx
            .select()
            .from(confirmationRequests)
            .where(eq(confirmationRequests.tokenHash, input.tokenHash))
            .limit(1)
            .get();
          if (!existing) throw notFound('Confirmation link');
          throw conflict('conflict', 'This confirmation link has already been used.');
        }

        const invoice = tx
          .update(invoices)
          .set({
            status: input.decision === 'confirmed' ? 'confirmed' : 'disputed',
            confirmationTokenHash: null,
            confirmationDecision: input.decision,
            confirmationDecidedAt: input.at,
            confirmationNote: input.note ?? null,
            updatedAt: input.at,
          })
          .where(eq(invoices.id, request.invoiceId))
          .returning()
          .get();
        if (!invoice) throw notFound(`Invoice ${request.invoiceId}`);

        return { request, invoice };
      }, IMMEDIATE),
    );
  }

  // --- standing bids ------------------------------------------------------------

  async insertMandate(row: NewMandateRow): Promise<MandateRow> {
    const [inserted] = await this.#db.insert(mandates).values(row).returning();
    if (!inserted) throw new Error('insertMandate returned no row');
    return inserted;
  }

  async getMandate(id: string): Promise<MandateRow | null> {
    const [row] = await this.#db.select().from(mandates).where(eq(mandates.id, id)).limit(1);
    return row ?? null;
  }

  async listMandates(criteria: ListMandatesCriteria): Promise<MandateRow[]> {
    return this.#db
      .select()
      .from(mandates)
      .where(
        and(
          eq(mandates.buyerId, criteria.buyerId),
          criteria.status === undefined ? undefined : eq(mandates.status, criteria.status),
        ),
      )
      .orderBy(desc(mandates.createdAt), desc(mandates.id))
      .limit(criteria.limit);
  }

  async listQuotableMandates(currency: string): Promise<MandateRow[]> {
    return (
      this.#db
        .select()
        .from(mandates)
        .where(and(eq(mandates.status, 'active'), eq(mandates.currency, currency)))
        // Tightest bid first — the smallest discount is the most money for the seller.
        // `annualised_yield_bps` is an INTEGER column, so this ordering is numeric; the
        // money columns are TEXT and must never be sorted or summed in SQL.
        .orderBy(asc(mandates.annualisedYieldBps), asc(mandates.id))
    );
  }

  fundMandate(input: FundMandateInput): Promise<MandateRow> {
    return asPromise(() =>
      this.#db.transaction((tx) => {
        const row = tx
          .select()
          .from(mandates)
          .where(eq(mandates.id, input.mandateId))
          .limit(1)
          .get();
        if (!row) throw notFound(`Mandate ${input.mandateId}`);
        if (row.status === 'withdrawn') {
          throw conflict('conflict', 'A withdrawn mandate cannot be funded; write a new one.');
        }

        const funded = row.fundedMinor + input.amount;
        if (funded > row.exposureLimitMinor) {
          throw conflict(
            'conflict',
            `Funding ${input.amount} would take this mandate to ${funded}, above the ` +
              `${row.exposureLimitMinor} exposure limit it was written with.`,
          );
        }

        const updated = tx
          .update(mandates)
          .set({
            fundedMinor: funded,
            escrowRef: input.escrowRef,
            status: 'active',
            updatedAt: input.at,
          })
          .where(eq(mandates.id, input.mandateId))
          .returning()
          .get();
        if (!updated) throw notFound(`Mandate ${input.mandateId}`);
        return updated;
      }, IMMEDIATE),
    );
  }

  withdrawFromMandate(input: WithdrawInput): Promise<WithdrawResult> {
    return asPromise(() =>
      this.#db.transaction((tx) => {
        const row = tx
          .select()
          .from(mandates)
          .where(eq(mandates.id, input.mandateId))
          .limit(1)
          .get();
        if (!row) throw notFound(`Mandate ${input.mandateId}`);

        const available = max0(row.fundedMinor - row.allocatedMinor);
        const wanted = input.amount ?? available;
        if (wanted > available) {
          throw conflict(
            'insufficient_mandate_balance',
            `This mandate has ${available} unallocated; ${wanted} was requested. Allocated ` +
              'capital is committed against trades in flight and cannot be withdrawn.',
          );
        }

        const funded = row.fundedMinor - wanted;
        const updated = tx
          .update(mandates)
          .set({
            fundedMinor: funded,
            status: funded === 0n ? 'withdrawn' : row.status,
            updatedAt: input.at,
          })
          .where(eq(mandates.id, input.mandateId))
          .returning()
          .get();
        if (!updated) throw notFound(`Mandate ${input.mandateId}`);
        return { mandate: updated, withdrawn: wanted };
      }, IMMEDIATE),
    );
  }

  allocate(mandateId: string, amount: bigint): Promise<MandateRow> {
    return asPromise(() =>
      this.#db.transaction((tx) => {
        const row = tx.select().from(mandates).where(eq(mandates.id, mandateId)).limit(1).get();
        if (!row) throw notFound(`Mandate ${mandateId}`);

        const available = max0(row.fundedMinor - row.allocatedMinor);
        if (amount > available) {
          throw conflict(
            'insufficient_mandate_balance',
            `This mandate has ${available} of committed capital left and the trade needs ${amount}.`,
          );
        }

        const allocated = row.allocatedMinor + amount;
        const updated = tx
          .update(mandates)
          .set({
            allocatedMinor: allocated,
            status: allocated >= row.fundedMinor ? 'exhausted' : row.status,
            updatedAt: new Date(),
          })
          .where(eq(mandates.id, mandateId))
          .returning()
          .get();
        if (!updated) throw notFound(`Mandate ${mandateId}`);
        return updated;
      }, IMMEDIATE),
    );
  }

  release(mandateId: string, amount: bigint): Promise<MandateRow> {
    return asPromise(() =>
      this.#db.transaction((tx) => {
        const row = tx.select().from(mandates).where(eq(mandates.id, mandateId)).limit(1).get();
        if (!row) throw notFound(`Mandate ${mandateId}`);

        const allocated = max0(row.allocatedMinor - amount);
        const updated = tx
          .update(mandates)
          .set({
            allocatedMinor: allocated,
            status:
              row.status === 'exhausted' && allocated < row.fundedMinor ? 'active' : row.status,
            updatedAt: new Date(),
          })
          .where(eq(mandates.id, mandateId))
          .returning()
          .get();
        if (!updated) throw notFound(`Mandate ${mandateId}`);
        return updated;
      }, IMMEDIATE),
    );
  }

  async debtorExposure(mandateIds: readonly string[]): Promise<DebtorExposureMap> {
    const out = new Map<string, Record<string, bigint>>();
    for (const id of mandateIds) out.set(id, {});
    if (mandateIds.length === 0) return out;

    // Still one query for the whole page, never one per mandate — but the rows come back
    // unaggregated and are summed here. `sum()` over a TEXT money column would coerce to a
    // float, which is the precision loss the TEXT column exists to prevent.
    const rows = await this.#db
      .select({
        mandateId: trades.mandateId,
        debtorId: invoices.debtorId,
        committed: trades.proceedsMinor,
      })
      .from(trades)
      .innerJoin(invoices, eq(invoices.id, trades.invoiceId))
      .where(
        and(
          inArray(trades.mandateId, [...mandateIds]),
          inArray(trades.status, [...EXPOSING_TRADE_STATUSES]),
          notInArray(invoices.status, [...CLOSED_INVOICE_STATUSES]),
        ),
      );

    for (const row of rows) {
      const bucket = out.get(row.mandateId) ?? {};
      bucket[row.debtorId] = (bucket[row.debtorId] ?? 0n) + row.committed;
      out.set(row.mandateId, bucket);
    }
    return out;
  }

  // --- quotes, trades, refusals -------------------------------------------------

  async insertQuote(row: NewQuoteRow): Promise<QuoteRow> {
    const [inserted] = await this.#db.insert(quotes).values(row).returning();
    if (!inserted) throw new Error('insertQuote returned no row');
    return inserted;
  }

  async getQuote(id: string): Promise<QuoteRow | null> {
    const [row] = await this.#db.select().from(quotes).where(eq(quotes.id, id)).limit(1);
    return row ?? null;
  }

  async findLiveQuote(invoiceId: string, at: Date): Promise<QuoteRow | null> {
    const [row] = await this.#db
      .select()
      .from(quotes)
      .where(
        and(eq(quotes.invoiceId, invoiceId), eq(quotes.status, 'live'), gt(quotes.expiresAt, at)),
      )
      .orderBy(desc(quotes.pricedAt))
      .limit(1);
    return row ?? null;
  }

  async setQuoteStatus(id: string, status: QuoteStatusValue): Promise<QuoteRow> {
    const [row] = await this.#db
      .update(quotes)
      .set({ status })
      .where(eq(quotes.id, id))
      .returning();
    if (!row) throw notFound(`Quote ${id}`);
    return row;
  }

  async insertTrade(row: NewTradeRow): Promise<TradeRow> {
    const [inserted] = await this.#db.insert(trades).values(row).returning();
    if (!inserted) throw new Error('insertTrade returned no row');
    return inserted;
  }

  async getTrade(id: string): Promise<TradeRow | null> {
    const [row] = await this.#db.select().from(trades).where(eq(trades.id, id)).limit(1);
    return row ?? null;
  }

  async getTradeForInvoice(invoiceId: string): Promise<TradeRow | null> {
    const [row] = await this.#db
      .select()
      .from(trades)
      .where(eq(trades.invoiceId, invoiceId))
      .orderBy(desc(trades.createdAt), desc(trades.id))
      .limit(1);
    return row ?? null;
  }

  async listTrades(criteria: ListTradesCriteria): Promise<TradeRow[]> {
    return this.#db
      .select()
      .from(trades)
      .where(
        and(
          criteria.sellerId === undefined ? undefined : eq(trades.sellerId, criteria.sellerId),
          criteria.buyerId === undefined ? undefined : eq(trades.buyerId, criteria.buyerId),
          criteria.invoiceId === undefined ? undefined : eq(trades.invoiceId, criteria.invoiceId),
          criteria.status === undefined ? undefined : eq(trades.status, criteria.status),
        ),
      )
      .orderBy(desc(trades.createdAt), desc(trades.id))
      .limit(criteria.limit);
  }

  /** Oldest first, unlike every other trade read here — see the interface. */
  async listArmedTradesOlderThan(before: Date, limit: number): Promise<TradeRow[]> {
    return this.#db
      .select()
      .from(trades)
      .where(
        and(
          inArray(trades.status, ['preparing', 'awaiting_payment']),
          lte(trades.createdAt, before),
        ),
      )
      .orderBy(asc(trades.createdAt), asc(trades.id))
      .limit(limit);
  }

  async updateTrade(id: string, patch: Partial<NewTradeRow>): Promise<TradeRow> {
    const [row] = await this.#db.update(trades).set(patch).where(eq(trades.id, id)).returning();
    if (!row) throw notFound(`Trade ${id}`);
    return row;
  }

  async insertRefusals(rows: readonly NewRefusalReceiptRow[]): Promise<RefusalReceiptRow[]> {
    if (rows.length === 0) return [];
    return this.#db
      .insert(refusalReceipts)
      .values([...rows])
      .returning();
  }

  async listRefusalsForInvoice(invoiceId: string): Promise<RefusalReceiptRow[]> {
    return this.#db
      .select()
      .from(refusalReceipts)
      .where(eq(refusalReceipts.invoiceId, invoiceId))
      .orderBy(desc(refusalReceipts.createdAt), desc(refusalReceipts.id));
  }

  // --- ratings ------------------------------------------------------------------

  recordOutcome(input: RecordOutcomeInput): Promise<RecordOutcomeResult> {
    return asPromise(() =>
      this.#db.transaction((tx) => {
        const inserted = tx
          .insert(settlementOutcomes)
          .values({
            debtorId: input.debtorId,
            invoiceId: input.invoiceId,
            outcome: input.outcome,
            faceValue: input.faceValue,
            occurredAt: input.at,
          })
          // Idempotency is the unique index, not a pre-check: maturity can be observed twice
          // and a rating may only move once per receivable.
          .onConflictDoNothing({
            target: [settlementOutcomes.debtorId, settlementOutcomes.invoiceId],
          })
          .returning()
          .all();

        const current = tx
          .select()
          .from(debtors)
          .where(eq(debtors.id, input.debtorId))
          .limit(1)
          .get();
        if (!current) throw notFound(`Customer ${input.debtorId}`);

        if (inserted.length === 0) return { debtor: current, alreadyRecorded: true };

        // The accumulator moves in JS, not in SQL. `settled_face_value` is a TEXT money
        // column and `col + ?` would make SQLite do float arithmetic on it. Safe to
        // read-then-write: this transaction already holds the write lock.
        const debtor = tx
          .update(debtors)
          .set({
            settledOnTime: current.settledOnTime + (input.outcome === 'on_time' ? 1 : 0),
            settledLate: current.settledLate + (input.outcome === 'late' ? 1 : 0),
            defaulted: current.defaulted + (input.outcome === 'default' ? 1 : 0),
            settledFaceValue:
              current.settledFaceValue + (input.outcome === 'default' ? 0n : input.faceValue),
            firstSettlementAt: current.firstSettlementAt ?? input.at,
            lastSettlementAt: input.at,
          })
          .where(eq(debtors.id, input.debtorId))
          .returning()
          .get();
        if (!debtor) throw notFound(`Customer ${input.debtorId}`);

        return { debtor, alreadyRecorded: false };
      }, IMMEDIATE),
    );
  }

  // --- issuance and indexing ----------------------------------------------------

  async saveIssuanceJob(patch: IssuanceJobPatch): Promise<IssuanceJobRow> {
    const values = {
      invoiceId: patch.invoiceId,
      state: patch.state,
      attempts: patch.attempts,
      startedAt: patch.startedAt ?? null,
      completedAt: patch.completedAt ?? null,
      nextAttemptAt: patch.nextAttemptAt ?? null,
      lastError: patch.lastError ?? null,
    };
    const [row] = await this.#db
      .insert(issuanceJobs)
      .values(values)
      .onConflictDoUpdate({ target: issuanceJobs.invoiceId, set: values })
      .returning();
    if (!row) throw new Error('saveIssuanceJob returned no row');
    return row;
  }

  async listUnfinishedIssuanceJobs(): Promise<IssuanceJobRow[]> {
    return this.#db
      .select()
      .from(issuanceJobs)
      .where(inArray(issuanceJobs.state, ['queued', 'issuing']))
      .orderBy(asc(issuanceJobs.queuedAt));
  }

  async getCursor(chain: string): Promise<string | null> {
    const [row] = await this.#db
      .select()
      .from(indexerCursors)
      .where(eq(indexerCursors.chain, chain))
      .limit(1);
    return row?.cursor ?? null;
  }

  async setCursor(chain: string, position: string): Promise<void> {
    await this.#db
      .insert(indexerCursors)
      .values({ chain, cursor: position })
      .onConflictDoUpdate({
        target: indexerCursors.chain,
        set: { cursor: position, updatedAt: new Date() },
      });
  }
}

export const createSqliteStore = (db: Database): SqliteStore => new SqliteStore(db);

const max0 = (v: bigint): bigint => (v > 0n ? v : 0n);

const cursorOf = (row: { createdAt: Date; id: string }): string =>
  `${row.createdAt.toISOString()}|${row.id}`;

function parseCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (cursor === undefined) return null;
  const at = cursor.indexOf('|');
  if (at < 0) return null;
  const createdAt = new Date(cursor.slice(0, at));
  const id = cursor.slice(at + 1);
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) return null;
  return { createdAt, id };
}
