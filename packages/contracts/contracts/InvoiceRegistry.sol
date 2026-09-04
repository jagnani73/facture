// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IInvoiceRegistry} from "./interfaces/IInvoiceRegistry.sol";
import {IUniquenessRegistry} from "./interfaces/IUniquenessRegistry.sol";
import {Rating, InvoiceStatus} from "./libraries/FactureTypes.sol";

/**
 * @title InvoiceRegistry
 * @notice The venue's record of what each listed receivable IS. The book reads it; only the venue's
 *         attesters write it.
 *
 * @dev Why this contract has to exist and cannot be the mock, stated first because it governs every
 *      line below:
 *
 *        {MandateBook} does not take an invoice's rating, tenor or confirmation as arguments. It
 *        reads them from here. That is the whole reason its refusals mean anything - "rating below
 *        floor" is a check against reality only if the rating is not supplied by the party who wants
 *        the match to succeed. An unpermissioned registry moves the forgery one contract sideways
 *        rather than removing it: anyone could write an `A` rating onto a defaulted debtor, and the
 *        book would price it, match it and settle it exactly as designed. So the access control here
 *        is not hygiene around a data store, it is the thing the compliance-before-matching claim
 *        rests on.
 *
 *      WHAT IS WRITABLE, AND BY WHOM. Writes are attester-gated, following the role idiom already
 *      used by {UniquenessRegistry-setIssuer} and {MandateBook-setMatcher}: an owner curates a set,
 *      and the set members do the work. A set rather than {MandateBook}'s single `_attester` slot
 *      for two reasons - listing and rating are different venue processes ({IInvoiceRegistry} names
 *      them: debtor confirmation arrives over a link, ratings are earned from settled payment
 *      behaviour) and can hold separate keys, and a key can be rotated by granting the replacement
 *      before revoking the incumbent rather than through a window in which nobody can write.
 *
 *      WHAT AN ATTESTER CANNOT DO, which is what makes that surface acceptable:
 *
 *        - It cannot list the same receivable twice. {list} refuses a `uniquenessHash` or an
 *          `instrument` that is already spoken for, and it verifies the hash against the venue's
 *          {IUniquenessRegistry} rather than taking the caller's word for it.
 *        - It cannot list an invoice straight into `Confirmed`. {list} always writes `Draft`;
 *          confirmation is a separate transition, because confirmation is what removes dispute risk
 *          and therefore what justifies advancing the full face value with no holdback.
 *        - It cannot move a record backwards through its lifecycle. See {_isValidTransition}.
 *        - It cannot re-rate or re-date paper that has already been priced. See {setRating} and
 *          {amendDueDate}.
 *        - It cannot touch money. Nothing here holds funds, and no function on this contract moves
 *          an allocation, a mandate or a token.
 *
 *      READS NEVER REVERT. {getInvoice} on an unknown id returns a zero-filled struct, whose
 *      `status` decodes to `InvoiceStatus.Unknown`. That is a hard requirement of the interface, not
 *      a convenience: {MandateBook-previewMatch} is a `view` that has to report `INVOICE_UNKNOWN` as
 *      a named refusal. A refusal is a product output here; a revert is a failure, and the two are
 *      not interchangeable.
 *
 *      THIS IS NOT THE BOOK'S SALE GUARD. `InvoiceStatus.Matched` here is a mirror of a decision
 *      taken on {MandateBook}, relayed by an attester after the fact, so it can lag. What actually
 *      stops one receivable being sold to two mandates is the book's own `_matchOfInvoice`, written
 *      inside the matching transaction. This status is for readers and for the audit trail, and the
 *      belt-and-braces effect - a relayed `Matched` also stops matching here, since only `Confirmed`
 *      matches - is a bonus rather than the mechanism.
 */
contract InvoiceRegistry is IInvoiceRegistry {
    // -------------------------------------------------------------------------------------------
    // Immutables
    // -------------------------------------------------------------------------------------------

    /**
     * @notice The venue's anti-double-pledge registry, consulted on every listing.
     *
     * @dev Immutable, and the check it backs is not optional. {IUniquenessRegistry-claim} states the
     *      obligation this discharges: "a `deployBond` whose `claim` reverts leaves an orphaned bond
     *      that must never be listed. The listing path enforces that by requiring a matching claim."
     *      This is that listing path.
     *
     *      Without the check, `Invoice.uniquenessHash` would be a field an attester types in, and the
     *      interface's promise that a reader can use it to "verify one-invoice-one-token" would be
     *      false - the reader would be verifying the attester against itself.
     */
    IUniquenessRegistry public immutable uniquenessRegistry;

    // -------------------------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------------------------

    /// @dev The record. `InvoiceStatus.Unknown == 0`, so an unwritten key reads back as not listed.
    mapping(bytes32 invoiceId => Invoice) private _invoices;

    /**
     * @dev Reverse index: which invoice id claimed a receivable. Enforces one listing per receivable.
     *
     *      This closes a hole that would otherwise sit underneath the book: {MandateBook} guards
     *      against a double sale per INVOICE ID, so that guard is only sound if an id maps to a
     *      receivable one-for-one. Two ids over one receivable would be two independently matchable
     *      listings of the same paper.
     */
    mapping(bytes32 uniquenessHash => bytes32 invoiceId) private _invoiceOfReceivable;

    /**
     * @dev Reverse index: which invoice id listed an instrument. The same argument as above, applied
     *      to the object that is actually delivered at settlement.
     *
     *      Belt and braces with {_invoiceOfReceivable}: two hashes bound to one instrument is an
     *      issuer error at the uniqueness registry rather than something this contract can be told
     *      about, and selling the same paper twice is the specific fraud the venue exists to
     *      prevent, so it is worth one extra slot to refuse it here too.
     */
    mapping(address instrument => bytes32 invoiceId) private _invoiceOfInstrument;

    /// @dev Addresses permitted to relay invoice facts. Curated by the owner; hold no spending power.
    mapping(address account => bool allowed) private _isAttester;

    /// @dev Curator of the attester set. Cannot write an invoice record.
    address private _owner;

    /// @dev Nominated owner, pending acceptance. Two-step; see {transferOwnership}.
    address private _pendingOwner;

    // -------------------------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------------------------

    /**
     * @notice A receivable was listed. Always lands in `Draft`.
     * @dev Carries every field of the record, so the log alone is enough to reconstruct what the
     *      book would have read at any block - which is what makes "why was this match allowed"
     *      answerable after the fact without an archive node.
     */
    event InvoiceListed(
        bytes32 indexed invoiceId,
        address indexed instrument,
        bytes32 indexed debtorId,
        address seller,
        uint128 faceValue,
        uint64 dueDate,
        Rating rating,
        bytes32 uniquenessHash,
        address attester
    );

    /// @notice A listed receivable moved through its lifecycle. Emitted on every transition.
    event InvoiceStatusChanged(
        bytes32 indexed invoiceId,
        InvoiceStatus indexed previousStatus,
        InvoiceStatus indexed newStatus,
        address attester
    );

    /// @notice The debtor's earned rating on this invoice was updated. Pre-trade only.
    event InvoiceRatingChanged(
        bytes32 indexed invoiceId,
        Rating indexed previousRating,
        Rating indexed newRating,
        address attester
    );

    /// @notice A due date was corrected before the debtor confirmed it.
    event InvoiceDueDateAmended(bytes32 indexed invoiceId, uint64 previousDueDate, uint64 newDueDate, address attester);

    /// @notice An address was granted or revoked the right to relay invoice facts.
    event AttesterSet(address indexed account, bool allowed);

    /// @notice An owner nominated a successor. Takes effect only on {acceptOwnership}.
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);

    /// @notice Curation of the attester set moved.
    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);

    // -------------------------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------------------------

    /// @notice The caller may not write invoice facts.
    error NotAttester(address caller);

    /// @notice The caller does not curate the attester set.
    error NotOwner(address caller);

    /// @notice A zero address was supplied where one is never valid.
    error ZeroAddress();

    /// @notice `invoiceId` was zero. Rejected because zero is indistinguishable from an unset key.
    error ZeroInvoiceId();

    /// @notice `uniquenessHash` was zero, which is {IUniquenessRegistry}'s own unclaimed sentinel.
    error ZeroHash();

    /// @notice `instrument` was zero, so the record would name no paper to deliver.
    error ZeroInstrument();

    /// @notice `debtorId` was zero. Exposure limits are keyed on it, so a blank one would pool debtors.
    error ZeroDebtor();

    /// @notice `faceValue` was zero. A receivable owed nothing is not an instrument.
    error ZeroFaceValue();

    /// @notice The due date is not in the future, so there is no tenor left to price.
    error DueDateNotInFuture(uint64 dueDate, uint64 nowTs);

    /// @notice This invoice id is already listed. Records are never overwritten wholesale.
    error InvoiceAlreadyListed(bytes32 invoiceId);

    /**
     * @notice This receivable is already listed under another invoice id.
     * @dev The registry-level restatement of one receivable, one listing. Carries the incumbent so
     *      the caller can inspect it rather than searching the logs.
     */
    error ReceivableAlreadyListed(bytes32 uniquenessHash, bytes32 existingInvoiceId);

    /// @notice This instrument is already listed under another invoice id.
    error InstrumentAlreadyListed(address instrument, bytes32 existingInvoiceId);

    /**
     * @notice The uniqueness registry does not bind this hash to this instrument.
     * @dev `claimedInstrument` is `address(0)` when the receivable was never claimed at all, which is
     *      the orphaned-bond case {IUniquenessRegistry-claim} warns must never be listed.
     */
    error UniquenessMismatch(bytes32 uniquenessHash, address claimedInstrument, address suppliedInstrument);

    /// @notice No such invoice. Only the WRITE paths raise this; {getInvoice} never does.
    error InvoiceUnknown(bytes32 invoiceId);

    /// @notice The lifecycle does not admit this move. See {_isValidTransition} for the table.
    error InvalidStatusTransition(bytes32 invoiceId, InvoiceStatus from, InvoiceStatus to);

    /// @notice The invoice has left the pre-trade window, so its rating is frozen as priced.
    error RatingLocked(bytes32 invoiceId, InvoiceStatus status);

    /// @notice The debtor has already acknowledged this date, so it can no longer be amended.
    error DueDateLocked(bytes32 invoiceId, InvoiceStatus status);

    // -------------------------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != _owner) revert NotOwner(msg.sender);
        _;
    }

    modifier onlyAttester() {
        if (!_isAttester[msg.sender]) revert NotAttester(msg.sender);
        _;
    }

    // -------------------------------------------------------------------------------------------
    // Construction
    // -------------------------------------------------------------------------------------------

    /**
     * @param initialOwner Curator of the attester set.
     * @param uniquenessRegistry_ The venue's {IUniquenessRegistry}, which must already be deployed.
     *
     * @dev The deployer is deliberately NOT made an attester implicitly, for the same reason
     *      {UniquenessRegistry} does not implicitly grant issuance: the `AttesterSet` log should be a
     *      complete history of who has ever been able to assert an invoice fact.
     */
    constructor(address initialOwner, IUniquenessRegistry uniquenessRegistry_) {
        if (initialOwner == address(0)) revert ZeroAddress();
        if (address(uniquenessRegistry_) == address(0)) revert ZeroAddress();

        _owner = initialOwner;
        uniquenessRegistry = uniquenessRegistry_;

        emit OwnerTransferred(address(0), initialOwner);
    }

    // -------------------------------------------------------------------------------------------
    // Listing
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Record a receivable. Always lands in `Draft`, never in `Confirmed`.
     *
     * @dev Arguments are flat rather than an `Invoice` struct on purpose. A struct would carry a
     *      `status` field that the caller could set and this function would then have to ignore,
     *      which is a worse interface than one where listing straight into `Confirmed` is not
     *      expressible. The debtor's acknowledgement is a separate call, because it is a separate
     *      real-world event and it is the one that makes the paper quotable.
     *
     *      Three uniqueness checks run before anything is written, in increasing order of what they
     *      cost to establish: this id is free, this receivable is free, this instrument is free.
     *      Then the external check that none of them can substitute for - that the venue's
     *      {IUniquenessRegistry} actually binds this hash to this instrument.
     *
     * @param invoiceId Venue identifier for the receivable.
     * @param instrument The ATS zero-coupon bond issued for it. Must already be claimed.
     * @param debtorId Stable venue identity of the business that owes the money.
     * @param seller The business owed the money, and the recipient of the sale proceeds.
     * @param faceValue Amount owed at maturity, in settlement-currency smallest units.
     * @param dueDate Invoice due date, unix seconds. Must be in the future.
     * @param uniquenessHash The {IUniquenessRegistry} commitment for this receivable.
     * @param rating The debtor's earned rating at listing time. `Unrated` for a cold start.
     */
    function list(
        bytes32 invoiceId,
        address instrument,
        bytes32 debtorId,
        address seller,
        uint128 faceValue,
        uint64 dueDate,
        bytes32 uniquenessHash,
        Rating rating
    ) external onlyAttester {
        if (invoiceId == bytes32(0)) revert ZeroInvoiceId();
        if (instrument == address(0)) revert ZeroInstrument();
        if (debtorId == bytes32(0)) revert ZeroDebtor();
        if (seller == address(0)) revert ZeroAddress();
        if (faceValue == 0) revert ZeroFaceValue();
        if (uniquenessHash == bytes32(0)) revert ZeroHash();
        if (dueDate <= block.timestamp) revert DueDateNotInFuture(dueDate, uint64(block.timestamp));

        if (_invoices[invoiceId].status != InvoiceStatus.Unknown) revert InvoiceAlreadyListed(invoiceId);

        bytes32 incumbentByHash = _invoiceOfReceivable[uniquenessHash];
        if (incumbentByHash != bytes32(0)) revert ReceivableAlreadyListed(uniquenessHash, incumbentByHash);

        bytes32 incumbentByInstrument = _invoiceOfInstrument[instrument];
        if (incumbentByInstrument != bytes32(0)) revert InstrumentAlreadyListed(instrument, incumbentByInstrument);

        // The one fact this contract does not take the attester's word for. An unclaimed hash reads
        // back as `address(0)` here, which is exactly the orphaned-bond case that must never list.
        address claimed = uniquenessRegistry.instrumentOf(uniquenessHash);
        if (claimed != instrument) revert UniquenessMismatch(uniquenessHash, claimed, instrument);

        _invoices[invoiceId] = Invoice({
            instrument: instrument,
            rating: rating,
            status: InvoiceStatus.Draft,
            dueDate: dueDate,
            debtorId: debtorId,
            seller: seller,
            faceValue: faceValue,
            uniquenessHash: uniquenessHash
        });
        _invoiceOfReceivable[uniquenessHash] = invoiceId;
        _invoiceOfInstrument[instrument] = invoiceId;

        emit InvoiceListed(
            invoiceId,
            instrument,
            debtorId,
            seller,
            faceValue,
            dueDate,
            rating,
            uniquenessHash,
            msg.sender
        );
        // Emitted alongside, so a consumer watching only status changes sees the record appear.
        emit InvoiceStatusChanged(invoiceId, InvoiceStatus.Unknown, InvoiceStatus.Draft, msg.sender);
    }

    // -------------------------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Move a listed receivable to a new lifecycle status.
     * @dev Reverts with {InvalidStatusTransition} unless {_isValidTransition} admits the move, and
     *      that includes a move to the status the invoice is already in - a no-op write would put a
     *      transition in the log that did not happen, and the audit trail is the product here.
     * @param invoiceId Venue identifier for the receivable.
     * @param newStatus The status to move to.
     */
    function setStatus(bytes32 invoiceId, InvoiceStatus newStatus) external onlyAttester {
        Invoice storage inv = _invoices[invoiceId];
        InvoiceStatus previous = inv.status;

        if (previous == InvoiceStatus.Unknown) revert InvoiceUnknown(invoiceId);
        if (!_isValidTransition(previous, newStatus)) {
            revert InvalidStatusTransition(invoiceId, previous, newStatus);
        }

        inv.status = newStatus;

        emit InvoiceStatusChanged(invoiceId, previous, newStatus, msg.sender);
    }

    /**
     * @notice Update the debtor's earned rating on a receivable that has not yet been priced.
     *
     * @dev Permitted in `Draft` and `Confirmed` only, and the boundary is where the rating stops
     *      being an input and becomes a record of what was paid for.
     *
     *      A rating moves because settled payment behaviour moved it - that is the whole "earned,
     *      not assigned" rule - so it genuinely has to be mutable while an invoice sits on the book
     *      waiting for a bid. The instant a match is struck, the rating that cleared the mandate's
     *      floor is a fact about a completed trade. Re-writing it afterwards would not change any
     *      on-chain outcome, because {MandateBook} snapshots what it needs at match time, but it
     *      would leave a reader unable to reconstruct why the match was allowed - and that
     *      reconstruction is the point of this contract.
     *
     * @param invoiceId Venue identifier for the receivable.
     * @param newRating The debtor's rating as of now.
     */
    function setRating(bytes32 invoiceId, Rating newRating) external onlyAttester {
        Invoice storage inv = _invoices[invoiceId];
        InvoiceStatus status = inv.status;

        if (status == InvoiceStatus.Unknown) revert InvoiceUnknown(invoiceId);
        if (status != InvoiceStatus.Draft && status != InvoiceStatus.Confirmed) {
            revert RatingLocked(invoiceId, status);
        }

        Rating previous = inv.rating;
        inv.rating = newRating;

        emit InvoiceRatingChanged(invoiceId, previous, newRating, msg.sender);
    }

    /**
     * @notice Correct a due date before the debtor has acknowledged it.
     *
     * @dev `Draft` only. Confirmation is the debtor acknowledging an amount AND a date, so a date
     *      changed after confirmation would leave the venue holding an acknowledgement of something
     *      the record no longer says - and that acknowledgement is exactly what removes dispute risk
     *      and justifies advancing the full face with no holdback.
     *
     *      There is deliberately no equivalent for `faceValue` or `debtorId`. Both are committed to
     *      by the uniqueness hash, so a correction to either is a different receivable that gets a
     *      different hash and a different instrument - see {IUniquenessRegistry-computeHash}.
     *      `dueDate` is not in that commitment, which is why it is the one field a typo can be fixed
     *      in rather than re-issued around.
     *
     * @param invoiceId Venue identifier for the receivable.
     * @param newDueDate Corrected due date, unix seconds. Must be in the future.
     */
    function amendDueDate(bytes32 invoiceId, uint64 newDueDate) external onlyAttester {
        Invoice storage inv = _invoices[invoiceId];
        InvoiceStatus status = inv.status;

        if (status == InvoiceStatus.Unknown) revert InvoiceUnknown(invoiceId);
        if (status != InvoiceStatus.Draft) revert DueDateLocked(invoiceId, status);
        if (newDueDate <= block.timestamp) revert DueDateNotInFuture(newDueDate, uint64(block.timestamp));

        uint64 previous = inv.dueDate;
        inv.dueDate = newDueDate;

        emit InvoiceDueDateAmended(invoiceId, previous, newDueDate, msg.sender);
    }

    /**
     * @notice The permitted lifecycle moves, in one table.
     *
     * @dev Transitions are validated rather than free, and the justification is per-edge rather than
     *      a general preference for state machines:
     *
     *        Draft     -> Confirmed   the debtor acknowledged amount and date; the paper is quotable
     *        Draft     -> Cancelled   the seller withdrew before anyone confirmed
     *        Confirmed -> Matched     a mandate took it; mirrors a decision made on {MandateBook}
     *        Confirmed -> Cancelled   withdrawn, or the debtor retracted their acknowledgement
     *        Matched   -> Settled     DvP completed; the buyer holds the instrument
     *        Matched   -> Confirmed   the match was cancelled, so the paper is back on the book
     *        Settled   -> Repaid      the debtor paid at maturity
     *        Settled   -> Defaulted   it matured unpaid; the buyer takes the loss
     *        Cancelled -> Draft       re-listed; see below
     *
     *      What is refused, and why each refusal is load-bearing:
     *
     *        - ANY move to `Unknown`. Zero is the "not listed" sentinel that {getInvoice} leans on,
     *          so writing it would make a listed invoice read as though it had never existed, while
     *          its receivable and instrument stayed permanently spoken for by the reverse indexes.
     *          The record would be unreachable and un-relistable.
     *        - `Settled -> Confirmed`, and every other backwards move out of a completed trade. Once
     *          a buyer holds the paper, re-listing it would offer a second mandate something the
     *          venue has already sold. The book's own `_matchOfInvoice` would catch it, but a
     *          registry that can say "for sale" about sold paper is a registry a reader cannot use.
     *        - `Repaid` and `Defaulted` are terminal. Both are the end of the money, and a default
     *          in particular carries a permanent mark on the debtor's rating - a status that could
     *          be walked back would make that mark an operator's discretion rather than a fact. A
     *          debtor who pays late, after default, is an off-chain recovery and a rating matter,
     *          not a rewrite of what happened.
     *        - `Confirmed -> Draft`. Un-confirming would silently pull a live quote out of the book
     *          in a way that reads as though the invoice had never been confirmed. A retraction is a
     *          `Cancelled`, which says what happened.
     *
     *      The one non-obvious edge is `Cancelled -> Draft`, and it is admitted deliberately. The
     *      alternative is worse: cancellation is a seller changing their mind about an UNSOLD
     *      receivable, and because {list} refuses a receivable or an instrument that is already
     *      spoken for, a terminal `Cancelled` would burn that receivable on this venue forever, with
     *      no way to re-list it and no way to re-issue around it - the bond is permanently bound in
     *      the uniqueness registry. Re-opening costs nothing, because it lands in `Draft`, which is
     *      unmatchable, and requires a fresh debtor confirmation before it can be quoted again.
     */
    function _isValidTransition(InvoiceStatus from, InvoiceStatus to) private pure returns (bool) {
        if (from == InvoiceStatus.Draft) {
            return to == InvoiceStatus.Confirmed || to == InvoiceStatus.Cancelled;
        }
        if (from == InvoiceStatus.Confirmed) {
            return to == InvoiceStatus.Matched || to == InvoiceStatus.Cancelled;
        }
        if (from == InvoiceStatus.Matched) {
            return to == InvoiceStatus.Settled || to == InvoiceStatus.Confirmed;
        }
        if (from == InvoiceStatus.Settled) {
            return to == InvoiceStatus.Repaid || to == InvoiceStatus.Defaulted;
        }
        if (from == InvoiceStatus.Cancelled) {
            return to == InvoiceStatus.Draft;
        }
        // `Unknown` is handled by the caller with a better error; `Repaid` and `Defaulted` are terminal.
        return false;
    }

    // -------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------

    /// @inheritdoc IInvoiceRegistry
    function getInvoice(bytes32 invoiceId) external view returns (Invoice memory) {
        // A plain mapping read, and that is the entire implementation on purpose. There is no
        // existence check to fail: an unwritten key returns a zero-filled struct whose `status` is
        // `InvoiceStatus.Unknown`, which is what lets `previewMatch` report `INVOICE_UNKNOWN` as a
        // refusal rather than propagating a revert out of a `view`.
        return _invoices[invoiceId];
    }

    /// @inheritdoc IInvoiceRegistry
    function isConfirmed(bytes32 invoiceId) external view returns (bool) {
        return _invoices[invoiceId].status == InvoiceStatus.Confirmed;
    }

    /// @notice Whether a receivable has a record here at all.
    function isListed(bytes32 invoiceId) external view returns (bool) {
        return _invoices[invoiceId].status != InvoiceStatus.Unknown;
    }

    /// @notice The invoice id listed against a uniqueness commitment, or zero.
    function invoiceOfReceivable(bytes32 uniquenessHash) external view returns (bytes32) {
        return _invoiceOfReceivable[uniquenessHash];
    }

    /// @notice The invoice id listed against an instrument, or zero.
    function invoiceOfInstrument(address instrument) external view returns (bytes32) {
        return _invoiceOfInstrument[instrument];
    }

    /// @notice Whether an address may relay invoice facts.
    function isAttester(address account) external view returns (bool) {
        return _isAttester[account];
    }

    /// @notice Curator of the attester set.
    function owner() external view returns (address) {
        return _owner;
    }

    /// @notice The address nominated to become owner, pending its acceptance.
    function pendingOwner() external view returns (address) {
        return _pendingOwner;
    }

    // -------------------------------------------------------------------------------------------
    // Administration
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Grant or revoke the right to relay invoice facts.
     * @dev The whole of this contract's trust surface. An attester can list paper that does not
     *      exist behind a bond that does - it cannot forge the bond itself, because {list} checks
     *      the uniqueness registry - and can rate a debtor better than they are. It cannot move
     *      capital, alter a mandate, or reverse a completed trade. Revocation is immediate.
     * @param account Address to grant or revoke.
     * @param allowed True to grant.
     */
    function setAttester(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        _isAttester[account] = allowed;
        emit AttesterSet(account, allowed);
    }

    /**
     * @notice Nominate a new owner. Takes effect only when they call {acceptOwnership}.
     * @dev Two-step, matching {UniquenessRegistry}. A one-step transfer to a mistyped address would
     *      leave the attester set permanently unmanageable - no grants, no revocations - and this
     *      contract has no upgrade path to recover through. Nominating `address(0)` cancels a
     *      pending nomination, since nobody can call {acceptOwnership} from it.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        _pendingOwner = newOwner;
        emit OwnershipTransferStarted(_owner, newOwner);
    }

    /// @notice Accept a pending ownership nomination.
    function acceptOwnership() external {
        if (msg.sender != _pendingOwner) revert NotOwner(msg.sender);
        address previous = _owner;
        _owner = msg.sender;
        _pendingOwner = address(0);
        emit OwnerTransferred(previous, msg.sender);
    }
}
