'use client';

import { useState } from 'react';

import type { Invoice } from '@/lib/domain';
import type { Outcome } from '@/lib/data';
import { delistInvoice, listInvoice } from '@/lib/data';
import type { IssuanceDisplay } from '@/components/status-pill';
import { Button, Label } from '@/components/ui/primitives';

/**
 * Offering a receivable for sale, and taking the offer back.
 *
 * **Confirmed and listed are different permissions, and this is where a seller crosses
 * between them.** A confirmed invoice is *quotable*, which is what puts a live price beside
 * every green line the moment the book loads. A listed invoice is *sellable*, and the venue
 * refuses to arm a trade against anything else. Pricing something is not offering it, and
 * until this control existed the book could not tell a seller the difference — the price was
 * there, the Sell button was there, and the venue answered 409.
 *
 * Nothing here lists on a seller's behalf. A sale that quietly listed first would collapse
 * the distinction back into one act, and the act being protected is the seller's: a standing
 * bid can take a listed invoice without asking again, so offering it is the moment the
 * decision is made.
 *
 * ## Every reason this renders nothing
 *
 * Each is a separate fact, and each would otherwise be a button that comes back 409 — which
 * is worse than no button, because it invites a decision the venue has already refused.
 *
 * - **The instrument has not landed.** Listing requires a deployed security, because the
 *   paper has to be deliverable before it can be offered. The page says so in its own words
 *   directly below this; repeating it inside a disabled button would say it twice.
 * - **The invoice is not confirmed, or is already sold.** Neither is a listing decision.
 * - **A buyer is settling against it.** The venue refuses to withdraw an offer with a trade
 *   armed, because taking it off the book underneath a payment already in flight is how a
 *   confirmed invoice ends up marked sold. That refusal is stated rather than hidden: the
 *   way out is unwinding the trade, and a seller looking for the withdraw button is owed the
 *   reason it is not there.
 */
export function OfferControl({
  invoice,
  issuance,
  armed,
  onChanged,
}: {
  invoice: Invoice;
  issuance: IssuanceDisplay;
  /** A trade is being settled against this invoice, so the offer is not the seller's to pull. */
  armed: boolean;
  /** Re-read the book. The venue is the authority on what is on it, not this component. */
  onChanged: () => void;
}) {
  const [state, setState] = useState<{ busy: boolean; message: string | null; failed: boolean }>({
    busy: false,
    message: null,
    failed: false,
  });

  if (issuance !== 'issued') return null;
  if (invoice.status !== 'confirmed' && invoice.status !== 'listed') return null;

  async function run(action: (invoiceId: string) => Promise<Outcome>) {
    setState({ busy: true, message: null, failed: false });
    const result = await action(invoice.id);
    setState({
      busy: false,
      message: result.ok ? result.note : result.reason,
      failed: !result.ok,
    });
    // Only on success: a refused listing changed nothing, and re-reading the book would
    // spend a request to be told the same thing.
    if (result.ok) onChanged();
  }

  const note = state.message ? (
    <p className={`mt-3 text-xs ${state.failed ? 'text-warn' : 'text-muted'}`}>{state.message}</p>
  ) : null;

  if (invoice.status === 'listed') {
    if (armed) {
      return (
        <p className="mt-4 text-xs text-muted">
          A buyer has armed a trade against this invoice and is settling it, so the offer cannot be
          taken back. Unwind the trade if it should not go through. The venue will not take paper
          off the book underneath a payment already in flight.
        </p>
      );
    }

    return (
      <div className="mt-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="quiet"
            size="sm"
            disabled={state.busy}
            onClick={() => void run(delistInvoice)}
          >
            {state.busy ? 'Taking it off…' : 'Take it off the book'}
          </Button>
          <span className="text-xs text-muted">
            It stays confirmed and keeps its price. It just stops being for sale.
          </span>
        </div>
        {note}
      </div>
    );
  }

  return (
    <div className="mt-5 rounded-sm border border-rule-strong bg-sunken px-4 py-4">
      <Label className="mb-1">Not offered yet</Label>
      <p className="text-sm text-ink">
        Your customer has confirmed this invoice, so it is priced. It is not for sale until you
        offer it, and once it is on the book a standing bid can take it without asking you again.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={state.busy} onClick={() => void run(listInvoice)}>
          {state.busy ? 'Offering…' : 'Offer it for sale'}
        </Button>
        <span className="text-xs text-muted">
          You can take it back off the book at any time, until a buyer takes it.
        </span>
      </div>
      {note}
    </div>
  );
}
