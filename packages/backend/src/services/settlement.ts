/**
 * Cross-chain DvP settlement.
 *
 * The bond stays on Hedera, the USDC stays on Arc, and neither side moves first. Nothing
 * is wrapped and nothing bridges. The honest reason for two chains is not cleverness: it
 * is that buyer capital already lives where stablecoins live, and you do not ask a
 * treasury desk to bridge onto Hedera to buy a $40k receivable.
 *
 * The shape of one trade:
 *
 *   1. prepare  — place an ATS hold on the seller's position (asset leg `held`, not moved)
 *                 and build the x402 `PaymentRequirements` for the cash leg.
 *   2. execute  — facilitator settles the cash leg; on success the hold is executed and
 *                 the security transfers to the buyer.
 *   3. unwind   — if the cash leg fails or times out, release the hold. The seller's
 *                 position was never encumbered for longer than the challenge window.
 *
 * Compliance is NOT checked here. It was checked before matching, against the security's
 * own `ControlList` and `Kyc` facets. By the time settlement runs, an ineligible
 * counterparty has already been refused with a receipt.
 */

import type { Currency, SettlementLegState } from '@facture/shared';
import { CURRENCY_DECIMALS } from '@facture/shared';
import { explorer } from '../chain.js';
import { getConfig } from '../config.js';
import { getStore } from '../db/store.js';
import { badRequest, conflict, internalError, notFound, upstreamUnavailable } from '../errors.js';
import { rootLogger } from '../logger.js';
import { accountIdToEvmAddress, getAtsAdapter, operatorEvmAddress } from './ats.js';
import type { SettlementOutcome } from './rating.js';
import { ratingService } from './rating.js';
import { getX402Client } from './x402.js';
import type { PaymentRequirements, ResourceInfo } from './x402.js';

/**
 * One leg's state, from `@facture/shared`: `pending | held | settled | released | failed`.
 *
 * The escrowed-but-not-yet-released state is spelled `held`, matching the ATS hold that
 * implements it on the asset side and the x402 challenge on the cash side. This module
 * used to call it `armed`, which named the same state differently from every other package
 * reading the same trade.
 */
export type LegState = SettlementLegState;

export interface DvpIntent {
  tradeId: string;
  invoiceId: string;
  mandateId: string;
  /** ATS security for this invoice, native id `0.0.x`. */
  securityId: string;
  sellerHederaAccountId: string;
  buyerHederaAccountId: string;
  buyerArcAddress: `0x${string}`;
  /** Whole position. Partial sales are a later cut — see the cut list. */
  unitsMinor: bigint;
  /** What the buyer pays today. Face minus the discount the curve implies. */
  proceedsMinor: bigint;
  faceValue: bigint;
  currency: string;
}

/** Asset leg: an ATS hold on Hedera, executed only once the cash leg clears. */
export interface AssetLegReceipt {
  chain: 'hedera';
  state: LegState;
  holdId: string | null;
  transactionId: string | null;
  consensusAt: string | null;
  explorerUrl: string | null;
}

/** Cash leg: an x402 payment. `transaction` is the facilitator's settlement reference. */
export interface CashLegReceipt {
  chain: 'arc' | 'hedera';
  scheme: 'x402';
  state: LegState;
  asset: string;
  amountMinor: string;
  transaction: string | null;
  payer: string | null;
  explorerUrl: string | null;
}

export interface DvpPreparation {
  tradeId: string;
  assetLeg: AssetLegReceipt;
  requirements: PaymentRequirements;
  /**
   * Sibling of `requirements` on the wire. In `@x402/core` 2.24.0 the resource description
   * is its own object rather than three fields inside the requirements.
   */
  resourceInfo: ResourceInfo;
  /** After this the hold is released whether or not the buyer signed. */
  expiresAt: string;
}

export interface SettlementResult {
  tradeId: string;
  assetLeg: AssetLegReceipt;
  cashLeg: CashLegReceipt;
  settledAt: string;
}

export interface SettlementService {
  prepare(intent: DvpIntent): Promise<DvpPreparation>;
  execute(input: {
    tradeId: string;
    requirements: PaymentRequirements;
    /** The buyer's signed `PAYMENT-SIGNATURE` payload. */
    paymentPayload: unknown;
  }): Promise<SettlementResult>;
  unwind(tradeId: string, reason: string): Promise<AssetLegReceipt>;
  /**
   * Maturity. The debtor pays and settlement routes to whoever holds the token NOW, not
   * whoever bought it first. Without this the paper cannot legitimately change hands,
   * because a second buyer would have no way to be paid.
   */
  settleAtMaturity(invoiceId: string): Promise<SettlementResult>;
}

/**
 * How long the asset leg stays held waiting for the cash leg.
 *
 * Short on purpose. This is the whole window in which the seller's position is encumbered
 * for a trade that has not paid, and if the buyer never signs, the hold expiring is what
 * makes the failure cost nothing. It is also the `maxTimeoutSeconds` the payer is given,
 * so the two cannot disagree about when the challenge dies.
 */
export const CHALLENGE_WINDOW_SECONDS = 180;

/** A receivable paid within this many days of maturity still counts as on time. */
const ON_TIME_GRACE_DAYS = 0;

/**
 * The `resource` a trade's challenge is bound to.
 *
 * Exported because the challenge is rebuilt rather than stored when the buyer returns with
 * a signature, and a `resource` that differed by one character between the two would fail
 * verification with nothing on either side explaining why.
 */
export const tradeResourceUrl = (tradeId: string): string =>
  `${getConfig().env.PUBLIC_BASE_URL.replace(/\/$/, '')}/v1/trades/${tradeId}`;

/**
 * The cash-leg challenge for one trade, built in exactly one place.
 *
 * The buyer signs over these fields, and the same object has to come back when they return
 * with the signature — the challenge is rebuilt rather than stored, because
 * `extra.feePayer` is read from the facilitator at runtime and a persisted copy goes stale
 * the moment the facilitator rotates it. Rebuilding it anywhere but here would let a
 * description or a timeout differ by one character and fail verification with nothing on
 * either side saying why.
 */
export const buildTradeChallenge = (input: {
  tradeId: string;
  invoiceId: string;
  proceedsMinor: bigint;
  faceValue: bigint;
  currency: string;
}): Promise<{ accepted: PaymentRequirements; resource: ResourceInfo }> =>
  getX402Client().buildRequirements({
    amountMinor: input.proceedsMinor,
    currencyDecimals: CURRENCY_DECIMALS[input.currency as Currency] ?? 2,
    resource: tradeResourceUrl(input.tradeId),
    description:
      `Purchase of receivable ${input.invoiceId} at ${input.proceedsMinor} ` +
      `${input.currency} minor units against face ${input.faceValue}. ` +
      `The cash leg settles one unit of ${input.currency} as one unit of the settlement ` +
      `asset — a declared convention, not a quoted rate — scaled for testnet.`,
    maxTimeoutSeconds: CHALLENGE_WINDOW_SECONDS,
  });

export const settlementService: SettlementService = {
  /**
   * Arm both legs. Nothing moves.
   *
   * The ATS hold is placed first because it is the leg that can fail for a reason worth
   * telling the buyer about — a paused instrument, a lost role grant — and discovering
   * that after taking a payment signature would be the wrong order. Once the hold exists,
   * the 402 challenge is built for the proceeds and the hold id is written onto the trade
   * so `unwind` can find it after a restart.
   */
  async prepare(intent) {
    const store = getStore();
    const expiresAt = new Date(Date.now() + CHALLENGE_WINDOW_SECONDS * 1000);

    /*
     * Hedera addresses, not Arc ones. `buyerArcAddress` on the intent is where the cash
     * leg pays; the security never leaves Hedera, so the hold's `to` is the buyer's Hedera
     * account in its EVM form. Mixing the two would deliver the paper to an address that
     * does not exist on the chain holding it.
     */
    const hold = await getAtsAdapter().createHold({
      securityId: intent.securityId,
      holderEvmAddress: accountIdToEvmAddress(intent.sellerHederaAccountId),
      toEvmAddress: accountIdToEvmAddress(intent.buyerHederaAccountId),
      // The venue is the escrow agent for the challenge window, and nothing longer.
      escrowEvmAddress: operatorEvmAddress(getConfig().env.HEDERA_OPERATOR_KEY),
      units: intent.unitsMinor,
      expiresAt,
    });

    const challenge = await buildTradeChallenge({
      tradeId: intent.tradeId,
      invoiceId: intent.invoiceId,
      proceedsMinor: intent.proceedsMinor,
      faceValue: intent.faceValue,
      currency: intent.currency,
    });

    await store.updateTrade(intent.tradeId, {
      status: 'awaiting_payment',
      holdId: hold.holdId,
      assetTxId: hold.transactionId,
      assetConsensusAt: new Date(hold.consensusAt),
      cashScheme: challenge.accepted.scheme,
      cashNetwork: challenge.accepted.network,
      cashAsset: challenge.accepted.asset,
    });

    return {
      tradeId: intent.tradeId,
      assetLeg: {
        chain: 'hedera',
        state: 'held',
        holdId: hold.holdId,
        transactionId: hold.transactionId,
        consensusAt: hold.consensusAt,
        explorerUrl: explorer.hederaTx(hold.transactionId),
      },
      requirements: challenge.accepted,
      resourceInfo: challenge.resource,
      expiresAt: expiresAt.toISOString(),
    };
  },

  /**
   * Release both legs, cash first.
   *
   * `verify` before `settle` so a bad signature costs a round trip rather than a settled
   * payment against a hold that will not execute. After `settle` succeeds the security has
   * to follow, and if the hold execution then fails **that is the genuinely bad state** —
   * the buyer has paid and does not hold the paper. It is recorded loudly as `failed` with
   * the cash reference intact and reconciled out of band; swallowing it would leave a
   * half-settled trade that looks merely unfinished.
   */
  async execute(input) {
    const store = getStore();
    const client = getX402Client();

    const trade = await store.getTrade(input.tradeId);
    if (!trade) throw notFound(`Trade ${input.tradeId}`);
    if (trade.status === 'settled') {
      throw conflict('conflict', 'This trade has already settled.');
    }
    if (trade.holdId === null) {
      throw conflict('conflict', 'This trade has no asset-leg hold; prepare it first.');
    }

    const verification = await client.verify(input.paymentPayload, input.requirements);
    if (!verification.isValid) {
      throw badRequest(
        `The payment signature was rejected by the facilitator: ${
          verification.invalidReason ?? 'no reason given'
        }.`,
      );
    }

    const settlement = await client.settle(input.paymentPayload, input.requirements);
    if (!settlement.success) {
      await store.updateTrade(trade.id, { status: 'failed' });
      throw upstreamUnavailable(
        'x402 facilitator',
        `The cash leg did not settle: ${settlement.errorReason ?? 'no reason given'}.`,
      );
    }

    const cashLeg: CashLegReceipt = {
      chain: input.requirements.network.startsWith('hedera') ? 'hedera' : 'arc',
      scheme: 'x402',
      state: 'settled',
      asset: input.requirements.asset,
      amountMinor: trade.proceedsMinor.toString(10),
      transaction: settlement.transaction ?? null,
      payer: settlement.payer ?? verification.payer ?? null,
      explorerUrl: settlement.transaction
        ? explorerFor(input.requirements.network, settlement.transaction)
        : null,
    };

    const invoice = await store.getInvoice(trade.invoiceId);
    const seller = await store.getSeller(trade.sellerId);
    const buyer = await store.getBuyer(trade.buyerId);

    let assetLeg: AssetLegReceipt;
    try {
      const executed = await getAtsAdapter().executeHold({
        securityId: invoice?.securityId ?? '',
        holderEvmAddress: accountIdToEvmAddress(seller?.hederaAccountId),
        toEvmAddress: accountIdToEvmAddress(buyer?.hederaAccountId),
        holdId: trade.holdId,
        units: 1n,
      });
      assetLeg = {
        chain: 'hedera',
        state: 'settled',
        holdId: trade.holdId,
        transactionId: executed.transactionId,
        consensusAt: executed.consensusAt,
        explorerUrl: explorer.hederaTx(executed.transactionId),
      };
    } catch (err) {
      await store.updateTrade(trade.id, {
        status: 'failed',
        cashTransaction: cashLeg.transaction,
        cashPayer: cashLeg.payer,
      });
      rootLogger.error('HALF-SETTLED TRADE: cash leg settled, asset leg did not execute', {
        tradeId: trade.id,
        cashTransaction: cashLeg.transaction,
        holdId: trade.holdId,
        err,
      });
      throw internalError(
        `The payment settled but the security did not transfer. Trade ${trade.id} is ` +
          'half-settled and is being reconciled; quote this id.',
      );
    }

    const settledAt = new Date();
    await store.updateTrade(trade.id, {
      status: 'settled',
      assetTxId: assetLeg.transactionId,
      assetConsensusAt: assetLeg.consensusAt === null ? null : new Date(assetLeg.consensusAt),
      cashTransaction: cashLeg.transaction,
      cashPayer: cashLeg.payer,
      cashAsset: cashLeg.asset,
      cashNetwork: input.requirements.network,
      cashScheme: input.requirements.scheme,
      settledAt,
    });
    await store.setQuoteStatus(trade.quoteId, 'accepted');
    await store.updateInvoice(trade.invoiceId, { status: 'sold' });

    return {
      tradeId: trade.id,
      assetLeg,
      cashLeg,
      settledAt: settledAt.toISOString(),
    };
  },

  /**
   * Give the position back. Safe to call twice: an already-unwound trade returns the
   * receipt it already had rather than releasing a hold that no longer exists.
   *
   * The mandate's allocation is released here, not at the call site, because the
   * allocation and the hold were taken together and a partial rollback would leave the
   * bid quoting money it cannot spend.
   */
  async unwind(tradeId, reason) {
    const store = getStore();
    const trade = await store.getTrade(tradeId);
    if (!trade) throw notFound(`Trade ${tradeId}`);

    if (trade.status === 'unwound') {
      return {
        chain: 'hedera',
        state: 'released',
        holdId: trade.holdId,
        transactionId: trade.assetTxId,
        consensusAt: trade.assetConsensusAt === null ? null : trade.assetConsensusAt.toISOString(),
        explorerUrl: trade.assetTxId === null ? null : explorer.hederaTx(trade.assetTxId),
      };
    }
    if (trade.status === 'settled') {
      throw conflict('conflict', 'A settled trade cannot be unwound; it is a new sale.');
    }

    let transactionId = trade.assetTxId;
    let consensusAt = trade.assetConsensusAt?.toISOString() ?? null;

    if (trade.holdId !== null) {
      const invoice = await store.getInvoice(trade.invoiceId);
      const seller = await store.getSeller(trade.sellerId);
      const released = await getAtsAdapter().releaseHold({
        securityId: invoice?.securityId ?? '',
        holderEvmAddress: accountIdToEvmAddress(seller?.hederaAccountId),
        holdId: trade.holdId,
        units: 1n,
      });
      transactionId = released.transactionId;
      consensusAt = released.consensusAt;
    }

    await store.release(trade.mandateId, trade.proceedsMinor);
    await store.updateTrade(trade.id, {
      status: 'unwound',
      assetTxId: transactionId,
      assetConsensusAt: consensusAt === null ? null : new Date(consensusAt),
    });
    await store.setQuoteStatus(trade.quoteId, 'expired');

    rootLogger.info('trade unwound', { tradeId, reason });

    return {
      chain: 'hedera',
      state: 'released',
      holdId: trade.holdId,
      transactionId,
      consensusAt,
      explorerUrl: transactionId === null ? null : explorer.hederaTx(transactionId),
    };
  },

  /**
   * Maturity.
   *
   * The load-bearing line is the holder lookup: settlement routes to whoever holds the
   * token **now**, read off the most recent settled trade, not to whoever bought it first.
   * Without that the paper cannot legitimately change hands, because a second buyer would
   * have no way to be paid — so this is what makes the secondary market a market rather
   * than a screen.
   *
   * The outcome (`on_time` / `late` / `default`) goes to `ratingService.recordOutcome`,
   * which is idempotent per receivable, so a replayed maturity event cannot tighten or
   * mark a rating twice.
   *
   * **The cash leg comes back `pending`, deliberately.** The debtor's payment is the money
   * that settles a matured receivable, and there is no debtor payment rail in this build.
   * The requirement is built and addressed to the current holder; reporting it as
   * `settled` would put a payment on the proof view that nobody made. A Hedera Scheduled
   * Transaction is the right fit for the payout when there is one — one-shot maturity
   * settlement is exactly what `ScheduleCreateTransaction` is for, and it is not a
   * streaming primitive.
   */
  async settleAtMaturity(invoiceId) {
    const store = getStore();
    const invoice = await store.getInvoice(invoiceId);
    if (!invoice) throw notFound(`Invoice ${invoiceId}`);

    const trades = await store.listTrades({ status: 'settled', limit: 200 });
    const holderTrade = trades
      .filter((t) => t.invoiceId === invoiceId)
      .sort((a, b) => (b.settledAt?.getTime() ?? 0) - (a.settledAt?.getTime() ?? 0))[0];
    if (!holderTrade) {
      throw conflict('conflict', `Invoice ${invoiceId} has never settled, so nothing matures.`);
    }

    const now = new Date();
    const graceEnd = new Date(invoice.dueAt.getTime() + ON_TIME_GRACE_DAYS * 86_400_000);
    const outcome: SettlementOutcome = now.getTime() <= graceEnd.getTime() ? 'on_time' : 'late';

    await ratingService.recordOutcome({
      debtorId: invoice.debtorId,
      invoiceId,
      outcome,
      faceValue: invoice.faceValue,
      at: now,
    });

    // The capital comes back to the mandate, which is what lets an `exhausted` bid quote
    // again rather than sitting on the book with nothing behind it.
    await store.release(holderTrade.mandateId, holderTrade.proceedsMinor);
    await store.updateInvoice(invoiceId, { status: 'matured' });

    const holder = await store.getBuyer(holderTrade.buyerId);
    const challenge = await getX402Client().buildRequirements({
      amountMinor: invoice.faceValue,
      currencyDecimals: CURRENCY_DECIMALS[invoice.currency as Currency] ?? 2,
      resource: tradeResourceUrl(holderTrade.id),
      description:
        `Maturity of receivable ${invoiceId}: face ${invoice.faceValue} payable to the ` +
        `current holder ${holder?.name ?? holderTrade.buyerId}.`,
    });

    return {
      tradeId: holderTrade.id,
      assetLeg: {
        chain: 'hedera',
        state: 'settled',
        holdId: holderTrade.holdId,
        transactionId: holderTrade.assetTxId,
        consensusAt: holderTrade.assetConsensusAt?.toISOString() ?? null,
        explorerUrl:
          holderTrade.assetTxId === null ? null : explorer.hederaTx(holderTrade.assetTxId),
      },
      cashLeg: {
        chain: challenge.accepted.network.startsWith('hedera') ? 'hedera' : 'arc',
        scheme: 'x402',
        state: 'pending',
        asset: challenge.accepted.asset,
        amountMinor: invoice.faceValue.toString(10),
        transaction: null,
        payer: null,
        explorerUrl: null,
      },
      settledAt: now.toISOString(),
    };
  },
};

/** Explorer link for a cash-leg reference, chosen by the network the leg settled on. */
const explorerFor = (network: string, reference: string): string =>
  network.startsWith('hedera') ? explorer.hederaTx(reference) : explorer.arcTx(reference);
