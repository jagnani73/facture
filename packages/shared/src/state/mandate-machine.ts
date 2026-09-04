import { MANDATE_STATUSES, type MandateStatus } from '../types/mandate.js';
import { createStateMachine, type StateMachine, type TransitionTable } from './machine.js';

/**
 * Mandate lifecycle.
 *
 * ```
 *   draft ──► funding ──► active ⇄ exhausted
 *     │          │          │          │
 *     └──────────┴──────────┴──────────┴──► withdrawn
 * ```
 *
 * Why each edge exists:
 *
 * - `draft -> funding` — the buyer submits the mandate and escrow of `totalCommitted`
 *   begins. A mandate does not quote from `draft`: an unfunded standing bid is exactly the
 *   thing this design refuses to treat as a price.
 * - `funding -> active` — escrow confirmed. Only now is the quote firm.
 * - `funding -> withdrawn` — funding abandoned or failed; whatever was escrowed goes back.
 * - `active -> exhausted` — `allocated` reached `totalCommitted`. This is a *derived* fact,
 *   and the state exists so the book can stop offering a bid that cannot pay rather than
 *   quoting it and refusing every match with `EXPOSURE_EXHAUSTED`.
 * - `exhausted -> active` — capacity came back: a trade was unwound, or the buyer topped the
 *   mandate up. The edge has to exist or an unwind would strand the capital.
 * - `active -> withdrawn`, `exhausted -> withdrawn` — the buyer closes the mandate and takes
 *   the unallocated balance back. Already-allocated capital is not affected; it is committed
 *   to trades that have settled.
 * - `draft -> withdrawn` — a draft the buyer abandoned.
 *
 * Terminal: `withdrawn`. Reopening is a new mandate with a new id, because the bid it
 * carried was published to the book and a silently revived mandate would let a buyer quote
 * yesterday's yield today.
 *
 * Deliberately absent:
 *
 * - No `active -> funding`. Topping up an active mandate raises `totalCommitted` in place;
 *   it does not make an already-firm bid provisional again.
 * - No `active -> draft`. Editing the terms of a live bid is a new mandate, for the same
 *   reason a withdrawn one is.
 */
export const MANDATE_TRANSITIONS: TransitionTable<MandateStatus> = {
  draft: ['funding', 'withdrawn'],
  funding: ['active', 'withdrawn'],
  active: ['exhausted', 'withdrawn'],
  exhausted: ['active', 'withdrawn'],
  withdrawn: [],
};

export const mandateMachine: StateMachine<MandateStatus> = createStateMachine(
  'mandate',
  MANDATE_STATUSES,
  MANDATE_TRANSITIONS,
);

export const canTransitionMandate = mandateMachine.canTransition;
export const transitionMandate = mandateMachine.transition;
export const allowedMandateTransitions = mandateMachine.allowedTransitions;
export const isTerminalMandateStatus = mandateMachine.isTerminal;
