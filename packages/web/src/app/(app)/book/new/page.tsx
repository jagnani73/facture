import type { Metadata } from 'next';

import { NewInvoicesView } from '@/components/views/new-invoices-view';

export const metadata: Metadata = {
  title: 'Add invoices',
  description: 'Add invoices one at a time, or paste them straight out of a spreadsheet.',
};

export default function NewInvoicePage() {
  return <NewInvoicesView />;
}
