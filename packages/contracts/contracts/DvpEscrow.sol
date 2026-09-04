// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IDvpEscrow} from "./interfaces/IDvpEscrow.sol";

/**
 * @title DvpEscrow
 * @notice Hash-timelock escrow for one leg of a cross-chain delivery-versus-payment trade.
 *
 * @dev Deploy one instance per chain: on Hedera it escrows the ATS bond (delivery), on Arc it
 *      escrows USDC (payment). The two instances never communicate. The only thing that crosses is
 *      a 32-byte preimage, carried by whoever is watching, and it crosses only as a consequence of
 *      someone claiming what is already theirs to claim.
 *
 *      The trust model, the ordering rule that integrators must honour, the free-option problem and
 *      the reasons for preferring a hashlock over a trusted attester are all documented at length on
 *      {IDvpEscrow}. Read that before wiring this up; the ordering rule in particular is the
 *      difference between a fair exchange and a one-sided one, and this contract cannot enforce it.
 *
 *      What this implementation guarantees on its own chain:
 *
 *        - Claim and refund are DISJOINT. Claim requires `block.timestamp < timeout`; refund
 *          requires `block.timestamp >= timeout`. There is no timestamp at which both are live, so
 *          the asset cannot be taken twice even under adversarial block-time manipulation. A miner
 *          or consensus node nudging the timestamp can only choose WHICH of the two is available,
 *          never both, and only near the boundary the depositor already chose.
 *        - Status is set before any transfer, and the only transitions out of `Locked` are terminal.
 *          Combined with `nonReentrant`, a token with transfer hooks cannot re-enter to claim twice.
 *        - The preimage is written to storage as well as logged. A counterparty relayer running
 *          against a pruned node can still recover it, which matters because losing the preimage
 *          after the counterparty has claimed is precisely the half-done state that costs money.
 *
 *      WHY keccak256 AND NOT sha256. Both chains here are EVM, so `keccak256` is the native, cheap
 *      choice and both legs can verify the same commitment directly. `sha256` would only be required
 *      if one leg lived on a chain whose script system cannot compute keccak - Bitcoin-family
 *      chains, most notably. Should such a leg ever be added, this is the line that changes, and it
 *      is called out here rather than buried so that the assumption is visible.
 *
 *      DECIMALS. Only ERC-20 assets are escrowed, never the native token. HBAR is 8 decimals on the
 *      Hedera ledger and 18 over the JSON-RPC relay for the same balance, and mixing those scales
 *      inside escrow arithmetic is a documented way to lose funds. Refusing `msg.value` entirely
 *      removes the question rather than answering it carefully.
 */
contract DvpEscrow is IDvpEscrow, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------------------------
    // Timeout bounds
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Shortest permitted time from now to a lock's timeout.
     * @dev Fifteen minutes. A shorter lock cannot be honestly claimed: the beneficiary has to
     *      observe the lock, then submit and get a transaction included, and on a congested chain
     *      that is not reliably a matter of seconds. Setting a floor is what stops a depositor
     *      opening a lock that is technically claimable but practically already expired - which
     *      would be a free option dressed up as a trade.
     */
    uint64 internal constant _MIN_LOCK_DURATION = 15 minutes;

    /**
     * @notice Longest permitted time from now to a lock's timeout.
     * @dev Two days. Every second of lock is a second the depositor's capital is immobile and the
     *      beneficiary holds a free option over it. The ceiling bounds the value of that option.
     */
    uint64 internal constant _MAX_LOCK_DURATION = 2 days;

    /**
     * @notice Recommended minimum difference between the two legs' timeouts.
     * @dev One hour. Advisory only, because this contract cannot see the other chain - it is
     *      published so an operator and an auditor argue about the same number rather than about a
     *      value buried in a deploy script. It must comfortably exceed the worst-case finality plus
     *      congestion window of the SLOWER chain, since that is what bounds how long the second
     *      claimant might need after the preimage becomes public.
     */
    uint64 internal constant _MIN_LEG_GAP = 1 hours;

    // The bounds are surfaced through functions rather than as `public constant` variables so they
    // satisfy the {IDvpEscrow} declarations without relying on the state-variable-overrides-function
    // rule, whose mutability handling differs across compiler versions.

    /// @inheritdoc IDvpEscrow
    function MIN_LOCK_DURATION() external pure returns (uint64) {
        return _MIN_LOCK_DURATION;
    }

    /// @inheritdoc IDvpEscrow
    function MAX_LOCK_DURATION() external pure returns (uint64) {
        return _MAX_LOCK_DURATION;
    }

    /// @inheritdoc IDvpEscrow
    function MIN_LEG_GAP() external pure returns (uint64) {
        return _MIN_LEG_GAP;
    }

    // -------------------------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------------------------

    mapping(bytes32 lockId => Lock) private _locks;

    /// @dev The cross-chain channel. Written once, at claim, and never cleared.
    mapping(bytes32 lockId => bytes32 secret) private _revealedSecret;

    // -------------------------------------------------------------------------------------------
    // Locking
    // -------------------------------------------------------------------------------------------

    /// @inheritdoc IDvpEscrow
    function openLock(
        bytes32 lockId,
        bytes32 secretHash,
        bytes32 tradeRef,
        address beneficiary,
        address asset,
        uint256 amount,
        uint64 timeout,
        LegKind kind
    ) external nonReentrant {
        if (lockId == bytes32(0) || secretHash == bytes32(0) || amount == 0) revert ZeroValue();
        if (beneficiary == address(0) || asset == address(0)) revert ZeroAddress();
        if (kind == LegKind.Unspecified) revert InvalidLegKind();
        if (_locks[lockId].status != LockStatus.None) revert LockExists(lockId);

        // Bounds are checked against `block.timestamp` rather than against a duration argument so
        // that a transaction sitting in the mempool cannot be included with a window that has
        // already shrunk below the usable minimum.
        if (timeout < block.timestamp + _MIN_LOCK_DURATION) {
            revert TimeoutTooSoon(timeout, uint64(block.timestamp) + _MIN_LOCK_DURATION);
        }
        if (timeout > block.timestamp + _MAX_LOCK_DURATION) {
            revert TimeoutTooLate(timeout, uint64(block.timestamp) + _MAX_LOCK_DURATION);
        }

        _locks[lockId] = Lock({
            secretHash: secretHash,
            tradeRef: tradeRef,
            depositor: msg.sender,
            timeout: timeout,
            kind: kind,
            status: LockStatus.Locked,
            beneficiary: beneficiary,
            asset: asset,
            amount: amount
        });

        // Effects before interaction.
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);

        emit LockOpened(lockId, tradeRef, secretHash, msg.sender, beneficiary, asset, amount, timeout, kind);
    }

    /// @inheritdoc IDvpEscrow
    function claim(bytes32 lockId, bytes32 secret) external nonReentrant {
        Lock storage l = _locks[lockId];

        if (l.status == LockStatus.None) revert LockUnknown(lockId);
        if (l.status != LockStatus.Locked) revert LockNotOpen(lockId, l.status);
        if (msg.sender != l.beneficiary) revert NotBeneficiary(lockId, msg.sender);

        // Strictly before the timeout. See the disjointness argument in the contract header.
        if (block.timestamp >= l.timeout) revert LockExpired(lockId, l.timeout);

        if (keccak256(abi.encodePacked(secret)) != l.secretHash) revert InvalidSecret(lockId);

        address beneficiary = l.beneficiary;
        address asset = l.asset;
        uint256 amount = l.amount;
        bytes32 tradeRef = l.tradeRef;

        l.status = LockStatus.Claimed;
        _revealedSecret[lockId] = secret;

        IERC20(asset).safeTransfer(beneficiary, amount);

        // The preimage is published here on purpose - this log is how the other leg gets claimed.
        emit LockClaimed(lockId, tradeRef, beneficiary, secret);
    }

    /// @inheritdoc IDvpEscrow
    function refund(bytes32 lockId) external nonReentrant {
        Lock storage l = _locks[lockId];

        if (l.status == LockStatus.None) revert LockUnknown(lockId);
        if (l.status != LockStatus.Locked) revert LockNotOpen(lockId, l.status);
        if (msg.sender != l.depositor) revert NotDepositor(lockId, msg.sender);

        // At or after the timeout. Disjoint from claim, which is strictly before.
        if (block.timestamp < l.timeout) revert TimeoutNotReached(lockId, l.timeout);

        address depositor = l.depositor;
        address asset = l.asset;
        uint256 amount = l.amount;
        bytes32 tradeRef = l.tradeRef;

        l.status = LockStatus.Refunded;

        IERC20(asset).safeTransfer(depositor, amount);

        emit LockRefunded(lockId, tradeRef, depositor, amount);
    }

    // -------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------

    /// @inheritdoc IDvpEscrow
    function getLock(bytes32 lockId) external view returns (Lock memory) {
        return _locks[lockId];
    }

    /// @inheritdoc IDvpEscrow
    function revealedSecret(bytes32 lockId) external view returns (bytes32) {
        return _revealedSecret[lockId];
    }

    /// @inheritdoc IDvpEscrow
    function isClaimable(bytes32 lockId, bytes32 secret) external view returns (bool) {
        Lock memory l = _locks[lockId];
        return
            l.status == LockStatus.Locked &&
            block.timestamp < l.timeout &&
            keccak256(abi.encodePacked(secret)) == l.secretHash;
    }

    /// @inheritdoc IDvpEscrow
    function isRefundable(bytes32 lockId) external view returns (bool) {
        Lock memory l = _locks[lockId];
        return l.status == LockStatus.Locked && block.timestamp >= l.timeout;
    }
}
