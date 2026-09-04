import { INVOICE_STATUSES, type InvoiceStatus } from '../types/invoice.js';
import { createStateMachine, type StateMachine, type TransitionTable } from './machine.js';

/**
 * Invoice lifecycle.
 *
 * ```
 *   draft ⇄ awaiting_confirmation ──► confirmed ⇄ listed ──► sold ──► matured
 *              │                          ▲         │         │  └──► defaulted
 *              └──────────────────────────┼─────────┼─────────┘
 *                                      disputed ◄───┘   (sold ──► listed: secondary)
 * ```
 *
 * Why each edge exists:
 *
 * - `draft -> awaiting_confirmation` — the seller sends the debtor a confirmation link.
 * - `awaiting_confirmation -> draft` — the seller pulls the request back to fix a typo in
 *   the amount or the date. Legal only while the debtor has not answered; once they have,
 *   the acknowledgement is about a specific amount and editing it silently would void it.
 * - `awaiting_confirmation -> confirmed` — the debtor acknowledges their own accounts
 *   payable. This is the edge that gives the invoice a price, and it is also what removes
 *   dispute risk and therefore the holdback.
 * - `awaiting_confirmation -> disputed` — the debtor says no.
 * - `confirmed -> listed` — the seller offers it into the book. The instrument must already
 *   exist; that is a guard at the call site, not a state, because issuance is paced and an
 *   invoice can sit confirmed-but-not-yet-issued for minutes.
 * - `listed -> confirmed` — the seller pulls it off the book without disputing anything.
 * - `confirmed -> disputed`, `listed -> disputed` — the debtor retracts before it sells.
 *   Withdrawing from the book is not enough: a retracted acknowledgement has to be visible,
 *   because a re-listed invoice would otherwise look identical to a clean one.
 * - `listed -> sold` — matched against a mandate and both DvP legs settled.
 * - `sold -> listed` — **the secondary market**. A holder relists seasoned paper into the
 *   same book. Without this edge there is one market, not two, and the README's argument
 *   that the secondary leg is what tightens the primary quote does not hold.
 * - `sold -> matured` — the debtor paid at maturity and settlement routed to whoever held
 *   the token then, not to whoever bought it first.
 * - `sold -> defaulted` — maturity passed unpaid. Non-recourse: the buyer takes the loss,
 *   and the debtor's rating takes a permanent mark.
 * - `sold -> disputed` — a dispute surfacing after the sale. Rare, and it must be
 *   representable or it gets recorded as a default, which would blame the wrong party.
 * - `disputed -> confirmed` — resolved in the seller's favour; back to quotable.
 * - `disputed -> defaulted` — resolved against the seller, or simply never paid.
 *
 * Terminal: `matured` and `defaulted`. Both are permanent facts about a settled receivable
 * and both feed the debtor's rating, which never ages off.
 *
 * Deliberately absent:
 *
 * - No `sold -> confirmed`. Un-selling is not a state change, it is an unwind, and it has to
 *   reverse two settlement legs on two chains. That belongs to the trade record.
 * - No `draft -> confirmed`. A confirmation nobody asked for is not a confirmation.
 * - No `draft -> listed`. Unconfirmed paper is never quotable — see `QUOTABLE_INVOICE_STATUSES`.
 * - No path out of `matured` or `defaulted`.
 */
export const INVOICE_TRANSITIONS: TransitionTable<InvoiceStatus> = {
  draft: ['awaiting_confirmation'],
  awaiting_confirmation: ['draft', 'confirmed', 'disputed'],
  confirmed: ['listed', 'disputed'],
  listed: ['confirmed', 'sold', 'disputed'],
  sold: ['listed', 'matured', 'defaulted', 'disputed'],
  matured: [],
  defaulted: [],
  disputed: ['confirmed', 'defaulted'],
};

export const invoiceMachine: StateMachine<InvoiceStatus> = createStateMachine(
  'invoice',
  INVOICE_STATUSES,
  INVOICE_TRANSITIONS,
);

export const canTransitionInvoice = invoiceMachine.canTransition;
export const transitionInvoice = invoiceMachine.transition;
export const allowedInvoiceTransitions = invoiceMachine.allowedTransitions;
export const isTerminalInvoiceStatus = invoiceMachine.isTerminal;
