// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/**
 * @title MockAtsSecurity
 * @notice Test-only stand-in for an ATS security diamond's compliance facets.
 *
 * @dev Implements exactly the three selectors {AtsComplianceGate} probes, and nothing else. It can
 *      also be told to misbehave, which is the more interesting half: the gate's entire design
 *      rests on the claim that a facet which reverts, returns nothing, or returns garbage produces a
 *      NAMED REFUSAL rather than a revert, and that claim is untestable against a well-behaved mock.
 *
 *      `setRevertMode` makes every probe revert. `setGarbageMode` makes them return a word that is
 *      neither 0 nor 1, which is specifically what would break an `abi.decode(..., (bool))` and is
 *      the reason the gate decodes as a word and compares.
 */
contract MockAtsSecurity {
    bool public paused;
    bool public authorized;
    bool public kycGranted;

    /// @dev When true, every probe reverts.
    bool public revertMode;

    /// @dev When true, every probe returns a word that is neither 0 nor 1.
    bool public garbageMode;

    /// @dev When true, every probe consumes far more gas than the gate's probe cap.
    bool public gasBurnMode;

    constructor(bool authorized_, bool kycGranted_, bool paused_) {
        authorized = authorized_;
        kycGranted = kycGranted_;
        paused = paused_;
    }

    function setAuthorized(bool value) external {
        authorized = value;
    }

    function setKyc(bool value) external {
        kycGranted = value;
    }

    function setPaused(bool value) external {
        paused = value;
    }

    function setRevertMode(bool value) external {
        revertMode = value;
    }

    function setGarbageMode(bool value) external {
        garbageMode = value;
    }

    function setGasBurnMode(bool value) external {
        gasBurnMode = value;
    }

    // --- probed selectors --------------------------------------------------------------------

    function isPaused() external view returns (bool) {
        return _answer(paused);
    }

    function isAuthorized(address) external view returns (bool) {
        return _answer(authorized);
    }

    function getKycAccountStatus(address) external view returns (bool) {
        return _answer(kycGranted);
    }

    function getControlListType() external pure returns (bool) {
        return true; // whitelist
    }

    // --- misbehaviour ------------------------------------------------------------------------

    function _answer(bool value) private view returns (bool result) {
        if (revertMode) revert("MockAtsSecurity: probe reverted");

        if (gasBurnMode) {
            // Burn well past the gate's PROBE_GAS cap so the staticcall runs out of its allowance
            // while the caller retains enough gas to continue - which is the situation the cap
            // exists to survive.
            uint256 acc;
            for (uint256 i = 0; i < 10_000; ++i) {
                acc = uint256(keccak256(abi.encode(acc, i)));
            }
            if (acc == 0) return false;
        }

        if (garbageMode) {
            // Return 0x02: a word that is neither false nor true. `abi.decode(_, (bool))` reverts on
            // this; the gate's word-compare treats it as truthy. The test asserts the gate does not
            // revert, which is the property that matters.
            //
            // Deliberately not annotated `memory-safe`: this returns straight out of the call rather
            // than handing control back to the compiler's memory model.
            assembly {
                mstore(0x00, 2)
                return(0x00, 0x20)
            }
        }

        return value;
    }
}
