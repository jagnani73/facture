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
 *        - Every authorisation is single-use, keyed by an id the book derives from its own chain id,
 *          address and nonce, so a relayed authorisation cannot be replayed here or on another
 *          deployment.
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
    // Events
    // -------------------------------------------------------------------------------------------

    /**
     * @notice A mandate's cash leg was opened and bound to its buyer.
     * @dev One-shot. The binding is what lets {executeRelease} refuse to pay anyone else.
     */
    event MandateRegistered(uint256 indexed mandateId, address indexed buyer);

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

    /// @notice A settled trade was paid out under an authorisation from the book.
    event PayoutExecuted(
        bytes32 indexed authId,
        uint256 indexed mandateId,
        address indexed beneficiary,
        uint128 amount
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
     * @notice Pay out a settled trade, under an authorisation from the book.
     *
     * @dev Attester only, relaying a `PayoutAuthorised` from the book.
     *
     *      Unlike {executeRelease}, the beneficiary is a parameter, because the payee is a different
     *      seller on every trade and this contract has no way to know who that is. That asymmetry is
     *      the residual trust in the attester and it is stated rather than glossed: a compromised
     *      attester could direct a settled payout to an address of its choosing, bounded by the
     *      mandate's own balance.
     *
     *      TODO(dvp-wiring): bind `beneficiary` to the Arc-side {DvpEscrow} rather than paying the
     *      seller directly. The seller's claim then depends on a revealed preimage instead of on
     *      attester honesty, which removes the asymmetry above entirely. The escrow already exists;
     *      what is missing is the book emitting the lock parameters alongside the authorisation.
     *
     * @param authId The book's authorisation id. Single-use.
     * @param mandateId The mandate whose capital is paid out.
     * @param beneficiary The payee.
     * @param amount Units to pay.
     */
    function executePayout(bytes32 authId, uint256 mandateId, address beneficiary, uint128 amount) external;

    // -------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------

    /// @notice Capital held here for one mandate. The hard ceiling on that mandate's outflows.
    function balanceOf(uint256 mandateId) external view returns (uint128);

    /// @notice The address a release for this mandate will always pay, or zero if unregistered.
    function buyerOf(uint256 mandateId) external view returns (address);

    /// @notice Whether an authorisation has already been executed.
    function isConsumed(bytes32 authId) external view returns (bool);

    /// @notice The escrowed settlement currency (USDC on Arc).
    function settlementToken() external view returns (address);

    /// @notice The address permitted to relay the book's authorisations.
    function attester() external view returns (address);
}
