import type { Metadata } from 'next';

import { InvoiceDetailView } from '@/components/views/invoice-detail-view';
import { debtorNameOf, getInvoice } from '@/lib/fixtures';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}): Promise<Metadata> {
  const { invoiceId } = await params;
  const invoice = getInvoice(invoiceId);
  return {
    title: invoice ? `${invoice.invoiceNumber} · ${debtorNameOf(invoice)}` : 'Invoice',
  };
}

/**
 * Thin server shell. The view owns its own data so that no `bigint` has to
 * cross the server/client boundary.
 */
export default async function InvoicePage({ params }: { params: Promise<{ invoiceId: string }> }) {
  const { invoiceId } = await params;
  return <InvoiceDetailView invoiceId={invoiceId} />;
}
