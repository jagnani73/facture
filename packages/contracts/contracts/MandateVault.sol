// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IMandateVault} from "./interfaces/IMandateVault.sol";

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
 *      Three enforced bounds on a compromised attester, in decreasing order of strength:
 *
 *        1. `_balanceOf` is per mandate and every outflow is checked against it, so no authorisation
 *           can reach another mandate's capital. This is arithmetic, not policy.
 *        2. {executeRelease} pays `_buyerOf[mandateId]` and takes no recipient argument, so a forged
 *           release can only return a buyer's money to that buyer.
 *        3. `_consumed` makes every authorisation single-use. Because the book derives ids from its
 *           own chain id and address, an authorisation cannot be replayed here, against a second
 *           vault, or against a redeployment.
 *
 *      What remains: {executePayout} takes a beneficiary, because the seller differs per trade. That
 *      is the residual trust, it is bounded by (1), and the fix is the DvP wiring noted on the
 *      interface.
 */
contract MandateVault is IMandateVault, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Domain separator for deposit references. Versioned; see {UniquenessRegistry-DOMAIN}.
    bytes32 public constant DEPOSIT_DOMAIN = keccak256("facture.vault.deposit.v1");

    /// @dev Immutable: the escrowed asset cannot change without orphaning every balance below.
    IERC20 private immutable _settlementToken;

    /// @dev Per-mandate custody. The hard ceiling on every outflow.
    mapping(uint256 mandateId => uint128 balance) private _balanceOf;

    /// @dev One-shot binding of a mandate to the only address a release may pay.
    mapping(uint256 mandateId => address buyer) private _buyerOf;

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
     * @param initialAttester The address permitted to relay the book's authorisations.
     * @param initialOwner Curator of the attester role. Holds no spending power of its own.
     */
    constructor(IERC20 settlementToken_, address initialAttester, address initialOwner) {
        if (address(settlementToken_) == address(0) || initialAttester == address(0) || initialOwner == address(0)) {
            revert ZeroAddress();
        }
        _settlementToken = settlementToken_;
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
        uint256 mandateId,
        address beneficiary,
        uint128 amount
    ) external onlyAttester nonReentrant {
        if (beneficiary == address(0)) revert ZeroAddress();

        uint128 amountOut = _consumeAuthorisation(authId, mandateId, amount);

        _settlementToken.safeTransfer(beneficiary, amountOut);

        emit PayoutExecuted(authId, mandateId, beneficiary, amountOut);
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
