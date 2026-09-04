// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IMandateBook} from "./interfaces/IMandateBook.sol";
import {IInvoiceRegistry} from "./interfaces/IInvoiceRegistry.sol";
import {IComplianceGate} from "./interfaces/IComplianceGate.sol";
import {ReasonCodes} from "./libraries/ReasonCodes.sol";
import {Rating, MandateStatus, InvoiceStatus, MatchStatus} from "./libraries/FactureTypes.sol";

/**
 * @title MandateBook
 * @notice The standing-bid book: funded quotes over risk buckets, and the matching engine over them.
 *
 * @dev The product argument, the escrow property and the deployment topology are all documented on
 *      {IMandateBook}. This header covers only what is specific to the implementation.
 *
 *      SINGLE EVALUATION, THREE REPORTING MODES. {previewMatch}, {tryMatch} and {matchInvoice} all
 *      delegate to one internal `_evaluate`, which returns a reason code and every value a caller
 *      might need. Nothing re-derives a decision. This is what guarantees that the reason code in a
 *      {MatchRefused} log, the typed error from a reverted {matchInvoice}, and the answer the UI
 *      showed a second earlier are the same judgement rather than three implementations of it.
 *
 *      NO TOKENS LIVE HERE. The buyer's USDC is escrowed in {IMandateVault} on Arc; this contract
 *      holds an attested view of it and issues the authorisations that are the vault's only exits.
 *      The reasoning for that split, the staleness analysis and the trust assumptions are on
 *      {IMandateBook} and {IMandateVault}. What follows is what the implementation does about it.
 *
 *      Because no token ever moves in this contract, there is deliberately no `ReentrancyGuard`. The
 *      only external calls made from here are the compliance gate and the invoice registry, both
 *      declared `view` and therefore compiled to `STATICCALL`, which cannot write state and so
 *      cannot re-enter a state-changing path. A guard would be cargo cult, and on Hedera it would be
 *      billed for on every match.
 *
 *      WHY CAPITAL CANNOT LEAK. Every unit of `totalCommitted` is in exactly one of two states, and
 *      the arithmetic that moves between them is confined to five places:
 *
 *          creditFunding         totalCommitted +=            (attested; tokens already on Arc)
 *          authoriseRelease      totalCommitted -=            (bounded by unallocated; opens the vault)
 *          _commitMatch          allocated      +=            (nothing moves)
 *          confirmSettlement     allocated -=, committed -=   (authorises the seller's payout)
 *          cancelMatch           allocated -=                 (nothing moves)
 *
 *      Note the ordering in the two decrementing cases: this book gives up its claim on the capital
 *      BEFORE the vault is opened by that much. So at no instant does the book count money the buyer
 *      could already have taken. That direction is what makes an attested balance safe to match
 *      against.
 *
 *      `allocated <= totalCommitted` therefore holds after every one of them, and an open match is
 *      the only thing that can hold `allocated` above zero. A match must resolve to `Settled` or
 *      `Cancelled`, and past the settlement window ANYONE may cancel, so capital cannot be stranded
 *      by an absent or unwilling settler. That last property matters more than it looks: without it,
 *      a buyer's escrowed capital would be hostage to venue liveness, which would make "escrowed"
 *      read as "confiscated" the first time a keeper went down.
 *
 *      TODO(v2): partial position sales. The cut list names an all-or-nothing exit as the first cut
 *      that genuinely costs the product, and the storage here is deliberately shaped so that adding
 *      it does not require a migration: a `Match` already snapshots `faceValue` and `price`
 *      separately, so a partial sale is a second match against a fraction of the same invoice rather
 *      than a new record type. What is missing is the instrument-side split, which ATS expresses
 *      through partitions and which is out of scope for this package.
 */
contract MandateBook is IMandateBook {
    // -------------------------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------------------------

    /// @notice Basis-point denominator. 10_000 bps == 100%.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Day-count denominator. ACT/365 fixed; see {previewPrice} for why not 360.
    uint256 public constant DAYS_PER_YEAR = 365;

    /**
     * @notice Hardest cap on a mandate's quoted rate.
     * @dev 50% annualised. Not a view on what is a reasonable bid - buyers set their own curve - but
     *      a bound that keeps the pricing arithmetic in a range where the invariant below holds and
     *      where a fat-fingered extra digit is refused rather than filled.
     */
    uint16 public constant MAX_YIELD_BPS = 5_000;

    /// @notice Hardest cap on a mandate's tenor ceiling. A receivable maturing beyond a year is not this market.
    uint32 public constant MAX_TENOR_DAYS = 365;

    /**
     * @notice Domain separator for match identifiers.
     * @dev Keeps a match id from ever colliding with a uniqueness hash or any other commitment.
     */
    bytes32 public constant MATCH_DOMAIN = keccak256("facture.match.v1");

    /**
     * @notice Domain separator for vault authorisation ids.
     * @dev Combined with this chain id and this contract's address, it makes an authorisation
     *      minted here unusable against any other vault, chain or redeployment.
     */
    bytes32 public constant AUTH_DOMAIN = keccak256("facture.authorisation.v1");

    // -------------------------------------------------------------------------------------------
    // Immutables
    // -------------------------------------------------------------------------------------------

    /**
     * @dev Where this book's capital actually sits. Declarative only - this contract cannot read
     *      Arc, so nothing on-chain verifies these. They are immutable and emitted at deployment
     *      precisely because an unverifiable value that could be changed later would be worse than
     *      useless: an operator could point the record at one vault while the attester relayed
     *      another.
     */
    uint256 private immutable _cashLegChainId;
    address private immutable _cashLegVault;

    /// @dev Source of invoice truth. Immutable: the book's refusals are only meaningful when
    ///      measured against a fixed oracle of facts.
    IInvoiceRegistry private immutable _invoiceRegistry;

    /**
     * @notice How long an open match may sit before anyone may cancel it and free the capital.
     * @dev Immutable and deliberately generous relative to the cross-chain settlement window in
     *      {DvpEscrow}. It must exceed the escrow's longest leg timeout, or this contract could
     *      release an allocation while the delivery leg is still claimable - paying nobody and
     *      handing the buyer the bond for free.
     */
    uint64 public immutable settlementWindow;

    // -------------------------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------------------------

    /// @dev Pre-trade eligibility gate. Mutable, because ATS is a third-party dependency on its own
    ///      release cadence and the adapter must be replaceable without redeploying the book. Owner
    ///      only, and note the trust this concentrates: a malicious gate can approve ineligible
    ///      buyers. It cannot touch escrowed capital.
    IComplianceGate private _complianceGate;

    /// @dev Curator of roles and of the gate address. Holds no spending power.
    address private _owner;

    /// @dev Addresses permitted to strike matches.
    mapping(address account => bool allowed) private _isMatcher;

    /// @dev Addresses permitted to confirm settlement, and to cancel before the window elapses.
    mapping(address account => bool allowed) private _isSettler;

    /// @dev Monotonic. Mandate ids run 1..n; zero is never valid, so an unset id cannot read as a mandate.
    uint256 private _mandateCount;

    mapping(uint256 mandateId => Mandate) private _mandates;

    mapping(bytes32 matchId => Match) private _matches;

    /// @dev Live exposure per (mandate, debtor). Rises on match, falls on cancel and on redemption.
    mapping(uint256 mandateId => mapping(bytes32 debtorId => uint128 exposure)) private _debtorExposure;

    /**
     * @dev The open or settled match holding an invoice. This is what stops one receivable being
     *      sold to two mandates, and it lives here rather than on the invoice registry because the
     *      book cannot write to an external registry inside the matching transaction. The registry
     *      is the source of truth for what an invoice IS; this map is the source of truth for
     *      whether the book has already sold it.
     */
    mapping(bytes32 invoiceId => bytes32 matchId) private _matchOfInvoice;

    /// @dev Per-invoice attempt counter, so a cancelled match does not block a later one from having a fresh id.
    mapping(bytes32 invoiceId => uint64 attempts) private _matchAttempts;

    /// @dev Relays vault deposits in, and carries release and payout authorisations back out.
    address private _attester;

    /**
     * @dev Vault deposit references already credited. The replay guard on the attestation path.
     *      References are minted by the VAULT, bound to Arc's chain id and the vault's address, so
     *      this map cannot be fooled by a reference from a testnet vault or an earlier deployment.
     */
    mapping(bytes32 depositRef => bool credited) private _creditedDeposits;

    /// @dev Monotonic, feeding {computeAuthorisationId}. Every authorisation is single-use downstream.
    uint256 private _authNonce;

    // -------------------------------------------------------------------------------------------
    // Internal evaluation result
    // -------------------------------------------------------------------------------------------

    /**
     * @dev Everything one evaluation of a candidate match produces. Memory-only; never stored.
     *      Carrying the intermediate values out rather than recomputing them is what lets
     *      {matchInvoice} raise a typed error with the real offending numbers in it.
     */
    struct Evaluation {
        bytes32 reasonCode;
        uint128 price;
        uint32 tenorDays;
        address instrument;
        address seller;
        bytes32 debtorId;
        uint128 faceValue;
        uint64 dueDate;
        Rating rating;
        uint128 unallocatedAmount;
        uint128 wouldBeExposure;
        bytes32 gateReason;
    }

    // -------------------------------------------------------------------------------------------
    // Errors specific to administration
    // -------------------------------------------------------------------------------------------

    error NotOwner(address caller);
    error ZeroAddress();

    // -------------------------------------------------------------------------------------------
    // Events specific to administration
    // -------------------------------------------------------------------------------------------

    event ComplianceGateChanged(address indexed previousGate, address indexed newGate);
    event MatcherSet(address indexed account, bool allowed);
    event SettlerSet(address indexed account, bool allowed);
    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);

    /// @notice The relaying attester was rotated.
    event AttesterChanged(address indexed previousAttester, address indexed newAttester);

    /// @notice Recorded at deployment so operators and indexers can check which vault this book
    ///         believes holds its capital. Unverifiable on-chain by construction.
    event CashLegDeclared(uint256 chainId, address vault);

    /// @notice Exposure to a debtor was released after redemption or default resolution.
    event DebtorExposureReleased(uint256 indexed mandateId, bytes32 indexed debtorId, uint128 amount);

    // -------------------------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != _owner) revert NotOwner(msg.sender);
        _;
    }

    modifier onlyMatcher() {
        if (!_isMatcher[msg.sender]) revert NotMatcher(msg.sender);
        _;
    }

    modifier onlyAttester() {
        if (msg.sender != _attester) revert NotAttester(msg.sender);
        _;
    }

    // -------------------------------------------------------------------------------------------
    // Construction
    // -------------------------------------------------------------------------------------------

    /**
     * @param invoiceRegistry_ Source of invoice truth.
     * @param complianceGate_ Pre-trade eligibility gate.
     * @param initialOwner Curator of roles and gate address.
     * @param initialAttester Relay for vault deposits and authorisations.
     * @param cashLegChainId_ Arc's chain id. Declarative; see {cashLeg}.
     * @param cashLegVault_ The {IMandateVault} on Arc. Declarative; see {cashLeg}.
     * @param settlementWindow_ Seconds after which an open match may be cancelled by anyone.
     */
    constructor(
        IInvoiceRegistry invoiceRegistry_,
        IComplianceGate complianceGate_,
        address initialOwner,
        address initialAttester,
        uint256 cashLegChainId_,
        address cashLegVault_,
        uint64 settlementWindow_
    ) {
        if (
            address(invoiceRegistry_) == address(0) ||
            address(complianceGate_) == address(0) ||
            initialOwner == address(0) ||
            initialAttester == address(0) ||
            cashLegVault_ == address(0)
        ) revert ZeroAddress();
        if (settlementWindow_ == 0 || cashLegChainId_ == 0) revert InvalidTerms();

        _invoiceRegistry = invoiceRegistry_;
        _complianceGate = complianceGate_;
        _owner = initialOwner;
        _attester = initialAttester;
        _cashLegChainId = cashLegChainId_;
        _cashLegVault = cashLegVault_;
        settlementWindow = settlementWindow_;

        emit OwnerTransferred(address(0), initialOwner);
        emit ComplianceGateChanged(address(0), address(complianceGate_));
        emit AttesterChanged(address(0), initialAttester);
        emit CashLegDeclared(cashLegChainId_, cashLegVault_);
    }

    // -------------------------------------------------------------------------------------------
    // Mandate lifecycle
    // -------------------------------------------------------------------------------------------

    /// @inheritdoc IMandateBook
    function postMandate(
        Rating minRating,
        uint32 maxTenorDays,
        uint16 annualisedYieldBps,
        uint128 maxPerDebtor
    ) external returns (uint256 mandateId) {
        if (maxTenorDays == 0 || maxTenorDays > MAX_TENOR_DAYS) revert InvalidTerms();
        if (annualisedYieldBps == 0 || annualisedYieldBps > MAX_YIELD_BPS) revert InvalidTerms();
        if (maxPerDebtor == 0) revert InvalidTerms();

        // The pricing invariant: a mandate's own terms must not be able to discount an invoice to
        // zero or below. Because matching refuses any tenor above `maxTenorDays` BEFORE pricing,
        // this makes every matched price strictly positive by construction rather than by a runtime
        // clamp.
        //
        // Note honestly that it is currently REDUNDANT: the two caps above already bound the product
        // at 5_000 * 365 = 1_825_000, half the 3_650_000 threshold, so the worst a mandate can do is
        // buy at 50% of face. It is kept because it is the check that would have to be re-derived if
        // either cap were raised, and a silently broken pricing invariant is a worse failure than a
        // redundant comparison is a cost.
        if (uint256(annualisedYieldBps) * uint256(maxTenorDays) >= BPS_DENOMINATOR * DAYS_PER_YEAR) {
            revert InvalidTerms();
        }

        unchecked {
            mandateId = ++_mandateCount;
        }

        _mandates[mandateId] = Mandate({
            buyer: msg.sender,
            minRating: minRating,
            status: MandateStatus.Active,
            maxTenorDays: maxTenorDays,
            annualisedYieldBps: annualisedYieldBps,
            totalCommitted: 0,
            allocated: 0,
            maxPerDebtor: maxPerDebtor
        });

        emit MandatePosted(mandateId, msg.sender, minRating, maxTenorDays, annualisedYieldBps, maxPerDebtor);
    }

    /// @inheritdoc IMandateBook
    function creditFunding(
        uint256 mandateId,
        address funder,
        uint128 amount,
        bytes32 depositRef
    ) external onlyAttester {
        if (amount == 0) revert ZeroAmount();
        if (depositRef == bytes32(0)) revert ZeroAmount();

        Mandate storage m = _mandates[mandateId];
        if (m.status == MandateStatus.Uninitialised) revert MandateUnknown(mandateId);

        // The whole attestation path, in one branch. An honest relay retrying a dropped transaction
        // and a malicious relay double-crediting look identical from here, so both are refused.
        if (_creditedDeposits[depositRef]) revert DepositAlreadyCredited(depositRef);
        _creditedDeposits[depositRef] = true;

        // Crediting is permitted in every status including `Paused` and `Closed`. The capital is
        // already sitting on Arc by the time this runs; refusing to acknowledge it would strand it,
        // because release is bounded by the attested balance.
        m.totalCommitted += amount;

        emit MandateFunded(mandateId, funder, depositRef, amount, m.totalCommitted);
    }

    /// @inheritdoc IMandateBook
    function authoriseRelease(uint256 mandateId, uint128 amount) external returns (bytes32 authId) {
        if (amount == 0) revert ZeroAmount();

        Mandate storage m = _mandates[mandateId];
        if (m.status == MandateStatus.Uninitialised) revert MandateUnknown(mandateId);
        if (msg.sender != m.buyer) revert NotMandateBuyer(mandateId, msg.sender);

        uint128 available = m.totalCommitted - m.allocated;
        if (amount > available) revert InsufficientUnallocated(mandateId, amount, available);

        // Decrement FIRST, then open the vault. Between this transaction and the attester's relay on
        // Arc the book under-counts, which is the safe direction; the reverse ordering would let the
        // book match against capital the buyer had already withdrawn.
        m.totalCommitted -= amount;

        authId = _nextAuthorisationId();

        emit ReleaseAuthorised(authId, mandateId, m.buyer, amount, m.totalCommitted);
    }

    /// @inheritdoc IMandateBook
    function setMandateStatus(uint256 mandateId, MandateStatus newStatus) external {
        Mandate storage m = _mandates[mandateId];
        if (m.status == MandateStatus.Uninitialised) revert MandateUnknown(mandateId);
        if (msg.sender != m.buyer) revert NotMandateBuyer(mandateId, msg.sender);
        // `Uninitialised` is not a status a live mandate may be moved into; it is the absence marker.
        if (newStatus == MandateStatus.Uninitialised) revert InvalidTerms();

        MandateStatus previous = m.status;
        m.status = newStatus;

        emit MandateStatusChanged(mandateId, previous, newStatus);
    }

    // -------------------------------------------------------------------------------------------
    // Matching
    // -------------------------------------------------------------------------------------------

    /// @inheritdoc IMandateBook
    function previewMatch(
        bytes32 invoiceId,
        uint256 mandateId
    ) external view returns (bool ok, bytes32 reasonCode, uint128 price, uint32 tenorDays) {
        Evaluation memory e = _evaluate(invoiceId, mandateId);
        ok = e.reasonCode == ReasonCodes.NONE;
        return (ok, e.reasonCode, ok ? e.price : 0, ok ? e.tenorDays : 0);
    }

    /// @inheritdoc IMandateBook
    function tryMatch(
        bytes32 invoiceId,
        uint256 mandateId
    ) external onlyMatcher returns (bool ok, bytes32 reasonCode, bytes32 matchId) {
        Evaluation memory e = _evaluate(invoiceId, mandateId);

        if (e.reasonCode != ReasonCodes.NONE) {
            // The refusal receipt. This transaction SUCCEEDS, which is the entire point: a reverted
            // call would discard this log, and the rejected party would be left with nothing to
            // check. See {ReasonCodes}.
            emit MatchRefused(invoiceId, mandateId, e.reasonCode);
            return (false, e.reasonCode, bytes32(0));
        }

        matchId = _commitMatch(invoiceId, mandateId, e);
        return (true, ReasonCodes.NONE, matchId);
    }

    /// @inheritdoc IMandateBook
    function matchInvoice(bytes32 invoiceId, uint256 mandateId) external onlyMatcher returns (bytes32 matchId) {
        Evaluation memory e = _evaluate(invoiceId, mandateId);

        if (e.reasonCode != ReasonCodes.NONE) {
            _revertWithReason(invoiceId, mandateId, e);
        }

        return _commitMatch(invoiceId, mandateId, e);
    }

    /**
     * @notice The single decision procedure. Every entry point routes through this.
     *
     * @dev `view` and never reverting, which is what allows it to back {previewMatch}. Returns at
     *      the FIRST failing check, so `reasonCode` always names the most fundamental problem rather
     *      than an arbitrary one. Check order and its justification are documented on
     *      {IMandateBook-matchInvoice}.
     */
    function _evaluate(bytes32 invoiceId, uint256 mandateId) internal view returns (Evaluation memory e) {
        // --- 1. mandate known and active -------------------------------------------------------
        Mandate memory m = _mandates[mandateId];
        if (m.status == MandateStatus.Uninitialised) {
            e.reasonCode = ReasonCodes.MANDATE_UNKNOWN;
            return e;
        }
        if (m.status != MandateStatus.Active) {
            e.reasonCode = ReasonCodes.MANDATE_NOT_ACTIVE;
            return e;
        }

        // --- 2. invoice known, confirmed, and not already sold ---------------------------------
        IInvoiceRegistry.Invoice memory inv = _invoiceRegistry.getInvoice(invoiceId);
        if (inv.status == InvoiceStatus.Unknown) {
            e.reasonCode = ReasonCodes.INVOICE_UNKNOWN;
            return e;
        }

        e.instrument = inv.instrument;
        e.seller = inv.seller;
        e.debtorId = inv.debtorId;
        e.faceValue = inv.faceValue;
        e.dueDate = inv.dueDate;
        e.rating = inv.rating;

        if (inv.status != InvoiceStatus.Confirmed) {
            e.reasonCode = ReasonCodes.INVOICE_NOT_CONFIRMED;
            return e;
        }

        // One receivable sells once. The uniqueness registry guarantees one instrument per
        // receivable; this guarantees one sale per instrument while a match is live. Without it the
        // same invoice could be allocated against two mandates in the same block, and the venue
        // would have promised the same paper to two buyers.
        if (_matchOfInvoice[invoiceId] != bytes32(0)) {
            e.reasonCode = ReasonCodes.INVOICE_ALREADY_ALLOCATED;
            return e;
        }

        // --- 3. rating >= floor ----------------------------------------------------------------
        // Ordinal comparison. Valid only because {Rating} is ordered by credit quality, with `D`
        // as the zero value sitting below `Unrated`; see {FactureTypes}.
        if (uint8(inv.rating) < uint8(m.minRating)) {
            e.reasonCode = ReasonCodes.RATING_BELOW_FLOOR;
            return e;
        }

        // --- 4. tenor <= ceiling ---------------------------------------------------------------
        if (inv.dueDate <= block.timestamp) {
            e.reasonCode = ReasonCodes.INVOICE_MATURED;
            return e;
        }

        // Ceiling division, not floor. An invoice maturing in twenty hours has a tenor of one day,
        // not zero. Flooring would price the last day of any invoice at par - the buyer would pay
        // face and earn nothing - which is not a quote anyone intended to post.
        uint256 secondsToMaturity = uint256(inv.dueDate) - block.timestamp;
        e.tenorDays = uint32((secondsToMaturity + 1 days - 1) / 1 days);

        if (e.tenorDays > m.maxTenorDays) {
            e.reasonCode = ReasonCodes.TENOR_ABOVE_CEILING;
            return e;
        }

        // --- price, derived rather than supplied -----------------------------------------------
        // The caller never states a price. If they did, "insufficient unallocated" and "debtor limit
        // exceeded" would be checks against a number chosen by the party who wants the match to
        // succeed. Deriving it from the mandate's own posted quote is what makes those two refusals
        // mean something. Safe from underflow by the invariant enforced in {postMandate}.
        e.price = _price(inv.faceValue, e.tenorDays, m.annualisedYieldBps);

        // --- 5. unallocated >= price -----------------------------------------------------------
        // The check that makes a standing quote firm rather than indicative.
        e.unallocatedAmount = m.totalCommitted - m.allocated;
        if (e.price > e.unallocatedAmount) {
            e.reasonCode = ReasonCodes.INSUFFICIENT_UNALLOCATED;
            return e;
        }

        // --- 6. per-debtor concentration -------------------------------------------------------
        e.wouldBeExposure = _debtorExposure[mandateId][inv.debtorId] + e.price;
        if (e.wouldBeExposure > m.maxPerDebtor) {
            e.reasonCode = ReasonCodes.DEBTOR_LIMIT_EXCEEDED;
            return e;
        }

        // --- 7. instrument eligibility, LAST because it is the only external call ---------------
        // Everything above has already been read and decided, so a hostile instrument cannot
        // influence any of it. The gate is contractually non-reverting, but it is called through a
        // mutable address, so it is treated as untrusted anyway: see {_probeGate}.
        (bool eligible, bytes32 gateReason) = _probeGate(inv.instrument, m.buyer);
        if (!eligible) {
            e.gateReason = gateReason;
            e.reasonCode = gateReason;
            return e;
        }

        e.reasonCode = ReasonCodes.NONE;
        return e;
    }

    /**
     * @dev Calls the compliance gate defensively. {IComplianceGate} requires implementations never
     *      to revert, but the gate address is owner-mutable and therefore not trusted to honour its
     *      own contract. A gate that reverts, returns nothing, or burns gas must not be able to take
     *      down `previewMatch` for every invoice on the venue - it must produce a refusal.
     */
    function _probeGate(address instrument, address buyer) private view returns (bool ok, bytes32 reasonCode) {
        IComplianceGate gate = _complianceGate;
        if (address(gate) == address(0)) return (false, ReasonCodes.NO_GATE_CONFIGURED);

        try gate.canReceive(instrument, buyer) returns (bool gateOk, bytes32 gateReason) {
            if (gateOk) return (true, ReasonCodes.NONE);
            // Never let a misbehaving gate return `ok == false` with an empty reason, which would
            // surface as a refusal with no name.
            return (false, gateReason == ReasonCodes.NONE ? ReasonCodes.COMPLIANCE_PROBE_FAILED : gateReason);
        } catch {
            return (false, ReasonCodes.COMPLIANCE_PROBE_FAILED);
        }
    }

    /**
     * @dev Translate an evaluation's reason code into its paired typed error.
     *      The `if` chain mirrors {ReasonCodes} exactly; adding a code without adding a branch here
     *      is caught by the test that asserts every refusal path raises its own error type.
     */
    function _revertWithReason(bytes32 invoiceId, uint256 mandateId, Evaluation memory e) private view {
        bytes32 r = e.reasonCode;

        if (r == ReasonCodes.MANDATE_UNKNOWN) revert MandateUnknown(mandateId);
        if (r == ReasonCodes.MANDATE_NOT_ACTIVE) revert MandateNotActive(mandateId, _mandates[mandateId].status);
        if (r == ReasonCodes.INVOICE_UNKNOWN) revert InvoiceUnknown(invoiceId);
        if (r == ReasonCodes.INVOICE_NOT_CONFIRMED) revert InvoiceNotConfirmed(invoiceId);
        if (r == ReasonCodes.INVOICE_ALREADY_ALLOCATED) {
            revert InvoiceAlreadyAllocated(invoiceId, _matchOfInvoice[invoiceId]);
        }
        if (r == ReasonCodes.RATING_BELOW_FLOOR) {
            revert RatingBelowFloor(invoiceId, e.rating, _mandates[mandateId].minRating);
        }
        if (r == ReasonCodes.INVOICE_MATURED) revert InvoiceMatured(invoiceId, e.dueDate);
        if (r == ReasonCodes.TENOR_ABOVE_CEILING) {
            revert TenorAboveCeiling(invoiceId, e.tenorDays, _mandates[mandateId].maxTenorDays);
        }
        if (r == ReasonCodes.INSUFFICIENT_UNALLOCATED) {
            revert InsufficientUnallocated(mandateId, e.price, e.unallocatedAmount);
        }
        if (r == ReasonCodes.DEBTOR_LIMIT_EXCEEDED) {
            revert DebtorLimitExceeded(mandateId, e.debtorId, e.wouldBeExposure, _mandates[mandateId].maxPerDebtor);
        }

        // Everything remaining originated in the gate, and carries the gate's own code so that a
        // refusal decided inside a third-party diamond reaches the funder intact.
        revert NotEligible(e.instrument, _mandates[mandateId].buyer, r);
    }

    /// @dev Apply an approved evaluation. The only place `allocated` and `_debtorExposure` rise.
    function _commitMatch(bytes32 invoiceId, uint256 mandateId, Evaluation memory e) private returns (bytes32 matchId) {
        Mandate storage m = _mandates[mandateId];

        uint64 attempt;
        unchecked {
            attempt = ++_matchAttempts[invoiceId];
        }
        matchId = computeMatchId(invoiceId, mandateId, attempt);

        m.allocated += e.price;
        _debtorExposure[mandateId][e.debtorId] = e.wouldBeExposure;
        _matchOfInvoice[invoiceId] = matchId;

        _matches[matchId] = Match({
            mandateId: mandateId,
            invoiceId: invoiceId,
            buyer: m.buyer,
            matchedAt: uint64(block.timestamp),
            status: MatchStatus.Open,
            seller: e.seller,
            tenorDays: e.tenorDays,
            yieldBps: m.annualisedYieldBps,
            price: e.price,
            faceValue: e.faceValue,
            debtorId: e.debtorId
        });

        emit Matched(
            matchId,
            invoiceId,
            mandateId,
            m.buyer,
            e.seller,
            e.price,
            e.faceValue,
            e.tenorDays,
            m.annualisedYieldBps
        );
    }

    // -------------------------------------------------------------------------------------------
    // Settlement
    // -------------------------------------------------------------------------------------------

    /**
     * @inheritdoc IMandateBook
     *
     * @dev TODO(settlement-wiring): today this trusts an authorised settler to have verified the
     *      delivery leg. The intended v1 binding is that {DvpEscrow} on this chain is the only
     *      settler, and that it calls in only after a preimage has been revealed against the
     *      delivery lock - so the proof of delivery is the preimage itself rather than a keeper's
     *      assertion. Wiring that requires the escrow to know the match id, which it already carries
     *      as `tradeRef`. What is deliberately NOT deferred is the accounting below, because getting
     *      the allocation arithmetic right is the part that protects buyer capital.
     */
    function confirmSettlement(bytes32 matchId) external returns (bytes32 authId) {
        if (!_isSettler[msg.sender]) revert NotSettler(msg.sender);

        Match storage mt = _matches[matchId];
        if (mt.status == MatchStatus.Uninitialised) revert MatchUnknown(matchId);
        if (mt.status != MatchStatus.Open) revert MatchNotOpen(matchId, mt.status);

        Mandate storage m = _mandates[mt.mandateId];
        uint128 price = mt.price;
        address seller = mt.seller;

        // The capital is now spoken for on Arc, so BOTH counters fall. Debtor exposure deliberately
        // does not: the buyer now holds the paper and is genuinely exposed to that debtor until it
        // redeems. Releasing it here would let a mandate exceed its own concentration cap simply by
        // settling faster.
        mt.status = MatchStatus.Settled;
        m.allocated -= price;
        m.totalCommitted -= price;

        authId = _nextAuthorisationId();

        emit MatchSettled(matchId, mt.mandateId, seller, price);
        emit PayoutAuthorised(authId, matchId, mt.mandateId, seller, price);
    }

    /**
     * @inheritdoc IMandateBook
     *
     * @dev Two callers, deliberately. An authorised settler may cancel at any time, because they are
     *      the party that learns the cross-chain leg failed. ANYONE may cancel once
     *      `settlementWindow` has elapsed, which is the property that stops escrowed capital being
     *      hostage to venue liveness. A buyer whose keeper has gone dark can free their own capital
     *      without asking permission.
     */
    function cancelMatch(bytes32 matchId, bytes32 reasonCode) external {
        Match storage mt = _matches[matchId];
        if (mt.status == MatchStatus.Uninitialised) revert MatchUnknown(matchId);
        if (mt.status != MatchStatus.Open) revert MatchNotOpen(matchId, mt.status);

        bool windowElapsed = block.timestamp >= uint256(mt.matchedAt) + settlementWindow;
        if (!_isSettler[msg.sender] && !windowElapsed) revert NotSettler(msg.sender);

        Mandate storage m = _mandates[mt.mandateId];
        uint128 price = mt.price;
        bytes32 invoiceId = mt.invoiceId;

        // No tokens moved, so only `allocated` falls. The capital is immediately available to the
        // next invoice, and the invoice is free to be matched again by any mandate.
        mt.status = MatchStatus.Cancelled;
        m.allocated -= price;

        // The SNAPSHOTTED debtor, never a fresh registry read. See {IMandateBook-Match}.
        _debtorExposure[mt.mandateId][mt.debtorId] -= price;
        _matchOfInvoice[invoiceId] = bytes32(0);

        emit MatchCancelled(matchId, mt.mandateId, windowElapsed ? ReasonCodes.SETTLEMENT_TIMEOUT : reasonCode);
    }

    /**
     * @notice Release a mandate's exposure to a debtor once a settled position has resolved.
     *
     * @dev Called at maturity - whether the debtor paid or defaulted. Both outcomes end the exposure;
     *      a default additionally marks the debtor's rating, which happens off this contract in the
     *      rating engine.
     *
     *      TODO(maturity-wiring): the caller is currently an authorised settler asserting that the
     *      position resolved. It should instead be driven by the instrument's own redemption event,
     *      which on Hedera arrives via a one-shot Scheduled Transaction at maturity. Left as a role
     *      call because the maturity path is owned by a different package.
     */
    function releaseDebtorExposure(bytes32 matchId) external {
        if (!_isSettler[msg.sender]) revert NotSettler(msg.sender);

        Match storage mt = _matches[matchId];
        if (mt.status == MatchStatus.Uninitialised) revert MatchUnknown(matchId);
        if (mt.status != MatchStatus.Settled) revert MatchNotOpen(matchId, mt.status);

        uint128 price = mt.price;
        bytes32 debtorId = mt.debtorId;

        _debtorExposure[mt.mandateId][debtorId] -= price;

        emit DebtorExposureReleased(mt.mandateId, debtorId, price);
    }

    // -------------------------------------------------------------------------------------------
    // Pricing
    // -------------------------------------------------------------------------------------------

    /// @inheritdoc IMandateBook
    function previewPrice(
        uint128 faceValue,
        uint32 tenorDays,
        uint16 annualisedYieldBps
    ) external pure returns (uint128) {
        return _price(faceValue, tenorDays, annualisedYieldBps);
    }

    /// @dev See {IMandateBook-previewPrice} for the convention and its justification.
    function _price(uint128 faceValue, uint32 tenorDays, uint16 annualisedYieldBps) internal pure returns (uint128) {
        // Widened to 256 bits before multiplying. `faceValue` is at most 2^128, the rate at most
        // 5_000 and the tenor at most 365, so the product cannot approach 2^256.
        uint256 discount =
            (uint256(faceValue) * uint256(annualisedYieldBps) * uint256(tenorDays)) / (BPS_DENOMINATOR * DAYS_PER_YEAR);

        // Unreachable from any matched trade because of the invariant enforced in {postMandate}.
        // Reachable by calling {previewPrice} directly with arbitrary arguments, which is why it is
        // a revert rather than an assertion.
        if (discount >= faceValue) revert InvalidTerms();

        // The division above floors the discount, so the price rounds UP - in the seller's favour by
        // at most one unit. Direction chosen, not incidental.
        return faceValue - uint128(discount);
    }

    // -------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------

    /// @inheritdoc IMandateBook
    function getMandate(uint256 mandateId) external view returns (Mandate memory) {
        return _mandates[mandateId];
    }

    /// @inheritdoc IMandateBook
    function getMatch(bytes32 matchId) external view returns (Match memory) {
        return _matches[matchId];
    }

    /// @inheritdoc IMandateBook
    function unallocated(uint256 mandateId) external view returns (uint128) {
        Mandate memory m = _mandates[mandateId];
        return m.totalCommitted - m.allocated;
    }

    /// @inheritdoc IMandateBook
    function debtorExposure(uint256 mandateId, bytes32 debtorId) external view returns (uint128) {
        return _debtorExposure[mandateId][debtorId];
    }

    /// @inheritdoc IMandateBook
    function matchOfInvoice(bytes32 invoiceId) external view returns (bytes32) {
        return _matchOfInvoice[invoiceId];
    }

    /// @inheritdoc IMandateBook
    function matchAttempts(bytes32 invoiceId) external view returns (uint64) {
        return _matchAttempts[invoiceId];
    }

    /// @inheritdoc IMandateBook
    function computeMatchId(bytes32 invoiceId, uint256 mandateId, uint64 attempt) public pure returns (bytes32) {
        return keccak256(abi.encode(MATCH_DOMAIN, invoiceId, mandateId, attempt));
    }

    /// @inheritdoc IMandateBook
    function mandateCount() external view returns (uint256) {
        return _mandateCount;
    }

    /// @inheritdoc IMandateBook
    function cashLeg() external view returns (uint256, address) {
        return (_cashLegChainId, _cashLegVault);
    }

    /// @inheritdoc IMandateBook
    function attester() external view returns (address) {
        return _attester;
    }

    /// @inheritdoc IMandateBook
    function isDepositCredited(bytes32 depositRef) external view returns (bool) {
        return _creditedDeposits[depositRef];
    }

    /// @inheritdoc IMandateBook
    function computeAuthorisationId(uint256 nonce) public view returns (bytes32) {
        return keccak256(abi.encode(AUTH_DOMAIN, block.chainid, address(this), nonce));
    }

    /// @notice How many vault authorisations this book has issued.
    function authorisationCount() external view returns (uint256) {
        return _authNonce;
    }

    /// @dev Mints the next single-use authorisation id. The only place `_authNonce` advances.
    function _nextAuthorisationId() private returns (bytes32) {
        uint256 nonce;
        unchecked {
            nonce = ++_authNonce;
        }
        return computeAuthorisationId(nonce);
    }

    /// @inheritdoc IMandateBook
    function invoiceRegistry() external view returns (address) {
        return address(_invoiceRegistry);
    }

    /// @inheritdoc IMandateBook
    function complianceGate() external view returns (address) {
        return address(_complianceGate);
    }

    /// @notice Whether an address may strike matches.
    function isMatcher(address account) external view returns (bool) {
        return _isMatcher[account];
    }

    /// @notice Whether an address may confirm settlement or cancel early.
    function isSettler(address account) external view returns (bool) {
        return _isSettler[account];
    }

    /// @notice Curator of roles and of the gate address.
    function owner() external view returns (address) {
        return _owner;
    }

    // -------------------------------------------------------------------------------------------
    // Administration
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Replace the pre-trade eligibility gate.
     * @dev The gate is an adapter onto a third-party dependency, so it must be replaceable. Note
     *      honestly what this concentrates: an owner who sets a permissive gate can cause
     *      ineligible buyers to be matched. They cannot move escrowed capital, cancel a settled
     *      match, or alter a mandate's terms. Bounding the damage is what makes the mutability
     *      acceptable; removing it would mean redeploying the book for an ATS release.
     */
    function setComplianceGate(IComplianceGate newGate) external onlyOwner {
        if (address(newGate) == address(0)) revert ZeroAddress();
        address previous = address(_complianceGate);
        _complianceGate = newGate;
        emit ComplianceGateChanged(previous, address(newGate));
    }

    /// @notice Grant or revoke the right to strike matches.
    function setMatcher(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        _isMatcher[account] = allowed;
        emit MatcherSet(account, allowed);
    }

    /**
     * @notice Grant or revoke the right to confirm settlement.
     * @dev In the intended deployment the only settler is {DvpEscrow}. A settler can move allocated
     *      capital to the recorded seller of a matched invoice; it cannot redirect it elsewhere,
     *      because the payee is snapshotted at match time from the invoice registry.
     */
    function setSettler(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        _isSettler[account] = allowed;
        emit SettlerSet(account, allowed);
    }

    /**
     * @notice Rotate the attester that relays vault deposits and carries authorisations to Arc.
     * @dev The recovery path when the relay stalls. Note what a compromised attester can and cannot
     *      do from here: it can credit funding that does not exist on Arc, which is the honest weak
     *      point documented on {IMandateBook}. It cannot move an allocation, alter a mandate's
     *      terms, settle a match, or authorise a release - those are buyer- and settler-gated.
     */
    function setAttester(address newAttester) external onlyOwner {
        if (newAttester == address(0)) revert ZeroAddress();
        address previous = _attester;
        _attester = newAttester;
        emit AttesterChanged(previous, newAttester);
    }

    /// @notice Transfer curation of roles and the gate address.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = _owner;
        _owner = newOwner;
        emit OwnerTransferred(previous, newOwner);
    }
}
