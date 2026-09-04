// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDC
 * @notice Test-only stand-in for the settlement currency.
 * @dev Six decimals, matching USDC on both Arc and Hedera. That matters for the pricing tests: the
 *      whole point of the `uint128` money width and of the rounding direction in
 *      {MandateBook-previewPrice} is calibrated to six decimals, so testing against an 18-decimal
 *      token would silently exercise different arithmetic than production.
 *
 *      Not deployed to any network. Present only so the book's escrow paths can be tested without a
 *      live token.
 */
contract MockUSDC is ERC20 {
    /**
     * @notice When true, the two reads a holder probe depends on revert.
     *
     * @dev Doubles as the stand-in for an instrument's ERC-20 facade, which is how the venue reaches
     *      an ATS security token on Hedera. {MandateBook-confirmMaturity} asks an instrument who
     *      holds it and must produce a NAMED refusal rather than an opaque revert when the answer
     *      cannot be had - a facet whose selector drifted between ATS releases, a diamond that is
     *      paused, an address with no code. A mock that always answers cannot demonstrate that, in
     *      exactly the way {MockComplianceGate-setRevertMode} exists for the gate.
     *
     *      Transfers keep working while this is set, so a test can settle a trade and only then make
     *      the instrument unanswerable.
     */
    bool public probeBroken;

    constructor() ERC20("Mock USD Coin", "USDC") {}

    function setProbeBroken(bool value) external {
        probeBroken = value;
    }

    /// @dev Overridden from the OZ default of 18.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Unrestricted mint. Test-only, obviously.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function totalSupply() public view override returns (uint256) {
        if (probeBroken) revert("MockUSDC: probe unavailable");
        return super.totalSupply();
    }

    function balanceOf(address account) public view override returns (uint256) {
        if (probeBroken) revert("MockUSDC: probe unavailable");
        return super.balanceOf(account);
    }
}
