// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/**
 * @title IMandateVault
 * @notice The cash leg of a mandate. Holds escrowed USDC on Arc; releases only on the book's word.
 *
 * @dev WHY THE CAPITAL IS HERE AND THE BOOK IS NOT.
 *
 *      {MandateBook} needs two things that cannot both be local to one chain: a synchronous
 *      compliance answer from an ATS diamond (Hedera) and custody of the buyer's USDC (Arc, where
 *      treasury capital already lives). Rather than compromise one, the venue splits them along the
 *      line of what actually has to be live:
 *
 *        - COMPLIANCE MUST BE SYNCHRONOUS. It is a legal fact that has to be exactly right at the
 *          instant of matching, and "the venue refuses to match" is the whole claim against an AMM
 *          that discovers illegality at settlement. So the book stays on Hedera, beside the paper,
 *          and reads the facets directly.
 *        - A FUNDED BALANCE DOES NOT HAVE TO BE SYNCHRONOUS. It is a number only one party can move.
 *          So the capital stays here on Arc, never bridges, and the book holds an ATTESTED view of
 *          it.
 *
 *      WHAT MAKES THE ATTESTED BALANCE SOUND. An attested number is only safe if the thing it
 *      describes cannot change behind its back. That is this contract's entire job: WITHDRAWAL
 *      REQUIRES AN AUTHORISATION ISSUED BY THE BOOK. A buyer cannot pull capital on Arc while the
 *      book still believes it is committed, because the only path out of this contract is one the
 *      book opened. Overcommitment is closed structurally, without a synchronous balance read.
 *
 *      STALENESS, AND WHY BOTH WINDOWS FAIL SAFE. There are exactly two lags, and neither can make
 *      the book believe it has more money than it has:
 *
 *        1. Arc deposit -> Hedera credit. Until the attester relays it, the book UNDER-counts. The
 *           mandate simply matches less than it could. Fails toward refusal.
 *        2. Hedera release authorisation -> Arc execution. The book decrements `totalCommitted` at
 *           the moment it authorises, before the tokens move, so again it UNDER-counts.
 *
 *      Under an honest attester the attested balance is therefore a LOWER BOUND on real withdrawable
 *      Arc capital, at every instant. That is the property that makes the split defensible.
 *
 *      THE HONEST WEAK POINT. The unsafe direction - attested balance above real balance - is not
 *      reachable by lag. It is reachable only by an attester crediting a deposit that never
 *      happened, at which point the book can match a trade the cash leg cannot pay, and the failure
 *      surfaces at settlement. v1 runs a single trusted attester and says so rather than implying
 *      otherwise. Three things bound the damage even so, and they are enforced here rather than
 *      assumed:
 *
 *        - Per-mandate accounting. Each mandate's balance is tracked separately and an outflow can
 *          never exceed it, so a bad authorisation cannot reach another mandate's capital.
 *        - Releases are hard-bound to the registered buyer. {executeRelease} ignores any recipient in
 *          the authorisation and always pays {buyerOf}. The attester cannot redirect a buyer's own
 *          capital to itself.
 *        - Payouts are hard-bound to the registered seller, and leave only toward the payment
 *          escrow. {executePayout} takes no beneficiary and no amount: it reads {payoutOf}, a
 *          one-shot binding relayed at MATCH time, and opens a lock for that seller at that price out
 *          of that mandate. Because the binding lands before delivery, the seller can check who the
 *          venue will pay while they still hold the paper.
 *        - Every authorisation is single-use, keyed by an id the book derives from its own chain id,
 *          address and nonce, so a relayed authorisation cannot be replayed here or on another
 *          deployment. A match, separately, admits at most one payout ever.
 *
 *      WHAT IS STILL TRUSTED, PRECISELY. Authorisation ids are public hashes of a nonce, so a
 *      compromised attester can forge one; combined with a forged match registration it can drain a
 *      mandate's balance toward an address of its choosing. No arrangement of this contract closes
 *      that, because Arc cannot read Hedera and this contract therefore cannot authenticate the
 *      book's word - only the messenger's. What the bindings above change is the SHAPE of the
 *      residual: nothing can be redirected after the fact, every destination is committed before
 *      delivery and publicly readable, and every outflow lands in a contract where it is visible and
 *      refundable rather than in an EOA where it is gone.
 *
 *      TODO(v2): replace the single attester with either a threshold of independent attesters or a
 *      light-client proof of the Arc deposit log. The interface does not change; only who may call
 *      {creditFunding}'s counterpart on the book does.
 *
 *      ATTESTER FAILURE IS A LIVENESS FAILURE, NOT A LOSS. If the attester stops, deposits stop
 *      being credited (the mandate stops growing - safe) and authorised releases stop executing
 *      (buyer capital sits here, unreachable). Recovery is attester ROTATION by the owner, never a
 *      timeout escape hatch: a path out of this contract that did not require the book's word would
 *      destroy the exact property the design exists to provide.
 */
interface IMandateVault {
    // -------------------------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------------------------

    /**
     * @notice The payee, payer and price of one matched trade, bound here before it settles.
     *
     * @dev This is the payout counterpart of the buyer binding, and it exists for the same reason:
     *      an outflow whose destination is an argument is an outflow the relay chooses. Registered
     *      once, at match time, and never re-pointable - so by the time a payout is authorised there
     *      is nothing left for the attester to decide except when to relay it.
     *
     *      Registering at MATCH time rather than at settlement time is the part that does the work.
     *      The seller can read this binding on Arc before they part with the paper, which turns the
     *      payee from something they have to trust into something they can check. A binding that
     *      appeared only at payout would be checkable only after delivery, which is too late to be
     *      worth anything.
     */
    struct Payout {
        /// @dev The mandate whose escrowed capital pays. Fixes which balance an authorisation debits.
        uint256 mandateId;
        /// @dev The seller recorded on the book at match time. The only address a payout may name.
        address seller;
        /// @dev Whether the payout has been executed. One match, at most one payout, ever.
        bool executed;
        /// @dev The matched price. Fixes the amount an authorisation may move.
        uint128 price;
    }

    // -------------------------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------------------------

    /**
     * @notice A mandate's cash leg was opened and bound to its buyer.
     * @dev One-shot. The binding is what lets {executeRelease} refuse to pay anyone else.
     */
    event MandateRegistered(uint256 indexed mandateId, address indexed buyer);

    /**
     * @notice A matched trade's payee, payer and price were bound here.
     * @dev One-shot, relayed from the book's `Matched`. Emitted so the seller can verify the payee
     *      binding before delivering.
     */
    event MatchRegistered(bytes32 indexed matchId, uint256 indexed mandateId, address indexed seller, uint128 price);

    /**
     * @notice Capital was escrowed against a mandate. The attester relays this to the book.
     * @param depositRef Unique reference the book uses to credit this deposit exactly once.
     * @param mandateId The mandate funded.
     * @param funder Who supplied the capital, which need not be the buyer.
     * @param amount Units escrowed.
     * @param balance The mandate's new vault balance, so an indexer never has to accumulate.
     */
    event Deposited(
        bytes32 indexed depositRef,
        uint256 indexed mandateId,
        address indexed funder,
        uint128 amount,
        uint128 balance
    );

    /// @notice Unallocated capital was returned to the buyer under an authorisation from the book.
    event ReleaseExecuted(bytes32 indexed authId, uint256 indexed mandateId, address indexed buyer, uint128 amount);

    /**
     * @notice A settled trade's price left the vault into the payment escrow, locked for the seller.
     * @dev The payout does not reach the seller here - it reaches the escrow, where it sits as a
     *      claimable, refundable lock. `lockId` and `secretHash` pair this with the delivery leg on
     *      the other chain.
     */
    event PayoutExecuted(
        bytes32 indexed authId,
        bytes32 indexed matchId,
        uint256 indexed mandateId,
        address seller,
        bytes32 lockId,
        bytes32 secretHash,
        uint128 amount
    );

    /**
     * @notice An unclaimed payment lock timed out and its capital returned to the mandate.
     * @dev Carries a fresh `depositRef` and is accompanied by a {Deposited} event, so the returning
     *      capital re-enters the book through the same path any other deposit does.
     */
    event PayoutReclaimed(
        bytes32 indexed matchId,
        bytes32 indexed lockId,
        uint256 indexed mandateId,
        uint128 amount,
        bytes32 depositRef
    );

    /// @notice The relaying attester was rotated. The recovery path for a stalled attester.
    event AttesterChanged(address indexed previousAttester, address indexed newAttester);

    /// @notice Ownership of the attester role moved.
    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);

    // -------------------------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------------------------

    /// @notice The caller is not the relaying attester.
    error NotAttester(address caller);

    /// @notice The caller is not the owner.
    error NotOwner(address caller);

    /// @notice The mandate has no cash leg here yet. Deposits require registration first.
    error MandateNotRegistered(uint256 mandateId);

    /// @notice The mandate's cash leg was already opened; the buyer binding is immutable.
    error MandateAlreadyRegistered(uint256 mandateId, address buyer);

    /// @notice The match has no payee binding here, so there is no address a payout could pay.
    error MatchNotRegistered(bytes32 matchId);

    /// @notice The match's payee binding was already set; like the buyer binding, it never moves.
    error MatchAlreadyRegistered(bytes32 matchId, address seller);

    /// @notice This match's payout has already left the vault. One match, at most one payout.
    error PayoutAlreadyExecuted(bytes32 matchId);

    /// @notice No payment lock was opened here under this id, so there is nothing to reclaim.
    error PayoutLockUnknown(bytes32 lockId);

    /**
     * @notice This authorisation has already been executed.
     * @dev The replay guard. Authorisation ids are derived by the book from its own chain id,
     *      address and a nonce, so this also prevents an authorisation issued for one deployment
     *      being replayed against another.
     */
    error AuthorisationConsumed(bytes32 authId);

    /**
     * @notice The mandate's vault balance is smaller than the authorised amount.
     * @dev The bound that stops a bad authorisation reaching another mandate's capital. If this
     *      ever reverts in production it means the book and the vault have diverged, which is an
     *      incident rather than a user error.
     */
    error InsufficientVaultBalance(uint256 mandateId, uint128 requested, uint128 balance);

    /// @notice A zero address was supplied where a real one is required.
    error ZeroAddress();

    /// @notice A zero amount or zero id was supplied where a non-zero one is required.
    error ZeroValue();

    // -------------------------------------------------------------------------------------------
    // Funding
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Open a mandate's cash leg and bind it permanently to its buyer.
     * @dev Attester only, relaying a {MandatePosted} from the book. One-shot: the buyer binding can
     *      never change, which is what {executeRelease} relies on to refuse a redirected payment.
     * @param mandateId The mandate, as numbered by the book.
     * @param buyer The mandate's owner on the book, and the only address a release may ever pay.
     */
    function registerMandate(uint256 mandateId, address buyer) external;

    /**
     * @notice Bind a matched trade's payee, payer and price, before it settles.
     *
     * @dev Attester only, relaying a `Matched` from the book. One-shot, exactly like
     *      {registerMandate}: the payee binding is what {executePayout} consults instead of taking a
     *      beneficiary argument, so it must not be re-pointable by the party that relays it.
     *
     *      The mandate must already be registered, which keeps a payout from being bound against a
     *      cash leg that does not exist. `price` and `mandateId` are bound here too, not just the
     *      seller: with all three fixed, a payout authorisation carries no discretion at all - it can
     *      only move this amount, out of this mandate, toward this seller.
     *
     * @param matchId The book's match id.
     * @param mandateId The mandate whose capital pays.
     * @param seller The payee recorded on the book at match time.
     * @param price The matched price, in settlement-currency units.
     */
    function registerMatch(bytes32 matchId, uint256 mandateId, address seller, uint128 price) external;

    /**
     * @notice Escrow settlement currency against a mandate.
     *
     * @dev Pulls `amount` from `msg.sender`, who must have approved this contract. Anyone may fund
     *      any registered mandate - a treasury funding a policy-capped agent's mandate is a
     *      first-class use - because funding can only ever increase the buyer's position, and the
     *      way out is bound to the buyer regardless of who put the money in.
     *
     *      Emits {Deposited} with a unique `depositRef`. The attester relays that reference to the
     *      book, which credits it exactly once. Until then the book under-counts, which is safe.
     *
     * @param mandateId The mandate to fund.
     * @param amount Units to escrow.
     * @return depositRef The reference the book will credit against.
     */
    function deposit(uint256 mandateId, uint128 amount) external returns (bytes32 depositRef);

    // -------------------------------------------------------------------------------------------
    // Authorised outflows - the only two paths out of this contract
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Return unallocated capital to a mandate's buyer, under an authorisation from the book.
     *
     * @dev Attester only, relaying a `ReleaseAuthorised` from the book. The book has already
     *      decremented its own `totalCommitted`, so by the time this runs the attested balance is
     *      already below the real one.
     *
     *      Note what is deliberately NOT a parameter: the recipient. This always pays {buyerOf}, so
     *      a compromised attester relaying a forged release can only return a buyer's capital to
     *      that same buyer. The authorisation carries a destination on the book side; this contract
     *      ignores it.
     *
     * @param authId The book's authorisation id. Single-use.
     * @param mandateId The mandate to release from.
     * @param amount Units to return.
     */
    function executeRelease(bytes32 authId, uint256 mandateId, uint128 amount) external;

    /**
     * @notice Pay out a settled trade into the payment escrow, locked for the registered seller.
     *
     * @dev Attester only, relaying a `PayoutAuthorised` from the book.
     *
     *      THE BENEFICIARY IS NOT A PARAMETER, and that is the change this function exists to carry.
     *      Capital leaves toward exactly one address - the immutable {DvpEscrow} on this chain - and
     *      the lock it opens there names {payoutOf}'s registered seller, at that registration's
     *      price, out of that registration's mandate. The attester supplies an authorisation id, a
     *      lock id and a hashlock; it supplies no payee, no amount and no mandate. Every value that
     *      decides where money goes is read from a binding made at match time, which the seller could
     *      check before delivering.
     *
     *      WHY THROUGH AN ESCROW AND NOT STRAIGHT TO THE SELLER. Three things follow from the hop
     *      that a direct transfer cannot give:
     *
     *        - A payout is no longer an irreversible transfer. It is a lock with a timeout, so a
     *          payout the seller cannot take - wrong hashlock relayed, seller's key lost - returns to
     *          the mandate through {reclaimPayout} instead of being burned.
     *        - Both legs of one trade become the same kind of object under the same `tradeRef` and
     *          the same hash, on the two chains, which is what a proof view needs to show a trade
     *          rather than two unrelated transfers.
     *        - The venue's cash leg stops being a special case. The delivery leg was already a lock;
     *          now the payment leg is one, and the ordering rule in {IDvpEscrow} applies to both.
     *
     *      WHAT THE HASHLOCK DOES AND DOES NOT DO HERE, stated rather than implied. By the time the
     *      book authorises a payout it has already proven that the delivery lock was CLAIMED, which
     *      means the preimage is public. The hash carried here therefore does not keep anyone out -
     *      the escrow's beneficiary check does that - and it is copied across for pairing and for
     *      the ordering it will need if the legs are ever reversed. The lock's protection against a
     *      misdirected payout is the beneficiary binding above, not the secret.
     *
     * @param authId The book's authorisation id. Single-use.
     * @param matchId The settled match. Selects the payee, the mandate and the amount.
     * @param lockId Identifier for the payment lock. Free-form: lock ids are caller-supplied in
     *        {IDvpEscrow}, so if one is squatted the relay simply picks another.
     * @param secretHash The delivery leg's hashlock, carried across so the two legs pair.
     */
    function executePayout(bytes32 authId, bytes32 matchId, bytes32 lockId, bytes32 secretHash) external;

    /**
     * @notice Return an expired, unclaimed payment lock's capital to the mandate that funded it.
     *
     * @dev Permissionless, because it can only move capital in one direction: out of the escrow and
     *      back into the mandate it left. There is no recipient to choose and nothing to gain by
     *      calling it, which is why it needs no role - and it must need none, since the party who
     *      most wants it called is the buyer whose capital is stuck.
     *
     *      The escrow enforces the conditions: it refunds only to the depositor, which is this
     *      contract, and only at or after the lock's timeout, and never after a claim. So this cannot
     *      race a seller who is claiming, and cannot be used to recall a payout that succeeded.
     *
     *      Emits {Deposited} as well as {PayoutReclaimed}, with a fresh reference. Returning capital
     *      re-enters the book through the ordinary funding path rather than through a special one:
     *      the attester credits it exactly as it credits any deposit, and until it does the book
     *      under-counts, which is the safe direction.
     *
     *      What this does NOT do is re-open the trade. The book has already consumed the allocation
     *      and recorded the match as settled; a reclaim means the seller was not paid, and putting
     *      that right is an operator matter, not something this contract can decide.
     *
     * @param lockId The payment lock to refund. Must have been opened by this contract.
     */
    function reclaimPayout(bytes32 lockId) external;

    // -------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------

    /// @notice Capital held here for one mandate. The hard ceiling on that mandate's outflows.
    function balanceOf(uint256 mandateId) external view returns (uint128);

    /// @notice The address a release for this mandate will always pay, or zero if unregistered.
    function buyerOf(uint256 mandateId) external view returns (address);

    /**
     * @notice The payee, payer and price bound to a match, or a zero-filled record if unregistered.
     * @dev What a seller reads before delivering, to see that the venue will pay them and not
     *      somebody else.
     */
    function payoutOf(bytes32 matchId) external view returns (Payout memory);

    /// @notice The match a payment lock opened here belongs to, or zero once reclaimed or unknown.
    function payoutLockOf(bytes32 lockId) external view returns (bytes32 matchId);

    /// @notice The escrow every payout leaves toward. Immutable, and the only outward address.
    function paymentEscrow() external view returns (address);

    /// @notice How long a payment lock stays claimable before it may be reclaimed to the mandate.
    function PAYMENT_LOCK_DURATION() external view returns (uint64);

    /// @notice Whether an authorisation has already been executed.
    function isConsumed(bytes32 authId) external view returns (bool);

    /// @notice The escrowed settlement currency (USDC on Arc).
    function settlementToken() external view returns (address);

    /// @notice The address permitted to relay the book's authorisations.
    function attester() external view returns (address);
}
