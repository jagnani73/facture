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

import { randomBytes } from 'node:crypto';
import type { Currency, Rating, SettlementLegState } from '@facture/shared';
import { CURRENCY_DECIMALS, transitionInvoice } from '@facture/shared';
import { keccak256 } from 'viem';
import { explorer } from '../chain.js';
import { getConfig } from '../config.js';
import { transitionTo } from '../db/status.js';
import { getStore } from '../db/store.js';
import { badRequest, conflict, internalError, notFound, upstreamUnavailable } from '../errors.js';
import { rootLogger } from '../logger.js';
import { getArcEscrow } from './arc.js';
import { publishMatch } from './hcs.js';
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
  /** The accepted quote. Marked taken once both legs are done, on either rail. */
  quoteId: string;
  /** Carried so a settled match can be committed to consensus without re-reading the row. */
  buyerId: string;
  sellerId: string;
  /** ATS security for this invoice, native id `0.0.x`. */
  securityId: string;
  sellerHederaAccountId: string;
  /**
   * Where a vault payout lands. Bound into `registerMatch` and unchangeable afterwards, so
   * an address nobody controls is a sale that settles and pays nobody.
   */
  sellerArcAddress: string | null;
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

/**
 * Which rail carried the cash.
 *
 * `x402` is a payment the buyer signs, per trade, on Hedera. `arc-vault` draws on capital the
 * buyer escrowed in `MandateVault` before any of these invoices existed — no per-trade
 * signature, because a funded mandate already said yes to anything meeting its terms. That is
 * what "firm bid" means, and it is why the two rails are not two ways of doing one thing.
 */
export type CashRail = 'x402' | 'arc-vault';

/** Cash leg. `transaction` is the facilitator's reference, or the Arc payout transaction. */
export interface CashLegReceipt {
  chain: 'arc' | 'hedera';
  /**
   * Stated, never inferred. This used to be reconstructed from `network.startsWith('hedera')`
   * in two places, which defaulted an unsettled trade to Arc and left two copies of one guess
   * free to drift apart.
   */
  rail: CashRail;
  scheme: string;
  state: LegState;
  asset: string;
  /**
   * The trade's price in INVOICE currency minor units — US cents, not the asset's units.
   * Kept under this name because every consumer already reads it as the price.
   */
  amountMinor: string;
  /**
   * What actually moved, in the settlement asset's own minor units: tinybars on Hedera, USDC
   * minor units on Arc, both after `X402_SETTLEMENT_SCALE_PPM`. The receipt used to show
   * `$59,331.78` beside a transaction that moved 0.059331 USDC, with nothing naming the
   * second figure — so the one number a reader could check was the one nobody wrote down.
   */
  settledAmountMinor: string | null;
  transaction: string | null;
  payer: string | null;
  explorerUrl: string | null;
  /**
   * Arc only. The escrow lock the payout opened, and whether the seller has taken it.
   *
   * A payout puts the money in `DvpEscrow` claimable by the seller alone for 24 hours; it
   * does not put it in the seller's wallet. Reporting a settled cash leg without saying that
   * would be reporting a payment that has not happened yet.
   */
  lock: CashLegLock | null;
}

/** The Arc escrow lock behind a vault payout. */
export interface CashLegLock {
  lockId: string;
  /** `locked` until the seller claims, then `claimed`. `refunded` if it timed out. */
  status: string;
  /** The preimage that releases it. Public the moment the seller claims — not a credential. */
  secret: string;
  /** Unix seconds. Claiming is permitted strictly before this. */
  claimableUntil: number | null;
  beneficiary: string | null;
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
  /** Read off the ledger on every call, never remembered — see `payoutStatus`. */
  executed: boolean;
  /** When the holder was actually paid. Null until the collection key signs. */
  executedAt: string | null;
  /** The transfer that paid them, `0.0.x@seconds.nanos`. */
  executedTransactionId: string | null;
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
   * When the debtor's money landed, as the ledger holds it — the date {@link outcome} was
   * decided against.
   *
   * Read back rather than echoed from the caller, because the two disagree on exactly the
   * call where a reader most needs them not to. A replay reports the ledger's `on_time`, and
   * echoing the request's `paidAt` beside it printed a date that would have produced `late`:
   * a receipt contradicting itself in the one field that exists to make the outcome
   * checkable. It is never null — a call that writes nothing still had a date written for
   * it, and a call that writes reports the date it wrote.
   */
  paidAt: string;
  /**
   * True when this receivable was already in the ledger, so this call changed nothing.
   *
   * Maturity is observable twice — a mirror-node replay, a retried scheduled transaction,
   * an operator pressing the button again — and a replay must not tighten a rating or hand
   * the mandate its capital back a second time.
   */
  alreadyRecorded: boolean;
}

/**
 * When the debtor's money landed in the venue's collection account.
 *
 * The one input the on-time/late distinction takes, and a fact only the venue holds: the
 * debtor pays off chain, by whatever rail they already use, so nothing in this service can
 * observe it. Absent means the venue has not stated it — which is a different thing from
 * "it was late", and used to be recorded as the same thing.
 */
export interface MaturityObservation {
  paidAt?: Date | undefined;
}

/**
 * A receivable that will never be paid, and what it cost.
 *
 * Deliberately not a {@link SettlementResult}: nothing settled. There are no legs, no
 * transaction and no payout, because the whole content of a default is that the money did
 * not move and is not coming.
 */
export interface DefaultResult {
  invoiceId: string;
  /** The trade that bought the paper. Whoever holds it now is who takes the loss. */
  tradeId: string;
  holder: { buyerId: string; mandateId: string; name: string | null };
  /**
   * What the holder paid and will not get back, minor units.
   *
   * Reported rather than released. See the note in `recordDefault` on why the mandate's
   * allocation stays where it is.
   */
  lossMinor: string;
  /** Face value the debtor owed and did not pay. */
  faceValueMinor: string;
  /** Always `default` — a mismatch with the ledger is refused before it gets this far. */
  outcome: SettlementOutcome;
  /**
   * True when this receivable was already in the ledger as a default, so nothing moved.
   *
   * A default is declared by a person pressing a button, and a person presses a button
   * twice. The permanent mark on the customer must land exactly once regardless.
   */
  alreadyRecorded: boolean;
  /** The customer's grade after the mark. `D`, permanently, once anything has defaulted. */
  rating: { debtorId: string; grade: Rating; permanentlyMarked: boolean; reason: string };
  /**
   * When the write-off was declared, as the ledger holds it — not when this call ran.
   *
   * On a replay those are different dates and only the first is a fact about the customer.
   * Reporting the second dated a permanent mark to whenever somebody last pressed the
   * button, which is the same defect the outcome itself was already read back to avoid.
   */
  declaredAt: string;
}

/** One expired armed trade, and what unwinding it gave back. */
export interface ReclaimedTrade {
  tradeId: string;
  mandateId: string;
  /** Capital returned to the mandate, minor units. */
  releasedMinor: string;
}

/**
 * Which rail a trade will settle on, decided before anything is armed.
 *
 * `reason` is carried because "this bid is not escrowed" and "this deployment has no vault"
 * are different facts that produce the same rail, and a demo that cannot tell them apart
 * cannot tell whether the Arc path is broken or simply not in use.
 */
export interface RailChoice {
  rail: CashRail;
  reason: string;
  /** USDC minor units the vault holds for this mandate. Null when it could not be asked. */
  depositedUsdcMinor: bigint | null;
  /** USDC minor units this trade would draw. */
  priceUsdcMinor: bigint;
}

export interface SettlementService {
  /**
   * Which rail this trade settles on.
   *
   * Arc when the mandate's escrowed capital covers the price and the seller has an address to
   * be paid at; x402 otherwise. Asked once, before arming, because the answer decides what
   * `POST /v1/trades` even returns — a challenge to sign, or a settled trade.
   */
  chooseRail(input: {
    mandateId: string;
    proceedsMinor: bigint;
    currency: string;
    sellerArcAddress: string | null;
  }): Promise<RailChoice>;
  /**
   * Settle out of the buyer's escrowed capital on Arc. One call, both legs.
   *
   * There is no challenge half because there is nothing for the buyer to sign: they escrowed
   * the capital and wrote the terms, and an invoice meeting those terms is a trade they have
   * already agreed to. A second consent would make the standing bid not standing.
   */
  settleFromVault(intent: DvpIntent): Promise<SettlementResult>;
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
  settleAtMaturity(invoiceId: string, observed?: MaturityObservation): Promise<MaturityResult>;
  /**
   * The debtor never paid, and the venue says so.
   *
   * An explicit act rather than a timer, for the same reason the payout is: a receivable
   * falling overdue is not evidence that the money is never coming, and only the venue can
   * make that call because only the venue watches the collection account. A clock that
   * defaulted customers on its own would mark them permanently for a payment three days in
   * the post.
   */
  recordDefault(invoiceId: string): Promise<DefaultResult>;
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
 * The Arc rail's (network, scheme) pair, in the same shape the x402 rail records.
 *
 * `arc:testnet` is CAIP-2 style with a colon, matching `hedera:testnet` — the web's chain
 * reconciler reads the colon form on both rails, so a hyphen here would render an Arc trade
 * as whatever the fallback is.
 *
 * The scheme is not `x402`, because this is not an x402 payment: no challenge is issued and
 * nothing is signed per trade. Calling it x402 would make the receipt claim a protocol that
 * never ran.
 */
export const ARC_NETWORK = 'arc:testnet';
export const ARC_SCHEME = 'vault-payout';

/**
 * How long the asset leg stays held on the Arc rail.
 *
 * Deliberately NOT `CHALLENGE_WINDOW_SECONDS`. That 180 seconds is sized for a human or an
 * agent to sign a challenge, and this rail issues no challenge — what has to fit inside the
 * window instead is two Arc writes and two receipt waits, back to back. Two ordinary
 * hundred-second inclusions would outlive a 180-second hold, and the hold expiring mid-flight
 * is the *cause* of the worst failure this path has: the cash is already locked and the paper
 * can no longer be delivered.
 *
 * Twelve minutes, which is longer than viem's own 180-second receipt timeout applied twice
 * with room to spare, and still far inside the escrow's 24-hour payment lock.
 */
export const VAULT_HOLD_WINDOW_SECONDS = 720;

/**
 * The preimage a seller needs to take their money.
 *
 * 32 bytes from the platform CSPRNG, because `DvpEscrow` hashes exactly `bytes32` and
 * `keccak256(abi.encodePacked(bytes32))` is the raw 32 bytes. Random rather than derived from
 * the trade id: a derivation is computable by anyone who learns it, and until the seller
 * claims, this is the only thing between an open lock and the money.
 */
const randomSecret = (): `0x${string}` => `0x${randomBytes(32).toString('hex')}`;

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
 * Why a written-off receivable cannot be matured, said the same way from both places that
 * refuse it.
 *
 * Maturity meets that fact twice and from two sources — the invoice row, before anything is
 * written, and the settlement-outcome ledger, which is the one that catches a default whose
 * status write never landed. Both are needed, neither subsumes the other, and a seller
 * should not be able to tell which one answered: the thing they have to act on is that
 * reversing a permanent mark is a decision about the customer, not a retry.
 */
const writtenOffRefusal = (invoiceId: string): string =>
  `Invoice ${invoiceId} is recorded as defaulted. A receivable that was written off cannot ` +
  "be matured; correcting that is a decision about the customer's permanent record, not a " +
  'second press of this button.';

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

/**
 * Commit a settled match to the topic, and write back where it landed.
 *
 * `trades.hcs_topic_id` and `hcs_sequence_number` have been on this table since the first
 * migration and the proof view has rendered a link off them the whole time — **and nothing
 * ever wrote them.** Only `seed.ts` did, so on every trade this venue actually settled the
 * block was null. This is the writer.
 *
 * It runs after both legs are done and it never throws: the sale has already happened, both
 * legs are on chain and checkable there, so an unavailable topic costs the convenience of a
 * consensus coordinate rather than the trade.
 */
async function commitMatch(input: {
  tradeId: string;
  invoiceId: string;
  mandateId: string;
  buyerId: string;
  sellerId: string;
  faceValue: bigint;
  proceedsMinor: bigint;
  rail: CashRail;
  assetTransactionId: string | null;
}): Promise<void> {
  const published = await publishMatch({
    tradeId: input.tradeId,
    invoiceId: input.invoiceId,
    mandateId: input.mandateId,
    buyerId: input.buyerId,
    sellerId: input.sellerId,
    faceValue: input.faceValue.toString(10),
    proceedsMinor: input.proceedsMinor.toString(10),
    rail: input.rail,
    assetTransactionId: input.assetTransactionId ?? '',
  });
  if (published === null) return;

  await getStore().updateTrade(input.tradeId, {
    hcsTopicId: published.topicId,
    hcsSequenceNumber: published.sequenceNumber,
  });
}

export const settlementService: SettlementService = {
  /**
   * Ask the vault, then decide.
   *
   * One chain read, on the arming path only. `priceBook` must never do this — it prices the
   * whole book in one pass and a read per row is the N+1 that design exists to avoid — but a
   * trade about to be armed is a single mandate, and the answer changes what the caller gets
   * back rather than merely decorating it.
   *
   * An unreadable vault chooses x402, deliberately. The alternative is refusing to trade
   * because a second rail was unavailable, and the first rail is right there and works.
   */
  async chooseRail({ mandateId, proceedsMinor, currency, sellerArcAddress }) {
    const escrow = getArcEscrow();
    /*
     * `payoutFor`, not `requiredFor`: this figure is what the buyer is charged and what
     * `registerMatch` binds on chain. The requirement rounds up and a payment rounds down,
     * and using the wrong one made an Arc trade cost a unit more than the same invoice on
     * x402 — two prices for one receivable, which is what the shared scale exists to stop.
     */
    const priceUsdcMinor = escrow.priceFor(proceedsMinor, currency);

    if (!escrow.enabled) {
      return {
        rail: 'x402',
        reason: 'No Arc vault is configured on this deployment, so no bid is escrowed.',
        depositedUsdcMinor: null,
        priceUsdcMinor,
      };
    }

    /*
     * Checked before the balance, because `registerMatch` binds this address permanently and
     * the vault will happily bind one nobody controls. A seller with no address on file is a
     * seller who cannot be paid on Arc, which is a reason to use the other rail rather than
     * a reason to open a lock into the void.
     */
    if (sellerArcAddress === null || sellerArcAddress === '') {
      return {
        rail: 'x402',
        reason: 'The seller has no Arc address on file, so a payout would have no payee.',
        depositedUsdcMinor: null,
        priceUsdcMinor,
      };
    }

    let deposited: bigint;
    try {
      deposited = await escrow.depositedFor(mandateId);
    } catch (err) {
      rootLogger.warn('could not read the Arc vault; settling over x402', { mandateId, err });
      return {
        rail: 'x402',
        reason: 'The Arc vault could not be read, so this trade settles on the rail that can.',
        depositedUsdcMinor: null,
        priceUsdcMinor,
      };
    }

    if (deposited < priceUsdcMinor) {
      return {
        rail: 'x402',
        reason:
          `This bid holds ${deposited} USDC minor units on Arc and this trade needs ` +
          `${priceUsdcMinor}, so the buyer pays per trade instead.`,
        depositedUsdcMinor: deposited,
        priceUsdcMinor,
      };
    }

    return {
      rail: 'arc-vault',
      reason: 'The buyer escrowed this capital on Arc before the invoice existed.',
      depositedUsdcMinor: deposited,
      priceUsdcMinor,
    };
  },

  /**
   * Arm both legs. Nothing moves.
   *
   * The ATS hold is placed first because it is the leg that can fail for a reason worth
   * telling the buyer about — a paused instrument, a lost role grant — and discovering
   * that after taking a payment signature would be the wrong order. Once the hold exists,
   * the 402 challenge is built for the proceeds and the hold id is written onto the trade
   * so `unwind` can find it after a restart.
   */
  /**
   * Both legs, one call, out of capital the buyer posted before the invoice existed.
   *
   * The order is the whole design, and it is chosen by which way a failure hurts:
   *
   *   1. hold the seller's position (nothing moves)
   *   2. `registerMatch` — bind payee, price and mandate ON CHAIN, before delivery
   *   3. `executePayout` — capital leaves the vault into `DvpEscrow`, locked for the seller
   *   4. execute the hold — the paper moves to the buyer
   *   5. hand the seller the preimage, which is what lets them take the cash
   *
   * **Cash commits before the paper moves.** Reverse 3 and 4 and a failed payout leaves the
   * buyer holding paper nobody paid for, which is unrecoverable. This way a failed step 4
   * leaves money locked in an escrow that CAN be returned to the mandate after 24 hours, and
   * the seller still has their position — so the bad case is recoverable, not a lost
   * receivable.
   *
   * "Can be" is exact. `MandateVault.reclaimPayout` is permissionless and does exactly this,
   * and **nothing in this service calls it.** Recovering a stranded lock is an operator
   * action today, not something the venue does on its own, and saying otherwise would
   * describe a safety net that is not strung.
   *
   * Step 2 is not bookkeeping. `registerMatch` is what lets a seller read `payoutOf(matchId)`
   * and see the price and the payee fixed and public **before** parting with the paper. It is
   * also one-shot and uncorrectable, which is why every write here reads first.
   */
  async settleFromVault(intent) {
    const store = getStore();
    const ats = getAtsAdapter();
    const escrow = getArcEscrow();

    if (intent.sellerArcAddress === null || intent.sellerArcAddress === '') {
      throw conflict(
        'conflict',
        'This seller has no Arc address on file, so a payout would have no payee. ' +
          'The trade cannot settle out of the vault.',
      );
    }

    const sellerEvmAddress = accountIdToEvmAddress(intent.sellerHederaAccountId);
    const priceUsdcMinor = escrow.priceFor(intent.proceedsMinor, intent.currency);

    /*
     * Read before the hold, because a hold moves units out of the free balance and the same
     * call afterwards answers a smaller number. Identical to `prepare`; the asset leg does
     * not care which rail pays for it.
     */
    const position = await ats.balanceOf({
      securityId: intent.securityId,
      ownerEvmAddress: sellerEvmAddress,
    });
    if (position <= 0n) {
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
      escrowEvmAddress: operatorEvmAddress(getConfig().env.HEDERA_OPERATOR_KEY),
      units: position,
      expiresAt: new Date(Date.now() + VAULT_HOLD_WINDOW_SECONDS * 1000),
    });

    await store.updateTrade(intent.tradeId, {
      status: 'awaiting_payment',
      holdId: hold.holdId,
      unitsMinor: position,
      assetTxId: hold.transactionId,
      assetConsensusAt: new Date(hold.consensusAt),
      cashRail: 'arc-vault',
      cashNetwork: ARC_NETWORK,
      cashScheme: ARC_SCHEME,
      cashAsset: getConfig().chain.arc.usdcAddress,
      /*
       * `cashAmountMinor` is deliberately NOT written here. Its own column note defines it as
       * what actually moved, and at this point nothing has: a trade that fails at
       * `registerMatch` would otherwise report a settled amount beside a null transaction.
       * It is written after the payout, where the claim becomes true.
       */
    });

    /*
     * Bound already? Then a previous attempt got this far and died. `registerMatch` cannot be
     * called twice — it reverts `MatchAlreadyRegistered` even from the attester with identical
     * arguments — so asking is the only way to tell a retry from a first attempt without
     * spending a transaction to find out.
     */
    const existing = await escrow.payoutFor(intent.tradeId);
    if (existing === null) {
      await escrow.registerMatch({
        tradeId: intent.tradeId,
        mandateUuid: intent.mandateId,
        seller: intent.sellerArcAddress,
        priceUsdcMinor,
      });
    } else if (existing.executed) {
      /*
       * The capital already left the vault for this match and can never leave again —
       * `reclaimPayout` returns it to the buyer but leaves `executed` true forever. Refusing
       * loudly is the only honest answer; arming a second payout would revert, and pretending
       * it settled would report a payment that cannot happen.
       */
      throw conflict(
        'conflict',
        `Trade ${intent.tradeId} has already drawn its payout from the vault. If the seller ` +
          'never claimed it, the capital can be reclaimed to the buyer once the lock expires ' +
          '— by someone calling reclaimPayout, which this venue does not do automatically — ' +
          'and this receivable needs a new sale rather than a retry of this one.',
      );
    } else if (
      existing.price !== priceUsdcMinor ||
      existing.seller.toLowerCase() !== intent.sellerArcAddress.toLowerCase()
    ) {
      /*
       * A binding that exists but does not match this trade.
       *
       * `executePayout` takes no amount and no payee: it pays `payout.price` to
       * `payout.seller` off the stored binding, and that binding **cannot be corrected**.
       * So proceeding here would move whatever the chain already agreed to while the venue
       * wrote a receipt describing this trade's numbers — a proof view stating an amount and
       * a payee that the transaction beside it contradicts, which is the one thing that
       * screen exists to make impossible.
       *
       * It should not be reachable: a match id is derived from a trade id and every arming
       * inserts a fresh trade. Reaching it means the derivation changed or a trade id
       * repeated, and both are worth stopping for rather than paying through.
       */
      throw conflict(
        'conflict',
        `Trade ${intent.tradeId} is bound on chain to pay ${existing.price} to ` +
          `${existing.seller}, but this trade is for ${priceUsdcMinor} to ` +
          `${intent.sellerArcAddress}. A match binding cannot be changed, so this sale is ` +
          'refused rather than settled against terms it does not match.',
      );
    }

    /*
     * The preimage. Random rather than derived: a derivation would make every secret
     * computable by anyone who learned it, and this one is the only thing standing between an
     * open lock and the seller's money until the moment they claim.
     */
    const secret = randomSecret();
    const secretHash = keccak256(secret);
    await store.updateTrade(intent.tradeId, { arcSecret: secret });

    const payout = await escrow.executePayout({ tradeId: intent.tradeId, secretHash });
    await store.updateTrade(intent.tradeId, {
      arcLockId: payout.lockId,
      cashTransaction: payout.transactionHash,
      cashPayer: intent.buyerArcAddress,
      cashAmountMinor: priceUsdcMinor,
    });

    /*
     * The receivable stops being for sale HERE, before delivery, and that ordering is a fix
     * rather than a detail.
     *
     * The buyer's capital has irreversibly left the vault. If the invoice stayed quotable and
     * the delivery below then failed, the hold would expire, the seller could take a fresh
     * quote, and a second trade would draw a second payout from the same funded mandate —
     * because this rail's whole premise is that no second consent is needed. The buyer would
     * have paid twice for one receivable, silently. On the x402 rail the same hole exists and
     * cannot be reached, since a second sale needs a second signature.
     *
     * So the invoice is marked sold at the moment it is paid for, not at the moment it is
     * delivered. A failed delivery after this is a half-settled trade to reconcile, which is
     * what it is; it is not an invoice to sell again.
     */
    await store.updateInvoice(intent.invoiceId, { status: 'sold' });
    await store.setQuoteStatus(intent.quoteId, 'accepted');

    const cashLeg: CashLegReceipt = {
      chain: 'arc',
      rail: 'arc-vault',
      scheme: ARC_SCHEME,
      state: 'settled',
      asset: getConfig().chain.arc.usdcAddress,
      amountMinor: intent.proceedsMinor.toString(10),
      settledAmountMinor: priceUsdcMinor.toString(10),
      transaction: payout.transactionHash,
      payer: intent.buyerArcAddress,
      explorerUrl: explorer.arcTx(payout.transactionHash),
      lock: {
        lockId: payout.lockId,
        status: 'locked',
        secret,
        claimableUntil: null,
        beneficiary: intent.sellerArcAddress,
        explorerUrl: explorer.arcTx(payout.transactionHash),
      },
    };

    let assetLeg: AssetLegReceipt;
    try {
      const executed = await ats.executeHold({
        securityId: intent.securityId,
        holderEvmAddress: sellerEvmAddress,
        toEvmAddress: accountIdToEvmAddress(intent.buyerHederaAccountId),
        holdId: hold.holdId,
        units: position,
      });
      assetLeg = {
        chain: 'hedera',
        state: 'settled',
        holdId: hold.holdId,
        unitsMinor: position.toString(10),
        transactionId: executed.transactionId,
        consensusAt: executed.consensusAt,
        explorerUrl: explorer.hederaTx(executed.transactionId),
      };
    } catch (err) {
      await store.updateTrade(intent.tradeId, { status: 'failed' });
      /*
       * Loud, but not the same emergency as the x402 half-settled case. There the buyer has
       * paid and cannot be unpaid. Here the money is in an escrow the vault gets back after
       * the lock expires, and the seller keeps their position — so this is recoverable by
       * waiting, and the secret is deliberately never handed over.
       */
      rootLogger.error('Arc payout locked but the asset leg did not execute', {
        tradeId: intent.tradeId,
        lockId: payout.lockId,
        payoutTransaction: payout.transactionHash,
        err,
      });
      throw internalError(
        `The payout was locked on Arc but the security did not transfer. Trade ` +
          `${intent.tradeId} is being reconciled; the seller keeps their position and the ` +
          'locked capital can be reclaimed to the buyer after the lock expires. Quote this id.',
      );
    }

    const settledAt = new Date();
    await store.updateTrade(intent.tradeId, {
      status: 'settled',
      assetTxId: assetLeg.transactionId,
      assetConsensusAt: assetLeg.consensusAt === null ? null : new Date(assetLeg.consensusAt),
      settledAt,
    });

    await commitMatch({
      tradeId: intent.tradeId,
      invoiceId: intent.invoiceId,
      mandateId: intent.mandateId,
      buyerId: intent.buyerId,
      sellerId: intent.sellerId,
      faceValue: intent.faceValue,
      proceedsMinor: intent.proceedsMinor,
      rail: 'arc-vault',
      assetTransactionId: assetLeg.transactionId,
    });

    rootLogger.info('trade settled out of the Arc vault', {
      tradeId: intent.tradeId,
      lockId: payout.lockId,
      priceUsdcMinor: priceUsdcMinor.toString(10),
    });

    return { tradeId: intent.tradeId, assetLeg, cashLeg, settledAt: settledAt.toISOString() };
  },

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
      rail: 'x402',
      scheme: input.requirements.scheme,
      state: 'settled',
      asset: input.requirements.asset,
      amountMinor: trade.proceedsMinor.toString(10),
      /*
       * `requirements.amount` is the figure the payer actually signed over, in the settlement
       * asset's smallest unit. It is the only number on this receipt a reader can check
       * against the transaction, and until now nothing carried it.
       */
      settledAmountMinor: input.requirements.amount,
      transaction: settlement.transaction ?? null,
      payer: settlement.payer ?? verification.payer ?? null,
      explorerUrl: settlement.transaction
        ? explorerFor(input.requirements.network, settlement.transaction)
        : null,
      // x402 pays the seller directly; there is no escrow lock standing between them and it.
      lock: null,
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
        /*
         * The rail and the amount belong on this row too, not only on the success path.
         * This is the one trade where a reader most needs to know which rail took the
         * money, and leaving them null makes a half-settled trade claim no rail has run
         * while a real cash transaction sits beside it.
         */
        cashRail: 'x402',
        cashAmountMinor: BigInt(input.requirements.amount),
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
      cashRail: 'x402',
      cashTransaction: cashLeg.transaction,
      cashPayer: cashLeg.payer,
      cashAsset: cashLeg.asset,
      cashAmountMinor: BigInt(input.requirements.amount),
      cashNetwork: input.requirements.network,
      cashScheme: input.requirements.scheme,
      settledAt,
    });
    await store.setQuoteStatus(trade.quoteId, 'accepted');
    await store.updateInvoice(trade.invoiceId, { status: 'sold' });
    await commitMatch({
      tradeId: trade.id,
      invoiceId: trade.invoiceId,
      mandateId: trade.mandateId,
      buyerId: trade.buyerId,
      sellerId: trade.sellerId,
      faceValue: trade.faceValue,
      proceedsMinor: trade.proceedsMinor,
      rail: 'x402',
      assetTransactionId: assetLeg.transactionId,
    });

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

    /*
     * A trade whose cash has already moved cannot be unwound, whatever its status says.
     *
     * On the x402 rail `awaiting_payment` always means nothing has moved, so status alone was
     * a sufficient guard. On the Arc rail it does not: a trade sits in `awaiting_payment` for
     * the whole of its settlement, including after `executePayout` has put the buyer's USDC
     * in the escrow. Unwinding there would release the hold and hand the mandate its capital
     * back while that capital is on chain and gone — a DvP break, and a double release once
     * the caller's own compensation runs too.
     *
     * `reclaimExpired` sweeps `awaiting_payment` on almost every request, so this is not a
     * race that needs an unlucky client: any concurrent read of the book could trigger it.
     */
    if (trade.cashTransaction !== null || trade.arcLockId !== null) {
      throw conflict(
        'conflict',
        `Trade ${trade.id} has already moved money on its cash leg, so it cannot be unwound. ` +
          'It is reconciled rather than released.',
      );
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
   * The ledger is also read **before** the guards, because every one of them protects a
   * first write and a replay makes none. The past-due refusal had been running ahead of
   * that read and firing on pure replays, which is the property above being false whenever
   * the clock had passed the due date.
   *
   * **The cash leg comes back `pending`, deliberately.** The debtor's payment is the money
   * that settles a matured receivable, and there is no debtor payment rail in this build.
   * The requirement is built and addressed to the current holder; reporting it as
   * `settled` would put a payment on the proof view that nobody made. A Hedera Scheduled
   * Transaction is the right fit for the payout when there is one — one-shot maturity
   * settlement is exactly what `ScheduleCreateTransaction` is for, and it is not a
   * streaming primitive.
   */
  async settleAtMaturity(invoiceId, observed = {}) {
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

    /*
     * The lifecycle decides what may mature, and it lives in `@facture/shared` rather than
     * in a list written out here — the same argument `recordDefault` makes, and this side
     * had neither a list nor the machine. A `disputed` receivable matured to `matured` with
     * a 200 against an edge `INVOICE_TRANSITIONS` does not contain: a customer disputing an
     * invoice and being recorded as having paid it.
     *
     * Checked before anything is written, so a refusal costs no repair. An invoice already
     * `matured` is not a transition but the replay, and falls through to the ledger below,
     * which is what makes this idempotent. `defaulted` is spelled out ahead of the machine
     * only for its sentence: both are terminal and the machine refuses both, but "which is
     * final" tells a seller nothing about the permanent mark they would be reversing.
     */
    if (invoice.status === 'defaulted') throw conflict('conflict', writtenOffRefusal(invoiceId));
    if (invoice.status !== 'matured') transitionTo(invoice.status, 'matured');

    const now = new Date();

    /*
     * Whether this call is recording a settlement or reading one back.
     *
     * The ledger, never the invoice's own status: a row can carry `matured` with nothing
     * behind it on the ledger — the seeded book contains exactly that — so the status would
     * wave a first write past the guard below on the strength of a settlement nobody
     * recorded. This is the only read that can tell the two apart, and everything the guard
     * protects is a first write.
     */
    const onLedger = await store.getOutcome(invoice.debtorId, invoiceId);

    /*
     * `late` means the debtor paid after the due date. It used to mean something else.
     *
     * The comparison here was `now` against the due date — the instant the OPERATOR pressed
     * the button, not the instant the money landed — so a receivable matured a week after it
     * fell due was written to the rating ledger as a late payment whether the debtor had
     * paid early, paid on the day, or never paid at all. That is a permanent widening of a
     * customer's curve for every seller afterwards, sourced from the venue's own admin
     * timing. `late` was doing duty as the fallback for "we do not know yet", which is the
     * one thing a rating input must never be.
     *
     * The debtor pays into the venue's collection account off chain, so the date the money
     * landed is a fact only the venue holds and nothing here can observe. It is therefore
     * stated, not inferred:
     *
     * - stated -> compare THAT against the due date. This is the only path that can produce
     *   `late`, and it produces `on_time` just as readily for a payment made on the day.
     * - not stated, receivable not yet past due -> `on_time`. There is no instant left at
     *   which the payment could have been late; the deadline has not passed.
     * - not stated, receivable past due -> refused below. Guessing in either direction is a
     *   permanent claim about a customer made from no evidence, and there is a route for
     *   the other answer: if the money is never coming, that is a default, not a late
     *   payment recorded as one.
     *
     * The refusal is scoped to a receivable the ledger has nothing on, and that scope is the
     * whole of it. The question it refuses to guess at — was this paid on time — is only
     * asked when a settlement is being RECORDED; a replay decides nothing and reads back an
     * answer already written, so refusing one would make a documented property false the
     * moment the clock passed the due date. It also broke the only way to ask whether the
     * collection key had signed the payout, which is this route, without re-stating a
     * `paidAt` the operator may not have.
     */
    const deadline = onTimeDeadline(invoice.dueAt);
    if (onLedger === null && observed.paidAt === undefined && now.getTime() > deadline.getTime()) {
      throw conflict(
        'conflict',
        `Invoice ${invoiceId} fell due on ${invoice.dueAt.toISOString().slice(0, 10)} and is ` +
          'past due, so whether it was paid on time is not something this call can work out. ' +
          'Say when the money landed with `paidAt`, or record a default if it never will.',
      );
    }
    const paidAt = observed.paidAt ?? now;

    /*
     * A stated payment date is a claim about the past, and it is the claim the permanent
     * half of the rating ladder is computed from. A date in the future would record a
     * payment nobody has made; a date before the invoice was raised would record one against
     * an invoice that did not exist. Both would decide `late` as confidently as a real one.
     */
    if (paidAt.getTime() > now.getTime()) {
      throw badRequest(
        `A payment cannot have landed at ${paidAt.toISOString()}, which is in the future.`,
      );
    }
    if (paidAt.getTime() < invoice.issuedAt.getTime()) {
      throw badRequest(
        `A payment cannot have landed at ${paidAt.toISOString()}, before invoice ${invoiceId} ` +
          `was raised on ${invoice.issuedAt.toISOString().slice(0, 10)}.`,
      );
    }

    const outcome: SettlementOutcome = paidAt.getTime() <= deadline.getTime() ? 'on_time' : 'late';

    const { alreadyRecorded, recorded, occurredAt } = await ratingService.recordOutcome({
      debtorId: invoice.debtorId,
      invoiceId,
      outcome,
      faceValue: invoice.faceValue,
      at: paidAt,
    });

    /*
     * A defaulted receivable does not un-default.
     *
     * `recordOutcome` writes once per receivable and reports what the ledger actually holds,
     * so this is reachable only when a default was declared first — and `recordOutcome` will
     * have written nothing, which is what makes refusing here safe rather than half-done.
     * Without the check the release and the status write below would run, handing the
     * mandate back capital it lost and replacing a permanent mark with a payment.
     *
     * Not made redundant by the lifecycle guard above. That one reads the invoice row; this
     * one reads the ledger, and the case it exists for is a default whose status write never
     * landed — a receivable still saying `sold` with a permanent mark already recorded
     * against the customer.
     */
    if (recorded === 'default') {
      throw conflict('conflict', writtenOffRefusal(invoiceId));
    }

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
      /*
       * The capital comes back to the mandate, which is what lets an `exhausted` bid quote
       * again rather than sitting on the book with nothing behind it — **but only the x402
       * rail gets all of it back.**
       *
       * On the Arc rail the proceeds left the vault at settlement, when `executePayout`
       * debited the mandate. Nothing decremented `funded_minor` then, and nothing should
       * have: while the trade was armed the allocation already held that money out of
       * `unallocated`, so reducing the book as well would have counted it twice. Maturity is
       * where both fall together — the allocation is returned and the commitment is retired
       * with it — which leaves `unallocated` flat and the book back in step with the vault.
       *
       * Releasing it plainly here was the accounting error behind a defect that only looked
       * like an outage: after one Arc trade matured, the book claimed the full committed
       * capital while the vault was short by the proceeds, so the next withdrawal was refused
       * as `insufficient` and blamed a deposit that had been fine all along.
       */
      await (holderTrade.cashRail === 'arc-vault'
        ? store.retireAllocatedCapital(holderTrade.mandateId, holderTrade.proceedsMinor)
        : store.release(holderTrade.mandateId, holderTrade.proceedsMinor));
      /*
       * Written only when it actually moves. The status can already be `matured` here on the
       * mirror repair — a row carrying the marker with no ledger row behind it — and
       * re-asserting it is the self-edge the invoice machine refuses, which would turn a
       * repair into a 409.
       */
      if (invoice.status !== 'matured') {
        await store.updateInvoice(invoiceId, { status: 'matured' });
      }
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
        executedAt: null,
        executedTransactionId: null,
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
          payout = {
            ...receipt,
            executedAt: null,
            executedTransactionId: null,
            explorerUrl: explorer.hederaSchedule(receipt.scheduleId),
          };
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

    /*
     * Whether the holder has actually been paid is asked, not remembered.
     *
     * The signature that executes a payout happens outside this service — it is the venue's
     * statement that the debtor's money arrived — so a flag set here would be this service
     * guessing at a fact only the ledger holds. Asking on every call also means a maturity
     * that was recorded before anyone signed reports the payment the moment it lands, with
     * no reconciliation step and nothing to backfill.
     */
    if (payout !== null) {
      const status = await getScheduleAdapter().payoutStatus(payout.scheduleId);
      payout = {
        ...payout,
        executed: status.executed,
        executedAt: status.executedAt,
        executedTransactionId: status.transactionId,
        payerAccountId: status.payerAccountId ?? payout.payerAccountId,
        payeeAccountId: status.payeeAccountId ?? payout.payeeAccountId,
      };
    }

    rootLogger.info('receivable matured', {
      invoiceId,
      tradeId: holderTrade.id,
      holder: holderTrade.buyerId,
      outcome: recorded,
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
      /*
       * What the ledger holds, not what this call computed. On a replay the two can differ
       * — the first call may have been given a payment date and the second not — and the
       * ledger is the authority, because it is what the curve reads. Reporting the local
       * computation would tell a seller their customer paid on time on a call that wrote
       * nothing.
       */
      outcome: recorded,
      /*
       * The date that outcome was decided against, from the same row. Reading one off the
       * ledger and the other off the request was how a replay came to answer `on_time`
       * beside a `paidAt` that would have produced `late` — two halves of one claim, taken
       * from two sources that only agree on the first call.
       */
      paidAt: occurredAt.toISOString(),
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
       * `pending` until the payout has actually executed, and `settled` once it has.
       *
       * A scheduled payout is an obligation, not a payment — it becomes one when the
       * collection key signs, which is the venue's statement that the debtor's money
       * arrived. So this leg follows the ledger rather than the schedule's existence:
       * arranging a payout leaves it `pending` with a schedule id anyone can look up, and
       * only an executed transfer turns it into a receipt with a transaction behind it.
       *
       * The distinction is the whole point on the one screen whose job is to be checkable.
       */
      cashLeg: {
        chain: challenge.accepted.network.startsWith('hedera') ? 'hedera' : 'arc',
        /*
         * Maturity is on Hedera whichever rail bought the paper. The debtor pays into the
         * venue's collection account off chain and a Scheduled Transaction pays the holder in
         * HBAR — none of which involves the Arc vault, whose capital was spent at settlement.
         * So this is the x402 rail's chain and asset even for a trade that settled on Arc.
         */
        rail: 'x402',
        scheme: 'x402',
        state: payout?.executed === true ? 'settled' : 'pending',
        asset: challenge.accepted.asset,
        amountMinor: invoice.faceValue.toString(10),
        settledAmountMinor: payoutAmount.toString(10),
        transaction: payout?.executedTransactionId ?? null,
        payer: payout?.executed === true ? payout.payerAccountId : null,
        explorerUrl:
          payout?.executedTransactionId === undefined || payout?.executedTransactionId === null
            ? null
            : explorer.hederaTx(payout.executedTransactionId),
        lock: null,
      },
      payout,
      payoutError,
      settledAt: now.toISOString(),
    };
  },

  /**
   * The debtor never paid, and the venue says so.
   *
   * **This is the only thing that produces `SettlementOutcome: 'default'`, and it is the
   * half of the rating loop the product's central claim rests on.** A rating earned from
   * settled history is only worth reading if the bad history is in it: every invoice a
   * customer pays tightens their curve, and the market prices its own mistakes back in only
   * because a default marks them permanently and widens it for every seller afterwards.
   * Until this existed nothing wrote that mark, and maturing an overdue unpaid receivable
   * recorded it as `late` — a write-off entered in the ledger as a payment.
   *
   * **Declared, never inferred from a clock.** This follows the maturity payout exactly: a
   * schedule becomes a payment when the collection key signs, because only the venue can say
   * the debtor's money landed; a receivable becomes a default when someone presses this,
   * because only the venue can say it never will. A timer that marked customers on its own
   * would mark them for a payment three days in the post, and the mark does not come off.
   *
   * **What it deliberately does NOT do is give the mandate its capital back.** Maturity
   * releases the allocation because the face value came in and the position closed whole. In
   * a default the position closes at zero — non-recourse, the buyer takes the loss — so
   * releasing here would hand a bid capital it no longer has and let it quote again on
   * money that is gone. The allocation stays put, which is what makes the mandate's headroom
   * reflect the loss. Writing that capital off properly means decrementing what the buyer
   * committed as well as what it allocated, and there is no store operation that does both;
   * `lossMinor` reports the figure rather than pretending it moved.
   *
   * **The per-debtor concentration cap stays consumed too, and that used to be untrue.** The
   * stores counted a defaulted invoice as closed for exposure purposes, so the position
   * vanished from the mandate's per-debtor map the moment this ran while `allocated_minor`
   * correctly stayed — the aggregate reflected the loss and the cap on the one customer that
   * had just failed to pay was handed back. A default is the strongest evidence there is for
   * counting a debtor's exposure, not the event that forgets it.
   */
  async recordDefault(invoiceId) {
    const store = getStore();
    const invoice = await store.getInvoice(invoiceId);
    if (!invoice) throw notFound(`Invoice ${invoiceId}`);

    /*
     * The lifecycle decides what may be defaulted, and it lives in `@facture/shared` rather
     * than in a list written out here — a hand-copied set of statuses is how the two come to
     * disagree, and the disagreement would show up as either a permanent mark on a customer
     * whose invoice was never sold, or a `matured` receivable being written off after the
     * fact. `matured` is terminal in that table, so this is also the guard that stops a
     * default landing on a receivable that was actually paid.
     *
     * A receivable already `defaulted` is not a transition; it is the replay, and it falls
     * through to the ledger below, which is the thing that makes this idempotent.
     */
    if (invoice.status !== 'defaulted') {
      const move = transitionInvoice(invoice.status, 'defaulted');
      if (!move.ok) {
        throw conflict(
          'conflict',
          invoice.status === 'matured'
            ? `Invoice ${invoiceId} has already matured — the debtor paid it. A default ` +
                'cannot be declared against a receivable that settled.'
            : move.error.reason,
        );
      }
    }

    /*
     * The position that takes the loss: the newest settled trade, the same holder lookup
     * maturity uses. Whoever holds the paper now is who is out the money, not whoever bought
     * it first.
     *
     * A receivable nobody bought cannot be defaulted here, and that is the ledger's rule
     * rather than a limitation: `settlement_outcomes` is one row per SETTLED receivable, and
     * a rating built out of invoices the venue never priced, matched or delivered would be a
     * record of the seller's collections rather than of the customer's behaviour.
     */
    const settled = await store.listTrades({ invoiceId, status: 'settled', limit: 50 });
    const holderTrade = [...settled].sort(
      (a, b) => (b.settledAt?.getTime() ?? 0) - (a.settledAt?.getTime() ?? 0),
    )[0];
    if (!holderTrade) {
      throw conflict(
        'conflict',
        `Invoice ${invoiceId} has never settled, so there is no position to write off and ` +
          'nothing the rating ledger can record.',
      );
    }

    /*
     * Not yet overdue is not a default.
     *
     * The mark is permanent and it is read by every seller who ever invoices this customer
     * afterwards, so the receivable has to have actually failed to be paid before one can be
     * declared. A debtor who has until Friday has not defaulted on Tuesday, however
     * confident anyone is about Friday.
     *
     * Skipped only for a receivable the ledger already has a row for, and the ledger is the
     * authority rather than the invoice's own status. The two can disagree: a row can carry
     * `defaulted` with nothing recorded against it — the seeded book does — and exempting on
     * the status let such a receivable take a FIRST mark with neither this guard nor the
     * lifecycle's ever running. Time only moves forward, so a genuine replay passes this on
     * its own merits and needs no exemption at all.
     */
    const now = new Date();
    const deadline = onTimeDeadline(invoice.dueAt);
    const onLedger = await store.getOutcome(invoice.debtorId, invoiceId);
    if (onLedger === null && now.getTime() <= deadline.getTime()) {
      throw conflict(
        'conflict',
        `Invoice ${invoiceId} is not due until ${invoice.dueAt.toISOString().slice(0, 10)}, ` +
          'so it cannot have been defaulted on yet. A default is a permanent mark on the ' +
          'customer and there is no way to take one back.',
      );
    }

    /*
     * The ledger write is the fact, and it is written before the invoice moves — same order
     * as maturity, for the same reason. `recordOutcome` is keyed on `(debtor_id, invoice_id)`
     * and writes once, so pressing this twice marks the customer once.
     */
    const { alreadyRecorded, recorded, occurredAt, ...assessment } =
      await ratingService.recordOutcome({
        debtorId: invoice.debtorId,
        invoiceId,
        outcome: 'default',
        faceValue: invoice.faceValue,
        at: now,
      });

    /*
     * A settlement already on the ledger is not overwritten, and cannot be.
     *
     * Reachable when a maturity recorded its outcome and died before moving the invoice —
     * the row says `on_time`, the invoice still says `sold`, and from outside that is
     * indistinguishable from a default that tore in the same place. `recordOutcome` wrote
     * nothing in this case, so refusing costs no repair; going ahead would move the invoice
     * to `defaulted` over a ledger that says the customer paid, and the two would disagree
     * permanently with the accumulator siding with the payment.
     */
    if (recorded !== 'default') {
      throw conflict(
        'conflict',
        `Invoice ${invoiceId} is already recorded on the rating ledger as paid ` +
          `${recorded === 'on_time' ? 'on time' : 'late'}. A default cannot overwrite a ` +
          'settlement that was already recorded — the customer has been credited for it.',
      );
    }

    /*
     * The invoice follows the ledger, and a replay that finds it already moved does nothing.
     * The other order — status first — would let a run that died in between report a default
     * the accumulator never saw, which is the same lie as the one this route exists to fix.
     */
    if (invoice.status !== 'defaulted') {
      await store.updateInvoice(invoiceId, { status: 'defaulted' });
    }

    rootLogger.warn('receivable written off', {
      invoiceId,
      tradeId: holderTrade.id,
      holder: holderTrade.buyerId,
      mandateId: holderTrade.mandateId,
      lossMinor: holderTrade.proceedsMinor.toString(10),
      alreadyRecorded,
    });

    const holder = await store.getBuyer(holderTrade.buyerId);

    return {
      invoiceId,
      tradeId: holderTrade.id,
      holder: {
        buyerId: holderTrade.buyerId,
        mandateId: holderTrade.mandateId,
        name: holder?.name ?? null,
      },
      lossMinor: holderTrade.proceedsMinor.toString(10),
      faceValueMinor: invoice.faceValue.toString(10),
      outcome: recorded,
      alreadyRecorded,
      rating: {
        debtorId: invoice.debtorId,
        grade: assessment.rating,
        permanentlyMarked: assessment.permanentlyMarked,
        reason: assessment.reason,
      },
      /*
       * The ledger's date, not this call's clock. A default is declared once and the mark
       * dates from that declaration; a replay reporting `now` would move the date of a
       * permanent fact every time somebody pressed the button again.
       */
      declaredAt: occurredAt.toISOString(),
    };
  },
};

/** Explorer link for a cash-leg reference, chosen by the network the leg settled on. */
const explorerFor = (network: string, reference: string): string =>
  network.startsWith('hedera') ? explorer.hederaTx(reference) : explorer.arcTx(reference);
