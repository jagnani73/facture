/**
 * Postgres `Store`, over Drizzle.
 *
 * Every method that can be raced is one statement or one transaction, never a read
 * followed by a write from application code. The three that matter:
 *
 * - `allocate` takes `SELECT … FOR UPDATE` on the mandate and re-checks the unallocated
 *   balance inside the lock, so two invoices arriving against one mandate serialise.
 * - `withdrawFromMandate` takes the same lock, which is what makes a withdrawal racing a
 *   match lose to the match rather than the other way round. That ordering is what "firm"
 *   means: capital a buyer has already been matched against is not theirs to pull.
 * - `decideConfirmation` consumes the token in the statement that writes the decision, so
 *   a double-clicked email cannot record two answers.
 *
 * `insertInvoice` leans on the unique index rather than a pre-check. A `SELECT` then
 * `INSERT` has a window in which the same receivable can be listed twice, and that window
 * is exactly the fraud the uniqueness registry exists to close.
 */

import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { conflict, duplicateReceivable, notFound } from '../errors.js';
import type { Database } from './index.js';
import type {
  BuyerRow,
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

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'code' in err && err.code === UNIQUE_VIOLATION;

/**
 * Exposure counts capital that is committed and has not come back. A trade against an
 * invoice that has matured or defaulted is over — the capital was released, and leaving it
 * in the concentration figure would refuse a debtor the mandate has room for.
 */
const EXPOSING_TRADE_STATUSES = ['preparing', 'awaiting_payment', 'settled'] as const;
const CLOSED_INVOICE_STATUSES = ['matured', 'defaulted'] as const;

export class PgStore implements Store {
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
          parsed === null
            ? undefined
            : sql`(${invoices.createdAt}, ${invoices.id}) < (${parsed.createdAt}, ${parsed.id})`,
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

  async requestConfirmation(input: ConfirmationRequestInput): Promise<ConfirmationLookup> {
    return this.#db.transaction(async (tx) => {
      const [invoice] = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, input.invoiceId))
        .for('update')
        .limit(1);
      if (!invoice) throw notFound(`Invoice ${input.invoiceId}`);

      // Re-requesting invalidates the previous link, and "invalidates" has to leave a
      // trace or a debtor clicking a stale link gets an unexplained refusal.
      await tx
        .update(confirmationRequests)
        .set({ supersededAt: input.requestedAt })
        .where(
          and(
            eq(confirmationRequests.invoiceId, input.invoiceId),
            isNull(confirmationRequests.decision),
            isNull(confirmationRequests.supersededAt),
          ),
        );

      const [request] = await tx
        .insert(confirmationRequests)
        .values({
          invoiceId: input.invoiceId,
          tokenHash: input.tokenHash,
          requestedAt: input.requestedAt,
          expiresAt: input.expiresAt,
        })
        .returning();
      if (!request) throw new Error('requestConfirmation returned no row');

      const [updated] = await tx
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
        .returning();
      if (!updated) throw notFound(`Invoice ${input.invoiceId}`);

      return { request, invoice: updated };
    });
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

  async decideConfirmation(input: ConfirmationDecisionInput): Promise<ConfirmationLookup> {
    return this.#db.transaction(async (tx) => {
      // Single-use lives in this WHERE clause: the update matches nothing the second time,
      // so a double-clicked email cannot record two answers.
      const [request] = await tx
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
        .returning();

      if (!request) {
        const existing = await this.findConfirmationByTokenHash(input.tokenHash);
        if (!existing) throw notFound('Confirmation link');
        throw conflict('conflict', 'This confirmation link has already been used.');
      }

      const [invoice] = await tx
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
        .returning();
      if (!invoice) throw notFound(`Invoice ${request.invoiceId}`);

      return { request, invoice };
    });
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
        .orderBy(mandates.annualisedYieldBps, mandates.id)
    );
  }

  async fundMandate(input: FundMandateInput): Promise<MandateRow> {
    return this.#db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(mandates)
        .where(eq(mandates.id, input.mandateId))
        .for('update')
        .limit(1);
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

      const [updated] = await tx
        .update(mandates)
        .set({
          fundedMinor: funded,
          escrowRef: input.escrowRef,
          status: 'active',
          updatedAt: input.at,
        })
        .where(eq(mandates.id, input.mandateId))
        .returning();
      if (!updated) throw notFound(`Mandate ${input.mandateId}`);
      return updated;
    });
  }

  async withdrawFromMandate(input: WithdrawInput): Promise<WithdrawResult> {
    return this.#db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(mandates)
        .where(eq(mandates.id, input.mandateId))
        .for('update')
        .limit(1);
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
      const [updated] = await tx
        .update(mandates)
        .set({
          fundedMinor: funded,
          status: funded === 0n ? 'withdrawn' : row.status,
          updatedAt: input.at,
        })
        .where(eq(mandates.id, input.mandateId))
        .returning();
      if (!updated) throw notFound(`Mandate ${input.mandateId}`);
      return { mandate: updated, withdrawn: wanted };
    });
  }

  async allocate(mandateId: string, amount: bigint): Promise<MandateRow> {
    return this.#db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(mandates)
        .where(eq(mandates.id, mandateId))
        .for('update')
        .limit(1);
      if (!row) throw notFound(`Mandate ${mandateId}`);

      const available = max0(row.fundedMinor - row.allocatedMinor);
      if (amount > available) {
        throw conflict(
          'insufficient_mandate_balance',
          `This mandate has ${available} of committed capital left and the trade needs ${amount}.`,
        );
      }

      const allocated = row.allocatedMinor + amount;
      const [updated] = await tx
        .update(mandates)
        .set({
          allocatedMinor: allocated,
          status: allocated >= row.fundedMinor ? 'exhausted' : row.status,
          updatedAt: new Date(),
        })
        .where(eq(mandates.id, mandateId))
        .returning();
      if (!updated) throw notFound(`Mandate ${mandateId}`);
      return updated;
    });
  }

  async release(mandateId: string, amount: bigint): Promise<MandateRow> {
    return this.#db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(mandates)
        .where(eq(mandates.id, mandateId))
        .for('update')
        .limit(1);
      if (!row) throw notFound(`Mandate ${mandateId}`);

      const allocated = max0(row.allocatedMinor - amount);
      const [updated] = await tx
        .update(mandates)
        .set({
          allocatedMinor: allocated,
          status: row.status === 'exhausted' && allocated < row.fundedMinor ? 'active' : row.status,
          updatedAt: new Date(),
        })
        .where(eq(mandates.id, mandateId))
        .returning();
      if (!updated) throw notFound(`Mandate ${mandateId}`);
      return updated;
    });
  }

  async debtorExposure(mandateIds: readonly string[]): Promise<DebtorExposureMap> {
    const out = new Map<string, Record<string, bigint>>();
    for (const id of mandateIds) out.set(id, {});
    if (mandateIds.length === 0) return out;

    const rows = await this.#db
      .select({
        mandateId: trades.mandateId,
        debtorId: invoices.debtorId,
        committed: sql<string>`sum(${trades.proceedsMinor})`,
      })
      .from(trades)
      .innerJoin(invoices, eq(invoices.id, trades.invoiceId))
      .where(
        and(
          inArray(trades.mandateId, [...mandateIds]),
          inArray(trades.status, [...EXPOSING_TRADE_STATUSES]),
          sql`${invoices.status} not in ${CLOSED_INVOICE_STATUSES}`,
        ),
      )
      .groupBy(trades.mandateId, invoices.debtorId);

    for (const row of rows) {
      const bucket = out.get(row.mandateId) ?? {};
      // `sum()` comes back as a string from postgres.js — numeric, not bigint — so it is
      // parsed here rather than being allowed to reach the money path as anything else.
      bucket[row.debtorId] = BigInt(row.committed);
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
          criteria.status === undefined ? undefined : eq(trades.status, criteria.status),
        ),
      )
      .orderBy(desc(trades.createdAt), desc(trades.id))
      .limit(criteria.limit);
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

  async recordOutcome(input: RecordOutcomeInput): Promise<RecordOutcomeResult> {
    return this.#db.transaction(async (tx) => {
      const inserted = await tx
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
        .returning();

      if (inserted.length === 0) {
        const [existing] = await tx
          .select()
          .from(debtors)
          .where(eq(debtors.id, input.debtorId))
          .limit(1);
        if (!existing) throw notFound(`Customer ${input.debtorId}`);
        return { debtor: existing, alreadyRecorded: true };
      }

      const [debtor] = await tx
        .update(debtors)
        .set({
          settledOnTime: sql`${debtors.settledOnTime} + ${input.outcome === 'on_time' ? 1 : 0}`,
          settledLate: sql`${debtors.settledLate} + ${input.outcome === 'late' ? 1 : 0}`,
          defaulted: sql`${debtors.defaulted} + ${input.outcome === 'default' ? 1 : 0}`,
          settledFaceValue: sql`${debtors.settledFaceValue} + ${
            input.outcome === 'default' ? 0n : input.faceValue
          }`,
          firstSettlementAt: sql`coalesce(${debtors.firstSettlementAt}, ${input.at})`,
          lastSettlementAt: input.at,
        })
        .where(eq(debtors.id, input.debtorId))
        .returning();
      if (!debtor) throw notFound(`Customer ${input.debtorId}`);

      return { debtor, alreadyRecorded: false };
    });
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
      .orderBy(issuanceJobs.queuedAt);
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

export const createPgStore = (db: Database): PgStore => new PgStore(db);

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
