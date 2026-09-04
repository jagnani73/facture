import type { Metadata } from 'next';

import { MandatesView } from '@/components/views/mandates-view';

export const metadata: Metadata = {
  title: 'Mandates',
  description: 'Standing bids, exposure used, weighted yield and a maturity ladder.',
};

export default function MandatesPage() {
  return <MandatesView />;
}
