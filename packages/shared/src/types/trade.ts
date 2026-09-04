import type { Bps, Currency, IsoDateTime, MinorUnits } from './common.js';

/**
 * State of one leg of a cross-chain delivery-versus-payment.
 *
 * Neither party moves first: the asset leg is *held* on Hedera and the cash leg is *held*
 * as an x402 payment signature on Arc, and the facilitator releases both or neither. So a
 * leg has a `held` state distinct from `settled`, and a failure has to be able to `released`
 * the other side rather than leaving it stranded.
 *
 * - `pending`   not yet submitted
 * - `held`      committed and escrowed, awaiting the other leg
 * - `settled`   released to the counterparty — terminal for a successful trade
 * - `released`  unwound because the other leg failed; value returned to its owner
 * - `failed`    could not be committed at all
 */
export const SETTLEMENT_LEG_STATES = ['pending', 'held', 'settled', 'released', 'failed'] as const;

export type SettlementLegState = (typeof SETTLEMENT_LEG_STATES)[number];

export interface SettlementLeg {
  readonly state: SettlementLegState;
  /** Chain key from `src/chains`. Never a bare string. */
  readonly chain: string;
  /**
   * EVM tx hash, Hedera transaction id (`0.0.x@seconds.nanos`) or x402 settlement reference,
   * depending on the leg. Deliberately a plain string — the three forms do not share a shape,
   * and the `chain` field is what says which to expect.
   */
  readonly reference?: string | undefined;
  readonly updatedAt?: IsoDateTime | undefined;
  /** Why the leg failed, when it did. Human-readable. */
  readonly failureReason?: string | undefined;
}

/**
 * A matched and executed sale. Price fields are frozen copies of the accepted quote rather
 * than references to it, because a mandate's bid can move afterwards and a trade may not.
 *
 * The same shape covers the primary sale and every secondary sale of the same paper —
 * `sellerId` is simply the current holder. That is the "one book, two lives" claim, and it
 * would be broken by a separate `SecondaryTrade` type.
 */
export interface Trade {
  readonly id: string;
  readonly invoiceId: string;
  readonly mandateId: string;
  /** Whoever held the paper going in — the originating seller, or a prior buyer. */
  readonly sellerId: string;
  readonly buyerId: string;

  readonly faceValue: MinorUnits;
  readonly annualisedYieldBps: Bps;
  readonly tenorDays: number;
  readonly discount: MinorUnits;
  /** What the seller received. Full advance — there is no holdback. */
  readonly proceeds: MinorUnits;
  readonly currency: Currency;

  /** Delivery: the ATS bond moving on Hedera. */
  readonly assetLeg: SettlementLeg;
  /** Payment: USDC moving on Arc. */
  readonly cashLeg: SettlementLeg;

  readonly executedAt: IsoDateTime;
  /** Set only once both legs are `settled`. */
  readonly settledAt?: IsoDateTime | undefined;
}

/** DvP is complete only when both legs settled. Either one alone is not a trade. */
export const isSettled = (t: Trade): boolean =>
  t.assetLeg.state === 'settled' && t.cashLeg.state === 'settled';

/** One leg failed. The other must be released rather than left held. */
export const isFailed = (t: Trade): boolean =>
  t.assetLeg.state === 'failed' || t.cashLeg.state === 'failed';

/**
 * The dangerous state: one leg is settled and the other is not. Should never persist, and
 * anything observing it should alarm rather than retry quietly.
 */
export const isHalfSettled = (t: Trade): boolean =>
  (t.assetLeg.state === 'settled') !== (t.cashLeg.state === 'settled');
