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
import { CashLegError, type CashLegSigner } from './cash.js';
import type { Logger } from './logger.js';
import {
  checkCashLegPayable,
  decide,
  explainAgentRefusal,
  unallocated,
  withAllocation,
  type AgentRefusal,
  type ExpectedRail,
  type InvoiceCandidate,
  type MandateAcceptance,
  type MandateAllocations,
  type MandateTerms,
  type X402Readiness,
} from './mandate.js';
import { USDC_DECIMALS, type WalletClient } from './wallet.js';
import { VenueError, type ArmedTrade, type BookRow, type VenueClient } from './venue.js';

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
  /**
   * The buyer's Hedera key, for the x402 cash leg.
   *
   * **Optional, and its absence is a capability rather than a misconfiguration.** Without
   * it the agent trades only against mandates whose capital is escrowed on Arc, which is a
   * coherent way to run a desk — it just cannot take an unfunded bid, because the venue
   * settles those by a payment nobody here could sign.
   */
  readonly cash?: CashLegSigner | null | undefined;
  /** Injectable clock, so a tick is reproducible in a test. */
  readonly now?: (() => Date) | undefined;
}

/** Both legs, done, as the venue reported them. Every field is checkable on a block explorer. */
export interface TradeSettlement {
  /** `arc-vault` or `x402`, from the venue rather than inferred from which branch ran. */
  readonly rail: string;
  readonly chain: string;
  /** The cash moving. An Arc transaction hash, or a Hedera transaction id. */
  readonly cashTransaction: string | null;
  readonly assetTransaction: string | null;
  /** What was paid, in the settlement asset's smallest unit, as the payer signed it. */
  readonly settledAmountMinor: string | null;
  readonly settledAt: string | null;
}

/**
 * What one `act` call did, and what it spent doing it.
 *
 * `spentTinybars` is separate from the report because it feeds the tick's running budget
 * rather than the summary: the balance is read once per pass and the mirror node lags a
 * signature by seconds, so what the pass has already promised has to be tracked locally or
 * two invoices will both be told the same tinybar is free.
 */
interface ActOutcome {
  readonly taken: TakenInvoice;
  /** Zero unless the x402 rail actually signed. The Arc rail spends nothing this key holds. */
  readonly spentTinybars: bigint;
}

/** One invoice the agent decided to take, and what it did about it. */
export interface TakenInvoice {
  readonly acceptance: MandateAcceptance;
  readonly quoteId: string | null;
  /**
   * The venue's answer to arming. `200` means it settled out of the buyer's Arc escrow on
   * the spot; `402` means it issued a challenge. `null` in dry run, or when arming was
   * skipped.
   */
  readonly armedStatus: number | null;
  readonly skippedReason: string | null;
  /** Which rail the venue chose, in its own words. `null` when nothing was armed. */
  readonly rail: string | null;
  /**
   * Set once the cash has actually moved. `null` for a trade that was armed but not
   * settled — which is a real and different outcome, not a missing value.
   */
  readonly settlement: TradeSettlement | null;
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
  /**
   * What the x402 payer could do this tick.
   *
   * Reported even when no trade took that rail, because "the agent took nothing" and "the
   * agent could not have paid for anything" look identical in a tick summary otherwise.
   */
  readonly x402: X402Readiness;
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
  const cash = deps.cash ?? null;
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

    /*
     * The x402 payer, read once per tick for the same reason as the wallet: within one pass
     * the running budget below is what keeps two payments off the same tinybar, and
     * re-reading mid-pass would let the mirror node's lag *undo* that budget rather than
     * tighten it.
     *
     * This proves only that an account exists and is not empty. Whether it covers any
     * particular trade is checked against that trade's own challenge, which names the amount
     * in this same unit — so no price is converted here and this agent still holds no copy of
     * the venue's ppm scale.
     */
    const x402: X402Readiness = {
      configured: cash !== null,
      balanceTinybars: cash === null ? null : await cash.balanceTinybars(),
    };
    if (cash !== null && x402.balanceTinybars === null) {
      logger.warn('the x402 payer’s balance could not be read; the Hedera rail is unavailable', {
        payerAccountId: cash.payerAccountId,
        network: cash.network,
      });
    }
    /* Tinybars promised by signatures already made this tick. See the budget note above. */
    let spentTinybars = 0n;

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
    /*
     * The venue's reading of each vault, as of this tick's mandate fetch.
     *
     * Read once with the mandates rather than per invoice, for the same reason the balance
     * used to be: a value that moved mid-pass would let a later invoice see a different
     * world from an earlier one, and the running budget below assumes one world.
     */
    const vaultById = new Map(quoting.map((m) => [m.terms.id, m.vault]));
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
       * part only the agent can do — decide whether a trade it arms can actually finish.
       *
       * It asks about **both** rails, and that is the change that put this agent on the
       * Hedera one. While it asked only about the vault, every mandate it would arm was
       * escrowed — and an escrowed mandate settles on Arc — so the x402 branch below was
       * unreachable by construction rather than by choice, and nothing errored to say so.
       *
       * No price is compared against either rail. For Arc that is because `backed` is
       * measured against the mandate's whole committed capital and `decide` has already
       * checked this trade fits inside it. For Hedera it is because the amount is named by
       * the challenge, which does not exist yet. Converting one here would put a second copy
       * of the venue's ppm scale in this package, which is the defect this pre-flight was
       * rewritten once already to remove.
       */
      const payable = checkCashLegPayable({
        mandateId: best.mandateId,
        vault: vaultById.get(best.mandateId) ?? null,
        x402,
      });
      if (!payable.ok) {
        record(refused, row.invoiceId, best.mandateId, payable.error);
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
        /* A prediction, not the decision — the venue re-reads the vault when the trade is armed. */
        expectedRail: payable.value,
        /*
         * What this tick has committed, not what is left. There is no per-tick purse any
         * more: the pot a trade settles from is the mandate's escrowed capital, and the
         * running `allocations` map is what bounds it. Subtracting commitments from a wallet
         * balance that pays for neither rail produced a negative "remaining" figure that
         * meant nothing.
         */
        committedThisTick: committedThisTick + best.proceeds,
      });

      try {
        const outcome = await act(best, row, payable.value, {
          balanceTinybars: x402.balanceTinybars,
          alreadySpent: spentTinybars,
        });
        spentTinybars += outcome.spentTinybars;
        taken.push(outcome.taken);
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
      x402,
      committedThisTick,
      taken,
      refused,
      errors,
    };
  }

  /**
   * Take the price, arm the trade, and — where the venue asks for one — sign and settle the
   * cash leg.
   *
   * The quote is re-fetched rather than reused from the book row, because a trade is
   * executed against a `quoteId` and the venue mints that id only on the quote route. It is
   * also the venue's own answer, so a disagreement between it and the agent's arithmetic
   * shows up here rather than as a surprise fill.
   */
  async function act(
    acceptance: MandateAcceptance,
    row: BookRow,
    expectedRail: ExpectedRail,
    budget: { readonly balanceTinybars: bigint | null; readonly alreadySpent: bigint },
  ): Promise<ActOutcome> {
    const base: Omit<TakenInvoice, 'quoteId' | 'armedStatus' | 'skippedReason'> = {
      acceptance,
      rail: null,
      settlement: null,
    };
    const stop = (taken: TakenInvoice): ActOutcome => ({ taken, spentTinybars: 0n });

    if (!row.issued) {
      // Issuance is paced, so an invoice is quotable before its ATS bond exists. Arming
      // one would be refused as `issuance_pending`; the mandate still wants it next tick.
      return stop({ ...base, quoteId: null, armedStatus: null, skippedReason: 'issuance_pending' });
    }

    if (!row.listed) {
      /*
       * Priced but not offered. The venue quotes a confirmed invoice and sells only a listed
       * one, and listing is the seller's act — so this is not something a buyer can fix, and
       * arming would come back 409. The bid stays interested; the row is skipped with the
       * reason, exactly as an unissued one is.
       */
      return stop({ ...base, quoteId: null, armedStatus: null, skippedReason: 'not_listed' });
    }

    const live = await venue.quote(acceptance.invoiceId);
    if (live.quoteId === null || live.proceeds === null) {
      return stop({ ...base, quoteId: null, armedStatus: null, skippedReason: 'no_live_quote' });
    }

    if (live.mandateId !== acceptance.mandateId) {
      /*
       * The venue picked a different mandate — very often someone else's, which is an
       * ordinary outcome on a competitive book rather than a fault. Arming anyway would
       * fill against a bid this agent does not operate.
       */
      return stop({
        ...base,
        quoteId: live.quoteId,
        armedStatus: null,
        skippedReason: `matched_elsewhere:${live.mandateId ?? 'none'}`,
      });
    }

    const tolerance = (acceptance.proceeds * BigInt(maxSlippageBps)) / 10_000n;
    if (live.proceeds > acceptance.proceeds + tolerance) {
      // The venue wants more for the paper than this mandate priced. Outside tolerance the
      // mandate simply does not take it at that number.
      return stop({
        ...base,
        quoteId: live.quoteId,
        armedStatus: null,
        skippedReason: `outside_tolerance:${live.proceeds}`,
      });
    }

    if (dryRun) {
      logger.info('dry run: would arm trade', {
        invoiceId: acceptance.invoiceId,
        mandateId: acceptance.mandateId,
        quoteId: live.quoteId,
        proceeds: live.proceeds,
        expectedRail,
      });
      return stop({ ...base, quoteId: live.quoteId, armedStatus: null, skippedReason: 'dry_run' });
    }

    /*
     * There is deliberately no last look here any more.
     *
     * There used to be a second wallet read immediately before arming, on the reasoning that
     * the balance had to be true at the moment money was promised. That reasoning was sound
     * and the pot was wrong: the Circle wallet settles neither rail.
     *
     * The vault reading taken at the top of the tick is not re-fetched to replace it, because
     * **the venue re-decides the rail at arm time.** `chooseRail` reads the vault itself on
     * every `POST /v1/trades` and drops to x402 if the capital is no longer there, so a stale
     * reading here cannot cause a bad settlement — only a wasted arm, which the venue then
     * refuses. Paying for that certainty would mean a mandates fetch per invoice, which is
     * the N+1 the venue's own pricing path exists to avoid.
     */

    const trade = {
      invoiceId: acceptance.invoiceId,
      quoteId: live.quoteId,
      maxSlippageBps,
    };
    const armed = await venue.armTrade(trade);
    const armedBase = {
      ...base,
      quoteId: live.quoteId,
      armedStatus: armed.status,
      rail: armed.rail?.chosen ?? null,
    };

    /*
     * Not a 402, so the venue settled it out of the buyer's escrow on Arc and there is
     * nothing to sign. Reported as what it is: the old log line said the cash leg awaited an
     * x402 signature on every arm, which on this branch described a signature nobody was
     * waiting for against money that had already moved.
     */
    if (armed.status !== 402) {
      logger.info('trade settled out of escrowed capital; no signature was needed', {
        invoiceId: acceptance.invoiceId,
        mandateId: acceptance.mandateId,
        quoteId: live.quoteId,
        rail: armed.rail?.chosen ?? null,
        reason: armed.rail?.reason ?? null,
      });
      return stop({ ...armedBase, skippedReason: null, settlement: settlementFrom(armed) });
    }

    if (armed.challenge === null) {
      // Armed, and unpayable. The seller's paper is held until the venue reclaims the
      // expired challenge, which it does lazily on almost every request — see
      // `reclaimExpired`. Nothing here can shorten that, and pretending to have settled
      // would be worse than reporting it.
      logger.error('the venue issued a challenge this agent cannot read', {
        invoiceId: acceptance.invoiceId,
        quoteId: live.quoteId,
        detail: armed.challengeError,
      });
      return stop({ ...armedBase, skippedReason: 'unreadable_challenge' });
    }

    if (cash === null) {
      // Unreachable through the pre-flight, which refuses an unbacked mandate when no key
      // exists. Kept because the venue re-decides the rail and could route to x402 a bid the
      // vault backed a moment ago, and arriving here with no key must not throw.
      return stop({ ...armedBase, skippedReason: 'no_x402_signer' });
    }

    let signed;
    try {
      signed = await cash.sign(armed.challenge);
    } catch (cause) {
      if (cause instanceof CashLegError) {
        logger.error('the cash leg was not signed', {
          invoiceId: acceptance.invoiceId,
          kind: cause.kind,
          detail: cause.message,
        });
        return stop({ ...armedBase, skippedReason: `unsigned:${cause.kind}` });
      }
      throw cause;
    }

    /*
     * The only amount comparison this agent makes, and it is made here because here is the
     * only place the amount is stated in the payer's own unit. The challenge names tinybars;
     * so does the balance. Nothing is converted, so there is no scale to get wrong.
     *
     * `alreadySpent` is what earlier signatures in this same tick promised. The balance was
     * read once at the top and the mirror node lags a signature by seconds, so two invoices
     * in one pass would otherwise both be told the same tinybar is free.
     */
    const available = (budget.balanceTinybars ?? 0n) - budget.alreadySpent;
    if (available < signed.amount) {
      logger.error('the x402 payer cannot cover this trade; not settling', {
        invoiceId: acceptance.invoiceId,
        payerAccountId: cash.payerAccountId,
        requiredTinybars: signed.amount,
        availableTinybars: available,
      });
      return stop({ ...armedBase, skippedReason: `x402_balance_short:${signed.amount}` });
    }

    const settled = await venue.settleTrade({ ...trade, payment: signed.payload });
    logger.info('trade settled; the agent signed and paid the cash leg', {
      invoiceId: acceptance.invoiceId,
      mandateId: acceptance.mandateId,
      quoteId: live.quoteId,
      rail: settled.cashLeg?.rail ?? armed.rail?.chosen ?? null,
      payerAccountId: cash.payerAccountId,
      paidTinybars: signed.amount,
      feePayer: signed.feePayer,
      cashTransaction: settled.cashLeg?.transaction ?? null,
      assetTransaction: settled.assetLeg?.transactionId ?? null,
    });

    return {
      taken: {
        ...armedBase,
        skippedReason: null,
        rail: settled.cashLeg?.rail ?? armedBase.rail,
        settlement: {
          rail: settled.cashLeg?.rail ?? 'x402',
          chain: settled.cashLeg?.chain ?? cash.network,
          cashTransaction: settled.cashLeg?.transaction ?? null,
          assetTransaction: settled.assetLeg?.transactionId ?? null,
          settledAmountMinor: settled.cashLeg?.settledAmountMinor ?? signed.amount.toString(10),
          settledAt: settled.settledAt,
        },
      },
      /*
       * Counted against the tick's budget only once the venue has answered. A settle that
       * threw left the transaction in an unknown state — it may yet reach consensus — but
       * the trade is over either way, and the next tick re-reads the balance from the mirror
       * node, which is the authority.
       */
      spentTinybars: signed.amount,
    };
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

/**
 * The Arc rail's settlement, read off the venue's own 200.
 *
 * `null` when that body carried no cash leg. A 200 with nothing to show for it is a venue
 * that settled and did not say how, and building a receipt out of the branch that ran rather
 * than out of what the venue reported is how a log ends up naming a rail nobody checked.
 */
function settlementFrom(armed: ArmedTrade): TradeSettlement | null {
  if (armed.cashLeg === null) return null;
  return {
    rail: armed.cashLeg.rail,
    chain: armed.cashLeg.chain,
    cashTransaction: armed.cashLeg.transaction,
    assetTransaction: armed.assetLeg?.transactionId ?? null,
    settledAmountMinor: armed.cashLeg.settledAmountMinor,
    settledAt: armed.settledAt,
  };
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
