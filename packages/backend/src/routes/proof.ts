/**
 * The proof view.
 *
 * Nobody using Facture needs to know it is on a blockchain. A seller sees invoices with
 * prices beside them; a buyer sees mandates, exposure and yield. The chains surface in
 * exactly one place, and this is it: one click from any trade, showing the on-chain
 * receipts, the compliance decision and both settlement legs.
 *
 * The response is deliberately link-heavy. Every claim it makes should be checkable by
 * the reader against HashScan or Arcscan without trusting this service — that is the
 * difference between an audit view and a receipt we printed ourselves.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { notImplemented } from '../errors.js';
import type { AppEnv } from '../middleware/context.js';
import { readParams } from '../validate.js';

/** The exact shape the proof screen renders. Every field is independently verifiable. */
export interface TradeProof {
  tradeId: string;
  invoice: {
    id: string;
    invoiceNumber: string;
    /** hash(debtor, invoice number, amount) — one receivable, one instrument, ever. */
    uniquenessHash: string;
    isin: string | null;
    /** The ATS zero-coupon bond. Maturity = due date, principal = face, rate = 0. */
    securityId: string | null;
    securityExplorerUrl: string | null;
  };
  /** How the debtor acknowledged their own accounts payable. */
  confirmation: {
    decision: 'confirmed' | 'disputed' | null;
    decidedAt: string | null;
  };
  /**
   * The pre-match decision, taken against the security's own ControlList and Kyc facets
   * before matching — not at settlement.
   */
  compliance: {
    decision: Record<string, unknown> | null;
    checkedAt: string | null;
    hcsTopicId: string | null;
    hcsSequenceNumber: string | null;
    hcsExplorerUrl: string | null;
  };
  /**
   * The quote this trade filled at, frozen. Amounts are decimal strings in minor units —
   * see `src/wire.ts`, which owns that convention for the whole service.
   *
   * NOTE: `discountMinor`/`proceedsMinor` still carry the old suffix, unlike `faceValue`.
   * The domain names in `@facture/shared` are `Quote.discount` and `Quote.proceeds`, and
   * the columns behind them are `discount_minor`/`proceeds_minor`, so these three fields
   * should be unified the same way `faceMinor -> faceValue` was. Left as-is here only
   * because the rename was scoped to face value.
   */
  pricing: {
    ratingAtQuote: string;
    tenorDays: number;
    annualisedYieldBps: number;
    faceValue: string;
    discountMinor: string;
    proceedsMinor: string;
  };
  /** Asset leg: the ATS hold, then its execution. Hedera. */
  assetLeg: {
    chain: 'hedera';
    holdId: string | null;
    transactionId: string | null;
    consensusAt: string | null;
    explorerUrl: string | null;
  };
  /** Cash leg: the x402 payment. Arc, or Hedera when settling in HBAR. */
  cashLeg: {
    chain: 'arc' | 'hedera';
    scheme: string | null;
    network: string | null;
    asset: string | null;
    transaction: string | null;
    payer: string | null;
    explorerUrl: string | null;
  };
  /** Refusals recorded while pricing this invoice. Kept for the funders who were told no. */
  refusals: {
    mandateId: string;
    reasonCode: string;
    reasonText: string;
    hcsExplorerUrl: string | null;
  }[];
  settledAt: string | null;
}

export const proofRoutes = new Hono<AppEnv>();

proofRoutes.get('/trades/:id/proof', (c) => {
  const { id } = readParams(c, z.object({ id: z.uuid() }));
  // TODO: one read across trades / invoices / quotes / refusal_receipts, then decorate
  // with `explorer.*` from `src/chain.ts`. Do not synthesise any link whose underlying
  // identifier is null — an explorer URL that 404s is worse than an absent one.
  throw notImplemented(`proof view for trade ${id}`);
});
