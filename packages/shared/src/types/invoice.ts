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
 * How far tokenisation has got, which moves independently of {@link InvoiceStatus}.
 *
 * Issuance is paced — a seller adding twenty invoices is twenty seven-million-gas
 * transactions, and Hedera throttles on network gas throughput — so an invoice is in the
 * book before its instrument is on chain, and may be confirmed before it either.
 *
 * `failed` is the state that matters here and the one that used to be unrepresentable
 * outside the database. A failed issuance and a queued one both lack an instrument, so
 * anything deriving progress from {@link isIssued} alone reports a permanently broken
 * invoice as still being added. It is not "still being added"; nobody is coming.
 */
export const ISSUANCE_STATES = ['queued', 'issuing', 'issued', 'failed'] as const;

export type IssuanceState = (typeof ISSUANCE_STATES)[number];

export const isIssuanceState = (v: unknown): v is IssuanceState =>
  typeof v === 'string' && (ISSUANCE_STATES as readonly string[]).includes(v);

/** Tokenisation progress for one receivable, as the book reads it. */
export interface InvoiceIssuance {
  readonly state: IssuanceState;
  /** How many times the queue has tried. Non-zero with `queued` means it is retrying. */
  readonly attempts?: number | undefined;
  /** Hedera transaction that created the instrument, once one has. */
  readonly transactionId?: string | undefined;
  /** Why it failed, in the words the chain used. Present only with `failed`. */
  readonly error?: string | undefined;
}

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

  /**
   * Tokenisation progress. Optional because a caller working from a fixture or an older
   * projection may not carry it, and its absence must not be read as failure.
   */
  readonly issuance?: InvoiceIssuance | undefined;

  readonly createdAt?: IsoDateTime | undefined;
  readonly updatedAt?: IsoDateTime | undefined;
}

/** True once the instrument exists on Hedera and the invoice can actually be delivered. */
export const isIssued = (i: Invoice): boolean =>
  i.instrumentAddress !== undefined && i.isin !== undefined;

/**
 * True when issuance has stopped and will not resume on its own.
 *
 * The distinction {@link isIssued} cannot draw. An invoice with no instrument is either
 * still being added or permanently stuck, and those want opposite things from a reader:
 * one is worth waiting for, the other is worth acting on. Absent issuance data answers
 * `false` — not knowing is not the same as knowing it failed.
 */
export const issuanceFailed = (i: Invoice): boolean => i.issuance?.state === 'failed';

/**
 * True while the instrument is genuinely still on its way.
 *
 * Deliberately not `!isIssued(i)`. That expression is what put "Being added to the book"
 * under a failed invoice for as long as anyone cared to look at it.
 */
export const issuancePending = (i: Invoice): boolean => !isIssued(i) && !issuanceFailed(i);

/**
 * Statuses from which an invoice may be priced against a mandate.
 *
 * `listed` as well as `confirmed`: a listed invoice is re-quoted continuously as the curve
 * moves and as the due date approaches, so quoting must not require de-listing first.
 */
export const QUOTABLE_INVOICE_STATUSES: readonly InvoiceStatus[] = ['confirmed', 'listed'];

export const isQuotable = (i: Invoice): boolean => QUOTABLE_INVOICE_STATUSES.includes(i.status);
