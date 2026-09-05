/**
 * The demo book, behind the seam.
 *
 * Nothing in `src/lib/fixtures.ts` changed when the API client landed. It is still the
 * same book, still derived rather than typed in — outlays priced with the shared pricer,
 * allocations summed from actual positions, uniqueness hashes and ISINs computed exactly
 * as the registry would — and it is still what renders when no service is configured. That
 * matters for more than convenience: the two invoices that carry no bid, and the one that
 * clears at 18.5% because only the widest mandate on the book will touch it, are
 * consequences of this data rather than copy, and they are checkable on a laptop with
 * nothing else running.
 *
 * Prices here are computed with the same `bestQuote` the venue matches on, so the demo
 * book and the live book disagree about nothing except which rows are in them.
 */

import { bestQuote } from '@/lib/domain';
import { ASSET_CHAIN, CASH_CHAIN, CHAINS } from '@/lib/domain';
import type { Invoice } from '@/lib/domain';
import { formatMoney } from '@/lib/format';
import * as fixtures from '@/lib/fixtures';
import type { ConfirmationRecord, InvoicePricing, Market, ProofRecord } from './types';
import { buildMarket } from './types';

function priceEverything(asOf: Date): Map<string, InvoicePricing> {
  const priced = new Map<string, InvoicePricing>();

  for (const invoice of fixtures.invoices) {
    const result = bestQuote(invoice, fixtures.mandates, fixtures.debtorFor(invoice), { asOf });

    priced.set(invoice.id, {
      invoiceId: invoice.id,
      rating: fixtures.ratingOf(invoice),
      tenorDays: result.tenorDays,
      quote: result.quote,
      // The demo book has no venue to hold a quote reference, and the sale says so.
      quoteId: null,
      matches: result.matches.map((match) => ({ mandate: match.mandate, quote: match.quote })),
      matchCount: result.matches.length,
      candidatesConsidered: result.matches.length + result.refusals.length,
      refusals: result.refusals,
      pricedAt: result.asOf,
    });
  }

  return priced;
}

let cached: Market | null = null;

/**
 * Built once. The clock is frozen at `MARKET_NOW`, so there is nothing to invalidate — and
 * a stable object means the server's HTML and the browser's first paint are identical and
 * hydration stays quiet.
 */
export function fixtureMarket(): Market {
  if (cached) return cached;

  const asOf = fixtures.marketNow();

  cached = buildMarket({
    source: 'fixtures',
    asOf,
    seller: { id: fixtures.seller.id, name: fixtures.seller.name },
    viewer: { id: fixtures.viewer.buyerId, name: fixtures.viewer.name },
    invoices: fixtures.invoices,
    debtors: fixtures.debtors,
    mandates: fixtures.mandates,
    positions: fixtures.positions,
    trades: fixtures.trades,
    pricing: priceEverything(asOf),
    meta: new Map(Object.entries(fixtures.mandateMeta)),
    tokens: new Map(
      Object.entries(fixtures.confirmationTokens).map(([token, invoiceId]) => [invoiceId, token]),
    ),
    notices: [],
    debtorHistoryKnown: true,
  });

  return cached;
}

/* -------------------------------------------------------------------------- */
/* Debtor confirmation                                                         */
/* -------------------------------------------------------------------------- */

export function fixtureConfirmation(token: string): ConfirmationRecord | null {
  const invoice: Invoice | undefined = fixtures.invoiceForToken(token);
  if (!invoice) return null;

  return {
    sellerName: fixtures.seller.name,
    debtorName: fixtures.debtorNameOf(invoice),
    invoiceNumber: invoice.invoiceNumber,
    amount: formatMoney(invoice.faceValue),
    faceValue: invoice.faceValue,
    dueAt: invoice.dueAt,
    decision: invoice.status === 'disputed' ? 'disputed' : null,
  };
}

/* -------------------------------------------------------------------------- */
/* The proof view                                                              */
/* -------------------------------------------------------------------------- */

const HEDERA = CHAINS[ASSET_CHAIN];

export function fixtureProof(tradeId: string): ProofRecord | null {
  const trade = fixtures.getTrade(tradeId);
  const proof = fixtures.getTradeProof(tradeId);
  if (!trade || !proof) return null;

  const invoice = fixtures.getInvoice(trade.invoiceId);
  const meta = fixtures.metaOf(trade.mandateId);

  return {
    tradeId: trade.id,
    trade,
    instrument: {
      tokenId: proof.instrument.tokenId,
      isin: proof.instrument.isin,
      uniquenessHash: invoice?.uniquenessHash ?? null,
      regulation: proof.instrument.regulation,
      maturity: proof.instrument.maturity,
      issuedAt: proof.instrument.issuedAt,
      issuedTxId: proof.instrument.issuedTxId,
      explorerUrl: `${HEDERA.explorerUrl}/token/${proof.instrument.tokenId}`,
    },
    confirmation: {
      decision: invoice?.status === 'disputed' ? 'disputed' : 'confirmed',
      decidedAt: proof.instrument.issuedAt,
    },
    compliance: {
      allowed: proof.compliance.decision === 'allowed',
      checkedAt: proof.compliance.checkedAt,
      checks: proof.compliance.checks,
      // The demo book has no refused trade, so there is no failed check to name.
      reason: null,
      hcsTopicId: proof.compliance.receiptTopicId,
      hcsSequenceNumber: String(proof.compliance.receiptSequence),
      hcsExplorerUrl: `${HEDERA.explorerUrl}/topic/${proof.compliance.receiptTopicId}`,
    },
    assetLeg: {
      from: proof.assetLeg.from,
      to: proof.assetLeg.to,
      quantity: proof.assetLeg.quantity,
      transactionId: trade.assetLeg.reference ?? null,
      holdId: null,
      consensusAt: proof.compliance.consensusTimestamp,
      explorerUrl: null,
    },
    cashLeg: {
      // The demo book's cash leg is USDC on Arc, which is what its trades say.
      chain: CASH_CHAIN,
      from: proof.cashLeg.from,
      to: proof.cashLeg.to,
      asset: proof.cashLeg.asset,
      scheme: null,
      network: null,
      transaction: trade.cashLeg.reference ?? null,
      explorerUrl: null,
    },
    /*
     * Null, and deliberately not invented. The fixture book carries no matured receivable
     * with a real scheduled payout behind it, and a fabricated schedule id on the one screen
     * whose job is being checkable would point at nothing on HashScan.
     */
    payout: null,
    settlement: {
      protocol: proof.settlement.protocol,
      scheme: null,
      network: null,
      facilitator: proof.settlement.facilitator,
      challengeNonce: proof.settlement.challengeNonce,
      boundAt: proof.settlement.boundAt,
      note: proof.settlement.note,
    },
    // The demo book's two trades both settled cleanly, so no funder was told no on them.
    refusals: [],
    invoiceNumber: invoice?.invoiceNumber ?? null,
    debtorName: invoice ? fixtures.debtorNameOf(invoice) : null,
    sellerName: fixtures.seller.name,
    buyerName: meta.ownerName,
    settledAt: trade.settledAt ?? null,
  };
}
