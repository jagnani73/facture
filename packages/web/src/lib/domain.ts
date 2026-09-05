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
  ChainKey,
  Currency,
  Debtor,
  Invoice,
  InvoiceIssuance,
  InvoiceStatus,
  IssuanceState,
  IsoDateTime,
  Mandate,
  MandateStatus,
  MinorUnits,
  PriceBreakdown,
  Quote,
  Rating,
  RegulationKey,
  Refusal,
  RefusalCode,
  RefusalReceipt,
  SettlementLeg,
  SettlementLegState,
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
  isInvoiceStatus,
  isIssued,
  isQuotable,
  ISSUANCE_STATES,
  isIssuanceState,
  issuanceFailed,
  issuancePending,
  // mandates
  MANDATE_STATUSES,
  isMandateStatus,
  unallocated,
  remainingForDebtor,
  debtorExposureOf,
  availableFor,
  // trades
  SETTLEMENT_LEG_STATES,
  // refusals
  REFUSAL_CODES,
  isRefusalCode,
  explainRefusal,
  refusalReceipt,
  // money
  CURRENCIES,
  formatMinorUnits,
  CURRENCY_SYMBOL,
  // identity
  uniquenessHash,
  isinForInvoice,
  // chains — read only by the proof view
  CHAINS,
  CHAIN_KEYS,
  ASSET_CHAIN,
  CASH_CHAIN,
  REGULATIONS,
  isRegulationKey,
  explorerTxUrl,
  explorerAddressUrl,
} from '@facture/shared';
