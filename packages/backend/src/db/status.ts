/**
 * Where a row's status goes when its money or its paperwork moves, and the machine that says so.
 *
 * Both stores import this rather than each writing the arithmetic out. `max0` is duplicated
 * across the two and that is harmless; a lifecycle is not — the two implementations promise to
 * behave identically, the memory one is what every backend test runs against, and a status rule
 * that drifted between them would make the whole suite agree with a store nothing deploys.
 *
 * **Every hop is checked against `@facture/shared`, never just the destination.** The mandate
 * table has no `draft -> active` edge on purpose: an unfunded bid becoming firm without passing
 * through `funding` is precisely the transition the machine refuses, and validating endpoints
 * alone would wave it through. So these return the *path*, and the caller folds it through
 * `transitionMandate`.
 *
 * The other rule these encode is that **a status is written only when it changes.** A no-op
 * write reads as a transition to anything auditing the column, and the machine refuses a
 * self-edge for exactly that reason: `X -> X` is almost always a caller that has not worked out
 * whether anything happened. So the "nothing moved" answer is `null`, not the current status.
 */

import {
  transitionInvoice,
  transitionMandate,
  type InvoiceStatus,
  type MandateStatus,
} from '@facture/shared';
import { conflict } from '../errors.js';

/**
 * One guarded invoice hop, returning the status to write.
 *
 * Throws rather than returning a `Result` because the stores are the last place a bad
 * transition can be stopped and there is nothing sensible for them to do with a refusal but
 * refuse. Route-level guards are still where a seller gets a sentence they can act on; this is
 * the backstop under them.
 */
export function transitionTo(from: InvoiceStatus, to: InvoiceStatus): InvoiceStatus {
  const move = transitionInvoice(from, to);
  if (!move.ok) throw conflict('conflict', move.error.reason);
  return move.value;
}

/** A mandate row, as much of it as any rule here reads. */
export interface MandateCapital {
  readonly status: MandateStatus;
  readonly fundedMinor: bigint;
  readonly allocatedMinor: bigint;
}

/**
 * The hops a funding takes, given whether the capital behind it is firm.
 *
 * - `draft` → `funding`, and on to `active` only once the money is verifiably there. This is
 *   the state the machine describes as "escrow of `totalCommitted` begins": the buyer has said
 *   how much, and it has not landed yet.
 * - `funding` → `active` when it lands. Calling fund again is how that gets re-checked, which
 *   is why an unbacked funding is recorded rather than refused — a refusal leaves nothing to
 *   promote later.
 * - `active` stays `active`. The machine has no `active -> funding` deliberately: topping up a
 *   live bid raises its committed capital in place and does not make an already-firm bid
 *   provisional again. Which is exactly why the *route* refuses a top-up it cannot verify —
 *   there is no state to park it in, so the only alternative would be quoting on it.
 * - `exhausted` → `active` when the top-up opens real headroom, the same edge an unwind uses.
 *   Without headroom it stays exhausted: a bid whose allocation still covers its capital has
 *   nothing more to offer, whatever was just added.
 */
export function fundingHops(
  row: MandateCapital,
  fundedAfter: bigint,
  firm: boolean,
): readonly MandateStatus[] {
  switch (row.status) {
    case 'draft':
      return firm ? ['funding', 'active'] : ['funding'];
    case 'funding':
      return firm ? ['active'] : [];
    case 'exhausted':
      return firm && row.allocatedMinor < fundedAfter ? ['active'] : [];
    default:
      return [];
  }
}

/**
 * Walk a path of hops, refusing at the first one the machine does not allow.
 *
 * Returns the status to write. Callers pass the row's current status back when the path is
 * empty, and must not write it again — a no-op status write is the self-edge the machine
 * forbids, and it is how `allocate`, `release` and `withdrawFromMandate` each came to perform
 * `X -> X` on every call that changed nothing but a balance.
 */
export function walkMandateStatus(
  from: MandateStatus,
  hops: readonly MandateStatus[],
): MandateStatus {
  let status = from;
  for (const hop of hops) {
    const move = transitionMandate(status, hop);
    if (!move.ok) throw conflict('conflict', move.error.reason);
    status = move.value;
  }
  return status;
}

/**
 * The status after an allocation, or `null` when nothing changed.
 *
 * `null` rather than the current status, so a caller cannot accidentally write the same value
 * back and call it a transition.
 */
export function statusAfterAllocate(
  row: MandateCapital,
  allocatedAfter: bigint,
): MandateStatus | null {
  if (allocatedAfter < row.fundedMinor || row.status === 'exhausted') return null;
  return walkMandateStatus(row.status, ['exhausted']);
}

/** The status after capital came back, or `null` when nothing changed. */
export function statusAfterRelease(
  row: MandateCapital,
  allocatedAfter: bigint,
): MandateStatus | null {
  if (row.status !== 'exhausted' || allocatedAfter >= row.fundedMinor) return null;
  return walkMandateStatus(row.status, ['active']);
}

/**
 * The status after a withdrawal, or `null` when nothing changed.
 *
 * A mandate emptied to zero is withdrawn, from wherever it stood. Already-withdrawn stays
 * withdrawn without a write: `withdrawn` is terminal, so re-asserting it is the one self-edge
 * the machine would throw on rather than merely dislike.
 */
export function statusAfterWithdraw(
  row: MandateCapital,
  fundedAfter: bigint,
): MandateStatus | null {
  if (fundedAfter !== 0n || row.status === 'withdrawn') return null;
  return walkMandateStatus(row.status, ['withdrawn']);
}
