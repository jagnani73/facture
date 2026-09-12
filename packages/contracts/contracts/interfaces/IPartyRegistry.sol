// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/**
 * @title IPartyRegistry
 * @notice What each address on this venue says about itself, signed by that address.
 *
 * @dev Every other registry here records a fact about *paper*: a receivable is bound to one
 *      instrument, a debtor confirmed an invoice, a mandate will take a match. Nothing records a
 *      fact about a *party*, and the gap shows up wherever a human reads the product. The venue's
 *      own screens call a seller "Your business" and a funder "Your desk"; a settled trade's public
 *      proof names no seller and no buyer; and {IMandateBook} records `buyer = msg.sender`, which is
 *      the venue, on every standing bid it posts. A market whose parties are anonymous to everyone
 *      including themselves is what this contract exists to end.
 *
 *      ## The promise, and its exact limits
 *
 *      A record here means: **the key controlling this address signed this description of itself, at
 *      this nonce.** That is the whole claim, and reading more into it is a mistake this codebase
 *      has made in other places and paid for.
 *
 *      In particular it is none of the following, and cannot be made to mean them:
 *
 *        - Not a name registry. Display names are not unique and nothing here arbitrates them. Two
 *          addresses may both call themselves "Meridian Fabrication" and both records are equally
 *          valid statements about what their signers claim. Which address the venue actually deals
 *          with is decided by the venue's own books, not by a string in this mapping.
 *        - Not a verification. No KYC, no attestation, no check that a legal name corresponds to a
 *          real entity. Eligibility to hold paper is `ControlList` and `Kyc` on each instrument's
 *          own diamond, which is where it has always been and where it stays.
 *        - Not a permission. Holding {ROLE_BUYER} here authorises nothing. It is a statement of
 *          intent that lets a screen render the right thing; every actual capability is still
 *          checked by the contract that grants it.
 *
 *      ## Why signatures rather than an owner or a permissioned writer
 *
 *      The venue submits almost every transaction in this system, and the party being described
 *      usually cannot submit one at all: a wallet made from an email address at sign-in holds no
 *      HBAR on Hedera and no USDC on Arc, so it cannot pay for a write on either chain. The obvious
 *      shortcut is to let the venue write the record on the party's behalf. That shortcut is exactly
 *      what {IMandateBook} already takes with `buyer = msg.sender`, and the result is a public book
 *      on which every bid belongs to the venue.
 *
 *      So authorship is proven by a signature and gas is paid by whoever is willing. The party signs
 *      an EIP-712 {ProfileUpdate}; anyone may relay it with {updateProfileFor}; the recovered signer
 *      is whose record gets written. The relayer is emitted and otherwise carries no weight, and a
 *      relayer who alters one byte produces a signature that recovers to a different address - so
 *      the forgery writes some stranger's profile rather than the one it was aimed at.
 *
 *      The consequence is accepted rather than worked around: **an address whose key nobody holds
 *      can have no profile here.** Several parties seeded into the demo book carry invented
 *      addresses and will simply be absent. That is the correct outcome. A registry that let the
 *      venue fill in the blanks would be recording the venue's opinion under someone else's name,
 *      which is the failure being fixed rather than a smaller version of it.
 *
 *      ## Editable, and therefore versioned rather than permanent
 *
 *      {IUniquenessRegistry} is append-only because a uniqueness guarantee that can be released is
 *      not a guarantee. Nothing of the sort applies here: a business genuinely changes its name, its
 *      website and what it does on this venue, and a record it could not correct would be worse than
 *      no record. So a profile is overwritten in place and every version stays checkable from the
 *      log - `ProfileUpdated` carries the EIP-712 digest of the update that produced it, so a
 *      claim about what an address said at nonce 3 can be verified without any string ever having
 *      been stored in a log.
 *
 *      The nonce is strictly sequential per party and is consumed by every write, including one the
 *      party sends itself. A signature is therefore single-use, and a relayer cannot replay an old
 *      description over a newer one.
 *
 *      ## What is deliberately not on chain
 *
 *      Only what a counterparty would want to check. Email, telephone, registration numbers and
 *      anything else personal stay in the venue's own store, committed to by
 *      {ProfileUpdate-metadataHash}. This is the call the refusal-receipt topic already makes by
 *      publishing a digest instead of the sentence: a public ledger is a poor place for a business's
 *      contact book, and a hash is enough to prove the venue has not altered what it holds.
 */
interface IPartyRegistry {
    // -------------------------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------------------------

    /**
     * @notice A party's current description of itself.
     * @dev `updatedAt == 0` is the "no profile" sentinel, which is why a written record can never
     *      carry a zero timestamp, and why every other field may legitimately be empty on a record
     *      that does exist.
     * @param roles Bitmask of {ROLE_SELLER} and {ROLE_BUYER}. Never zero on a written record.
     * @param country ISO 3166-1 alpha-2, uppercase, or `0x0000` when the party stated none.
     * @param updatedAt Block timestamp of the most recent write. Zero means no profile.
     * @param nonce The nonce that most recent write consumed.
     * @param metadataHash Commitment to the off-chain remainder of the record, or zero when there is
     *        none. Only the venue can open it; this is what proves it has not changed since.
     * @param displayName What the party calls itself. Not unique - see the interface header.
     * @param legalName The registered entity name, where the party chose to state one.
     * @param websiteUri Free-form and unvalidated beyond length. A reader must treat it as a claim.
     */
    struct Profile {
        uint8 roles;
        bytes2 country;
        uint64 updatedAt;
        uint64 nonce;
        bytes32 metadataHash;
        string displayName;
        string legalName;
        string websiteUri;
    }

    /**
     * @notice The EIP-712 message a party signs to write or correct its profile.
     * @dev **Field order is a promise.** It determines the type hash and therefore whether a
     *      signature produced by any client verifies here at all. Reordering silently invalidates
     *      every signature in flight and every `recordHash` already emitted; appending a field is
     *      the only compatible change, and even that needs the domain version bumped.
     * @param party Whose profile is written. Must equal the recovered signer.
     * @param roles Bitmask of {ROLE_SELLER} and {ROLE_BUYER}. Zero is refused.
     * @param displayName Non-empty, at most {MAX_DISPLAY_NAME_BYTES} bytes.
     * @param legalName May be empty. At most {MAX_LEGAL_NAME_BYTES} bytes.
     * @param country ISO 3166-1 alpha-2 in uppercase ASCII, or `0x0000` for unstated.
     * @param websiteUri May be empty. At most {MAX_WEBSITE_BYTES} bytes.
     * @param metadataHash Commitment to the off-chain remainder, or zero.
     * @param nonce Must equal {nonceOf} for `party` at the moment the write lands.
     * @param deadline Unix seconds after which the signature is refused. Updating a profile is
     *        something a person does in a browser in the next minute, so a signature that stayed
     *        valid forever would be a credential nobody meant to issue.
     */
    struct ProfileUpdate {
        address party;
        uint8 roles;
        string displayName;
        string legalName;
        bytes2 country;
        string websiteUri;
        bytes32 metadataHash;
        uint64 nonce;
        uint64 deadline;
    }

    // -------------------------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------------------------

    /**
     * @notice A party wrote or corrected its own description.
     * @dev `recordHash` is the EIP-712 digest of the {ProfileUpdate} behind this version, which
     *      makes the whole history checkable without a single string entering a log. Anyone holding
     *      a claimed copy of what an address said at a given nonce recomputes the hash and compares.
     * @param party The address the record describes, and the address that signed it.
     * @param nonce The nonce this write consumed. Strictly sequential per party from zero.
     * @param roles The bitmask now in force.
     * @param recordHash EIP-712 digest of the update - domain-bound, so a record hash from another
     *        chain or a superseded deployment cannot collide with one from here.
     * @param relayer Who paid for the transaction. Equal to `party` on a self-sent write, and
     *        otherwise carrying no authority at all - recorded so a reader can see that the venue
     *        relayed something, rather than wonder why a party that holds no gas appears to.
     */
    event ProfileUpdated(
        address indexed party, uint64 indexed nonce, uint8 roles, bytes32 recordHash, address relayer
    );

    // -------------------------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------------------------

    /// @notice `party` was the zero address, which holds no key and could never have signed.
    error ZeroParty();

    /// @notice The roles bitmask was zero, or carried a bit this version does not define.
    error InvalidRoles(uint8 roles);

    /// @notice The display name was empty. A record whose purpose is to name a party must name it.
    error EmptyDisplayName();

    /**
     * @notice A string exceeded its cap.
     * @dev Caps exist because this storage is written by anyone who can sign, and an unbounded
     *      string is an unbounded cost borne by whoever relays it.
     */
    error StringTooLong(string field, uint256 length, uint256 maximum);

    /// @notice `country` was neither `0x0000` nor two uppercase ASCII letters.
    error InvalidCountry(bytes2 country);

    /// @notice The supplied nonce is not the one this party is next expected to use.
    error WrongNonce(address party, uint64 supplied, uint64 expected);

    /// @notice The signature's deadline has passed.
    error SignatureExpired(uint64 deadline, uint64 nowTime);

    /// @notice The signature did not recover to `party`.
    error BadSignature(address party, address recovered);

    /// @notice {updateProfile} was called by someone other than the party it describes.
    error NotParty(address caller, address party);

    // -------------------------------------------------------------------------------------------
    // Writing
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Write your own profile, paying your own gas.
     * @dev The path for a party that holds gas on this chain - the venue's operator, or anyone who
     *      has funded their own wallet. Authorship is proven by `msg.sender` rather than by a
     *      signature, which is the same proof approached from the other side. The nonce is consumed
     *      exactly as on a relayed write, so neither path can be used to replay the other.
     */
    function updateProfile(ProfileUpdate calldata update) external;

    /**
     * @notice Relay a profile update somebody else signed.
     * @dev The path that matters, because the typical party here is a wallet made from an email
     *      address holding no gas on any chain. The caller pays; the recovered signer is written.
     *      Nothing about the relayer is trusted.
     * @param update The signed message.
     * @param signature 65-byte ECDSA signature over the EIP-712 digest of `update`.
     */
    function updateProfileFor(ProfileUpdate calldata update, bytes calldata signature) external;

    // -------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------

    /// @notice The party's current description of itself. All-zero when they have never written one.
    function profileOf(address party) external view returns (Profile memory profile);

    /// @notice Whether `party` has ever written a profile.
    function hasProfile(address party) external view returns (bool);

    /// @notice The nonce `party` must use on its next update. Zero before the first one.
    function nonceOf(address party) external view returns (uint64);

    /**
     * @notice Whether `party` claims the given role.
     * @dev A claim, not a permission. See the interface header.
     * @param role A single bit - {ROLE_SELLER} or {ROLE_BUYER}. A mask with several bits set asks
     *        whether the party claims all of them.
     */
    function hasRole(address party, uint8 role) external view returns (bool);

    /**
     * @notice The EIP-712 digest a party must sign for `update`.
     * @dev Published so a client can check the bytes it is about to sign against the bytes this
     *      contract will verify, rather than trusting two independent implementations of one
     *      encoding to agree. They did not agree the first time it mattered here: `deployBond` spent
     *      every issuance this venue ever attempted on a selector the diamond did not have.
     */
    function hashUpdate(ProfileUpdate calldata update) external view returns (bytes32 digest);
}
