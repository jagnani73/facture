/**
 * Trades: the sale itself.
 *
 * Face $40,000, sixty days, 8.0%, discount $820, proceeds $39,180. Confirm, and it settles
 * against the best mandate that accepts this customer, accepts this tenor, and has
 * exposure left.
 *
 * Non-recourse and a full advance. The risk being priced is the customer's, because the
 * mandate was written against the customer's rating — so the buyer carries the loss if the
 * customer does not pay. There is no holdback, because debtor confirmation already removed
 * the dispute risk a holdback exists to cover.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { notImplemented } from '../errors.js';
import type { AppEnv } from '../middleware/context.js';
import { readJson, readParams, readQuery } from '../validate.js';

const executeTradeBody = z.object({
  invoiceId: z.uuid(),
  /**
   * The quote the seller actually saw. Required, not optional: the curve moves, and a
   * seller must never be filled at a price they were not shown.
   */
  quoteId: z.uuid(),
  /**
   * Belt and braces on top of `quoteId` — reject if the engine now prices this outside
   * the tolerance the seller accepted, in basis points.
   */
  maxSlippageBps: z.number().int().min(0).max(500).default(0),
});

const listTradesQuery = z
  .object({
    sellerId: z.uuid().optional(),
    buyerId: z.uuid().optional(),
    status: z.enum(['preparing', 'awaiting_payment', 'settled', 'unwound', 'failed']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine((q) => q.sellerId !== undefined || q.buyerId !== undefined, {
    message: 'one of sellerId or buyerId is required',
  });

export const tradeRoutes = new Hono<AppEnv>();

/**
 * Execute a sale. The ordering matters and is the whole argument against doing this on an
 * AMM: compliance is checked BEFORE the match, so an ineligible counterparty is never
 * matched and the refusal is a first-class output rather than a revert.
 */
tradeRoutes.post('/', async (c) => {
  const body = await readJson(c, executeTradeBody);
  // TODO:
  //  1. re-price and compare against the accepted quote inside `maxSlippageBps`;
  //  2. `SELECT ... FOR UPDATE` the mandate and reserve against unallocated balance;
  //  3. `settlementService.prepare` — ATS hold placed, x402 requirements built;
  //  4. return 402 carrying `PAYMENT-REQUIRED` so the buyer signs the cash leg;
  //  5. on `PAYMENT-SIGNATURE`, `settlementService.execute` and return the settled trade.
  // Steps 3–5 are one DvP: if the cash leg never arrives, the hold expires and the
  // seller's position was never encumbered beyond the challenge window.
  throw notImplemented(`trade execution for invoice ${body.invoiceId}`);
});

tradeRoutes.get('/', (c) => {
  const query = readQuery(c, listTradesQuery);
  // TODO: keyset page, filtered to whichever side asked.
  throw notImplemented(`trade listing for ${query.sellerId ?? query.buyerId}`);
});

tradeRoutes.get('/:id', (c) => {
  const { id } = readParams(c, z.object({ id: z.uuid() }));
  // TODO: the trade plus both legs' current state. The audit detail is one click away at
  // `/v1/trades/:id/proof` — see `routes/proof.ts`.
  throw notImplemented(`trade detail for ${id}`);
});
