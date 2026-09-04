import type { Metadata } from 'next';

import { MandateComposer } from '@/components/views/mandate-composer';

export const metadata: Metadata = {
  title: 'Write a mandate',
  description: 'A standing bid over a bucket of risk, priced as you type it.',
};

export default function NewMandatePage() {
  return <MandateComposer />;
}
