import type { Metadata } from 'next';

import { ConfirmView } from '@/components/views/confirm-view';

export const metadata: Metadata = {
  title: 'Confirm an invoice',
  description: 'Confirm that an invoice you have been sent is correct.',
  robots: { index: false, follow: false },
};

/**
 * Deliberately outside the market layout. No masthead, no bid prices, no nav —
 * the reader is not a user of this market and should never have to become one.
 */
export default async function ConfirmPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ConfirmView token={token} />;
}
