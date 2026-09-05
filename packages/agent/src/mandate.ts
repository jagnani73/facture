/**
 * A funded standing mandate, and the pure decision that says whether it takes an invoice.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * THE CAP IS OURS. CIRCLE ENFORCES NOTHING.
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Read this before changing anything below, because the obvious assumption is wrong in a
 * way that would put unbacked liquidity on the curve.
 *
 * Circle's Developer-Controlled Wallets have **no policy engine**. Circle's own
 * documentation says so: *"Dev-controlled wallets do not include a built-in policy engine.
 * If you require transaction restrictions, destination allowlists, or multi-party approval
 * flows, enforce those controls in your own application logic before calling Circle
 * APIs."* The spending-policy product that does exist requires a **mainnet** Agent Wallet
 * — *"Spending policies require a mainnet agent wallet. Testnet is not supported."* — and
 * Arc is listed as testnet-only with no mainnet identifier at all. There is no
 * configuration of Circle, on this chain, that would enforce a mandate.
 *
 * It could not express one anyway. Circle's policy schema offers flat per-transaction,
 * daily, weekly and monthly caps plus allow/blocklists. A mandate is *"any A-rated paper,
 * ninety days or less, at 12.5% annualised, up to $200,000 total and $50,000 per
 * customer"* — a rating×tenor bucket with a per-debtor sub-limit and a lifetime ceiling
 * rather than a rolling window. No arrangement of Circle's primitives produces it.
 *
 * Therefore **every check in this file runs before any Circle call is made**, and the
 * result of that check is the only thing standing between a mandate and an overspend. If
 * `decide` returns an acceptance it did not mean, money moves. Nothing downstream will
 * catch it.
 *
 * ## What makes a quote firm
 *
 * The README's claim is that a standing bid is firm because the capital behind it is
 * committed rather than merely permitted, and a mandate matches only up to its unallocated
 * balance. That is what {@link decide} enforces, and the agent additionally proves the
 * capital exists on-chain before committing — see `checkCashLegPayable` and `agent.ts`. An
 * agent that simulated a balance it did not hold would be fake liquidity, which is the one
 * thing the product cannot survive.
 *
 * ## Refusals are outputs, not errors
 *
 * A refused invoice comes back as a named {@link AgentRefusal} with a sentence, never as a
 * thrown exception. The codes are `@facture/shared`'s `RefusalCode` union — the same
 * vocabulary the backend records and publishes to HCS — so a refusal this agent computes
 * and a refusal the venue computes are the same object, and `explainRefusal` writes the
 * sentence for both.
 */

import {
  CURRENCY_DECIMALS,
  RATING_RANK,
  explainRefusal,
  meetsRatingFloor,
  priceInvoice,
  type Bps,
  type Currency,
  type MandateStatus,
  type Mandate as SharedMandate,
  type MinorUnits,
  type Rating,
  type Refusal,
  type RefusalCode,
  type Result,
  err,
  ok,
} from '@facture/shared';

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * The mandate
 * ───────────────────────────────────────────────────────────────────────────────────── */

/**
 * The bid itself: a rating floor, a tenor ceiling, a price, and two caps.
 *
 * Structurally a subset of `@facture/shared`'s `Mandate` — deliberately, so the two cannot
 * drift — but with the running allocation state lifted out into {@link MandateAllocations}.
 * Shared's `Mandate` carries `allocated` and `debtorExposure` on the object because
 * `bestQuote` is a pure function of three arguments; here the terms are configuration that
 * changes when a buyer rewrites the bid, and the allocations are state that changes on
 * every fill. Keeping them apart is what lets a caller re-price against fresh allocations
 * without rebuilding the mandate.
 */
export interface MandateTerms {
  readonly id: string;
  readonly buyerId: string;
  /** A EUR invoice never matches a USD mandate. Not optional here — the agent always knows. */
  readonly currency: Currency;
  /**
   * Rating floor. `UNRATED` is the widest floor a buyer can write: it accepts cold starts
   * and still refuses `D`, because on shared's scale a default ranks *below* no history at
   * all. A floor of `D` is not a bid anyone means to write.
   */
  readonly minRating: Rating;
  /** Tenor ceiling in days, inclusive: an invoice at exactly this many days still matches. */
  readonly maxTenorDays: number;
  /** The bid. Annualised, simple discount, actual/365. */
  readonly annualisedYieldBps: Bps;
  /**
   * Total exposure ceiling, in minor units of `currency`. This is escrowed capital, not an
   * intention — an unfunded ceiling would make every quote the mandate appears in soft.
   */
  readonly totalCommitted: MinorUnits;
  /** Concentration cap: the most this mandate will hold against any one debtor. */
  readonly maxPerDebtor: MinorUnits;
  readonly status: MandateStatus;
}

/**
 * What the mandate has already spent. Amounts are in the mandate's own minor units.
 *
 * `total` is not derivable from `byDebtor` and must not be computed from it: the venue is
 * the authority on both, and a debtor whose exposure has been rolled up elsewhere would
 * silently reduce the total if the two were folded together.
 */
export interface MandateAllocations {
  readonly total: MinorUnits;
  readonly byDebtor: Readonly<Record<string, MinorUnits>>;
}

export const NO_ALLOCATIONS: MandateAllocations = { total: 0n, byDebtor: {} };

/** Capital still available to match against, clamped at zero. */
export function unallocated(terms: MandateTerms, allocations: MandateAllocations): MinorUnits {
  const remaining = terms.totalCommitted - allocations.total;
  return remaining > 0n ? remaining : 0n;
}

/** Capital already committed against one debtor. Zero when the debtor is unknown. */
export const exposureTo = (allocations: MandateAllocations, debtorId: string): MinorUnits =>
  allocations.byDebtor[debtorId] ?? 0n;

/** Headroom left under the concentration cap for one debtor, clamped at zero. */
export function debtorHeadroom(
  terms: MandateTerms,
  allocations: MandateAllocations,
  debtorId: string,
): MinorUnits {
  const remaining = terms.maxPerDebtor - exposureTo(allocations, debtorId);
  return remaining > 0n ? remaining : 0n;
}

/**
 * The most this mandate could pay for one invoice against one debtor right now: the lesser
 * of the unallocated balance and the per-debtor headroom.
 */
export function availableFor(
  terms: MandateTerms,
  allocations: MandateAllocations,
  debtorId: string,
): MinorUnits {
  const pool = unallocated(terms, allocations);
  const perDebtor = debtorHeadroom(terms, allocations, debtorId);
  return pool < perDebtor ? pool : perDebtor;
}

/** Only an `active` mandate quotes. `funding` is not yet firm; `exhausted` has nothing left. */
export const isQuoting = (terms: MandateTerms): boolean => terms.status === 'active';

/**
 * Project into `@facture/shared`'s `Mandate`, so this agent's mandate can be handed to
 * `bestQuote` and priced by exactly the code the venue uses.
 *
 * Nothing here calls it on the decision path — {@link decide} screens one mandate rather
 * than a book — but a caller comparing its own answer against the venue's needs the bridge,
 * and it must exist in one place rather than being open-coded at each site.
 */
export function toSharedMandate(
  terms: MandateTerms,
  allocations: MandateAllocations,
): SharedMandate {
  return {
    id: terms.id,
    buyerId: terms.buyerId,
    minRating: terms.minRating,
    maxTenorDays: terms.maxTenorDays,
    annualisedYieldBps: terms.annualisedYieldBps,
    totalCommitted: terms.totalCommitted,
    allocated: allocations.total,
    maxPerDebtor: terms.maxPerDebtor,
    status: terms.status,
    currency: terms.currency,
    debtorExposure: allocations.byDebtor,
  };
}

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * Refusals
 * ───────────────────────────────────────────────────────────────────────────────────── */

/**
 * The agent's own refusal, on top of shared's union.
 *
 * `CASH_LEG_UNPAYABLE` is not a venue refusal and deliberately is not in shared's
 * `RefusalCode` — the venue never refuses for this reason. It has two rails and always has
 * one to offer. This is the *agent* saying it cannot pay on either of them, which is a fact
 * about this process rather than about the invoice, the mandate, or the paper.
 *
 * ## It has been wrong twice, in two different ways, and both are worth keeping
 *
 * It began as `WALLET_BALANCE_SHORT`, comparing the Circle wallet's balance against the
 * invoice price. That checked the wrong pot — the wallet settles neither rail — and it
 * compared at par against a venue that settles at a ppm scale, so it refused everything by a
 * factor of a million.
 *
 * It then became `MANDATE_NOT_ESCROWED`, which fixed the pot but hardcoded a premise that
 * has since stopped being true: *"a mandate whose capital is not posted on Arc gets an x402
 * challenge on Hedera instead, which is a perfectly good answer for a buyer who can sign
 * one. **This agent cannot.**"* It can now — `cash.ts` holds the buyer's Hedera key. That
 * one sentence was the only thing making an unescrowed bid unreachable, and while it stood,
 * a gate written to keep the agent honest was also what kept it off the x402 rail entirely:
 * every mandate it would arm was backed, and a backed mandate settles on Arc, so no
 * challenge could ever arrive.
 *
 * The lesson is the same one this repo keeps relearning. A guard that encodes a capability
 * as a permanent fact outlives the capability changing, and it fails silently — nothing
 * errored, the agent simply never took the other path.
 */
/**
 * The venue's reading of the Arc vault behind one mandate. USDC minor units, 6dp.
 *
 * Declared here rather than in `venue.ts` because `venue.ts` already imports this module —
 * the dependency runs one way, and putting a domain type on the transport side would turn
 * that into a cycle.
 */
export interface VaultBacking {
  /** False when the venue holds no vault to ask. Then `backed` says nothing. */
  readonly checked: boolean;
  /** Null when the vault could not be read — which is not the same as zero. */
  readonly depositedUsdcMinor: bigint | null;
  readonly requiredUsdcMinor: bigint;
  /** The vault covers this mandate's whole committed capital, not just one trade. */
  readonly backed: boolean;
}

/**
 * Whether this process can sign an x402 cash leg, and what it found when it asked.
 *
 * Three states, not two, for the same reason `VaultBacking` has three: "no key configured",
 * "a key whose account is empty" and "a key whose account could not be read" are different
 * problems with different fixes, and collapsing them produces a refusal nobody can act on.
 */
export interface X402Readiness {
  /** A Hedera signer exists on this process. False means the rail is simply not fitted. */
  readonly configured: boolean;
  /**
   * The payer's balance in tinybars, or `null` when the mirror node could not be read.
   *
   * Read once per tick and compared against zero, never against a price. What it proves is
   * only that the account exists and is not empty; whether it covers *this* trade is checked
   * against the challenge, which names the amount in this same unit.
   */
  readonly balanceTinybars: bigint | null;
}

/** Which rail the agent expects to settle on. The venue decides for real; see `checkCashLegPayable`. */
export type ExpectedRail = 'arc-vault' | 'x402-hedera';

export interface CashLegUnpayableRefusal {
  readonly code: 'CASH_LEG_UNPAYABLE';
  readonly mandateId: string;
  /** The Arc rail's answer. `null` when the venue runs no vault at all, which is not "unbacked". */
  readonly vault: VaultBacking | null;
  /** The Hedera rail's answer, from this process rather than from the venue. */
  readonly x402: X402Readiness;
}

export type AgentRefusal = Refusal | CashLegUnpayableRefusal;

export type AgentRefusalCode = RefusalCode | 'CASH_LEG_UNPAYABLE';

/**
 * Every refusal this agent can itself produce.
 *
 * Shared's union is wider, and the difference is a statement about who decides what.
 * `NOT_KYC_VERIFIED` and `INELIGIBLE_JURISDICTION` are answers from the instrument's own
 * `Kyc` and `ControlList` facets, read by the venue's compliance gate; an agent that
 * emitted them would be guessing at a diamond it has not called. `INVOICE_NOT_CONFIRMED`
 * *is* here, because the book already tells the agent an invoice's status and refusing to
 * price an unconfirmed one is the agent's own decision.
 */
export const AGENT_EMITTED_REFUSAL_CODES = [
  'MANDATE_NOT_ACTIVE',
  'CURRENCY_MISMATCH',
  'RATING_BELOW_MANDATE',
  'TENOR_EXCEEDS_MANDATE',
  'EXPOSURE_EXHAUSTED',
  'DEBTOR_CONCENTRATION',
  'INVOICE_NOT_CONFIRMED',
  'CASH_LEG_UNPAYABLE',
] as const satisfies readonly AgentRefusalCode[];

export const isCashLegUnpayable = (r: AgentRefusal): r is CashLegUnpayableRefusal =>
  r.code === 'CASH_LEG_UNPAYABLE';

/**
 * One sentence, addressed to the party being refused, naming both sides of the comparison
 * that failed. Shared's variants delegate to `explainRefusal`, so the agent and the venue
 * produce identical wording for identical refusals.
 */
export function explainAgentRefusal(r: AgentRefusal): string {
  if (!isCashLegUnpayable(r)) return explainRefusal(r);

  /*
   * USDC minor units, deliberately rendered raw rather than through `formatMinorUnits`.
   *
   * That helper formats at the invoice currency's two decimals, and these are six. Putting
   * one through the other turns 0.05 USDC into $500.00 — a ten-thousandfold error in a
   * sentence whose entire job is naming both sides of a comparison honestly. That is the
   * same confusion this refusal exists because of, and it would be embarrassing to
   * reintroduce it in the explanation of it.
   */
  const usdc = (amount: bigint): string => `${amount.toString(10)} USDC minor units`;

  /*
   * Both halves, always. The refusal means *neither* rail could pay, so naming only the one
   * the reader happens to be thinking about is how someone funds the vault to fix a problem
   * that was a missing Hedera key. The Arc clause comes first because it is the venue's
   * reading and the cheaper thing to correct.
   */
  const arc =
    r.vault === null
      ? 'this venue escrows no mandate capital on Arc'
      : r.vault.depositedUsdcMinor === null
        ? 'the Arc vault could not be read, so its backing is unknown rather than absent'
        : `mandate ${r.mandateId} holds ${usdc(r.vault.depositedUsdcMinor)} on Arc against ` +
          `the ${usdc(r.vault.requiredUsdcMinor)} its committed capital needs`;

  const hedera = !r.x402.configured
    ? 'no Hedera key is configured on this agent, so it cannot sign an x402 payment'
    : r.x402.balanceTinybars === null
      ? 'the x402 payer’s balance could not be read, so whether it can pay is unknown'
      : 'the x402 payer holds no HBAR';

  return (
    `Not armed: ${arc}, and ${hedera}. With neither rail able to carry the cash leg, ` +
    'arming would hold the seller’s paper against a payment that never arrives.'
  );
}

/**
 * The on-chain spelling of one refusal code, expressed as a type rather than as data.
 *
 * Written this way so identity is enforced rather than merely asserted: the seven codes both
 * layers model cannot be given any value but their own name, which is the half of a rename
 * that would otherwise be applied to the key and forgotten on the value.
 */
type OnChainSpelling<C extends AgentRefusalCode> = C extends 'INELIGIBLE_JURISDICTION'
  ? 'CONTROL_LIST_BLOCKED'
  : C extends 'CURRENCY_MISMATCH' | 'CASH_LEG_UNPAYABLE'
    ? null
    : C;

/**
 * The same refusals under the on-chain vocabulary.
 *
 * **The two vocabularies were unified**: `libraries/ReasonCodes.sol` was renamed to spell
 * every overlapping code exactly as `@facture/shared` spells it, so a single decision now
 * reads the same in a `MatchRefused` event and in the API. That was the point — the product
 * claims every refusal names its reason, and two names for one decision undercuts it.
 *
 * What is left is therefore not a translation table. It is a record of the only three places
 * the two layers do not line up, and {@link OnChainSpelling} makes the compiler enforce that:
 * every other code must map to itself, so a rename applied to a key but not to its value stops
 * being something anyone can write. Deleting the map would delete the three facts with it.
 *
 * - `INELIGIBLE_JURISDICTION` is the one genuine translation, and it is not a leftover of the
 *   rename. The book does not decide jurisdiction at all — `AtsComplianceGate` does, by asking
 *   the instrument's own `ControlList`, and what it emits is `CONTROL_LIST_BLOCKED`. There is
 *   no `INELIGIBLE_JURISDICTION` in `ReasonCodes.sol` for this to be identical to. The
 *   asymmetry is about reading events back rather than about anything this agent can say:
 *   `INELIGIBLE_JURISDICTION` is absent from {@link AGENT_EMITTED_REFUSAL_CODES} precisely
 *   because only a diamond the agent has not called could decide it.
 * - `CURRENCY_MISMATCH` is `null` because the on-chain book does not model currency.
 * - `CASH_LEG_UNPAYABLE` is `null` because the venue does not refuse this at all — it always
 *   has a rail to offer — so there is no on-chain refusal for it to be the same as. It is
 *   this agent declining to arm what it cannot finish, which is a fact about the agent.
 */
export const ON_CHAIN_REASON_CODE: { readonly [C in AgentRefusalCode]: OnChainSpelling<C> } = {
  RATING_BELOW_MANDATE: 'RATING_BELOW_MANDATE',
  TENOR_EXCEEDS_MANDATE: 'TENOR_EXCEEDS_MANDATE',
  EXPOSURE_EXHAUSTED: 'EXPOSURE_EXHAUSTED',
  DEBTOR_CONCENTRATION: 'DEBTOR_CONCENTRATION',
  MANDATE_NOT_ACTIVE: 'MANDATE_NOT_ACTIVE',
  INVOICE_NOT_CONFIRMED: 'INVOICE_NOT_CONFIRMED',
  NOT_KYC_VERIFIED: 'NOT_KYC_VERIFIED',
  INELIGIBLE_JURISDICTION: 'CONTROL_LIST_BLOCKED',
  CURRENCY_MISMATCH: null,
  CASH_LEG_UNPAYABLE: null,
};

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * The decision
 * ───────────────────────────────────────────────────────────────────────────────────── */

/**
 * One invoice, reduced to the four facts a mandate prices against: whose credit, how long,
 * how much, and in what currency.
 *
 * `tenorDays` is passed rather than a due date because the caller has already read the
 * clock once for the whole book, and re-deriving it per mandate would let two mandates in
 * one pass disagree about what day it is.
 */
export interface InvoiceCandidate {
  readonly invoiceId: string;
  readonly debtorId: string;
  readonly debtorName?: string | undefined;
  /** The debtor's earned rating, from the venue. Never inferred locally. */
  readonly rating: Rating;
  /** UTC calendar days to maturity, clamped at zero. */
  readonly tenorDays: number;
  readonly faceValue: MinorUnits;
  readonly currency: Currency;
}

/**
 * What the mandate commits to when it takes an invoice.
 *
 * `proceeds` is the amount that must be paid *today* and therefore the amount that
 * consumes both caps — not `faceValue`. The mandate pays the discounted price now and is
 * repaid face at maturity, so testing capacity against face would refuse mandates that can
 * comfortably afford the trade. This matches the venue's `bestQuote`, which is what makes
 * the agent's answer and the venue's answer agree.
 */
export interface MandateAcceptance {
  readonly mandateId: string;
  readonly invoiceId: string;
  readonly debtorId: string;
  readonly faceValue: MinorUnits;
  readonly discount: MinorUnits;
  readonly proceeds: MinorUnits;
  readonly annualisedYieldBps: Bps;
  readonly tenorDays: number;
  readonly currency: Currency;
}

export type MandateDecision = Result<MandateAcceptance, Refusal>;

/**
 * Does this mandate take this invoice, and if not, why?
 *
 * Pure: no clock, no network, no Circle. Given the same three arguments it returns the same
 * answer, which is what makes it testable and what makes it safe to run before spending.
 *
 * The check order mirrors `@facture/shared`'s `bestQuote` exactly, and that is a
 * requirement rather than a coincidence. The agent decides what to bid on; the venue
 * decides what to fill. If the two screened in a different order they would refuse the same
 * invoice for different stated reasons, and the receipt the seller reads would not match
 * the one the buyer reads.
 *
 * 1. `MANDATE_NOT_ACTIVE`  — an unfunded or withdrawn bid is not on the curve at all.
 * 2. `CURRENCY_MISMATCH`   — a EUR invoice never matches a USD mandate.
 * 3. `RATING_BELOW_MANDATE`— the debtor's earned rating is below the floor.
 * 4. `TENOR_EXCEEDS_MANDATE` — days to maturity exceed the ceiling. Inclusive at the bound.
 * 5. `EXPOSURE_EXHAUSTED`  — the unallocated balance cannot cover the proceeds.
 * 6. `DEBTOR_CONCENTRATION`— there is room overall, but not against this debtor.
 *
 * The two capacity checks come last because they need the price, and the price needs the
 * tenor to have passed. The four cheap, more explanatory checks come first: a buyer whose
 * mandate is unfunded should be told that, not told about a rating floor.
 */
export function decide(
  terms: MandateTerms,
  allocations: MandateAllocations,
  candidate: InvoiceCandidate,
): MandateDecision {
  if (terms.status !== 'active') {
    return err({ code: 'MANDATE_NOT_ACTIVE', status: terms.status });
  }

  if (terms.currency !== candidate.currency) {
    return err({
      code: 'CURRENCY_MISMATCH',
      invoiceCurrency: candidate.currency,
      mandateCurrency: terms.currency,
    });
  }

  if (!meetsRatingFloor(candidate.rating, terms.minRating)) {
    return err({
      code: 'RATING_BELOW_MANDATE',
      debtorId: candidate.debtorId,
      debtorRating: candidate.rating,
      minRating: terms.minRating,
    });
  }

  // Inclusive: an invoice at exactly `maxTenorDays` is inside a "ninety days or less" bid.
  if (candidate.tenorDays > terms.maxTenorDays) {
    return err({
      code: 'TENOR_EXCEEDS_MANDATE',
      tenorDays: candidate.tenorDays,
      maxTenorDays: terms.maxTenorDays,
    });
  }

  // Integer arithmetic throughout, from `@facture/shared`. One exact rational, one
  // division, rounded up in the buyer's favour. No float touches this path.
  const price = priceInvoice(candidate.faceValue, terms.annualisedYieldBps, candidate.tenorDays);
  const required = price.proceeds;

  const pool = unallocated(terms, allocations);
  if (pool < required) {
    return err({
      code: 'EXPOSURE_EXHAUSTED',
      required,
      unallocated: pool,
      currency: candidate.currency,
    });
  }

  const headroom = debtorHeadroom(terms, allocations, candidate.debtorId);
  if (headroom < required) {
    return err({
      code: 'DEBTOR_CONCENTRATION',
      debtorId: candidate.debtorId,
      debtorName: candidate.debtorName,
      required,
      remainingForDebtor: headroom,
      maxPerDebtor: terms.maxPerDebtor,
      currency: candidate.currency,
    });
  }

  return ok({
    mandateId: terms.id,
    invoiceId: candidate.invoiceId,
    debtorId: candidate.debtorId,
    faceValue: candidate.faceValue,
    discount: price.discount,
    proceeds: price.proceeds,
    annualisedYieldBps: terms.annualisedYieldBps,
    tenorDays: candidate.tenorDays,
    currency: candidate.currency,
  });
}

/**
 * The second half of the pre-flight: is there a rail this agent can actually pay on?
 *
 * {@link decide} answers a question about the mandate's *books* — is there headroom. This
 * answers a question about money: whether the cash leg of the trade it is about to arm can
 * be settled by anyone in this process. They are different questions and both have to pass.
 *
 * ## Two rails, and either one is enough
 *
 * - **Escrowed on Arc.** The venue draws the payment out of `MandateVault` and nothing here
 *   signs anything. `backed` is the venue's own reading, measured against the mandate's
 *   WHOLE committed capital.
 * - **x402 on Hedera.** The venue issues a challenge and this process signs it with the
 *   buyer's Hedera key. That needs a key to exist and an account behind it with something in
 *   it — see `cash.ts` for why no other key the agent holds can produce that signature.
 *
 * **No price is compared against either.** For the vault that is because `backed` already
 * covers everything the headroom allows. For x402 it is because the amount is named by the
 * challenge, in the settlement asset's own unit, and that check belongs at the moment of
 * signing rather than here — converting a price into tinybars would mean a second copy of
 * the venue's ppm scale, which is the defect this whole pre-flight was rewritten to remove.
 * So this returns *which rail it expects*, and the exact arithmetic happens where the venue
 * has already done the conversion.
 *
 * ## What the expected rail is and is not
 *
 * It is a prediction, not a decision. `chooseRail` on the venue re-reads the vault on every
 * `POST /v1/trades` and is the authority; a stale reading here costs a wasted arm at worst.
 * The prediction is still worth making, because refusing to arm what nothing can pay for is
 * the difference between a missed fill and a seller's paper held against a payment that
 * never comes.
 *
 * An unreadable answer refuses on the x402 side and falls through on the Arc side, and the
 * asymmetry is deliberate: an unreadable vault is a case the venue itself already handles by
 * routing to x402, whereas an unreadable payer balance is this process failing to establish
 * that it can pay at all.
 */
export function checkCashLegPayable(input: {
  readonly mandateId: string;
  readonly vault: VaultBacking | null;
  readonly x402: X402Readiness;
}): Result<ExpectedRail, CashLegUnpayableRefusal> {
  // Escrowed capital settles without a signature. Checked first because it is the rail the
  // venue prefers, and because it costs this process nothing at all.
  if (input.vault?.backed === true) return ok('arc-vault');

  if (input.x402.configured && (input.x402.balanceTinybars ?? 0n) > 0n) return ok('x402-hedera');

  return err({
    code: 'CASH_LEG_UNPAYABLE',
    mandateId: input.mandateId,
    vault: input.vault,
    x402: input.x402,
  });
}

/**
 * Apply an acceptance to a running allocation set.
 *
 * Used within a single pass over the book so that two invoices considered against one
 * mandate cannot both be told the same dollar is free. Without this, a mandate with
 * $50,000 unallocated would accept two $40,000 invoices in the same tick, and the second
 * fill would fail at the venue after the agent had already announced it would take it.
 */
export function withAllocation(
  allocations: MandateAllocations,
  acceptance: MandateAcceptance,
): MandateAllocations {
  return {
    total: allocations.total + acceptance.proceeds,
    byDebtor: {
      ...allocations.byDebtor,
      [acceptance.debtorId]: exposureTo(allocations, acceptance.debtorId) + acceptance.proceeds,
    },
  };
}

/**
 * Invariants a mandate must satisfy before it is allowed to quote.
 *
 * Throws rather than returning a refusal: a per-debtor cap above the total ceiling or a
 * negative commitment is a bug in whoever built the mandate, not a domain outcome. The
 * distinction matters — a refusal is shown to a counterparty, and none of these are things
 * a counterparty did.
 */
export function assertWellFormed(terms: MandateTerms): void {
  if (terms.totalCommitted < 0n) {
    throw new RangeError(`Mandate ${terms.id}: totalCommitted must be non-negative`);
  }
  if (terms.maxPerDebtor < 0n) {
    throw new RangeError(`Mandate ${terms.id}: maxPerDebtor must be non-negative`);
  }
  /*
   * A per-debtor cap *above* `totalCommitted` is deliberately not an error. `totalCommitted`
   * is escrowed capital, not the ceiling the buyer wrote: a mandate written for $200,000
   * total and $50,000 per customer but funded to $30,000 so far is legitimate, and its pool
   * simply binds before its concentration cap does. `availableFor` takes the lesser of the
   * two, so a non-binding cap costs nothing.
   */
  if (!Number.isInteger(terms.maxTenorDays) || terms.maxTenorDays < 1) {
    throw new RangeError(`Mandate ${terms.id}: maxTenorDays must be a positive integer`);
  }
  if (!Number.isInteger(terms.annualisedYieldBps) || terms.annualisedYieldBps < 0) {
    throw new RangeError(
      `Mandate ${terms.id}: annualisedYieldBps must be a non-negative whole number of bps`,
    );
  }
  if (terms.minRating === 'D') {
    throw new RangeError(
      `Mandate ${terms.id}: a floor of D accepts a customer already known to default, ` +
        'which is not a bid anyone means to write',
    );
  }
  if (RATING_RANK[terms.minRating] === undefined) {
    throw new RangeError(`Mandate ${terms.id}: unknown rating floor ${terms.minRating}`);
  }
  if (CURRENCY_DECIMALS[terms.currency] === undefined) {
    throw new RangeError(`Mandate ${terms.id}: unknown currency ${terms.currency}`);
  }
}
