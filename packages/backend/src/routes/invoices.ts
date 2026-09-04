/**
 * Seller-facing routes, plus the one public route the debtor hits.
 *
 * The seller's journey: add invoices (each becomes an instrument immediately, queued and
 * paced), request confirmation from the customer, watch grey turn green, and see a price
 * beside every green line.
 *
 * Debtor confirmation is load-bearing and is deliberately the lightest thing in the
 * product. The customer gets a link carrying one sentence and two buttons — no wallet, no
 * signup, no account. It works where attestation schemes usually do not for a behavioural
 * reason rather than a cryptographic one: the debtor is not vouching for a stranger, they
 * are acknowledging their own accounts payable, which costs them nothing and which they
 * have no incentive to deny. Confirmation is also what removes dispute risk at listing,
 * which is what buys the seller a full advance instead of a 10–20% holdback.
 */

import { INVOICE_STATUSES } from '@facture/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { notImplemented } from '../errors.js';
import type { AppEnv } from '../middleware/context.js';
import { readJson, readParams, readQuery } from '../validate.js';
import { moneyString } from '../wire.js';

const uuidParam = z.object({ id: z.uuid() });

const createInvoiceBody = z.object({
  sellerId: z.uuid(),
  debtor: z.object({
    /** Reuses an existing debtor when the email already exists — ratings are per debtor. */
    name: z.string().min(1).max(200),
    email: z.email(),
    taxId: z.string().min(1).max(64).optional(),
  }),
  invoiceNumber: z.string().min(1).max(64),
  /** Minor units as a decimal string, parsed to `bigint`. See `src/wire.ts`. */
  faceValue: moneyString,
  currency: z
    .string()
    .length(3)
    .transform((v) => v.toUpperCase()),
  issuedAt: z.iso.datetime(),
  dueAt: z.iso.datetime(),
});

const listInvoicesQuery = z.object({
  sellerId: z.uuid(),
  /** The domain union from `@facture/shared`, so the filter cannot drift from the column. */
  status: z.enum(INVOICE_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

const confirmationDecisionBody = z.object({
  decision: z.enum(['confirmed', 'disputed']),
  /** Required when disputing: the seller needs to know what to fix. */
  note: z.string().min(1).max(500).optional(),
});

export const invoiceRoutes = new Hono<AppEnv>();

/**
 * Create an invoice. Tokenisation happens here, at onboarding, not at the moment of sale
 * — issuance is never on the critical path of the moment money moves.
 */
invoiceRoutes.post('/', async (c) => {
  const body = await readJson(c, createInvoiceBody);
  // TODO:
  //  1. upsert the debtor on email;
  //  2. `uniquenessHash(debtorId, invoiceNumber, faceValue)` from shared, INSERT with the
  //     unique index doing the work — a duplicate raises `duplicateReceivable`, which is
  //     the whole point of the registry;
  //  3. `isinForInvoice(uniquenessHash)` from shared, NOT `generateIsin` directly: the ISIN
  //     is seeded from the uniqueness hash so the two identifiers cannot disagree about
  //     which invoice they describe. ATS `onlyValidISIN` rejects arbitrary strings;
  //  4. `getIssuanceQueue().enqueue(...)` and return 202 with `issuance.state = queued`.
  //     The book shows the invoice as *being added* until its instrument exists.
  throw notImplemented(`invoice creation for seller ${body.sellerId}`);
});

/** The seller's book. Every row carries a live price; see `routes/quotes.ts`. */
invoiceRoutes.get('/', (c) => {
  const query = readQuery(c, listInvoicesQuery);
  // TODO: keyset page over invoices for this seller, then `quoteEngine.priceBook` in one
  // batched pass. Not N calls to `priceOne`.
  throw notImplemented(`invoice listing for seller ${query.sellerId}`);
});

invoiceRoutes.get('/:id', (c) => {
  const { id } = readParams(c, uuidParam);
  // TODO: invoice + debtor + rating + issuance status + live quote. Issuance status comes
  // from `getIssuanceQueue().status(id)` when in memory, falling back to the invoice row.
  throw notImplemented(`invoice detail for ${id}`);
});

/**
 * Ask the customer to confirm. Mints a single-use token, stores only its SHA-256, and
 * emails `${PUBLIC_BASE_URL}/v1/confirm/{token}`.
 */
invoiceRoutes.post('/:id/confirmation-request', (c) => {
  const { id } = readParams(c, uuidParam);
  // TODO: generate 32 bytes of entropy, HMAC with CONFIRMATION_TOKEN_SECRET, store the
  // hash + expiry (CONFIRMATION_TOKEN_TTL_HOURS), send the email, set the invoice to
  // `awaiting_confirmation`. Re-requesting invalidates the previous token.
  throw notImplemented(`confirmation request for invoice ${id}`);
});

/**
 * The public, token-authenticated confirmation surface. Mounted separately at `/confirm`
 * so nothing here sits behind seller or buyer auth.
 *
 * The token IS the authentication. There is no session, and there must never be a signup
 * wall in front of these two handlers — the moment a debtor has to create an account, the
 * behavioural argument that makes confirmation work stops holding.
 */
export const confirmationRoutes = new Hono<AppEnv>();

/** What the debtor sees: one sentence and two buttons. */
confirmationRoutes.get('/:token', (c) => {
  const { token } = readParams(c, z.object({ token: z.string().min(20).max(200) }));
  // TODO: look up by SHA-256 of the token, reject expired or already-decided, and return
  // exactly the sentence — "{seller} says you owe them {amount}, due {date}. Is that
  // right?" Nothing about tokens, chains or the buyer is exposed here.
  throw notImplemented(`confirmation prompt for token …${token.slice(-6)}`);
});

confirmationRoutes.post('/:token', async (c) => {
  const { token } = readParams(c, z.object({ token: z.string().min(20).max(200) }));
  const body = await readJson(c, confirmationDecisionBody);
  // TODO: single-use — consume the token in the same transaction that writes the
  // decision. `confirmed` moves the invoice to `confirmed` (grey turns green, and it now
  // has a price); `disputed` moves it to `disputed` and it never becomes listable.
  throw notImplemented(`confirmation decision ${body.decision} for token …${token.slice(-6)}`);
});
