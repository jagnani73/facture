/**
 * The market maker.
 *
 * One tick: read the agent's own mandates from the venue, read the book, price every
 * quotable invoice against every mandate, and arm a trade on whatever the mandates take.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * WHY THE BALANCE IS READ FROM THE CHAIN AND NOT FROM MEMORY
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * The README's claim is that these market makers are *real agents holding funded
 * mandates*, and that fake liquidity is the one thing that would undo every argument in the
 * product. An agent that quoted from a locally-remembered balance would be exactly that:
 * the number on the seller's screen would be backed by this process's belief rather than by
 * money.
 *
 * So each tick reads the wallet's USDC balance from Circle before deciding anything, and
 * re-reads it immediately before any live arm. Local state is used only for the one thing
 * the chain cannot answer — how much *this tick* has already promised — because two
 * invoices considered a millisecond apart would otherwise both be told the same dollar is
 * free.
 *
 * And because **Circle enforces no cap** (see the header of `mandate.ts`), the running
 * budget below is not a convenience. It is the enforcement. If it is wrong, money moves.
 */

import {
  CURRENCY_DECIMALS,
  scaleMinorUnits,
  type Currency,
  type MinorUnits,
} from '@facture/shared';
import type { Logger } from './logger.js';
import {
  checkWalletFunded,
  decide,
  explainAgentRefusal,
  unallocated,
  withAllocation,
  type AgentRefusal,
  type InvoiceCandidate,
  type MandateAcceptance,
  type MandateAllocations,
  type MandateTerms,
} from './mandate.js';
import { USDC_DECIMALS, type WalletClient } from './wallet.js';
import { VenueError, type BookRow, type VenueClient } from './venue.js';

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * Scale conversion
 * ───────────────────────────────────────────────────────────────────────────────────── */

/**
 * USDC minor units (6dp) → invoice minor units (2dp for USD/EUR).
 *
 * **Truncates, deliberately in the direction that refuses to spend.** A wallet holding
 * 5.009999 USDC reads as 500 cents, not 501, so sub-cent dust is never counted as
 * spendable. The amount actually *sent* is converted the other way and is exact — only this
 * comparison rounds, and it rounds against the agent.
 */
export const usdcToInvoiceMinor = (amount: bigint, currency: Currency): MinorUnits =>
  scaleMinorUnits(amount, USDC_DECIMALS, CURRENCY_DECIMALS[currency]);

/** Invoice minor units → USDC minor units. Scaling up, so exact. */
export const invoiceMinorToUsdc = (amount: MinorUnits, currency: Currency): bigint =>
  scaleMinorUnits(amount, CURRENCY_DECIMALS[currency], USDC_DECIMALS);

/**
 * The settlement asset is USDC, so a mandate denominated in anything else cannot be funded
 * from this wallet. EURC exists on Arc testnet and a EUR mandate would need its own wallet
 * and its own balance read; nothing here pretends one balance covers both.
 */
export const SETTLEMENT_CURRENCY: Currency = 'USD';

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * Configuration and reporting
 * ───────────────────────────────────────────────────────────────────────────────────── */

export interface AgentConfig {
  /** The buyer whose mandates this process operates. */
  readonly buyerId: string;
  /** Sellers whose books are watched. The venue has no buyer-side book route — see `venue.ts`. */
  readonly sellerIds: readonly string[];
  /** Circle wallet holding the mandates' capital. */
  readonly walletId: string;
  /** Restrict to these mandates. Empty means every active mandate the buyer holds. */
  readonly mandateIds?: readonly string[] | undefined;
  /** Tolerance when the venue re-prices between quote and fill. Zero means fill or nothing. */
  readonly maxSlippageBps?: number | undefined;
  /**
   * Decide and report, arm nothing. **Defaults to true.** Arming a trade puts a hold on the
   * Hedera leg and commits the mandate, so it is opt-in rather than opt-out.
   */
  readonly dryRun?: boolean | undefined;
}

export interface AgentDeps {
  readonly venue: VenueClient;
  readonly wallet: WalletClient;
  readonly logger: Logger;
  /** Injectable clock, so a tick is reproducible in a test. */
  readonly now?: (() => Date) | undefined;
}

/** One invoice the agent decided to take, and what it did about it. */
export interface TakenInvoice {
  readonly acceptance: MandateAcceptance;
  readonly quoteId: string | null;
  /** `null` in dry run, or when arming was skipped. */
  readonly armedStatus: number | null;
  readonly skippedReason: string | null;
}

/** One invoice the agent will not take, with the reason named and written out. */
export interface RefusedInvoice {
  readonly invoiceId: string;
  readonly mandateId: string | null;
  readonly refusal: AgentRefusal;
  readonly humanReason: string;
}

export interface TickReport {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly mandatesConsidered: number;
  readonly mandatesQuoting: number;
  readonly bookRows: number;
  readonly quotableRows: number;
  /** On-chain USDC balance in minor units at 6dp, or `null` when the wallet holds none. */
  readonly walletUsdc: bigint | null;
  /** The same balance in invoice minor units, which is what the caps are measured in. */
  readonly spendableMinor: MinorUnits;
  readonly committedThisTick: MinorUnits;
  readonly taken: readonly TakenInvoice[];
  readonly refused: readonly RefusedInvoice[];
  readonly errors: readonly string[];
}

export interface MarketMaker {
  /** One pass over the book. Safe to call directly; `run` is this on an interval. */
  tick(): Promise<TickReport>;
  /** Poll until `stop()`. Resolves once the loop has drained. */
  run(intervalMs: number): Promise<void>;
  stop(): void;
}

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * The agent
 * ───────────────────────────────────────────────────────────────────────────────────── */

export function createMarketMaker(config: AgentConfig, deps: AgentDeps): MarketMaker {
  const { venue, wallet, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const dryRun = config.dryRun ?? true;
  const maxSlippageBps = config.maxSlippageBps ?? 0;
  const restrictTo = new Set(config.mandateIds ?? []);

  let running = false;

  async function tick(): Promise<TickReport> {
    const startedAt = now().toISOString();
    const errors: string[] = [];
    const taken: TakenInvoice[] = [];
    const refused: RefusedInvoice[] = [];

    const all = await venue.mandates(config.buyerId);
    const mine = all.filter((m) => restrictTo.size === 0 || restrictTo.has(m.terms.id));

    /*
     * Non-USD mandates are dropped rather than quoted. The wallet settles USDC; a EUR
     * mandate would draw on a EURC balance nobody has read, and quoting it would be
     * exactly the unfunded bid the product cannot have.
     */
    const settleable = mine.filter((m) => {
      if (m.terms.currency === SETTLEMENT_CURRENCY) return true;
      logger.warn('mandate skipped: not denominated in the settlement asset', {
        mandateId: m.terms.id,
        mandateCurrency: m.terms.currency,
        settlementCurrency: SETTLEMENT_CURRENCY,
      });
      return false;
    });

    const quoting = settleable.filter((m) => m.terms.status === 'active');

    /*
     * The balance, from the chain, before any decision is made. Read once per tick rather
     * than once per invoice: within one pass the running budget is what keeps two
     * allocations off the same dollar, and re-reading mid-pass would let Circle's lag
     * *undo* the budget rather than tighten it.
     */
    const balance = await wallet.usdcBalance(config.walletId);
    const walletUsdc = balance?.amount ?? null;
    if (balance === null) {
      logger.warn('wallet holds no USDC balance record; every mandate reads as unfunded', {
        walletId: config.walletId,
      });
    } else if (balance.decimals !== USDC_DECIMALS) {
      // The 18-vs-6 trap. A silent mismatch here is a 10^12 error in a spend.
      throw new Error(
        `USDC on ${wallet.blockchain} reports ${balance.decimals} decimals, expected ` +
          `${USDC_DECIMALS}. Refusing to price against a scale this agent does not understand.`,
      );
    }

    const spendableMinor = usdcToInvoiceMinor(walletUsdc ?? 0n, SETTLEMENT_CURRENCY);

    const rows = await venue.book(config.sellerIds);
    const quotableRows = rows.filter((row) => row.quotable);

    logger.info('tick: book read', {
      mandatesConsidered: mine.length,
      mandatesQuoting: quoting.length,
      bookRows: rows.length,
      quotableRows: quotableRows.length,
      walletUsdc,
      spendableMinor,
      dryRun,
    });

    for (const row of rows) {
      if (!row.quotable) {
        record(refused, row.invoiceId, null, {
          code: 'INVOICE_NOT_CONFIRMED',
          status: row.status,
        });
      }
    }

    // Running state for this pass. `allocations` starts from the venue's figures and is
    // advanced locally as the agent commits, so the second invoice against a mandate sees
    // what the first one took.
    const allocations = new Map<string, MandateAllocations>(
      quoting.map((m) => [m.terms.id, m.allocations]),
    );
    const termsById = new Map<string, MandateTerms>(quoting.map((m) => [m.terms.id, m.terms]));
    let committedThisTick = 0n;

    for (const row of quotableRows) {
      const candidate: InvoiceCandidate = {
        invoiceId: row.invoiceId,
        debtorId: row.debtorId,
        debtorName: row.debtorName,
        rating: row.rating,
        tenorDays: row.tenorDays,
        faceValue: row.faceValue,
        currency: row.currency,
      };

      const accepted: MandateAcceptance[] = [];
      for (const mandate of quoting) {
        const current = allocations.get(mandate.terms.id) ?? mandate.allocations;
        const outcome = decide(mandate.terms, current, candidate);
        if (outcome.ok) accepted.push(outcome.value);
        else record(refused, row.invoiceId, mandate.terms.id, outcome.error);
      }

      const best = pickBest(accepted, termsById, allocations, row.debtorId);
      if (best === null) continue;

      /*
       * The pre-flight. Everything above is book-keeping the venue also does; this is the
       * part only the agent can do, and the part Circle will not do for it. `spendable`
       * already has this tick's earlier commitments taken out of it, so a mandate cannot
       * spend the same balance twice.
       */
      const funded = checkWalletFunded({
        walletId: config.walletId,
        required: best.proceeds,
        available: spendableMinor - committedThisTick,
        currency: SETTLEMENT_CURRENCY,
      });
      if (!funded.ok) {
        record(refused, row.invoiceId, best.mandateId, funded.error);
        continue;
      }

      allocations.set(
        best.mandateId,
        withAllocation(allocations.get(best.mandateId) ?? { total: 0n, byDebtor: {} }, best),
      );
      committedThisTick += best.proceeds;

      logger.info('mandate takes invoice', {
        mandateId: best.mandateId,
        invoiceId: best.invoiceId,
        debtorId: best.debtorId,
        rating: row.rating,
        tenorDays: best.tenorDays,
        faceValue: best.faceValue,
        proceeds: best.proceeds,
        discount: best.discount,
        annualisedYieldBps: best.annualisedYieldBps,
        remainingThisTick: spendableMinor - committedThisTick,
      });

      try {
        taken.push(await act(best, row));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        errors.push(`${row.invoiceId}: ${message}`);
        logger.error('failed to act on an accepted invoice', {
          invoiceId: row.invoiceId,
          mandateId: best.mandateId,
          err: cause,
        });
        /*
         * The local commitment is deliberately NOT rolled back. Whether the venue took the
         * allocation is unknown from here, and assuming it did not is the direction that
         * double-spends. The next tick re-reads both the balance and the venue's own
         * allocated figure, which is the authority, and the budget corrects itself.
         */
      }
    }

    for (const item of refused) {
      logger.debug('refused', {
        invoiceId: item.invoiceId,
        mandateId: item.mandateId,
        code: item.refusal.code,
        reason: item.humanReason,
      });
    }

    return {
      startedAt,
      finishedAt: now().toISOString(),
      mandatesConsidered: mine.length,
      mandatesQuoting: quoting.length,
      bookRows: rows.length,
      quotableRows: quotableRows.length,
      walletUsdc,
      spendableMinor,
      committedThisTick,
      taken,
      refused,
      errors,
    };
  }

  /**
   * Take the price and arm the trade.
   *
   * The quote is re-fetched rather than reused from the book row, because a trade is
   * executed against a `quoteId` and the venue mints that id only on the quote route. It is
   * also the venue's own answer, so a disagreement between it and the agent's arithmetic
   * shows up here rather than as a surprise fill.
   */
  async function act(acceptance: MandateAcceptance, row: BookRow): Promise<TakenInvoice> {
    const base: Omit<TakenInvoice, 'quoteId' | 'armedStatus' | 'skippedReason'> = { acceptance };

    if (!row.issued) {
      // Issuance is paced, so an invoice is quotable before its ATS bond exists. Arming
      // one would be refused as `issuance_pending`; the mandate still wants it next tick.
      return { ...base, quoteId: null, armedStatus: null, skippedReason: 'issuance_pending' };
    }

    const live = await venue.quote(acceptance.invoiceId);
    if (live.quoteId === null || live.proceeds === null) {
      return { ...base, quoteId: null, armedStatus: null, skippedReason: 'no_live_quote' };
    }

    if (live.mandateId !== acceptance.mandateId) {
      /*
       * The venue picked a different mandate — very often someone else's, which is an
       * ordinary outcome on a competitive book rather than a fault. Arming anyway would
       * fill against a bid this agent does not operate.
       */
      return {
        ...base,
        quoteId: live.quoteId,
        armedStatus: null,
        skippedReason: `matched_elsewhere:${live.mandateId ?? 'none'}`,
      };
    }

    const tolerance = (acceptance.proceeds * BigInt(maxSlippageBps)) / 10_000n;
    if (live.proceeds > acceptance.proceeds + tolerance) {
      // The venue wants more for the paper than this mandate priced. Outside tolerance the
      // mandate simply does not take it at that number.
      return {
        ...base,
        quoteId: live.quoteId,
        armedStatus: null,
        skippedReason: `outside_tolerance:${live.proceeds}`,
      };
    }

    if (dryRun) {
      logger.info('dry run: would arm trade', {
        invoiceId: acceptance.invoiceId,
        mandateId: acceptance.mandateId,
        quoteId: live.quoteId,
        proceeds: live.proceeds,
      });
      return { ...base, quoteId: live.quoteId, armedStatus: null, skippedReason: 'dry_run' };
    }

    /*
     * Last look at the chain before anything commits. The balance was read at the top of
     * the tick and the book has been walked since; this is the moment the money is actually
     * promised, so it is the moment the balance has to be true.
     */
    const confirmed = await wallet.usdcBalance(config.walletId);
    const stillFunded = checkWalletFunded({
      walletId: config.walletId,
      required: live.proceeds,
      available: usdcToInvoiceMinor(confirmed?.amount ?? 0n, SETTLEMENT_CURRENCY),
      currency: SETTLEMENT_CURRENCY,
    });
    if (!stillFunded.ok) {
      logger.warn('balance moved under the agent; not arming', {
        invoiceId: acceptance.invoiceId,
        mandateId: acceptance.mandateId,
        reason: explainAgentRefusal(stillFunded.error),
      });
      return {
        ...base,
        quoteId: live.quoteId,
        armedStatus: null,
        skippedReason: 'WALLET_BALANCE_SHORT',
      };
    }

    const armed = await venue.armTrade({
      invoiceId: acceptance.invoiceId,
      quoteId: live.quoteId,
      maxSlippageBps,
    });
    logger.info('trade armed; cash leg awaits its x402 signature', {
      invoiceId: acceptance.invoiceId,
      mandateId: acceptance.mandateId,
      quoteId: live.quoteId,
      status: armed.status,
    });
    return { ...base, quoteId: live.quoteId, armedStatus: armed.status, skippedReason: null };
  }

  async function run(intervalMs: number): Promise<void> {
    running = true;
    while (running) {
      try {
        const report = await tick();
        logger.info('tick complete', {
          taken: report.taken.length,
          refused: report.refused.length,
          committedThisTick: report.committedThisTick,
          errors: report.errors.length,
        });
      } catch (cause) {
        // A tick that throws is a tick that did nothing, which is the safe failure. Log and
        // wait: a venue that is down comes back, and backing off is better than a hot loop.
        const venueStatus = cause instanceof VenueError ? cause.status : undefined;
        logger.error('tick failed', { err: cause, venueStatus });
      }
      if (!running) break;
      await sleep(intervalMs);
    }
  }

  return {
    tick,
    run,
    stop() {
      running = false;
    },
  };
}

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * Helpers
 * ───────────────────────────────────────────────────────────────────────────────────── */

/**
 * Which of the agent's own mandates takes it, when several would.
 *
 * Mirrors `@facture/shared`'s `bestQuote` ordering exactly — lowest annualised yield, then
 * deepest unallocated balance, then lowest mandate id. Matching it is the point: the venue
 * fills against its own best mandate, so an agent that ranked differently would arm a trade
 * on one bid and be filled on another.
 *
 * 1. Lowest yield — the smallest discount, i.e. the most money for the seller.
 * 2. Deepest unallocated balance — spreads the book instead of exhausting one bid.
 * 3. Lowest id — so two identical bids do not select differently between two calls.
 */
export function pickBest(
  accepted: readonly MandateAcceptance[],
  termsById: ReadonlyMap<string, MandateTerms>,
  allocations: ReadonlyMap<string, MandateAllocations>,
  _debtorId: string,
): MandateAcceptance | null {
  if (accepted.length === 0) return null;

  const depth = (mandateId: string): MinorUnits => {
    const terms = termsById.get(mandateId);
    if (terms === undefined) return 0n;
    return unallocated(terms, allocations.get(mandateId) ?? { total: 0n, byDebtor: {} });
  };

  return [...accepted].sort((a, b) => {
    const byYield = a.annualisedYieldBps - b.annualisedYieldBps;
    if (byYield !== 0) return byYield;

    const depthA = depth(a.mandateId);
    const depthB = depth(b.mandateId);
    if (depthA !== depthB) return depthA > depthB ? -1 : 1;

    return a.mandateId < b.mandateId ? -1 : a.mandateId > b.mandateId ? 1 : 0;
  })[0] as MandateAcceptance;
}

function record(
  into: RefusedInvoice[],
  invoiceId: string,
  mandateId: string | null,
  refusal: AgentRefusal,
): void {
  into.push({ invoiceId, mandateId, refusal, humanReason: explainAgentRefusal(refusal) });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Do not hold the process open for a timer that is only pacing a loop.
    timer.unref?.();
  });
