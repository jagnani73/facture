// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Rating, MandateStatus, MatchStatus} from "../libraries/FactureTypes.sol";
import {IDvpEscrow} from "./IDvpEscrow.sol";

/**
 * @title IMandateBook
 * @notice The standing-bid book. Buyers post quotes over risk buckets; invoices price off them.
 *
 * @dev The venue's central claim is that you cannot standardise invoices, so you standardise the BID
 *      instead. A buyer never browses individual receivables; they post one mandate - "any A-rated
 *      paper, 60 days or less, at 8% annualised, up to $200k total and $50k per debtor" - fund it,
 *      and walk away. The assets stay unique and the buyers become fungible, which is what lets an
 *      arriving invoice be priced immediately by reading the curve at its own rating and tenor.
 *
 *      CAPITAL IS ESCROWED AT FUNDING. This is the single most important property of this contract
 *      and the reason the rest of it is shaped the way it is. A standing quote that is merely
 *      *permitted* - an allowance, a signed intent, an off-chain promise - is indicative, not firm:
 *      the buyer can spend the same balance elsewhere, revoke between quote and fill, or simply not
 *      have the money. A seller reading "worth $39,178 today" on their screen is reading a number
 *      that means nothing unless the capital behind it is already committed.
 *
 *      So capital is escrowed before a mandate can match anything. It is escrowed in {IMandateVault}
 *      on Arc rather than here, for reasons set out under DEPLOYMENT TOPOLOGY below, and this
 *      contract holds an attested view of it. Every matching path is bounded by
 *      `totalCommitted - allocated`, and {authoriseRelease} can never touch the allocated portion.
 *      Two consequences fall out for free, and both are things a naive design has to patch
 *      separately:
 *
 *        - Two invoices arriving against one mandate in the same block cannot both fill if only one
 *          is affordable. The second is refused with `EXPOSURE_EXHAUSTED`, deterministically,
 *          because allocation is a state write and not a check against a live wallet balance.
 *        - Overcommitment across mandates is structurally impossible rather than merely discouraged,
 *          because the same tokens cannot be escrowed twice.
 *
 *      REFUSALS ARE OUTPUTS, NOT FAILURES. Three entry points evaluate the identical predicate and
 *      differ only in how they report it, which is what lets the venue show a seller "three mandates
 *      would take this" and tell a rejected buyer why in words:
 *
 *        {previewMatch}  view, no state change, returns a reason code. Drives the UI and keepers.
 *        {tryMatch}      does not revert on refusal; emits {MatchRefused} and returns false. The
 *                        product path, because it leaves a durable receipt a third party can check.
 *        {matchInvoice}  strict; reverts with a typed custom error carrying the offending values.
 *                        The integrator path, for callers who want the transaction to fail loudly.
 *
 *      DEPLOYMENT TOPOLOGY. This contract needs two things that naturally live on different chains:
 *      a synchronous pre-trade compliance answer from an ATS instrument (Hedera) and custody of the
 *      buyer's USDC (Arc, where treasury capital already sits). Neither is negotiable, so rather
 *      than pick one the venue splits them along the line of what actually has to be live:
 *
 *        - COMPLIANCE MUST BE SYNCHRONOUS. It is a legal fact that has to be exactly right at the
 *          instant of matching, and "the venue refuses to match" is the whole claim against an AMM
 *          that discovers illegality at settlement. So this book deploys on HEDERA, beside the paper
 *          and the gate, and eligibility is a real `staticcall` inside the matching transaction.
 *        - A FUNDED BALANCE DOES NOT HAVE TO BE SYNCHRONOUS. It is a number only the buyer can move.
 *          So the capital stays on ARC in {IMandateVault}, never bridges, and this contract holds an
 *          ATTESTED view of it. The buyer's stablecoins never leave the chain their stablecoins
 *          live on.
 *
 *      WHAT MAKES THE ATTESTED BALANCE SOUND, in one sentence: the vault's only exits require an
 *      authorisation issued HERE, so a buyer cannot pull capital on Arc while this book still counts
 *      it as committed. Overcommitment is closed structurally rather than by a synchronous read.
 *
 *      STALENESS, AND WHY IT FAILS SAFE. Two lags exist and neither can inflate the attested
 *      balance. An Arc deposit is not credited until the attester relays it, so the book
 *      under-counts until then. A release decrements `totalCommitted` at the moment it is
 *      AUTHORISED, before the tokens move on Arc, so the book under-counts then too. Under an
 *      honest attester the attested balance is a lower bound on real withdrawable capital at every
 *      instant, and both windows fail toward refusing a match rather than toward promising money
 *      that is not there.
 *
 *      THE HONEST WEAK POINT. Attested-above-real is not reachable by lag; it is reachable only by
 *      an attester crediting a deposit that never happened, after which this book can match a trade
 *      the cash leg cannot pay and the failure surfaces at settlement. v1 runs a single trusted
 *      attester and says so. {IMandateVault} documents the three bounds that limit the damage even
 *      then, and the v2 path (attester threshold, or a light-client proof of the Arc deposit log).
 *      Nothing about this interface changes when that lands.
 *
 *      THIS IS NOT ATOMIC and is not described as such. It is a two-phase commit with a trusted
 *      relay, whose failure mode is a liveness stall recovered by attester rotation, not a loss.
 *
 *      SETTLEMENT IS PROVEN, NOT ASSERTED. The two paths that end a position - {confirmSettlement}
 *      and {confirmMaturity} - take no role at all. Each reads its own proof: a claimed delivery
 *      lock out of {IDvpEscrow} on this chain, and the instrument's own answer to who holds it now.
 *      Both are therefore permissionless, which is not a convenience but the substance of the claim:
 *      a buyer who has taken the paper cannot decline to pay for it, and a holder cannot be denied
 *      redemption by a keeper that has gone dark. The one role left on this side of the lifecycle is
 *      the early cancel in {cancelMatch}, and it expires into a permissionless one.
 */
interface IMandateBook {
    // -------------------------------------------------------------------------------------------
    // Structs
    // -------------------------------------------------------------------------------------------

    /**
     * @notice A funded standing bid over a risk bucket.
     *
     * @dev Storage layout is deliberate, not incidental. Three slots:
     *
     *        slot 0: buyer(20) + minRating(1) + status(1) + maxTenorDays(4) + annualisedYieldBps(2)
     *                = 28 bytes. All of the mandate's *terms*, which are written once at
     *                {postMandate} and then only read.
     *        slot 1: totalCommitted(16) + allocated(16) = 32 bytes exactly.
     *        slot 2: maxPerDebtor(16), 16 bytes spare for future limits.
     *
     *      Slot 1 is the point of the layout. `totalCommitted` and `allocated` are the two values a
     *      match mutates, and pairing them means the hot path costs one warm SSTORE rather than two.
     *      On Hedera, where gas is billed close to the limit you declare rather than to what you
     *      consume, keeping the matching transaction genuinely small matters more than usual.
     *
     *      `uint128` for money is not a compromise. USDC has 6 decimals, so `type(uint128).max` is
     *      about 3.4e32 units, i.e. 3.4e26 dollars. The cap is unreachable, and halving the width is
     *      what lets committed and allocated share a slot.
     */
    struct Mandate {
        /// @dev Owner of the mandate and of the escrowed capital. The only address that may withdraw.
        address buyer;
        /// @dev Lowest debtor rating this bid will take. Compared with `>=`; see {Rating}.
        Rating minRating;
        /// @dev Lifecycle. Only `Active` matches. Never `Uninitialised` for a posted mandate.
        MandateStatus status;
        /// @dev Longest tenor in days this bid will take, measured from now to the invoice due date.
        uint32 maxTenorDays;
        /// @dev The quote itself: annualised discount rate in basis points. 800 == 8.00%.
        uint16 annualisedYieldBps;
        /// @dev Settlement currency escrowed in this contract for this mandate. Only funding raises it.
        uint128 totalCommitted;
        /// @dev Portion of `totalCommitted` locked to open matches. Never withdrawable.
        uint128 allocated;
        /// @dev Concentration cap: most this mandate will ever hold against any single debtor.
        uint128 maxPerDebtor;
    }

    /**
     * @notice One allocation of mandate capital to one invoice, awaiting cross-chain settlement.
     * @dev An `Open` match holds capital that is neither withdrawable by the buyer nor spendable by
     *      any other match. It must resolve to `Settled` or `Cancelled`; there is no path that leaks
     *      the allocation. The terms are snapshotted at match time rather than re-read at settlement
     *      because the mandate's quote may change afterwards and the trade was struck at the old one.
     */
    struct Match {
        /// @dev The mandate whose capital is allocated.
        uint256 mandateId;
        /// @dev The receivable being bought.
        bytes32 invoiceId;
        /// @dev Snapshot of the mandate's buyer at match time.
        address buyer;
        /// @dev When the match was struck, unix seconds. Starts the settlement timeout.
        uint64 matchedAt;
        /// @dev Lifecycle of this allocation.
        MatchStatus status;
        /// @dev Snapshot of the invoice's seller; the payee of `price`.
        address seller;
        /// @dev Days from match to maturity, snapshotted. Priced off this, not off a later reading.
        uint32 tenorDays;
        /// @dev Snapshot of the mandate's quote at match time.
        uint16 yieldBps;
        /// @dev What the buyer pays now, in settlement-currency units. The allocated amount.
        uint128 price;
        /// @dev What the instrument redeems for at maturity. `faceValue - price` is the carry.
        uint128 faceValue;
        /**
         * @dev Snapshot of the debtor this exposure is booked against.
         *
         *      Costs a whole extra slot, and is worth it. Concentration accounting is symmetric -
         *      the debtor credited on cancellation must be the one debited on match - and the
         *      invoice registry is an external, mutable contract. Re-reading `debtorId` at
         *      cancellation time would mean a registry edit between match and cancel silently
         *      decrements the WRONG debtor's exposure, leaving the real one permanently overstated
         *      and quietly shrinking the mandate's capacity forever. Snapshotting removes the
         *      dependency rather than assuming the registry is well-behaved.
         */
        bytes32 debtorId;
        /**
         * @dev Snapshot of the ATS instrument this trade delivers.
         *
         *      Same argument as `debtorId`, applied to settlement rather than to concentration.
         *      {confirmSettlement} proves delivery by reading a lock out of {IDvpEscrow} and
         *      checking that the escrowed asset is this instrument; {confirmMaturity} asks this
         *      instrument who holds it now. Both of those are authorisation decisions, so neither
         *      may depend on a registry record that can be rewritten between match and settlement.
         *      Costs one slot, and buys the property that the delivery proof is measured against
         *      the instrument the trade was struck on rather than the one the registry names later.
         */
        address instrument;
    }

    // -------------------------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------------------------

    /**
     * @notice A buyer posted a standing bid. The bid is NOT yet firm - it has no capital behind it.
     * @dev Deliberately separate from {MandateFunded}. A posted-but-unfunded mandate is visible in
     *      the book and matches nothing, which keeps "posted" and "firm" from being confused by any
     *      consumer of these logs.
     */
    event MandatePosted(
        uint256 indexed mandateId,
        address indexed buyer,
        Rating minRating,
        uint32 maxTenorDays,
        uint16 annualisedYieldBps,
        uint128 maxPerDebtor
    );

    /**
     * @notice Capital was escrowed against a mandate. This is the moment the quote becomes firm.
     * @param mandateId The mandate funded.
     * @param funder Who supplied the capital, which need not be the buyer.
     * @param amount Units added to `totalCommitted`.
     * @param totalCommitted The new total, so an indexer never has to accumulate.
     */
    event MandateFunded(
        uint256 indexed mandateId,
        address indexed funder,
        bytes32 indexed depositRef,
        uint128 amount,
        uint128 totalCommitted
    );

    /**
     * @notice The book authorised unallocated capital to leave the vault. Allocated capital never can.
     * @dev The first half of a two-step release. The attester relays `authId` to
     *      {IMandateVault-executeRelease}, which pays the mandate's registered buyer. This book has
     *      already decremented `totalCommitted`, so between the two steps it under-counts - the safe
     *      direction.
     * @param authId Single-use authorisation id. Derived from this chain and contract; see
     *        {computeAuthorisationId}.
     * @param mandateId The mandate released from.
     * @param buyer The only address the vault will pay for this mandate.
     * @param amount Units authorised to leave.
     * @param totalCommitted The mandate's new attested balance.
     */
    event ReleaseAuthorised(
        bytes32 indexed authId,
        uint256 indexed mandateId,
        address indexed buyer,
        uint128 amount,
        uint128 totalCommitted
    );

    /**
     * @notice The book authorised a settled trade to be paid out of the vault.
     *
     * @dev Relayed by the attester to {IMandateVault-executePayout}. The allocation is consumed here
     *      at the moment of authorisation, not when the tokens move on Arc.
     *
     *      `deliveryLockId` and `secretHash` are the delivery leg's own parameters, copied out of
     *      the {IDvpEscrow} lock this authorisation was proven against. They travel with the
     *      authorisation because the cash leg is opened as the mirror of the delivery leg: the vault
     *      escrows the price under the SAME hash and, by convention, the same lock id, so an
     *      operator or a proof view can pair the two legs of one trade across the two chains without
     *      a lookup table. The vault does not have to trust either value - see
     *      {IMandateVault-executePayout} for what it derives locally instead.
     *
     * @param authId Single-use authorisation id.
     * @param matchId The settled match.
     * @param mandateId The mandate whose capital pays.
     * @param seller The payee recorded at match time.
     * @param amount Units authorised to leave.
     * @param deliveryLockId The delivery leg's lock, on this chain's escrow.
     * @param secretHash The hashlock both legs of this trade share.
     */
    event PayoutAuthorised(
        bytes32 indexed authId,
        bytes32 indexed matchId,
        uint256 indexed mandateId,
        address seller,
        uint128 amount,
        bytes32 deliveryLockId,
        bytes32 secretHash
    );

    /**
     * @notice A settled position reached maturity, and redemption routes to the holder of record.
     *
     * @dev `holder` is read from the instrument at the moment of the call, never from the match. A
     *      position that changed hands on the secondary market pays whoever holds the paper NOW,
     *      which is what makes the paper genuinely transferable: a second buyer with no way to be
     *      paid is not a buyer.
     *
     * @param matchId The settled match that matured.
     * @param mandateId The mandate that originally bought it, whose debtor exposure now ends.
     * @param instrument The ATS bond, and the source of truth for `holder`.
     * @param holder Who held the whole instrument when maturity was confirmed.
     * @param faceValue What the instrument redeems for.
     */
    event MaturityConfirmed(
        bytes32 indexed matchId,
        uint256 indexed mandateId,
        address indexed instrument,
        address holder,
        uint128 faceValue
    );

    /// @notice A buyer paused, resumed or closed their mandate. Existing allocations are unaffected.
    event MandateStatusChanged(uint256 indexed mandateId, MandateStatus previousStatus, MandateStatus newStatus);

    /**
     * @notice An invoice matched a mandate. Capital is now allocated and settlement is in flight.
     * @param matchId Deterministic id for the allocation; see {computeMatchId}.
     * @param invoiceId The receivable bought.
     * @param mandateId The bid that took it.
     * @param buyer Payer and prospective holder of the instrument.
     * @param seller Payee of `price`.
     * @param price Settlement-currency units allocated to this trade.
     * @param faceValue Redemption value at maturity.
     * @param tenorDays Days from match to maturity.
     * @param yieldBps The quote this cleared at.
     */
    event Matched(
        bytes32 indexed matchId,
        bytes32 indexed invoiceId,
        uint256 indexed mandateId,
        address buyer,
        address seller,
        uint128 price,
        uint128 faceValue,
        uint32 tenorDays,
        uint16 yieldBps
    );

    /**
     * @notice A match was evaluated and refused, with the reason recorded on-chain.
     *
     * @dev The product-facing counterpart to reverting. A funder whose mandate did not take an
     *      invoice is told why in a log they can read without trusting the venue, rather than being
     *      handed a failed transaction. Emitted only by {tryMatch}; {matchInvoice} reverts instead,
     *      and a revert would discard this event along with everything else in the call.
     *
     * @param invoiceId The receivable that was offered.
     * @param mandateId The bid that refused it.
     * @param reasonCode The specific refusal. See {ReasonCodes}.
     */
    event MatchRefused(bytes32 indexed invoiceId, uint256 indexed mandateId, bytes32 reasonCode);

    /// @notice Settlement completed; `price` left the contract for the seller and the allocation was consumed.
    event MatchSettled(bytes32 indexed matchId, uint256 indexed mandateId, address indexed seller, uint128 price);

    /// @notice Settlement failed or timed out; the allocation returned to the mandate's unallocated balance.
    event MatchCancelled(bytes32 indexed matchId, uint256 indexed mandateId, bytes32 reasonCode);

    // -------------------------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------------------------
    //
    // Every refusal below has exactly one paired `ReasonCodes` constant. `matchInvoice` raises the
    // error, `tryMatch` emits the code, and both come from the same evaluation, so the two
    // representations cannot drift apart.

    /// @notice No mandate has ever been posted under this id. Paired with `MANDATE_UNKNOWN`.
    error MandateUnknown(uint256 mandateId);

    /// @notice The mandate is paused or closed and is not accepting matches. Paired with `MANDATE_NOT_ACTIVE`.
    error MandateNotActive(uint256 mandateId, MandateStatus status);

    /// @notice The invoice has never been listed. Paired with `INVOICE_UNKNOWN`.
    error InvoiceUnknown(bytes32 invoiceId);

    /**
     * @notice The debtor has not acknowledged this invoice, so it is not quotable.
     * @dev Paired with `INVOICE_NOT_CONFIRMED`. Checked first because it is the cheapest read and
     *      because an unconfirmed invoice has no honest price at all - the other checks would be
     *      evaluating terms that nobody has agreed to.
     */
    error InvoiceNotConfirmed(bytes32 invoiceId);

    /// @notice The debtor's earned rating sits below the mandate's floor. Paired with `RATING_BELOW_MANDATE`.
    error RatingBelowMandate(bytes32 invoiceId, Rating invoiceRating, Rating minRating);

    /// @notice Days to maturity exceed the mandate's ceiling. Paired with `TENOR_EXCEEDS_MANDATE`.
    error TenorExceedsMandate(bytes32 invoiceId, uint32 tenorDays, uint32 maxTenorDays);

    /// @notice The invoice is at or past its due date; there is no tenor left to price. Paired with `INVOICE_MATURED`.
    error InvoiceMatured(bytes32 invoiceId, uint64 dueDate);

    /**
     * @notice The mandate's unallocated balance is smaller than the price.
     * @dev Paired with `EXPOSURE_EXHAUSTED`. This is the refusal that makes a standing quote
     *      firm rather than indicative, and the one that resolves two invoices racing for one bid.
     */
    error ExposureExhausted(uint256 mandateId, uint128 price, uint128 unallocated);

    /// @notice Taking this invoice would push exposure to one debtor past its cap. Paired with `DEBTOR_CONCENTRATION`.
    error DebtorConcentration(uint256 mandateId, bytes32 debtorId, uint128 wouldBe, uint128 maxPerDebtor);

    /**
     * @notice The instrument itself refuses this buyer.
     * @dev Carries the gate's own reason code rather than flattening it, so a refusal originating
     *      inside a third-party diamond survives intact all the way to the funder's screen.
     */
    error NotEligible(address instrument, address buyer, bytes32 reasonCode);

    /// @notice The caller is not the mandate's buyer.
    error NotMandateBuyer(uint256 mandateId, address caller);

    /// @notice The caller is not permitted to strike matches. See {setMatcher}.
    error NotMatcher(address caller);

    /// @notice The caller is not the attester permitted to credit vault deposits.
    error NotAttester(address caller);

    /**
     * @notice This vault deposit has already been credited.
     * @dev The replay guard on the attestation path. An honest relay retrying after a dropped
     *      transaction and a malicious relay double-crediting are indistinguishable from here, so
     *      both are refused by the same check.
     */
    error DepositAlreadyCredited(bytes32 depositRef);

    /// @notice The caller is not permitted to cancel settlement early. See {setSettler}.
    error NotSettler(address caller);

    /// @notice No match exists under this id.
    error MatchUnknown(bytes32 matchId);

    /// @notice The match is not `Open`, so it can be neither settled nor cancelled again.
    error MatchNotOpen(bytes32 matchId, MatchStatus status);

    /// @notice The match has not settled, so there is no position to mature.
    error MatchNotSettled(bytes32 matchId, MatchStatus status);

    // --- delivery proof -----------------------------------------------------------------------
    //
    // The five refusals below are what replaced "an authorised keeper says delivery happened". Each
    // names the specific way the presented lock fails to be a proof of THIS trade's delivery.

    /**
     * @notice The presented delivery lock has not been claimed, so no preimage was ever revealed.
     * @dev The load-bearing one. A `Locked` lock means the paper is escrowed but the buyer has not
     *      taken it; a `Refunded` one means the trade failed and the seller has it back. Neither
     *      releases the buyer's capital.
     */
    error DeliveryNotProven(bytes32 matchId, bytes32 lockId, IDvpEscrow.LockStatus status);

    /// @notice The lock is a real lock, but it belongs to a different trade or to the wrong leg.
    error DeliveryLockMismatch(bytes32 matchId, bytes32 lockId, bytes32 tradeRef, IDvpEscrow.LegKind kind);

    /// @notice The paper in the lock was escrowed by someone other than this trade's seller.
    error DeliveryDepositorMismatch(bytes32 matchId, address expectedSeller, address actualDepositor);

    /// @notice The lock delivers to someone other than this trade's buyer.
    error DeliveryBeneficiaryMismatch(bytes32 matchId, address expectedBuyer, address actualBeneficiary);

    /// @notice The lock escrows an asset that is not this trade's instrument.
    error DeliveryAssetMismatch(bytes32 matchId, address expectedInstrument, address actualAsset);

    // --- maturity -----------------------------------------------------------------------------

    /// @notice The position has not reached its due date yet. See {maturityOf}.
    error NotYetMatured(bytes32 matchId, uint64 maturesAt);

    /**
     * @notice The address offered as the holder does not hold this instrument.
     * @dev The instrument itself is asked, so a caller cannot nominate a payee. Fails closed: a
     *      partial holding is not a holder either, because an all-or-nothing position is the only
     *      shape this venue issues.
     */
    error NotInstrumentHolder(bytes32 matchId, address instrument, address claimedHolder);

    /// @notice The instrument could not be asked who holds it, so maturity cannot be routed.
    error HolderProbeFailed(bytes32 matchId, address instrument);

    /// @notice The invoice already has an open or settled allocation. One receivable sells once.
    error InvoiceAlreadyAllocated(bytes32 invoiceId, bytes32 existingMatchId);

    /// @notice A zero amount was supplied where a positive one is required.
    error ZeroAmount();

    /// @notice A mandate term was outside its permitted range.
    error InvalidTerms();

    // -------------------------------------------------------------------------------------------
    // Mandate lifecycle
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Post a standing bid. It matches nothing until it is funded.
     * @param minRating Lowest debtor rating this bid accepts.
     * @param maxTenorDays Longest tenor accepted, in days. Must be non-zero.
     * @param annualisedYieldBps The quote, in basis points. Must be non-zero and below `MAX_YIELD_BPS`.
     * @param maxPerDebtor Concentration cap per debtor. Must be non-zero.
     * @return mandateId Identifier of the new mandate.
     */
    function postMandate(
        Rating minRating,
        uint32 maxTenorDays,
        uint16 annualisedYieldBps,
        uint128 maxPerDebtor
    ) external returns (uint256 mandateId);

    /**
     * @notice Credit a proven Arc-side deposit to a mandate, making its quote firm.
     *
     * @dev No tokens move here - they are already in {IMandateVault} on Arc. This records the
     *      attested credit. Attester only, relaying a {IMandateVault-Deposited} event.
     *
     *      `depositRef` is the vault's own reference, bound to Arc's chain id and the vault's
     *      address, and it is consumed exactly once. That single check is what stops a relayed
     *      deposit being credited twice, whether by an honest retry or a malicious replay, and it is
     *      why the reference is generated by the vault rather than by the relay.
     *
     *      Anyone may fund a mandate on the vault - a treasury desk funding a policy-capped agent
     *      wallet's mandate is a first-class use - so `funder` is recorded but carries no rights.
     *      Release is bound to the mandate's buyer at both ends, which is what makes that safe.
     *
     * @param mandateId The mandate to credit.
     * @param funder Who supplied the capital on Arc. Informational.
     * @param amount Units deposited.
     * @param depositRef The vault's unique reference for this deposit.
     */
    function creditFunding(uint256 mandateId, address funder, uint128 amount, bytes32 depositRef) external;

    /**
     * @notice Authorise the release of capital that is not locked to an open match.
     *
     * @dev The first step of a two-step release; the second is
     *      {IMandateVault-executeRelease} on Arc, which the attester triggers with the returned
     *      `authId`. This function moves no tokens - it cannot, they are on another chain - it
     *      decrements the attested balance and opens the vault's door by exactly that much.
     *
     *      Bounded by `totalCommitted - allocated`, so allocated capital can never be released. This
     *      is the ordering that makes the attested balance safe: the book gives up its claim on the
     *      capital BEFORE the vault lets it go, so at no instant does the book count money the buyer
     *      could already have taken.
     *
     *      Permitted in every status including `Closed`, because closing a mandate must not strand
     *      capital. Buyer only.
     *
     * @param mandateId The mandate to release from.
     * @param amount Units to release.
     * @return authId Single-use authorisation for the vault. Relay this to Arc.
     */
    function authoriseRelease(uint256 mandateId, uint128 amount) external returns (bytes32 authId);

    /// @notice Pause, resume or close a mandate. Buyer only. Never affects existing allocations.
    function setMandateStatus(uint256 mandateId, MandateStatus newStatus) external;

    // -------------------------------------------------------------------------------------------
    // Matching
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Evaluate a match without touching state. The read-only half of the refusal apparatus.
     * @param invoiceId The receivable offered.
     * @param mandateId The bid to test.
     * @return ok True if a match would succeed right now.
     * @return reasonCode `ReasonCodes.NONE` when `ok`, else the first failing check.
     * @return price What the buyer would pay, in settlement-currency units. Zero when not `ok`.
     * @return tenorDays Days from now to maturity. Zero when not `ok`.
     */
    function previewMatch(
        bytes32 invoiceId,
        uint256 mandateId
    ) external view returns (bool ok, bytes32 reasonCode, uint128 price, uint32 tenorDays);

    /**
     * @notice Match if eligible; on refusal emit {MatchRefused} and return false rather than revert.
     * @dev The product-facing entry point. A refusal here is a successful transaction that produced
     *      a receipt, which is the behaviour the venue promises the rejected party.
     * @param invoiceId The receivable to buy.
     * @param mandateId The bid to fill against.
     * @return ok Whether the match was struck.
     * @return reasonCode `ReasonCodes.NONE` on success, else the refusal that was logged.
     * @return matchId The new match on success, `bytes32(0)` on refusal.
     */
    function tryMatch(
        bytes32 invoiceId,
        uint256 mandateId
    ) external returns (bool ok, bytes32 reasonCode, bytes32 matchId);

    /**
     * @notice Match, or revert with the specific typed error for the first failing check.
     *
     * @dev Checks run in this order, and the order is chosen rather than arbitrary:
     *
     *        1. mandate known and active      cheap local read; nothing else is meaningful without it
     *        2. invoice known and confirmed   an unconfirmed invoice has no honest price
     *        3. rating >= floor               pure comparison on data already loaded
     *        4. tenor <= ceiling              ditto, plus the maturity guard
     *        5. unallocated >= price          needs the price, so it follows the tenor computation
     *        6. per-debtor exposure           needs the price too, and is a second storage read
     *        7. instrument eligibility        LAST, because it is the only external call
     *
     *      Putting the external call last does two jobs. It keeps the common refusals cheap - a bid
     *      that is simply out of money never pays for a cross-contract probe - and it means every
     *      state read that a decision depends on has already happened before control leaves the
     *      contract, so a hostile or reentrant instrument cannot influence checks 1 through 6.
     *
     * @param invoiceId The receivable to buy.
     * @param mandateId The bid to fill against.
     * @return matchId The new match.
     */
    function matchInvoice(bytes32 invoiceId, uint256 mandateId) external returns (bytes32 matchId);

    // -------------------------------------------------------------------------------------------
    // Settlement
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Release an allocation to the seller against an on-chain proof that delivery happened.
     *
     * @dev PERMISSIONLESS, AND THAT IS THE POINT. There is no settler role on this path and no
     *      keeper whose word is taken for it. The caller presents a lock id in the venue's
     *      {IDvpEscrow} on this chain, and the book reads that lock and checks it is a proof of THIS
     *      trade's delivery: claimed (so a preimage was revealed), carrying this `matchId` as its
     *      trade reference, on the delivery leg, escrowed by this match's seller, delivering to this
     *      match's buyer, and holding this match's instrument. Anything less is one of the
     *      `Delivery*` refusals.
     *
     *      Proving delivery rather than asserting it is what makes settlement SAFE TO COMPEL. Once
     *      the buyer has claimed the paper, the seller - or anyone at all - can force the payout
     *      authorisation, so a buyer cannot take delivery and then decline to pay, and a stalled
     *      venue keeper cannot hold a completed trade hostage.
     *
     *      WHY THE LOCK ID IS AN ARGUMENT rather than derived from `matchId`. Lock ids in
     *      {IDvpEscrow} are caller-supplied and opening a lock is permissionless, so any id this
     *      contract could derive could also be squatted: a griefer opens a junk lock at the derived
     *      id and the real seller can never open the delivery leg for that match. Verifying the
     *      CONTENTS of a presented lock removes the squat entirely - a junk lock simply fails the
     *      checks, and a lock that passes them is delivery whatever id it was opened under.
     *
     *      What this cannot check is quantity. The instrument's unit scale is the issuer's, not the
     *      venue's, so the book does not know how many units a face value should be. The buyer's own
     *      claim transaction is the consent that settles that question: nobody else can put a lock
     *      into `Claimed`.
     *
     *      Consumes the allocation - `allocated` and `totalCommitted` both fall - and emits
     *      {PayoutAuthorised} carrying the delivery leg's lock id and hashlock. No tokens move here;
     *      the attester relays `authId` to {IMandateVault-executePayout}. As with a release, the
     *      book gives up its claim first and the vault opens second.
     *
     * @param matchId The allocation to settle.
     * @param deliveryLockId The delivery leg's lock in this chain's escrow. Verified, not trusted.
     * @return authId Single-use payout authorisation for the vault.
     */
    function confirmSettlement(bytes32 matchId, bytes32 deliveryLockId) external returns (bytes32 authId);

    /**
     * @notice Route a matured position's redemption to whoever holds the instrument now.
     *
     * @dev PAYS THE CURRENT HOLDER, NEVER THE ORIGINAL BUYER, and that distinction is the whole
     *      reason this function exists. Paper that pays its first buyer forever cannot legitimately
     *      change hands, because a second buyer would have no way to be paid - so the secondary
     *      market the venue claims to run would not be one. `holder` is therefore not accepted as an
     *      assertion: the instrument is asked, and the answer has to be that `holder` holds the
     *      whole issue.
     *
     *      Permissionless for the same reason {confirmSettlement} is. Every input is proven - the
     *      due date against the match's own snapshot, the holder against the instrument - so there
     *      is nothing left for a role to add, and a keeper who has gone dark cannot strand a
     *      position at maturity.
     *
     *      Also ends the buying mandate's exposure to the debtor, exactly once, because the position
     *      moves to `Matured` and only a `Settled` position may enter it. Both outcomes end the
     *      exposure: a default ends it too, and marks the debtor's rating, which happens off this
     *      contract in the rating engine.
     *
     *      Maturity is measured from the match's own `matchedAt + tenorDays`, never from a fresh
     *      registry read. Tenor was rounded UP at match time, so this is at or after the true due
     *      date - late by less than a day at worst, and never early. A registry read would be
     *      neither: an edited due date could bring maturity forward on a live position.
     *
     * @param matchId The settled position that matured.
     * @param holder The address claimed to hold the instrument. Checked against the instrument.
     */
    function confirmMaturity(bytes32 matchId, address holder) external;

    /**
     * @notice Return an allocation to the mandate after failed or timed-out settlement.
     * @dev `allocated` falls, `totalCommitted` does not, because the tokens never left. The capital
     *      becomes available to the next invoice immediately.
     * @param matchId The allocation to release.
     * @param reasonCode Why settlement did not complete. See {ReasonCodes}.
     */
    function cancelMatch(bytes32 matchId, bytes32 reasonCode) external;

    // -------------------------------------------------------------------------------------------
    // Pricing
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Price a face value at a rate and tenor.
     *
     * @dev Convention: SIMPLE DISCOUNT ON FACE, ACT/365 fixed.
     *
     *          discount = faceValue * annualisedYieldBps * tenorDays / (10_000 * 365)
     *          price    = faceValue - discount
     *
     *      Worked example, the one the product describes: $40,000 face, 60 days, 1250 bps (12.5%).
     *          discount = 40000 * 1250 * 60 / 3_650_000 = $821.92
     *          price    = $39,178.08
     *
     *      Two deliberate choices, both reviewable:
     *
     *        - Discount basis, not true-yield basis. Money-market convention for short paper quotes
     *          the discount against face, exactly as T-bills and commercial paper do, and it costs
     *          one multiplication and one division with no division in the denominator to lose
     *          precision to. The honest consequence is that the buyer's realised annualised return
     *          is slightly ABOVE the quoted `annualisedYieldBps`, because they paid less than the
     *          true-yield price. At 8% over 60 days the gap is roughly 1 basis point. It is stated
     *          here rather than discovered later by whoever reconciles a buyer's returns.
     *        - ACT/365 fixed, not 30/360 or ACT/360. Tenor is derived from real calendar seconds to
     *          the due date, so the denominator should be a real year. It also makes the secondary
     *          market behave correctly without a special case: seasoned paper is just shorter-tenor
     *          paper, and a linear day count is what makes day-thirty paper clear tighter than the
     *          same invoice did on day zero.
     *
     *      Rounding favours the seller by at most one unit: the discount is floored, so the price is
     *      never rounded down against the party selling. At 6 decimals that is one millionth of a
     *      dollar, but the direction is chosen rather than left to chance.
     *
     * @param faceValue Redemption value at maturity, in settlement-currency units.
     * @param tenorDays Days from now to maturity.
     * @param annualisedYieldBps Annualised discount rate in basis points.
     * @return price What the buyer pays today.
     */
    function previewPrice(
        uint128 faceValue,
        uint32 tenorDays,
        uint16 annualisedYieldBps
    ) external pure returns (uint128 price);

    // -------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------

    /// @notice Read a mandate. Returns a zero-filled struct for an unknown id.
    function getMandate(uint256 mandateId) external view returns (Mandate memory);

    /// @notice Read a match. Returns a zero-filled struct for an unknown id.
    function getMatch(bytes32 matchId) external view returns (Match memory);

    /// @notice Capital available to new matches: `totalCommitted - allocated`.
    function unallocated(uint256 mandateId) external view returns (uint128);

    /// @notice How much of a mandate is currently exposed to one debtor, across all open and settled matches.
    function debtorExposure(uint256 mandateId, bytes32 debtorId) external view returns (uint128);

    /// @notice The open or settled match holding an invoice, or `bytes32(0)` if unallocated.
    function matchOfInvoice(bytes32 invoiceId) external view returns (bytes32 matchId);

    /**
     * @notice How many times this invoice has been matched, including cancelled attempts.
     * @dev Feeds {computeMatchId}. Exposed so a client can derive the id of the match that a
     *      pending `matchInvoice` will create, as `computeMatchId(invoiceId, mandateId, attempts+1)`.
     */
    function matchAttempts(bytes32 invoiceId) external view returns (uint64);

    /**
     * @notice Deterministic match id, so clients can derive it without waiting for the log.
     * @dev The attempt counter is part of the preimage because a cancelled match must not block a
     *      later one. Settlement of the first match and cancellation of the second are different
     *      events on the same (invoice, mandate) pair, and collapsing them onto one id would make
     *      the second silently overwrite the first's record.
     */
    function computeMatchId(bytes32 invoiceId, uint256 mandateId, uint64 attempt) external pure returns (bytes32);

    /// @notice Number of mandates ever posted. Ids are `1..mandateCount`; zero is never a valid id.
    function mandateCount() external view returns (uint256);

    /**
     * @notice Where this book's capital actually sits.
     * @dev Declarative, not verifiable. This contract cannot read Arc, so these values are recorded
     *      at construction for operators, indexers and auditors to check against the vault they
     *      believe they deployed. Nothing on-chain enforces that they are correct, which is exactly
     *      why they are immutable and emitted at deployment rather than settable later.
     * @return chainId Arc's chain id.
     * @return vault The {IMandateVault} holding this book's escrowed USDC.
     */
    function cashLeg() external view returns (uint256 chainId, address vault);

    /// @notice The address permitted to credit deposits attested from the vault.
    function attester() external view returns (address);

    /// @notice Whether a vault deposit reference has already been credited.
    function isDepositCredited(bytes32 depositRef) external view returns (bool);

    /// @notice Deterministic authorisation id, so a relayer can derive it without waiting for the log.
    function computeAuthorisationId(uint256 nonce) external view returns (bytes32);

    /// @notice The source of invoice truth this book reads from.
    function invoiceRegistry() external view returns (address);

    /// @notice The pre-trade eligibility gate consulted before every match.
    function complianceGate() external view returns (address);

    /**
     * @notice The escrow on THIS chain that settlement proofs are read out of.
     * @dev Immutable, and the delivery leg's twin of the Arc-side escrow the vault pays into. It is
     *      never called: the book only ever reads locks from it, so the escrow stays a
     *      venue-agnostic contract that knows nothing about mandates.
     */
    function deliveryEscrow() external view returns (address);

    /**
     * @notice When a match's position matures, unix seconds.
     * @dev `matchedAt + tenorDays`, using the tenor snapshotted at match time. Zero for an unknown
     *      match. Because tenor was rounded up, this is at or just after the real due date.
     */
    function maturityOf(bytes32 matchId) external view returns (uint64);
}
