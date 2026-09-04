// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/**
 * @title IComplianceGate
 * @notice Asks an instrument whether a prospective buyer is allowed to hold it, BEFORE matching.
 *
 * @dev The ordering is the entire argument. An AMM matches first and discovers the transfer is
 *      illegal afterwards, so a non-compliant trade surfaces as a reverted transaction: no receipt,
 *      no reason, and gas burned by the party who did nothing wrong. Here an ineligible counterparty
 *      is never matched in the first place, and the refusal is a first-class output that the
 *      rejected party can check without trusting the venue.
 *
 *      That is only possible if eligibility is a QUESTION rather than an ATTEMPT, which is why the
 *      function below is `view` and returns a reason instead of reverting. A gate that reverted
 *      would be unusable from `previewMatch`, and the UI could not say "three mandates would take
 *      this" without simulating three failing transactions.
 *
 *      This interface is deliberately chain-agnostic; its implementations are not.
 *      {AtsComplianceGate} answers by making direct `staticcall`s into the security's own diamond,
 *      so it must be deployed on the same chain as the instrument. A venue whose book sits on a
 *      different chain from its paper needs a different implementation behind this same interface,
 *      one backed by a relayed attestation, and that implementation has strictly weaker guarantees
 *      because an attestation can be stale in a way a same-chain `staticcall` cannot. Keeping the
 *      interface this narrow is what makes that substitution explicit rather than accidental. See
 *      the header of {MandateBook} for which deployment topology v1 assumes, and why.
 *
 *      Implementations MUST fail closed: any inability to obtain an answer returns `ok == false`
 *      with a reason code, never `ok == true`.
 */
interface IComplianceGate {
    /**
     * @notice May `buyer` receive `instrument`?
     *
     * @dev Never reverts. An instrument that cannot be reached, a facet that is missing, and a buyer
     *      who is genuinely barred are all reported the same way - as a refusal with a name - because
     *      from the product's point of view they are the same event: the venue could not establish
     *      that this trade would be legal, so it will not match it.
     *
     * @param instrument The ATS security token the buyer would receive.
     * @param buyer The prospective holder.
     * @return ok True only if the instrument affirmatively permits this buyer to hold it.
     * @return reasonCode `ReasonCodes.NONE` when `ok` is true, otherwise the specific refusal. See
     *         {ReasonCodes} for the vocabulary.
     */
    function canReceive(address instrument, address buyer) external view returns (bool ok, bytes32 reasonCode);
}
