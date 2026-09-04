/**
 * The venue, over HTTP.
 *
 * Reads the book and the agent's own mandates from `@facture/backend`, and arms a trade
 * against a quote. Nothing here decides anything: it parses, validates and converts, and
 * hands typed domain values to `agent.ts`.
 *
 * ## Money on the wire
 *
 * The backend renders every amount as a **decimal string of minor units** (`"4000000"` is
 * $40,000.00), for the reason set out in its `src/wire.ts`: `JSON.parse` produces an IEEE-754
 * double, which is exact only below 2^53, and a committed-capital figure or an 8-decimal
 * HBAR leg passes that without anything looking wrong. So every amount is read with
 * `BigInt(string)` and never with `Number`. A response that carries an amount as a JSON
 * number is rejected rather than coerced — it means the two services disagree about the
 * representation, and guessing which one is right is how a hundredfold error gets in.
 *
 * ## The book is read per seller
 *
 * The backend exposes the book as `GET /v1/invoices?sellerId=…`; there is no buyer-side
 * "everything listed" route today. So the agent is configured with the sellers whose books
 * it watches and unions them. When a buyer-facing book route exists this is the one place
 * that changes.
 */

import {
  CURRENCIES,
  MANDATE_STATUSES,
  QUOTABLE_INVOICE_STATUSES,
  RATINGS,
  tenorDays as tenorDaysBetween,
  type Currency,
  type InvoiceStatus,
  type MandateStatus,
  type MinorUnits,
  type Rating,
} from '@facture/shared';
import { z } from 'zod';
import type { MandateAllocations, MandateTerms } from './mandate.js';

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * Wire schemas
 * ───────────────────────────────────────────────────────────────────────────────────── */

/**
 * An amount as the backend renders it. `z.string()` first, so a JSON number fails the type
 * check rather than being coerced — see the note on representation above.
 */
const wireMoney = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, 'must be a non-negative integer in minor units, as a decimal string')
  .transform((v) => BigInt(v));

const wireCurrency = z.enum(CURRENCIES as unknown as [Currency, ...Currency[]]);
const wireRating = z.enum(RATINGS as unknown as [Rating, ...Rating[]]);
const wireMandateStatus = z.enum(
  MANDATE_STATUSES as unknown as [MandateStatus, ...MandateStatus[]],
);

const mandateSchema = z.object({
  id: z.string().min(1),
  buyerId: z.string().min(1),
  ratingFloor: wireRating,
  maxTenorDays: z.number().int().positive(),
  annualisedYieldBps: z.number().int().nonnegative(),
  currency: wireCurrency,
  /** The ceiling the buyer wrote. */
  exposureLimit: wireMoney,
  perDebtorLimit: wireMoney.nullable(),
  /** Escrowed capital. This is what actually bounds a match. */
  committed: wireMoney,
  allocated: wireMoney,
  unallocated: wireMoney,
  status: wireMandateStatus,
  quoting: z.boolean().optional(),
  debtorExposure: z.record(wireMoney).optional(),
});

const mandateListSchema = z.object({ mandates: z.array(mandateSchema) });

const bookRowSchema = z.object({
  id: z.string().min(1),
  sellerId: z.string().min(1),
  debtorId: z.string().min(1),
  invoiceNumber: z.string(),
  faceValue: wireMoney,
  currency: wireCurrency,
  dueAt: z.string().min(1),
  status: z.string().min(1),
  instrumentAddress: z.string().nullable().optional(),
  debtor: z.object({ id: z.string(), name: z.string(), rating: wireRating }).nullable().optional(),
  tenorDays: z.number().int().nullable().optional(),
  mandatesMatching: z.number().int().nonnegative().optional(),
});

const bookPageSchema = z.object({
  invoices: z.array(bookRowSchema),
  nextCursor: z.string().nullable().optional(),
});

const quoteSchema = z.object({
  invoiceId: z.string(),
  mandateId: z.string(),
  annualisedYieldBps: z.number().int(),
  tenorDays: z.number().int(),
  faceValue: wireMoney,
  discount: wireMoney,
  proceeds: wireMoney,
  currency: wireCurrency,
  asOf: z.string(),
  expiresAt: z.string(),
});

const liveQuoteSchema = z.object({
  invoiceId: z.string(),
  rating: wireRating,
  tenorDays: z.number().int(),
  quote: quoteSchema.nullable(),
  quoteId: z.string().nullable(),
  mandatesConsidered: z.number().int().nonnegative().optional(),
  mandatesMatching: z.number().int().nonnegative().optional(),
  pricedAt: z.string().optional(),
});

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * What this module hands back
 * ───────────────────────────────────────────────────────────────────────────────────── */

/** A mandate as the venue holds it: the terms, plus what has already been spent. */
export interface VenueMandate {
  readonly terms: MandateTerms;
  readonly allocations: MandateAllocations;
  /** The ceiling the buyer wrote, kept for reporting. `terms.totalCommitted` is what binds. */
  readonly exposureLimit: MinorUnits;
  readonly escrowedCapital: MinorUnits;
}

/** One line of the book, with everything the decision needs and nothing it does not. */
export interface BookRow {
  readonly invoiceId: string;
  readonly sellerId: string;
  readonly debtorId: string;
  readonly debtorName: string | undefined;
  readonly rating: Rating;
  readonly invoiceNumber: string;
  readonly faceValue: MinorUnits;
  readonly currency: Currency;
  readonly dueAt: string;
  readonly tenorDays: number;
  readonly status: InvoiceStatus;
  readonly quotable: boolean;
  readonly issued: boolean;
}

export interface LiveQuote {
  readonly invoiceId: string;
  /** The handle `POST /v1/trades` is executed against. `null` when nothing will take it. */
  readonly quoteId: string | null;
  readonly mandateId: string | null;
  readonly proceeds: MinorUnits | null;
  readonly discount: MinorUnits | null;
  readonly annualisedYieldBps: number | null;
  readonly tenorDays: number;
  readonly rating: Rating;
  readonly expiresAt: string | null;
}

/** What `POST /v1/trades` returns before the cash leg is signed. */
export interface ArmedTrade {
  readonly invoiceId: string;
  readonly quoteId: string;
  /** HTTP status. `402` is the success case: the x402 challenge is waiting to be signed. */
  readonly status: number;
  /** The x402 challenge, verbatim. Signing it is the settlement package's job, not this one's. */
  readonly challenge: unknown;
}

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * Errors
 * ───────────────────────────────────────────────────────────────────────────────────── */

/**
 * A venue call that did not come back as expected.
 *
 * Carries the status and the backend's own error code so the agent can distinguish "this
 * invoice was taken by someone else" from "the venue is down" — one is an ordinary outcome
 * of a competitive book, the other is a reason to back off.
 */
export class VenueError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly path: string,
  ) {
    super(message);
    this.name = 'VenueError';
  }
}

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * The client
 * ───────────────────────────────────────────────────────────────────────────────────── */

export interface VenueClientConfig {
  readonly baseUrl: string;
  /** Bounded so a hung venue cannot stall the loop indefinitely. */
  readonly timeoutMs?: number | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export interface VenueClient {
  /** The agent's own mandates. Only `active` ones quote; the rest are returned for reporting. */
  mandates(buyerId: string): Promise<readonly VenueMandate[]>;
  /** Every invoice on the books of the given sellers, deduplicated by invoice id. */
  book(sellerIds: readonly string[], limit?: number): Promise<readonly BookRow[]>;
  /** The live price, and the quote id a trade is executed against. */
  quote(invoiceId: string): Promise<LiveQuote>;
  /**
   * Arm a trade. Returns the x402 challenge; **does not** settle, because signing the cash
   * leg is the settlement package's job. Nothing here broadcasts a transaction.
   */
  armTrade(input: {
    readonly invoiceId: string;
    readonly quoteId: string;
    readonly maxSlippageBps?: number | undefined;
  }): Promise<ArmedTrade>;
}

export function createVenueClient(config: VenueClientConfig): VenueClient {
  const base = config.baseUrl.replace(/\/+$/, '');
  const timeoutMs = config.timeoutMs ?? 10_000;
  const doFetch = config.fetch ?? globalThis.fetch;

  async function request(
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: unknown }> {
    const url = `${base}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, {
        ...init,
        signal: controller.signal,
        headers: { accept: 'application/json', ...(init.headers ?? {}) },
      });
      const text = await response.text();
      let body: unknown = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          throw new VenueError(
            `${path} returned ${response.status} with a body that is not JSON`,
            response.status,
            undefined,
            path,
          );
        }
      }
      return { status: response.status, body };
    } catch (cause) {
      if (cause instanceof VenueError) throw cause;
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new VenueError(`${path} failed: ${reason}`, 0, undefined, path);
    } finally {
      clearTimeout(timer);
    }
  }

  async function getJson(path: string): Promise<unknown> {
    const { status, body } = await request(path);
    if (status < 200 || status >= 300) throw errorFrom(status, body, path);
    return body;
  }

  return {
    async mandates(buyerId) {
      const body = await getJson(`/v1/mandates?buyerId=${encodeURIComponent(buyerId)}&limit=200`);
      const parsed = parse(mandateListSchema, body, '/v1/mandates');
      return parsed.mandates.map(toVenueMandate);
    },

    async book(sellerIds, limit = 100) {
      const seen = new Map<string, BookRow>();
      for (const sellerId of sellerIds) {
        let cursor: string | null = null;
        // Bounded rather than `while (cursor)`: a venue that kept returning a cursor would
        // otherwise hold the tick open forever, and a tick that never ends never re-reads
        // its balance.
        for (let page = 0; page < 20; page += 1) {
          const query = new URLSearchParams({ sellerId, limit: String(limit) });
          if (cursor !== null) query.set('cursor', cursor);
          const body = await getJson(`/v1/invoices?${query.toString()}`);
          const parsed = parse(bookPageSchema, body, '/v1/invoices');
          for (const row of parsed.invoices) {
            const mapped = toBookRow(row);
            if (mapped !== null) seen.set(mapped.invoiceId, mapped);
          }
          cursor = parsed.nextCursor ?? null;
          if (cursor === null) break;
        }
      }
      return [...seen.values()];
    },

    async quote(invoiceId) {
      const body = await getJson(
        `/v1/invoices/${encodeURIComponent(invoiceId)}/quote?includeRefusals=false`,
      );
      const parsed = parse(liveQuoteSchema, body, '/v1/invoices/:id/quote');
      return {
        invoiceId: parsed.invoiceId,
        quoteId: parsed.quoteId,
        mandateId: parsed.quote?.mandateId ?? null,
        proceeds: parsed.quote?.proceeds ?? null,
        discount: parsed.quote?.discount ?? null,
        annualisedYieldBps: parsed.quote?.annualisedYieldBps ?? null,
        tenorDays: parsed.tenorDays,
        rating: parsed.rating,
        expiresAt: parsed.quote?.expiresAt ?? null,
      };
    },

    async armTrade(input) {
      const { status, body } = await request('/v1/trades', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          invoiceId: input.invoiceId,
          quoteId: input.quoteId,
          maxSlippageBps: input.maxSlippageBps ?? 0,
        }),
      });

      /*
       * 402 is the success case, not a failure. The first half of the x402 exchange arms
       * the trade and answers with the challenge; the cash leg is signed against it
       * afterwards. Treating 402 as an error would make the settlement path unreachable.
       */
      if (status !== 402 && (status < 200 || status >= 300)) {
        throw errorFrom(status, body, '/v1/trades');
      }
      return { invoiceId: input.invoiceId, quoteId: input.quoteId, status, challenge: body };
    },
  };
}

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * Mapping
 * ───────────────────────────────────────────────────────────────────────────────────── */

function toVenueMandate(row: z.infer<typeof mandateSchema>): VenueMandate {
  /*
   * `committed`, not `exposureLimit`, is what a mandate can match against — a bid quotes
   * what it funded, not what it intends to fund. The minimum of the two is taken because
   * both bind independently: escrow above the buyer's written ceiling is still capital they
   * said they did not want deployed, and a ceiling above the escrow is capital that is not
   * there. Taking the lesser is the only reading that respects both.
   */
  const committed = row.committed < row.exposureLimit ? row.committed : row.exposureLimit;

  return {
    terms: {
      id: row.id,
      buyerId: row.buyerId,
      currency: row.currency,
      minRating: row.ratingFloor,
      maxTenorDays: row.maxTenorDays,
      annualisedYieldBps: row.annualisedYieldBps,
      totalCommitted: committed,
      // No concentration cap set means the total pool is the only cap.
      maxPerDebtor: row.perDebtorLimit ?? row.exposureLimit,
      status: row.status,
    },
    allocations: { total: row.allocated, byDebtor: row.debtorExposure ?? {} },
    exposureLimit: row.exposureLimit,
    escrowedCapital: row.committed,
  };
}

function toBookRow(row: z.infer<typeof bookRowSchema>): BookRow | null {
  /*
   * A row with no debtor has no rating, and a rating is the first thing a mandate screens
   * on. Dropping it is right: guessing `UNRATED` would quote paper whose credit the venue
   * has not told us about, which is precisely the number a mandate is written against.
   */
  if (row.debtor === null || row.debtor === undefined) return null;

  const status = row.status as InvoiceStatus;
  return {
    invoiceId: row.id,
    sellerId: row.sellerId,
    debtorId: row.debtorId,
    debtorName: row.debtor.name,
    rating: row.debtor.rating,
    invoiceNumber: row.invoiceNumber,
    faceValue: row.faceValue,
    currency: row.currency,
    dueAt: row.dueAt,
    // The venue's tenor wins where it has one, so the agent and the venue cannot disagree
    // about what day it is mid-tick. Derived only when the row was not priced.
    tenorDays: row.tenorDays ?? tenorDaysBetween(row.dueAt),
    status,
    quotable: QUOTABLE_INVOICE_STATUSES.includes(status),
    /*
     * Issuance is paced and off the critical path, so an invoice is quotable before its ATS
     * bond exists. The agent may price it, but a trade against it would be refused as
     * `issuance_pending`, so it is worth knowing before arming one.
     */
    issued: typeof row.instrumentAddress === 'string' && row.instrumentAddress.length > 0,
  };
}

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * Helpers
 * ───────────────────────────────────────────────────────────────────────────────────── */

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown, path: string): z.infer<T> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const detail = result.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
  throw new VenueError(
    `${path} returned a body this agent cannot read — ${detail}`,
    200,
    undefined,
    path,
  );
}

const errorBodySchema = z.object({
  error: z
    .object({ code: z.string().optional(), message: z.string().optional() })
    .partial()
    .optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});

function errorFrom(status: number, body: unknown, path: string): VenueError {
  const parsed = errorBodySchema.safeParse(body);
  const code = parsed.success ? (parsed.data.error?.code ?? parsed.data.code) : undefined;
  const message = parsed.success ? (parsed.data.error?.message ?? parsed.data.message) : undefined;
  return new VenueError(message ?? `${path} returned ${status}`, status, code, path);
}
