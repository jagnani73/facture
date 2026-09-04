// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IMandateVault} from "./interfaces/IMandateVault.sol";
import {IDvpEscrow} from "./interfaces/IDvpEscrow.sol";

/**
 * @title MandateVault
 * @notice The cash leg. Deploys on Arc, holds the USDC, and opens only on the Hedera book's word.
 *
 * @dev The full argument for the split, the staleness analysis and the trust assumptions are on
 *      {IMandateVault}. This header covers only what the implementation is doing about them.
 *
 *      THERE ARE EXACTLY TWO PATHS OUT of this contract, {executeRelease} and {executePayout}, and
 *      both require an authorisation the book issued. There is no timeout escape, no owner sweep,
 *      no emergency withdrawal, and adding one would destroy the property the whole design exists
 *      to provide - a buyer must not be able to pull capital on Arc while the book still counts it
 *      as committed. A stalled attester is recovered by ROTATION, which is why {setAttester} exists
 *      and why nothing else does.
 *
 *      {reclaimPayout} is not a third one. It moves capital INWARD - out of a payment lock nobody
 *      claimed and back into the mandate that funded it - which is why it can be permissionless
 *      while everything above is not.
 *
 *      Four enforced bounds on a compromised attester, in decreasing order of strength:
 *
 *        1. `_balanceOf` is per mandate and every outflow is checked against it, so no authorisation
 *           can reach another mandate's capital. This is arithmetic, not policy.
 *        2. {executeRelease} pays `_buyerOf[mandateId]` and takes no recipient argument, so a forged
 *           release can only return a buyer's money to that buyer.
 *        3. `_consumed` makes every authorisation single-use. Because the book derives ids from its
 *           own chain id and address, an authorisation cannot be replayed here, against a second
 *           vault, or against a redeployment.
 *        4. {executePayout} pays `_payouts[matchId].seller`, at that record's price, out of that
 *           record's mandate, and sends it to `_paymentEscrow` and nowhere else. The record is
 *           written once, at match time, so the destination of a settled payout is fixed and public
 *           before the seller delivers anything.
 *
 *      What remains is the messenger problem, and it is not solvable here: this contract cannot
 *      authenticate the book, only the relay, so a compromised attester that forges a match
 *      registration and an authorisation id can still drain a mandate's balance. {IMandateVault}
 *      states that plainly. The four bounds above decide how much damage that is and how visible it
 *      is; they do not pretend to remove it.
 */
contract MandateVault is IMandateVault, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Domain separator for deposit references. Versioned; see {UniquenessRegistry-DOMAIN}.
    bytes32 public constant DEPOSIT_DOMAIN = keccak256("facture.vault.deposit.v1");

    /**
     * @notice How long a payment lock stays claimable before it may be reclaimed to the mandate.
     *
     * @dev A DURATION applied at open time, not a deadline computed on the other chain. The book
     *      cannot set this: a timestamp minted on Hedera and used on Arc goes stale by however long
     *      the relay took, and a stale one would either be rejected by the escrow's own bounds -
     *      stranding a payout - or leave the seller a window shorter than the venue intended. A
     *      duration cannot go stale.
     *
     *      ONE DAY, and the length is chosen by which way the harm runs rather than by taste. If the
     *      lock expires unclaimed the capital returns to the buyer's mandate and the book cannot
     *      mint a second payout authorisation for that match, so an expiry costs the SELLER money
     *      they had already earned. A long window costs the buyer nothing at all: they gave the
     *      capital up at settlement and the book has already decremented it either way. So the
     *      window is set long enough that a seller claiming by hand, in another timezone, is in no
     *      danger, and the recovery of a genuinely misdirected payout waits a day for it.
     *
     *      Inside the escrow's `MIN_LOCK_DURATION`..`MAX_LOCK_DURATION` band with a day to spare, so
     *      {executePayout} cannot fail on a bound.
     */
    uint64 private constant _PAYMENT_LOCK_DURATION = 1 days;

    /// @dev Immutable: the escrowed asset cannot change without orphaning every balance below.
    IERC20 private immutable _settlementToken;

    /**
     * @dev The only address capital ever leaves toward on the payout path.
     *
     *      Immutable, and deployed BEFORE this contract for that reason - the deployment order on
     *      Arc is escrow, then vault, then the Hedera book that records this vault. The dependency
     *      runs one way at every step and never doubles back: the escrow knows nothing, the vault
     *      knows the escrow, the book knows the vault.
     *
     *      An owner-settable escrow would defeat the binding it exists to provide, since redirecting
     *      every future payout would be one transaction away.
     */
    IDvpEscrow private immutable _paymentEscrow;

    /// @dev Per-mandate custody. The hard ceiling on every outflow.
    mapping(uint256 mandateId => uint128 balance) private _balanceOf;

    /// @dev One-shot binding of a mandate to the only address a release may pay.
    mapping(uint256 mandateId => address buyer) private _buyerOf;

    /// @dev One-shot binding of a match to the only address, amount and mandate a payout may use.
    mapping(bytes32 matchId => Payout) private _payouts;

    /// @dev Payment locks this contract opened, so an expired one can be traced back and reclaimed.
    mapping(bytes32 lockId => bytes32 matchId) private _payoutLockOf;

    /// @dev Single-use guard over the book's authorisation ids.
    mapping(bytes32 authId => bool used) private _consumed;

    /// @dev Monotonic, feeding {DEPOSIT_DOMAIN}-separated deposit references.
    uint256 private _depositNonce;

    address private _attester;
    address private _owner;

    modifier onlyAttester() {
        if (msg.sender != _attester) revert NotAttester(msg.sender);
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != _owner) revert NotOwner(msg.sender);
        _;
    }

    /**
     * @param settlementToken_ USDC on Arc. Use the ERC-20 interface (6 decimals), never the
     *        18-decimal native gas accounting - mixing the two is a documented way to lose money.
     * @param paymentEscrow_ The {IDvpEscrow} on this chain. Every payout leaves toward it, so it has
     *        to exist before this contract does.
     * @param initialAttester The address permitted to relay the book's authorisations.
     * @param initialOwner Curator of the attester role. Holds no spending power of its own.
     */
    constructor(IERC20 settlementToken_, IDvpEscrow paymentEscrow_, address initialAttester, address initialOwner) {
        if (
            address(settlementToken_) == address(0) ||
            address(paymentEscrow_) == address(0) ||
            initialAttester == address(0) ||
            initialOwner == address(0)
        ) {
            revert ZeroAddress();
        }
        _settlementToken = settlementToken_;
        _paymentEscrow = paymentEscrow_;
        _attester = initialAttester;
        _owner = initialOwner;

        emit AttesterChanged(address(0), initialAttester);
        emit OwnerTransferred(address(0), initialOwner);
    }

    // -------------------------------------------------------------------------------------------
    // Funding
    // -------------------------------------------------------------------------------------------

    /// @inheritdoc IMandateVault
    function registerMandate(uint256 mandateId, address buyer) external onlyAttester {
        if (buyer == address(0)) revert ZeroAddress();

        address existing = _buyerOf[mandateId];
        if (existing != address(0)) revert MandateAlreadyRegistered(mandateId, existing);

        _buyerOf[mandateId] = buyer;

        emit MandateRegistered(mandateId, buyer);
    }

    /// @inheritdoc IMandateVault
    function registerMatch(bytes32 matchId, uint256 mandateId, address seller, uint128 price) external onlyAttester {
        if (matchId == bytes32(0) || price == 0) revert ZeroValue();
        if (seller == address(0)) revert ZeroAddress();
        // The mandate's cash leg has to exist first, or a payout could be bound against capital that
        // has no way in and no way out.
        if (_buyerOf[mandateId] == address(0)) revert MandateNotRegistered(mandateId);

        Payout storage existing = _payouts[matchId];
        if (existing.seller != address(0)) revert MatchAlreadyRegistered(matchId, existing.seller);

        _payouts[matchId] = Payout({mandateId: mandateId, seller: seller, executed: false, price: price});

        emit MatchRegistered(matchId, mandateId, seller, price);
    }

    /// @inheritdoc IMandateVault
    function deposit(uint256 mandateId, uint128 amount) external nonReentrant returns (bytes32 depositRef) {
        if (amount == 0) revert ZeroValue();
        // Registration first, so a deposit can never land against a mandate with no way out.
        if (_buyerOf[mandateId] == address(0)) revert MandateNotRegistered(mandateId);

        uint256 nonce;
        unchecked {
            nonce = ++_depositNonce;
        }
        // Bound to this chain and this deployment, so the book can credit it exactly once and a
        // reference from a test or a redeployment can never be replayed against production.
        depositRef = keccak256(abi.encode(DEPOSIT_DOMAIN, block.chainid, address(this), nonce));

        uint128 balance = _balanceOf[mandateId] + amount;
        _balanceOf[mandateId] = balance;

        // Effects before interaction.
        _settlementToken.safeTransferFrom(msg.sender, address(this), amount);

        emit Deposited(depositRef, mandateId, msg.sender, amount, balance);
    }

    // -------------------------------------------------------------------------------------------
    // Authorised outflows
    // -------------------------------------------------------------------------------------------

    /// @inheritdoc IMandateVault
    function executeRelease(bytes32 authId, uint256 mandateId, uint128 amount) external onlyAttester nonReentrant {
        address buyer = _buyerOf[mandateId];
        if (buyer == address(0)) revert MandateNotRegistered(mandateId);

        uint128 amountOut = _consumeAuthorisation(authId, mandateId, amount);

        // The recipient is NOT a parameter. See the contract header, bound (2).
        _settlementToken.safeTransfer(buyer, amountOut);

        emit ReleaseExecuted(authId, mandateId, buyer, amountOut);
    }

    /// @inheritdoc IMandateVault
    function executePayout(
        bytes32 authId,
        bytes32 matchId,
        bytes32 lockId,
        bytes32 secretHash
    ) external onlyAttester nonReentrant {
        Payout storage payout = _payouts[matchId];

        address seller = payout.seller;
        // No binding, no payout. There is no fallback to a caller-supplied address, which is the
        // whole point: an unregistered match has no payee this contract is willing to invent.
        if (seller == address(0)) revert MatchNotRegistered(matchId);
        if (payout.executed) revert PayoutAlreadyExecuted(matchId);

        uint256 mandateId = payout.mandateId;
        uint128 price = payout.price;

        payout.executed = true;
        uint128 amountOut = _consumeAuthorisation(authId, mandateId, price);

        _payoutLockOf[lockId] = matchId;

        // Effects above, interactions below. `forceApprove` rather than `approve` because the
        // settlement token is a third-party contract and the USDT-style non-standard return is not
        // this contract's to assume away; the allowance is consumed immediately by `openLock`, so it
        // is never left standing.
        _settlementToken.forceApprove(address(_paymentEscrow), amountOut);
        _paymentEscrow.openLock(
            lockId,
            secretHash,
            matchId, // tradeRef: pairs this leg with the delivery lock on the other chain
            seller,
            address(_settlementToken),
            amountOut,
            uint64(block.timestamp) + _PAYMENT_LOCK_DURATION,
            IDvpEscrow.LegKind.Payment
        );

        emit PayoutExecuted(authId, matchId, mandateId, seller, lockId, secretHash, amountOut);
    }

    /// @inheritdoc IMandateVault
    function reclaimPayout(bytes32 lockId) external nonReentrant {
        bytes32 matchId = _payoutLockOf[lockId];
        if (matchId == bytes32(0)) revert PayoutLockUnknown(lockId);

        Payout storage payout = _payouts[matchId];
        uint256 mandateId = payout.mandateId;
        uint128 price = payout.price;

        // Cleared before the refund, so a second call finds nothing to reclaim even if the escrow's
        // own terminal-status guard were ever relaxed.
        _payoutLockOf[lockId] = bytes32(0);

        // Reverts unless this contract is the depositor and the lock has timed out unclaimed. The
        // conditions live in the escrow rather than being restated here, so there is one place where
        // "claimed" and "refundable" are decided.
        _paymentEscrow.refund(lockId);

        uint128 balance = _balanceOf[mandateId] + price;
        _balanceOf[mandateId] = balance;

        uint256 nonce;
        unchecked {
            nonce = ++_depositNonce;
        }
        bytes32 depositRef = keccak256(abi.encode(DEPOSIT_DOMAIN, block.chainid, address(this), nonce));

        // Returning capital re-enters the book through the ordinary funding path. The attester sees
        // a {Deposited} it already knows how to relay, rather than needing a second code path for a
        // case that should almost never happen.
        emit PayoutReclaimed(matchId, lockId, mandateId, price, depositRef);
        emit Deposited(depositRef, mandateId, address(this), price, balance);
    }

    /**
     * @dev The shared guard on both outflows: non-zero, single-use, and within the mandate's own
     *      balance. Debits the balance before returning, so the caller performs only the transfer.
     */
    function _consumeAuthorisation(bytes32 authId, uint256 mandateId, uint128 amount) private returns (uint128) {
        if (authId == bytes32(0) || amount == 0) revert ZeroValue();
        if (_consumed[authId]) revert AuthorisationConsumed(authId);

        uint128 balance = _balanceOf[mandateId];
        if (amount > balance) revert InsufficientVaultBalance(mandateId, amount, balance);

        _consumed[authId] = true;
        _balanceOf[mandateId] = balance - amount;

        return amount;
    }

    // -------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------

    /// @inheritdoc IMandateVault
    function balanceOf(uint256 mandateId) external view returns (uint128) {
        return _balanceOf[mandateId];
    }

    /// @inheritdoc IMandateVault
    function buyerOf(uint256 mandateId) external view returns (address) {
        return _buyerOf[mandateId];
    }

    /// @inheritdoc IMandateVault
    function payoutOf(bytes32 matchId) external view returns (Payout memory) {
        return _payouts[matchId];
    }

    /// @inheritdoc IMandateVault
    function payoutLockOf(bytes32 lockId) external view returns (bytes32) {
        return _payoutLockOf[lockId];
    }

    /// @inheritdoc IMandateVault
    function paymentEscrow() external view returns (address) {
        return address(_paymentEscrow);
    }

    /// @inheritdoc IMandateVault
    function PAYMENT_LOCK_DURATION() external pure returns (uint64) {
        return _PAYMENT_LOCK_DURATION;
    }

    /// @inheritdoc IMandateVault
    function isConsumed(bytes32 authId) external view returns (bool) {
        return _consumed[authId];
    }

    /// @inheritdoc IMandateVault
    function settlementToken() external view returns (address) {
        return address(_settlementToken);
    }

    /// @inheritdoc IMandateVault
    function attester() external view returns (address) {
        return _attester;
    }

    /// @notice Curator of the attester role.
    function owner() external view returns (address) {
        return _owner;
    }

    // -------------------------------------------------------------------------------------------
    // Administration
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Rotate the relaying attester.
     * @dev The ONLY recovery path for a stalled or compromised relay, and deliberately the only one.
     *      A timeout-based withdrawal would let a buyer pull capital the book still counts as
     *      committed, which is the single thing this contract exists to prevent.
     */
    function setAttester(address newAttester) external onlyOwner {
        if (newAttester == address(0)) revert ZeroAddress();
        address previous = _attester;
        _attester = newAttester;
        emit AttesterChanged(previous, newAttester);
    }

    /// @notice Transfer curation of the attester role.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = _owner;
        _owner = newOwner;
        emit OwnerTransferred(previous, newOwner);
    }
}
