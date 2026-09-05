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

import {
  formatMinorUnits,
  INVOICE_STATUSES,
  isinForInvoice,
  uniquenessHash,
  type Currency,
} from '@facture/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { getConfig } from '../config.js';
import type { InvoiceRow, SellerRow } from '../db/schema.js';
import { getStore } from '../db/store.js';
import { rootLogger } from '../logger.js';
import { INVOICE_STATUS, getInvoiceRegistry } from '../services/invoice-registry.js';
import { claimedByAnother, getUniquenessRegistry } from '../services/uniqueness.js';
import { badRequest, conflict, duplicateReceivable, notFound } from '../errors.js';
import type { AppEnv } from '../middleware/context.js';
import {
  confirmationLink,
  confirmationTokenHash,
  isWellFormedToken,
  mintConfirmationToken,
} from '../services/confirmation.js';
import { getIssuanceQueue, issuanceJobFor } from '../services/issuance.js';
import { getNotifier } from '../services/notifier.js';
import { quoteEngine } from '../services/quote-engine.js';
import { ratingService } from '../services/rating.js';
import { settlementService } from '../services/settlement.js';
import { readJson, readOptionalJson, readParams, readQuery } from '../validate.js';
import { moneyString, wireInvoice, wireQuote, wireRefusalReceipt } from '../wire.js';

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

/**
 * The one thing maturity cannot work out for itself: when the debtor's money landed.
 *
 * The debtor pays into the venue's collection account off chain, by whatever rail they
 * already use, so this is a fact only the venue holds. It is the sole input to the
 * on-time/late call, and stating it is what stops that call being made against the clock —
 * see `settleAtMaturity`, where reading the button-press time instead used to record a
 * receivable matured a week late as a customer who paid late.
 *
 * Optional, and absent is not a synonym for "now": a receivable that is already past due is
 * refused rather than guessed at.
 */
const matureBody = z.object({
  paidAt: z.iso.datetime().optional(),
});

export const invoiceRoutes = new Hono<AppEnv>();

/**
 * Create an invoice. Tokenisation happens here, at onboarding, not at the moment of sale
 * — issuance is never on the critical path of the moment money moves.
 */
invoiceRoutes.post('/', async (c) => {
  const body = await readJson(c, createInvoiceBody);
  const store = getStore();
  const { env } = getConfig();

  const seller = await store.getSeller(body.sellerId);
  if (!seller) throw notFound(`Seller ${body.sellerId}`);

  if (Date.parse(body.dueAt) <= Date.parse(body.issuedAt)) {
    throw badRequest('An invoice cannot fall due before it was issued.');
  }

  // Reused on email, never duplicated: the rating being priced belongs to the customer,
  // and a second row for the same customer would price them as a cold start again.
  const debtor = await store.upsertDebtor({
    name: body.debtor.name,
    email: body.debtor.email,
    ...(body.debtor.taxId === undefined ? {} : { taxId: body.debtor.taxId }),
  });

  /*
   * The uniqueness registry. One receivable mints exactly one instrument, ever — selling
   * the same invoice to three financiers is the specific fraud factoring has always had.
   * The unique index does the work rather than a SELECT first: check-then-insert has a
   * window, and that window is exactly the fraud this is meant to close.
   */
  const hash = uniquenessHash(debtor.id, body.invoiceNumber, body.faceValue);

  /*
   * `isinForInvoice`, not `generateIsin`. The ISIN is seeded from the uniqueness hash, so
   * the two identifiers cannot disagree about which receivable they describe — and because
   * it is deterministic, a retried or replayed issuance produces the same one rather than
   * letting one invoice acquire two instruments.
   */
  const isin = isinForInvoice(hash);

  /*
   * Ask the chain before the database. The unique index below stops **this** venue listing a
   * receivable twice; it says nothing about the same invoice being financed somewhere else,
   * which is the fraud as it actually happens — the second financier is a different company,
   * not a second row in the first one's table. `UniquenessRegistry` is append-only, so a
   * non-zero answer here is a permanent public claim by someone.
   *
   * An unreachable registry does not block listing: the venue falls back to the guarantee it
   * has always had. That is a real reduction in strength, which is why it is `checked: false`
   * rather than a clean answer — see `services/uniqueness.ts`.
   */
  const claimed = await getUniquenessRegistry().lookup(hash);
  if (claimedByAnother(claimed, null)) {
    throw duplicateReceivable(hash);
  }

  const row = await store.insertInvoice({
    sellerId: seller.id,
    debtorId: debtor.id,
    invoiceNumber: body.invoiceNumber,
    faceValue: body.faceValue,
    currency: body.currency,
    issuedAt: new Date(body.issuedAt),
    dueAt: new Date(body.dueAt),
    status: 'draft',
    uniquenessHash: hash,
    isin,
    regulationType: env.ATS_REGULATION_TYPE,
    issuanceState: 'queued',
  });

  /*
   * Tokenisation happens here, at onboarding, and is paced — never at the moment of sale.
   * The response is 202 because the instrument does not exist yet, and saying otherwise
   * would be a claim the book would then have to maintain.
   */
  const status = getIssuanceQueue().enqueue(
    issuanceJobFor({
      invoiceId: row.id,
      invoiceNumber: row.invoiceNumber,
      isin,
      uniquenessHash: row.uniquenessHash,
      regulationType: row.regulationType,
      dueAt: row.dueAt,
      faceValue: row.faceValue,
      currency: row.currency,
      sellerName: seller.name,
    }),
  );

  return c.json(
    {
      invoice: wireInvoice(row),
      debtor: { id: debtor.id, name: debtor.name, rating: debtor.rating },
      issuance: {
        state: status.state,
        attempts: status.attempts,
        queuedAt: status.queuedAt,
        nextAttemptAt: status.nextAttemptAt,
      },
    },
    202,
  );
});

/** The seller's book. Every row carries a live price; see `routes/quotes.ts`. */
invoiceRoutes.get('/', async (c) => {
  const query = readQuery(c, listInvoicesQuery);
  const store = getStore();

  const page = await store.listInvoices({
    sellerId: query.sellerId,
    ...(query.status === undefined ? {} : { status: query.status }),
    limit: query.limit,
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  });

  /*
   * One batched pricing pass, not N calls to `priceOne`. Every row on this screen carries
   * a live price, so an N+1 here is an N+1 on the product's main screen.
   */
  const priced = await quoteEngine.priceBook(page.rows.map((row) => row.id));
  const byInvoice = new Map(priced.map((live) => [live.invoiceId, live]));

  const debtors = await store.getDebtors(page.rows.map((row) => row.debtorId));
  const debtorsById = new Map(debtors.map((row) => [row.id, row]));

  return c.json({
    invoices: page.rows.map((row) => {
      const live = byInvoice.get(row.id);
      const debtor = debtorsById.get(row.debtorId);
      return {
        ...wireInvoice(row),
        debtor:
          debtor === undefined
            ? null
            : { id: debtor.id, name: debtor.name, rating: live?.rating ?? debtor.rating },
        // Refusals are left off here on purpose: the book shows one price per row, and the
        // reasons behind an absent one belong on the invoice's own screen where there is
        // room for the sentence.
        quote: live?.quote ? wireQuote(live.quote) : null,
        tenorDays: live?.tenorDays ?? null,
        mandatesMatching: live?.matchesAvailable ?? 0,
      };
    }),
    nextCursor: page.nextCursor ?? null,
  });
});

invoiceRoutes.get('/:id', async (c) => {
  const { id } = readParams(c, uuidParam);
  const store = getStore();

  const row = await store.getInvoice(id);
  if (!row) throw notFound(`Invoice ${id}`);

  const [debtor, assessment, live] = await Promise.all([
    store.getDebtor(row.debtorId),
    ratingService.ratingFor(row.debtorId),
    quoteEngine.priceOne(id),
  ]);

  /*
   * The queue's in-memory view wins where it has one: it knows about a backoff that has
   * not been written to the row yet. The row is the fallback after a restart, which is
   * why both exist rather than one being redundant.
   */
  const queued = getIssuanceQueue().status(id);

  return c.json({
    invoice: wireInvoice(row),
    debtor:
      debtor === null
        ? null
        : {
            id: debtor.id,
            name: debtor.name,
            rating: assessment.rating,
            reason: assessment.reason,
            score: assessment.score,
            nextGradeAt: assessment.nextGradeAt,
            permanentlyMarked: assessment.permanentlyMarked,
          },
    issuance: {
      state: queued?.state ?? row.issuanceState,
      attempts: queued?.attempts ?? row.issuanceAttempts,
      nextAttemptAt: queued?.nextAttemptAt ?? null,
      transactionId: queued?.security?.transactionId ?? row.issuanceTxId,
      error: queued?.lastError ?? row.issuanceError,
    },
    quote: live.quote === null ? null : wireQuote(live.quote),
    /** Every mandate that would not take this paper, and why, in words. */
    refusals: live.refusals.map(wireRefusalReceipt),
    mandatesConsidered: live.candidatesConsidered,
    mandatesMatching: live.matchesAvailable,
    tenorDays: live.tenorDays,
    pricedAt: live.pricedAt,
  });
});

/**
 * Ask the customer to confirm. Mints a single-use token, stores only its SHA-256, and
 * emails `${PUBLIC_BASE_URL}/v1/confirm/{token}`.
 */
invoiceRoutes.post('/:id/confirmation-request', async (c) => {
  const { id } = readParams(c, uuidParam);
  const store = getStore();
  const { env } = getConfig();

  const invoice = await store.getInvoice(id);
  if (!invoice) throw notFound(`Invoice ${id}`);

  /*
   * A decided invoice is not re-askable. The acknowledgement is about a specific amount
   * and date, and re-opening it would let an amount change under an answer the debtor has
   * already given — which is the one thing that would make confirmation worthless.
   */
  if (invoice.confirmationDecision !== null) {
    throw conflict(
      'conflict',
      `This customer has already answered — the invoice is ${invoice.status}. ` +
        'Correcting the amount or the date is a new invoice, not a second question.',
    );
  }
  if (invoice.status !== 'draft' && invoice.status !== 'awaiting_confirmation') {
    throw conflict('conflict', `An invoice that is ${invoice.status} cannot be re-confirmed.`);
  }

  const [seller, debtor] = await Promise.all([
    store.getSeller(invoice.sellerId),
    store.getDebtor(invoice.debtorId),
  ]);
  if (!seller || !debtor) throw notFound(`Invoice ${id}`);

  const minted = mintConfirmationToken(
    env.CONFIRMATION_TOKEN_SECRET,
    env.CONFIRMATION_TOKEN_TTL_HOURS,
  );

  // Only the SHA-256 is stored, and re-requesting supersedes the previous link in the same
  // transaction — a stale link then fails as used rather than silently still working.
  const { invoice: updated } = await store.requestConfirmation({
    invoiceId: id,
    tokenHash: minted.tokenHash,
    requestedAt: new Date(),
    expiresAt: minted.expiresAt,
  });

  const link = confirmationLink(env.PUBLIC_BASE_URL, minted.token);
  await getNotifier().sendConfirmationRequest({
    to: debtor.email,
    debtorName: debtor.name,
    sellerName: seller.name,
    sentence: confirmationSentence(seller.name, invoice.faceValue, invoice.currency, invoice.dueAt),
    link,
    expiresAt: minted.expiresAt,
  });

  return c.json({
    invoice: wireInvoice(updated),
    confirmation: {
      sentTo: debtor.email,
      expiresAt: minted.expiresAt.toISOString(),
      /*
       * Returned only outside production. There is no mail transport in this build, so a
       * demo needs the link from somewhere — but handing it back to the seller in
       * production would let them confirm their own invoices, which is the entire
       * behavioural argument for confirmation undone in one field.
       */
      link: getConfig().isProduction ? null : link,
    },
  });
});

/**
 * Maturity: the receivable comes due and the face value is owed to whoever holds the paper
 * NOW, not to whoever bought it first.
 *
 * Without a way to run this the paper cannot legitimately change hands, because a second
 * buyer would have no way to be paid — which is why the README calls it load-bearing and
 * why the service having no caller was a gap rather than an omission.
 *
 * **The cash leg comes back `pending` and that is the honest answer.** The money that
 * settles a matured receivable is the debtor's payment, and a debtor here has no wallet by
 * design — that is what makes confirmation work. What this does is real: it names the
 * current holder, writes the outcome to the settlement-outcome ledger (which is what moves
 * the customer's rating), releases the mandate's capital so an exhausted bid can quote
 * again, and puts the obligation on the ledger as a Hedera Scheduled Transaction paying
 * face value to that holder. What it does not do is claim anyone was paid.
 *
 * The schedule is created **unsigned**, drawn on the venue's collection account. Signing it
 * is the venue's statement that the debtor's money arrived, and that is a separate act from
 * the receivable maturing — so `payout` is an obligation anyone can look up, not a receipt.
 *
 * Operator-triggered, because nothing observes debtor payments here. Which is also why
 * **`paidAt` is on the request**: the same absence that makes the cash leg `pending` means
 * this service cannot see when the money landed, and that date is the only input to whether
 * the customer paid on time. Absent is allowed while the receivable is not yet past due, and
 * refused after — the answer used to be taken from the clock, which recorded a receivable
 * matured late as a customer who paid late.
 */
invoiceRoutes.post('/:id/mature', async (c) => {
  const { id } = readParams(c, uuidParam);
  const body = await readOptionalJson(c, matureBody);

  const result = await settlementService.settleAtMaturity(id, {
    ...(body.paidAt === undefined ? {} : { paidAt: new Date(body.paidAt) }),
  });

  // Read back rather than patched locally: `settleAtMaturity` moves the invoice to
  // `matured`, and the row is the authority on whether it did.
  const invoice = await getStore().getInvoice(id);
  if (!invoice) throw notFound(`Invoice ${id}`);

  return c.json({
    invoice: wireInvoice(invoice),
    /** Whoever holds the token now. The whole point of the lookup behind this. */
    holder: result.holder,
    outcome: result.outcome,
    /** True when this receivable had already matured, so nothing moved a second time. */
    alreadyRecorded: result.alreadyRecorded,
    /**
     * When the debtor's money landed, as the venue stated it — echoed so a reader can see
     * what the `on_time` / `late` call was actually made against rather than assuming it
     * was made against the clock. Null when the venue did not state one, which is only
     * possible while the receivable is not yet past due.
     */
    paidAt: body.paidAt ?? null,
    assetLeg: result.assetLeg,
    cashLeg: result.cashLeg,
    /**
     * The obligation as an on-chain object: an unsigned Hedera Scheduled Transaction paying
     * face value to the holder. `null` when no collection account is configured.
     */
    payout: result.payout,
    /** Why there is no payout when there should have been one. */
    payoutError: result.payoutError,
    maturedAt: result.settledAt,
    proofUrl: `/v1/trades/${result.tradeId}/proof`,
  });
});

/**
 * Default: the debtor never paid, and the venue says so.
 *
 * The other end of the rating loop, and the half that makes the rest of it worth reading. A
 * grade earned from settled history only prices anything if the bad history is in it — every
 * invoice a customer pays tightens their curve, and the market prices its own mistakes back
 * in only because a write-off marks them permanently and widens it for every seller
 * afterwards. Nothing wrote that mark before this route existed, and maturing an overdue
 * unpaid receivable recorded it as `late`: a default entered in the ledger as a payment.
 *
 * **An act, not a timer**, exactly as the maturity payout is. A scheduled payout becomes a
 * payment when the collection key signs, because only the venue watches the collection
 * account and only the venue can say the debtor's money arrived. A receivable becomes a
 * default when an operator presses this, for the mirror of that reason: only the venue can
 * say the money is never coming. A clock left to decide it would mark customers permanently
 * for payments three days in the post, and there is no route that takes a mark back.
 *
 * Safe to press twice — the rating ledger is keyed per receivable — and refused rather than
 * applied where the ledger already says the invoice was paid.
 */
invoiceRoutes.post('/:id/default', async (c) => {
  const { id } = readParams(c, uuidParam);
  const result = await settlementService.recordDefault(id);

  // Read back rather than patched locally, matching the maturity route: `recordDefault`
  // moves the invoice to `defaulted`, and the row is the authority on whether it did.
  const invoice = await getStore().getInvoice(id);
  if (!invoice) throw notFound(`Invoice ${id}`);

  return c.json({
    invoice: wireInvoice(invoice),
    /** Who is out the money: whoever held the paper, not whoever bought it first. */
    holder: result.holder,
    outcome: result.outcome,
    /** True when this receivable was already written off, so nothing moved a second time. */
    alreadyRecorded: result.alreadyRecorded,
    /**
     * What the holder paid and will not get back.
     *
     * The mandate's allocation is NOT released against it. Maturity releases because the
     * face value came in; here the position closes at zero and the buyer takes the loss, so
     * giving the capacity back would let the bid quote again on money that is gone.
     */
    lossMinor: result.lossMinor,
    faceValueMinor: result.faceValueMinor,
    /** The mark itself. `D`, and no amount of good behaviour afterwards clears it. */
    rating: result.rating,
    declaredAt: result.declaredAt,
    proofUrl: `/v1/trades/${result.tradeId}/proof`,
  });
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
confirmationRoutes.get('/:token', async (c) => {
  const { token } = readParams(c, z.object({ token: z.string().min(20).max(200) }));
  const { invoice, seller } = await resolveToken(token);

  /*
   * Exactly the sentence, and nothing else. No token, no chain, no ISIN, no buyer, no
   * price. Someone's accounts payable clerk is being asked to acknowledge their own ledger
   * entry; showing them a page of paper prices would be both irrelevant and a leak of the
   * seller's book.
   */
  return c.json({
    sentence: confirmationSentence(seller.name, invoice.faceValue, invoice.currency, invoice.dueAt),
    seller: seller.name,
    invoiceNumber: invoice.invoiceNumber,
    amount: formatMinorUnits(invoice.faceValue, invoice.currency as Currency, { symbol: true }),
    currency: invoice.currency,
    dueAt: invoice.dueAt.toISOString(),
    expiresAt: invoice.confirmationExpiresAt?.toISOString() ?? null,
    /** Two buttons, named by the API so the page does not invent a third. */
    actions: ['confirmed', 'disputed'],
  });
});

confirmationRoutes.post('/:token', async (c) => {
  const { token } = readParams(c, z.object({ token: z.string().min(20).max(200) }));
  const body = await readJson(c, confirmationDecisionBody);
  await resolveToken(token);

  if (body.decision === 'disputed' && body.note === undefined) {
    throw badRequest('Tell the seller what is wrong — a dispute without a reason is not fixable.');
  }

  /*
   * Single-use, consumed in the same transaction that writes the decision. `confirmed`
   * turns the invoice green and gives it a price; `disputed` moves it to `disputed`, and
   * it is not quotable from there.
   */
  const { invoice } = await getStore().decideConfirmation({
    tokenHash: confirmationTokenHash(token),
    decision: body.decision,
    ...(body.note === undefined ? {} : { note: body.note }),
    at: new Date(),
  });

  /*
   * The confirmation, on chain.
   *
   * This is the transition the product's risk argument rests on: debtor confirmation removes
   * dispute risk, and that is what justifies advancing the full face value with no holdback.
   * Until it was recorded here it was a column only the venue could see, and a buyer had to
   * take our word for it. `isConfirmed(invoiceId)` is a public view.
   *
   * Never allowed to fail the confirmation. The debtor has answered — that is a real-world
   * event which has already happened, and returning an error to a customer who did nothing
   * wrong because a node was unreachable would be inexcusable. A registry that missed one
   * leaves the invoice confirmed here and unconfirmed there, which is visible rather than
   * silent, and is the honest failure of the two available.
   */
  if (body.decision === 'confirmed') {
    const registry = getInvoiceRegistry();
    if (registry.enabled) {
      try {
        await registry.setStatus(invoice.id, INVOICE_STATUS.Confirmed);
      } catch (err) {
        rootLogger.warn('invoice confirmed but not recorded on chain', {
          invoiceId: invoice.id,
          err,
        });
      }
    }
  }

  return c.json({
    decision: body.decision,
    status: invoice.status,
    decidedAt: invoice.confirmationDecidedAt?.toISOString() ?? null,
    message:
      body.decision === 'confirmed'
        ? 'Thank you. Nothing further is needed from you.'
        : 'Thank you. The seller has been told, and this invoice will not be sold.',
  });
});

/**
 * Everything a confirmation link has to be before it means anything.
 *
 * The HMAC tag is checked first and without touching the database, so a scan for valid
 * links costs the scanner rather than the store. Every failure below deliberately reports
 * the same shape a wrong token does — an attacker must not learn from the response whether
 * a token existed, only expired, or was already used.
 */
async function resolveToken(token: string): Promise<{ invoice: InvoiceRow; seller: SellerRow }> {
  const { env } = getConfig();
  const store = getStore();

  if (!isWellFormedToken(token, env.CONFIRMATION_TOKEN_SECRET)) {
    throw notFound('This confirmation link');
  }

  const found = await store.findConfirmationByTokenHash(confirmationTokenHash(token));
  if (!found) throw notFound('This confirmation link');

  const { request, invoice } = found;
  if (request.consumedAt !== null) {
    throw conflict('conflict', 'This confirmation link has already been used.');
  }
  if (request.supersededAt !== null) {
    throw conflict(
      'conflict',
      'A newer confirmation link was sent for this invoice. Please use the latest email.',
    );
  }
  if (request.expiresAt.getTime() <= Date.now()) {
    throw conflict('conflict', 'This confirmation link has expired. Ask the seller for a new one.');
  }

  const seller = await store.getSeller(invoice.sellerId);
  if (!seller) throw notFound('This confirmation link');

  return { invoice, seller };
}

/** The one sentence the debtor is asked. Written once so both handlers agree on it. */
function confirmationSentence(
  sellerName: string,
  faceValue: bigint,
  currency: string,
  dueAt: Date,
): string {
  const amount = formatMinorUnits(faceValue, currency as Currency, { symbol: true });
  const due = dueAt.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
  return `${sellerName} says you owe them ${amount}, due ${due}. Is that right?`;
}

/**
 * A ticker for the instrument, derived from the invoice number.
 *
 * Not a real exchange symbol and not presented as one — like the ISIN, it exists because
 * ATS wants the field. Kept deterministic in the invoice number so a retried issuance does
 * not produce a second name for the same paper.
 */
