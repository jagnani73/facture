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
import { getScheduleAdapter } from './schedule.js';
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
  /*
   * There is deliberately no `unitsMinor` here. The size of the trade is the seller's
   * whole position, which is a fact about the instrument rather than something a caller
   * gets to assert — `prepare` reads it with `balanceOf` and writes it onto the trade.
   * Passing it in is how it came to be `1n` against a security carrying 6,230,000 units.
   */
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
  /**
   * Units of the security this leg moves — the seller's whole position, as a decimal
   * string. On the proof view it is the number a reader can check against the transfer on
   * HashScan, which is the whole point of putting it there.
   */
  unitsMinor: string | null;
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

/**
 * The scheduled payout for a matured receivable, with somewhere to go and look at it.
 *
 * Wider than the rail's own `MaturityPayoutReceipt` because a replay answers from the stored
 * schedule id rather than from the ledger. The id and the explorer link are always known;
 * the details of the `ScheduleCreate` that produced it are only known to the call that made
 * it, and re-reading them would be a paid query to restate something already recorded.
 */
export interface MaturityPayoutLeg {
  scheduleId: string;
  transactionId: string | null;
  consensusAt: string | null;
  payerAccountId: string | null;
  payeeAccountId: string | null;
  amountMinor: string;
  executed: boolean;
  explorerUrl: string;
}

export interface MaturityResult extends SettlementResult {
  /** Who the face value is owed to: whoever holds the paper now. */
  holder: { buyerId: string; mandateId: string; name: string | null };
  /**
   * The obligation, as an on-chain object: a Hedera Scheduled Transaction paying the face
   * value from the venue's collection account to the current holder.
   *
   * `null` when no collection account is configured, which is the truthful answer for a
   * deployment with no rail rather than a reason to fail. It is created **unsigned** — the
   * signature is the venue's statement that the debtor's money arrived, and maturity is not
   * that statement.
   */
  payout: MaturityPayoutLeg | null;
  /**
   * Why there is no payout, when there should have been one.
   *
   * Separate from `payout: null` on purpose. A deployment with no collection account and a
   * deployment whose scheduling call failed are not the same fact, and collapsing them
   * would turn a broken rail into a configuration that merely looks quiet.
   */
  payoutError: string | null;
  /** How the receivable resolved, as it was written to the settlement-outcome ledger. */
  outcome: SettlementOutcome;
  /**
   * True when this receivable was already in the ledger, so this call changed nothing.
   *
   * Maturity is observable twice — a mirror-node replay, a retried scheduled transaction,
   * an operator pressing the button again — and a replay must not tighten a rating or hand
   * the mandate its capital back a second time.
   */
  alreadyRecorded: boolean;
}

/** One expired armed trade, and what unwinding it gave back. */
export interface ReclaimedTrade {
  tradeId: string;
  mandateId: string;
  /** Capital returned to the mandate, minor units. */
  releasedMinor: string;
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
   * Unwind every armed trade whose challenge window has passed. Safe to call on any path.
   */
  reclaimExpired(at?: Date): Promise<ReclaimedTrade[]>;
  /**
   * Maturity. The debtor pays and settlement routes to whoever holds the token NOW, not
   * whoever bought it first. Without this the paper cannot legitimately change hands,
   * because a second buyer would have no way to be paid.
   */
  settleAtMaturity(invoiceId: string): Promise<MaturityResult>;
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

/**
 * A receivable paid within this many days of the due DATE still counts as on time.
 *
 * Zero, and the day itself is not the grace: `due_at` is an instant at the start of the
 * due date, so a debtor paying at nine in the morning on the day the invoice falls due was
 * previously recorded as late. "Due on the 12th" means any time on the 12th, and a rating
 * mark is permanent — an off-by-one-day here widens a customer's curve for every seller
 * afterwards for a payment that was on time.
 */
const ON_TIME_GRACE_DAYS = 0;

const DAY_MS = 86_400_000;

/** The last instant that still counts as paying on time. */
const onTimeDeadline = (dueAt: Date): Date =>
  new Date(dueAt.getTime() + (ON_TIME_GRACE_DAYS + 1) * DAY_MS - 1);

/**
 * How many expired trades one reclaim pass unwinds.
 *
 * Bounded because the pass runs on request paths: a backlog is worked off over several
 * requests rather than turning one of them into a long chain of Hedera submissions.
 */
const RECLAIM_BATCH = 25;

/**
 * Slack between the challenge dying and the trade being reclaimed.
 *
 * Expiry is measured from the trade row's `created_at`, which is stamped a moment *before*
 * the challenge is built — arming reads the position and submits a hold to Hedera in
 * between, and that is seconds, not milliseconds. Without this grace the cutoff would sit
 * marginally earlier than the challenge the payer was actually given, so a buyer signing
 * at the very end of their window could lose the trade to a reclaim. Erring late costs a
 * little stale capital; erring early cancels a live payment.
 */
const RECLAIM_GRACE_SECONDS = 30;

/**
 * How old an armed trade has to be before it is reclaimable, from `created_at`.
 *
 * Exported so a test measures the same boundary the service does rather than restating it.
 */
export const EXPIRED_AFTER_SECONDS = CHALLENGE_WINDOW_SECONDS + RECLAIM_GRACE_SECONDS;

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
    const ats = getAtsAdapter();
    const expiresAt = new Date(Date.now() + CHALLENGE_WINDOW_SECONDS * 1000);

    /*
     * Hedera addresses, not Arc ones. `buyerArcAddress` on the intent is where the cash
     * leg pays; the security never leaves Hedera, so the hold's `to` is the buyer's Hedera
     * account in its EVM form. Mixing the two would deliver the paper to an address that
     * does not exist on the chain holding it.
     */
    const sellerEvmAddress = accountIdToEvmAddress(intent.sellerHederaAccountId);

    /*
     * The size of the trade, read off the instrument rather than assumed.
     *
     * "Whole position" has to mean the whole position. Issuance mints face-value-many
     * units, so the earlier hardcoded `1n` sold one unit in millions and left the seller
     * holding paper they had been paid for. Partial sales are cut-list item 4 and are
     * genuinely out of scope, which makes this an all-or-nothing sale — but all-or-nothing
     * of the *balance*, not of an assumed unit.
     *
     * Read before the hold, because a hold moves units out of the free balance and the
     * same call afterwards answers a smaller number.
     */
    const position = await ats.balanceOf({
      securityId: intent.securityId,
      ownerEvmAddress: sellerEvmAddress,
    });
    if (position <= 0n) {
      /*
       * A zero-unit transfer would "settle" and deliver nothing, which is worse than not
       * trading: the buyer pays and the proof view shows a transfer of nothing. Refused
       * with the reason named, before the hold and before any payment challenge exists.
       */
      throw conflict(
        'conflict',
        `The seller holds no units of ${intent.securityId}, so there is no position to ` +
          'sell. Either the instrument has not been issued to them yet, or it has ' +
          'already been sold.',
      );
    }

    const hold = await ats.createHold({
      securityId: intent.securityId,
      holderEvmAddress: sellerEvmAddress,
      toEvmAddress: accountIdToEvmAddress(intent.buyerHederaAccountId),
      // The venue is the escrow agent for the challenge window, and nothing longer.
      escrowEvmAddress: operatorEvmAddress(getConfig().env.HEDERA_OPERATOR_KEY),
      units: position,
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
      // Persisted, not re-read: `executeHoldByPartition` and `releaseHoldByPartition` have
      // to name the amount the hold was created for, and the balance has moved by then.
      unitsMinor: position,
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
        unitsMinor: position.toString(10),
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
    /*
     * Checked here, before `verify` and `settle`, and not next to the hold execution it
     * guards. The units are what the delivery is made in, and discovering they are unknown
     * after the cash leg has cleared would manufacture the half-settled state on purpose.
     */
    const units = trade.unitsMinor;
    if (units === null || units <= 0n) {
      throw conflict(
        'conflict',
        'This trade does not record how many units it moves, so the security cannot be ' +
          'delivered. Unwind it and arm it again.',
      );
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
        units,
      });
      assetLeg = {
        chain: 'hedera',
        state: 'settled',
        holdId: trade.holdId,
        unitsMinor: units.toString(10),
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
        unitsMinor: trade.unitsMinor?.toString(10) ?? null,
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
      /*
       * A hold can only be released for the amount it was created for, so a trade that
       * carries a hold but no unit count cannot be unwound honestly. Refused rather than
       * released for a guessed amount or marked unwound with the hold still standing —
       * either would leave the ledger and the chain disagreeing about who owns the paper.
       * No trade this build arms can be in that state; the column is nullable only for
       * rows written before it existed, all of which are terminal.
       */
      if (trade.unitsMinor === null) {
        throw conflict(
          'conflict',
          `Trade ${trade.id} holds ${trade.holdId} but does not record its size, so the ` +
            'hold cannot be released for the right amount. It expires on its own at the ' +
            'end of the challenge window.',
        );
      }
      const invoice = await store.getInvoice(trade.invoiceId);
      const seller = await store.getSeller(trade.sellerId);
      const released = await getAtsAdapter().releaseHold({
        securityId: invoice?.securityId ?? '',
        holderEvmAddress: accountIdToEvmAddress(seller?.hederaAccountId),
        holdId: trade.holdId,
        units: trade.unitsMinor,
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

    rootLogger.info('trade unwound', {
      tradeId,
      reason,
      releasedMinor: trade.proceedsMinor.toString(10),
      mandateId: trade.mandateId,
    });

    return {
      chain: 'hedera',
      state: 'released',
      holdId: trade.holdId,
      unitsMinor: trade.unitsMinor?.toString(10) ?? null,
      transactionId,
      consensusAt,
      explorerUrl: transactionId === null ? null : explorer.hederaTx(transactionId),
    };
  },

  /**
   * Reclaim armed trades whose challenge window has passed.
   *
   * ## Lazily, on the paths that care — not on a timer
   *
   * An armed trade that is never paid holds the mandate's capital and the seller's
   * position for as long as nobody looks. Something has to end it, and the two options are
   * a background sweep and reclaiming lazily when the state is next read. This is the lazy
   * one, called from the trade and mandate routes.
   *
   * The argument for it over a timer:
   *
   * - **Stale capital is only wrong when someone asks.** The whole cost of an expired
   *   trade is that a mandate looks fuller than it is, and that is only ever observed by
   *   arming a trade, listing positions, or reading the capital views. Reclaiming there
   *   means the number is never stale at the moment it is used, which a timer can only
   *   approximate by running often enough.
   * - **Nothing in this process schedules work.** The only timer here is the issuance
   *   queue's backoff, and a second one would need start/stop wiring through `index.ts`,
   *   would keep the process alive at shutdown, and would fire inside tests that freeze the
   *   clock. A sweep also does the same writes; it just does them when nobody asked.
   * - **The window is {@link EXPIRED_AFTER_SECONDS} seconds, not a day.** Reclaiming on
   *   the next request cannot be meaningfully later than a sweep unless there are no
   *   requests at all — and with no requests there is nobody the capital is stuck from.
   *
   * What this costs, stated plainly: a request that happens to find expired trades pays
   * for their `releaseHoldByPartition` submissions, so it is slower than one that does not.
   * That is bounded by {@link RECLAIM_BATCH}, and it is the same work a sweep would do.
   *
   * Reads deliberately not hooked: the quote and book screens. They are polled, they must
   * stay free of chain writes, and a mandate that looks fuller than it is can only quote
   * *wide* — never through capital it does not have. Arming re-prices against the live
   * curve after reclaiming, so nothing can be filled against a stale allocation.
   *
   * One trade failing to unwind must not take the request with it: the failure is logged
   * against that trade and the rest of the batch continues.
   */
  async reclaimExpired(at = new Date()) {
    const store = getStore();
    const expiredBefore = new Date(at.getTime() - EXPIRED_AFTER_SECONDS * 1000);
    const stale = await store.listArmedTradesOlderThan(expiredBefore, RECLAIM_BATCH);

    const reclaimed: ReclaimedTrade[] = [];
    for (const trade of stale) {
      try {
        await settlementService.unwind(trade.id, 'challenge window expired');
        reclaimed.push({
          tradeId: trade.id,
          mandateId: trade.mandateId,
          releasedMinor: trade.proceedsMinor.toString(10),
        });
      } catch (err) {
        rootLogger.warn('expired trade could not be reclaimed', { tradeId: trade.id, err });
      }
    }
    if (reclaimed.length > 0) {
      rootLogger.info('reclaimed expired trades', { count: reclaimed.length });
    }
    return reclaimed;
  },

  /**
   * Maturity.
   *
   * The load-bearing line is the holder lookup: settlement routes to whoever holds the
   * token **now** — the most recently settled trade on this receivable — not to whoever
   * bought it first. Without that the paper cannot legitimately change hands, because a
   * second buyer would have no way to be paid, so this is what makes the secondary market
   * a market rather than a screen.
   *
   * **Idempotent through the settlement-outcome ledger.** The ledger's unique index on
   * `(debtor_id, invoice_id)` is the fact; everything else here is a consequence of
   * writing it. A replay therefore cannot tighten a rating twice, and — the part that used
   * to be missing — cannot hand the mandate its capital back twice either.
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

    /*
     * Every settled trade on THIS receivable, newest first — an indexed read scoped to the
     * invoice rather than a page of the whole book filtered in memory. The old form asked
     * for 200 trades of any invoice and hoped this one was among them, which on a busy
     * book silently matures nothing while reporting that the invoice never sold.
     */
    const settled = await store.listTrades({ invoiceId, status: 'settled', limit: 50 });
    const holderTrade = [...settled].sort(
      (a, b) => (b.settledAt?.getTime() ?? 0) - (a.settledAt?.getTime() ?? 0),
    )[0];
    if (!holderTrade) {
      throw conflict('conflict', `Invoice ${invoiceId} has never settled, so nothing matures.`);
    }

    const now = new Date();
    const outcome: SettlementOutcome =
      now.getTime() <= onTimeDeadline(invoice.dueAt).getTime() ? 'on_time' : 'late';

    const { alreadyRecorded } = await ratingService.recordOutcome({
      debtorId: invoice.debtorId,
      invoiceId,
      outcome,
      faceValue: invoice.faceValue,
      at: now,
    });

    /*
     * The ledger write is the first of two steps and the invoice status is the marker for
     * the second, so a replay finishes the job rather than repeating it or abandoning it.
     *
     * - not recorded before -> do both.
     * - recorded, invoice already `matured` -> nothing to do; this is the ordinary replay.
     * - recorded, invoice NOT `matured` -> a previous run died between the two. The capital
     *   was never released, so releasing it now is a repair and not a double release.
     */
    const finished = alreadyRecorded && invoice.status === 'matured';
    if (!finished) {
      // The capital comes back to the mandate, which is what lets an `exhausted` bid quote
      // again rather than sitting on the book with nothing behind it.
      await store.release(holderTrade.mandateId, holderTrade.proceedsMinor);
      await store.updateInvoice(invoiceId, { status: 'matured' });
    }

    /*
     * Only the current holder's mandate is released here, because only the current holder
     * is owed anything at maturity. An earlier holder was paid by the buyer who took the
     * paper off them, and it is that resale which owes them their capital back — not this.
     * There is no resale path in this build (a `sold` invoice is unquotable), so today
     * "current holder" and "only holder" coincide; when relisting lands, `execute` is where
     * the previous holder's allocation has to be freed.
     */

    const holder = await store.getBuyer(holderTrade.buyerId);
    const challenge = await getX402Client().buildRequirements({
      amountMinor: invoice.faceValue,
      currencyDecimals: CURRENCY_DECIMALS[invoice.currency as Currency] ?? 2,
      resource: tradeResourceUrl(holderTrade.id),
      description:
        `Maturity of receivable ${invoiceId}: face ${invoice.faceValue} payable to the ` +
        `current holder ${holder?.name ?? holderTrade.buyerId}.`,
    });

    /*
     * The obligation becomes an on-chain object here.
     *
     * Scheduled last, and deliberately after the ledger write and the capital release: a
     * receivable has matured whether or not a payout could be arranged, and a rail that is
     * down must not be able to un-mature it or strand a mandate's capital. So a failure
     * here is reported, not thrown — the alternative is an endpoint that half-succeeds and
     * says nothing, which is the shape of bug this whole path is careful about.
     *
     * The amount goes through the same conversion the trade's cash leg used, so the two
     * legs of one receivable cannot disagree about what a unit of its currency settles as.
     */
    const payoutAmount = getX402Client().settlementAmount(
      invoice.faceValue,
      CURRENCY_DECIMALS[invoice.currency as Currency] ?? 2,
    );

    let payout: MaturityPayoutLeg | null = null;
    let payoutError: string | null = null;

    if (holderTrade.maturityScheduleId !== null) {
      /*
       * Already arranged. Reported rather than repeated: a second schedule against one
       * receivable is a second claim on the same face value, and the venue would have two
       * obligations on the ledger with no way to tell which one it meant. The stored id is
       * the record of the first, which is the one to sign or delete.
       */
      payout = {
        scheduleId: holderTrade.maturityScheduleId,
        transactionId: null,
        consensusAt: null,
        payerAccountId: null,
        payeeAccountId: holder?.hederaAccountId ?? null,
        amountMinor: payoutAmount.toString(10),
        executed: false,
        explorerUrl: explorer.hederaSchedule(holderTrade.maturityScheduleId),
      };
    } else {
      try {
        const receipt = await getScheduleAdapter().schedulePayout({
          invoiceId,
          tradeId: holderTrade.id,
          payeeAccount: holder?.hederaAccountId ?? '',
          amountMinor: payoutAmount,
        });
        if (receipt !== null) {
          /*
           * Written before the result is returned, so a caller that retries after a dropped
           * connection finds the schedule rather than making another one. The schedule
           * already exists on the ledger at this point; losing its id here is the failure
           * that costs a duplicate obligation.
           */
          await store.updateTrade(holderTrade.id, { maturityScheduleId: receipt.scheduleId });
          payout = { ...receipt, explorerUrl: explorer.hederaSchedule(receipt.scheduleId) };
        }
      } catch (err) {
        payoutError = err instanceof Error ? err.message : String(err);
        rootLogger.error('maturity payout could not be scheduled', {
          invoiceId,
          tradeId: holderTrade.id,
          err,
        });
      }
    }

    rootLogger.info('receivable matured', {
      invoiceId,
      tradeId: holderTrade.id,
      holder: holderTrade.buyerId,
      outcome,
      alreadyRecorded,
      scheduleId: payout?.scheduleId ?? null,
    });

    return {
      tradeId: holderTrade.id,
      holder: {
        buyerId: holderTrade.buyerId,
        mandateId: holderTrade.mandateId,
        name: holder?.name ?? null,
      },
      outcome,
      alreadyRecorded,
      assetLeg: {
        chain: 'hedera',
        state: 'settled',
        holdId: holderTrade.holdId,
        unitsMinor: holderTrade.unitsMinor?.toString(10) ?? null,
        transactionId: holderTrade.assetTxId,
        consensusAt: holderTrade.assetConsensusAt?.toISOString() ?? null,
        explorerUrl:
          holderTrade.assetTxId === null ? null : explorer.hederaTx(holderTrade.assetTxId),
      },
      /*
       * `pending`, with no transaction and no explorer link — and that stays true even when
       * a payout was scheduled, because a schedule is an obligation rather than a payment.
       * It executes when the collection key signs, which is the venue's statement that the
       * debtor's money arrived; until then nobody has been paid and this leg must not say
       * otherwise on the one screen whose whole job is to be checkable.
       *
       * What changed is that `pending` now has something behind it. `payout` carries the
       * schedule id, so a holder can read the obligation on the mirror node instead of
       * taking our word that they are owed something.
       */
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
      payout,
      payoutError,
      settledAt: now.toISOString(),
    };
  },
};

/** Explorer link for a cash-leg reference, chosen by the network the leg settled on. */
const explorerFor = (network: string, reference: string): string =>
  network.startsWith('hedera') ? explorer.hederaTx(reference) : explorer.arcTx(reference);
