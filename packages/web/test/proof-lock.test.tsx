/**
 * What the proof view says about a payout that is still in the escrow.
 *
 * `DvpEscrow.claim` is beneficiary-only and time-bounded, so a `locked` payout means two
 * different things either side of its timeout: before, the seller can take it; after, `claim`
 * reverts and the capital moves only if someone calls `reclaimPayout`, which returns it to the
 * buyer and which this build does not wire.
 *
 * The page said "Locked for the seller, not yet claimed" for both. On MF-2070 — the first
 * receivable to go issued, sold from the vault and matured, and the strongest lifecycle claim
 * the venue has — the window closed on 5 September with the payout untaken, and the page went
 * on telling a reader the money was still coming. Found by opening the page, because the
 * fixture book's lock is not expired and never will be.
 *
 * This is the same rule as the registry block beside it: say the state that is true, not the
 * better one next to it.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { held } = vi.hoisted(() => ({ held: { proof: null as unknown } }));

vi.mock('@/lib/data/hooks', () => ({ useProof: () => held.proof }));

/* No case below renders a claimable lock for a connected wallet, so the seam is stubbed. */
vi.mock('@privy-io/react-auth', () => ({
  useWallets: () => ({ wallets: [] }),
  useSendTransaction: () => ({ sendTransaction: vi.fn() }),
}));

import type { CashLegLock } from '@/lib/api/contract';
import type { ProofRecord } from '@/lib/data';
import { fixtureProof } from '@/lib/data/fixture-source';
import { ProofView } from '@/components/views/proof-view';

const TRADE = 'TRD-4417';

const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

function show(lock: Partial<CashLegLock> | null): void {
  const record = fixtureProof(TRADE);
  if (record === null) throw new Error(`the demo book has no proof for ${TRADE}`);

  const existing = record.cashLeg.lock;
  held.proof = {
    status: 'ready',
    reload: vi.fn(),
    data: {
      ...record,
      cashLeg: {
        ...record.cashLeg,
        lock:
          lock === null
            ? null
            : ({
                lockId: '0x8d423031a260c768c15df1134451e43e85d03e824b00dcb6aef9bbae0449cfc6',
                status: 'locked',
                beneficiary: '0x2Da63Ac0F6AE2C3059091d8DF38b3175a237ee71',
                amountMinor: 12326n,
                claimableUntil: null,
                secret: null,
                escrowAddress: '0x32e3511A2F3d941F776dF01f6bA66a73cAf10d69',
                explorerUrl: null,
                ...existing,
                ...lock,
              } as CashLegLock),
      },
    },
  } satisfies { status: 'ready'; reload: () => void; data: ProofRecord };

  render(<ProofView tradeId={TRADE} />);
}

beforeEach(() => {
  held.proof = null;
});

afterEach(() => {
  cleanup();
});

describe('the payout escrow block', () => {
  it('says the seller can still take a payout inside its window', () => {
    show({ status: 'locked', claimableUntil: TOMORROW });

    expect(screen.getByText(/Locked for the seller, not yet claimed/)).toBeTruthy();
  });

  /**
   * THE ONE THAT MATTERS. "Not yet claimed" reads as money still coming, and after the timeout
   * it is not: the seller cannot take it at all.
   */
  it('does not call an expired lock "not yet claimed"', () => {
    show({ status: 'locked', claimableUntil: YESTERDAY });

    expect(screen.queryByText(/not yet claimed/)).toBeNull();
    expect(screen.getByText(/claim window closed/)).toBeTruthy();
    expect(screen.getByText(/returned to the buyer/)).toBeTruthy();
  });

  /**
   * An escrow that did not report a timeout has not reported a closure either. Inventing one
   * from an absent field is the same overclaim pointed the other way.
   */
  it('does not invent a closure from a missing timeout', () => {
    show({ status: 'locked', claimableUntil: null });

    expect(screen.getByText(/Locked for the seller, not yet claimed/)).toBeTruthy();
  });

  /** A taken payout stays taken, whatever the window says. */
  it('reports a claimed payout regardless of the window', () => {
    show({ status: 'claimed', claimableUntil: YESTERDAY });

    expect(screen.getByText(/Seller has taken the payout/)).toBeTruthy();
  });

  it('reports a refunded payout as returned', () => {
    show({ status: 'refunded', claimableUntil: YESTERDAY });

    expect(screen.getByText(/returned to the buyer/)).toBeTruthy();
  });
});
