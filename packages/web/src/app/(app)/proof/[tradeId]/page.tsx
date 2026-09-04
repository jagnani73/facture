import type { Metadata } from 'next';

import { ProofView } from '@/components/views/proof-view';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ tradeId: string }>;
}): Promise<Metadata> {
  const { tradeId } = await params;
  return {
    title: `Proof · ${tradeId}`,
    description: 'On-chain receipts, the compliance decision, and both settlement legs.',
  };
}

export default async function ProofPage({ params }: { params: Promise<{ tradeId: string }> }) {
  const { tradeId } = await params;
  return <ProofView tradeId={tradeId} />;
}
