/**
 * The single seam between the web package and `@facture/shared`.
 *
 * Nothing else in `src/` imports `@facture/shared` directly. Domain types, the curve
 * maths, the eligibility screen and the chain constants are all owned there and
 * re-exported here, so the UI has exactly one place where it meets the domain.
 *
 * Two conventions from the shared package that the whole UI inherits:
 *
 *   - **Money is `bigint` minor units** of its currency — cents for USD. `$40,000.00`
 *     is `4_000_000n`. It never becomes a `number`, and it is never rendered raw: it
 *     becomes a string only in `src/lib/format.ts`.
 *   - **Instants are ISO-8601 strings**, not `Date`. Tenor is UTC calendar days.
 *
 * Pricing is simple discount on an actual/365 basis, with the single division rounded up
 * in the buyer's favour so a realised yield is never below the published bid:
 *
 *     discount = ceil(face x yieldBps x days / (10_000 x 365))
 *     proceeds = face - discount
 */

export type {
  Bps,
  Currency,
  Debtor,
  Invoice,
  InvoiceStatus,
  IsoDateTime,
  Mandate,
  MandateStatus,
  MinorUnits,
  PriceBreakdown,
  Quote,
  Rating,
  Refusal,
  RefusalCode,
  RefusalReceipt,
  SettlementLeg,
  Trade,
  BestQuoteResult,
} from '@facture/shared';

export {
  // pricing
  bestQuote,
  matchCount,
  priceInvoice,
  priceInvoiceAt,
  tenorDays,
  tenorDaysSigned,
  discountBps,
  // ratings
  RATINGS,
  RATING_RANK,
  meetsRatingFloor,
  compareRating,
  // debtors
  settledCount,
  onTimeRate,
  isColdStart,
  // invoices
  INVOICE_STATUSES,
  isIssued,
  isQuotable,
  // mandates
  unallocated,
  remainingForDebtor,
  debtorExposureOf,
  availableFor,
  // refusals
  explainRefusal,
  refusalReceipt,
  // money
  formatMinorUnits,
  CURRENCY_SYMBOL,
  // identity
  uniquenessHash,
  isinForInvoice,
  // chains — read only by the proof view
  CHAINS,
  ASSET_CHAIN,
  CASH_CHAIN,
  REGULATIONS,
  explorerTxUrl,
  explorerAddressUrl,
} from '@facture/shared';
