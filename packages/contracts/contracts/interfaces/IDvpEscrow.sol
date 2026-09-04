// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/**
 * @title IDvpEscrow
 * @notice Delivery versus payment across two chains, with no bridge and nothing wrapped.
 *
 * @dev The paper is an ATS bond on Hedera; the cash is USDC on Arc. Neither party should have to
 *      move first, and neither asset should have to travel. This is a hash-timelock escrow deployed
 *      symmetrically - one instance on each chain - where both legs are locked against the same
 *      `secretHash` and revealing the preimage to claim one leg publishes it for the other.
 *
 *      WHAT IS ATOMIC AND WHAT IS NOT. Stating this plainly, because "atomic swap" is routinely
 *      claimed for this construction and it is not true:
 *
 *        - There is NO atomicity across the two chains. Two independent consensus systems cannot
 *          commit a single transaction. What this gives is FAIR EXCHANGE UNDER A LIVENESS
 *          ASSUMPTION: either both legs complete, or both refund, PROVIDED each party submits a
 *          transaction before their own timeout expires.
 *        - Each leg is individually atomic within its own chain. A claim either moves the asset and
 *          publishes the preimage, or does neither.
 *        - The dangerous state is real and is not engineered away. Between the moment the preimage
 *          becomes public on chain B and the moment the counterparty claims on chain A, the trade is
 *          half-done. If chain A is congested, halted, or reorganising, and the counterparty's
 *          timeout lapses in that window, they can lose their leg while the other side keeps theirs.
 *          The mitigation is parameterisation, not cryptography: see the ordering rule below.
 *
 *      THE ORDERING RULE, which is the classic footgun and the one thing an integrator must get
 *      right. Let A be the party who generates the secret.
 *
 *          A locks first, with the LONGER timeout.
 *          B locks second, with the SHORTER timeout, after observing A's lock.
 *          A claims B's leg first, publishing the preimage.
 *          B claims A's leg second, using the now-public preimage.
 *
 *      Reverse it and A can wait until B's timeout has nearly lapsed, then claim, leaving B unable
 *      to claim in time. `MIN_LEG_GAP` enforces a floor on the difference between the two timeouts
 *      so that B always has a usable window; it cannot enforce which party generated the secret,
 *      because this contract cannot see the other chain. That part is the integrator's obligation
 *      and is why {openLock} takes the timeout explicitly rather than deriving it.
 *
 *      THE FREE-OPTION PROBLEM, disclosed rather than hidden. Between locking and claiming, the
 *      party holding the preimage holds a free option: if the price moves against them they can
 *      simply not reveal and take the refund, having cost the counterparty the time value of locked
 *      capital and nothing else. This is inherent to hash-timelock exchange and is not fixed here.
 *      It is tolerable for this venue specifically because the tenors are minutes, not days, and
 *      because the priced asset is a fixed-face zero-coupon claim whose value cannot move materially
 *      inside a settlement window. It would NOT be tolerable for a volatile pair.
 *
 *      WHY HASHLOCK RATHER THAN AN AUTHORISATION-CLAIM ESCROW. The alternative is a trusted attester
 *      - a facilitator, a notary, an oracle committee - that observes leg one and signs an
 *      authorisation releasing leg two. It is simpler, has no ordering footgun and no free option.
 *      It was rejected because it reintroduces exactly the trusted intermediary the venue exists to
 *      remove: the attester could refuse to sign, sign falsely, or be compelled, and the seller
 *      would have no recourse that did not run through the venue. A preimage cannot be compelled to
 *      lie. The cost of that choice is the two honest weaknesses above, and they are the right ones
 *      to accept for a settlement window measured in minutes.
 *
 *      RELATION TO x402. The venue drives this with x402 as the settlement protocol rather than as
 *      an API paywall: the challenge carries the asset leg, the payment signature is the cash leg,
 *      and the facilitator is what makes the two near-simultaneous. Note what the facilitator is and
 *      is not - it schedules and relays, so it can make the exchange fast, but it holds no custody
 *      and cannot make either leg complete without the preimage. Losing the facilitator degrades
 *      settlement to manual claiming within the timeout; it does not put funds at risk.
 *
 *      HEDERA NOTE. On the Hedera side, both parties must have associated the settlement token and
 *      the security token before any transfer to them can succeed. An unassociated beneficiary turns
 *      a claim into a revert, which under the ordering rule above burns claim window rather than
 *      funds. Association is therefore an onboarding precondition, checked before a lock is opened,
 *      never at claim time.
 */
interface IDvpEscrow {
    // -------------------------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Which side of the trade a lock represents.
     * @dev Recorded rather than inferred so that an indexer watching one chain can pair a lock with
     *      its counterpart on the other without reconstructing the trade from asset addresses.
     */
    enum LegKind {
        Unspecified, // 0 - never valid; zero-value guard
        Delivery, // 1 - the instrument leg (Hedera: the ATS bond)
        Payment // 2 - the cash leg (Arc: USDC)
    }

    /// @notice Lifecycle of one leg. Terminal in both `Claimed` and `Refunded`.
    enum LockStatus {
        None, // 0 - no such lock
        Locked, // 1 - funded, awaiting preimage or timeout
        Claimed, // 2 - beneficiary revealed the preimage and took the asset
        Refunded // 3 - timeout elapsed and the depositor took the asset back
    }

    /**
     * @notice One side of a cross-chain trade.
     * @dev Layout: `secretHash` and `tradeRef` take a full slot each; `depositor`+`timeout`+`kind`
     *      +`status` pack into one (20+8+1+1 = 30); `beneficiary` and `asset` share none since each
     *      is 20 bytes, so they occupy a slot apiece with room to spare. `amount` is `uint256`
     *      rather than `uint128` because the delivery leg counts security-token units, whose
     *      decimals are set by the issuer and are not the venue's to bound.
     */
    struct Lock {
        /// @dev `keccak256(secret)`. Identical on both chains for a paired trade.
        bytes32 secretHash;
        /// @dev Venue trade reference, typically the {IMandateBook} match id. Ties the two legs together.
        bytes32 tradeRef;
        /// @dev Who funded the lock and who is refunded if it times out.
        address depositor;
        /// @dev When the depositor may refund, unix seconds. Claiming is permitted strictly before this.
        uint64 timeout;
        /// @dev Delivery or payment.
        LegKind kind;
        /// @dev Lifecycle.
        LockStatus status;
        /// @dev Who may claim by revealing the preimage.
        address beneficiary;
        /// @dev ERC-20 being escrowed. The native asset is not supported; see {openLock}.
        address asset;
        /// @dev Units escrowed.
        uint256 amount;
    }

    // -------------------------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------------------------

    /// @notice A leg was funded and locked.
    event LockOpened(
        bytes32 indexed lockId,
        bytes32 indexed tradeRef,
        bytes32 secretHash,
        address indexed depositor,
        address beneficiary,
        address asset,
        uint256 amount,
        uint64 timeout,
        LegKind kind
    );

    /**
     * @notice A leg was claimed, and the preimage is now public.
     * @dev `secret` is emitted deliberately and is the mechanism, not a leak. The counterparty's
     *      relayer watches for exactly this log on one chain in order to claim on the other. It is
     *      also stored in {revealedSecret} so the preimage survives log pruning on any client that
     *      only reads state.
     */
    event LockClaimed(bytes32 indexed lockId, bytes32 indexed tradeRef, address indexed beneficiary, bytes32 secret);

    /// @notice A leg timed out and the depositor took the asset back.
    event LockRefunded(bytes32 indexed lockId, bytes32 indexed tradeRef, address indexed depositor, uint256 amount);

    // -------------------------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------------------------

    /// @notice A lock already exists under this id. Ids are caller-supplied and must be unique.
    error LockExists(bytes32 lockId);

    /// @notice No lock exists under this id.
    error LockUnknown(bytes32 lockId);

    /// @notice The lock is not in `Locked` status, so it has already resolved.
    error LockNotOpen(bytes32 lockId, LockStatus status);

    /// @notice `keccak256(secret)` did not equal the lock's `secretHash`.
    error InvalidSecret(bytes32 lockId);

    /// @notice The timeout has passed, so the lock may only be refunded now.
    error LockExpired(bytes32 lockId, uint64 timeout);

    /// @notice The timeout has not yet passed, so the lock may not be refunded.
    error TimeoutNotReached(bytes32 lockId, uint64 timeout);

    /// @notice The requested timeout is too near to leave a usable claim window. See `MIN_LOCK_DURATION`.
    error TimeoutTooSoon(uint64 requested, uint64 minimum);

    /// @notice The requested timeout is far enough out to strand capital. See `MAX_LOCK_DURATION`.
    error TimeoutTooLate(uint64 requested, uint64 maximum);

    /// @notice Only the beneficiary may claim.
    error NotBeneficiary(bytes32 lockId, address caller);

    /// @notice Only the depositor may refund.
    error NotDepositor(bytes32 lockId, address caller);

    /// @notice A zero address was supplied where a real one is required.
    error ZeroAddress();

    /// @notice A zero amount, hash or id was supplied where a non-zero one is required.
    error ZeroValue();

    /// @notice `kind` was `Unspecified`.
    error InvalidLegKind();

    // -------------------------------------------------------------------------------------------
    // Functions
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Fund and lock one leg of a cross-chain trade.
     *
     * @dev Pulls `amount` of `asset` from `msg.sender`, who must have approved this contract. Only
     *      ERC-20 assets are supported, including the security token, which on Hedera is reached
     *      through its ERC-20 facade rather than the native HTS interface. The native asset is
     *      deliberately unsupported: HBAR is 8 decimals on the ledger and 18 over the JSON-RPC
     *      relay, and mixing that scaling into escrow arithmetic is a documented way to lose money.
     *
     *      `lockId` is supplied by the caller rather than generated, so that both chains can use the
     *      same identifier for a paired trade and an operator can reconcile the two legs without a
     *      lookup table. It must be unique on this chain.
     *
     *      This function CANNOT verify that a counterpart lock exists on the other chain, that its
     *      timeout is correctly ordered relative to this one, or that the secret generator locked
     *      first. See the ordering rule in the contract header - that obligation is the integrator's.
     *
     * @param lockId Caller-supplied unique identifier, shared with the counterpart leg.
     * @param secretHash `keccak256(secret)`. Both legs of a trade share this.
     * @param tradeRef Venue trade reference, typically the match id.
     * @param beneficiary Who may claim by revealing the preimage.
     * @param asset ERC-20 to escrow.
     * @param amount Units to escrow.
     * @param timeout Unix seconds after which the depositor may refund.
     * @param kind Delivery or payment.
     */
    function openLock(
        bytes32 lockId,
        bytes32 secretHash,
        bytes32 tradeRef,
        address beneficiary,
        address asset,
        uint256 amount,
        uint64 timeout,
        LegKind kind
    ) external;

    /**
     * @notice Claim a leg by revealing the preimage, before the timeout.
     * @dev Publishes `secret` in the {LockClaimed} log and in {revealedSecret}, which is what lets
     *      the counterparty claim the other leg. Claiming is permitted strictly before `timeout`;
     *      at or after it, only refund is possible, so there is never a window in which both a claim
     *      and a refund would succeed.
     * @param lockId The lock to claim.
     * @param secret The preimage of `secretHash`.
     */
    function claim(bytes32 lockId, bytes32 secret) external;

    /**
     * @notice Take back an escrowed leg after its timeout.
     * @dev Depositor only. Permitted at or after `timeout`. Because claim is strictly-before and
     *      refund is at-or-after, the two are disjoint on the same block timestamp.
     * @param lockId The lock to refund.
     */
    function refund(bytes32 lockId) external;

    // -------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------

    /// @notice Read a lock. Returns a zero-filled struct for an unknown id.
    function getLock(bytes32 lockId) external view returns (Lock memory);

    /**
     * @notice The preimage revealed by a successful claim, or zero if not yet claimed.
     * @dev Stored as well as logged so a counterparty relayer can recover the secret from state on a
     *      node that does not serve historical logs. This is the cross-chain channel.
     */
    function revealedSecret(bytes32 lockId) external view returns (bytes32);

    /// @notice Whether `secret` would successfully claim `lockId` at the current block timestamp.
    function isClaimable(bytes32 lockId, bytes32 secret) external view returns (bool);

    /// @notice Whether `lockId` may be refunded at the current block timestamp.
    function isRefundable(bytes32 lockId) external view returns (bool);

    /// @notice Shortest permitted time from now to a lock's timeout.
    function MIN_LOCK_DURATION() external view returns (uint64);

    /// @notice Longest permitted time from now to a lock's timeout.
    function MAX_LOCK_DURATION() external view returns (uint64);

    /**
     * @notice Recommended minimum difference between the two legs' timeouts.
     * @dev Advisory, not enforceable here, because this contract cannot see the other chain. Exposed
     *      so that an operator and an auditor read the same number.
     */
    function MIN_LEG_GAP() external view returns (uint64);
}
