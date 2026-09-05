'use client';

import { useSendTransaction, useWallets } from '@privy-io/react-auth';
import { useState } from 'react';
import { encodeFunctionData } from 'viem';

import type { CashLegLock } from '@/lib/api/contract';
import { formatUsdc } from '@/lib/format';
import { buttonClasses } from '@/components/ui/primitives';

/**
 * The one transaction this app asks a person to sign, and the only reason Privy needs a
 * chain declared at all.
 *
 * A sale settled out of the buyer's escrow does not put money in the seller's wallet. It puts
 * it in a `DvpEscrow` lock, and `claim` checks `msg.sender == beneficiary` — so **the venue
 * cannot collect on the seller's behalf even though it holds the preimage.** The tests in
 * `packages/contracts` assert exactly that: the attester, holding the public secret, is
 * refused with `NotBeneficiary`.
 *
 * That makes this the one place a seller's own key is load-bearing, and the key is the one
 * Privy made when they signed in with an email address. Everything else a seller does here is
 * still signature-free: they do not sign to list, to be matched, or to sell.
 *
 * ## Why the preimage is on the page at all
 *
 * It is not a credential. `claim` needs the caller AND the hash, so the secret alone moves
 * nothing — the escrow's own note says the hashlock "does not keep anyone out" and that the
 * protection is the beneficiary binding. `claim` then writes the preimage to storage in the
 * clear, because that log is how the other chain learns it. Publishing it costs nothing and
 * withholding it once cost a payout: it used to be returned exactly once, in the settlement
 * response, so a dropped connection left money nobody could ever claim.
 */

const ESCROW_ABI = [
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'lockId', type: 'bytes32' },
      { name: 'secret', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

/** What the button can be doing. `sent` is terminal here — the escrow is the record. */
type Stage = 'idle' | 'signing' | 'sent' | 'failed';

export function ClaimPayout({ lock }: { lock: CashLegLock }) {
  const { wallets } = useWallets();
  const { sendTransaction } = useSendTransaction();
  const [stage, setStage] = useState<Stage>('idle');
  const [detail, setDetail] = useState<string | null>(null);

  /*
   * Everything below is a reason this button must not be offered, and each is a different
   * fact rather than one absent value. Rendering a claim the viewer cannot make would be
   * worse than rendering none: it invites a signature that reverts.
   */
  if (lock.status === 'claimed') return null;
  if (lock.status === 'refunded') return null;
  if (lock.secret === null || lock.escrowAddress === null || lock.beneficiary === null) {
    return null;
  }

  /*
   * Only the beneficiary. Compared case-insensitively because one side is a checksummed
   * address off the chain and the other is whatever Privy reports, and an address that
   * differs only in case is the same account.
   */
  const claimant = wallets.find((w) => w.address.toLowerCase() === lock.beneficiary?.toLowerCase());
  if (!claimant) return null;

  const expired = lock.claimableUntil !== null && new Date(lock.claimableUntil) <= new Date();

  async function claim() {
    setStage('signing');
    setDetail(null);
    try {
      const hash = await sendTransaction({
        to: lock.escrowAddress as `0x${string}`,
        data: encodeFunctionData({
          abi: ESCROW_ABI,
          functionName: 'claim',
          args: [lock.lockId as `0x${string}`, lock.secret as `0x${string}`],
        }),
      });
      setStage('sent');
      setDetail(typeof hash === 'string' ? hash : (hash?.hash ?? null));
    } catch (error) {
      /*
       * Reported, never swallowed. A claim that failed and looked like it worked would send
       * a seller away from the one screen that could have told them the money is still in
       * the escrow and the window is finite.
       */
      setStage('failed');
      setDetail(error instanceof Error ? error.message : String(error));
    }
  }

  if (stage === 'sent') {
    return (
      <p className="mt-3 text-xs text-pos">
        Claim submitted{detail ? ` — ${detail.slice(0, 18)}…` : ''}. The escrow is the record: this
        row reads <span className="num">claimed</span> once it confirms.
      </p>
    );
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => void claim()}
        disabled={stage === 'signing' || expired}
        className={buttonClasses('primary', 'sm')}
      >
        {stage === 'signing'
          ? 'Waiting for your signature…'
          : expired
            ? 'The claim window has closed'
            : `Claim ${lock.amountMinor === null ? 'your payout' : formatUsdc(lock.amountMinor)}`}
      </button>
      <p className="mt-2 text-xs text-muted">
        {expired
          ? 'This lock has timed out, so the capital can be reclaimed to the buyer. That is an operator action, not an automatic one.'
          : 'Sent from your own wallet — the escrow checks the caller, so nobody can collect this for you. Gas on Arc is USDC.'}
      </p>
      {stage === 'failed' && detail !== null ? (
        <p className="mt-2 text-xs text-neg">The claim did not go through: {detail}</p>
      ) : null}
    </div>
  );
}
