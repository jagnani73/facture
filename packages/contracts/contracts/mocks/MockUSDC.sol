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
    constructor() ERC20("Mock USD Coin", "USDC") {}

    /// @dev Overridden from the OZ default of 18.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Unrestricted mint. Test-only, obviously.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
