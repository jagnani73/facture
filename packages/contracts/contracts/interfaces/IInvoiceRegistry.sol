// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Rating, InvoiceStatus} from "../libraries/FactureTypes.sol";

/**
 * @title IInvoiceRegistry
 * @notice The venue's record of what each listed receivable IS: debtor, face, due date, rating.
 *
 * @dev {MandateBook} does not store invoice facts, it reads them from behind this interface, and
 *      that separation is deliberate.
 *
 *      The alternative would be to pass the invoice's rating, tenor and confirmation status in as
 *      arguments to `matchInvoice`. That collapses immediately: whoever calls the matcher could then
 *      assert any rating they liked, and the whole refusal apparatus would be checking the caller's
 *      claims against the mandate rather than checking reality against the mandate. "Rating below
 *      floor" only means something if the rating is not supplied by the party who wants the match to
 *      succeed. The same argument applies to confirmation, which is the control that removes dispute
 *      risk and therefore justifies advancing the full face value with no holdback.
 *
 *      So the book reads, and something else writes. What writes is out of scope for this package:
 *      ratings are earned from settled payment behaviour and debtor confirmation arrives over a
 *      link, both of which are venue-operated processes. This interface is the seam between them,
 *      and it is intentionally read-only from the book's side.
 *
 *      A mock implementation lives in `contracts/mocks/MockInvoiceRegistry.sol` so the book's
 *      refusal paths can be tested without the rest of the venue existing.
 */
interface IInvoiceRegistry {
    /**
     * @notice Everything the book needs to price and permission one receivable.
     *
     * @dev Field order is chosen for packing, not for readability - see {MandateBook} for the same
     *      treatment of `Mandate`. Layout across three slots:
     *        slot 0: instrument (20) + rating (1) + status (1) + dueDate (8)   = 30 bytes
     *        slot 1: debtorId (32)
     *        slot 2: seller (20) + faceValue (12 of 16, spilling)              -> see note
     *      `faceValue` is `uint128` and shares slot 2 with `seller` only partially, so the compiler
     *      places it in slot 3. That is accepted: the alternative packings all cost a field's
     *      meaning, and this struct is read once per match, not written per match.
     */
    struct Invoice {
        /// @dev The ATS zero-coupon bond issued for this receivable. Bound in {IUniquenessRegistry}.
        address instrument;
        /// @dev Debtor credit bucket, earned on the venue. `Unrated` until history exists.
        Rating rating;
        /// @dev Lifecycle. Only `Confirmed` is matchable.
        InvoiceStatus status;
        /// @dev Invoice due date, unix seconds. This is the bond's maturity; tenor is derived from it.
        uint64 dueDate;
        /// @dev Stable venue identity of the debtor. Not an address - debtors never hold a wallet.
        bytes32 debtorId;
        /// @dev The business owed the money, and the recipient of the sale proceeds.
        address seller;
        /// @dev Amount owed at maturity, in settlement-currency smallest units. Redeems at par.
        uint128 faceValue;
        /// @dev The {IUniquenessRegistry} commitment, so a reader can verify one-invoice-one-token.
        bytes32 uniquenessHash;
    }

    /**
     * @notice Read one listed receivable.
     * @dev MUST NOT revert for an unknown id. It returns a zero-filled struct instead, whose
     *      `status` decodes to `InvoiceStatus.Unknown`, because the book's `previewMatch` is a
     *      `view` that has to be able to report `INVOICE_UNKNOWN` as a named refusal rather than
     *      propagating a revert. Failing soft here is what keeps refusals first-class upstream.
     * @param invoiceId Venue identifier for the receivable.
     * @return invoice The record, or a zero-filled struct if not listed.
     */
    function getInvoice(bytes32 invoiceId) external view returns (Invoice memory invoice);

    /**
     * @notice Whether the debtor has acknowledged this invoice.
     * @param invoiceId Venue identifier for the receivable.
     * @return True only when `status == InvoiceStatus.Confirmed`.
     */
    function isConfirmed(bytes32 invoiceId) external view returns (bool);
}
