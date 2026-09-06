/**
 * The HTTP client for the Facture service.
 *
 * One function per route in `packages/backend/src/routes/`, with the request shapes taken
 * from the zod schemas there — those are frozen, so they are what this file codes against.
 * Responses go through `contract.ts`, which is the only place a wire value becomes a domain
 * value.
 *
 * Nothing in here knows about React, fixtures or screens. It is a transport: it asks, it
 * decodes, and when either half fails it throws an `ApiError` carrying a sentence rather
 * than a status code.
 */

import type { InvoiceStatus, MandateStatus, MinorUnits, Rating } from '@/lib/domain';
import { API_BASE_URL, API_V1 } from './config';
import type {
  ConfirmationPrompt,
  ConfirmationRequested,
  HealthResponse,
  InvoiceDetail,
  InvoiceListing,
  InvoiceRow,
  LiveQuoteResponse,
  MandateRecord,
  Page,
  SellerSignIn,
  TradeChallenge,
  TradeProofResponse,
  TradeRecord,
  TradeStatus,
} from './contract';
import {
  decodePaymentRequiredHeader,
  readConfirmationPrompt,
  readConfirmationRequested,
  readHealth,
  readInvoice,
  readInvoiceDetail,
  readInvoiceListing,
  readInvoiceRow,
  readLiveQuote,
  readMandate,
  readMandateRecord,
  readObject,
  readPage,
  readSellerSignIn,
  readTrade,
  readTradeChallenge,
  readTradeProof,
  writeMoney,
} from './contract';
import type { Problem } from './problem';
import { ApiError, SERVER_ERROR_CODES } from './problem';
import type { Invoice, Mandate } from '@/lib/domain';

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

type Query = Record<string, string | number | boolean | undefined>;

interface RequestOptions {
  method?: 'GET' | 'POST';
  query?: Query | undefined;
  body?: unknown;
  signal?: AbortSignal | undefined;
  /** Extra headers. Only sign-in uses this, to present its bearer credential. */
  headers?: Record<string, string> | undefined;
  /** What is being asked for, in the product's words. Used to write the failure sentence. */
  what: string;
}

function buildUrl(base: string, path: string, query?: Query): string {
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function problemFrom(raw: unknown, status: number, url: string, what: string): ApiError {
  const body = typeof raw === 'object' && raw !== null ? (raw as Partial<Problem>) : {};
  const code = SERVER_ERROR_CODES.find((candidate) => candidate === body.code);

  return new ApiError({
    // A gateway or proxy in front of the service will not speak problem+json. Falling back
    // on the status keeps the sentence honest rather than claiming a code nobody sent.
    code: code ?? (status === 404 ? 'not_found' : status >= 500 ? 'internal_error' : 'bad_request'),
    status,
    title: typeof body.title === 'string' ? body.title : `HTTP ${status}`,
    detail: typeof body.detail === 'string' ? body.detail : undefined,
    issues: Array.isArray(body.errors) ? body.errors : undefined,
    requestId: typeof body.requestId === 'string' ? body.requestId : undefined,
    url,
    what,
  });
}

async function request<T>(
  path: string,
  options: RequestOptions,
  decode: (raw: unknown) => T,
  base: string = API_V1,
): Promise<T> {
  const url = buildUrl(base, path, options.query);
  const method = options.method ?? 'GET';

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      // A price that is one poll stale is the wrong number, not a slow one — see the
      // backend's own note that the quote route is uncached at the edge.
      cache: 'no-store',
      headers: {
        accept: 'application/json, application/problem+json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError({
      code: 'unreachable',
      status: 0,
      title: 'No answer',
      url,
      what: options.what,
      cause,
    });
  }

  const text = await response.text();
  let payload: unknown = undefined;
  if (text.trim() !== '') {
    try {
      payload = JSON.parse(text);
    } catch (cause) {
      throw new ApiError({
        code: 'unreadable',
        status: response.status,
        title: 'Unreadable response',
        detail: 'the body is not JSON',
        url,
        what: options.what,
        cause,
      });
    }
  }

  if (!response.ok) throw problemFrom(payload, response.status, url, options.what);

  try {
    return decode(payload);
  } catch (cause) {
    // A decoder failure is an `unreadable` ApiError already; re-label it with the route so
    // the screen can say what it was reading when the shape surprised it.
    if (cause instanceof ApiError) {
      throw new ApiError({
        code: cause.code,
        status: response.status,
        title: cause.title,
        detail: cause.detail,
        issues: cause.issues,
        url,
        what: options.what,
        cause,
      });
    }
    throw cause;
  }
}

/* -------------------------------------------------------------------------- */
/* Requests, as the zod schemas define them                                    */
/* -------------------------------------------------------------------------- */

/** `createInvoiceBody` in `routes/invoices.ts`. */
export interface CreateInvoiceInput {
  sellerId: string;
  debtor: { name: string; email: string; taxId?: string | undefined };
  invoiceNumber: string;
  faceValue: MinorUnits;
  currency: string;
  issuedAt: string;
  dueAt: string;
}

/** `createMandateBody` in `routes/mandates.ts`. `D` is deliberately not selectable there. */
export interface CreateMandateInput {
  buyerId: string;
  ratingFloor: Exclude<Rating, 'D'>;
  maxTenorDays: number;
  annualisedYieldBps: number;
  currency: string;
  exposureLimitMinor: MinorUnits;
  perDebtorLimitMinor?: MinorUnits | undefined;
}

/** `executeTradeBody` in `routes/trades.ts`. */
export interface ExecuteTradeInput {
  invoiceId: string;
  quoteId: string;
  maxSlippageBps?: number | undefined;
}

export type { TradeStatus } from './contract';

/* -------------------------------------------------------------------------- */
/* The routes                                                                  */
/* -------------------------------------------------------------------------- */

export const api = {
  /** `GET /health`. Outside the version prefix: operational, not product surface. */
  health(signal?: AbortSignal): Promise<HealthResponse> {
    return request(
      '/health',
      { what: 'the service status', signal },
      (raw) => readHealth(raw),
      API_BASE_URL,
    );
  },

  /* --- Seller: signing in ----------------------------------------------- */

  /**
   * `POST /v1/sellers` — sign in, and record the wallet the identity was made from.
   *
   * **Sends no body.** The venue reads the email and the wallet address out of the Privy
   * identity token and verifies them against Privy's signature, so there is no field here a
   * caller could use to claim another business's identity. An earlier version passed both in
   * a body and the venue believed them.
   *
   * The token must be the **identity** token, not the access token: only the first carries
   * the linked accounts, and the second fails at the signature check rather than at anything
   * that names the mistake.
   *
   * Idempotent on email at the venue, which is what makes this the *sign-in* call rather than
   * a sign-up call: a returning business gets its existing id back instead of a second empty
   * book. That is also why nothing caches the id — this is cheap to ask again and always
   * current, and a cached copy would be a staler second answer.
   *
   * A 409 is a real answer about this business, not a transport failure: the venue refuses to
   * rebind a wallet address that is already on file.
   */
  signInSeller(idToken: string, signal?: AbortSignal): Promise<SellerSignIn> {
    return request(
      '/sellers',
      {
        method: 'POST',
        what: 'signing in',
        signal,
        headers: { authorization: `Bearer ${idToken}` },
      },
      (raw) => readSellerSignIn(raw),
    );
  },

  /* --- Seller: the book ------------------------------------------------- */

  /**
   * `GET /v1/invoices` — the seller's book, priced.
   *
   * One request for the whole page, price included. The service prices the page in a single
   * batched pass for exactly this reason, so the screen does not turn "a live price in every
   * row" into one round trip per row.
   */
  listInvoices(
    params: { sellerId: string; status?: InvoiceStatus; limit?: number; cursor?: string },
    signal?: AbortSignal,
  ): Promise<Page<InvoiceRow>> {
    return request(
      '/invoices',
      {
        what: 'the book',
        query: {
          sellerId: params.sellerId,
          status: params.status,
          limit: params.limit ?? 200,
          cursor: params.cursor,
        },
        signal,
      },
      (raw) => readPage(raw, 'invoices', readInvoiceRow, 'invoices'),
    );
  },

  /** `GET /v1/invoices/:id` — invoice, customer, issuance state, live price and refusals. */
  getInvoice(id: string, signal?: AbortSignal): Promise<InvoiceDetail> {
    return request(`/invoices/${encodeURIComponent(id)}`, { what: 'that invoice', signal }, (raw) =>
      readInvoiceDetail(raw),
    );
  },

  /** `POST /v1/invoices` — tokenisation happens here, queued and paced. */
  createInvoice(input: CreateInvoiceInput, signal?: AbortSignal): Promise<Invoice> {
    return request(
      '/invoices',
      {
        method: 'POST',
        what: 'adding that invoice',
        signal,
        body: {
          sellerId: input.sellerId,
          debtor: {
            name: input.debtor.name,
            email: input.debtor.email,
            ...(input.debtor.taxId ? { taxId: input.debtor.taxId } : {}),
          },
          invoiceNumber: input.invoiceNumber,
          faceValue: writeMoney(input.faceValue),
          currency: input.currency,
          issuedAt: input.issuedAt,
          dueAt: input.dueAt,
        },
      },
      (raw) => {
        const body = readObject(raw, 'invoice');
        return readInvoice(body['invoice'] ?? body, 'invoice');
      },
    );
  },

  /**
   * `POST /v1/invoices/:id/confirmation-request` — ask the customer.
   *
   * The response was discarded here for as long as this method existed, which is why the
   * screen could tell a seller their customer "has been sent the link" while nothing in
   * this build sends mail at all. The venue returns the link precisely because nothing
   * does; throwing it away was what turned an honest answer into a false one.
   */
  requestConfirmation(invoiceId: string, signal?: AbortSignal): Promise<ConfirmationRequested> {
    return request(
      `/invoices/${encodeURIComponent(invoiceId)}/confirmation-request`,
      { method: 'POST', what: 'asking your customer to confirm', signal, body: {} },
      readConfirmationRequested,
    );
  },

  /**
   * `POST /v1/invoices/:id/list` — the seller offering it for sale.
   *
   * A confirmed invoice is *quotable*; a listed one is *sellable*. Those are different
   * permissions at the venue, and arming a trade refuses anything that is not listed — so
   * this is the call that has to happen before a sale, and it is the seller's decision
   * rather than something a sale can do on their behalf.
   *
   * Idempotent at the venue: listing what is already listed answers 200 having written
   * nothing, which is what makes a double-clicked button harmless.
   */
  listInvoice(invoiceId: string, signal?: AbortSignal): Promise<InvoiceListing> {
    return request(
      `/invoices/${encodeURIComponent(invoiceId)}/list`,
      { method: 'POST', what: 'offering that invoice for sale', signal, body: {} },
      (raw) => readInvoiceListing(raw, 'listing'),
    );
  },

  /**
   * `POST /v1/invoices/:id/delist` — withdrawing the offer.
   *
   * The invoice stays confirmed and keeps its price; only the offer goes away. The venue
   * refuses this outright while a buyer has a trade armed against the invoice, because
   * taking an offer off the book underneath a payment already in flight is how a `confirmed`
   * invoice would end up marked sold. The way out of an armed trade is unwinding it.
   */
  delistInvoice(invoiceId: string, signal?: AbortSignal): Promise<InvoiceListing> {
    return request(
      `/invoices/${encodeURIComponent(invoiceId)}/delist`,
      { method: 'POST', what: 'taking that invoice off the book', signal, body: {} },
      (raw) => readInvoiceListing(raw, 'listing'),
    );
  },

  /* --- The live quote --------------------------------------------------- */

  /**
   * `GET /v1/invoices/:id/quote` — the price that is already there.
   *
   * Cheap and safe to poll by the backend's own description, which is what lets the book
   * carry a number in every row rather than a button that asks for one.
   */
  getQuote(
    invoiceId: string,
    options: { asOf?: string | undefined; includeRefusals?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<LiveQuoteResponse> {
    return request(
      `/invoices/${encodeURIComponent(invoiceId)}/quote`,
      {
        what: 'the price for that invoice',
        query: {
          asOf: options.asOf,
          includeRefusals: options.includeRefusals === false ? 'false' : 'true',
        },
        signal,
      },
      (raw) => readLiveQuote(raw),
    );
  },

  /* --- Debtor confirmation ---------------------------------------------- */

  /** `GET /v1/confirm/:token` — public, token-authenticated, no wallet and no signup. */
  getConfirmation(token: string, signal?: AbortSignal): Promise<ConfirmationPrompt> {
    return request(
      `/confirm/${encodeURIComponent(token)}`,
      { what: 'this invoice', signal },
      (raw) => readConfirmationPrompt(raw),
    );
  },

  /** `POST /v1/confirm/:token` — single use, consumed with the decision. */
  decideConfirmation(
    token: string,
    decision: 'confirmed' | 'disputed',
    note?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return request(
      `/confirm/${encodeURIComponent(token)}`,
      {
        method: 'POST',
        what: 'your answer',
        signal,
        body: { decision, ...(note ? { note } : {}) },
      },
      () => undefined,
    );
  },

  /* --- Buyer: mandates -------------------------------------------------- */

  /** `GET /v1/mandates` — this buyer's standing bids. */
  listMandates(
    params: { buyerId: string; status?: MandateStatus; limit?: number },
    signal?: AbortSignal,
  ): Promise<Page<MandateRecord>> {
    return request(
      '/mandates',
      {
        what: 'your mandates',
        query: { buyerId: params.buyerId, status: params.status, limit: params.limit ?? 200 },
        signal,
      },
      // The record, not the bare mandate: this route is the only one that says whether a
      // bid's capital is actually posted, and dropping that here would lose it silently.
      (raw) => readPage(raw, 'mandates', readMandateRecord, 'mandates'),
    );
  },

  /** `POST /v1/mandates` — written as a draft. It is not on the curve until it is funded. */
  createMandate(input: CreateMandateInput, signal?: AbortSignal): Promise<Mandate> {
    return request(
      '/mandates',
      {
        method: 'POST',
        what: 'writing that mandate',
        signal,
        body: {
          buyerId: input.buyerId,
          ratingFloor: input.ratingFloor,
          maxTenorDays: input.maxTenorDays,
          annualisedYieldBps: input.annualisedYieldBps,
          currency: input.currency,
          exposureLimitMinor: writeMoney(input.exposureLimitMinor),
          ...(input.perDebtorLimitMinor === undefined
            ? {}
            : { perDebtorLimitMinor: writeMoney(input.perDebtorLimitMinor) }),
        },
      },
      (raw) => {
        const body = readObject(raw, 'mandate');
        return readMandate(body['mandate'] ?? body, 'mandate');
      },
    );
  },

  /**
   * `POST /v1/mandates/:id/fund` — the moment the bid becomes firm, or is merely recorded.
   *
   * The venue answers `escrowVerified`, and it publishes that field for one reason, stated
   * in its own comment: *"a reader must not have to infer"* whether the amount was checked
   * against capital that exists or simply believed. This client discarded it, and the screen
   * told every buyer their capital was escrowed — which is the exact overclaim the vault
   * check, `escrow.backed` and the `Escrowed on Arc` badge were all built to prevent.
   */
  fundMandate(
    id: string,
    input: { amountMinor: MinorUnits; escrowRef: string },
    signal?: AbortSignal,
  ): Promise<{ mandate: Mandate | null; escrowVerified: boolean }> {
    return request(
      `/mandates/${encodeURIComponent(id)}/fund`,
      {
        method: 'POST',
        what: 'funding that mandate',
        signal,
        body: { amountMinor: writeMoney(input.amountMinor), escrowRef: input.escrowRef },
      },
      (raw) => {
        if (raw === undefined || raw === null) return { mandate: null, escrowVerified: false };
        const body = readObject(raw, 'mandate');
        const nested = body['mandate'];
        return {
          mandate:
            nested === undefined && body['id'] === undefined
              ? null
              : readMandate(nested ?? body, 'mandate'),
          /*
           * Absent reads as false, deliberately. A venue that does not say whether it checked
           * has not checked as far as this screen is concerned, and the sentence a buyer sees
           * should understate rather than overstate what the venue verified.
           */
          escrowVerified: body['escrowVerified'] === true,
        };
      },
    );
  },

  /** `POST /v1/mandates/:id/withdraw` — unallocated capital only. */
  withdrawMandate(
    id: string,
    amountMinor?: MinorUnits,
    signal?: AbortSignal,
  ): Promise<Mandate | null> {
    return request(
      `/mandates/${encodeURIComponent(id)}/withdraw`,
      {
        method: 'POST',
        what: 'that withdrawal',
        signal,
        body: amountMinor === undefined ? {} : { amountMinor: writeMoney(amountMinor) },
      },
      (raw) => {
        if (raw === undefined || raw === null) return null;
        const body = readObject(raw, 'mandate');
        const nested = body['mandate'];
        return nested === undefined && body['id'] === undefined
          ? null
          : readMandate(nested ?? body, 'mandate');
      },
    );
  },

  /**
   * `GET /v1/mandates/exposure` — committed, allocated, unallocated and concentration
   * across the buyer's whole book. Registered before `/:id/...` on the server so the static
   * segment is not swallowed by the param.
   *
   * Returned raw: the aggregation shape is not stated anywhere in the frozen schemas, and
   * the mandates page computes the same figures from the mandates it already holds. This is
   * here so the route is reachable, not so a screen can depend on a shape nobody fixed.
   */
  buyerExposure(buyerId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return request(
      '/mandates/exposure',
      { what: 'your exposure', query: { buyerId }, signal },
      (raw) => readObject(raw, 'exposure'),
    );
  },

  /** `GET /v1/mandates/:id/exposure` — one mandate's allocations by customer. */
  mandateExposure(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return request(
      `/mandates/${encodeURIComponent(id)}/exposure`,
      { what: "that mandate's exposure", signal },
      (raw) => readObject(raw, 'exposure'),
    );
  },

  /* --- Trades ----------------------------------------------------------- */

  /**
   * `POST /v1/trades` — execute a sale.
   *
   * One route, two halves of one x402 exchange. The first request arms the trade and comes
   * back **402** carrying the challenge: the asset leg is held on Hedera, nothing has
   * moved, and the cash leg is waiting for the buyer's signature in `PAYMENT-SIGNATURE`.
   * That is a stage of delivery-versus-payment rather than a failure, so it is returned as
   * a state and not thrown — and it is decoded, because a challenge nobody can read is a
   * challenge nobody can sign.
   *
   * The `payment-required` header carries a whole `PaymentRequired` (v2), not a bare
   * requirements object; the body carries the same `accepts` and `resource`, so the header
   * is read as a cross-check and the body is the source.
   */
  executeTrade(
    input: ExecuteTradeInput,
    signal?: AbortSignal,
  ): Promise<
    | { status: 'settled'; trade: TradeRecord }
    | { status: 'payment_required'; challenge: TradeChallenge }
  > {
    const url = `${API_V1}/trades`;

    return (async () => {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          cache: 'no-store',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({
            invoiceId: input.invoiceId,
            quoteId: input.quoteId,
            maxSlippageBps: input.maxSlippageBps ?? 0,
          }),
          ...(signal ? { signal } : {}),
        });
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
        throw new ApiError({
          code: 'unreachable',
          status: 0,
          title: 'No answer',
          url,
          what: 'this sale',
          cause,
        });
      }

      const text = await response.text();
      let payload: unknown = undefined;
      if (text.trim() !== '') {
        try {
          payload = JSON.parse(text);
        } catch (cause) {
          throw new ApiError({
            code: 'unreadable',
            status: response.status,
            title: 'Unreadable response',
            detail: 'the body is not JSON',
            url,
            what: 'this sale',
            cause,
          });
        }
      }

      if (response.status === 402) {
        const challenge = readTradeChallenge(payload, 'the payment challenge');
        // Same object, two carriers. Where the header decodes and the body did not name a
        // resource, the header fills it in; a header that disagrees is not authoritative.
        const header = decodePaymentRequiredHeader(response.headers.get('payment-required'));
        return {
          status: 'payment_required' as const,
          challenge:
            challenge.payment.resource === null && header?.resource
              ? { ...challenge, payment: { ...challenge.payment, resource: header.resource } }
              : challenge,
        };
      }
      if (!response.ok) throw problemFrom(payload, response.status, url, 'this sale');

      const body = readObject(payload, 'trade');
      return { status: 'settled' as const, trade: readTrade(body['trade'] ?? body, 'trade') };
    })();
  },

  /** `GET /v1/trades` — filtered to whichever side asked. */
  listTrades(
    params: { sellerId?: string; buyerId?: string; status?: TradeStatus; limit?: number },
    signal?: AbortSignal,
  ): Promise<Page<TradeRecord>> {
    return request(
      '/trades',
      {
        what: 'your trades',
        query: {
          sellerId: params.sellerId,
          buyerId: params.buyerId,
          status: params.status,
          limit: params.limit ?? 200,
        },
        signal,
      },
      (raw) => readPage(raw, 'trades', readTrade, 'trades'),
    );
  },

  /** `GET /v1/trades/:id`. */
  getTrade(id: string, signal?: AbortSignal): Promise<TradeRecord> {
    return request(`/trades/${encodeURIComponent(id)}`, { what: 'that trade', signal }, (raw) => {
      const body = readObject(raw, 'trade');
      return readTrade(body['trade'] ?? body, 'trade');
    });
  },

  /** `GET /v1/trades/:id/proof` — the audit view, one click from any trade. */
  getTradeProof(id: string, signal?: AbortSignal): Promise<TradeProofResponse> {
    return request(
      `/trades/${encodeURIComponent(id)}/proof`,
      { what: 'the proof of that trade', signal },
      (raw) => readTradeProof(raw),
    );
  },
};

export type FactureApi = typeof api;
