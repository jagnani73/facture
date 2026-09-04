import type { Metadata } from 'next';

import { InvoiceDetailView } from '@/components/views/invoice-detail-view';
import { loadInvoiceLabel } from '@/lib/data';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}): Promise<Metadata> {
  const { invoiceId } = await params;
  const label = await loadInvoiceLabel(invoiceId);
  return {
    title: label ? `${label.invoiceNumber} · ${label.customer}` : 'Invoice',
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
