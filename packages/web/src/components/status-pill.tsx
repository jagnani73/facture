import type { Invoice, InvoiceStatus } from '@/lib/domain';
import { isIssued, issuanceFailed } from '@/lib/domain';

/**
 * The invoice state machine, in the seller's language.
 *
 *   draft ─▶ awaiting_confirmation ─▶ confirmed ─▶ listed ─▶ sold ─▶ matured
 *                     │                   │                            │
 *                     └──▶ disputed       └──▶ disputed                └──▶ defaulted
 *
 * Grey until the customer confirms, then it has a price. That is the whole story the
 * colour is telling.
 *
 * Issuance is a separate axis, and it has three states rather than two. Tokenisation is
 * paced, so an invoice exists in the book before its instrument does and shows as being
 * added whatever its status — that is the thing the seller can actually see happening. But
 * issuance can also *fail*, and a failed one is not a slow one: nobody is coming, and the
 * pill has to say so instead of pulsing indefinitely.
 */

interface StatusMeta {
  label: string;
  /** One sentence, in words a seller would use. */
  explain: string;
  dot: string;
  chip: string;
  pulse?: boolean;
}

const BEING_ADDED: StatusMeta = {
  label: 'Being added',
  explain:
    'We are still setting this invoice up. Adding is paced on purpose and nothing is waiting on it — it becomes quotable the moment it lands.',
  dot: 'bg-idle',
  chip: 'border-rule-strong bg-sunken text-muted',
  pulse: true,
};

/**
 * Issuance stopped and will not resume. Deliberately in the negative palette rather than
 * the idle one: this is not a slower version of being added, it is a thing that needs a
 * person, and a pulsing grey chip would say the opposite.
 */
const COULD_NOT_ADD: StatusMeta = {
  label: 'Could not add',
  explain:
    'Setting this invoice up on the ledger did not work, and it will not keep trying on its own. It cannot be priced or sold until it is added.',
  dot: 'bg-neg',
  chip: 'border-neg/45 bg-neg-wash text-neg',
};

const STATUS: Record<InvoiceStatus, StatusMeta> = {
  draft: {
    label: 'Not sent',
    explain: 'Your customer has not been asked to confirm this invoice yet.',
    dot: 'bg-idle',
    chip: 'border-rule-strong bg-sunken text-muted',
  },
  awaiting_confirmation: {
    label: 'Awaiting customer',
    explain:
      'Your customer has been asked to confirm the amount and the date. Until they do, this invoice has no price.',
    dot: 'bg-warn',
    chip: 'border-warn/40 bg-warn-wash text-warn',
  },
  confirmed: {
    label: 'Confirmed',
    explain: 'Your customer has acknowledged this invoice. It is priced and can be sold now.',
    dot: 'bg-pos',
    chip: 'border-pos/45 bg-pos-wash text-pos',
  },
  listed: {
    label: 'Listed',
    explain: 'Offered into the book and re-priced continuously as the bids move.',
    dot: 'bg-pos',
    chip: 'border-pos/45 bg-pos-wash text-pos',
  },
  sold: {
    label: 'Sold',
    explain: 'You have been paid for this invoice. Your customer still pays on the due date.',
    dot: 'bg-accent',
    chip: 'border-accent/45 bg-accent-wash text-accent-ink',
  },
  matured: {
    label: 'Settled',
    explain: 'Your customer paid on the due date. This invoice is closed.',
    dot: 'bg-idle',
    chip: 'border-rule-strong bg-sunken text-muted',
  },
  disputed: {
    label: 'Disputed',
    explain:
      'Your customer says this is not right. Nothing can be sold until you and they agree the amount.',
    dot: 'bg-neg',
    chip: 'border-neg/45 bg-neg-wash text-neg',
  },
  defaulted: {
    label: 'Unpaid',
    explain:
      'Your customer did not pay. The buyer takes that loss, and the customer’s rating carries the mark from here on.',
    dot: 'bg-neg',
    chip: 'border-neg/45 bg-neg-wash text-neg',
  },
};

/**
 * Where tokenisation has got to, as the pill needs to say it.
 *
 * Three states rather than a boolean, because `issued === false` covered two situations
 * that want opposite things from a seller: one is worth ignoring, the other is worth acting
 * on. A failed issuance read as "Being added" for as long as anyone cared to look.
 */
export type IssuanceDisplay = 'issued' | 'pending' | 'failed';

/** The display state for one invoice, decided in a single place. */
export const issuanceDisplayOf = (invoice: Invoice): IssuanceDisplay =>
  issuanceFailed(invoice) ? 'failed' : isIssued(invoice) ? 'issued' : 'pending';

export function statusMeta(
  status: InvoiceStatus,
  issuance: IssuanceDisplay = 'issued',
): StatusMeta {
  if (issuance === 'failed') return COULD_NOT_ADD;
  if (issuance === 'pending') return BEING_ADDED;
  return STATUS[status];
}

export function explainStatus(status: InvoiceStatus, issuance: IssuanceDisplay = 'issued'): string {
  return statusMeta(status, issuance).explain;
}

export function StatusPill({
  status,
  issuance = 'issued',
  size = 'sm',
}: {
  status: InvoiceStatus;
  issuance?: IssuanceDisplay | undefined;
  size?: 'sm' | 'md' | undefined;
}) {
  const meta = statusMeta(status, issuance);
  return (
    <span
      title={meta.explain}
      className={[
        'inline-flex items-center gap-1.5 rounded-xs border font-medium whitespace-nowrap',
        size === 'sm' ? 'h-5 px-1.5 text-[0.6875rem]' : 'h-6 px-2 text-xs',
        meta.chip,
      ].join(' ')}
    >
      <span
        aria-hidden
        className={`size-1.5 rounded-full ${meta.dot} ${meta.pulse ? 'animate-pulse' : ''}`}
      />
      {meta.label}
    </span>
  );
}
