// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/**
 * @notice Minimal views onto the facets of a Hedera Asset Tokenization Studio security diamond.
 *
 * @dev SCOPE. Facture does not reimplement ATS and does not deploy it. Each receivable is issued by
 *      ATS's own `Factory.deployBond`, and the resulting security is a diamond carrying roughly
 *      ninety-four facets. The venue needs exactly three read-only answers out of that diamond, and
 *      declaring only those three is deliberate: a narrow surface is what keeps the venue decoupled
 *      from an ATS release it does not control.
 *
 *      SELECTOR STABILITY - read before deploying against a new ATS release. These signatures are
 *      transcribed from the ATS facets as understood at the time of writing, and they are NOT
 *      guaranteed to match the pinned release byte for byte. That risk is handled structurally
 *      rather than by hoping: {AtsComplianceGate} does not call through these interfaces, it issues
 *      raw `staticcall`s with the encoded selector and treats an empty return, a revert, or
 *      undecodable data as `COMPLIANCE_PROBE_FAILED`. A selector that has drifted therefore produces
 *      a named refusal and a failing test, never a silent `true` and never a reverted match.
 *
 *      These interfaces exist for documentation, for ABI generation, and so that
 *      `IAtsControlList.isAuthorized.selector` is written once rather than being hand-encoded at
 *      each call site.
 *
 *      WHY THESE FACETS AND NOT THE ERC-3643 IDENTITY REGISTRY - see {AtsComplianceGate}.
 */

/**
 * @title IAtsControlList
 * @notice The security's own allow/deny list, scoped to that one instrument.
 */
interface IAtsControlList {
    /**
     * @notice Whether `account` is permitted to hold this security.
     * @dev Resolves the list against its configured mode, so the caller does not need to know
     *      whether the instrument runs a whitelist or a blacklist. That is why this is the selector
     *      the gate probes rather than reading the raw membership set.
     * @param account The prospective holder.
     * @return True if the control list permits this account.
     */
    function isAuthorized(address account) external view returns (bool);

    /**
     * @notice Whether the control list operates as a whitelist (true) or a blacklist (false).
     * @dev Not used on the gate's hot path. Exposed because the distinction changes what a refusal
     *      means to a human: on a whitelist the buyer has simply not been added yet and can ask to
     *      be, whereas on a blacklist they have been affirmatively excluded.
     */
    function getControlListType() external view returns (bool);
}

/**
 * @title IAtsKyc
 * @notice The security's own KYC grants, scoped to that one instrument.
 */
interface IAtsKyc {
    /**
     * @notice Whether `account` holds a valid KYC grant on this security.
     * @param account The prospective holder.
     * @return True if a valid grant exists.
     */
    function getKycAccountStatus(address account) external view returns (bool);
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
    function isPaused() external view returns (bool);
}
