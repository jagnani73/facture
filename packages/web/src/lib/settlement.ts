/**
 * Where a trade actually got to.
 *
 * Delivery versus payment has more states than "done" and "not done", and two of them
 * matter enough to have names on screen:
 *
 * - **`awaiting_payment`** — the asset leg is held on Hedera and the cash leg has not been
 *   signed. Nothing has moved. A screen that calls this "sold" is claiming a settlement
 *   that has not happened.
 * - **`half_settled`** — the cash leg settled and the asset leg did not. The venue answers
 *   500 here and deliberately does *not* unwind, because releasing a hold against a payment
 *   that actually happened turns a reconcilable state into a lost one. The money moved.
 *   This is the one state that must never be rendered as a generic failure.
 *
 * Derived from the leg states first, because both data sources have them and because the
 * legs are what a half-settled trade is *made of* — the venue's own `status` for that state
 * is `failed`, which is true of the trade and misleading about the cash. The venue's status
 * is preferred only where the legs do not already answer, which is where it separates
 * `preparing` from `awaiting_payment`.
 */

import type { SettlementLeg, Trade } from '@/lib/domain';
import type { TradeRecord } from '@/lib/api/contract';

export type SettlementState =
  'preparing' | 'awaiting_payment' | 'settled' | 'half_settled' | 'unwound' | 'failed';

const isSettled = (leg: SettlementLeg): boolean => leg.state === 'settled';

export function settlementStateOf(trade: TradeRecord | Trade): SettlementState {
  const asset = trade.assetLeg;
  const cash = trade.cashLeg;

  // Checked before anything else, including the venue's own status: a trade the venue calls
  // `failed` whose cash leg settled is the dangerous state, not an ordinary failure.
  if (isSettled(asset) !== isSettled(cash)) return 'half_settled';
  if (isSettled(asset) && isSettled(cash)) return 'settled';

  const status = (trade as TradeRecord).status;
  if (status === 'unwound') return 'unwound';
  if (status === 'failed') return 'failed';
  if (status === 'awaiting_payment') return 'awaiting_payment';
  if (status === 'preparing') return 'preparing';

  if (asset.state === 'failed' || cash.state === 'failed') return 'failed';
  if (asset.state === 'released' || cash.state === 'released') return 'unwound';
  if (asset.state === 'held') return 'awaiting_payment';
  return 'preparing';
}

/** Only a settled trade is a sale. Everything else is a trade that is still an attempt. */
export const isSettledTrade = (trade: TradeRecord | Trade): boolean =>
  settlementStateOf(trade) === 'settled';

/** The money moved and the paper did not. Alarm, never retry quietly. */
export const isHalfSettledTrade = (trade: TradeRecord | Trade): boolean =>
  settlementStateOf(trade) === 'half_settled';

/** Which leg got there, for a sentence that names the one that did not. */
export function halfSettledLegs(trade: TradeRecord | Trade): {
  moved: 'cash' | 'asset';
  stalled: 'cash' | 'asset';
} {
  return trade.cashLeg.state === 'settled'
    ? { moved: 'cash', stalled: 'asset' }
    : { moved: 'asset', stalled: 'cash' };
}

/** One clause per state, for a pill or a caption. */
export const SETTLEMENT_STATE_LABEL: Record<SettlementState, string> = {
  preparing: 'Being arranged',
  awaiting_payment: 'Paper held, awaiting payment',
  settled: 'Settled',
  half_settled: 'Half-settled — being reconciled',
  unwound: 'Unwound, nothing moved',
  failed: 'Did not go through',
};

/** The same states, in a sentence a seller can act on. */
export const SETTLEMENT_STATE_SENTENCE: Record<SettlementState, string> = {
  preparing: 'This sale is being arranged. Neither leg has been committed.',
  awaiting_payment:
    'The paper is held and the buyer has been asked to sign the cash leg. Neither leg settles unless both do, and if the payment never arrives the hold expires and the position was never encumbered.',
  settled: 'Both legs settled. Delivery against payment, in one step, with nothing held back.',
  half_settled:
    'The payment settled and the security did not transfer. The money moved. This is being reconciled and the hold is deliberately not released, because releasing it against a payment that happened would turn a recoverable state into a lost one.',
  unwound:
    'The cash leg did not settle, so the hold was released. Nothing moved and the position was never encumbered for longer than the challenge window.',
  failed: 'This sale did not go through, and nothing moved.',
};

/**
 * The same ending, reached without a challenge.
 *
 * A sale settled out of the buyer's escrowed capital is `settled` like any other, so it is
 * not a sixth state — but the sentence above describes an x402 exchange that did not happen
 * here, and it stops short of the one fact this seller most needs: the money is in an escrow
 * they still have to claim, and it does not wait forever.
 *
 * Kept out of `SETTLEMENT_STATE_SENTENCE` deliberately. That table is keyed by state, and
 * adding a rail to its keys would make every consumer handle a state the venue never emits.
 */
export const SETTLED_FROM_ESCROW_SENTENCE =
  'Both legs settled. The buyer had already escrowed this capital on Arc, so there was ' +
  'nothing for them to sign — the payout is locked for you in the escrow and you claim it ' +
  'with the key that holds the paper.';
