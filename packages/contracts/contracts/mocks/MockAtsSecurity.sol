// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/**
 * @title MockAtsSecurity
 * @notice Test-only stand-in for an ATS security diamond's compliance facets.
 *
 * @dev Implements exactly the four selectors {AtsComplianceGate} probes, and nothing else. It can
 *      also be told to misbehave, which is the more interesting half: the gate's entire design
 *      rests on the claim that a facet which reverts, returns nothing, or returns garbage produces a
 *      NAMED REFUSAL rather than a revert, and that claim is untestable against a well-behaved mock.
 *
 *      `setRevertMode` makes every probe revert. `setGarbageMode` makes them return a word that is
 *      neither 0 nor 1, which is specifically what would break an `abi.decode(..., (bool))` and is
 *      the reason the gate reads a word and compares.
 *
 *      ---------------------------------------------------------------------------------------
 *      THIS MOCK WAS THE REASON THE BUG SURVIVED
 *      ---------------------------------------------------------------------------------------
 *
 *      It previously implemented `isPaused()`, `isAuthorized(address)` and
 *      `getKycAccountStatus(address)` - the three selectors the gate probed, none of which exists
 *      on a real ATS diamond. Every test passed, because the mock had been built from the same
 *      misreading as the code under test. A fake that agrees with the code cannot contradict it.
 *
 *      What the selectors actually are, and how that was established, is in {IAtsFacets}. The
 *      structural lesson is narrower than "test against the real thing": a mock is only evidence
 *      about behaviour the mock did not choose. Selector names are not that.
 *
 *      Two capabilities are new here and exist because the corrected gate has decisions the old one
 *      did not. `setAllowList(false)` models a BLOCKLIST instrument, where membership means the
 *      opposite thing - the gate has to invert, and nothing could test that while the mock hard-coded
 *      `getControlListType()` to `true`. `setKycStatus` writes the raw enum, so a status outside
 *      `{NOT_GRANTED, GRANTED}` can be handed to a gate that must refuse it rather than read any
 *      non-zero word as a grant.
 */
contract MockAtsSecurity {
    /// @dev Storage is named apart from the selectors so that every probe routes through
    ///      `_answerWord` and can misbehave. A public `bool paused` would auto-generate a
    ///      `paused()` getter that ignores revert, garbage and gas-burn mode entirely.
    bool public pausedState;

    /// @dev Raw membership. Means "permitted" or "excluded" depending on `allowList`.
    bool public inControlList;

    /// @dev True = the control list is an allowlist; false = a blocklist.
    bool public allowList = true;

    /// @dev `IKyc.KycStatus` as a raw enum value: 0 NOT_GRANTED, 1 GRANTED.
    uint8 public kycStatus;

    /// @dev When true, every probe reverts.
    bool public revertMode;

    /// @dev When true, every probe returns a word that is neither 0 nor 1.
    bool public garbageMode;

    /// @dev When true, every probe consumes far more gas than the gate's probe cap.
    bool public gasBurnMode;

    constructor(bool inControlList_, bool kycGranted_, bool paused_) {
        inControlList = inControlList_;
        kycStatus = kycGranted_ ? 1 : 0;
        pausedState = paused_;
    }

    function setInControlList(bool value) external {
        inControlList = value;
    }

    /// @param value True for an allowlist, false for a blocklist.
    function setAllowList(bool value) external {
        allowList = value;
    }

    function setKyc(bool value) external {
        kycStatus = value ? 1 : 0;
    }

    /// @dev Writes the enum directly, including values outside the vocabulary the venue knows.
    function setKycStatus(uint8 value) external {
        kycStatus = value;
    }

    function setPaused(bool value) external {
        pausedState = value;
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
    //
    // These four, spelled exactly this way, are what a deployed ATS diamond answers. See
    // {IAtsFacets} for the proof and for the three that do not exist.

    function paused() external view returns (bool) {
        return _answerWord(pausedState ? 1 : 0) != 0;
    }

    function getControlListType() external view returns (bool) {
        return _answerWord(allowList ? 1 : 0) != 0;
    }

    function isInControlList(address) external view returns (bool) {
        return _answerWord(inControlList ? 1 : 0) != 0;
    }

    function getKycStatusFor(address) external view returns (uint8) {
        return uint8(_answerWord(kycStatus));
    }

    // --- misbehaviour ------------------------------------------------------------------------

    function _answerWord(uint256 value) private view returns (uint256) {
        if (revertMode) revert("MockAtsSecurity: probe reverted");

        if (gasBurnMode) {
            // Burn well past the gate's PROBE_GAS cap so the staticcall runs out of its allowance
            // while the caller retains enough gas to continue - which is the situation the cap
            // exists to survive.
            uint256 acc;
            for (uint256 i = 0; i < 10_000; ++i) {
                acc = uint256(keccak256(abi.encode(acc, i)));
            }
            if (acc == 0) return 0;
        }

        if (garbageMode) {
            // Return 0x02: a word that is neither false nor true. `abi.decode(_, (bool))` reverts on
            // this; the gate's word-compare survives it. The test asserts the gate does not revert,
            // which is the property that matters.
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

/**
 * @title MockControlListModeless
 * @notice A security that answers membership but not the list's MODE.
 *
 * @dev Deliberately omits `getControlListType()` while implementing everything else, which is the
 *      one shape {MockAtsSecurity} cannot express: its misbehaviour modes are all-or-nothing.
 *
 *      It stands for a real hazard rather than a contrived one. ATS is versioned independently, the
 *      control-list facets are separable, and a diamond can perfectly well carry a membership set
 *      whose mode getter this venue cannot reach. What must not happen then is the gate reading the
 *      membership bit and guessing a mode - because guessing "allowlist" refuses a permitted buyer,
 *      guessing "blocklist" admits an excluded one, and the second is a trade that should never
 *      have been struck.
 */
contract MockControlListModeless {
    bool public immutable IN_LIST;
    uint8 public immutable KYC_STATUS;

    constructor(bool inList_, bool kycGranted_) {
        IN_LIST = inList_;
        KYC_STATUS = kycGranted_ ? 1 : 0;
    }

    function paused() external pure returns (bool) {
        return false;
    }

    function isInControlList(address) external view returns (bool) {
        return IN_LIST;
    }

    function getKycStatusFor(address) external view returns (uint8) {
        return KYC_STATUS;
    }

    // getControlListType() is absent on purpose. Do not add it.
}
