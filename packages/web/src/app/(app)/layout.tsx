import type { ReactNode } from 'react';

import { AppShell } from '@/components/app-shell';

/**
 * Chrome for the market screens. The debtor confirmation page deliberately sits
 * outside this group: a customer being asked to acknowledge their own accounts
 * payable should not be shown a masthead of bid prices.
 */
export default function MarketLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
