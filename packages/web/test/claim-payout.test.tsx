/**
 * The one transaction this app asks a person to sign.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * WHAT THESE TESTS CAN PROVE, AND WHAT ONLY A LOGIN CAN
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * Privy's signing round trip needs a real session and is not simulated here. Everything
 * either side of it is, and that is where the risk actually sits:
 *
 * - **Every reason the button must not be offered.** There are five, they are separate
 *   facts, and each one renders nothing. A claim offered to someone who cannot make it
 *   invites a signature that reverts, which is worse than offering no button at all.
 * - **The calldata.** This is the assertion that matters. A wrong selector or a wrong
 *   argument order is well-typed, compiles, and produces a transaction that fails on chain
 *   for a reason that reads like a contract fault — which is exactly how this repo lost
 *   every backend issuance it ever attempted to a plausible-looking `deployBond` tuple.
 *   `claim(bytes32,bytes32)` is checked here against a hand-computed selector rather than
 *   against the same `encodeFunctionData` call the component makes, because a test that
 *   re-derives the value from the code under test agrees with it no matter what it says.
 *
 * What is left untested is Privy accepting the payload, and that is Privy's contract with
 * itself rather than this app's.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CashLegLock } from '@/lib/api/contract';

/* ── the Privy seam ──────────────────────────────────────────────────────────────────── */

/**
 * Mocked at the module boundary, because the component's whole job is to decide *whether* to
 * ask Privy for a signature. Faking the hooks lets every one of those decisions be exercised
 * without a session, and lets the request itself be captured and inspected.
 */
const sendTransaction = vi.fn();
let connectedWallets: { address: string }[] = [];

vi.mock('@privy-io/react-auth', () => ({
  useWallets: () => ({ wallets: connectedWallets }),
  useSendTransaction: () => ({ sendTransaction }),
}));

const { ClaimPayout } = await import('@/components/claim-payout');

/* ── fixtures ────────────────────────────────────────────────────────────────────────── */

/** The seller's address, in the checksummed form the venue puts on the wire. */
const SELLER = '0x2Da63Ac0F6AE2C3059091d8DF38b3175a237ee71';
const ESCROW = '0x32e3511A2F3d941F776dF01f6bA66a73cAf10d69';
const LOCK_ID = `0x${'11'.repeat(32)}`;
const SECRET = `0x${'22'.repeat(32)}`;

const lock = (over: Partial<CashLegLock> = {}): CashLegLock => ({
  lockId: LOCK_ID,
  status: 'locked',
  beneficiary: SELLER,
  amountMinor: 14_843n,
  claimableUntil: '2099-01-01T00:00:00.000Z',
  secret: SECRET,
  escrowAddress: ESCROW,
  explorerUrl: null,
  ...over,
});

beforeEach(() => {
  sendTransaction.mockReset();
  sendTransaction.mockResolvedValue(
    '0xdeadbeef00000000000000000000000000000000000000000000000000000000',
  );
  connectedWallets = [{ address: SELLER }];
});

afterEach(cleanup);

/* ── tests ───────────────────────────────────────────────────────────────────────────── */

describe('when the button must not be offered', () => {
  /*
   * Five separate facts, deliberately not collapsed into one absent value. The component
   * renders nothing for each, and the reason a reader might want is on the row above it.
   */
  it('renders nothing once the lock is claimed', () => {
    const { container } = render(<ClaimPayout lock={lock({ status: 'claimed' })} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing once the lock has been refunded to the buyer', () => {
    const { container } = render(<ClaimPayout lock={lock({ status: 'refunded' })} />);
    expect(container.firstChild).toBeNull();
  });

  /*
   * Without the preimage there is no call to build. It is published precisely so this button
   * can exist — withholding it once left a payout nobody could ever collect.
   */
  it('renders nothing without the preimage', () => {
    const { container } = render(<ClaimPayout lock={lock({ secret: null })} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing without an escrow address to send to', () => {
    const { container } = render(<ClaimPayout lock={lock({ escrowAddress: null })} />);
    expect(container.firstChild).toBeNull();
  });

  /*
   * The one that matters most. `DvpEscrow.claim` checks `msg.sender == beneficiary`, and the
   * contract tests assert that even the attester holding the public secret is refused with
   * `NotBeneficiary`. Offering the button to anyone else is offering a revert.
   */
  it('renders nothing for a wallet that is not the beneficiary', () => {
    connectedWallets = [{ address: '0x1C755e95CB11E5D5aF498bb0EA595b56e1adb035' }];
    const { container } = render(<ClaimPayout lock={lock()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when no wallet is connected at all', () => {
    connectedWallets = [];
    const { container } = render(<ClaimPayout lock={lock()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the lock names no beneficiary', () => {
    const { container } = render(<ClaimPayout lock={lock({ beneficiary: null })} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('who counts as the beneficiary', () => {
  /*
   * One side is a checksummed address read off the chain, the other is whatever Privy
   * reports. An address differing only in case is the same account, and comparing them
   * literally would hide the button from the one person entitled to press it.
   */
  it('matches the beneficiary regardless of case', () => {
    connectedWallets = [{ address: SELLER.toLowerCase() }];
    render(<ClaimPayout lock={lock()} />);
    expect(screen.getByRole('button')).toBeDefined();
  });

  it('finds the beneficiary among several connected wallets', () => {
    connectedWallets = [
      { address: '0x1C755e95CB11E5D5aF498bb0EA595b56e1adb035' },
      { address: SELLER },
    ];
    render(<ClaimPayout lock={lock()} />);
    expect(screen.getByRole('button')).toBeDefined();
  });
});

describe('the claim itself', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════
   * THE ASSERTION THAT MATTERS
   * ═══════════════════════════════════════════════════════════════════════════════════
   *
   * `claim(bytes32,bytes32)` keccaks to `84cc9dfb…`, so the calldata is that selector
   * followed by the lock id and then the secret, in that order. The selector is written out
   * rather than derived, and the argument order is asserted rather than assumed: swapping
   * two `bytes32` arguments type-checks, encodes, and produces a transaction that reverts on
   * chain for a reason that looks nothing like "the arguments were the wrong way round".
   */
  it('sends claim(lockId, secret) to the escrow, in that order', async () => {
    render(<ClaimPayout lock={lock()} />);
    fireEvent.click(screen.getByRole('button'));
    await vi.waitFor(() => expect(sendTransaction).toHaveBeenCalledTimes(1));

    const request = sendTransaction.mock.calls[0]?.[0] as { to: string; data: string };
    expect(request.to).toBe(ESCROW);

    const selector = request.data.slice(0, 10);
    const args = request.data.slice(10);
    expect(selector).toBe('0x84cc9dfb');
    expect(args).toHaveLength(128);
    expect(`0x${args.slice(0, 64)}`).toBe(LOCK_ID);
    expect(`0x${args.slice(64)}`).toBe(SECRET);
  });

  it('reports the submitted hash rather than claiming the money has landed', async () => {
    render(<ClaimPayout lock={lock()} />);
    fireEvent.click(screen.getByRole('button'));

    /*
     * "Submitted", not "paid". The escrow is the record and the row reads claimed once it
     * confirms; a component that announced success on a returned hash would be reporting a
     * broadcast as a settlement.
     */
    const note = await screen.findByText(/Claim submitted/);
    expect(note.textContent).toMatch(/the record/i);
  });

  /*
   * Reported, never swallowed. A claim that failed and looked like it worked would send a
   * seller away from the one screen that could have told them the money is still in the
   * escrow and the window is finite.
   */
  it('surfaces a rejected signature instead of failing quietly', async () => {
    sendTransaction.mockRejectedValue(new Error('User rejected the request'));
    render(<ClaimPayout lock={lock()} />);
    fireEvent.click(screen.getByRole('button'));

    const failure = await screen.findByText(/did not go through/);
    expect(failure.textContent).toContain('User rejected the request');
  });

  it('does not ask for a second signature while one is outstanding', async () => {
    let release: ((hash: string) => void) | undefined;
    sendTransaction.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );

    render(<ClaimPayout lock={lock()} />);
    const button = screen.getByRole('button');
    fireEvent.click(button);
    await vi.waitFor(() => expect(button.textContent).toMatch(/Waiting for your signature/));

    fireEvent.click(button);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    release?.('0xabc');
  });
});

describe('a lock whose window has closed', () => {
  /*
   * The capital can be reclaimed to the buyer once the window passes, and `reclaimPayout` is
   * deliberately not wired — recovering a stranded lock is an operator action. The copy has
   * to say that rather than implying the seller can still collect or that something
   * automatic will happen.
   */
  const expired = lock({ claimableUntil: '2020-01-01T00:00:00.000Z' });

  it('disables the button rather than offering a claim that reverts', () => {
    render(<ClaimPayout lock={expired} />);
    const button = screen.getByRole('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toMatch(/window has closed/i);
  });

  it('says recovery is an operator action, not an automatic one', () => {
    render(<ClaimPayout lock={expired} />);
    expect(screen.getByText(/operator action, not an automatic one/i)).toBeDefined();
  });

  /* A null window is open-ended, not expired. Treating absent as past would hide a live claim. */
  it('treats an absent deadline as open rather than closed', () => {
    render(<ClaimPayout lock={lock({ claimableUntil: null })} />);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
  });
});
