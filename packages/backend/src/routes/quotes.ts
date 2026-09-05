/**
 * The live quote.
 *
 * `GET /invoices/:id/quote` returns the price that is already there — not a price the
 * seller requested. The number moves as the curve moves and as the due date approaches,
 * so this route is cheap, uncached at the edge, and safe to poll.
 *
 * It returns refusals alongside the quote. A mandate that will not take this paper is a
 * product output, not an omission: the funder is told why in words rather than by a
 * reverted transaction, and every refusal carries an HCS receipt the rejected party can
 * check without trusting the venue.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../middleware/context.js';
import { materialiseQuote, quoteEngine } from '../services/quote-engine.js';
import { readParams, readQuery } from '../validate.js';
import { wireQuote, wireRefusalReceipt } from '../wire.js';

export const quoteRoutes = new Hono<AppEnv>();

const quoteQuery = z.object({
  /** Price the invoice as of a given instant. Used to show how the price seasons. */
  asOf: z.iso.datetime().optional(),
  /** Refusals are on by default; the book view turns them off to keep rows small. */
  includeRefusals: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

quoteRoutes.get('/invoices/:id/quote', async (c) => {
  const { id } = readParams(c, z.object({ id: z.uuid() }));
  const { asOf, includeRefusals } = readQuery(c, quoteQuery);

  const pricedAt = asOf ? new Date(asOf) : new Date();
  const live = await quoteEngine.priceOne(id, pricedAt);

  /*
   * The quote gets an id here, and only here. A trade is executed against a `quoteId`
   * because the seller must never be filled at a price they were not shown, so the number
   * on this screen has to be referable afterwards. An identical unexpired quote is reused
   * rather than rewritten, so polling this route stays cheap.
   */
  const quoteId =
    live.quote === null
      ? null
      : await materialiseQuote(live.invoiceId, live.rating, live.quote, pricedAt);

  /*
   * `Quote` and the refusal operands are `bigint` minor units in the domain, and
   * `JSON.stringify` throws on a `bigint` rather than guessing a representation. Both are
   * rendered through `src/wire.ts`, which is the only place in this service that decides
   * how an amount looks on the wire.
   */
  return c.json({
    invoiceId: live.invoiceId,
    rating: live.rating,
    tenorDays: live.tenorDays,
    /** null when nothing on the curve will take this paper today. */
    quote: live.quote === null ? null : wireQuote(live.quote),
    /** The handle `POST /v1/trades` is executed against. Null whenever `quote` is. */
    quoteId,
    /** Everything screened, matches and refusals together. */
    mandatesConsidered: live.candidatesConsidered,
    /** "three mandates would take this" comes from here. */
    mandatesMatching: live.matchesAvailable,
    /**
     * Bids the instrument itself will not let their buyer hold.
     *
     * On the wire because the alternative is a seller reading "no bid" when the truth is
     * "this instrument is not ready for the buyers who wanted it" — a different problem with
     * a different fix, and the difference is the venue's to state rather than the seller's to
     * guess. Not a refusal: the bid did not decline the paper, the paper declined the bid.
     */
    mandatesBarredByInstrument: live.excludedByCompliance,
    refusals: includeRefusals ? live.refusals.map(wireRefusalReceipt) : undefined,
    pricedAt: live.pricedAt,
  });
});
