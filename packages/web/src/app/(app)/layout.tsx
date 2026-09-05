import type { ReactNode } from 'react';

import { AppShell } from '@/components/app-shell';
import { FacturePrivyProvider } from '@/components/privy-provider';

/**
 * Chrome for the market screens. The debtor confirmation page deliberately sits
 * outside this group: a customer being asked to acknowledge their own accounts
 * payable should not be shown a masthead of bid prices.
 *
 * Sign-in is mounted here for the same reason and it matters more. A debtor confirms
 * without a wallet and without an account, and that is the behavioural argument the
 * product rests on - give them a key to manage and it collapses. Keeping the auth
 * provider inside this group is what stops it ever reaching them.
 */
export default function MarketLayout({ children }: { children: ReactNode }) {
  return (
    <FacturePrivyProvider>
      <AppShell>{children}</AppShell>
    </FacturePrivyProvider>
  );
}
