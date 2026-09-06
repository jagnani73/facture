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
  InvoiceIssuance,
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
  ISSUANCE_STATES,
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

/**
 * A boolean, or the absence of one.
 *
 * `null` is a third state and not a `false`. Every caller here is a question the venue may
 * not have been able to ask, and a screen that renders "unanswered" as "no" makes a negative
 * claim nobody made.
 */
function readOptionalBoolean(value: unknown, path: string): boolean | null {
  if (value === undefined || value === null) return null;
  return readBoolean(value, path);
}

function readEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  const raw = readString(value, path);
  const found = allowed.find((option) => option === raw || option === raw.toUpperCase());
  if (found === undefined)
    unreadable(path, `should be one of ${allowed.join(', ')} — got "${raw}"`);
  return found;
}

/**
 * The three offerings this build has a label for.
 *
 * Named once because two decoders read it — the `INELIGIBLE_JURISDICTION` refusal and the
 * proof view's instrument block — and a spelling that drifted between them would refuse one
 * offering while rendering the other.
 */
const REGULATION_KEYS = ['REG_D_506_B', 'REG_D_506_C', 'REG_S'] as const;

/** The SCREAMING_SNAKE spelling the venue uses, or nothing. */
export const regulationOf = (value: unknown): RegulationKey | null =>
  isRegulationKey(value) ? value : null;

/**
 * The SEC regulation an instrument was declared under.
 *
 * Absent reads as null; a value this build has no label for is **unreadable**, on the same
 * grounds as `readCashRail`. The proof view prints `REGULATIONS[key].label` as a claim about
 * the offering, and quietly folding an unrecognised spelling into null would hide a
 * declaration that was actually made rather than report a shape this build cannot read. A
 * declaration is not something the venue can correct afterwards, so it is not something to
 * drop silently either.
 */
function readRegulation(value: unknown, path: string): RegulationKey | null {
  if (value === undefined || value === null || value === '') return null;
  const key = regulationOf(value);
  if (key === null) unreadable(path, `should be one of ${REGULATION_KEYS.join(', ')}`);
  return key;
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

/**
 * An invoice as this package carries it: the shared `Invoice`, plus the instrument's native
 * Hedera id where the venue sent one.
 *
 * Extending rather than widening keeps `@facture/shared` frozen, on the same grounds as
 * `TradeRecord` below.
 */
export interface InvoiceRecord extends Invoice {
  /**
   * The `0.0.x` the ATS diamond answers to — the same contract as `instrumentAddress` under
   * its other name, and never a stand-in for it.
   */
  readonly securityId?: string | undefined;
}

/** An EVM address, and nothing that merely looks like one: 20 bytes, hex, `0x`-prefixed. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function readInvoice(raw: unknown, path = 'invoice'): InvoiceRecord {
  const body = readObject(raw, path);

  const hash = readOptionalString(field(body, 'uniquenessHash'), `${path}.uniquenessHash`);

  /*
   * Two names for one instrument, and they are not interchangeable. The venue sends
   * `instrumentAddress` — the EVM address `deployBond` returned — beside `securityId`, the
   * native id the same diamond answers to. One is derived from the deployment and the other
   * from an account number; neither can be computed from the other outside the mirror node,
   * so none is computed here.
   *
   * This used to read whichever arrived first into `instrumentAddress`, which is typed
   * `0x${string}` — so `0.0.10331926` satisfied the compiler while being the wrong
   * identifier, harmless only for as long as nothing built an EVM link out of it. They are
   * read apart now, and an address-shaped field carrying something that is not an address is
   * unreadable rather than cast. `isIssued` still answers off the address, which the venue
   * writes in the same update as the native id.
   */
  const address = readOptionalString(field(body, 'instrumentAddress'), `${path}.instrumentAddress`);
  if (address !== null && !EVM_ADDRESS.test(address)) {
    unreadable(`${path}.instrumentAddress`, 'should be an EVM address — `0x` and 40 hex digits');
  }
  const securityId = readOptionalString(field(body, 'securityId'), `${path}.securityId`);

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
    instrumentAddress: (address as `0x${string}` | null) ?? undefined,
    securityId: securityId ?? undefined,
    partition: (partition as `0x${string}` | null) ?? undefined,
    isin: readOptionalString(field(body, 'isin'), `${path}.isin`) ?? undefined,
    issuance: readIssuance(field(body, 'issuance'), `${path}.issuance`),
    createdAt: readOptionalString(field(body, 'createdAt'), `${path}.createdAt`) ?? undefined,
    updatedAt: readOptionalString(field(body, 'updatedAt'), `${path}.updatedAt`) ?? undefined,
  };
}

/**
 * Tokenisation progress, which the book needs in order to stop describing a failed issuance
 * as one that is still happening.
 *
 * Absent rather than guessed when the service does not send it. `undefined` reads as "not
 * known", and the domain helpers treat that as pending rather than failed — inventing a
 * state here would put a permanent error under an invoice on the strength of an older
 * payload.
 */
function readIssuance(raw: unknown, path: string): InvoiceIssuance | undefined {
  if (raw === undefined || raw === null) return undefined;
  const body = readObject(raw, path);
  const state = field(body, 'state');
  if (state === undefined || state === null) return undefined;

  const attempts = field(body, 'attempts');
  return {
    state: readEnum(state, `${path}.state`, ISSUANCE_STATES),
    attempts:
      attempts === undefined || attempts === null
        ? undefined
        : readNumber(attempts, `${path}.attempts`),
    transactionId:
      readOptionalString(field(body, 'transactionId'), `${path}.transactionId`) ?? undefined,
    error: readOptionalString(field(body, 'error'), `${path}.error`) ?? undefined,
  };
}

/**
 * The maturity receipt, when there is one.
 *
 * `state` is read strictly rather than defaulted: a maturity block that arrived without a
 * state would otherwise render as an unpaid obligation, which is the wrong half of the only
 * distinction this block exists to draw.
 */
function readMaturity(raw: unknown, path: string): TradeProofResponse['maturity'] {
  if (raw === undefined || raw === null) return null;
  const body = readObject(raw, path);
  const scheduleId = readOptionalString(field(body, 'scheduleId'), `${path}.scheduleId`);
  if (scheduleId === null) return null;

  return {
    scheduleId,
    scheduleExplorerUrl: readOptionalString(
      field(body, 'scheduleExplorerUrl'),
      `${path}.scheduleExplorerUrl`,
    ),
    state: readEnum(field(body, 'state'), `${path}.state`, ['pending', 'settled'] as const),
    executedAt: readOptionalString(field(body, 'executedAt'), `${path}.executedAt`),
    transactionId: readOptionalString(field(body, 'transactionId'), `${path}.transactionId`),
    explorerUrl: readOptionalString(field(body, 'explorerUrl'), `${path}.explorerUrl`),
    payer: readOptionalString(field(body, 'payer'), `${path}.payer`),
    payee: readOptionalString(field(body, 'payee'), `${path}.payee`),
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
/**
 * What the Arc vault actually holds behind a bid, and what it would have to hold.
 *
 * Three states, not two, and the third is the one worth having. `depositedUsdcMinor: null`
 * with `checked: true` means the vault could not be read — which must not render as "nobody
 * posted this", because that accuses a funded buyer of quoting on nothing. `backed` is
 * deliberately not `deposited > 0`: a mandate counted as holding more than the vault does is
 * an overclaim, and a partly-backed bid is not a funded one.
 *
 * **Both figures are USDC ERC-20 minor units — 6 decimals — and not the mandate's own
 * currency.** The names say so because they used to not: the field was `deposited`, the
 * screen rendered it with `formatMoney` at 2 decimals, and a vault holding 5 USDC was
 * reported as "Backed by $50,000.00". Render these with `formatUsdc`, never `formatMoney`.
 *
 * `requiredUsdcMinor` is what makes the pair comparable — the mandate's committed capital
 * put through the same conversion the cash leg settles at. Without it a reader has the
 * vault's balance and no way to know whether it is enough.
 */
/** Which rail settled the cash leg. Stated by the venue, never inferred here. */
export const CASH_RAILS = ['x402', 'arc-vault'] as const;
export type CashRail = (typeof CASH_RAILS)[number];

/**
 * The Arc escrow lock behind a vault payout.
 *
 * `status` is deliberately a plain string rather than an enum. It carries the escrow's own
 * lifecycle (`locked` / `claimed` / `refunded`) plus two words the venue uses when it could
 * not get an answer — `unknown` and `unreadable` — and collapsing "we could not ask" into
 * "not claimed" would accuse a paid seller of being unpaid.
 */
export interface CashLegLock {
  lockId: string;
  status: string;
  beneficiary: string | null;
  amountMinor: MinorUnits | null;
  claimableUntil: string | null;
  /**
   * The preimage that releases the lock, and not a credential.
   *
   * `claim` checks the caller as well as the hash, so the secret alone moves nothing — and
   * the escrow publishes it in the clear the moment anyone claims. It is on the wire because
   * the seller needs it to build their own transaction.
   */
  secret: string | null;
  /** The `DvpEscrow` the claim is sent to. Without it the seller cannot build the call. */
  escrowAddress: string | null;
  explorerUrl: string | null;
}

export interface MandateEscrow {
  checked: boolean;
  depositedUsdcMinor: MinorUnits | null;
  requiredUsdcMinor: MinorUnits;
  backed: boolean;
}

/**
 * A mandate as its owner's screen reads it.
 *
 * `escrow` and `operator` are absent on the fixture book, which has no vault behind it and
 * carries its own hand-written metadata.
 */
export type MandateRecord = Mandate & {
  escrow?: MandateEscrow;
  operator?: 'agent' | 'desk';
};

/**
 * The rail, or null.
 *
 * Unlike `readChainKey`, an unrecognised value is **not** quietly folded into a default. A
 * rail this build does not know about is a rail whose receipt it cannot describe, and
 * guessing would put a confident wrong sentence on the one screen that exists to be checked.
 */
export function readCashRail(value: unknown, path: string): CashRail | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return unreadable(path, 'is not a string');
  const found = CASH_RAILS.find((rail) => rail === value);
  if (found === undefined) return unreadable(path, `is not one of ${CASH_RAILS.join(', ')}`);
  return found;
}

/** The Arc escrow lock, when there is one. Absent is not an error — x402 has no lock. */
export function readCashLegLock(value: unknown, path: string): CashLegLock | null {
  if (value === undefined || value === null) return null;
  const body = readObject(value, path);
  return {
    lockId: readString(field(body, 'lockId'), `${path}.lockId`),
    /*
     * Required, and deliberately not defaulted to `locked`. The whole reason this block
     * exists is to say whether the seller has been paid; a missing status defaulted to
     * "still locked" would answer that question wrongly and confidently.
     */
    status: readString(field(body, 'status'), `${path}.status`),
    beneficiary: readOptionalString(field(body, 'beneficiary'), `${path}.beneficiary`),
    amountMinor: readOptionalMoney(field(body, 'amountMinor'), `${path}.amountMinor`),
    claimableUntil: readOptionalString(field(body, 'claimableUntil'), `${path}.claimableUntil`),
    secret: readOptionalString(field(body, 'secret'), `${path}.secret`),
    escrowAddress: readOptionalString(field(body, 'escrowAddress'), `${path}.escrowAddress`),
    explorerUrl: readOptionalString(field(body, 'explorerUrl'), `${path}.explorerUrl`),
  };
}

export function readMandateEscrow(raw: unknown, path: string): MandateEscrow | undefined {
  if (raw === undefined || raw === null) return undefined;
  const body = readObject(raw, path);
  return {
    checked: field(body, 'checked') === true,
    depositedUsdcMinor: readOptionalMoney(
      field(body, 'depositedUsdcMinor'),
      `${path}.depositedUsdcMinor`,
    ),
    requiredUsdcMinor: readMoney(field(body, 'requiredUsdcMinor'), `${path}.requiredUsdcMinor`),
    backed: field(body, 'backed') === true,
  };
}

export function readMandateRecord(raw: unknown, path = 'mandate'): MandateRecord {
  const body = readObject(raw, path);
  const escrow = readMandateEscrow(field(body, 'escrow'), `${path}.escrow`);
  const rawOperator = readOptionalString(field(body, 'operator'), `${path}.operator`);
  // Anything the screen has no rendering for is absent rather than guessed at.
  const operator = rawOperator === 'agent' || rawOperator === 'desk' ? rawOperator : undefined;

  return {
    ...readMandate(raw, path),
    ...(escrow === undefined ? {} : { escrow }),
    ...(operator === undefined ? {} : { operator }),
  };
}

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
        regulation: readEnum(
          field(body, 'regulation'),
          `${path}.regulation`,
          REGULATION_KEYS,
        ) as RegulationKey,
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
  invoice: InvoiceRecord;
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
  invoice: InvoiceRecord;
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

/**
 * The answer to offering an invoice into the book, or taking it back off —
 * `POST /v1/invoices/:id/list` and `POST /v1/invoices/:id/delist`.
 *
 * One shape for both, because both routes answer the same thing: whether the invoice is on
 * the book now, and a sentence. They differ only in which of `alreadyListed` /
 * `alreadyDelisted` they use for the idempotent case, so whichever one arrived is read into
 * a single `unchanged`.
 *
 * **`listed` is read strictly, and it is what the caller acts on.** It is the venue's own
 * statement about what it just did, so a 200 carrying `listed: false` from the list route is
 * the venue accepting the request and not performing it — which must be reported as a
 * refusal rather than as an offer that is now standing.
 *
 * The invoice the routes echo back is deliberately **not** decoded. The book is re-read from
 * the venue after either call, so the echo would be a second copy of a fact the screen
 * already asks for authoritatively — and decoding it strictly would let an unreadable echo
 * report a listing that actually happened as a failure.
 */
export interface InvoiceListing {
  /** On the book, and therefore sellable. */
  listed: boolean;
  /** True when the venue wrote nothing because the invoice was already in that state. */
  unchanged: boolean;
  /** The venue's own sentence. Rendered as-is; never paraphrased. */
  message: string | null;
}

export function readInvoiceListing(raw: unknown, path = 'listing'): InvoiceListing {
  const body = readObject(raw, path);
  const already = field(body, 'alreadyListed', 'alreadyDelisted');

  return {
    listed: readBoolean(field(body, 'listed'), `${path}.listed`),
    /*
     * Absent reads as "this call did something", which is the reading that cannot mislead: a
     * wrong `true` would tell a seller their click was a no-op when it was the click that put
     * the invoice on the book, and send them looking for whoever else had done it.
     */
    unchanged: already === undefined ? false : readBoolean(already, `${path}.alreadyListed`),
    message: readOptionalString(field(body, 'message'), `${path}.message`),
  };
}

/* -------------------------------------------------------------------------- */
/* Trades                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The venue's own word for where a trade got to — `TradeRow.status`, rendered by
 * `wireTrade`.
 *
 * Read because the leg states alone cannot separate `preparing` from `awaiting_payment`,
 * and because the venue is the authority on its own trade. It stays **optional** on
 * `TradeRecord`: the demo book has no such column, and a screen that needs the distinction
 * asks `settlementStateOf`, which falls back to the legs.
 */
export const TRADE_STATUSES = [
  'preparing',
  'awaiting_payment',
  'settled',
  'unwound',
  'failed',
] as const;

export type TradeStatus = (typeof TRADE_STATUSES)[number];

/**
 * A trade as this package carries it: the shared `Trade`, plus the venue's status where
 * there is one.
 *
 * Extending rather than widening `Trade` keeps `@facture/shared` frozen and keeps the demo
 * book assignable without a field it has never had.
 */
export interface TradeRecord extends Trade {
  readonly status?: TradeStatus | undefined;
  /**
   * Which rail carried the cash leg, when the venue said.
   *
   * It sits here rather than on `cashLeg` because `SettlementLeg` belongs to
   * `@facture/shared`, which is frozen — the same reason `status` is here. Undefined means
   * the venue did not say, which is not the same as x402: the sentence a seller is shown
   * after a sale turns on this, and defaulting would name a protocol that never ran.
   */
  readonly cashRail?: CashRail | undefined;
}

/**
 * The wire names a leg's chain `hedera` / `arc`; `@facture/shared` names the same two
 * chains `hedera-testnet` / `arc-testnet`, and `CHAINS` is keyed on the second spelling.
 * A leg carrying the bare wire word would index that table to `undefined`, so the two are
 * reconciled here rather than at every render site.
 *
 * This matters more than a label: the cash leg is **not** always Arc. When the deployment
 * settles in HBAR the venue answers `chain: "hedera"` with `network: "hedera:testnet"`,
 * and a screen that assumed Arc would offer an ArcScan link for a Hedera transaction.
 */
export function readChainKey(value: unknown, path: string, fallback: ChainKey): ChainKey {
  const raw = readOptionalString(value, path);
  if (raw === null) return fallback;
  if (raw === 'hedera' || raw === 'hedera-testnet' || raw.startsWith('hedera:')) {
    return 'hedera-testnet';
  }
  if (raw === 'arc' || raw === 'arc-testnet' || raw.startsWith('arc:')) return 'arc-testnet';
  return fallback;
}

function readLeg(raw: unknown, path: string, fallbackChain: ChainKey): SettlementLeg {
  const body = readObject(raw, path);
  return {
    state: readEnum(
      field(body, 'state') ?? 'pending',
      `${path}.state`,
      SETTLEMENT_LEG_STATES,
    ) as SettlementLegState,
    chain: readChainKey(field(body, 'chain'), `${path}.chain`, fallbackChain),
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

export function readTrade(raw: unknown, path = 'trade'): TradeRecord {
  const body = readObject(raw, path);
  const assetLeg = field(body, 'assetLeg');
  const cashLeg = field(body, 'cashLeg');
  const status = field(body, 'status');

  return {
    ...(status === undefined
      ? {}
      : { status: readEnum(status, `${path}.status`, TRADE_STATUSES) as TradeStatus }),
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
    // Lifted off the cash leg because the shared `SettlementLeg` has nowhere to put it.
    ...(cashLeg === undefined
      ? {}
      : {
          cashRail:
            readCashRail(
              field(readObject(cashLeg, `${path}.cashLeg`), 'rail'),
              `${path}.cashLeg.rail`,
            ) ?? undefined,
        }),
    // The wire calls it `createdAt`: a trade is created at the moment it is matched, and
    // there is no earlier moment for it to have been executed at.
    executedAt: readString(field(body, 'executedAt', 'createdAt'), `${path}.executedAt`),
    settledAt: readOptionalString(field(body, 'settledAt'), `${path}.settledAt`) ?? undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* The x402 challenge — the 402 from `POST /v1/trades`                         */
/* -------------------------------------------------------------------------- */

/**
 * The cash leg's terms, as the venue builds them in `services/x402.ts`.
 *
 * **This shape moved, and the old spelling fails silently.** In `@x402/core` 2.24.0 the
 * amount field is `amount`, not `maxAmountRequired`, and `resource` / `description` /
 * `mimeType` are no longer requirements fields at all — they live on
 * `PaymentRequired.resource`, a sibling of `accepts`. The backend's own note records that
 * this was settled by signing three live payments against the facilitator rather than read
 * off documentation, so it is decoded here strictly: `amount` is required by that name, and
 * a body still sending `maxAmountRequired` is reported as unreadable rather than guessed at.
 */
export interface PaymentRequirements {
  scheme: string;
  /** CAIP-2 style, with a **colon**: `hedera:testnet`, never `hedera-testnet`. */
  network: string;
  /** Hedera references HTS assets by native id. `0.0.0` is HBAR. */
  asset: string;
  /** The asset's smallest unit, as a decimal string. Tinybars for HBAR. */
  amount: string;
  /** Native id `0.0.x` of the receiving account. */
  payTo: string;
  maxTimeoutSeconds: number;
  /** Carries `feePayer`, which the venue reads from the facilitator at runtime. */
  extra: Record<string, unknown>;
}

/** The `resource` sibling of `accepts`. Three fields that used to sit inside `accepts[0]`. */
export interface ResourceInfo {
  resource: string;
  description: string;
  mimeType: string | null;
}

/** What the `payment-required` header carries, whole — not a bare requirements object. */
export interface PaymentRequired {
  x402Version: number;
  accepts: PaymentRequirements[];
  resource: ResourceInfo | null;
}

export function readPaymentRequirements(raw: unknown, path: string): PaymentRequirements {
  const body = readObject(raw, path);
  const amount = field(body, 'amount');

  if (amount === undefined) {
    unreadable(
      `${path}.amount`,
      'is missing — x402 v2 renamed `maxAmountRequired` to `amount`, and a challenge ' +
        'without it cannot be signed',
    );
  }

  return {
    scheme: readString(field(body, 'scheme'), `${path}.scheme`),
    network: readString(field(body, 'network'), `${path}.network`),
    asset: readString(field(body, 'asset'), `${path}.asset`),
    amount: readString(amount, `${path}.amount`),
    payTo: readString(field(body, 'payTo'), `${path}.payTo`),
    maxTimeoutSeconds: readNumber(
      field(body, 'maxTimeoutSeconds') ?? 0,
      `${path}.maxTimeoutSeconds`,
    ),
    extra:
      field(body, 'extra') === undefined ? {} : readObject(field(body, 'extra'), `${path}.extra`),
  };
}

function readResourceInfo(raw: unknown, path: string): ResourceInfo {
  const body = readObject(raw, path);
  return {
    resource: readString(field(body, 'resource'), `${path}.resource`),
    description: readOptionalString(field(body, 'description'), `${path}.description`) ?? '',
    mimeType: readOptionalString(field(body, 'mimeType'), `${path}.mimeType`),
  };
}

export function readPaymentRequired(raw: unknown, path = 'paymentRequired'): PaymentRequired {
  const body = readObject(raw, path);
  const accepts = field(body, 'accepts');
  const resource = field(body, 'resource');

  if (accepts === undefined) unreadable(`${path}.accepts`, 'is missing');

  return {
    x402Version: readNumber(field(body, 'x402Version') ?? 2, `${path}.x402Version`),
    accepts: readArray(accepts, `${path}.accepts`).map((item, i) =>
      readPaymentRequirements(item, `${path}.accepts[${i}]`),
    ),
    resource: resource === undefined ? null : readResourceInfo(resource, `${path}.resource`),
  };
}

/**
 * The whole 402 body.
 *
 * A 402 here is not a failure. It is the middle of a delivery-versus-payment: the asset leg
 * is **held** on Hedera, nothing has moved, and the cash leg is waiting for the buyer's
 * signature. A screen that renders this as "sold" is claiming a settlement that has not
 * happened, and one that renders it as an error is claiming a failure that has not happened
 * either.
 */
export interface TradeChallenge {
  trade: TradeRecord | null;
  quote: Quote | null;
  /** Held, not moved. Nobody goes first. */
  assetLeg: SettlementLeg | null;
  compliance: ComplianceDecision | null;
  payment: PaymentRequired;
  /** After this the hold is released whether or not the buyer signed. */
  expiresAt: string | null;
  /** The header the signed payload comes back in. `PAYMENT-SIGNATURE` in x402 v2. */
  signatureHeader: string;
}

/** The pre-match decision, as `services/compliance.ts` renders it. */
export interface ComplianceDecision {
  allowed: boolean | null;
  checks: ProofCheck[];
  checkedAt: string | null;
  /** Set when refused: the first check that failed, in words. */
  reason: string | null;
}

export function readComplianceDecision(raw: unknown, path: string): ComplianceDecision {
  const body = readObject(raw, path);
  return {
    ...readChecks(body, path),
    checkedAt: readOptionalString(field(body, 'checkedAt'), `${path}.checkedAt`),
    reason: readOptionalString(field(body, 'reason'), `${path}.reason`),
  };
}

export function readTradeChallenge(raw: unknown, path = 'challenge'): TradeChallenge {
  const body = readObject(raw, path);
  const trade = field(body, 'trade');
  const quote = field(body, 'quote');
  const assetLeg = field(body, 'assetLeg');
  const compliance = field(body, 'compliance');

  return {
    trade: trade === undefined ? null : readTrade(trade, `${path}.trade`),
    quote: quote === undefined ? null : readQuote(quote, `${path}.quote`),
    assetLeg:
      assetLeg === undefined ? null : readLeg(assetLeg, `${path}.assetLeg`, 'hedera-testnet'),
    compliance:
      compliance === undefined ? null : readComplianceDecision(compliance, `${path}.compliance`),
    payment: readPaymentRequired(body, path),
    expiresAt: readOptionalString(field(body, 'expiresAt'), `${path}.expiresAt`),
    signatureHeader:
      readOptionalString(field(body, 'signatureHeader'), `${path}.signatureHeader`) ??
      'PAYMENT-SIGNATURE',
  };
}

/** The `payment-required` header, which is base64 JSON of a whole `PaymentRequired`. */
export function decodePaymentRequiredHeader(header: string | null): PaymentRequired | null {
  if (header === null || header.trim() === '') return null;
  try {
    return readPaymentRequired(JSON.parse(atob(header)), 'paymentRequiredHeader');
  } catch {
    // The body carries the same two fields, so an unreadable header is a lost cross-check
    // rather than a lost challenge. It is not worth failing a sale over.
    return null;
  }
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

/**
 * What the public invoice registry says about this receivable — `InvoiceRegistry` on Hedera,
 * read back rather than asserted.
 *
 * Three states, and the third is the one this block exists for. `checked: false` means no
 * registry is configured, or the node could not be read; it is a question that went
 * unanswered and **not** a negative answer, so `listed` and `confirmed` are null rather than
 * false whenever it is. Collapsing that into "not confirmed" would have the proof view
 * contradict, a card away, the confirmation the venue is certain of — the same distinction
 * `/health` lost and `ComplianceDecision.determinate` exists to keep.
 */
export interface InvoiceRegistryAnswer {
  checked: boolean;
  listed: boolean | null;
  confirmed: boolean | null;
  /** The deployed `InvoiceRegistry`. Present even unchecked, when one is configured. */
  contractAddress: string | null;
  explorerUrl: string | null;
}

export function readInvoiceRegistry(raw: unknown, path: string): InvoiceRegistryAnswer {
  /*
   * A venue that sends no block at all was never asked, which is exactly what `checked:
   * false` says — so an older service reads as unchecked rather than as an unreadable
   * response.
   */
  if (raw === undefined || raw === null) {
    return {
      checked: false,
      listed: null,
      confirmed: null,
      contractAddress: null,
      explorerUrl: null,
    };
  }

  const body = readObject(raw, path);
  const contractAddress = readOptionalString(
    field(body, 'contractAddress'),
    `${path}.contractAddress`,
  );
  const explorerUrl = readOptionalString(field(body, 'explorerUrl'), `${path}.explorerUrl`);

  /*
   * Absent reads as unchecked, which is the reading that cannot overclaim: a missing flag
   * defaulted to `true` would present whatever happened to sit beside it as the chain's own
   * answer. The two answers are dropped in that case rather than carried — a value next to
   * "could not ask" did not come from the node, whatever it says.
   */
  if (field(body, 'checked') !== true) {
    return { checked: false, listed: null, confirmed: null, contractAddress, explorerUrl };
  }

  return {
    checked: true,
    listed: readOptionalBoolean(field(body, 'listed'), `${path}.listed`),
    confirmed: readOptionalBoolean(field(body, 'confirmed'), `${path}.confirmed`),
    contractAddress,
    explorerUrl,
  };
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
    /**
     * The offering this instrument was declared under, per invoice.
     *
     * Per invoice rather than per deployment, because those two disagreed once: MF-2052's row
     * said Reg D 506(c) and its bond went out `1/0`, Reg S. The row is what deploys now, so
     * this is the field a reader checks against the instrument's own calldata.
     */
    regulation: RegulationKey | null;
  };
  confirmation: {
    decision: 'confirmed' | 'disputed' | null;
    decidedAt: string | null;
  };
  /** The chain's own account of the same invoice, beside the venue's. */
  registry: InvoiceRegistryAnswer;
  compliance: {
    allowed: boolean | null;
    checks: ProofCheck[];
    /** The failed check, in words. The whole point of refusing before matching. */
    reason: string | null;
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
    /**
     * How many units actually moved.
     *
     * The venue publishes this precisely so that a trade moving one unit of a
     * face-value-many issuance cannot hide, which makes it the last field on this screen
     * that should have been going unread — and it was, until 2026-09-02. The backend sent
     * it, nothing here declared it, so the row it feeds rendered on the fixture path and
     * never on the live one.
     */
    unitsMinor: MinorUnits | null;
    transactionId: string | null;
    consensusAt: string | null;
    explorerUrl: string | null;
  };
  cashLeg: {
    /**
     * Reconciled to a `ChainKey`, because the cash leg is **not** always Arc: this
     * deployment settles in HBAR, so the venue answers `hedera` with a
     * `network: "hedera:testnet"`, and an ArcScan link over a Hedera transaction id would
     * be a dead link on the one screen whose whole job is being checkable.
     */
    chain: ChainKey;
    /**
     * Which rail carried the cash, as the venue recorded it — not reconstructed here.
     *
     * `x402` is a payment the buyer signed for this trade. `arc-vault` draws on USDC they
     * escrowed before the invoice existed. `null` means no rail has run, which is a third
     * state: the venue used to infer this from the network string and answer "Arc" for a
     * trade that had not settled at all.
     */
    rail: CashRail | null;
    scheme: string | null;
    network: string | null;
    asset: string | null;
    transaction: string | null;
    payer: string | null;
    /**
     * What moved, in the SETTLEMENT ASSET's minor units — tinybars or USDC at 6 decimals.
     *
     * Not the invoice currency. `pricing.proceeds` is US cents, and the two differ by the
     * venue's ppm scale, so rendering this one with `formatMoney` reports 0.059331 USDC as
     * $59,331.78 — the same confusion `MandateEscrow` above documents. Use `formatUsdc`.
     *
     * Null on trades that settled before the venue recorded it, which is honest: it does not
     * know, rather than a zero that looks like a price.
     */
    settledAmountMinor: MinorUnits | null;
    explorerUrl: string | null;
    /**
     * Arc only. Where a payout is sitting and whether the seller has taken it.
     *
     * A vault payout puts the money in an escrow claimable by the seller alone, for a day —
     * it does not put it in their wallet. A cash leg reported as settled with a `locked`
     * lock is a payment that has not reached anyone yet, and the screen has to say so.
     */
    lock: CashLegLock | null;
  };
  /**
   * Maturity: the third receipt, `null` until the receivable has matured.
   *
   * Two states, because arranging a payout is not the same event as making one. `pending`
   * is an obligation sitting on the ledger waiting for the venue to sign that the debtor's
   * money arrived; `settled` is a transfer that happened and can be checked.
   */
  maturity: {
    scheduleId: string;
    scheduleExplorerUrl: string | null;
    state: 'pending' | 'settled';
    executedAt: string | null;
    transactionId: string | null;
    explorerUrl: string | null;
    payer: string | null;
    payee: string | null;
  } | null;
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
  const maturityRaw = field(body, 'maturity');

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
      regulation: readRegulation(field(invoice, 'regulation'), `${path}.invoice.regulation`),
    },
    confirmation: {
      decision: decision === 'confirmed' || decision === 'disputed' ? decision : null,
      decidedAt: readOptionalString(
        field(confirmation, 'decidedAt'),
        `${path}.confirmation.decidedAt`,
      ),
    },
    registry: readInvoiceRegistry(field(body, 'registry'), `${path}.registry`),
    compliance: {
      ...readChecks(field(compliance, 'decision'), `${path}.compliance.decision`),
      reason: readOptionalString(
        field(
          readObject(field(compliance, 'decision') ?? {}, `${path}.compliance.decision`),
          'reason',
        ),
        `${path}.compliance.decision.reason`,
      ),
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
      unitsMinor: readOptionalMoney(field(assetLeg, 'unitsMinor'), `${path}.assetLeg.unitsMinor`),
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
      // The network wins over the bare chain word when both are present: `hedera:testnet`
      // is the thing the payer actually signed against.
      chain: readChainKey(
        field(cashLeg, 'network') ?? field(cashLeg, 'chain'),
        `${path}.cashLeg.chain`,
        'arc-testnet',
      ),
      rail: readCashRail(field(cashLeg, 'rail'), `${path}.cashLeg.rail`),
      scheme: readOptionalString(field(cashLeg, 'scheme'), `${path}.cashLeg.scheme`),
      network: readOptionalString(field(cashLeg, 'network'), `${path}.cashLeg.network`),
      asset: readOptionalString(field(cashLeg, 'asset'), `${path}.cashLeg.asset`),
      transaction: readOptionalString(field(cashLeg, 'transaction'), `${path}.cashLeg.transaction`),
      payer: readOptionalString(field(cashLeg, 'payer'), `${path}.cashLeg.payer`),
      settledAmountMinor: readOptionalMoney(
        field(cashLeg, 'settledAmountMinor'),
        `${path}.cashLeg.settledAmountMinor`,
      ),
      explorerUrl: readOptionalString(field(cashLeg, 'explorerUrl'), `${path}.cashLeg.explorerUrl`),
      lock: readCashLegLock(field(cashLeg, 'lock'), `${path}.cashLeg.lock`),
    },
    /*
     * Absent rather than empty when the receivable has not matured. A present-but-blank
     * maturity block would read as "asked and answered with nothing", which is a different
     * claim from "this has not happened yet".
     */
    maturity: readMaturity(maturityRaw, `${path}.maturity`),
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
/* Sellers — `POST /v1/sellers`, `GET /v1/sellers/:id`                         */
/* -------------------------------------------------------------------------- */

/**
 * A seller as the venue records them.
 *
 * The two wallet fields are nullable and their nulls mean different things, which is why
 * they are read separately rather than collapsed into one "wallet" shape. `arcAddress` is an
 * ordinary EVM address and works the moment it exists. `hederaAccountId` is a `0.0.x`, and a
 * wallet made from an email address does not have one: the address it was issued is an
 * *alias*, and Hedera creates the account behind it on first funding. A seller holding a
 * perfectly good address with no account id is the normal state, not a broken record.
 */
export interface SellerRecord {
  id: string;
  name: string;
  email: string;
  hederaAccountId: string | null;
  arcAddress: string | null;
}

/**
 * The sign-in result. `created` distinguishes a new business from a returning one — the
 * venue answers 201 and 200 respectively, and the screen says different things.
 */
export interface SellerSignIn {
  seller: SellerRecord;
  created: boolean;
}

/**
 * What the venue answers when a seller asks their customer to confirm.
 *
 * `link` is the confirmation URL, and it is **null in production on purpose**: there is no
 * mail transport in this build, so outside production the venue hands the link back rather
 * than pretending to send it, while a seller who could read it in production would be able
 * to confirm their own invoices. Both are real answers, and the screen has to be able to
 * tell them apart — which is why this is `string | null` and not a defaulted empty string.
 */
export interface ConfirmationRequested {
  sentTo: string;
  expiresAt: string;
  link: string | null;
}

export function readConfirmationRequested(
  raw: unknown,
  path = 'confirmationRequest',
): ConfirmationRequested {
  const body = readObject(raw, path);
  const confirmation = readObject(field(body, 'confirmation'), `${path}.confirmation`);
  return {
    sentTo: readString(field(confirmation, 'sentTo'), `${path}.confirmation.sentTo`),
    expiresAt: readString(field(confirmation, 'expiresAt'), `${path}.confirmation.expiresAt`),
    link: readOptionalString(field(confirmation, 'link'), `${path}.confirmation.link`),
  };
}

export function readSeller(raw: unknown, path = 'seller'): SellerRecord {
  const body = readObject(raw, path);
  return {
    id: readString(field(body, 'id'), `${path}.id`),
    name: readString(field(body, 'name'), `${path}.name`),
    email: readString(field(body, 'email'), `${path}.email`),
    hederaAccountId: readOptionalString(field(body, 'hederaAccountId'), `${path}.hederaAccountId`),
    arcAddress: readOptionalString(field(body, 'arcAddress'), `${path}.arcAddress`),
  };
}

export function readSellerSignIn(raw: unknown, path = 'signIn'): SellerSignIn {
  const body = readObject(raw, path);
  return {
    seller: readSeller(field(body, 'seller'), `${path}.seller`),
    /*
     * Absent means returning rather than new. A missing flag defaulting to `true` would
     * greet an existing business as a first-time one on every sign-in.
     */
    created: field(body, 'created') === true,
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
