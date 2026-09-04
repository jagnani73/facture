import Link from 'next/link';

import type { Refusal, RefusalCode, RefusalReceipt } from '@/lib/domain';
import { explainRefusal } from '@/lib/domain';
import { formatDateTime } from '@/lib/format';

/**
 * A refusal that explains itself.
 *
 * The market checks eligibility before it matches, so an ineligible pairing is never a
 * failed transaction — it is an answer, and an answer owes a reason. The sentence comes
 * from the domain (`explainRefusal`), which names both sides of the comparison that
 * failed and is the same string that goes on the receipt, so the screen and the receipt
 * can never say different things. No screen in this product is allowed to say that
 * something reverted.
 *
 * The short forms below are the only copy this component owns: a table cell has no room
 * for a sentence, and truncating the real one would lose the half that matters.
 */

const SHORT: Record<RefusalCode, string> = {
  RATING_BELOW_MANDATE: 'rated below every standing bid',
  TENOR_EXCEEDS_MANDATE: 'runs longer than any bid will hold',
  EXPOSURE_EXHAUSTED: 'no committed capital left at this size',
  DEBTOR_CONCENTRATION: 'at its limit on this customer',
  NOT_KYC_VERIFIED: 'buyer not verified on this instrument',
  INELIGIBLE_JURISDICTION: 'buyer outside the permitted jurisdictions',
  INVOICE_NOT_CONFIRMED: 'awaiting customer confirmation',
  MANDATE_NOT_ACTIVE: 'mandate not funded and quoting',
  CURRENCY_MISMATCH: 'bid in a different currency',
};

/** A clause, for a cell with no room for a sentence. */
export function refusalShort(code: RefusalCode): string {
  return SHORT[code] ?? 'refused, reason unavailable';
}

/** The sentence, from the domain. Never written here. */
export function refusalSentence(detail: Refusal): string {
  return explainRefusal(detail);
}

export interface RefusalNoticeProps {
  /** The receipt as the refused party receives it. */
  receipt: RefusalReceipt;
  /** Which mandate refused, in words the reader knows it by. */
  mandateName?: string | undefined;
  invoiceLabel?: string | undefined;
  /** Where the counterparty can check the receipt without trusting the venue. */
  receiptHref?: string | undefined;
  /** Hide the timestamp on a dense list where every row shares it. */
  showTime?: boolean | undefined;
  variant?: 'notice' | 'quiet' | undefined;
}

export function RefusalNotice({
  receipt,
  mandateName,
  invoiceLabel,
  receiptHref,
  showTime = true,
  variant = 'notice',
}: RefusalNoticeProps) {
  const quiet = variant === 'quiet';

  return (
    <div
      className={[
        'rounded-sm border px-4 py-3',
        quiet ? 'border-rule bg-sunken' : 'border-warn/40 bg-warn-wash',
      ].join(' ')}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={[
            'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[0.6875rem] font-semibold',
            quiet ? 'border-rule-strong text-muted' : 'border-warn/50 text-warn',
          ].join(' ')}
        >
          !
        </span>

        <div className="min-w-0 flex-1">
          {mandateName || invoiceLabel ? (
            <p className="label-micro mb-1">
              {[mandateName, invoiceLabel].filter(Boolean).join(' · ')}
            </p>
          ) : null}

          <p className="text-sm text-ink">{receipt.humanReason}</p>

          {showTime || receiptHref ? (
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
              {showTime ? <span className="num">{formatDateTime(receipt.checkedAt)}</span> : null}
              {receiptHref ? (
                <Link className="text-accent underline underline-offset-2" href={receiptHref}>
                  Check the receipt for yourself
                </Link>
              ) : null}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
