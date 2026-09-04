// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/**
 * @title ReasonCodes
 * @notice The canonical vocabulary of machine-readable refusal reasons emitted by the venue.
 *
 * @dev Why reason codes exist at all, and why they are not just revert strings:
 *
 *      A refusal is a *product output*, not a failed transaction. An AMM matches first and discovers
 *      the transfer was illegal afterwards, so non-compliance surfaces as a revert that nobody can
 *      read and nobody can prove happened. Here an ineligible counterparty is never matched, and the
 *      rejected party is told why in a form they can check without trusting the venue.
 *
 *      That requires the reason to survive in a log, which a revert cannot do: a reverted call
 *      discards its own events. Hence the split enforced across `IMandateBook`:
 *
 *        - `previewMatch`  - `view`, returns a reason code, changes nothing. Used by the UI to show
 *                            "three mandates would take this" and by keepers to pick a mandate.
 *        - `tryMatch`      - non-reverting, emits `MatchRefused(invoiceId, mandateId, reasonCode)`
 *                            and returns false. This is the product-facing path, because it leaves a
 *                            durable, independently checkable receipt of the refusal.
 *        - `matchInvoice`  - strict, reverts with a *typed custom error* carrying the offending
 *                            values. This is the integrator-facing path, where a caller wants the
 *                            transaction to fail loudly rather than to succeed having done nothing.
 *
 *      Every refusal therefore has exactly two representations that must stay in lockstep: one
 *      custom error and one reason code. `MandateBook._evaluate` is the single place that decides
 *      which, so the two can never diverge.
 *
 *      Codes are `bytes32` short strings rather than an enum so that an adapter (notably
 *      `AtsComplianceGate`, which surfaces refusals originating inside a third-party diamond) can
 *      introduce a code the venue did not compile in, without a redeploy and without colliding.
 *      They are human-readable under `bytes32ToString` and stable forever once emitted.
 */
library ReasonCodes {
    // --- no refusal -------------------------------------------------------------------------

    /// @notice Sentinel returned alongside `ok == true`. Never emitted in a `MatchRefused`.
    bytes32 internal constant NONE = bytes32(0);

    // --- book-side refusals (decided inside MandateBook) -------------------------------------

    /// @notice The mandate id has never been posted.
    bytes32 internal constant MANDATE_UNKNOWN = "MANDATE_UNKNOWN";

    /// @notice The mandate exists but is paused or closed, so it is not accepting new matches.
    bytes32 internal constant MANDATE_NOT_ACTIVE = "MANDATE_NOT_ACTIVE";

    /// @notice The invoice id has never been listed on the invoice registry.
    bytes32 internal constant INVOICE_UNKNOWN = "INVOICE_UNKNOWN";

    /// @notice The debtor has not yet acknowledged the invoice, so it is not quotable.
    bytes32 internal constant INVOICE_NOT_CONFIRMED = "INVOICE_NOT_CONFIRMED";

    /**
     * @notice The invoice already has a live or completed allocation.
     * @dev Distinct from `INVOICE_NOT_CONFIRMED` on purpose. Both mean "not available", but they are
     *      opposite situations for whoever reads the refusal: an unconfirmed invoice needs the
     *      debtor to act, whereas an allocated one has already been sold and no action will change
     *      that. Collapsing the two would make the refusal actively misleading.
     */
    bytes32 internal constant INVOICE_ALREADY_ALLOCATED = "INVOICE_ALREADY_ALLOCATED";

    /// @notice The debtor's earned rating sits below the mandate's floor.
    bytes32 internal constant RATING_BELOW_FLOOR = "RATING_BELOW_FLOOR";

    /// @notice Days to maturity exceed the mandate's ceiling.
    bytes32 internal constant TENOR_ABOVE_CEILING = "TENOR_ABOVE_CEILING";

    /// @notice The invoice has already matured; there is no tenor left to price.
    bytes32 internal constant INVOICE_MATURED = "INVOICE_MATURED";

    /// @notice The mandate's unallocated balance is smaller than the purchase price.
    /// @dev This is the refusal that makes a standing quote firm rather than indicative.
    bytes32 internal constant INSUFFICIENT_UNALLOCATED = "INSUFFICIENT_UNALLOCATED";

    /// @notice Taking this invoice would push the mandate's exposure to one debtor past its cap.
    bytes32 internal constant DEBTOR_LIMIT_EXCEEDED = "DEBTOR_LIMIT_EXCEEDED";

    // --- gate-side refusals (decided inside a compliance gate) -------------------------------

    /// @notice The buyer has no valid KYC grant on this security's own `Kyc` facet.
    bytes32 internal constant KYC_NOT_GRANTED = "KYC_NOT_GRANTED";

    /// @notice The security's own `ControlList` refuses this buyer (blacklisted, or not whitelisted).
    bytes32 internal constant CONTROL_LIST_BLOCKED = "CONTROL_LIST_BLOCKED";

    /// @notice The instrument is paused, so no transfer to anyone would succeed right now.
    bytes32 internal constant INSTRUMENT_PAUSED = "INSTRUMENT_PAUSED";

    /**
     * @notice The gate could not obtain an answer from the instrument.
     * @dev Emitted when a `staticcall` into the security's diamond reverts, runs out of the probe's
     *      gas, or returns undecodable data - typically a facet that is absent or whose selector has
     *      drifted between ATS releases. Deliberately *not* a revert: an unreachable instrument is a
     *      refusal with a name, so the buyer learns the venue could not verify them rather than
     *      seeing an opaque failed transaction. Fails closed - a probe that cannot answer never
     *      returns `ok == true`.
     */
    bytes32 internal constant COMPLIANCE_PROBE_FAILED = "COMPLIANCE_PROBE_FAILED";

    /// @notice No compliance gate is configured for this instrument's chain or issuer.
    bytes32 internal constant NO_GATE_CONFIGURED = "NO_GATE_CONFIGURED";

    // --- settlement-side refusals -------------------------------------------------------------

    /// @notice The cross-chain settlement window elapsed without both legs completing.
    bytes32 internal constant SETTLEMENT_TIMEOUT = "SETTLEMENT_TIMEOUT";

    /**
     * @notice Renders a reason code as a human-readable string.
     * @dev Convenience for off-chain decoding and for tests; not used on any hot path.
     * @param code The short-string reason code.
     * @return The code with its zero padding stripped.
     */
    function toString(bytes32 code) internal pure returns (string memory) {
        uint256 length = 0;
        while (length < 32 && code[length] != 0) {
            unchecked {
                ++length;
            }
        }
        bytes memory out = new bytes(length);
        for (uint256 i = 0; i < length;) {
            out[i] = code[i];
            unchecked {
                ++i;
            }
        }
        return string(out);
    }
}
