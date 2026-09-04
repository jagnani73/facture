// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IUniquenessRegistry} from "./interfaces/IUniquenessRegistry.sol";

/**
 * @title UniquenessRegistry
 * @notice One receivable mints exactly one instrument, ever. Append-only and permanently binding.
 *
 * @dev The full rationale - why the binding is irreversible, and why writes are permissioned given
 *      that irreversibility - is on {IUniquenessRegistry}. The short version, because it governs
 *      every line below:
 *
 *        A claim, once written, can never be removed, moved, or overwritten. There is no `release`,
 *        no admin escape hatch, and no upgrade path. A buyer must be able to conclude from
 *        `instrumentOf(h) == x` that no other instrument was ever issued against that receivable,
 *        without first reasoning about who holds which key.
 *
 *      Implementation notes that follow from that promise:
 *
 *        - This contract holds no funds, has no `receive`, and inherits nothing. Its dependency
 *          surface is empty on purpose, because it is intended to outlive every other contract in
 *          the venue and to be re-verifiable by hand.
 *        - Ownership exists only to curate the issuer set. The owner CANNOT touch a binding. The
 *          worst a compromised owner can do is grant issuers who then censor new claims or bind
 *          hashes to junk addresses going forward; they can never alter or unbind history. That
 *          bound on blast radius is the reason it is safe to have an owner at all.
 *        - Ownership transfer is two-step. A one-step transfer to a mistyped address would leave the
 *          issuer set permanently unmanageable, and since nothing here is upgradeable there would be
 *          no recovery.
 */
contract UniquenessRegistry is IUniquenessRegistry {
    // -------------------------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Domain separator mixed into every uniqueness commitment.
     * @dev Ensures a hash produced here can never collide with an unrelated `keccak256` commitment
     *      used elsewhere in the protocol, even given identical field values. Versioned so that a
     *      future change to the preimage layout is a visibly different namespace rather than a
     *      silent reinterpretation of existing claims.
     */
    bytes32 public constant DOMAIN = keccak256("facture.uniqueness.v1");

    // -------------------------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------------------------

    /**
     * @dev slot 0: the binding. Write-once; every write is guarded by the emptiness check in {claim}.
     *      `address(0)` is the unclaimed sentinel, which is why {claim} rejects a zero instrument.
     */
    mapping(bytes32 uniquenessHash => address instrument) private _instrumentOf;

    /// @dev slot 1: addresses permitted to record claims.
    mapping(address account => bool allowed) private _isIssuer;

    /// @dev slot 2: curator of the issuer set. Cannot touch bindings.
    address private _owner;

    /// @dev slot 3: nominated owner, pending acceptance. Two-step transfer; see the contract header.
    address private _pendingOwner;

    // -------------------------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != _owner) revert NotOwner(msg.sender);
        _;
    }

    modifier onlyIssuer() {
        if (!_isIssuer[msg.sender]) revert NotIssuer(msg.sender);
        _;
    }

    // -------------------------------------------------------------------------------------------
    // Construction
    // -------------------------------------------------------------------------------------------

    /**
     * @param initialOwner Curator of the issuer set.
     * @dev The deployer is deliberately NOT made an issuer implicitly. Issuance authority is granted
     *      explicitly and visibly, so the log of `IssuerSet` events is a complete history of who has
     *      ever been able to write a permanent binding.
     */
    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        _owner = initialOwner;
        emit OwnerTransferred(address(0), initialOwner);
    }

    // -------------------------------------------------------------------------------------------
    // Claiming
    // -------------------------------------------------------------------------------------------

    /// @inheritdoc IUniquenessRegistry
    function claim(bytes32 uniquenessHash, address instrument) external onlyIssuer {
        if (uniquenessHash == bytes32(0)) revert ZeroHash();
        if (instrument == address(0)) revert ZeroInstrument();

        address existing = _instrumentOf[uniquenessHash];

        // The whole contract, in one branch. Note that this is checked even when `existing` happens
        // to equal `instrument`: a repeat claim of an identical pair is still refused, so that the
        // caller learns their issuance pipeline ran twice rather than having the second run silently
        // succeed and look like a fresh issuance.
        if (existing != address(0)) revert AlreadyClaimed(uniquenessHash, existing);

        _instrumentOf[uniquenessHash] = instrument;

        emit Claimed(uniquenessHash, instrument, msg.sender);
    }

    // -------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------

    /// @inheritdoc IUniquenessRegistry
    function instrumentOf(bytes32 uniquenessHash) external view returns (address) {
        return _instrumentOf[uniquenessHash];
    }

    /// @inheritdoc IUniquenessRegistry
    function isClaimed(bytes32 uniquenessHash) external view returns (bool) {
        return _instrumentOf[uniquenessHash] != address(0);
    }

    /// @inheritdoc IUniquenessRegistry
    function computeHash(bytes32 debtorId, bytes32 invoiceRef, uint256 faceValue) public pure returns (bytes32) {
        // `abi.encode`, not `encodePacked`. With three fixed-width fields `encodePacked` would not
        // actually be ambiguous, but the rule is applied unconditionally so that adding a
        // variable-length field later cannot quietly introduce a collision between, say,
        // ("AC", "ME123") and ("ACME", "123").
        return keccak256(abi.encode(DOMAIN, debtorId, invoiceRef, faceValue));
    }

    // -------------------------------------------------------------------------------------------
    // Administration
    // -------------------------------------------------------------------------------------------

    /// @inheritdoc IUniquenessRegistry
    function setIssuer(address issuer, bool allowed) external onlyOwner {
        if (issuer == address(0)) revert ZeroAddress();
        _isIssuer[issuer] = allowed;
        emit IssuerSet(issuer, allowed);
    }

    /// @inheritdoc IUniquenessRegistry
    function isIssuer(address account) external view returns (bool) {
        return _isIssuer[account];
    }

    /// @inheritdoc IUniquenessRegistry
    function owner() external view returns (address) {
        return _owner;
    }

    /// @notice The address nominated to become owner, pending its acceptance.
    function pendingOwner() external view returns (address) {
        return _pendingOwner;
    }

    /**
     * @notice Nominate a new owner. Takes effect only when they call {acceptOwnership}.
     * @dev Two-step because a mistyped one-step transfer would permanently freeze the issuer set,
     *      and this contract has no upgrade path to recover through.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        _pendingOwner = newOwner;
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
