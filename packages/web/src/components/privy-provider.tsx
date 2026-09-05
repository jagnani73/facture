'use client';

import { PrivyProvider } from '@privy-io/react-auth';
import type { ReactNode } from 'react';

import { PRIVY_APP_ID, signInAvailable } from '@/lib/api/config';
import { ARC_TESTNET } from '@facture/shared';

/**
 * Arc as viem's `Chain`, built from the shared table rather than typed out.
 *
 * The chain id, RPC and explorer are already facts this repo keeps in one place, and a
 * second copy here is the kind of divergence that sends a signed transaction to the wrong
 * network with nothing on screen saying so.
 */
const arcTestnet = {
  id: ARC_TESTNET.chainId,
  name: ARC_TESTNET.name,
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_TESTNET.rpcUrl] } },
  blockExplorers: { default: { name: 'ArcScan', url: ARC_TESTNET.explorerUrl } },
} as const;

/**
 * Sign-in, wrapped around the market screens only.
 *
 * It sits in the `(app)` group rather than the root layout deliberately, and the reason is
 * the same one that put `/confirm/[token]` outside that group: **a debtor has no wallet and
 * no signup, and that is load-bearing.** Confirmation works because a customer is asked to
 * acknowledge their own accounts payable through a link with one sentence and two buttons.
 * Mounting an auth provider over that page would be the first step toward giving them an
 * account to manage, which is the thing the design refuses.
 *
 * ## Unset is a supported state
 *
 * With no app id this renders its children untouched. That is not a fallback bolted on for
 * safety — it is how the demo book renders, how `pnpm dev` behaves with nothing configured,
 * and how the app behaves for anyone who has not been given a Privy key. Sign-in is an
 * addition to a working app, not a gate in front of one.
 *
 * ## Arc is declared, and Hedera is not
 *
 * This block used to say no chains were declared, on the reasoning that the app transacts
 * from no wallet: the asset leg is the venue's operator, and the x402 cash leg is a native
 * Hedera `TransferTransaction` an EVM signer cannot produce at all. **The second half of
 * that is still true and the conclusion no longer follows**, because a second cash rail
 * arrived that is an ordinary EVM transaction on Arc.
 *
 * When a sale settles out of the buyer's escrow, the proceeds land in a `DvpEscrow` lock and
 * `claim` checks `msg.sender == beneficiary` — so **the seller's own key has to send it, and
 * the venue cannot collect on their behalf even holding the preimage.** That key is the one
 * Privy made when they signed in. Declaring Arc is therefore not decoration: it is the chain
 * the one transaction this app asks a user to sign actually happens on.
 *
 * Hedera stays undeclared, and for the original reason. Nothing a Privy signer can produce
 * is useful there.
 *
 * The boundary the old comment protected still holds where it was aimed: Privy remains
 * absent from the settlement path. A seller signs nothing to sell — the venue holds the paper
 * and places the hold — and signs only to collect money already bound to their address on
 * chain, after the trade is done.
 */
export function FacturePrivyProvider({ children }: { children: ReactNode }) {
  if (!signInAvailable()) return <>{children}</>;

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        /*
         * Email only. Every other method Privy offers — wallet connect, social, passkey —
         * is a login for someone who already lives onchain, and the claim this integration
         * exists to make good on is the opposite one: a business that has never held a
         * wallet gets one made from the address it already uses.
         */
        loginMethods: ['email'],
        embeddedWallets: {
          ethereum: { createOnLogin: 'users-without-wallets' },
        },
        /*
         * Arc testnet, and only Arc. `defaultChain` and `supportedChains` are what let the
         * embedded wallet send the one transaction this app ever asks for — claiming a
         * payout out of `DvpEscrow`. Adding a chain the app never transacts on would put
         * the false implication back that this comment block spent a paragraph removing.
         */
        defaultChain: arcTestnet,
        supportedChains: [arcTestnet],
        appearance: { walletChainType: 'ethereum-only' },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
