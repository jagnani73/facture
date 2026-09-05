'use client';

import { PrivyProvider } from '@privy-io/react-auth';
import type { ReactNode } from 'react';

import { PRIVY_APP_ID, signInAvailable } from '@/lib/api/config';

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
 * ## No chains are declared, on purpose
 *
 * An EVM address is derived from the key, so the address Privy issues is the same address on
 * every EVM chain — which is the only thing this integration uses it for. Declaring Hedera
 * or Arc here would suggest this app transacts from that wallet, and it does not: the asset
 * leg is placed by the venue's operator, and the cash leg is a native Hedera transfer that
 * an EVM signer cannot produce at all. Configuring chains for transactions that do not
 * happen would be decoration with a false implication attached.
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
        appearance: { walletChainType: 'ethereum-only' },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
