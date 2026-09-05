/**
 * The proof view.
 *
 * Nobody using Facture needs to know it is on a blockchain. A seller sees invoices with
 * prices beside them; a buyer sees mandates, exposure and yield. The chains surface in
 * exactly one place, and this is it: one click from any trade, showing the on-chain
 * receipts, the compliance decision and both settlement legs.
 *
 * The response is deliberately link-heavy. Every claim it makes should be checkable by
 * the reader against HashScan or Arcscan without trusting this service — that is the
 * difference between an audit view and a receipt we printed ourselves.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { explorer } from '../chain.js';
import { getStore } from '../db/store.js';
import { notFound } from '../errors.js';
import type { AppEnv } from '../middleware/context.js';
import { getScheduleAdapter } from '../services/schedule.js';
import { readParams } from '../validate.js';
import { money } from '../wire.js';

/** The exact shape the proof screen renders. Every field is independently verifiable. */
export interface TradeProof {
  tradeId: string;
  invoice: {
    id: string;
    invoiceNumber: string;
    /** hash(debtor, invoice number, amount) — one receivable, one instrument, ever. */
    uniquenessHash: string;
    isin: string | null;
    /** The ATS zero-coupon bond. Maturity = due date, principal = face, rate = 0. */
    securityId: string | null;
    securityExplorerUrl: string | null;
  };
  /** How the debtor acknowledged their own accounts payable. */
  confirmation: {
    decision: 'confirmed' | 'disputed' | null;
    decidedAt: string | null;
  };
  /**
   * The pre-match decision, taken against the security's own ControlList and Kyc facets
   * before matching — not at settlement.
   */
  compliance: {
    decision: Record<string, unknown> | null;
    checkedAt: string | null;
    hcsTopicId: string | null;
    hcsSequenceNumber: string | null;
    hcsExplorerUrl: string | null;
  };
  /**
   * The quote this trade filled at, frozen. Amounts are decimal strings in minor units —
   * see `src/wire.ts`, which owns that convention for the whole service.
   *
   * NOTE: `discountMinor`/`proceedsMinor` still carry the old suffix, unlike `faceValue`.
   * The domain names in `@facture/shared` are `Quote.discount` and `Quote.proceeds`, and
   * the columns behind them are `discount_minor`/`proceeds_minor`, so these three fields
   * should be unified the same way `faceMinor -> faceValue` was. Left as-is here only
   * because the rename was scoped to face value.
   */
  pricing: {
    ratingAtQuote: string;
    tenorDays: number;
    annualisedYieldBps: number;
    faceValue: string;
    discountMinor: string;
    proceedsMinor: string;
  };
  /** Asset leg: the ATS hold, then its execution. Hedera. */
  assetLeg: {
    chain: 'hedera';
    holdId: string | null;
    /**
     * How many units of the security moved: the seller's whole position, read off the
     * instrument when the trade was armed.
     *
     * On this screen it is the number a reader checks the HashScan transfer against, and
     * it is here because the two disagreed — issuance mints face-value-many units and the
     * trade used to move exactly one of them, which is the kind of claim a proof view
     * exists to make impossible to hide.
     */
    unitsMinor: string | null;
    transactionId: string | null;
    consensusAt: string | null;
    explorerUrl: string | null;
  };
  /** Cash leg: the x402 payment. Arc, or Hedera when settling in HBAR. */
  cashLeg: {
    chain: 'arc' | 'hedera';
    scheme: string | null;
    network: string | null;
    asset: string | null;
    transaction: string | null;
    payer: string | null;
    explorerUrl: string | null;
  };
  /**
   * Maturity: the third receipt, and the one that makes a resale legitimate.
   *
   * `null` until the receivable has matured — there is nothing to show, and an empty block
   * would imply the question had been asked and answered. Once it exists it has two
   * distinguishable states, because arranging a payout is not the same event as making one:
   * `pending` is an obligation on the ledger waiting for the venue to sign that the debtor's
   * money arrived, `settled` is a transfer that happened and can be checked.
   */
  maturity: {
    scheduleId: string;
    scheduleExplorerUrl: string;
    state: 'pending' | 'settled';
    executedAt: string | null;
    transactionId: string | null;
    explorerUrl: string | null;
    /** The collection account the money left, read off the executed transfer. */
    payer: string | null;
    /** The holder credited, likewise read off the transfer rather than from the buyer row. */
    payee: string | null;
  } | null;
  /** Refusals recorded while pricing this invoice. Kept for the funders who were told no. */
  refusals: {
    mandateId: string;
    reasonCode: string;
    reasonText: string;
    hcsExplorerUrl: string | null;
  }[];
  settledAt: string | null;
}

export const proofRoutes = new Hono<AppEnv>();

proofRoutes.get('/trades/:id/proof', async (c) => {
  const { id } = readParams(c, z.object({ id: z.uuid() }));
  const store = getStore();

  const trade = await store.getTrade(id);
  if (!trade) throw notFound(`Trade ${id}`);

  const [invoice, quote, refusals] = await Promise.all([
    store.getInvoice(trade.invoiceId),
    store.getQuote(trade.quoteId),
    store.listRefusalsForInvoice(trade.invoiceId),
  ]);
  if (!invoice) throw notFound(`Invoice ${trade.invoiceId}`);

  /*
   * Maturity, when there is one. The schedule id is the venue's record that an obligation
   * was created; whether it became a payment is asked of the ledger rather than stored,
   * because the signature that executes it happens outside this service.
   */
  const maturity: TradeProof['maturity'] =
    trade.maturityScheduleId === null
      ? null
      : await (async () => {
          const scheduleId = trade.maturityScheduleId as string;
          const status = await getScheduleAdapter().payoutStatus(scheduleId);
          return {
            scheduleId,
            scheduleExplorerUrl: explorer.hederaSchedule(scheduleId),
            state: status.executed ? ('settled' as const) : ('pending' as const),
            executedAt: status.executedAt,
            transactionId: status.transactionId,
            explorerUrl: link(status.transactionId, explorer.hederaTx),
            payer: status.payerAccountId,
            payee: status.payeeAccountId,
          };
        })();

  /*
   * Every link below is built from an identifier this service actually holds, and any
   * identifier that is null produces a null link rather than a URL. An explorer link that
   * 404s is worse than an absent one: this is the one screen whose whole purpose is that a
   * reader can check each claim against HashScan or Arcscan without trusting us, and a
   * dead link quietly converts "verifiable" into "looks verifiable".
   */
  const proof: TradeProof = {
    tradeId: trade.id,
    invoice: {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      uniquenessHash: invoice.uniquenessHash,
      isin: invoice.isin,
      securityId: invoice.securityId,
      securityExplorerUrl: link(invoice.securityId, explorer.hederaToken),
    },
    confirmation: {
      decision: invoice.confirmationDecision,
      decidedAt: iso(invoice.confirmationDecidedAt),
    },
    compliance: {
      decision: trade.complianceDecision,
      checkedAt: iso(trade.complianceCheckedAt),
      hcsTopicId: trade.hcsTopicId,
      hcsSequenceNumber: trade.hcsSequenceNumber?.toString(10) ?? null,
      hcsExplorerUrl:
        trade.hcsTopicId === null || trade.hcsSequenceNumber === null
          ? null
          : explorer.hederaTopicMessage(trade.hcsTopicId, Number(trade.hcsSequenceNumber)),
    },
    /*
     * The quote is frozen at the price that filled, read off the persisted row rather than
     * re-derived. A mandate's bid can move afterwards and a settled trade may not.
     */
    pricing: {
      ratingAtQuote: quote?.ratingAtQuote ?? 'UNRATED',
      tenorDays: trade.tenorDays,
      annualisedYieldBps: trade.annualisedYieldBps,
      faceValue: money(trade.faceValue),
      discountMinor: money(trade.faceValue - trade.proceedsMinor),
      proceedsMinor: money(trade.proceedsMinor),
    },
    assetLeg: {
      chain: 'hedera',
      holdId: trade.holdId,
      unitsMinor: trade.unitsMinor?.toString(10) ?? null,
      transactionId: trade.assetTxId,
      consensusAt: iso(trade.assetConsensusAt),
      explorerUrl: link(trade.assetTxId, explorer.hederaTx),
    },
    cashLeg: {
      chain: trade.cashNetwork?.startsWith('hedera') === true ? 'hedera' : 'arc',
      scheme: trade.cashScheme,
      network: trade.cashNetwork,
      asset: trade.cashAsset,
      transaction: trade.cashTransaction,
      payer: trade.cashPayer,
      explorerUrl:
        trade.cashTransaction === null
          ? null
          : trade.cashNetwork?.startsWith('hedera') === true
            ? explorer.hederaTx(trade.cashTransaction)
            : explorer.arcTx(trade.cashTransaction),
    },
    maturity: maturity,
    /** Kept for the funders who were told no, not only for the one who was matched. */
    refusals: refusals.map((row) => ({
      mandateId: row.mandateId,
      reasonCode: row.reasonCode,
      reasonText: row.reasonText,
      hcsExplorerUrl:
        row.hcsTopicId === null || row.hcsSequenceNumber === null
          ? null
          : explorer.hederaTopicMessage(row.hcsTopicId, Number(row.hcsSequenceNumber)),
    })),
    settledAt: iso(trade.settledAt),
  };

  return c.json(proof);
});

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

/** A link only exists when its identifier does. */
const link = (id: string | null, build: (value: string) => string): string | null =>
  id === null ? null : build(id);
