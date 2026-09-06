// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/**
 * @notice Minimal views onto the facets of a Hedera Asset Tokenization Studio security diamond.
 *
 * @dev SCOPE. Facture does not reimplement ATS and does not deploy it. Each receivable is issued by
 *      ATS's own `Factory.deployBond`, and the resulting security is a diamond carrying roughly
 *      ninety-four facets. The venue needs exactly four read-only answers out of that diamond, and
 *      declaring only those four is deliberate: a narrow surface is what keeps the venue decoupled
 *      from an ATS release it does not control.
 *
 *      ---------------------------------------------------------------------------------------
 *      THESE SIGNATURES WERE WRONG UNTIL 2026-09-06, AND THE CORRECTION IS THE POINT
 *      ---------------------------------------------------------------------------------------
 *
 *      This file previously declared `isAuthorized(address)`, `getKycAccountStatus(address)` and
 *      `isPaused()`. **None of those three functions exists on a deployed ATS diamond.** Each
 *      reverts with `FunctionNotFound(bytes4)` (`0x5416eb98`). They were transcribed from
 *      documentation and never checked against a security.
 *
 *      Proven against MF-2051, `0xb50567e02baaf768c834b0663f539db43d5b34b0`, on Hedera testnet:
 *
 *        isPaused()                  -> revert          paused()                  -> false
 *        isAuthorized(buyer)         -> revert          isInControlList(buyer)    -> true
 *        getKycAccountStatus(buyer)  -> revert          getKycStatusFor(buyer)    -> 1 (GRANTED)
 *                                                      getControlListType()      -> true (allowlist)
 *
 *      The consequence was not a compile error and not a revert. {AtsComplianceGate} fails closed
 *      by design, so three missing selectors collapsed into `COMPLIANCE_PROBE_FAILED` and the
 *      deployed gate refused **every buyer on every instrument** — including buyers the instrument
 *      affirmatively permits. It looked healthy because nothing called it, and the unit tests
 *      passed because {MockAtsSecurity} implemented the same wrong selectors. A mock built from the
 *      same misreading as the code under test cannot detect the misreading.
 *
 *      The venue's own off-chain reader, `packages/backend/src/services/compliance.ts`, had already
 *      been corrected against a live instrument months of commits earlier. The two halves of one
 *      fact were maintained separately and drifted, which is the split-vocabulary failure CLAUDE.md
 *      names elsewhere, in its most expensive form: the on-chain half was the one a third party
 *      would check.
 *
 *      SELECTOR STABILITY. The signatures below are now read off live paper rather than off docs,
 *      but ATS remains a third-party dependency on its own release cadence. The risk is handled
 *      structurally: {AtsComplianceGate} does not call through these interfaces, it issues raw
 *      `staticcall`s and treats an empty return, a revert, or undecodable data as
 *      `COMPLIANCE_PROBE_FAILED`. A selector that drifts therefore produces a named refusal and a
 *      failing test, never a silent `true` and never a reverted match. What that structure does NOT
 *      do — and this file is the proof — is tell you the selector was wrong in the first place.
 *      Only a call against a real instrument does that.
 *
 *      WHY THESE FACETS AND NOT THE ERC-3643 IDENTITY REGISTRY - see {AtsComplianceGate}.
 */

/**
 * @title IAtsControlList
 * @notice The security's own allow/deny list, scoped to that one instrument.
 *
 * @dev Two calls, not one, and the second is meaningless without the first. ATS has no
 *      `isAuthorized` that resolves the list's mode internally — that function was this file's
 *      original guess and does not exist. Membership is raw: the same `true` from
 *      `isInControlList` means "permitted" on an allowlist and "excluded" on a blocklist. Reading
 *      only membership admits exactly the party a blocklist was configured to keep out.
 */
interface IAtsControlList {
    /**
     * @notice Whether `account` appears in this security's control list.
     * @dev Raw membership. It does not decide eligibility on its own — pair it with
     *      {getControlListType}.
     * @param account The prospective holder.
     * @return True if the account is in the list, whatever the list means.
     */
    function isInControlList(address account) external view returns (bool);

    /**
     * @notice Whether the control list operates as an allowlist (true) or a blocklist (false).
     * @dev On the gate's hot path, and load-bearing: it is what turns membership into permission.
     *      It also changes what a refusal means to a human — on an allowlist the buyer has simply
     *      not been added yet and can ask to be, whereas on a blocklist they have been
     *      affirmatively excluded.
     */
    function getControlListType() external view returns (bool);
}

/**
 * @title IAtsKyc
 * @notice The security's own KYC grants, scoped to that one instrument.
 */
interface IAtsKyc {
    /**
     * @notice This security's KYC status for `account`.
     * @dev Returns `KycStatus`, an ENUM, not a bool: `0` NOT_GRANTED, `1` GRANTED. A caller that
     *      treats any non-zero word as a grant would admit every status ATS adds after this was
     *      written, so the gate compares against `1` exactly.
     * @param account The prospective holder.
     * @return The raw enum value.
     */
    function getKycStatusFor(address account) external view returns (uint8);
}

/**
 * @title IAtsPause
 * @notice Global transfer pause on the security.
 */
interface IAtsPause {
    /**
     * @notice Whether all transfers of this security are currently halted.
     * @dev Checked by the gate because a paused instrument would refuse the delivery leg at
     *      settlement regardless of who the buyer is. Catching it pre-trade turns a failed
     *      settlement into a named refusal, which is the ordering the venue promises.
     */
    function paused() external view returns (bool);
}
