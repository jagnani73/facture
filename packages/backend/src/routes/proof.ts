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
import { getArcEscrow } from '../services/arc.js';
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
  /**
   * Cash leg. Two rails, and which one ran is stated rather than inferred.
   *
   * `x402` is a payment the buyer signed for this trade, on Hedera in HBAR. `arc-vault` draws
   * on USDC the buyer escrowed in `MandateVault` before the invoice existed — no signature,
   * because a funded mandate already agreed to anything meeting its terms.
   *
   * `chain` and `rail` are both null before either rail has run. The inference these replaced
   * answered `'arc'` for a trade that had not settled at all.
   */
  cashLeg: {
    chain: 'arc' | 'hedera' | null;
    rail: 'x402' | 'arc-vault' | null;
    scheme: string | null;
    network: string | null;
    asset: string | null;
    transaction: string | null;
    payer: string | null;
    /** Settlement-asset minor units — tinybars or USDC — not the invoice currency. */
    settledAmountMinor: string | null;
    explorerUrl: string | null;
    /** Arc only: where a payout is sitting, and whether the seller has taken it. */
    lock: {
      lockId: string;
      status: string;
      beneficiary: string | null;
      amountMinor: string | null;
      claimableUntil: string | null;
      /**
       * The preimage that releases the lock.
       *
       * **This is not a credential, and publishing it costs nothing.** `DvpEscrow.claim`
       * requires `msg.sender == beneficiary` as well as the preimage, so the secret alone
       * moves no money — the contract's own note says the hashlock "does not keep anyone
       * out" and that the protection is the beneficiary binding. `claim` then writes the
       * preimage to storage in the clear anyway, because that log is the cross-chain channel.
       *
       * It is here because it was previously returned exactly once, in the body of the
       * `POST /v1/trades` response. A dropped connection at that moment left money locked
       * that nobody could ever claim: the lock times out, the capital goes back to the
       * buyer, and `payout.executed` stays true forever, so that match can never be paid.
       * A single delivery of the only key is not a delivery mechanism.
       */
      secret: string | null;
      /**
       * The `DvpEscrow` to send `claim` to.
       *
       * Published because the seller sends that transaction themselves — the escrow
       * checks the caller, so the venue cannot collect for them — and an address the
       * screen does not carry is a claim nobody can make.
       */
      escrowAddress: string | null;
      explorerUrl: string | null;
    } | null;
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
   * The cash leg's chain, from what the venue recorded rather than a prefix test on the
   * network string. `cash_rail` is authoritative; `cashNetwork` covers the rows written
   * before that column existed; neither means the trade has not settled.
   */
  const cashChain: 'arc' | 'hedera' | null =
    trade.cashRail === 'arc-vault'
      ? 'arc'
      : trade.cashNetwork === null
        ? null
        : trade.cashNetwork.startsWith('hedera')
          ? 'hedera'
          : 'arc';

  /*
   * Whether the seller has actually taken an Arc payout, asked of the escrow every time.
   *
   * The same rule the maturity block follows: a payout that has been *locked* is not a payout
   * that has been *received*, and the difference is visible only on chain. Storing a "claimed"
   * flag would be storing something this service could be wrong about — and a reader checking
   * a proof view is precisely the person who should not have to trust it.
   *
   * A read that fails leaves the lock unreported rather than reported as unclaimed, for the
   * same reason `escrow.backed` distinguishes those two: accusing a paid seller of being
   * unpaid is worse than saying nothing.
   */
  const lockState: TradeProof['cashLeg']['lock'] =
    trade.arcLockId === null
      ? null
      : await (async () => {
          const lockId = trade.arcLockId as string;
          const escrow = getArcEscrow();
          const escrowAddress = await escrow.escrowAddress().catch(() => null);
          const base = {
            lockId,
            beneficiary: null,
            amountMinor: null,
            claimableUntil: null,
            secret: trade.arcSecret,
            escrowAddress,
            explorerUrl: link(trade.cashTransaction, explorer.arcTx),
          };
          try {
            const lock = await escrow.lockOf(lockId);
            if (lock === null) return { ...base, status: 'unknown' };
            return {
              lockId,
              status: lock.status,
              beneficiary: lock.beneficiary,
              amountMinor: money(lock.amount),
              claimableUntil: new Date(lock.timeout * 1000).toISOString(),
              secret: trade.arcSecret,
              escrowAddress,
              explorerUrl: base.explorerUrl,
            };
          } catch {
            return { ...base, status: 'unreadable' };
          }
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
      securityExplorerUrl: link(invoice.securityId, explorer.hederaSecurity),
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
      chain: cashChain,
      /** Which rail paid, recorded at settlement rather than inferred here and in `wire.ts`. */
      rail: trade.cashRail,
      scheme: trade.cashScheme,
      network: trade.cashNetwork,
      asset: trade.cashAsset,
      transaction: trade.cashTransaction,
      payer: trade.cashPayer,
      /**
       * The figure that matches the transaction, in the settlement asset's own minor units.
       *
       * `pricing.proceedsMinor` above is US cents. The two differ by the deployment's
       * ppm scale, so a proof view showing only the first invites a reader to check
       * `$59,331.78` against a transfer of 0.059331 USDC and conclude the venue is lying.
       */
      settledAmountMinor: trade.cashAmountMinor === null ? null : money(trade.cashAmountMinor),
      explorerUrl:
        trade.cashTransaction === null
          ? null
          : cashChain === 'hedera'
            ? explorer.hederaTx(trade.cashTransaction)
            : explorer.arcTx(trade.cashTransaction),
      /**
       * Arc only. Where a payout is sitting, and whether the seller has taken it.
       *
       * A vault payout moves capital into `DvpEscrow` claimable by the seller alone, for 24
       * hours. Reporting the cash leg as settled without this would report a payment that has
       * not reached anyone yet. Read from the escrow on every call for the same reason
       * `maturity` is: whether someone was paid is asked, never remembered.
       */
      lock: lockState,
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
