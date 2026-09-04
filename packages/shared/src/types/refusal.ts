import type { RegulationKey } from '../chains/ats.js';
import { REGULATIONS } from '../chains/ats.js';
import type { Currency, IsoDateTime, MinorUnits } from './common.js';
import type { InvoiceStatus } from './invoice.js';
import type { MandateStatus } from './mandate.js';
import { formatMinorUnits } from './money.js';
import type { Rating } from './rating.js';

/**
 * Refusals are a first-class product output, not an error path.
 *
 * The argument in the README is that an AMM matches first and discovers the transfer was
 * illegal afterwards, so non-compliance surfaces as a revert nobody can read. Here the
 * ineligible counterparty is never matched, and the reason comes back in words with a
 * receipt the refused party can check on HCS without trusting the venue.
 *
 * Each code therefore carries the *operands of the comparison that failed*, so the message
 * can name both sides. `RATING_BELOW_MANDATE` alone is not an explanation; "the customer is
 * rated BB, and this mandate takes A or better" is.
 */
export const REFUSAL_CODES = [
  'INELIGIBLE_JURISDICTION',
  'RATING_BELOW_MANDATE',
  'TENOR_EXCEEDS_MANDATE',
  'EXPOSURE_EXHAUSTED',
  'DEBTOR_CONCENTRATION',
  'NOT_KYC_VERIFIED',
  'INVOICE_NOT_CONFIRMED',
  'MANDATE_NOT_ACTIVE',
  'CURRENCY_MISMATCH',
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

export const isRefusalCode = (v: unknown): v is RefusalCode =>
  typeof v === 'string' && (REFUSAL_CODES as readonly string[]).includes(v);

/** The buyer's jurisdiction is outside what the instrument's SEC regulation permits. */
export interface IneligibleJurisdictionRefusal {
  readonly code: 'INELIGIBLE_JURISDICTION';
  readonly regulation: RegulationKey;
  readonly buyerJurisdiction: string;
  readonly allowedJurisdictions?: readonly string[] | undefined;
}

/** The debtor's earned rating is below the mandate's floor. */
export interface RatingBelowMandateRefusal {
  readonly code: 'RATING_BELOW_MANDATE';
  readonly debtorId: string;
  readonly debtorRating: Rating;
  readonly minRating: Rating;
}

/** Days to maturity exceed the mandate's ceiling. */
export interface TenorExceedsMandateRefusal {
  readonly code: 'TENOR_EXCEEDS_MANDATE';
  readonly tenorDays: number;
  readonly maxTenorDays: number;
}

/** The mandate's unallocated balance cannot cover the proceeds. */
export interface ExposureExhaustedRefusal {
  readonly code: 'EXPOSURE_EXHAUSTED';
  readonly required: MinorUnits;
  readonly unallocated: MinorUnits;
  readonly currency: Currency;
}

/** The mandate has room overall but not against this particular debtor. */
export interface DebtorConcentrationRefusal {
  readonly code: 'DEBTOR_CONCENTRATION';
  readonly debtorId: string;
  readonly debtorName?: string | undefined;
  readonly required: MinorUnits;
  readonly remainingForDebtor: MinorUnits;
  readonly maxPerDebtor: MinorUnits;
  readonly currency: Currency;
}

/** The buyer is not KYC-verified on this instrument's own `Kyc` facet. */
export interface NotKycVerifiedRefusal {
  readonly code: 'NOT_KYC_VERIFIED';
  readonly account: string;
  readonly instrumentAddress?: string | undefined;
}

/** The invoice is not in a state that may be priced. Usually the debtor has not confirmed. */
export interface InvoiceNotConfirmedRefusal {
  readonly code: 'INVOICE_NOT_CONFIRMED';
  readonly status: InvoiceStatus;
}

/** The mandate is not funded and quoting, so its bid is not firm. */
export interface MandateNotActiveRefusal {
  readonly code: 'MANDATE_NOT_ACTIVE';
  readonly status: MandateStatus;
}

/** The mandate bids in a different currency than the invoice is denominated in. */
export interface CurrencyMismatchRefusal {
  readonly code: 'CURRENCY_MISMATCH';
  readonly invoiceCurrency: Currency;
  readonly mandateCurrency: Currency;
}

/** Discriminated on `code`. An exhaustive `switch` over this is checked by the compiler. */
export type Refusal =
  | IneligibleJurisdictionRefusal
  | RatingBelowMandateRefusal
  | TenorExceedsMandateRefusal
  | ExposureExhaustedRefusal
  | DebtorConcentrationRefusal
  | NotKycVerifiedRefusal
  | InvoiceNotConfirmedRefusal
  | MandateNotActiveRefusal
  | CurrencyMismatchRefusal;

/** Narrow a `Refusal` to one variant: `refusalOf(r, 'EXPOSURE_EXHAUSTED')`. */
export const refusalOf = <C extends RefusalCode>(
  r: Refusal,
  code: C,
): r is Extract<Refusal, { code: C }> => r.code === code;

const INVOICE_STATUS_PROSE: Record<InvoiceStatus, string> = {
  draft: 'has not been sent to the customer for confirmation yet',
  awaiting_confirmation: 'is still waiting for the customer to confirm it',
  confirmed: 'is confirmed',
  listed: 'is listed',
  sold: 'has already been sold',
  matured: 'has already matured',
  defaulted: 'is in default',
  disputed: 'is disputed by the customer',
};

const MANDATE_STATUS_PROSE: Record<MandateStatus, string> = {
  draft: 'has not been funded',
  funding: 'is still being funded',
  active: 'is active',
  exhausted: 'has allocated all of its committed capital',
  withdrawn: 'has been withdrawn',
};

/**
 * The human-readable half of a refusal: one sentence, addressed to the party being refused,
 * naming both sides of the comparison that failed. This string is what goes on the HCS
 * receipt, so it has to stand on its own without the structured payload beside it.
 */
export function explainRefusal(r: Refusal): string {
  switch (r.code) {
    case 'INELIGIBLE_JURISDICTION': {
      const reg = REGULATIONS[r.regulation];
      const allowed =
        r.allowedJurisdictions !== undefined && r.allowedJurisdictions.length > 0
          ? ` Buyers in ${r.allowedJurisdictions.join(', ')} are eligible.`
          : '';
      return (
        `This invoice is issued under ${reg.label}, ` +
        `which does not admit buyers in ${r.buyerJurisdiction}.${allowed}`
      );
    }
    case 'RATING_BELOW_MANDATE':
      return (
        `The customer is rated ${r.debtorRating}, ` +
        `and this mandate takes ${r.minRating} or better.`
      );
    case 'TENOR_EXCEEDS_MANDATE':
      return (
        `This invoice matures in ${r.tenorDays} days, ` +
        `and this mandate takes ${r.maxTenorDays} days or less.`
      );
    case 'EXPOSURE_EXHAUSTED':
      return (
        `This invoice needs ${money(r.required, r.currency)}, ` +
        `and this mandate has ${money(r.unallocated, r.currency)} of committed capital left.`
      );
    case 'DEBTOR_CONCENTRATION': {
      const who = r.debtorName ?? `customer ${r.debtorId}`;
      return (
        `This mandate caps exposure to ${who} at ${money(r.maxPerDebtor, r.currency)}, ` +
        `and only ${money(r.remainingForDebtor, r.currency)} of that is left ` +
        `against the ${money(r.required, r.currency)} this invoice needs.`
      );
    }
    case 'NOT_KYC_VERIFIED':
      return (
        `Account ${r.account} is not KYC-verified on this instrument, ` +
        `so it cannot receive the security.`
      );
    case 'INVOICE_NOT_CONFIRMED':
      return `This invoice ${INVOICE_STATUS_PROSE[r.status]}, so it cannot be priced.`;
    case 'MANDATE_NOT_ACTIVE':
      return `This mandate ${MANDATE_STATUS_PROSE[r.status]}, so it cannot quote.`;
    case 'CURRENCY_MISMATCH':
      return (
        `This invoice is denominated in ${r.invoiceCurrency}, ` +
        `and this mandate bids in ${r.mandateCurrency}.`
      );
  }
}

const money = (amount: MinorUnits, currency: Currency): string =>
  formatMinorUnits(amount, currency, { symbol: true });

/**
 * What the refused party receives, and what is published to HCS.
 *
 * `mandateId` is `null` when the refusal is about the invoice itself rather than about any
 * one mandate — an unconfirmed invoice is refused once, not once per bid on the book.
 *
 * `hcsMessageId` is filled in *after* publication, in the form Hedera returns
 * (`<topicId>@<consensusSeconds>.<nanos>`), so it is absent on a freshly built receipt.
 */
export interface RefusalReceipt {
  readonly invoiceId: string;
  readonly mandateId: string | null;
  readonly code: RefusalCode;
  /** One sentence, from `explainRefusal`. Denormalised so the receipt is self-contained. */
  readonly humanReason: string;
  /** Structured operands behind `humanReason`, for the UI and for tests. */
  readonly detail: Refusal;
  readonly checkedAt: IsoDateTime;
  /** HCS message id, once the receipt has been published. */
  readonly hcsMessageId?: string | undefined;
}

/** Build a receipt from a refusal. The human sentence is derived, never passed in. */
export function refusalReceipt(
  invoiceId: string,
  mandateId: string | null,
  detail: Refusal,
  checkedAt: IsoDateTime,
): RefusalReceipt {
  return {
    invoiceId,
    mandateId,
    code: detail.code,
    humanReason: explainRefusal(detail),
    detail,
    checkedAt,
  };
}
