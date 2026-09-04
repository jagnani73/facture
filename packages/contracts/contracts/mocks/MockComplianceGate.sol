// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IComplianceGate} from "../interfaces/IComplianceGate.sol";
import {ReasonCodes} from "../libraries/ReasonCodes.sol";

/**
 * @title MockComplianceGate
 * @notice Test-only gate whose verdict is set directly.
 *
 * @dev Two jobs. First, it lets {MandateBook} tests reach the eligibility refusal without standing
 *      up an ATS mock. Second, and more importantly, `setRevertMode` makes it violate its own
 *      interface contract by reverting - which is exactly what `MandateBook._probeGate` claims to
 *      survive. The gate address on the book is owner-mutable, so the book must not trust a gate to
 *      honour the "never reverts" rule, and a mock that always behaves well cannot demonstrate that.
 */
contract MockComplianceGate is IComplianceGate {
    bool public ok = true;
    bytes32 public reason = ReasonCodes.NONE;
    bool public revertMode;

    function setVerdict(bool ok_, bytes32 reason_) external {
        ok = ok_;
        reason = reason_;
    }

    function setRevertMode(bool value) external {
        revertMode = value;
    }

    /// @inheritdoc IComplianceGate
    function canReceive(address, address) external view returns (bool, bytes32) {
        if (revertMode) revert("MockComplianceGate: gate reverted");
        return (ok, reason);
    }
}
