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
import { paymentChallengeSchema, type PaymentChallenge, type PaymentPayload } from './cash.js';
import type { MandateAllocations, MandateTerms, VaultBacking } from './mandate.js';

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
  /**
   * Whether the buyer's capital is actually posted on Arc, as the venue reads it.
   *
   * `backed` is the one field this agent acts on, and it means more than it looks like:
   * the venue sets it by comparing the vault's balance against the mandate's **whole**
   * committed capital, not against one trade. So a backed mandate covers anything that
   * fits inside the headroom `decide` already checks — which is why nothing here has to
   * convert a price into USDC, and why this agent needs no copy of the venue's scale.
   *
   * Optional because a deployment with no vault omits it, and `checked` distinguishes
   * "we asked and the answer was no" from "there was nothing to ask".
   */
  escrow: z
    .object({
      checked: z.boolean(),
      depositedUsdcMinor: wireMoney.nullable(),
      requiredUsdcMinor: wireMoney,
      backed: z.boolean(),
    })
    .optional(),
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

const railSchema = z.object({ chosen: z.string().min(1), reason: z.string() });

const cashLegSchema = z.object({
  chain: z.string(),
  rail: z.string(),
  state: z.string(),
  transaction: z.string().nullable().optional(),
  settledAmountMinor: z.string().nullable().optional(),
  explorerUrl: z.string().nullable().optional(),
});

const assetLegSchema = z.object({
  state: z.string(),
  transactionId: z.string().nullable().optional(),
  unitsMinor: z.string().nullable().optional(),
  explorerUrl: z.string().nullable().optional(),
});

/**
 * The armed-trade body. Every field is optional because the two rails return different
 * shapes from one route, and the status code — not the body — is what says which.
 */
const armedBodySchema = z.object({
  trade: z.object({ id: z.string() }).partial().optional(),
  rail: railSchema.optional(),
  cashLeg: cashLegSchema.optional(),
  assetLeg: assetLegSchema.optional(),
  settledAt: z.string().optional(),
});

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * What this module hands back
 * ───────────────────────────────────────────────────────────────────────────────────── */

export type { VaultBacking };

/** A mandate as the venue holds it: the terms, plus what has already been spent. */
export interface VenueMandate {
  readonly terms: MandateTerms;
  readonly allocations: MandateAllocations;
  /** The ceiling the buyer wrote, kept for reporting. `terms.totalCommitted` is what binds. */
  readonly exposureLimit: MinorUnits;
  /**
   * The venue's book figure for committed capital, in the MANDATE's minor units.
   *
   * Named "escrowed" long before anything was escrowed anywhere. It is a database number,
   * not a chain reading — {@link VenueMandate.vault} is the chain. Two fields whose names
   * both say escrow at two different scales is the confusion that produced this whole
   * change, so the distinction is spelled out rather than left to the reader.
   */
  readonly escrowedCapital: MinorUnits;
  /**
   * What the Arc vault actually holds behind this bid, or `null` when the venue did not say.
   *
   * `null` is not "unbacked". A deployment with no vault reports nothing, and treating that
   * as a refusal would stop the agent trading against a venue that never escrows at all.
   */
  readonly vault: VaultBacking | null;
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

/**
 * Which rail the venue chose for a trade, in its own words.
 *
 * Read rather than inferred from the status code. Both are honest signals and they cannot
 * disagree, but a reader of a log should not have to know that 200 means Arc — the venue
 * publishes the reason as a sentence and throwing it away is how a build ends up demoing the
 * rail it did not mean to.
 */
export interface RailChoice {
  readonly chosen: string;
  readonly reason: string;
}

/**
 * What `POST /v1/trades` returns for the first half of the exchange.
 *
 * **Two outcomes, and the status is which.** `200` means the buyer's capital was escrowed on
 * Arc and the trade is *already settled* — there was nothing to sign, because a funded
 * mandate agreed in advance to anything meeting its terms. `402` means the cash leg is
 * pay-as-you-go on Hedera and the challenge is waiting.
 */
export interface ArmedTrade {
  readonly invoiceId: string;
  readonly quoteId: string;
  /** `200` (settled out of escrow on Arc) or `402` (an x402 challenge to sign on Hedera). */
  readonly status: number;
  readonly rail: RailChoice | null;
  /**
   * The x402 challenge, parsed from the `payment-required` header. `null` on a 200.
   *
   * **From the header, not the body.** The venue duplicates `accepts` into the JSON for
   * convenience, and reading that copy would make this a client of Facture's response shape
   * rather than of x402. The header is where the protocol puts it, and it is what any other
   * x402 client would read.
   */
  readonly challenge: PaymentChallenge | null;
  /** Set when the venue answered 402 without a readable challenge. Nothing can be signed. */
  readonly challengeError: string | null;
  /**
   * Both legs, present only on the 200 — where arming *was* the settlement.
   *
   * On a 402 these are null because nothing has moved: the asset leg is held rather than
   * transferred and the cash leg does not exist until the payer signs. Carrying the held
   * asset leg here would report a hold as a transfer, which is the one thing a receipt of
   * this shape must never do.
   */
  readonly cashLeg: CashLegReceipt | null;
  readonly assetLeg: AssetLegReceipt | null;
  readonly settledAt: string | null;
}

/** What the second half returns: both legs, done. */
export interface SettledTrade {
  readonly invoiceId: string;
  readonly tradeId: string | null;
  readonly settledAt: string | null;
  readonly cashLeg: CashLegReceipt | null;
  readonly assetLeg: AssetLegReceipt | null;
}

export interface CashLegReceipt {
  readonly chain: string;
  readonly rail: string;
  readonly state: string;
  /** The transaction the facilitator submitted. This is the money moving, on chain. */
  readonly transaction: string | null;
  /** What was actually paid, in the settlement asset's smallest unit, as the payer signed it. */
  readonly settledAmountMinor: string | null;
  readonly explorerUrl: string | null;
}

export interface AssetLegReceipt {
  readonly state: string;
  readonly transactionId: string | null;
  readonly unitsMinor: string | null;
  readonly explorerUrl: string | null;
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
   * Arm a trade — the first half of the exchange.
   *
   * Comes back either already settled out of the buyer's Arc escrow (200) or carrying an
   * x402 challenge to sign (402). Nothing here signs anything: the key lives in `cash.ts`
   * and the decision to use it lives in `agent.ts`.
   */
  armTrade(input: {
    readonly invoiceId: string;
    readonly quoteId: string;
    readonly maxSlippageBps?: number | undefined;
  }): Promise<ArmedTrade>;
  /**
   * The second half: repeat the same request with the signed payload, and the venue settles
   * both legs against each other.
   *
   * **The same body, deliberately.** One route serves both halves so that a client cannot
   * execute a payment against a challenge it never received, and sending different terms
   * here would be answered as a trade that does not exist rather than filled at the new
   * ones.
   */
  settleTrade(input: {
    readonly invoiceId: string;
    readonly quoteId: string;
    readonly maxSlippageBps?: number | undefined;
    readonly payment: PaymentPayload;
  }): Promise<SettledTrade>;
}

/**
 * x402 v2 header names. Lowercase because `Headers` is case-insensitive on lookup and this
 * is the spelling the shipped `@x402/*` v2 packages use — there is no `X-PAYMENT` at v2, and
 * a v1 spelling fails as a missing signature rather than as a bad one.
 */
const X402_HEADERS = {
  required: 'payment-required',
  signature: 'payment-signature',
} as const;

export function createVenueClient(config: VenueClientConfig): VenueClient {
  const base = config.baseUrl.replace(/\/+$/, '');
  const timeoutMs = config.timeoutMs ?? 10_000;
  const doFetch = config.fetch ?? globalThis.fetch;

  async function request(
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: unknown; headers: Headers }> {
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
      return { status: response.status, body, headers: response.headers };
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
      const { status, body, headers } = await request('/v1/trades', tradeRequest(input));

      /*
       * 402 is the success case, not a failure. The first half of the x402 exchange arms
       * the trade and answers with the challenge; the cash leg is signed against it
       * afterwards. Treating 402 as an error would make the settlement path unreachable.
       */
      if (status !== 402 && (status < 200 || status >= 300)) {
        throw errorFrom(status, body, '/v1/trades');
      }

      const parsed = armedBodySchema.safeParse(body);
      const rail = parsed.success ? (parsed.data.rail ?? null) : null;

      if (status !== 402) {
        return {
          invoiceId: input.invoiceId,
          quoteId: input.quoteId,
          status,
          rail,
          challenge: null,
          challengeError: null,
          cashLeg: parsed.success ? toCashLeg(parsed.data.cashLeg) : null,
          assetLeg: parsed.success ? toAssetLeg(parsed.data.assetLeg) : null,
          settledAt: parsed.success ? (parsed.data.settledAt ?? null) : null,
        };
      }

      const decoded = decodeChallenge(headers.get(X402_HEADERS.required));
      return {
        invoiceId: input.invoiceId,
        quoteId: input.quoteId,
        status,
        rail,
        challenge: decoded.challenge,
        challengeError: decoded.error,
        cashLeg: null,
        assetLeg: null,
        settledAt: null,
      };
    },

    async settleTrade(input) {
      const { status, body } = await request('/v1/trades', {
        ...tradeRequest(input),
        headers: {
          'content-type': 'application/json',
          [X402_HEADERS.signature]: encodeBase64Json(input.payment),
        },
      });
      if (status < 200 || status >= 300) throw errorFrom(status, body, '/v1/trades');

      const parsed = parse(armedBodySchema, body, '/v1/trades');
      return {
        invoiceId: input.invoiceId,
        tradeId: parsed.trade?.id ?? null,
        settledAt: parsed.settledAt ?? null,
        cashLeg: toCashLeg(parsed.cashLeg),
        assetLeg: toAssetLeg(parsed.assetLeg),
      };
    },
  };

  function tradeRequest(input: {
    readonly invoiceId: string;
    readonly quoteId: string;
    readonly maxSlippageBps?: number | undefined;
  }): RequestInit {
    return {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        invoiceId: input.invoiceId,
        quoteId: input.quoteId,
        maxSlippageBps: input.maxSlippageBps ?? 0,
      }),
    };
  }
}

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * The x402 envelope
 * ───────────────────────────────────────────────────────────────────────────────────── */

/** x402 v2 carries its payloads base64-encoded in the header, not as JSON in the body. */
const encodeBase64Json = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64');

/**
 * Read the challenge out of `payment-required`.
 *
 * **Never throws.** A 402 whose challenge cannot be read is a real answer — the trade is
 * armed, the seller's paper is held, and the agent needs to report that it cannot pay rather
 * than lose the fact in an exception on the transport. The error is carried back as a
 * sentence so the caller can log which of the three things went wrong.
 */
function decodeChallenge(header: string | null): {
  challenge: PaymentChallenge | null;
  error: string | null;
} {
  if (header === null || header.length === 0) {
    return {
      challenge: null,
      error:
        `the venue answered 402 with no ${X402_HEADERS.required} header, so there is nothing ` +
        'to sign. At x402 v2 the challenge is in that header; there is no X-PAYMENT.',
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return { challenge: null, error: `${X402_HEADERS.required} is not base64-encoded JSON` };
  }

  const parsed = paymentChallengeSchema.safeParse(decoded);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    return { challenge: null, error: `${X402_HEADERS.required} is not a v2 challenge — ${detail}` };
  }
  return { challenge: parsed.data, error: null };
}

const toCashLeg = (row: z.infer<typeof cashLegSchema> | undefined): CashLegReceipt | null =>
  row === undefined
    ? null
    : {
        chain: row.chain,
        rail: row.rail,
        state: row.state,
        transaction: row.transaction ?? null,
        settledAmountMinor: row.settledAmountMinor ?? null,
        explorerUrl: row.explorerUrl ?? null,
      };

const toAssetLeg = (row: z.infer<typeof assetLegSchema> | undefined): AssetLegReceipt | null =>
  row === undefined
    ? null
    : {
        state: row.state,
        transactionId: row.transactionId ?? null,
        unitsMinor: row.unitsMinor ?? null,
        explorerUrl: row.explorerUrl ?? null,
      };

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
    vault: row.escrow ?? null,
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
