import type { InvoiceStatus } from '@/lib/domain';

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
 * Issuance is a separate axis. Tokenisation is paced, so an invoice can exist in the book
 * before its instrument does — `issued={false}` shows it as being added, whatever its
 * status, because that is the thing the seller can actually see happening.
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

export function statusMeta(status: InvoiceStatus, issued = true): StatusMeta {
  if (!issued) return BEING_ADDED;
  return STATUS[status];
}

export function explainStatus(status: InvoiceStatus, issued = true): string {
  return statusMeta(status, issued).explain;
}

export function StatusPill({
  status,
  issued = true,
  size = 'sm',
}: {
  status: InvoiceStatus;
  issued?: boolean | undefined;
  size?: 'sm' | 'md' | undefined;
}) {
  const meta = statusMeta(status, issued);
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
