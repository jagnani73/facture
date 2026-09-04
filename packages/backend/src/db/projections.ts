/**
 * Row -> domain projections.
 *
 * `@facture/shared` is the vocabulary every package speaks, and the pricing maths only
 * accepts its shapes: `bestQuote(invoice, mandates, debtor)` wants an `Invoice`, a
 * `Mandate[]` and a `Debtor`, not three Drizzle rows. This module is the single place a
 * row becomes one of those, so a column rename lands here and nowhere else.
 *
 * Three conversions carry a decision rather than a mapping:
 *
 * 1. **Instants become ISO strings.** Shared's convention is `IsoDateTime`, because an
 *    instant in this system crosses HTTP and Postgres and a string survives both round
 *    trips unchanged. A `Date` does not.
 * 2. **`mandates.exposure_limit_minor` is NOT `Mandate.totalCommitted`.** The limit is the
 *    ceiling the buyer wrote; `funded_minor` is what they actually escrowed. Only escrowed
 *    capital makes a bid firm, so the committed figure the curve reads is the funded one.
 *    Projecting the limit here would quote money nobody has posted.
 * 3. **Per-debtor exposure is passed in, not read.** `Mandate.debtorExposure` is a map
 *    aggregated over trades, and one aggregate for a page of mandates is one query. The
 *    projection therefore takes it as an argument rather than reaching for it.
 */

import type { Currency, Debtor, Invoice, Mandate, MinorUnits, Rating } from '@facture/shared';
import type { Address, Hex } from 'viem';
import type { DebtorPaymentRecord } from '../services/rating.js';
import type { DebtorRow, InvoiceRow, MandateRow } from './schema.js';

/** Postgres hands back `Date`; shared speaks ISO-8601. */
export const iso = (value: Date): string => value.toISOString();

export const isoOrNull = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

/**
 * `char(3)` comes back as a plain string, and shared's `Currency` is a two-member union.
 * Anything else is a row that should never have been inserted, so it fails loudly here
 * rather than mispricing quietly downstream.
 */
export function toCurrency(value: string): Currency {
  if (value === 'USD' || value === 'EUR') return value;
  throw new Error(`Unsupported currency in database row: ${value}`);
}

export function toInvoice(row: InvoiceRow): Invoice {
  return {
    id: row.id,
    sellerId: row.sellerId,
    debtorId: row.debtorId,
    faceValue: row.faceValue,
    currency: toCurrency(row.currency),
    invoiceNumber: row.invoiceNumber,
    issuedAt: iso(row.issuedAt),
    dueAt: iso(row.dueAt),
    status: row.status,
    uniquenessHash: row.uniquenessHash as Hex,
    instrumentAddress: (row.securityEvmAddress as Address | null) ?? undefined,
    isin: row.isin ?? undefined,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/**
 * The debtor as the curve reads them.
 *
 * `confirmedCount` is not on the accumulator: the counters exist to price credit, and a
 * confirmation is not a payment. It is projected as the settled count so the field is
 * never a fiction — see the note on `Debtor.confirmedCount` in shared.
 */
export function toDebtor(row: DebtorRow, rating: Rating = row.rating): Debtor {
  return {
    id: row.id,
    name: row.name,
    rating,
    onTimeCount: row.settledOnTime,
    defaultCount: row.defaulted,
    confirmedCount: row.settledOnTime + row.settledLate + row.defaulted,
    createdAt: iso(row.createdAt),
  };
}

/** The accumulator `services/rating.ts` assesses. One row, no join. */
export function toPaymentRecord(row: DebtorRow): DebtorPaymentRecord {
  return {
    debtorId: row.id,
    settledOnTime: row.settledOnTime,
    settledLate: row.settledLate,
    defaulted: row.defaulted,
    settledFaceValue: row.settledFaceValue,
    firstSettlementAt: row.firstSettlementAt,
    lastSettlementAt: row.lastSettlementAt,
  };
}

/**
 * A standing bid as `bestQuote` reads it.
 *
 * `totalCommitted` is the *funded* balance, deliberately capped by the exposure limit the
 * buyer wrote: over-funding a mandate must not quietly raise the ceiling they published.
 */
export function toMandate(
  row: MandateRow,
  debtorExposure: Readonly<Record<string, MinorUnits>> = {},
): Mandate {
  const committed =
    row.fundedMinor < row.exposureLimitMinor ? row.fundedMinor : row.exposureLimitMinor;

  return {
    id: row.id,
    buyerId: row.buyerId,
    minRating: row.ratingFloor,
    maxTenorDays: row.maxTenorDays,
    annualisedYieldBps: row.annualisedYieldBps,
    totalCommitted: committed,
    allocated: row.allocatedMinor,
    /** Absent means the total limit is the only cap, which is the limit itself. */
    maxPerDebtor: row.perDebtorLimitMinor ?? row.exposureLimitMinor,
    status: row.status,
    currency: toCurrency(row.currency),
    debtorExposure,
    createdAt: iso(row.createdAt),
  };
}

/** Unallocated balance on the row, clamped. The ceiling on what a mandate can still take. */
export const unallocatedOf = (row: MandateRow): MinorUnits => {
  const remaining = row.fundedMinor - row.allocatedMinor;
  return remaining > 0n ? remaining : 0n;
};
