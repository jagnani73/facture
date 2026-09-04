/**
 * The wire contract, and the only place a response is turned into domain values.
 *
 * ## Money
 *
 * The backend owns this rule in `packages/backend/src/wire.ts` and it is not negotiable at
 * this end: **on the wire an amount is a decimal string of minor units; in the app it is a
 * `bigint`.** `JSON.parse` produces a double, and a double is exact only below 2^53 — a
 * per-debtor exposure ladder or an HBAR leg at eight decimals passes that without anything
 * looking wrong, and the corruption is silent. So every amount arrives as a string and
 * becomes a `bigint` here, once.
 *
 * Field names carry the domain name and nothing else — `faceValue`, not `faceMinor` —
 * again per the backend's own rule. The one documented exception is the proof view's
 * `discountMinor` / `proceedsMinor`, which the backend flags as a rename it has not made
 * yet; both spellings are read.
 *
 * ## What is frozen
 *
 * The zod schemas in `packages/backend/src/routes/` freeze every **request**, and the
 * request shapes here come from them. Responses are read against the renderers in
 * `packages/backend/src/wire.ts` and the bodies the handlers return, with the domain types
 * in `@facture/shared` as the target. Where the wire and the domain use different names for
 * the same thing — `ratingFloor` for `minRating`, `committed` for `totalCommitted`,
 * `createdAt` for a trade's `executedAt` — both are read and the mapping is explained where
 * it is made. This is the only file that has to change if a shape moves.
 *
 * A decoder never guesses. If a field the screen would render is missing or the wrong
 * type, it raises an `unreadable` `ApiError` naming the path, and the screen says so in
 * words rather than rendering a zero that looks like a price.
 */

import type {
  ChainKey,
  Currency,
  Debtor,
  Invoice,
  InvoiceStatus,
  Mandate,
  MandateStatus,
  MinorUnits,
  Quote,
  Rating,
  Refusal,
  RefusalCode,
  RefusalReceipt,
  RegulationKey,
  SettlementLeg,
  SettlementLegState,
  Trade,
} from '@/lib/domain';
import {
  CURRENCIES,
  formatMinorUnits,
  INVOICE_STATUSES,
  MANDATE_STATUSES,
  RATINGS,
  REFUSAL_CODES,
  SETTLEMENT_LEG_STATES,
  isRegulationKey,
} from '@/lib/domain';
import { ApiError } from './problem';

/* -------------------------------------------------------------------------- */
/* Readers                                                                     */
/* -------------------------------------------------------------------------- */

function unreadable(path: string, expected: string): never {
  throw new ApiError({
    code: 'unreadable',
    status: 0,
    title: 'Unreadable response',
    detail: `\`${path}\` ${expected}`,
  });
}

function field(source: Record<string, unknown>, ...names: readonly string[]): unknown {
  for (const name of names) {
    const value = source[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

export function readObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    unreadable(path, 'should be an object');
  }
  return value as Record<string, unknown>;
}

function readArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) unreadable(path, 'should be an array');
  return value;
}

function readString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') unreadable(path, 'should be a non-empty string');
  return value;
}

function readOptionalString(value: unknown, path: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') unreadable(path, 'should be a string when present');
  return value;
}

function readNumber(value: unknown, path: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // A count or a tenor may legitimately arrive as a numeric string from a SQL driver.
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  unreadable(path, 'should be a number');
}

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value === 'boolean') return value;
  unreadable(path, 'should be a boolean');
}

function readEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  const raw = readString(value, path);
  const found = allowed.find((option) => option === raw || option === raw.toUpperCase());
  if (found === undefined)
    unreadable(path, `should be one of ${allowed.join(', ')} — got "${raw}"`);
  return found;
}

/**
 * An amount. Strictly a decimal integer string of minor units, matching the backend's
 * `moneyString` / `money` pair exactly. A number is rejected rather than coerced: a
 * `number` here means the service dropped the convention, and quietly accepting it would
 * reintroduce the precision loss the convention exists to prevent.
 */
export function readMoney(value: unknown, path: string): MinorUnits {
  if (typeof value !== 'string' || !/^-?(0|[1-9]\d*)$/.test(value)) {
    unreadable(path, 'should be an integer amount in minor units, as a decimal string');
  }
  return BigInt(value);
}

function readOptionalMoney(value: unknown, path: string): MinorUnits | null {
  if (value === undefined || value === null) return null;
  return readMoney(value, path);
}

/** Money is written back out exactly as the backend's `money()` renders it. */
export const writeMoney = (amount: MinorUnits): string => amount.toString(10);

/* -------------------------------------------------------------------------- */
/* Envelopes                                                                   */
/* -------------------------------------------------------------------------- */

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * The listing envelopes. Each route names its own collection — `{ invoices, nextCursor }`,
 * `{ mandates }`, `{ trades }` — so the key is passed in rather than guessed, with `items`
 * and a bare array accepted as well.
 */
export function readPage<T>(
  value: unknown,
  path: string,
  readItem: (raw: unknown, itemPath: string) => T,
  key = 'items',
): Page<T> {
  if (Array.isArray(value)) {
    return { items: value.map((item, i) => readItem(item, `${path}[${i}]`)), nextCursor: null };
  }

  const body = readObject(value, path);
  const rawItems = field(body, key, 'items', 'data', 'results');
  if (rawItems === undefined) {
    unreadable(path, `should be an array, or an object carrying one under \`${key}\``);
  }

  return {
    items: readArray(rawItems, `${path}.items`).map((item, i) =>
      readItem(item, `${path}.items[${i}]`),
    ),
    nextCursor: readOptionalString(field(body, 'nextCursor', 'cursor'), `${path}.nextCursor`),
  };
}

/* -------------------------------------------------------------------------- */
/* Domain records                                                              */
/* -------------------------------------------------------------------------- */

export function readInvoice(raw: unknown, path = 'invoice'): Invoice {
  const body = readObject(raw, path);

  const hash = readOptionalString(field(body, 'uniquenessHash'), `${path}.uniquenessHash`);
  const instrument = readOptionalString(
    field(body, 'instrumentAddress', 'securityId'),
    `${path}.instrumentAddress`,
  );
  const partition = readOptionalString(field(body, 'partition'), `${path}.partition`);

  const invoice: Invoice = {
    id: readString(field(body, 'id'), `${path}.id`),
    sellerId: readString(field(body, 'sellerId'), `${path}.sellerId`),
    debtorId: readString(field(body, 'debtorId'), `${path}.debtorId`),
    faceValue: readMoney(field(body, 'faceValue'), `${path}.faceValue`),
    currency: readEnum(field(body, 'currency'), `${path}.currency`, CURRENCIES) as Currency,
    invoiceNumber: readString(field(body, 'invoiceNumber'), `${path}.invoiceNumber`),
    issuedAt: readString(field(body, 'issuedAt'), `${path}.issuedAt`),
    dueAt: readString(field(body, 'dueAt'), `${path}.dueAt`),
    status: readEnum(field(body, 'status'), `${path}.status`, INVOICE_STATUSES) as InvoiceStatus,
    // Never rendered as a claim about the receivable unless it actually arrived — the
    // proof view checks `hasUniquenessHash` before it prints one.
    uniquenessHash: (hash ?? '0x') as `0x${string}`,
  };

  return {
    ...invoice,
    instrumentAddress: (instrument as `0x${string}` | null) ?? undefined,
    partition: (partition as `0x${string}` | null) ?? undefined,
    isin: readOptionalString(field(body, 'isin'), `${path}.isin`) ?? undefined,
    createdAt: readOptionalString(field(body, 'createdAt'), `${path}.createdAt`) ?? undefined,
    updatedAt: readOptionalString(field(body, 'updatedAt'), `${path}.updatedAt`) ?? undefined,
  };
}

/** True when the service actually sent a uniqueness hash rather than the decoder's stand-in. */
export const hasUniquenessHash = (invoice: Invoice): boolean =>
  invoice.uniquenessHash !== '0x' && invoice.uniquenessHash.length > 2;

export function readDebtor(raw: unknown, path = 'customer'): Debtor {
  const body = readObject(raw, path);
  return {
    id: readString(field(body, 'id'), `${path}.id`),
    name: readString(field(body, 'name'), `${path}.name`),
    rating: readEnum(field(body, 'rating'), `${path}.rating`, RATINGS) as Rating,
    onTimeCount: readNumber(field(body, 'onTimeCount') ?? 0, `${path}.onTimeCount`),
    defaultCount: readNumber(field(body, 'defaultCount') ?? 0, `${path}.defaultCount`),
    confirmedCount: readNumber(field(body, 'confirmedCount') ?? 0, `${path}.confirmedCount`),
    createdAt: readOptionalString(field(body, 'createdAt'), `${path}.createdAt`) ?? undefined,
  };
}

/**
 * A standing bid.
 *
 * The wire names the policy `ratingFloor` / `exposureLimit` / `perDebtorLimit` and the
 * capital `committed` / `allocated` / `unallocated`; the domain names the same things
 * `minRating` / `maxPerDebtor` / `totalCommitted` / `allocated`. Both spellings are read.
 *
 * `totalCommitted` maps to **`committed`**, not to `exposureLimit`, and the distinction is
 * load-bearing: `exposureLimit` is the ceiling the buyer wrote, `committed` is the money
 * they actually escrowed, and only the second one bounds a match. A mandate quotes what it
 * funded, not what it intends to fund — reading the ceiling here would make every quote on
 * the book look firmer than it is.
 */
export function readMandate(raw: unknown, path = 'mandate'): Mandate {
  const body = readObject(raw, path);

  const committed = readMoney(
    field(body, 'committed', 'totalCommitted', 'fundedMinor'),
    `${path}.committed`,
  );
  // No concentration cap set means the total commitment is the only cap.
  const perDebtor =
    readOptionalMoney(
      field(body, 'perDebtorLimit', 'maxPerDebtor', 'perDebtorLimitMinor'),
      `${path}.perDebtorLimit`,
    ) ?? committed;

  const rawExposure = field(body, 'debtorExposure');
  const debtorExposure: Record<string, MinorUnits> = {};
  if (rawExposure !== undefined) {
    const table = readObject(rawExposure, `${path}.debtorExposure`);
    for (const [debtorId, amount] of Object.entries(table)) {
      debtorExposure[debtorId] = readMoney(amount, `${path}.debtorExposure.${debtorId}`);
    }
  }

  return {
    id: readString(field(body, 'id'), `${path}.id`),
    buyerId: readString(field(body, 'buyerId'), `${path}.buyerId`),
    minRating: readEnum(
      field(body, 'ratingFloor', 'minRating'),
      `${path}.ratingFloor`,
      RATINGS,
    ) as Rating,
    maxTenorDays: readNumber(field(body, 'maxTenorDays'), `${path}.maxTenorDays`),
    annualisedYieldBps: readNumber(field(body, 'annualisedYieldBps'), `${path}.annualisedYieldBps`),
    totalCommitted: committed,
    allocated: readOptionalMoney(field(body, 'allocated'), `${path}.allocated`) ?? 0n,
    maxPerDebtor: perDebtor,
    status: readEnum(field(body, 'status'), `${path}.status`, MANDATE_STATUSES) as MandateStatus,
    currency: readEnum(
      field(body, 'currency') ?? 'USD',
      `${path}.currency`,
      CURRENCIES,
    ) as Currency,
    debtorExposure,
    createdAt: readOptionalString(field(body, 'createdAt'), `${path}.createdAt`) ?? undefined,
    fundedAt: readOptionalString(field(body, 'fundedAt'), `${path}.fundedAt`) ?? undefined,
  };
}

export function readQuote(raw: unknown, path = 'quote'): Quote {
  const body = readObject(raw, path);
  return {
    invoiceId: readString(field(body, 'invoiceId'), `${path}.invoiceId`),
    mandateId: readString(field(body, 'mandateId'), `${path}.mandateId`),
    annualisedYieldBps: readNumber(field(body, 'annualisedYieldBps'), `${path}.annualisedYieldBps`),
    tenorDays: readNumber(field(body, 'tenorDays'), `${path}.tenorDays`),
    faceValue: readMoney(field(body, 'faceValue'), `${path}.faceValue`),
    discount: readMoney(field(body, 'discount', 'discountMinor'), `${path}.discount`),
    proceeds: readMoney(field(body, 'proceeds', 'proceedsMinor'), `${path}.proceeds`),
    currency: readEnum(
      field(body, 'currency') ?? 'USD',
      `${path}.currency`,
      CURRENCIES,
    ) as Currency,
    asOf: readString(field(body, 'asOf'), `${path}.asOf`),
    expiresAt: readString(field(body, 'expiresAt'), `${path}.expiresAt`),
  };
}

/* -------------------------------------------------------------------------- */
/* Refusals                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A refusal, rebuilt into the discriminated union the UI reasons over.
 *
 * The backend sends `detail` as `Record<string, unknown>` with any `bigint` operand
 * rendered as a decimal string (`wireRefusalReceipt`). The operands are what makes a
 * refusal an explanation rather than a code, so each variant is reassembled by hand.
 */
function readRefusal(raw: unknown, code: RefusalCode, path: string): Refusal {
  const body = readObject(raw, path);
  const currency = () =>
    readEnum(field(body, 'currency') ?? 'USD', `${path}.currency`, CURRENCIES) as Currency;

  switch (code) {
    case 'RATING_BELOW_MANDATE':
      return {
        code,
        debtorId: readString(field(body, 'debtorId'), `${path}.debtorId`),
        debtorRating: readEnum(
          field(body, 'debtorRating'),
          `${path}.debtorRating`,
          RATINGS,
        ) as Rating,
        minRating: readEnum(field(body, 'minRating'), `${path}.minRating`, RATINGS) as Rating,
      };

    case 'TENOR_EXCEEDS_MANDATE':
      return {
        code,
        tenorDays: readNumber(field(body, 'tenorDays'), `${path}.tenorDays`),
        maxTenorDays: readNumber(field(body, 'maxTenorDays'), `${path}.maxTenorDays`),
      };

    case 'EXPOSURE_EXHAUSTED':
      return {
        code,
        required: readMoney(field(body, 'required'), `${path}.required`),
        unallocated: readMoney(field(body, 'unallocated'), `${path}.unallocated`),
        currency: currency(),
      };

    case 'DEBTOR_CONCENTRATION':
      return {
        code,
        debtorId: readString(field(body, 'debtorId'), `${path}.debtorId`),
        debtorName:
          readOptionalString(field(body, 'debtorName'), `${path}.debtorName`) ?? undefined,
        required: readMoney(field(body, 'required'), `${path}.required`),
        remainingForDebtor: readMoney(
          field(body, 'remainingForDebtor'),
          `${path}.remainingForDebtor`,
        ),
        maxPerDebtor: readMoney(field(body, 'maxPerDebtor'), `${path}.maxPerDebtor`),
        currency: currency(),
      };

    case 'NOT_KYC_VERIFIED':
      return {
        code,
        account: readString(field(body, 'account'), `${path}.account`),
        instrumentAddress:
          readOptionalString(field(body, 'instrumentAddress'), `${path}.instrumentAddress`) ??
          undefined,
      };

    case 'INVOICE_NOT_CONFIRMED':
      return {
        code,
        status: readEnum(field(body, 'status'), `${path}.status`, INVOICE_STATUSES),
      };

    case 'MANDATE_NOT_ACTIVE':
      return {
        code,
        status: readEnum(field(body, 'status'), `${path}.status`, MANDATE_STATUSES),
      };

    case 'CURRENCY_MISMATCH':
      return {
        code,
        invoiceCurrency: readEnum(
          field(body, 'invoiceCurrency'),
          `${path}.invoiceCurrency`,
          CURRENCIES,
        ) as Currency,
        mandateCurrency: readEnum(
          field(body, 'mandateCurrency'),
          `${path}.mandateCurrency`,
          CURRENCIES,
        ) as Currency,
      };

    case 'INELIGIBLE_JURISDICTION': {
      const allowed = field(body, 'allowedJurisdictions');
      return {
        code,
        regulation: readEnum(field(body, 'regulation'), `${path}.regulation`, [
          'REG_D_506_B',
          'REG_D_506_C',
          'REG_S',
        ] as const) as RegulationKey,
        buyerJurisdiction: readString(
          field(body, 'buyerJurisdiction'),
          `${path}.buyerJurisdiction`,
        ),
        allowedJurisdictions:
          allowed === undefined
            ? undefined
            : readArray(allowed, `${path}.allowedJurisdictions`).map((item, i) =>
                readString(item, `${path}.allowedJurisdictions[${i}]`),
              ),
      };
    }
  }
}

export function readRefusalReceipt(raw: unknown, path = 'refusal'): RefusalReceipt {
  const body = readObject(raw, path);
  const code = readEnum(field(body, 'code'), `${path}.code`, REFUSAL_CODES) as RefusalCode;

  return {
    invoiceId: readString(field(body, 'invoiceId'), `${path}.invoiceId`),
    mandateId: readOptionalString(field(body, 'mandateId'), `${path}.mandateId`),
    code,
    humanReason: readString(field(body, 'humanReason'), `${path}.humanReason`),
    detail: readRefusal(field(body, 'detail') ?? body, code, `${path}.detail`),
    checkedAt: readString(field(body, 'checkedAt'), `${path}.checkedAt`),
    hcsMessageId:
      readOptionalString(field(body, 'hcsMessageId'), `${path}.hcsMessageId`) ?? undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* The live quote — `GET /v1/invoices/:id/quote`                               */
/* -------------------------------------------------------------------------- */

/**
 * The one response body that is written out literally in the backend today, in
 * `routes/quotes.ts`. Everything except `quoteId` below is taken from it verbatim.
 */
export interface LiveQuoteResponse {
  invoiceId: string;
  rating: Rating;
  tenorDays: number;
  quote: Quote | null;
  /**
   * ASSUMED. `POST /v1/trades` requires a `quoteId: z.uuid()` — "the quote the seller
   * actually saw" — and the domain `Quote` carries no id, so the venue has to hand one
   * back with the price. Absent it, the sell action says so rather than inventing one.
   */
  quoteId: string | null;
  mandatesConsidered: number;
  mandatesMatching: number;
  refusals: RefusalReceipt[];
  pricedAt: string;
}

export function readLiveQuote(raw: unknown, path = 'quote'): LiveQuoteResponse {
  const body = readObject(raw, path);
  const quote = field(body, 'quote');
  const refusals = field(body, 'refusals');

  return {
    invoiceId: readString(field(body, 'invoiceId'), `${path}.invoiceId`),
    rating: readEnum(field(body, 'rating'), `${path}.rating`, RATINGS) as Rating,
    tenorDays: readNumber(field(body, 'tenorDays'), `${path}.tenorDays`),
    quote: quote === undefined ? null : readQuote(quote, `${path}.quote`),
    quoteId: readOptionalString(
      field(body, 'quoteId') ??
        (quote === undefined ? undefined : readObject(quote, `${path}.quote`)['id']),
      `${path}.quoteId`,
    ),
    mandatesConsidered: readNumber(
      field(body, 'mandatesConsidered') ?? 0,
      `${path}.mandatesConsidered`,
    ),
    mandatesMatching: readNumber(field(body, 'mandatesMatching') ?? 0, `${path}.mandatesMatching`),
    refusals:
      refusals === undefined
        ? []
        : readArray(refusals, `${path}.refusals`).map((item, i) =>
            readRefusalReceipt(item, `${path}.refusals[${i}]`),
          ),
    pricedAt: readString(field(body, 'pricedAt'), `${path}.pricedAt`),
  };
}

/**
 * One row of the seller's book — `GET /v1/invoices`.
 *
 * The list route prices the whole page in one batched pass and returns the price inline,
 * which is what makes "a live price in every row" one request rather than one per row.
 * What it deliberately leaves out is the refusals: the book shows one price per row, and
 * the reasons behind an absent one belong on the invoice's own screen where there is room
 * for the sentence. It also leaves out `quoteId`, which only `GET /invoices/:id/quote`
 * mints — a handle to a specific price is only owed to someone about to sell at it.
 */
export interface InvoiceRow {
  invoice: Invoice;
  debtor: Debtor | null;
  quote: Quote | null;
  tenorDays: number | null;
  mandatesMatching: number;
}

export function readInvoiceRow(raw: unknown, path = 'invoice'): InvoiceRow {
  const body = readObject(raw, path);
  const debtor = field(body, 'debtor');
  const quote = field(body, 'quote');

  return {
    invoice: readInvoice(body, path),
    debtor: debtor === undefined ? null : readDebtor(debtor, `${path}.debtor`),
    quote: quote === undefined ? null : readQuote(quote, `${path}.quote`),
    tenorDays:
      field(body, 'tenorDays') === undefined
        ? null
        : readNumber(field(body, 'tenorDays'), `${path}.tenorDays`),
    mandatesMatching: readNumber(field(body, 'mandatesMatching') ?? 0, `${path}.mandatesMatching`),
  };
}

/**
 * One invoice in full — `GET /v1/invoices/:id`.
 *
 * The price and its refusals arrive flattened onto the response rather than nested under a
 * quote object, so they are gathered back into the same `LiveQuoteResponse` the quote route
 * returns. One shape for a price, wherever it came from.
 */
export interface InvoiceDetail {
  invoice: Invoice;
  debtor: Debtor | null;
  pricing: LiveQuoteResponse;
}

export function readInvoiceDetail(raw: unknown, path = 'invoice'): InvoiceDetail {
  const body = readObject(raw, path);
  const nested = field(body, 'invoice');
  const invoice = readInvoice(nested ?? body, path);
  const rawDebtor = field(body, 'debtor', 'customer');
  const debtor = rawDebtor === undefined ? null : readDebtor(rawDebtor, `${path}.debtor`);
  const quote = field(body, 'quote');
  const refusals = field(body, 'refusals');

  return {
    invoice,
    debtor,
    pricing: {
      invoiceId: invoice.id,
      rating: debtor?.rating ?? 'UNRATED',
      tenorDays: readNumber(field(body, 'tenorDays') ?? 0, `${path}.tenorDays`),
      quote: quote === undefined ? null : readQuote(quote, `${path}.quote`),
      // Only the quote route mints a handle. Selling reads one from there.
      quoteId: readOptionalString(field(body, 'quoteId'), `${path}.quoteId`),
      mandatesConsidered: readNumber(
        field(body, 'mandatesConsidered') ?? 0,
        `${path}.mandatesConsidered`,
      ),
      mandatesMatching: readNumber(
        field(body, 'mandatesMatching') ?? 0,
        `${path}.mandatesMatching`,
      ),
      refusals:
        refusals === undefined
          ? []
          : readArray(refusals, `${path}.refusals`).map((item, i) =>
              readRefusalReceipt(item, `${path}.refusals[${i}]`),
            ),
      pricedAt:
        readOptionalString(field(body, 'pricedAt'), `${path}.pricedAt`) ?? new Date().toISOString(),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Trades                                                                      */
/* -------------------------------------------------------------------------- */

function readLeg(raw: unknown, path: string, fallbackChain: ChainKey): SettlementLeg {
  const body = readObject(raw, path);
  return {
    state: readEnum(
      field(body, 'state') ?? 'pending',
      `${path}.state`,
      SETTLEMENT_LEG_STATES,
    ) as SettlementLegState,
    chain: readOptionalString(field(body, 'chain'), `${path}.chain`) ?? fallbackChain,
    reference:
      readOptionalString(
        field(body, 'reference', 'transaction', 'transactionId'),
        `${path}.reference`,
      ) ?? undefined,
    updatedAt: readOptionalString(field(body, 'updatedAt'), `${path}.updatedAt`) ?? undefined,
    failureReason:
      readOptionalString(field(body, 'failureReason'), `${path}.failureReason`) ?? undefined,
  };
}

const PENDING_LEG = (chain: ChainKey): SettlementLeg => ({ state: 'pending', chain });

export function readTrade(raw: unknown, path = 'trade'): Trade {
  const body = readObject(raw, path);
  const assetLeg = field(body, 'assetLeg');
  const cashLeg = field(body, 'cashLeg');

  return {
    id: readString(field(body, 'id'), `${path}.id`),
    invoiceId: readString(field(body, 'invoiceId'), `${path}.invoiceId`),
    mandateId: readString(field(body, 'mandateId'), `${path}.mandateId`),
    sellerId: readString(field(body, 'sellerId'), `${path}.sellerId`),
    buyerId: readString(field(body, 'buyerId'), `${path}.buyerId`),
    faceValue: readMoney(field(body, 'faceValue'), `${path}.faceValue`),
    annualisedYieldBps: readNumber(field(body, 'annualisedYieldBps'), `${path}.annualisedYieldBps`),
    tenorDays: readNumber(field(body, 'tenorDays'), `${path}.tenorDays`),
    discount: readMoney(field(body, 'discount', 'discountMinor'), `${path}.discount`),
    proceeds: readMoney(field(body, 'proceeds', 'proceedsMinor'), `${path}.proceeds`),
    currency: readEnum(
      field(body, 'currency') ?? 'USD',
      `${path}.currency`,
      CURRENCIES,
    ) as Currency,
    assetLeg:
      assetLeg === undefined
        ? PENDING_LEG('hedera-testnet')
        : readLeg(assetLeg, `${path}.assetLeg`, 'hedera-testnet'),
    cashLeg:
      cashLeg === undefined
        ? PENDING_LEG('arc-testnet')
        : readLeg(cashLeg, `${path}.cashLeg`, 'arc-testnet'),
    // The wire calls it `createdAt`: a trade is created at the moment it is matched, and
    // there is no earlier moment for it to have been executed at.
    executedAt: readString(field(body, 'executedAt', 'createdAt'), `${path}.executedAt`),
    settledAt: readOptionalString(field(body, 'settledAt'), `${path}.settledAt`) ?? undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* The proof view — `GET /v1/trades/:id/proof`                                 */
/* -------------------------------------------------------------------------- */

/**
 * Taken field for field from the `TradeProof` interface in `packages/backend/src/routes/proof.ts`,
 * which is a real exported type rather than an assumption.
 *
 * Two fields there are deliberately loose and stay loose here. `compliance.decision` is
 * `Record<string, unknown> | null`, so the checklist the proof screen draws is read out of
 * it when it looks like a checklist and left empty otherwise — the screen shows what it was
 * given, not a checklist it invented. And every `*ExplorerUrl` is nullable because the
 * backend refuses to synthesise a link whose identifier is null: an explorer URL that 404s
 * is worse than an absent one, and that judgement is inherited rather than second-guessed.
 */
export interface ProofCheck {
  name: string;
  detail: string;
  passed: boolean;
}

export interface TradeProofResponse {
  tradeId: string;
  invoice: {
    id: string;
    invoiceNumber: string;
    uniquenessHash: string | null;
    isin: string | null;
    securityId: string | null;
    securityExplorerUrl: string | null;
  };
  confirmation: {
    decision: 'confirmed' | 'disputed' | null;
    decidedAt: string | null;
  };
  compliance: {
    allowed: boolean | null;
    checks: ProofCheck[];
    checkedAt: string | null;
    hcsTopicId: string | null;
    hcsSequenceNumber: string | null;
    hcsExplorerUrl: string | null;
  };
  pricing: {
    ratingAtQuote: string;
    tenorDays: number;
    annualisedYieldBps: number;
    faceValue: MinorUnits;
    discount: MinorUnits;
    proceeds: MinorUnits;
  } | null;
  assetLeg: {
    chain: 'hedera';
    holdId: string | null;
    transactionId: string | null;
    consensusAt: string | null;
    explorerUrl: string | null;
  };
  cashLeg: {
    chain: 'arc' | 'hedera';
    scheme: string | null;
    network: string | null;
    asset: string | null;
    transaction: string | null;
    payer: string | null;
    explorerUrl: string | null;
  };
  refusals: {
    mandateId: string;
    reasonCode: string;
    reasonText: string;
    hcsExplorerUrl: string | null;
  }[];
  settledAt: string | null;
}

/** `compliance.decision` is an open bag; a checklist is read out of it only if one is there. */
function readChecks(
  decision: unknown,
  path: string,
): { allowed: boolean | null; checks: ProofCheck[] } {
  if (decision === undefined || decision === null) return { allowed: null, checks: [] };

  const body = readObject(decision, path);
  const rawChecks = field(body, 'checks');
  const rawAllowed = field(body, 'allowed', 'decision', 'outcome');

  let allowed: boolean | null = null;
  if (typeof rawAllowed === 'boolean') allowed = rawAllowed;
  else if (typeof rawAllowed === 'string') allowed = rawAllowed.toLowerCase() === 'allowed';

  const checks =
    rawChecks === undefined
      ? []
      : readArray(rawChecks, `${path}.checks`).map((item, i) => {
          const check = readObject(item, `${path}.checks[${i}]`);
          return {
            name: readString(field(check, 'name'), `${path}.checks[${i}].name`),
            detail: readOptionalString(field(check, 'detail'), `${path}.checks[${i}].detail`) ?? '',
            passed: readBoolean(field(check, 'passed') ?? true, `${path}.checks[${i}].passed`),
          };
        });

  return { allowed, checks };
}

export function readTradeProof(raw: unknown, path = 'proof'): TradeProofResponse {
  const body = readObject(raw, path);

  const invoice = readObject(field(body, 'invoice') ?? {}, `${path}.invoice`);
  const confirmation = readObject(field(body, 'confirmation') ?? {}, `${path}.confirmation`);
  const compliance = readObject(field(body, 'compliance') ?? {}, `${path}.compliance`);
  const pricing = field(body, 'pricing');
  const assetLeg = readObject(field(body, 'assetLeg') ?? {}, `${path}.assetLeg`);
  const cashLeg = readObject(field(body, 'cashLeg') ?? {}, `${path}.cashLeg`);
  const refusals = field(body, 'refusals');

  const decision = readOptionalString(
    field(confirmation, 'decision'),
    `${path}.confirmation.decision`,
  );

  return {
    tradeId: readString(field(body, 'tradeId'), `${path}.tradeId`),
    invoice: {
      id: readString(field(invoice, 'id'), `${path}.invoice.id`),
      invoiceNumber:
        readOptionalString(field(invoice, 'invoiceNumber'), `${path}.invoice.invoiceNumber`) ?? '',
      uniquenessHash: readOptionalString(
        field(invoice, 'uniquenessHash'),
        `${path}.invoice.uniquenessHash`,
      ),
      isin: readOptionalString(field(invoice, 'isin'), `${path}.invoice.isin`),
      securityId: readOptionalString(field(invoice, 'securityId'), `${path}.invoice.securityId`),
      securityExplorerUrl: readOptionalString(
        field(invoice, 'securityExplorerUrl'),
        `${path}.invoice.securityExplorerUrl`,
      ),
    },
    confirmation: {
      decision: decision === 'confirmed' || decision === 'disputed' ? decision : null,
      decidedAt: readOptionalString(
        field(confirmation, 'decidedAt'),
        `${path}.confirmation.decidedAt`,
      ),
    },
    compliance: {
      ...readChecks(field(compliance, 'decision'), `${path}.compliance.decision`),
      checkedAt: readOptionalString(field(compliance, 'checkedAt'), `${path}.compliance.checkedAt`),
      hcsTopicId: readOptionalString(
        field(compliance, 'hcsTopicId'),
        `${path}.compliance.hcsTopicId`,
      ),
      hcsSequenceNumber: readOptionalString(
        field(compliance, 'hcsSequenceNumber'),
        `${path}.compliance.hcsSequenceNumber`,
      ),
      hcsExplorerUrl: readOptionalString(
        field(compliance, 'hcsExplorerUrl'),
        `${path}.compliance.hcsExplorerUrl`,
      ),
    },
    pricing:
      pricing === undefined
        ? null
        : (() => {
            const p = readObject(pricing, `${path}.pricing`);
            return {
              ratingAtQuote:
                readOptionalString(field(p, 'ratingAtQuote'), `${path}.pricing.ratingAtQuote`) ??
                'UNRATED',
              tenorDays: readNumber(field(p, 'tenorDays'), `${path}.pricing.tenorDays`),
              annualisedYieldBps: readNumber(
                field(p, 'annualisedYieldBps'),
                `${path}.pricing.annualisedYieldBps`,
              ),
              faceValue: readMoney(field(p, 'faceValue'), `${path}.pricing.faceValue`),
              discount: readMoney(
                field(p, 'discountMinor', 'discount'),
                `${path}.pricing.discountMinor`,
              ),
              proceeds: readMoney(
                field(p, 'proceedsMinor', 'proceeds'),
                `${path}.pricing.proceedsMinor`,
              ),
            };
          })(),
    assetLeg: {
      chain: 'hedera',
      holdId: readOptionalString(field(assetLeg, 'holdId'), `${path}.assetLeg.holdId`),
      transactionId: readOptionalString(
        field(assetLeg, 'transactionId'),
        `${path}.assetLeg.transactionId`,
      ),
      consensusAt: readOptionalString(
        field(assetLeg, 'consensusAt'),
        `${path}.assetLeg.consensusAt`,
      ),
      explorerUrl: readOptionalString(
        field(assetLeg, 'explorerUrl'),
        `${path}.assetLeg.explorerUrl`,
      ),
    },
    cashLeg: {
      chain:
        readOptionalString(field(cashLeg, 'chain'), `${path}.cashLeg.chain`) === 'hedera'
          ? 'hedera'
          : 'arc',
      scheme: readOptionalString(field(cashLeg, 'scheme'), `${path}.cashLeg.scheme`),
      network: readOptionalString(field(cashLeg, 'network'), `${path}.cashLeg.network`),
      asset: readOptionalString(field(cashLeg, 'asset'), `${path}.cashLeg.asset`),
      transaction: readOptionalString(field(cashLeg, 'transaction'), `${path}.cashLeg.transaction`),
      payer: readOptionalString(field(cashLeg, 'payer'), `${path}.cashLeg.payer`),
      explorerUrl: readOptionalString(field(cashLeg, 'explorerUrl'), `${path}.cashLeg.explorerUrl`),
    },
    refusals:
      refusals === undefined
        ? []
        : readArray(refusals, `${path}.refusals`).map((item, i) => {
            const r = readObject(item, `${path}.refusals[${i}]`);
            return {
              mandateId:
                readOptionalString(field(r, 'mandateId'), `${path}.refusals[${i}].mandateId`) ?? '',
              reasonCode: readString(field(r, 'reasonCode'), `${path}.refusals[${i}].reasonCode`),
              reasonText: readString(field(r, 'reasonText'), `${path}.refusals[${i}].reasonText`),
              hcsExplorerUrl: readOptionalString(
                field(r, 'hcsExplorerUrl'),
                `${path}.refusals[${i}].hcsExplorerUrl`,
              ),
            };
          }),
    settledAt: readOptionalString(field(body, 'settledAt'), `${path}.settledAt`),
  };
}

export const regulationOf = (value: unknown): RegulationKey | null =>
  isRegulationKey(value) ? value : null;

/* -------------------------------------------------------------------------- */
/* Debtor confirmation — `GET /v1/confirm/:token`                              */
/* -------------------------------------------------------------------------- */

/**
 * What the customer is shown.
 *
 * The venue returns exactly the operands of one sentence — seller, amount, due date —
 * plus the sentence itself. Note what is **not** in it: no quote, no rate, no proceeds, no
 * mandate, no buyer. The debtor acknowledging their own accounts payable must never be
 * shown the market quoting their debt, and the surest guarantee is that the price never
 * reaches this screen at all. Nothing may be added to this type that a market participant
 * would recognise as a price.
 *
 * The amount arrives **already formatted** (`"$44,000.00"`), because the service formats
 * it with the invoice's own currency and this page has no business re-deriving a figure a
 * customer is being asked to agree to. `faceValue` is therefore nullable: it is present
 * only when the source keeps minor units, which the demo book does and the venue does not.
 */
export interface ConfirmationPrompt {
  sellerName: string;
  debtorName: string | null;
  invoiceNumber: string | null;
  /** Rendered by whoever owns the figure. Never re-derived here. */
  amount: string;
  /** Minor units, when the source has them. `null` over the wire. */
  faceValue: MinorUnits | null;
  currency: Currency;
  dueAt: string;
  /** `null` while the customer has not answered. */
  decision: 'confirmed' | 'disputed' | null;
  expiresAt: string | null;
}

export function readConfirmationPrompt(raw: unknown, path = 'confirmation'): ConfirmationPrompt {
  const body = readObject(raw, path);
  const seller = field(body, 'seller');
  const invoice = field(body, 'invoice');
  const debtor = field(body, 'debtor', 'customer');

  // `seller` is the name itself on the wire; a nested `{ name }` is read too.
  const sellerName =
    typeof seller === 'string'
      ? readString(seller, `${path}.seller`)
      : readString(
          field(
            seller === undefined ? body : readObject(seller, `${path}.seller`),
            'name',
            'sellerName',
          ),
          `${path}.seller`,
        );

  const invoiceBag = invoice === undefined ? body : readObject(invoice, `${path}.invoice`);
  const debtorBag =
    debtor === undefined || typeof debtor === 'string'
      ? body
      : readObject(debtor, `${path}.debtor`);

  const decision = readOptionalString(field(body, 'decision'), `${path}.decision`);
  const currency = readEnum(
    field(invoiceBag, 'currency') ?? field(body, 'currency') ?? 'USD',
    `${path}.currency`,
    CURRENCIES,
  ) as Currency;

  const faceValue = readOptionalMoney(field(invoiceBag, 'faceValue'), `${path}.faceValue`);
  const amount = readOptionalString(field(body, 'amount'), `${path}.amount`);

  if (amount === null && faceValue === null) {
    unreadable(`${path}.amount`, 'is missing, and there is no amount to ask the customer about');
  }

  return {
    sellerName,
    debtorName:
      typeof debtor === 'string'
        ? debtor
        : readOptionalString(field(debtorBag, 'debtorName'), `${path}.debtorName`),
    invoiceNumber: readOptionalString(
      field(body, 'invoiceNumber') ?? field(invoiceBag, 'invoiceNumber', 'reference'),
      `${path}.invoiceNumber`,
    ),
    amount: amount ?? formatMinorUnits(faceValue as MinorUnits, currency, { symbol: true }),
    faceValue,
    currency,
    dueAt: readString(
      field(body, 'dueAt') ?? field(invoiceBag, 'dueAt', 'dueDate'),
      `${path}.dueAt`,
    ),
    decision: decision === 'confirmed' || decision === 'disputed' ? decision : null,
    expiresAt: readOptionalString(field(body, 'expiresAt'), `${path}.expiresAt`),
  };
}

/* -------------------------------------------------------------------------- */
/* Health — `GET /health`                                                      */
/* -------------------------------------------------------------------------- */

/** Written out literally in `packages/backend/src/routes/health.ts`. */
export interface HealthResponse {
  status: string;
  environment: string;
  uptimeSeconds: number;
  databaseOk: boolean;
  facilitatorOk: boolean;
  issuanceQueued: number | null;
}

export function readHealth(raw: unknown, path = 'health'): HealthResponse {
  const body = readObject(raw, path);
  const dependencies = readObject(field(body, 'dependencies') ?? {}, `${path}.dependencies`);
  const database = readObject(
    field(dependencies, 'database') ?? {},
    `${path}.dependencies.database`,
  );
  const facilitator = readObject(
    field(dependencies, 'facilitator') ?? {},
    `${path}.dependencies.facilitator`,
  );
  const issuance = field(body, 'issuance');
  const queued =
    issuance === undefined
      ? undefined
      : field(readObject(issuance, `${path}.issuance`), 'queued', 'depth', 'pending');

  return {
    status: readOptionalString(field(body, 'status'), `${path}.status`) ?? 'unknown',
    environment: readOptionalString(field(body, 'environment'), `${path}.environment`) ?? 'unknown',
    uptimeSeconds: readNumber(field(body, 'uptimeSeconds') ?? 0, `${path}.uptimeSeconds`),
    databaseOk: field(database, 'ok') === true,
    facilitatorOk: field(facilitator, 'ok') === true,
    issuanceQueued: queued === undefined ? null : readNumber(queued, `${path}.issuance.queued`),
  };
}
