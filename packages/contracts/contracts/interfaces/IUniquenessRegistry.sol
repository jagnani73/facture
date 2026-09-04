// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/**
 * @title IUniquenessRegistry
 * @notice One receivable mints exactly one instrument, ever.
 *
 * @dev This is the venue's anti-double-pledge control. Selling the same receivable to three
 *      financiers is the specific fraud that factoring has always had, and it is roughly what broke
 *      Greensill. A registry does not make an invoice real - nothing on-chain can - but it makes it
 *      impossible to sell the same one twice on this venue.
 *
 *      The binding is APPEND-ONLY AND PERMANENT. There is deliberately no `release`, no `reassign`,
 *      no `transferClaim` and no admin override, not even one behind a timelock. That is not an
 *      oversight and not a v1 simplification to be relaxed later:
 *
 *        - A claim that can be released is not a uniqueness guarantee, it is a lock. A buyer
 *          diligencing an instrument needs to know the hash they are looking at can never point
 *          anywhere else, without also having to reason about who holds the release key and whether
 *          that key has been used. Mutability here would move the trust from "the registry" to "the
 *          registry operator", which is the exact trust the venue exists to remove.
 *        - The consequence is accepted honestly: a mis-typed claim burns that hash forever. Since
 *          the hash commits to (debtor, invoiceRef, faceValue), a genuine correction to any of those
 *          three fields is a different receivable and gets a different hash. The only truly
 *          unrecoverable case is claiming a correct hash against the wrong instrument address, which
 *          is why {claim} is permissioned - see {setIssuer}.
 *
 *      Deployment: one registry per venue, on the chain where the instruments live (Hedera). It is
 *      intended to outlive every other contract here, so it holds no funds, has no upgrade path and
 *      depends on nothing.
 */
interface IUniquenessRegistry {
    // -------------------------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------------------------

    /**
     * @notice A receivable has been permanently bound to an instrument.
     * @dev The receipt a buyer checks to confirm that the instrument they are being offered is the
     *      only one ever issued against that receivable. It can never be followed by a second
     *      `Claimed` carrying the same `uniquenessHash`.
     * @param uniquenessHash Commitment to (debtor, invoice reference, face value).
     * @param instrument The ATS security token deployed for this receivable.
     * @param claimant The authorised issuer that recorded the binding.
     */
    event Claimed(bytes32 indexed uniquenessHash, address indexed instrument, address indexed claimant);

    /**
     * @notice An address was granted or revoked the right to record claims.
     * @param issuer The address whose permission changed.
     * @param allowed True if it may now call {claim}.
     */
    event IssuerSet(address indexed issuer, bool allowed);

    /// @notice Ownership of the issuer allowlist moved.
    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);

    // -------------------------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------------------------

    /**
     * @notice The receivable has already been tokenised.
     * @dev The single most important refusal in the system. Carries the existing instrument so the
     *      caller can inspect what already exists rather than having to search the logs for it.
     * @param uniquenessHash The hash that is already bound.
     * @param existingInstrument The instrument it was bound to, and will always be bound to.
     */
    error AlreadyClaimed(bytes32 uniquenessHash, address existingInstrument);

    /// @notice `uniquenessHash` was zero. Rejected because zero is the "unclaimed" sentinel.
    error ZeroHash();

    /// @notice `instrument` was the zero address, which would make a binding indistinguishable from absent.
    error ZeroInstrument();

    /// @notice The caller is not an authorised issuer.
    error NotIssuer(address caller);

    /// @notice A zero address was supplied for the owner or for an issuer.
    error ZeroAddress();

    /// @notice The caller is not the owner of the issuer allowlist.
    error NotOwner(address caller);

    // -------------------------------------------------------------------------------------------
    // Claiming
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Permanently bind a receivable to the instrument issued against it.
     *
     * @dev Reverts with {AlreadyClaimed} if the hash is taken. Never overwrites. Callable only by an
     *      authorised issuer.
     *
     *      Call ordering matters: the instrument must be deployed before this is called, because the
     *      binding commits to its address. The issuance pipeline therefore runs `deployBond` then
     *      `claim`, and a `deployBond` whose `claim` reverts leaves an orphaned bond that must never
     *      be listed. The listing path enforces that by requiring a matching claim.
     *
     * @param uniquenessHash Commitment to (debtor, invoice reference, face value). See {computeHash}.
     * @param instrument Address of the ATS security token deployed for this receivable.
     */
    function claim(bytes32 uniquenessHash, address instrument) external;

    // -------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------

    /**
     * @notice The instrument bound to a receivable.
     * @param uniquenessHash The commitment to look up.
     * @return instrument The bound instrument, or `address(0)` if the receivable is unclaimed.
     */
    function instrumentOf(bytes32 uniquenessHash) external view returns (address instrument);

    /**
     * @notice Whether a receivable has already been tokenised.
     * @param uniquenessHash The commitment to look up.
     * @return claimed True once bound; can never return to false.
     */
    function isClaimed(bytes32 uniquenessHash) external view returns (bool claimed);

    /**
     * @notice The canonical uniqueness commitment for a receivable.
     *
     * @dev Kept on-chain, and `pure`, so every client derives the same hash from the same facts
     *      rather than each re-implementing the preimage layout. A client that computed this
     *      differently would silently fail to detect a duplicate, which is the one failure this
     *      contract exists to prevent.
     *
     *      The preimage is domain-separated by a constant tag so a hash from this registry can never
     *      collide with an unrelated `keccak256` commitment used elsewhere in the protocol.
     *
     *      `debtorId` is a `bytes32` venue identity rather than an `address` because debtors have no
     *      wallet. A debtor confirms an invoice through a link, with no wallet and no signup, so the
     *      venue never learns an address for them. {IMandateBook} makes the same choice for exposure
     *      limits, and for the same reason.
     *
     * @param debtorId Stable venue identity of the business that owes the money.
     * @param invoiceRef The seller's own invoice number, hashed or padded into 32 bytes.
     * @param faceValue Amount owed, in the settlement currency's smallest unit.
     * @return The uniqueness commitment.
     */
    function computeHash(bytes32 debtorId, bytes32 invoiceRef, uint256 faceValue) external pure returns (bytes32);

    // -------------------------------------------------------------------------------------------
    // Administration
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Grant or revoke the right to record claims.
     *
     * @dev {claim} is permissioned rather than open, and the reason is griefing rather than secrecy.
     *      A uniqueness hash commits only to facts an adversary can guess or observe - a debtor, an
     *      invoice number and a round amount. If anyone could claim, an attacker could front-run a
     *      genuine issuance, bind that hash to a worthless address, and permanently prevent that
     *      receivable from ever being tokenised. Because the registry is deliberately immutable,
     *      there would be no recovery. Permissioning the write is what makes permanence safe.
     *
     *      Note the asymmetry this creates and accepts: the issuer set can censor (refuse to record
     *      a claim) but can never forge or move an existing binding. Censorship is visible and
     *      recoverable by adding another issuer; a moved binding would be neither.
     *
     * @param issuer Address to grant or revoke.
     * @param allowed True to grant.
     */
    function setIssuer(address issuer, bool allowed) external;

    /// @notice Whether an address may record claims.
    function isIssuer(address account) external view returns (bool);

    /// @notice The owner of the issuer allowlist.
    function owner() external view returns (address);
}
