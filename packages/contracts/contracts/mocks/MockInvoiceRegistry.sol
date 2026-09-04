// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IInvoiceRegistry} from "../interfaces/IInvoiceRegistry.sol";
import {InvoiceStatus} from "../libraries/FactureTypes.sol";

/**
 * @title MockInvoiceRegistry
 * @notice Test-only source of invoice truth.
 * @dev Lets a test place an invoice into any state - unconfirmed, wrong rating, over-tenor, matured -
 *      so that every refusal path in {MandateBook} can be reached deterministically. The real
 *      registry is written by the venue's listing and rating pipelines, which live outside this
 *      package; see {IInvoiceRegistry} for why the book reads facts rather than accepting them as
 *      arguments.
 *
 *      Note it honours the interface's requirement not to revert on an unknown id: it returns a
 *      zero-filled struct, whose `status` decodes to `InvoiceStatus.Unknown`. Tests rely on that to
 *      exercise the `INVOICE_UNKNOWN` refusal.
 */
contract MockInvoiceRegistry is IInvoiceRegistry {
    mapping(bytes32 invoiceId => Invoice) private _invoices;

    /// @notice Write an invoice record wholesale.
    function setInvoice(bytes32 invoiceId, Invoice calldata invoice) external {
        _invoices[invoiceId] = invoice;
    }

    /// @notice Move an existing invoice to a new lifecycle status.
    function setStatus(bytes32 invoiceId, InvoiceStatus status) external {
        _invoices[invoiceId].status = status;
    }

    /// @inheritdoc IInvoiceRegistry
    function getInvoice(bytes32 invoiceId) external view returns (Invoice memory) {
        return _invoices[invoiceId];
    }

    /// @inheritdoc IInvoiceRegistry
    function isConfirmed(bytes32 invoiceId) external view returns (bool) {
        return _invoices[invoiceId].status == InvoiceStatus.Confirmed;
    }
}
