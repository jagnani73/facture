/**
 * Buyer-facing routes.
 *
 * A funder never scrolls through invoices deciding one at a time. They write a mandate —
 * any invoice, customer rated A or better, ninety days or less, at 8.0% annualised, up to
 * $200,000 total and $50,000 per customer — fund it, and walk away.
 *
 * Funding is what makes a quote firm. A mandate matches only up to its unallocated
 * balance, so overcommitment has a structural answer rather than a patch, and two invoices
 * arriving against one mandate resolve without a race.
 */

import { MANDATE_STATUSES } from '@facture/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { notImplemented } from '../errors.js';
import type { AppEnv } from '../middleware/context.js';
import { readJson, readParams, readQuery } from '../validate.js';
import { moneyString } from '../wire.js';

const uuidParam = z.object({ id: z.uuid() });

const createMandateBody = z.object({
  buyerId: z.uuid(),
  /**
   * Lowest customer grade this mandate will take. `UNRATED` is the widest floor on offer:
   * it accepts cold starts and still refuses `D`, because on shared's scale a default
   * ranks below no history at all. `D` is deliberately not selectable — a floor that
   * accepts a customer already known to default is not a bid anyone means to write.
   */
  ratingFloor: z.enum(['UNRATED', 'C', 'B', 'A']),
  maxTenorDays: z.number().int().min(1).max(365),
  annualisedYieldBps: z.number().int().min(1).max(10_000),
  currency: z
    .string()
    .length(3)
    .transform((v) => v.toUpperCase()),
  exposureLimitMinor: moneyString,
  /** Concentration cap. Absent means the total limit is the only cap. */
  perDebtorLimitMinor: moneyString.optional(),
});

const fundMandateBody = z.object({
  amountMinor: moneyString,
  /** Escrow reference for the deposit, so funding is provable in the proof view. */
  escrowRef: z.string().min(1).max(200),
});

const withdrawBody = z.object({
  /** Absent withdraws the whole unallocated balance. Allocated capital never moves. */
  amountMinor: moneyString.optional(),
});

const listMandatesQuery = z.object({
  buyerId: z.uuid(),
  status: z.enum(MANDATE_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const mandateRoutes = new Hono<AppEnv>();

mandateRoutes.post('/', async (c) => {
  const body = await readJson(c, createMandateBody);
  // TODO: INSERT as `draft`. A mandate is not on the curve until it is funded — an
  // unfunded bid would make the quote soft, which is the one thing the product cannot
  // afford.
  throw notImplemented(`mandate creation for buyer ${body.buyerId}`);
});

mandateRoutes.get('/', (c) => {
  const query = readQuery(c, listMandatesQuery);
  // TODO: mandates for this buyer with funded / allocated / unallocated per row.
  throw notImplemented(`mandate listing for buyer ${query.buyerId}`);
});

/**
 * Exposure across the buyer's whole book: committed, allocated, unallocated, and the
 * concentration per debtor. This is the screen a credit desk actually watches.
 *
 * Registered before `/:id/...` so the static segment cannot be swallowed by a param.
 */
mandateRoutes.get('/exposure', (c) => {
  const query = readQuery(c, z.object({ buyerId: z.uuid() }));
  // TODO: aggregate over mandates JOIN trades, grouped by debtor and by rating bucket.
  throw notImplemented(`exposure summary for buyer ${query.buyerId}`);
});

/** Escrow the capital. This is the moment the bid becomes firm. */
mandateRoutes.post('/:id/fund', async (c) => {
  const { id } = readParams(c, uuidParam);
  const body = await readJson(c, fundMandateBody);
  // TODO: verify the deposit landed, then `funded_minor += amount` and status -> funded
  // in one transaction. Never trust the client's amount over the escrow record.
  throw notImplemented(`funding mandate ${id} with ${body.amountMinor}`);
});

/**
 * Withdraw unallocated capital. Allocated capital is committed against trades in flight
 * and is not withdrawable — that is what "firm" means.
 */
mandateRoutes.post('/:id/withdraw', async (c) => {
  const { id } = readParams(c, uuidParam);
  const body = await readJson(c, withdrawBody);
  // TODO: `SELECT ... FOR UPDATE` on the mandate, clamp to funded - allocated, release
  // from escrow, decrement. A withdrawal racing a match must lose to the match.
  throw notImplemented(`withdrawal from mandate ${id} of ${body.amountMinor ?? 'all unallocated'}`);
});

/** Per-mandate exposure detail. */
mandateRoutes.get('/:id/exposure', (c) => {
  const { id } = readParams(c, uuidParam);
  // TODO: this mandate's allocations by debtor, against its own limits.
  throw notImplemented(`exposure detail for mandate ${id}`);
});
