import { describe, expect, it } from 'vitest';
import {
  isIssuanceState,
  isIssued,
  ISSUANCE_STATES,
  issuanceFailed,
  issuancePending,
  type Invoice,
  type IssuanceState,
} from '../../src/types/invoice.js';

const base: Invoice = {
  id: 'inv-1',
  sellerId: 'sel-1',
  debtorId: 'dbt-1',
  faceValue: 6_230_000n,
  currency: 'USD',
  invoiceNumber: 'MF-2046',
  issuedAt: '2026-06-01T00:00:00.000Z',
  dueAt: '2026-12-04T00:00:00.000Z',
  status: 'confirmed',
  uniquenessHash: `0x${'ab'.repeat(32)}`,
};

const issued: Invoice = {
  ...base,
  instrumentAddress: `0x${'cd'.repeat(20)}`,
  isin: 'USQ72738QUM6',
  issuance: { state: 'issued' },
};

describe('issuance state', () => {
  it('names every state the queue can be in', () => {
    expect(ISSUANCE_STATES).toEqual(['queued', 'issuing', 'issued', 'failed']);
  });

  it('rejects anything that is not one of them', () => {
    for (const not of ['pending', 'done', 'ISSUED', '', 'error', undefined, 3]) {
      expect(isIssuanceState(not)).toBe(false);
    }
    for (const state of ISSUANCE_STATES) expect(isIssuanceState(state)).toBe(true);
  });
});

/**
 * The distinction the book could not previously draw.
 *
 * An invoice with no instrument is either still being added or permanently stuck, and those
 * want opposite things from a reader — one is worth waiting for, the other is worth acting
 * on. Deriving progress from `isIssued` alone collapses them, which is what showed "Being
 * added to the book" under a failed invoice indefinitely.
 */
describe('telling a paced issuance from a broken one', () => {
  it('treats a queued invoice as pending, not failed', () => {
    const queued: Invoice = { ...base, issuance: { state: 'queued' } };

    expect(isIssued(queued)).toBe(false);
    expect(issuancePending(queued)).toBe(true);
    expect(issuanceFailed(queued)).toBe(false);
  });

  it('treats an in-flight issuance as pending', () => {
    const issuing: Invoice = { ...base, issuance: { state: 'issuing', attempts: 2 } };

    expect(issuancePending(issuing)).toBe(true);
    expect(issuanceFailed(issuing)).toBe(false);
  });

  it('treats a failed issuance as failed, and NOT as still being added', () => {
    const failed: Invoice = {
      ...base,
      issuance: { state: 'failed', attempts: 6, error: 'CONTRACT_REVERT_EXECUTED: onlyValidISIN' },
    };

    expect(isIssued(failed)).toBe(false);
    // The whole point: no instrument, but nobody is coming.
    expect(issuancePending(failed)).toBe(false);
    expect(issuanceFailed(failed)).toBe(true);
  });

  it('reports an issued invoice as neither pending nor failed', () => {
    expect(isIssued(issued)).toBe(true);
    expect(issuancePending(issued)).toBe(false);
    expect(issuanceFailed(issued)).toBe(false);
  });

  it('does not read missing issuance data as failure', () => {
    /*
     * A fixture or an older projection may carry no issuance block at all. Not knowing is
     * not the same as knowing it failed, and guessing the harsher answer would put a
     * permanent error on an invoice that is merely being described by an older caller.
     */
    expect(issuanceFailed(base)).toBe(false);
    expect(issuancePending(base)).toBe(true);
  });

  it('believes the state rather than inferring one from the instrument fields', () => {
    /*
     * An instrument address that landed while the row still said `failed` is a real
     * possibility — the queue writes the state and the address in separate steps. `isIssued`
     * answers for deliverability and `issuanceFailed` answers for the queue; they are
     * allowed to disagree, and neither may quietly override the other.
     */
    const contradictory: Invoice = {
      ...base,
      instrumentAddress: `0x${'cd'.repeat(20)}`,
      isin: 'USQ72738QUM6',
      issuance: { state: 'failed', error: 'receipt for transaction had status BUSY' },
    };

    expect(isIssued(contradictory)).toBe(true);
    expect(issuanceFailed(contradictory)).toBe(true);
    expect(issuancePending(contradictory)).toBe(false);
  });

  it('covers every state with exactly one of pending, failed or issued', () => {
    for (const state of ISSUANCE_STATES) {
      const invoice: Invoice =
        state === 'issued'
          ? { ...issued, issuance: { state } }
          : { ...base, issuance: { state: state as IssuanceState } };

      const buckets = [isIssued(invoice), issuanceFailed(invoice), issuancePending(invoice)];
      expect(buckets.filter(Boolean)).toHaveLength(1);
    }
  });
});
