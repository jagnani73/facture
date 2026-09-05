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

import { explainRefusal } from '@facture/shared';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { getStore } from '../db/store.js';
import { publishRefusals } from '../services/hcs.js';
import { badRequest, conflict, forbidden, isAppError, notFound } from '../errors.js';
import type { AppEnv } from '../middleware/context.js';
import { accountIdToEvmAddress } from '../services/ats.js';
import { getComplianceGate } from '../services/compliance.js';
import { quoteEngine } from '../services/quote-engine.js';
import { buildTradeChallenge, settlementService } from '../services/settlement.js';
import { X402_HEADERS, X402_VERSION } from '../services/x402.js';
import { readJson, readOptionalJson, readParams, readQuery } from '../validate.js';
import { money, wireQuote, wireTrade } from '../wire.js';

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

const uuidParam = z.object({ id: z.uuid() });

const unwindBody = z
  .object({
    /** Recorded in the log beside the trade id, so an unwind can be accounted for later. */
    reason: z.string().min(1).max(200).optional(),
  })
  /* An empty body is the ordinary case: "give me my capital back" needs no explanation. */
  .default({});

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

  /*
   * Give back the capital of anything that expired before pricing this one. A mandate
   * still carrying the allocation of a trade nobody paid for quotes as though that money
   * were spent, and the seller sees a worse price — or none — for a fill that never
   * happened. See `settlementService.reclaimExpired` for why this is lazy rather than a
   * background sweep.
   */
  await settlementService.reclaimExpired();

  /*
   * One route, two halves of one x402 exchange. The first request arms the trade and comes
   * back 402 carrying the challenge; the buyer signs it and repeats the same request with
   * `PAYMENT-SIGNATURE`, which is the leg that moves money. Splitting them across two
   * routes would let a client execute a payment against a challenge it never received.
   */
  const signature = c.req.header(X402_HEADERS.signature);
  return signature === undefined
    ? prepareTrade(c, body)
    : executeTrade(c, body, decodePaymentPayload(signature));
});

/**
 * Arm the trade. Compliance first, then capital, then the hold — and nothing has moved
 * when this returns.
 */
async function prepareTrade(
  c: Context<AppEnv>,
  body: z.infer<typeof executeTradeBody>,
): Promise<Response> {
  const store = getStore();

  const invoice = await store.getInvoice(body.invoiceId);
  if (!invoice) throw notFound(`Invoice ${body.invoiceId}`);

  /*
   * The instrument has to exist before it can be delivered. Issuance is paced and off the
   * critical path, so an invoice can be confirmed and priced while its bond is still being
   * deployed — this is the one moment where that catches up, and it is reported as
   * `issuance_pending` rather than as a failure.
   *
   * Checked before the quote, deliberately: this is a fact about the invoice, and the
   * seller is better told "it is still being added" than "that quote does not exist".
   */
  if (invoice.securityId === null || invoice.securityEvmAddress === null) {
    throw conflict(
      'issuance_pending',
      'This invoice is still being added to the market — its instrument has not been ' +
        'deployed yet. It will be sellable as soon as it lands.',
    );
  }

  const accepted = await store.getQuote(body.quoteId);
  if (!accepted || accepted.invoiceId !== invoice.id) {
    throw notFound(`Quote ${body.quoteId} for invoice ${body.invoiceId}`);
  }
  if (accepted.status !== 'live') {
    throw conflict('quote_expired', `That quote is ${accepted.status} and cannot be filled.`);
  }
  if (accepted.expiresAt.getTime() <= Date.now()) {
    throw conflict(
      'quote_expired',
      'That quote has expired. Tenor shortens every day, so yesterday’s proceeds are the ' +
        'wrong number rather than a stale one — take a fresh quote.',
    );
  }

  // Re-priced against the live curve, not read back off the accepted quote. The curve
  // moves, and the seller must never be filled at a price nobody is currently bidding.
  const live = await quoteEngine.priceOne(invoice.id);
  await recordRefusals(invoice.id, live);

  if (live.quote === null) {
    throw conflict(
      'conflict',
      `No mandate on the book will take this invoice today. ${live.refusals.length} ` +
        'refusals were recorded, each naming its reason.',
    );
  }

  /*
   * Slippage is measured on proceeds, which is the number the seller actually read. The
   * default tolerance is zero: `maxSlippageBps` is opt-in, and a seller who did not ask
   * for a tolerance is filled at what they were shown or not at all.
   */
  const tolerance = (accepted.proceedsMinor * BigInt(body.maxSlippageBps)) / 10_000n;
  if (live.quote.proceeds + tolerance < accepted.proceedsMinor) {
    throw conflict(
      'quote_expired',
      `The book now pays ${money(live.quote.proceeds)} against the ` +
        `${money(accepted.proceedsMinor)} you accepted, which is outside the ` +
        `${body.maxSlippageBps} bps you allowed.`,
    );
  }

  const mandate = await store.getMandate(live.quote.mandateId);
  if (!mandate) throw notFound(`Mandate ${live.quote.mandateId}`);
  const [seller, buyer] = await Promise.all([
    store.getSeller(invoice.sellerId),
    store.getBuyer(mandate.buyerId),
  ]);
  if (!seller || !buyer) throw notFound(`Counterparties for invoice ${invoice.id}`);

  /*
   * Compliance BEFORE the match, against the security's own ControlList and Kyc facets.
   * This ordering is the whole argument against doing this on an AMM: an AMM matches first
   * and discovers the transfer was illegal afterwards, so non-compliance arrives as a
   * revert. Here the buyer is refused in words, with a receipt, and nothing was reserved.
   */
  const compliance = await getComplianceGate().check({
    instrumentAddress: invoice.securityEvmAddress as `0x${string}`,
    buyerEvmAddress: accountIdToEvmAddress(buyer.hederaAccountId),
    buyerName: buyer.name,
  });
  if (compliance.decision === 'refused') {
    throw forbidden(compliance.reason ?? 'This buyer is not eligible to hold this instrument.');
  }

  /*
   * Reserve the capital before placing the hold. Both are taken under the mandate's row
   * lock, so two invoices arriving against one mandate serialise rather than both being
   * told there is room.
   */
  await store.allocate(mandate.id, live.quote.proceeds);

  const trade = await store.insertTrade({
    invoiceId: invoice.id,
    mandateId: mandate.id,
    quoteId: accepted.id,
    sellerId: seller.id,
    buyerId: buyer.id,
    faceValue: invoice.faceValue,
    proceedsMinor: live.quote.proceeds,
    annualisedYieldBps: live.quote.annualisedYieldBps,
    tenorDays: live.quote.tenorDays,
    status: 'preparing',
    complianceDecision: { ...compliance },
    complianceCheckedAt: new Date(compliance.checkedAt),
  });

  const intent = {
    tradeId: trade.id,
    invoiceId: invoice.id,
    mandateId: mandate.id,
    quoteId: accepted.id,
    buyerId: buyer.id,
    sellerId: seller.id,
    securityId: invoice.securityId,
    sellerHederaAccountId: seller.hederaAccountId ?? '',
    sellerArcAddress: seller.arcAddress,
    buyerHederaAccountId: buyer.hederaAccountId ?? '',
    buyerArcAddress: (buyer.arcAddress ?? '0x') as `0x${string}`,
    /*
     * No unit count. Both rails read the seller's whole position off the instrument with
     * `balanceOf` — partial sales are cut-list item 4, so this is all-or-nothing, and
     * "all" is whatever the seller actually holds rather than a number asserted here.
     */
    proceedsMinor: live.quote.proceeds,
    faceValue: invoice.faceValue,
    currency: invoice.currency,
  };

  /*
   * Both failure paths give the capital back. Arming failed means nothing is owed, and a bid
   * left quoting money it cannot spend is worse than a refused trade.
   */
  const committed = live.quote.proceeds;
  const abandon = async (err: unknown): Promise<never> => {
    /*
     * Not every failure is a failure to compensate.
     *
     * `internal_error` is the code both rails reserve for "the money moved and the paper did
     * not". Releasing the mandate's capacity there would hand the buyer back capital that has
     * already left — on Arc it is sitting in an escrow lock, on Hedera it is spent — and the
     * bid would go straight back to quoting against it. The signed half of the x402 exchange
     * already makes this carve-out; the arming half did not, and the Arc rail reaches this
     * state from here rather than from there.
     *
     * The trade keeps its allocation and the status the settlement service gave it, so a
     * half-settled trade stays visible as one rather than reading as an ordinary failure.
     */
    if (isAppError(err) && err.code === 'internal_error') throw err;
    await store.release(mandate.id, committed);
    await store.updateTrade(trade.id, { status: 'failed' });
    throw err;
  };

  /*
   * Which rail, decided here because it decides what this request even returns.
   *
   * A funded mandate settles out of its escrow on Arc and comes back **200, already settled**:
   * the buyer escrowed the capital and wrote the terms, so an invoice meeting those terms is
   * a trade they have already agreed to, and asking them to sign again would make a standing
   * bid not standing. An unfunded one comes back 402 with a challenge to sign, as before.
   *
   * The status code is therefore the honest signal of which rail ran, and the body says so in
   * words as well — `cashLeg.rail` — because a reader should not have to infer a rail from an
   * HTTP status any more than from a string prefix.
   */
  const railChoice = await settlementService.chooseRail({
    mandateId: mandate.id,
    proceedsMinor: live.quote.proceeds,
    currency: invoice.currency,
    sellerArcAddress: seller.arcAddress,
  });

  if (railChoice.rail === 'arc-vault') {
    const settled = await settlementService.settleFromVault(intent).catch(abandon);
    return c.json(
      {
        trade: wireTrade(await refresh(trade.id)),
        quote: wireQuote(live.quote),
        assetLeg: settled.assetLeg,
        cashLeg: settled.cashLeg,
        compliance,
        /** Why this settled without a challenge, rather than leaving the reader to guess. */
        rail: { chosen: railChoice.rail, reason: railChoice.reason },
        settledAt: settled.settledAt,
      },
      200,
    );
  }

  const prepared = await settlementService.prepare(intent).catch(abandon);

  /*
   * The header carries a whole `PaymentRequired`, not a bare requirements object.
   * Verified against the live facilitator on 2026-09-01: `accepts` holds the
   * requirements, and the resource description is a *sibling* of it rather than three
   * fields inside it. Encoding only the requirements here would hand a v2 client a shape
   * it cannot read, and the failure would surface as an opaque rejection rather than an
   * error naming the field.
   */
  c.header(
    X402_HEADERS.required,
    encodeChallenge({
      x402Version: X402_VERSION,
      accepts: [prepared.requirements],
      resource: prepared.resourceInfo,
    }),
  );
  return c.json(
    {
      trade: wireTrade(await refresh(trade.id)),
      quote: wireQuote(live.quote),
      /** The asset leg is held, not moved. Nobody goes first. */
      assetLeg: prepared.assetLeg,
      compliance,
      x402Version: X402_VERSION,
      accepts: [prepared.requirements],
      resource: prepared.resourceInfo,
      expiresAt: prepared.expiresAt,
      /** Why a challenge was issued rather than the trade settling out of an escrow. */
      rail: { chosen: railChoice.rail, reason: railChoice.reason },
      /** Repeat this request with the signed payload in this header. */
      signatureHeader: X402_HEADERS.signature,
    },
    402,
  );
}

/** Settle both legs. Cash clears at the facilitator, then the hold executes. */
async function executeTrade(
  c: Context<AppEnv>,
  body: z.infer<typeof executeTradeBody>,
  paymentPayload: unknown,
): Promise<Response> {
  const store = getStore();

  const trade = await store.getTradeForInvoice(body.invoiceId);
  if (!trade || trade.quoteId !== body.quoteId) {
    throw notFound(`An armed trade for invoice ${body.invoiceId}`);
  }
  /*
   * A signature is meaningless against a trade the vault is already paying for.
   *
   * An Arc trade sits in `awaiting_payment` for the whole of its settlement, and after a
   * crash it can stay there. Without this guard a client could present an x402 payload for
   * that trade and the venue would build a fresh HEDERA challenge, take a second payment for
   * the same receivable, and overwrite the row's rail — burying the Arc escrow lock under a
   * receipt claiming x402. Two payments, one invoice, and a row contradicting itself about
   * which chain took the money.
   */
  if (trade.cashRail === 'arc-vault') {
    throw conflict(
      'conflict',
      'This trade settles out of the buyer’s escrowed capital on Arc, so there is nothing ' +
        'to sign. A payment signature against it would be a second payment for one receivable.',
    );
  }
  if (trade.status !== 'awaiting_payment') {
    throw conflict(
      'conflict',
      `This trade is ${trade.status}; only a trade awaiting payment can be settled.`,
    );
  }

  /*
   * The challenge is rebuilt rather than stored. `extra.feePayer` is read from the
   * facilitator's `GET /supported` and cached, and hardcoding or persisting it works right
   * up until the facilitator rotates the payer, at which point it fails as an opaque
   * signature mismatch.
   */
  const invoice = await store.getInvoice(trade.invoiceId);
  if (!invoice) throw notFound(`Invoice ${trade.invoiceId}`);

  const challenge = await buildTradeChallenge({
    tradeId: trade.id,
    invoiceId: trade.invoiceId,
    proceedsMinor: trade.proceedsMinor,
    faceValue: trade.faceValue,
    currency: invoice.currency,
  });

  let result;
  try {
    result = await settlementService.execute({
      tradeId: trade.id,
      requirements: challenge.accepted,
      paymentPayload,
    });
  } catch (err) {
    /*
     * A half-settled trade — cash gone, security not delivered — is reported as an
     * internal error and left alone. Unwinding it would release a hold against a payment
     * that actually happened, which turns a reconcilable state into a lost one.
     */
    if (isAppError(err) && err.code === 'internal_error') throw err;
    await settlementService.unwind(trade.id, 'cash leg did not settle');
    throw err;
  }

  c.header(X402_HEADERS.response, encodeChallenge(result.cashLeg));
  return c.json({
    trade: wireTrade(await refresh(trade.id)),
    assetLeg: result.assetLeg,
    cashLeg: result.cashLeg,
    settledAt: result.settledAt,
  });
}

/**
 * Give the position back and release the capital.
 *
 * This is the way out of an armed trade whose buyer never returned. Without it a trade
 * that nobody pays for holds the mandate's capital until someone edits the database, and
 * `allocated_minor` is a real column rather than a derived one — so the release has to go
 * through the store, which is what this does by calling `unwind` rather than setting a
 * status.
 *
 * Guarded on one thing above all: a settled trade cannot be unwound. Releasing a hold
 * against a payment that actually cleared would take the paper back off a buyer who paid
 * for it, so `settlementService.unwind` refuses that with 409 and this route does not
 * reach around it. Unwinding an already-unwound trade is fine and returns the same
 * receipt — the caller who retries after a dropped connection is not doing anything wrong.
 */
tradeRoutes.post('/:id/unwind', async (c) => {
  const { id } = readParams(c, uuidParam);
  const body = await readOptionalJson(c, unwindBody);

  const assetLeg = await settlementService.unwind(id, body.reason ?? 'unwound by request');
  const trade = await refresh(id);

  return c.json({
    trade: wireTrade(trade),
    assetLeg,
    /**
     * The capital this trade had reserved against the mandate. The first unwind gives it
     * back; a repeat call reports the same figure without releasing anything twice.
     */
    releasedMinor: money(trade.proceedsMinor),
    mandateId: trade.mandateId,
  });
});

tradeRoutes.get('/', async (c) => {
  const query = readQuery(c, listTradesQuery);
  // A position list that still shows an expired trade as awaiting payment is showing
  // capital as committed that nothing is going to spend.
  await settlementService.reclaimExpired();
  const rows = await getStore().listTrades({
    ...(query.sellerId === undefined ? {} : { sellerId: query.sellerId }),
    ...(query.buyerId === undefined ? {} : { buyerId: query.buyerId }),
    ...(query.status === undefined ? {} : { status: query.status }),
    limit: query.limit,
  });
  return c.json({ trades: rows.map(wireTrade) });
});

tradeRoutes.get('/:id', async (c) => {
  const { id } = readParams(c, uuidParam);
  const store = getStore();

  await settlementService.reclaimExpired();

  const trade = await store.getTrade(id);
  if (!trade) throw notFound(`Trade ${id}`);

  const invoice = await store.getInvoice(trade.invoiceId);

  return c.json({
    trade: wireTrade(trade),
    invoice:
      invoice === null
        ? null
        : {
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            status: invoice.status,
            isin: invoice.isin,
            securityId: invoice.securityId,
            dueAt: invoice.dueAt.toISOString(),
          },
    compliance: trade.complianceDecision,
    /** The audit detail is one click away. */
    proofUrl: `/v1/trades/${trade.id}/proof`,
  });
});

// --- helpers ----------------------------------------------------------------------

/**
 * Persist the refusals from a pricing pass.
 *
 * A refusal is a product output, not a log line: the funder is told why in words rather
 * than by a reverted transaction, and the receipt outlives the request so they can still
 * read it afterwards. Invoice-level refusals (`mandateId === null`) are not stored —
 * "this invoice is not confirmed" is a property of the invoice's own status, which is
 * already on the row.
 */
async function recordRefusals(
  invoiceId: string,
  live: Awaited<ReturnType<typeof quoteEngine.priceOne>>,
): Promise<void> {
  const store = getStore();
  const mandateIds = live.refusals
    .map((refusal) => refusal.mandateId)
    .filter((id): id is string => id !== null);
  if (mandateIds.length === 0) return;

  const buyerOf = new Map<string, string>();
  for (const id of new Set(mandateIds)) {
    const mandate = await store.getMandate(id);
    if (mandate) buyerOf.set(id, mandate.buyerId);
  }

  const inserted = await store.insertRefusals(
    live.refusals.flatMap((refusal) => {
      const buyerId = refusal.mandateId === null ? undefined : buyerOf.get(refusal.mandateId);
      if (refusal.mandateId === null || buyerId === undefined) return [];
      return [
        {
          invoiceId,
          mandateId: refusal.mandateId,
          buyerId,
          reasonCode: refusal.code,
          reasonText: explainRefusal(refusal.detail),
          ratingAtRefusal: live.rating,
          tenorDaysAtRefusal: live.tenorDays,
        },
      ];
    }),
  );

  /*
   * The reason is already recorded and readable; this attaches the copy a refused funder can
   * check without trusting us. Awaited rather than fired and forgotten, so a receipt that did
   * reach consensus carries its coordinates by the time the response is written — but
   * `publishRefusals` never throws, so a topic that is down costs a consensus copy and not
   * the refusal itself. What is published is a digest, not the reason: see `services/hcs.ts`
   * for why a public topic must not carry one buyer's exposure.
   */
  await publishRefusals(
    inserted.map((row) => ({
      receiptId: row.id,
      invoiceId: row.invoiceId,
      mandateId: row.mandateId,
      buyerId: row.buyerId,
      reasonCode: row.reasonCode,
      reasonText: row.reasonText,
      ratingAtRefusal: row.ratingAtRefusal,
      tenorDaysAtRefusal: row.tenorDaysAtRefusal,
    })),
    (receiptId, published) =>
      store.recordRefusalConsensus(receiptId, published).then(() => undefined),
  );
}

async function refresh(tradeId: string) {
  const row = await getStore().getTrade(tradeId);
  if (!row) throw notFound(`Trade ${tradeId}`);
  return row;
}

/** x402 v2 carries its payloads base64-encoded in the header. */
const encodeChallenge = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64');

function decodePaymentPayload(header: string): unknown {
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    throw badRequest(
      `${X402_HEADERS.signature} must be base64-encoded JSON. Note that the shipped ` +
        '@x402/* v2 packages use this header, not the legacy X-PAYMENT.',
    );
  }
}
