/**
 * Who is selling, and who holds the paper now.
 *
 * Before the secondary market there was one answer to both questions and it was
 * `invoice.sellerId` — the business that raised the receivable, forever. A resale breaks
 * that: the party selling seasoned paper is whoever bought it last, and they are a
 * **buyer**, with a row in `buyers` and none in `sellers`.
 *
 * Two id spaces meeting in one question is exactly the shape this codebase keeps getting
 * wrong when the answer is derived at each call site — the settlement conversion in
 * {@link ./units.ts}, the refusal vocabulary, the regulation spelling. So the fallback is
 * spelled once, here, and every caller that needs to know who is selling imports it rather
 * than reading `reseller_buyer_id ?? seller_id` for itself.
 *
 * The rule: **`seller_id` names the originator and never stops meaning that.** Issuance
 * mints to them, the confirmation link is theirs, and the seller-scoped book is theirs.
 * `reseller_buyer_id` names the party selling *in this trade* and is null on a first sale.
 */

import type { TradeRow } from './db/schema.js';

/**
 * The party on the sell side of one trade.
 *
 * `kind` is not decoration. The two ids live in different tables, so a caller that resolves
 * a party has to know which store to ask, and a `string` alone cannot tell it — that is the
 * whole reason this is a tagged pair rather than an id.
 */
export type SellingParty =
  { kind: 'originator'; sellerId: string } | { kind: 'holder'; buyerId: string };

/**
 * Who is selling in this trade.
 *
 * A first sale is the originator; a resale is the previous holder. Total, so there is no
 * "unknown seller" case for a caller to invent a default for.
 */
export function sellingPartyOf(
  trade: Pick<TradeRow, 'sellerId' | 'resellerBuyerId'>,
): SellingParty {
  return trade.resellerBuyerId === null
    ? { kind: 'originator', sellerId: trade.sellerId }
    : { kind: 'holder', buyerId: trade.resellerBuyerId };
}

/** True when this trade is a resale rather than a first sale. */
export function isResale(trade: Pick<TradeRow, 'resellerBuyerId'>): boolean {
  return trade.resellerBuyerId !== null;
}

/**
 * The selling party's id, flattened.
 *
 * For callers that only need to name the party rather than resolve it — the HCS match
 * commitment, a log line. The tag is dropped deliberately: anything that goes on to LOOK the
 * party up needs {@link sellingPartyOf}, because the id alone cannot say which table.
 */
export function sellingPartyIdOf(trade: Pick<TradeRow, 'sellerId' | 'resellerBuyerId'>): string {
  const party = sellingPartyOf(trade);
  return party.kind === 'originator' ? party.sellerId : party.buyerId;
}

/**
 * The trade that currently holds an invoice's paper, or null if nobody does.
 *
 * The newest settled trade that has not been superseded. `settleAtMaturity` and
 * `recordDefault` already resolved the holder as "the newest settled trade" before resales
 * existed, and both were right for the reason this keeps being right: **the paper is where
 * it is, not where the invoice row says it started.** What a resale adds is the
 * `supersededAt` filter, so a position that has been sold on stops answering.
 *
 * Callers pass the trades they already loaded rather than this reaching for a store: the
 * holder is read inside transactions that are holding a row lock, and a second query there
 * is how a deadlock gets written.
 */
export function currentHolderTrade<
  T extends Pick<TradeRow, 'status' | 'supersededAt' | 'settledAt'>,
>(trades: readonly T[]): T | null {
  const live = trades.filter((t) => t.status === 'settled' && t.supersededAt === null);
  if (live.length === 0) return null;

  /*
   * Newest wins, and `settledAt` is what orders them rather than `createdAt`: a trade that
   * was armed first can settle second, and it is the settlement that moved the paper.
   */
  return live.reduce((newest, t) =>
    (t.settledAt?.getTime() ?? 0) > (newest.settledAt?.getTime() ?? 0) ? t : newest,
  );
}
