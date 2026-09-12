// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IPartyRegistry} from "./interfaces/IPartyRegistry.sol";

/**
 * @title PartyRegistry
 * @notice What each address on this venue says about itself, signed by that address.
 *
 * @dev The full rationale is on {IPartyRegistry}. Four things govern every line below:
 *
 *        1. **A record can only ever be written by the key it describes.** Either the party sends
 *           the transaction, or the party signed an EIP-712 message that somebody else relays.
 *           There is no owner, no admin, no permissioned writer and no way for this venue to fill
 *           in a profile on anyone's behalf - which is the entire difference between this and
 *           `MandateBook` recording `buyer = msg.sender` on every bid it posts.
 *        2. **Nothing here is a permission.** `hasRole` answers what a party claims about itself.
 *           Eligibility to hold paper is still `ControlList` and `Kyc` on each instrument, and
 *           every capability is still checked by whatever contract grants it.
 *        3. **The nonce is consumed by both write paths.** A signature is single-use and an old
 *           description can never be replayed over a newer one.
 *        4. **Strings are capped.** Storage here is writable by anyone who can sign, and the cost
 *           of an unbounded string falls on whoever relays it.
 *
 *      This contract holds no funds, has no `receive`, and its only dependencies are OpenZeppelin's
 *      EIP-712 and ECDSA helpers. There is no upgrade path and none is wanted: a profile is
 *      editable in place, so nothing here needs to be migrated to be corrected.
 */
contract PartyRegistry is IPartyRegistry, EIP712 {
    // -------------------------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------------------------

    /// @notice The party sells receivables on this venue.
    uint8 public constant ROLE_SELLER = 1;

    /// @notice The party funds mandates on this venue.
    uint8 public constant ROLE_BUYER = 2;

    /**
     * @notice Every role bit this version defines.
     * @dev An unknown bit is refused rather than ignored. A profile carrying a role this deployment
     *      does not understand would render as something weaker than the party meant, and silently
     *      narrowing what somebody said about themselves is worse than refusing to record it.
     */
    uint8 public constant ROLE_MASK = ROLE_SELLER | ROLE_BUYER;

    /// @notice Cap on {IPartyRegistry-ProfileUpdate-displayName}, in bytes rather than characters.
    uint256 public constant MAX_DISPLAY_NAME_BYTES = 64;

    /// @notice Cap on {IPartyRegistry-ProfileUpdate-legalName}, in bytes.
    uint256 public constant MAX_LEGAL_NAME_BYTES = 128;

    /// @notice Cap on {IPartyRegistry-ProfileUpdate-websiteUri}, in bytes.
    uint256 public constant MAX_WEBSITE_BYTES = 128;

    /**
     * @notice EIP-712 type hash for {IPartyRegistry-ProfileUpdate}.
     * @dev Written out as a literal string rather than assembled, so that the field order this
     *      contract verifies against is readable in one place and diffable in review. It is pinned
     *      by a test, because a reordering here is invisible at compile time and invalidates every
     *      signature any client has ever produced.
     */
    bytes32 public constant PROFILE_UPDATE_TYPEHASH = keccak256(
        "ProfileUpdate(address party,uint8 roles,string displayName,string legalName,bytes2 country,string websiteUri,bytes32 metadataHash,uint64 nonce,uint64 deadline)"
    );

    // -------------------------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------------------------

    /**
     * @dev The only storage this contract declares. NOT slot 0 - OpenZeppelin's {EIP712} declares
     *      `_nameFallback` and `_versionFallback` before it, and inherited storage is laid out
     *      first, so this mapping begins at slot 2. Said plainly because the earlier version of
     *      this comment claimed slot 0, and anyone computing a mapping key for `eth_getStorageAt`
     *      off it would have read the wrong slot and found nothing.
     *
     *      `updatedAt == 0` is the "never written" sentinel, which is why
     *      {_write} always stamps a non-zero timestamp and why {nonceOf} reads it rather than
     *      keeping a second mapping that could disagree with it.
     */
    mapping(address party => Profile profile) private _profiles;

    // -------------------------------------------------------------------------------------------
    // Construction
    // -------------------------------------------------------------------------------------------

    /**
     * @dev The EIP-712 domain fixes the name, the version, `block.chainid` and this address. Two of
     *      those matter operationally: a signature produced for a registry on another chain, or for
     *      a superseded deployment of this one, does not verify here. That is the property that
     *      lets a wallet policy scope signing to `verifyingContract` and `chainId` and have the
     *      scope mean something.
     *
     *      Bumping the version string invalidates every signature in flight, so it is reserved for
     *      a change to {IPartyRegistry-ProfileUpdate} itself.
     */
    constructor() EIP712("Facture Party Registry", "1") {}

    // -------------------------------------------------------------------------------------------
    // Writing
    // -------------------------------------------------------------------------------------------

    /// @inheritdoc IPartyRegistry
    function updateProfile(ProfileUpdate calldata update) external {
        if (msg.sender != update.party) revert NotParty(msg.sender, update.party);
        _write(update, msg.sender);
    }

    /// @inheritdoc IPartyRegistry
    function updateProfileFor(ProfileUpdate calldata update, bytes calldata signature) external {
        bytes32 digest = hashUpdate(update);

        // `tryRecover` rather than `recover` so that a malformed signature produces this contract's
        // own named refusal carrying what it recovered, instead of an OpenZeppelin error that says
        // nothing about which party the caller was trying to write.
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || recovered != update.party) {
            revert BadSignature(update.party, recovered);
        }

        _write(update, msg.sender);
    }

    /**
     * @dev Validate, consume the nonce, store, emit. Shared by both entry points so that the two
     *      cannot drift apart - in particular so that a self-sent write consumes a nonce exactly as
     *      a relayed one does, which is what stops the two paths being used to replay each other.
     * @param update The record to write. Already authenticated by the caller.
     * @param relayer Who paid. Emitted, and carrying no authority.
     */
    function _write(ProfileUpdate calldata update, address relayer) private {
        if (update.party == address(0)) revert ZeroParty();

        if (update.deadline < block.timestamp) {
            revert SignatureExpired(update.deadline, uint64(block.timestamp));
        }

        if (update.roles == 0 || update.roles & ~ROLE_MASK != 0) revert InvalidRoles(update.roles);

        uint256 nameLength = bytes(update.displayName).length;
        if (nameLength == 0) revert EmptyDisplayName();
        if (nameLength > MAX_DISPLAY_NAME_BYTES) {
            revert StringTooLong("displayName", nameLength, MAX_DISPLAY_NAME_BYTES);
        }

        uint256 legalLength = bytes(update.legalName).length;
        if (legalLength > MAX_LEGAL_NAME_BYTES) {
            revert StringTooLong("legalName", legalLength, MAX_LEGAL_NAME_BYTES);
        }

        uint256 websiteLength = bytes(update.websiteUri).length;
        if (websiteLength > MAX_WEBSITE_BYTES) {
            revert StringTooLong("websiteUri", websiteLength, MAX_WEBSITE_BYTES);
        }

        _requireValidCountry(update.country);

        uint64 expected = nonceOf(update.party);
        if (update.nonce != expected) revert WrongNonce(update.party, update.nonce, expected);

        _profiles[update.party] = Profile({
            roles: update.roles,
            country: update.country,
            // Non-zero by construction on any live chain, and the sentinel {nonceOf} and
            // {hasProfile} both read. A chain whose timestamp is genuinely zero has bigger problems.
            updatedAt: uint64(block.timestamp),
            nonce: update.nonce,
            metadataHash: update.metadataHash,
            displayName: update.displayName,
            legalName: update.legalName,
            websiteUri: update.websiteUri
        });

        emit ProfileUpdated(update.party, update.nonce, update.roles, hashUpdate(update), relayer);
    }

    /**
     * @dev `0x0000` means the party did not state a country. Anything else must be two uppercase
     *      ASCII letters, because the field is documented as ISO 3166-1 alpha-2 and a reader
     *      comparing it against a jurisdiction list needs one spelling rather than three. Case is
     *      not normalised here: silently rewriting what somebody signed would make the stored record
     *      differ from the message they authorised.
     */
    function _requireValidCountry(bytes2 country) private pure {
        if (country == bytes2(0)) return;

        uint8 first = uint8(country[0]);
        uint8 second = uint8(country[1]);
        bool ok = first >= 0x41 && first <= 0x5A && second >= 0x41 && second <= 0x5A;
        if (!ok) revert InvalidCountry(country);
    }

    // -------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------

    /// @inheritdoc IPartyRegistry
    function profileOf(address party) external view returns (Profile memory) {
        return _profiles[party];
    }

    /// @inheritdoc IPartyRegistry
    function hasProfile(address party) external view returns (bool) {
        return _profiles[party].updatedAt != 0;
    }

    /**
     * @inheritdoc IPartyRegistry
     * @dev Derived from the record rather than held in a second mapping. One storage slot cannot
     *      disagree with itself, and a nonce counter that drifted from the profile it guards would
     *      make a signature unverifiable with nothing on chain explaining why.
     */
    function nonceOf(address party) public view returns (uint64) {
        Profile storage profile = _profiles[party];
        return profile.updatedAt == 0 ? 0 : profile.nonce + 1;
    }

    /// @inheritdoc IPartyRegistry
    function hasRole(address party, uint8 role) external view returns (bool) {
        if (role == 0) return false;
        return _profiles[party].roles & role == role;
    }

    /// @inheritdoc IPartyRegistry
    function hashUpdate(ProfileUpdate calldata update) public view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(
                    abi.encode(
                        PROFILE_UPDATE_TYPEHASH,
                        update.party,
                        update.roles,
                        keccak256(bytes(update.displayName)),
                        keccak256(bytes(update.legalName)),
                        update.country,
                        keccak256(bytes(update.websiteUri)),
                        update.metadataHash,
                        update.nonce,
                        update.deadline
                    )
                )
            );
    }
}
