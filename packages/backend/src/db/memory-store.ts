/**
 * In-memory `Store`.
 *
 * Two jobs, and the second is why it lives in `src/` rather than `test/`:
 *
 * 1. **Tests run against it.** There is no Postgres in CI here, and a route handler that
 *    has never executed is not implemented, only written. Every route in this service is
 *    exercised end to end against this store.
 * 2. **The demo book runs against it.** `db/seed.ts` fills either implementation, so
 *    `DATABASE_URL` pointing at nothing is a degraded mode rather than a dead service.
 *
 * It is deliberately a faithful implementation rather than a convenient one: the same
 * clamping, the same idempotency on `recordOutcome`, the same "withdrawal loses to an
 * allocation" ordering, the same duplicate-receivable rejection. A fake that is easier to
 * satisfy than the real thing tests nothing.
 *
 * Single-threaded by construction, so the atomicity the interface promises is free here.
 */

import { conflict, duplicateReceivable, notFound } from '../errors.js';
import type {
  BuyerRow,
  ConfirmationRequestRow,
  DebtorRow,
  IndexerCursorRow,
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
import {
  fundingHops,
  statusAfterAllocate,
  statusAfterRelease,
  statusAfterWithdraw,
  transitionTo,
  walkMandateStatus,
} from './status.js';
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
 * Exposure counts capital that is committed and has not come back yet. A trade whose
 * invoice has matured or defaulted is over; the capital was released and must not keep
 * consuming the mandate's concentration headroom.
 */
const EXPOSING_TRADE_STATUSES = new Set<TradeRow['status']>([
  'preparing',
  'awaiting_payment',
  'settled',
]);
const CLOSED_INVOICE_STATUSES = new Set<InvoiceRow['status']>(['matured', 'defaulted']);

/**
 * Armed but not finished: capital reserved, hold placed or about to be, nothing settled.
 * These are the trades a challenge window can expire out from under.
 */
const ARMED_TRADE_STATUSES = new Set<TradeRow['status']>(['preparing', 'awaiting_payment']);

const clone = <T>(value: T): T => ({ ...value }) as T;

/** Deterministic ids keep a seeded book reproducible across runs. */
export interface MemoryStoreOptions {
  readonly newId?: () => string;
  readonly now?: () => Date;
}

export class MemoryStore implements Store {
  readonly sellers = new Map<string, SellerRow>();
  readonly buyers = new Map<string, BuyerRow>();
  readonly debtors = new Map<string, DebtorRow>();
  readonly invoices = new Map<string, InvoiceRow>();
  readonly mandates = new Map<string, MandateRow>();
  readonly quotes = new Map<string, QuoteRow>();
  readonly trades = new Map<string, TradeRow>();
  readonly refusals = new Map<string, RefusalReceiptRow>();
  readonly confirmations = new Map<string, ConfirmationRequestRow>();
  readonly outcomes = new Map<string, SettlementOutcomeRow>();
  readonly issuanceJobs = new Map<string, IssuanceJobRow>();
  readonly cursors = new Map<string, IndexerCursorRow>();

  readonly #newId: () => string;
  readonly #now: () => Date;

  constructor(options: MemoryStoreOptions = {}) {
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.#now = options.now ?? (() => new Date());
  }

  // --- parties ------------------------------------------------------------------

  async insertSeller(row: NewSellerRow): Promise<SellerRow> {
    return clone(this.#putSeller(row));
  }

  async insertBuyer(row: NewBuyerRow): Promise<BuyerRow> {
    return clone(this.#putBuyer(row));
  }

  async insertDebtor(row: NewDebtorRow): Promise<DebtorRow> {
    return clone(this.#putDebtor(row));
  }

  #putSeller(row: NewSellerRow): SellerRow {
    const full: SellerRow = {
      id: row.id ?? this.#newId(),
      name: row.name,
      email: row.email,
      hederaAccountId: row.hederaAccountId ?? null,
      arcAddress: row.arcAddress ?? null,
      createdAt: row.createdAt ?? this.#now(),
    };
    this.sellers.set(full.id, full);
    return full;
  }

  #putBuyer(row: NewBuyerRow): BuyerRow {
    const full: BuyerRow = {
      id: row.id ?? this.#newId(),
      name: row.name,
      email: row.email,
      hederaAccountId: row.hederaAccountId ?? null,
      arcAddress: row.arcAddress ?? null,
      agentPolicy: row.agentPolicy ?? null,
      createdAt: row.createdAt ?? this.#now(),
    };
    this.buyers.set(full.id, full);
    return full;
  }

  #putDebtor(row: NewDebtorRow): DebtorRow {
    const full: DebtorRow = {
      id: row.id ?? this.#newId(),
      name: row.name,
      email: row.email,
      taxId: row.taxId ?? null,
      rating: row.rating ?? 'UNRATED',
      settledOnTime: row.settledOnTime ?? 0,
      settledLate: row.settledLate ?? 0,
      defaulted: row.defaulted ?? 0,
      settledFaceValue: row.settledFaceValue ?? 0n,
      firstSettlementAt: row.firstSettlementAt ?? null,
      lastSettlementAt: row.lastSettlementAt ?? null,
      createdAt: row.createdAt ?? this.#now(),
    };
    this.debtors.set(full.id, full);
    return full;
  }

  async getSeller(id: string): Promise<SellerRow | null> {
    return this.sellers.get(id) ?? null;
  }

  async getSellerByEmail(email: string): Promise<SellerRow | null> {
    const wanted = email.trim().toLowerCase();
    for (const row of this.sellers.values()) {
      if (row.email.trim().toLowerCase() === wanted) return clone(row);
    }
    return null;
  }

  async updateSellerWallet(
    id: string,
    wallet: { hederaAccountId?: string | null; arcAddress?: string | null },
  ): Promise<SellerRow> {
    const row = this.sellers.get(id);
    if (!row) throw notFound(`Seller ${id}`);
    const next: SellerRow = {
      ...row,
      ...(wallet.hederaAccountId !== undefined ? { hederaAccountId: wallet.hederaAccountId } : {}),
      ...(wallet.arcAddress !== undefined ? { arcAddress: wallet.arcAddress } : {}),
    };
    this.sellers.set(id, next);
    return clone(next);
  }

  async getBuyer(id: string): Promise<BuyerRow | null> {
    return this.buyers.get(id) ?? null;
  }

  async upsertDebtor(input: UpsertDebtorInput): Promise<DebtorRow> {
    const email = input.email.trim().toLowerCase();
    for (const row of this.debtors.values()) {
      if (row.email.toLowerCase() === email) return clone(row);
    }
    return clone(
      this.#putDebtor({
        name: input.name,
        email,
        ...(input.taxId === undefined ? {} : { taxId: input.taxId }),
      }),
    );
  }

  async getDebtor(id: string): Promise<DebtorRow | null> {
    const row = this.debtors.get(id);
    return row ? clone(row) : null;
  }

  async updateDebtorRating(id: string, rating: DebtorRow['rating']): Promise<DebtorRow> {
    const row = this.debtors.get(id);
    if (!row) throw notFound(`Customer ${id}`);
    const next: DebtorRow = { ...row, rating };
    this.debtors.set(id, next);
    return clone(next);
  }

  async getDebtors(ids: readonly string[]): Promise<DebtorRow[]> {
    const wanted = new Set(ids);
    return [...this.debtors.values()].filter((d) => wanted.has(d.id)).map((d) => clone(d));
  }

  // --- the book -----------------------------------------------------------------

  async insertInvoice(row: NewInvoiceRow): Promise<InvoiceRow> {
    for (const existing of this.invoices.values()) {
      if (existing.uniquenessHash === row.uniquenessHash) {
        throw duplicateReceivable(row.uniquenessHash);
      }
    }
    const now = this.#now();
    const full: InvoiceRow = {
      id: row.id ?? this.#newId(),
      sellerId: row.sellerId,
      debtorId: row.debtorId,
      invoiceNumber: row.invoiceNumber,
      faceValue: row.faceValue,
      currency: row.currency,
      issuedAt: row.issuedAt,
      dueAt: row.dueAt,
      status: row.status ?? 'draft',
      uniquenessHash: row.uniquenessHash,
      isin: row.isin ?? null,
      regulationType: row.regulationType ?? 'reg-s',
      securityId: row.securityId ?? null,
      securityEvmAddress: row.securityEvmAddress ?? null,
      issuanceState: row.issuanceState ?? 'queued',
      issuanceAttempts: row.issuanceAttempts ?? 0,
      issuanceTxId: row.issuanceTxId ?? null,
      issuanceError: row.issuanceError ?? null,
      confirmationTokenHash: row.confirmationTokenHash ?? null,
      confirmationRequestedAt: row.confirmationRequestedAt ?? null,
      confirmationExpiresAt: row.confirmationExpiresAt ?? null,
      confirmationDecision: row.confirmationDecision ?? null,
      confirmationDecidedAt: row.confirmationDecidedAt ?? null,
      confirmationNote: row.confirmationNote ?? null,
      createdAt: row.createdAt ?? now,
      updatedAt: row.updatedAt ?? now,
    };
    this.invoices.set(full.id, full);
    return clone(full);
  }

  async getInvoice(id: string): Promise<InvoiceRow | null> {
    const row = this.invoices.get(id);
    return row ? clone(row) : null;
  }

  async getInvoices(ids: readonly string[]): Promise<InvoiceRow[]> {
    const wanted = new Set(ids);
    return [...this.invoices.values()].filter((i) => wanted.has(i.id)).map((i) => clone(i));
  }

  async getInvoiceByUniquenessHash(hash: string): Promise<InvoiceRow | null> {
    for (const row of this.invoices.values()) {
      if (row.uniquenessHash === hash) return clone(row);
    }
    return null;
  }

  async listInvoices(criteria: ListInvoicesCriteria): Promise<Page<InvoiceRow>> {
    const all = [...this.invoices.values()]
      .filter((i) => i.sellerId === criteria.sellerId)
      .filter((i) => criteria.status === undefined || i.status === criteria.status)
      .sort(byCreatedAtDescThenId);

    const start =
      criteria.cursor === undefined
        ? 0
        : Math.max(0, all.findIndex((i) => cursorOf(i) === criteria.cursor) + 1);
    const window = all.slice(start, start + criteria.limit);
    const last = window.at(-1);
    const more = start + window.length < all.length;

    return Promise.resolve({
      rows: window.map((i) => clone(i)),
      nextCursor: more && last ? cursorOf(last) : undefined,
    });
  }

  async updateInvoice(id: string, patch: Partial<NewInvoiceRow>): Promise<InvoiceRow> {
    const row = this.invoices.get(id);
    if (!row) throw notFound(`Invoice ${id}`);
    const next: InvoiceRow = { ...row, ...stripUndefined(patch), updatedAt: this.#now() };
    this.invoices.set(id, next);
    return clone(next);
  }

  // --- confirmation -------------------------------------------------------------

  async requestConfirmation(input: ConfirmationRequestInput): Promise<ConfirmationLookup> {
    const invoice = this.invoices.get(input.invoiceId);
    if (!invoice) throw notFound(`Invoice ${input.invoiceId}`);

    for (const [key, existing] of this.confirmations) {
      if (
        existing.invoiceId === input.invoiceId &&
        existing.decision === null &&
        existing.supersededAt === null
      ) {
        this.confirmations.set(key, { ...existing, supersededAt: input.requestedAt });
      }
    }

    const request: ConfirmationRequestRow = {
      id: this.#newId(),
      invoiceId: input.invoiceId,
      tokenHash: input.tokenHash,
      requestedAt: input.requestedAt,
      expiresAt: input.expiresAt,
      consumedAt: null,
      supersededAt: null,
      decision: null,
      decidedAt: null,
      note: null,
    };
    this.confirmations.set(request.id, request);

    /*
     * The status moves only when it actually moves.
     *
     * Re-sending a link to a debtor who has not answered is the ordinary case — a lost email,
     * a link that expired — and it used to write `awaiting_confirmation` over
     * `awaiting_confirmation`, which is a self-edge the invoice machine refuses. The
     * supersession above is what a re-request really does, and it is untouched.
     */
    const next: InvoiceRow = {
      ...invoice,
      status:
        invoice.status === 'awaiting_confirmation'
          ? invoice.status
          : transitionTo(invoice.status, 'awaiting_confirmation'),
      confirmationTokenHash: input.tokenHash,
      confirmationRequestedAt: input.requestedAt,
      confirmationExpiresAt: input.expiresAt,
      confirmationDecision: null,
      confirmationDecidedAt: null,
      confirmationNote: null,
      updatedAt: input.requestedAt,
    };
    this.invoices.set(next.id, next);

    return { request: clone(request), invoice: clone(next) };
  }

  async findConfirmationByTokenHash(tokenHash: string): Promise<ConfirmationLookup | null> {
    for (const request of this.confirmations.values()) {
      if (request.tokenHash !== tokenHash) continue;
      const invoice = this.invoices.get(request.invoiceId);
      if (!invoice) return null;
      return { request: clone(request), invoice: clone(invoice) };
    }
    return null;
  }

  async decideConfirmation(input: ConfirmationDecisionInput): Promise<ConfirmationLookup> {
    let found: ConfirmationRequestRow | undefined;
    for (const request of this.confirmations.values()) {
      if (request.tokenHash === input.tokenHash) found = request;
    }
    if (!found) throw notFound('Confirmation link');
    if (found.consumedAt !== null) {
      throw conflict('conflict', 'This confirmation link has already been used.');
    }

    const decided: ConfirmationRequestRow = {
      ...found,
      consumedAt: input.at,
      decision: input.decision,
      decidedAt: input.at,
      note: input.note ?? null,
    };
    this.confirmations.set(found.id, decided);

    const invoice = this.invoices.get(found.invoiceId);
    if (!invoice) throw notFound(`Invoice ${found.invoiceId}`);

    const next: InvoiceRow = {
      ...invoice,
      status: input.decision === 'confirmed' ? 'confirmed' : 'disputed',
      confirmationTokenHash: null,
      confirmationDecision: input.decision,
      confirmationDecidedAt: input.at,
      confirmationNote: input.note ?? null,
      updatedAt: input.at,
    };
    this.invoices.set(next.id, next);

    return { request: clone(decided), invoice: clone(next) };
  }

  // --- standing bids ------------------------------------------------------------

  async insertMandate(row: NewMandateRow): Promise<MandateRow> {
    const now = this.#now();
    const full: MandateRow = {
      id: row.id ?? this.#newId(),
      buyerId: row.buyerId,
      ratingFloor: row.ratingFloor,
      maxTenorDays: row.maxTenorDays,
      annualisedYieldBps: row.annualisedYieldBps,
      currency: row.currency,
      exposureLimitMinor: row.exposureLimitMinor,
      perDebtorLimitMinor: row.perDebtorLimitMinor ?? null,
      fundedMinor: row.fundedMinor ?? 0n,
      allocatedMinor: row.allocatedMinor ?? 0n,
      escrowRef: row.escrowRef ?? null,
      status: row.status ?? 'draft',
      createdAt: row.createdAt ?? now,
      updatedAt: row.updatedAt ?? now,
    };
    this.mandates.set(full.id, full);
    return clone(full);
  }

  async getMandate(id: string): Promise<MandateRow | null> {
    const row = this.mandates.get(id);
    return row ? clone(row) : null;
  }

  async listMandates(criteria: ListMandatesCriteria): Promise<MandateRow[]> {
    return [...this.mandates.values()]
      .filter((m) => m.buyerId === criteria.buyerId)
      .filter((m) => criteria.status === undefined || m.status === criteria.status)
      .sort(byCreatedAtDescThenId)
      .slice(0, criteria.limit)
      .map((m) => clone(m));
  }

  async listQuotableMandates(currency: string): Promise<MandateRow[]> {
    return [...this.mandates.values()]
      .filter((m) => m.status === 'active' && m.currency === currency)
      .sort((a, b) => a.annualisedYieldBps - b.annualisedYieldBps || (a.id < b.id ? -1 : 1))
      .map((m) => clone(m));
  }

  async fundMandate(input: FundMandateInput): Promise<MandateRow> {
    const row = this.mandates.get(input.mandateId);
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

    /*
     * `draft -> funding -> active`, one hop at a time, and only as far as the money has
     * actually got. The old write set `active` unconditionally, which performed
     * `draft -> active` (an edge the machine refuses, because an unfunded bid must not become
     * firm without escrow beginning) and `active -> active` on every top-up.
     */
    const next: MandateRow = {
      ...row,
      fundedMinor: funded,
      escrowRef: input.escrowRef,
      status: walkMandateStatus(row.status, fundingHops(row, funded, input.firm)),
      updatedAt: input.at,
    };
    this.mandates.set(next.id, next);
    return clone(next);
  }

  async withdrawFromMandate(input: WithdrawInput): Promise<WithdrawResult> {
    const row = this.mandates.get(input.mandateId);
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
    // `null` when the mandate is not emptied, and the status is then left alone rather than
    // written back as itself — see `db/status.ts`.
    const next: MandateRow = {
      ...row,
      fundedMinor: funded,
      status: statusAfterWithdraw(row, funded) ?? row.status,
      updatedAt: input.at,
    };
    this.mandates.set(next.id, next);
    return { mandate: clone(next), withdrawn: wanted };
  }

  async allocate(mandateId: string, amount: bigint): Promise<MandateRow> {
    const row = this.mandates.get(mandateId);
    if (!row) throw notFound(`Mandate ${mandateId}`);

    const available = max0(row.fundedMinor - row.allocatedMinor);
    if (amount > available) {
      throw conflict(
        'insufficient_mandate_balance',
        `This mandate has ${available} of committed capital left and the trade needs ${amount}.`,
      );
    }

    const allocated = row.allocatedMinor + amount;
    const next: MandateRow = {
      ...row,
      allocatedMinor: allocated,
      status: statusAfterAllocate(row, allocated) ?? row.status,
      updatedAt: this.#now(),
    };
    this.mandates.set(next.id, next);
    return clone(next);
  }

  async release(mandateId: string, amount: bigint): Promise<MandateRow> {
    const row = this.mandates.get(mandateId);
    if (!row) throw notFound(`Mandate ${mandateId}`);
    const allocated = max0(row.allocatedMinor - amount);
    const next: MandateRow = {
      ...row,
      allocatedMinor: allocated,
      status: statusAfterRelease(row, allocated) ?? row.status,
      updatedAt: this.#now(),
    };
    this.mandates.set(next.id, next);
    return clone(next);
  }

  async debtorExposure(mandateIds: readonly string[]): Promise<DebtorExposureMap> {
    const wanted = new Set(mandateIds);
    const out = new Map<string, Record<string, bigint>>();
    for (const id of wanted) out.set(id, {});

    for (const trade of this.trades.values()) {
      if (!wanted.has(trade.mandateId)) continue;
      if (!EXPOSING_TRADE_STATUSES.has(trade.status)) continue;
      const invoice = this.invoices.get(trade.invoiceId);
      if (!invoice || CLOSED_INVOICE_STATUSES.has(invoice.status)) continue;

      const bucket = out.get(trade.mandateId) ?? {};
      bucket[invoice.debtorId] = (bucket[invoice.debtorId] ?? 0n) + trade.proceedsMinor;
      out.set(trade.mandateId, bucket);
    }
    return out;
  }

  // --- quotes, trades, refusals -------------------------------------------------

  async insertQuote(row: NewQuoteRow): Promise<QuoteRow> {
    const full: QuoteRow = {
      id: row.id ?? this.#newId(),
      invoiceId: row.invoiceId,
      mandateId: row.mandateId ?? null,
      ratingAtQuote: row.ratingAtQuote,
      tenorDays: row.tenorDays,
      annualisedYieldBps: row.annualisedYieldBps,
      faceValue: row.faceValue,
      discountMinor: row.discountMinor,
      proceedsMinor: row.proceedsMinor,
      status: row.status ?? 'live',
      pricedAt: row.pricedAt ?? this.#now(),
      expiresAt: row.expiresAt,
    };
    this.quotes.set(full.id, full);
    return clone(full);
  }

  async getQuote(id: string): Promise<QuoteRow | null> {
    const row = this.quotes.get(id);
    return row ? clone(row) : null;
  }

  async findLiveQuote(invoiceId: string, at: Date): Promise<QuoteRow | null> {
    const matching = [...this.quotes.values()]
      .filter(
        (q) =>
          q.invoiceId === invoiceId && q.status === 'live' && q.expiresAt.getTime() > at.getTime(),
      )
      .sort((a, b) => b.pricedAt.getTime() - a.pricedAt.getTime());
    const first = matching[0];
    return first ? clone(first) : null;
  }

  async setQuoteStatus(id: string, status: QuoteStatusValue): Promise<QuoteRow> {
    const row = this.quotes.get(id);
    if (!row) throw notFound(`Quote ${id}`);
    const next: QuoteRow = { ...row, status };
    this.quotes.set(id, next);
    return clone(next);
  }

  async insertTrade(row: NewTradeRow): Promise<TradeRow> {
    const full: TradeRow = {
      id: row.id ?? this.#newId(),
      invoiceId: row.invoiceId,
      mandateId: row.mandateId,
      quoteId: row.quoteId,
      sellerId: row.sellerId,
      buyerId: row.buyerId,
      faceValue: row.faceValue,
      proceedsMinor: row.proceedsMinor,
      annualisedYieldBps: row.annualisedYieldBps,
      tenorDays: row.tenorDays,
      status: row.status ?? 'preparing',
      unitsMinor: row.unitsMinor ?? null,
      holdId: row.holdId ?? null,
      assetTxId: row.assetTxId ?? null,
      assetConsensusAt: row.assetConsensusAt ?? null,
      cashRail: row.cashRail ?? null,
      cashScheme: row.cashScheme ?? null,
      cashNetwork: row.cashNetwork ?? null,
      cashAsset: row.cashAsset ?? null,
      cashTransaction: row.cashTransaction ?? null,
      cashPayer: row.cashPayer ?? null,
      cashAmountMinor: row.cashAmountMinor ?? null,
      arcLockId: row.arcLockId ?? null,
      arcSecret: row.arcSecret ?? null,
      complianceDecision: row.complianceDecision ?? null,
      complianceCheckedAt: row.complianceCheckedAt ?? null,
      hcsTopicId: row.hcsTopicId ?? null,
      hcsSequenceNumber: row.hcsSequenceNumber ?? null,
      maturityScheduleId: row.maturityScheduleId ?? null,
      createdAt: row.createdAt ?? this.#now(),
      settledAt: row.settledAt ?? null,
    };
    this.trades.set(full.id, full);
    return clone(full);
  }

  async getTrade(id: string): Promise<TradeRow | null> {
    const row = this.trades.get(id);
    return row ? clone(row) : null;
  }

  async getTradeForInvoice(invoiceId: string): Promise<TradeRow | null> {
    const matching = [...this.trades.values()]
      .filter((t) => t.invoiceId === invoiceId)
      .sort(byCreatedAtDescThenId);
    const first = matching[0];
    return first ? clone(first) : null;
  }

  async listTrades(criteria: ListTradesCriteria): Promise<TradeRow[]> {
    return [...this.trades.values()]
      .filter((t) => criteria.sellerId === undefined || t.sellerId === criteria.sellerId)
      .filter((t) => criteria.buyerId === undefined || t.buyerId === criteria.buyerId)
      .filter((t) => criteria.invoiceId === undefined || t.invoiceId === criteria.invoiceId)
      .filter((t) => criteria.status === undefined || t.status === criteria.status)
      .sort(byCreatedAtDescThenId)
      .slice(0, criteria.limit)
      .map((t) => clone(t));
  }

  /** Oldest first, unlike every other trade read here — see the interface. */
  async listArmedTradesOlderThan(before: Date, limit: number): Promise<TradeRow[]> {
    return [...this.trades.values()]
      .filter((t) => ARMED_TRADE_STATUSES.has(t.status))
      .filter((t) => t.createdAt.getTime() <= before.getTime())
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map((t) => clone(t));
  }

  async updateTrade(id: string, patch: Partial<NewTradeRow>): Promise<TradeRow> {
    const row = this.trades.get(id);
    if (!row) throw notFound(`Trade ${id}`);
    const next: TradeRow = { ...row, ...stripUndefined(patch) };
    this.trades.set(id, next);
    return clone(next);
  }

  async insertRefusals(rows: readonly NewRefusalReceiptRow[]): Promise<RefusalReceiptRow[]> {
    const out: RefusalReceiptRow[] = [];
    for (const row of rows) {
      const full: RefusalReceiptRow = {
        id: row.id ?? this.#newId(),
        invoiceId: row.invoiceId,
        mandateId: row.mandateId,
        buyerId: row.buyerId,
        reasonCode: row.reasonCode,
        reasonText: row.reasonText,
        ratingAtRefusal: row.ratingAtRefusal,
        tenorDaysAtRefusal: row.tenorDaysAtRefusal,
        hcsTopicId: row.hcsTopicId ?? null,
        hcsSequenceNumber: row.hcsSequenceNumber ?? null,
        hcsConsensusAt: row.hcsConsensusAt ?? null,
        createdAt: row.createdAt ?? this.#now(),
      };
      this.refusals.set(full.id, full);
      out.push(clone(full));
    }
    return out;
  }

  async recordRefusalConsensus(
    id: string,
    consensus: { topicId: string; sequenceNumber: bigint; consensusAt: Date },
  ): Promise<RefusalReceiptRow> {
    const row = this.refusals.get(id);
    if (!row) throw notFound(`Refusal receipt ${id}`);
    const next: RefusalReceiptRow = {
      ...row,
      hcsTopicId: consensus.topicId,
      hcsSequenceNumber: consensus.sequenceNumber,
      hcsConsensusAt: consensus.consensusAt,
    };
    this.refusals.set(id, next);
    return clone(next);
  }

  async listRefusalsForInvoice(invoiceId: string): Promise<RefusalReceiptRow[]> {
    return [...this.refusals.values()]
      .filter((r) => r.invoiceId === invoiceId)
      .sort(byCreatedAtDescThenId)
      .map((r) => clone(r));
  }

  // --- ratings ------------------------------------------------------------------

  async recordOutcome(input: RecordOutcomeInput): Promise<RecordOutcomeResult> {
    const debtor = this.debtors.get(input.debtorId);
    if (!debtor) throw notFound(`Customer ${input.debtorId}`);

    const key = `${input.debtorId}:${input.invoiceId}`;
    const existing = this.outcomes.get(key);
    if (existing !== undefined) {
      // The outcome the ledger holds, not the one this call proposed. A caller that only
      // learns "something was already here" cannot tell a replayed default from a default
      // landing on top of a payment, and one of those contradicts a settled fact.
      return { debtor: clone(debtor), alreadyRecorded: true, recorded: existing.outcome };
    }

    this.outcomes.set(key, {
      id: this.#newId(),
      debtorId: input.debtorId,
      invoiceId: input.invoiceId,
      outcome: input.outcome,
      faceValue: input.faceValue,
      occurredAt: input.at,
      createdAt: this.#now(),
    });

    const next: DebtorRow = {
      ...debtor,
      settledOnTime: debtor.settledOnTime + (input.outcome === 'on_time' ? 1 : 0),
      settledLate: debtor.settledLate + (input.outcome === 'late' ? 1 : 0),
      defaulted: debtor.defaulted + (input.outcome === 'default' ? 1 : 0),
      settledFaceValue:
        input.outcome === 'default'
          ? debtor.settledFaceValue
          : debtor.settledFaceValue + input.faceValue,
      firstSettlementAt: debtor.firstSettlementAt ?? input.at,
      lastSettlementAt: input.at,
    };
    this.debtors.set(next.id, next);
    return { debtor: clone(next), alreadyRecorded: false, recorded: input.outcome };
  }

  // --- issuance and indexing ----------------------------------------------------

  async saveIssuanceJob(patch: IssuanceJobPatch): Promise<IssuanceJobRow> {
    const existing = this.issuanceJobs.get(patch.invoiceId);
    const row: IssuanceJobRow = {
      invoiceId: patch.invoiceId,
      state: patch.state,
      attempts: patch.attempts,
      queuedAt: existing?.queuedAt ?? this.#now(),
      startedAt: patch.startedAt ?? existing?.startedAt ?? null,
      completedAt: patch.completedAt ?? existing?.completedAt ?? null,
      nextAttemptAt: patch.nextAttemptAt ?? null,
      lastError: patch.lastError ?? null,
    };
    this.issuanceJobs.set(row.invoiceId, row);
    return clone(row);
  }

  async listUnfinishedIssuanceJobs(): Promise<IssuanceJobRow[]> {
    return [...this.issuanceJobs.values()]
      .filter((j) => j.state === 'queued' || j.state === 'issuing')
      .map((j) => clone(j));
  }

  async listInvoicesAwaitingIssuance(limit = 100): Promise<InvoiceRow[]> {
    return [...this.invoices.values()]
      .filter((i) => i.issuanceState === 'queued' || i.issuanceState === 'issuing')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
      .map((i) => clone(i));
  }

  async getCursor(chain: string): Promise<string | null> {
    return this.cursors.get(chain)?.cursor ?? null;
  }

  async setCursor(chain: string, position: string): Promise<void> {
    this.cursors.set(chain, { chain, cursor: position, updatedAt: this.#now() });
    return;
  }
}

export const createMemoryStore = (options?: MemoryStoreOptions): MemoryStore =>
  new MemoryStore(options);

// --- helpers --------------------------------------------------------------------

const max0 = (v: bigint): bigint => (v > 0n ? v : 0n);

const cursorOf = (row: { createdAt: Date; id: string }): string =>
  `${row.createdAt.toISOString()}|${row.id}`;

function byCreatedAtDescThenId<T extends { createdAt: Date; id: string }>(a: T, b: T): number {
  const delta = b.createdAt.getTime() - a.createdAt.getTime();
  if (delta !== 0) return delta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * A Drizzle patch spreads `undefined` as "leave alone"; a plain object spread would write
 * it as null. Dropping the keys keeps the two implementations behaving identically.
 */
type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

function stripUndefined<T extends object>(patch: T): Defined<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Defined<T>;
}
