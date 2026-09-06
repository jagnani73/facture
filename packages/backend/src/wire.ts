/**
 * The money serialisation boundary. One module, so there is exactly one answer.
 *
 * Two rules, and they are not in tension:
 *
 * 1. **Internally, money is `bigint` minor units.** That is `@facture/shared`'s
 *    `MinorUnits`, it is what `pricing/curve.ts` does arithmetic on, and it is what the
 *    `bigint` Drizzle columns read back. No `number` ever touches an amount.
 * 2. **On the wire, money is a decimal string.** `JSON.parse` produces a `number`, and a
 *    `number` is an IEEE-754 double: exact only below 2^53. A €100m invoice in cents is
 *    10_000_000_000n, which is fine — but a mandate's committed capital, a per-debtor
 *    exposure ladder, or any HBAR-denominated leg at 8 decimals passes 2^53 without
 *    anything looking wrong, and the corruption is silent. `JSON.stringify` also simply
 *    throws on a `bigint` rather than guessing, which is how the crash this module fixes
 *    was reachable at all.
 *
 * So: parse inbound money with {@link moneyString}, and render outbound money with
 * {@link money}. Neither direction is allowed to be open-coded elsewhere in this package
 * — a second regex is a second definition of what an amount is.
 *
 * **Field naming.** A wire field carries the *domain* name and nothing else:
 * `faceValue`, not `faceMinor`. The domain type in `@facture/shared` is
 * `Invoice.faceValue`, the DB column is `face_value`, and the JSON key is `faceValue`.
 * The scale is not encoded in the name because it is not a property of the field — it is
 * the invariant this module enforces at both ends. A name that has to be translated
 * between layers is a translation layer, and someone eventually forgets to apply it.
 */

import type { Quote, RefusalReceipt, SettlementLegState } from '@facture/shared';
import { z } from 'zod';
import type { InvoiceRow, MandateRow, SellerRow, TradeRow } from './db/schema.js';

/**
 * Inbound money: a positive integer in minor units, as a decimal string.
 *
 * Deliberately strict. No sign, no decimal point, no leading zero, no exponent — a client
 * sending `"40000.00"` or `4e7` has misunderstood the unit, and accepting it quietly
 * would be a hundredfold error in whichever direction the guess went. Rejecting is the
 * only safe read.
 */
export const moneyString = z
  .string()
  .regex(/^[1-9]\d*$/, 'must be a positive integer in minor units, as a decimal string')
  .transform((v) => BigInt(v));

/** Same, but permits zero — for balances and accumulators rather than prices. */
export const moneyStringOrZero = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, 'must be a non-negative integer in minor units, as a decimal string')
  .transform((v) => BigInt(v));

/** Outbound money: the only sanctioned way an amount leaves this service. */
export const money = (amount: bigint): string => amount.toString(10);

/** `Quote` with every `MinorUnits` field rendered as a decimal string. */
export interface WireQuote extends Omit<Quote, 'faceValue' | 'discount' | 'proceeds'> {
  faceValue: string;
  discount: string;
  proceeds: string;
}

export const wireQuote = (q: Quote): WireQuote => ({
  ...q,
  faceValue: money(q.faceValue),
  discount: money(q.discount),
  proceeds: money(q.proceeds),
});

/**
 * A refusal receipt, safe to `JSON.stringify`.
 *
 * `detail` is a discriminated union and two of its variants (`EXPOSURE_EXHAUSTED`,
 * `DEBTOR_CONCENTRATION`) carry `MinorUnits`. They are converted structurally rather than
 * by naming each field, so a new refusal variant that carries an amount cannot slip
 * through and reintroduce the throw.
 */
export interface WireRefusalReceipt extends Omit<RefusalReceipt, 'detail'> {
  detail: Record<string, unknown>;
}

export const wireRefusalReceipt = (r: RefusalReceipt): WireRefusalReceipt => ({
  ...r,
  detail: Object.fromEntries(
    Object.entries(r.detail).map(([k, v]) => [k, typeof v === 'bigint' ? money(v) : v]),
  ),
});

/* ---------------------------------------------------------------------------------- *
 * Row renderers.
 *
 * Everything a route returns that carries an amount goes through one of these, for the
 * same reason `money` exists at all: a `bigint` reaching `c.json` throws, and the throw is
 * a 500 on a screen that was only trying to show a price. Field names are the domain
 * names — `faceValue`, matching `Invoice.faceValue` and the `face_value` column — so
 * nothing has to be translated between layers.
 * ---------------------------------------------------------------------------------- */

const isoOrNull = (value: Date | null): string | null => value?.toISOString() ?? null;

/**
 * A seller as their own screens read them.
 *
 * Both wallet fields are nullable and mean different things when null. `arcAddress` is an
 * ordinary EVM address and is usable the moment it is recorded.
 *
 * `hederaAccountId` holds **either** a `0.0.x` **or** an ECDSA alias, and the name is older
 * than that fact: the seeded seller and the one buyer that settles both carry aliases, and
 * `services/ats.ts` passes a `0x…` straight through while converting a `0.0.x` to its
 * long-zero form. The two are different keys to a Solidity contract, which is why an
 * invented account id is worse here than an empty column.
 *
 * A wallet made from an email address has an alias and no account id at all: Hedera creates
 * the account behind it on first funding. So a seller can hold a perfectly good address and
 * still have no id, and the screen has to say which of those it is rather than printing an
 * empty cell.
 */
export const wireSeller = (row: SellerRow) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  hederaAccountId: row.hederaAccountId,
  arcAddress: row.arcAddress,
  createdAt: row.createdAt.toISOString(),
});

/**
 * An invoice as the book renders it.
 *
 * `issuance` is a sibling of `status`, not part of it. Tokenisation is paced and moves
 * independently: an invoice can be confirmed before its instrument exists, and the book
 * shows it as *being added* off this object while `status` already says `confirmed`.
 */
export const wireInvoice = (row: InvoiceRow) => ({
  id: row.id,
  sellerId: row.sellerId,
  debtorId: row.debtorId,
  invoiceNumber: row.invoiceNumber,
  faceValue: money(row.faceValue),
  currency: row.currency,
  issuedAt: row.issuedAt.toISOString(),
  dueAt: row.dueAt.toISOString(),
  status: row.status,
  uniquenessHash: row.uniquenessHash,
  isin: row.isin,
  regulationType: row.regulationType,
  securityId: row.securityId,
  instrumentAddress: row.securityEvmAddress,
  issuance: {
    state: row.issuanceState,
    attempts: row.issuanceAttempts,
    transactionId: row.issuanceTxId,
    error: row.issuanceError,
  },
  confirmation: {
    requestedAt: isoOrNull(row.confirmationRequestedAt),
    expiresAt: isoOrNull(row.confirmationExpiresAt),
    decision: row.confirmationDecision,
    decidedAt: isoOrNull(row.confirmationDecidedAt),
    note: row.confirmationNote,
  },
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * A standing bid as its owner reads it.
 *
 * `committed` is the escrowed balance and `exposureLimit` is the ceiling the buyer wrote.
 * They are separate fields because only the first one is money anyone has posted, and it
 * is the first one that bounds a match — a mandate quotes what it funded, not what it
 * intends to fund.
 */
export const wireMandate = (row: MandateRow) => ({
  id: row.id,
  buyerId: row.buyerId,
  ratingFloor: row.ratingFloor,
  maxTenorDays: row.maxTenorDays,
  annualisedYieldBps: row.annualisedYieldBps,
  currency: row.currency,
  exposureLimit: money(row.exposureLimitMinor),
  perDebtorLimit: row.perDebtorLimitMinor === null ? null : money(row.perDebtorLimitMinor),
  committed: money(row.fundedMinor),
  allocated: money(row.allocatedMinor),
  unallocated: money(
    row.fundedMinor > row.allocatedMinor ? row.fundedMinor - row.allocatedMinor : 0n,
  ),
  escrowRef: row.escrowRef,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** A trade with both legs' current state. The audit detail is one click away at `/proof`. */
export const wireTrade = (row: TradeRow) => ({
  id: row.id,
  invoiceId: row.invoiceId,
  mandateId: row.mandateId,
  quoteId: row.quoteId,
  sellerId: row.sellerId,
  buyerId: row.buyerId,
  faceValue: money(row.faceValue),
  proceeds: money(row.proceedsMinor),
  discount: money(row.faceValue - row.proceedsMinor),
  annualisedYieldBps: row.annualisedYieldBps,
  tenorDays: row.tenorDays,
  status: row.status,
  assetLeg: {
    chain: 'hedera' as const,
    state: assetLegState(row),
    holdId: row.holdId,
    /**
     * Units of the security, not money — a decimal string for the same reason the amounts
     * are: issuance mints face-value-many units, so this is in the millions and `number`
     * is the wrong type to hand a client for something that indexes a position.
     */
    unitsMinor: row.unitsMinor?.toString(10) ?? null,
    transactionId: row.assetTxId,
    consensusAt: isoOrNull(row.assetConsensusAt),
  },
  cashLeg: {
    chain: cashLegChain(row),
    /**
     * Which rail settled it, read from the row rather than guessed from the network string.
     *
     * Null until a rail has run. That is a third state and it matters: the guess this
     * replaced defaulted a null network to Arc, so a trade that had not settled at all
     * rendered as an Arc trade.
     */
    rail: row.cashRail,
    state: cashLegState(row),
    scheme: row.cashScheme,
    network: row.cashNetwork,
    asset: row.cashAsset,
    transaction: row.cashTransaction,
    payer: row.cashPayer,
    /** What moved, in the settlement asset's own minor units. See the column's own note. */
    settledAmountMinor: row.cashAmountMinor === null ? null : money(row.cashAmountMinor),
  },
  createdAt: row.createdAt.toISOString(),
  settledAt: isoOrNull(row.settledAt),
});

/**
 * Leg states derived from the trade's own status rather than stored twice.
 *
 * `SettlementLegState` is shared's vocabulary — `pending | held | settled | released |
 * failed` — and duplicating it in two nullable columns per leg would let a row describe a
 * trade that is settled with a pending leg.
 */
function assetLegState(row: TradeRow): SettlementLegState {
  if (row.status === 'settled') return 'settled';
  if (row.status === 'unwound') return 'released';
  if (row.status === 'failed') return 'failed';
  return row.holdId === null ? 'pending' : 'held';
}

/**
 * The chain the cash leg settled on, from the rail rather than a string prefix.
 *
 * `cash_rail` is what the venue recorded; `cashNetwork` is a fallback for the rows written
 * before that column existed, and it keeps its original meaning for them. A trade with
 * neither is `null` — it has not settled — where the old inference answered `'arc'`.
 */
function cashLegChain(row: TradeRow): 'hedera' | 'arc' | null {
  if (row.cashRail === 'arc-vault') return 'arc';
  if (row.cashRail === 'x402')
    return row.cashNetwork?.startsWith('hedera') === true ? 'hedera' : 'arc';
  if (row.cashNetwork === null) return null;
  return row.cashNetwork.startsWith('hedera') ? 'hedera' : 'arc';
}

function cashLegState(row: TradeRow): SettlementLegState {
  if (row.status === 'settled') return 'settled';
  if (row.status === 'failed') return row.cashTransaction === null ? 'failed' : 'settled';
  if (row.status === 'unwound') return 'released';
  return 'pending';
}
