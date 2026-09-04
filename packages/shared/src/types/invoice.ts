import type { Address, Hex } from 'viem';
import type { Currency, IsoDateTime, MinorUnits } from './common.js';

/**
 * Lifecycle of a receivable. Legal transitions live in `src/state/invoice-machine.ts`; this
 * file only names the states.
 *
 * - `draft`                  seller entered it, the debtor has not been asked
 * - `awaiting_confirmation`  the debtor has a link and has not answered
 * - `confirmed`              the debtor acknowledged the amount and date — now it has a price
 * - `listed`                 offered into the book, quotable against live mandates
 * - `sold`                   DvP settled; a holder owns the paper and may relist it
 * - `matured`                the debtor paid; whoever held the token was paid
 * - `defaulted`              maturity passed unpaid; the buyer takes the loss
 * - `disputed`               the debtor denies or retracts; not quotable while disputed
 */
export const INVOICE_STATUSES = [
  'draft',
  'awaiting_confirmation',
  'confirmed',
  'listed',
  'sold',
  'matured',
  'defaulted',
  'disputed',
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const isInvoiceStatus = (v: unknown): v is InvoiceStatus =>
  typeof v === 'string' && (INVOICE_STATUSES as readonly string[]).includes(v);

/**
 * A receivable.
 *
 * The three issuance fields are optional because tokenisation happens at onboarding and is
 * *paced* — an invoice exists in the book before its ATS bond does, and the UI shows it as
 * "being added" until `instrumentAddress` lands. Nothing on the quoting path may assume
 * they are present.
 */
export interface Invoice {
  readonly id: string;
  readonly sellerId: string;
  readonly debtorId: string;
  /** Face value in minor units of `currency`. Redeemed in full at maturity. */
  readonly faceValue: MinorUnits;
  readonly currency: Currency;
  /** As printed on the invoice. Canonicalised before hashing — see `src/registry`. */
  readonly invoiceNumber: string;
  readonly issuedAt: IsoDateTime;
  /** Maturity. Tenor is measured from "now" to this date, in UTC calendar days. */
  readonly dueAt: IsoDateTime;
  readonly status: InvoiceStatus;
  /** keccak256 over the canonical (debtor, invoice number, face value) triple. */
  readonly uniquenessHash: Hex;

  /** EVM address of the ATS bond diamond, once `deployBond` has landed. */
  readonly instrumentAddress?: Address | undefined;
  /** Checksum-valid ISIN handed to `deployBond`. Synthetic — see `src/isin`. */
  readonly isin?: string | undefined;
  /** ATS partition holding the issued balance. Lockup/clearing segmentation, not a sub-instrument. */
  readonly partition?: Hex | undefined;

  readonly createdAt?: IsoDateTime | undefined;
  readonly updatedAt?: IsoDateTime | undefined;
}

/** True once the instrument exists on Hedera and the invoice can actually be delivered. */
export const isIssued = (i: Invoice): boolean =>
  i.instrumentAddress !== undefined && i.isin !== undefined;

/**
 * Statuses from which an invoice may be priced against a mandate.
 *
 * `listed` as well as `confirmed`: a listed invoice is re-quoted continuously as the curve
 * moves and as the due date approaches, so quoting must not require de-listing first.
 */
export const QUOTABLE_INVOICE_STATUSES: readonly InvoiceStatus[] = ['confirmed', 'listed'];

export const isQuotable = (i: Invoice): boolean => QUOTABLE_INVOICE_STATUSES.includes(i.status);
