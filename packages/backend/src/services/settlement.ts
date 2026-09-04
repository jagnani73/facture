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

import type { SettlementLegState } from '@facture/shared';
import { notImplemented } from '../errors.js';
import type { PaymentRequirements } from './x402.js';

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

export const settlementService: SettlementService = {
  async prepare(intent) {
    // TODO: (a) `createHoldByPartition` on the security for `unitsMinor`, expiring at the
    // challenge window; (b) `x402Client.buildRequirements` for `proceedsMinor`, resource
    // = the trade URL. The hold id goes on the trade row so `unwind` can find it after a
    // restart.
    throw notImplemented(`DvP preparation for trade ${intent.tradeId}`);
  },

  async execute(input) {
    // TODO: `verify` then `settle` through the facilitator; on success execute the hold
    // so the security lands with the buyer, and write both legs onto the trade row in one
    // transaction. If `settle` succeeds and the hold execution then fails, that is the
    // one genuinely bad state — record it loudly and reconcile out of band rather than
    // swallowing it.
    throw notImplemented(`DvP execution for trade ${input.tradeId}`);
  },

  async unwind(tradeId, _reason) {
    // TODO: `releaseHold` and mark the trade abandoned. Safe to call twice.
    throw notImplemented(`DvP unwind for trade ${tradeId}`);
  },

  async settleAtMaturity(invoiceId) {
    // TODO: read the CURRENT holder off the security, not the original buyer, then pay
    // out and hand the outcome (on_time | late | default) to `ratingService.recordOutcome`.
    // A Scheduled Transaction is a correct fit here — one-shot maturity settlement is
    // exactly what `ScheduleCreateTransaction` is for. It is not a streaming primitive
    // and must not be described as one.
    throw notImplemented(`maturity settlement for invoice ${invoiceId}`);
  },
};
