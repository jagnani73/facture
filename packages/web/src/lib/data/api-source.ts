/**
 * The live book, behind the same seam.
 *
 * This is the fixture module's promise kept: same exported shape, bodies are fetches.
 *
 * Two things are worth stating about how the book is assembled here, because both are
 * product decisions rather than plumbing.
 *
 * **The price is the venue's, not the screen's.** Every row's number is priced against every
 * funded mandate on the book, server-side. The screen can only enumerate the mandates
 * belonging to whoever is looking — there is no "list all mandates" route, and bids being
 * public does not make a buyer's exposure public — so a locally computed price would be a
 * price against a fraction of the curve. It would also be a second opinion, and a market
 * with two opinions about its own price has one too many.
 *
 * **The book is one request; the reasons are not.** `GET /v1/invoices` prices the whole page
 * in a single batched pass and returns the price inline with every row, so "a live price in
 * every row" costs one round trip rather than one per row. What that route deliberately
 * omits is the refusals and the quote handle, both of which belong to one invoice — so
 * `GET /v1/invoices/:id/quote` is asked only for the invoices that are actually quotable.
 * That is what gives the invoice page its refusals in words, and the sale the exact price
 * the seller was shown.
 */

import type { Debtor, Invoice, Mandate, MinorUnits } from '@/lib/domain';
import { ASSET_CHAIN, CHAINS, isQuotable, tenorDays } from '@/lib/domain';
import type { Position } from '@/lib/pricing';
import { api } from '@/lib/api/client';
import { buyerId, explainMissingIdentity, sellerId } from '@/lib/api/identity';
import type {
  LiveQuoteResponse,
  PartyLookup,
  TradeProofResponse,
  TradeRecord,
} from '@/lib/api/contract';
import { ApiError } from '@/lib/api/problem';
import { isSettledTrade } from '@/lib/settlement';
import type { ConfirmationRecord, InvoicePricing, Market, ProofRecord } from './types';
import { buildMarket, derivedMeta } from './types';

/* -------------------------------------------------------------------------- */
/* Plumbing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Bounded fan-out. A seller with two hundred quotable invoices should not open two hundred
 * sockets at once.
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await run(item, index);
    }
  });

  await Promise.all(workers);
  return results;
}

function requireIdentity(): void {
  const problems = [explainMissingIdentity('seller'), explainMissingIdentity('buyer')].filter(
    (message): message is string => message !== null,
  );

  if (problems.length > 0) {
    throw new ApiError({
      code: 'misconfigured',
      status: 0,
      title: 'Not configured',
      detail: problems.join(' '),
      what: 'the book',
    });
  }
}

/** The venue derives the price; this only converts its answer to view shape. */
function toPricing(invoiceId: string, live: LiveQuoteResponse): InvoicePricing {
  return {
    invoiceId,
    rating: live.rating,
    tenorDays: live.tenorDays,
    quote: live.quote,
    quoteId: live.quoteId,
    // The venue answers how many mandates would take this, never which — a seller does not
    // choose a counterparty, so the list would be decoration with a privacy cost.
    matches: [],
    matchCount: live.mandatesMatching,
    candidatesConsidered: live.mandatesConsidered,
    refusals: live.refusals,
    pricedAt: live.pricedAt,
  };
}

/** Tenor is measured off the trade, so the maturity it implies is the trade's own. */
function dueAtFromTrade(trade: TradeRecord): string {
  return new Date(Date.parse(trade.executedAt) + trade.tenorDays * 86_400_000).toISOString();
}

function toPosition(
  trade: TradeRecord,
  invoice: Invoice | undefined,
  debtor: Debtor | undefined,
): Position {
  return {
    id: trade.id,
    mandateId: trade.mandateId,
    invoiceId: trade.invoiceId,
    invoiceNumber: invoice?.invoiceNumber ?? trade.invoiceId,
    debtorId: invoice?.debtorId ?? 'unknown',
    debtorName: debtor?.name ?? 'Customer not disclosed',
    rating: debtor?.rating ?? 'UNRATED',
    faceValue: trade.faceValue,
    outlay: trade.proceeds,
    annualisedYieldBps: trade.annualisedYieldBps,
    boughtAt: trade.executedAt,
    dueAt: invoice?.dueAt ?? dueAtFromTrade(trade),
    state:
      invoice?.status === 'matured'
        ? 'settled'
        : invoice?.status === 'defaulted'
          ? 'defaulted'
          : 'open',
  };
}

/**
 * Who the screens are looking at, in the party's own words.
 *
 * This used to be the literal `'Your business'`, above a comment saying no response carried a
 * name and there was no session. **Both halves of that stopped being true** — `GET /v1/sellers/:id`
 * has answered a name since seller onboarding shipped, and a signed-in seller's record comes back
 * on every sign-in — and the literal outlived them, so the live product called every seller "Your
 * business" and every funder "Your desk" while the fixture book was the only place a company was
 * ever named.
 *
 * The order is deliberate. A profile on `PartyRegistry` is what the party **signed** for
 * themselves, so it outranks the venue's own column, which before onboarding holds nothing better
 * than `provisionalName`'s guess at the email domain. The venue's name is the fallback rather than
 * the authority, and the last resort names nobody rather than inventing one.
 */
function nameOf(party: PartyLookup | null, fallback: string): string {
  return party?.profile?.displayName ?? party?.venueName ?? fallback;
}

/**
 * A party lookup that cannot fail the page.
 *
 * A name is the least load-bearing thing on these screens, and the book behind it is the most.
 * Letting an unreadable registry — or a venue that has not been told who this buyer is — take out
 * the whole market view would trade something that matters for something that does not.
 */
async function lookupParty(read: () => Promise<PartyLookup>): Promise<PartyLookup | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* The market                                                                  */
/* -------------------------------------------------------------------------- */

export async function apiMarket(signal?: AbortSignal): Promise<Market> {
  requireIdentity();

  const asOf = new Date();

  const [book, mandatePage, sellerTrades, buyerTrades, sellerParty, buyerParty] = await Promise.all(
    [
      api.listInvoices({ sellerId: sellerId() }, signal),
      api.listMandates({ buyerId: buyerId() }, signal),
      api.listTrades({ sellerId: sellerId() }, signal),
      api.listTrades({ buyerId: buyerId() }, signal),
      // Two more round trips, in the same pass rather than after it. Serialising them would put a
      // name lookup in front of the book, which is the wrong thing to make anyone wait for.
      lookupParty(() => api.getPartyBySeller(sellerId(), signal)),
      lookupParty(() => api.getPartyByBuyer(buyerId(), signal)),
    ],
  );

  const rows = book.items;
  const invoices = rows.map((row) => row.invoice);
  const mandates: Mandate[] = mandatePage.items;

  /*
   * Customers come back on the row that names them. There is no route that lists them
   * separately — a debtor is reached through an invoice — and there does not need to be.
   */
  const debtorsById = new Map<string, Debtor>();
  for (const row of rows) {
    if (row.debtor) debtorsById.set(row.debtor.id, row.debtor);
  }

  // The batched price, straight off the row.
  const pricing = new Map<string, InvoicePricing>(
    rows.map((row) => [
      row.invoice.id,
      {
        invoiceId: row.invoice.id,
        rating: row.debtor?.rating ?? 'UNRATED',
        tenorDays: row.tenorDays ?? tenorDays(row.invoice.dueAt, asOf),
        quote: row.quote,
        // Only `GET /invoices/:id/quote` mints a handle; filled in below where it matters.
        quoteId: null,
        matches: [],
        matchCount: row.mandatesMatching,
        // The book route answers how many matched, never how many were screened. Claiming
        // the two are equal would understate the curve on any row that was refused.
        candidatesConsidered: 0,
        refusals: [],
        pricedAt: asOf.toISOString(),
      },
    ]),
  );

  /*
   * The reasons, and the handle to sell at. Only for paper that can actually be quoted:
   * why a sold or matured invoice carries no bid is not a question anyone is asking.
   */
  const quotable = invoices.filter(isQuotable);
  const priced = await mapLimit(quotable, 6, (invoice) =>
    api.getQuote(invoice.id, { includeRefusals: true }, signal),
  );
  for (const live of priced) {
    pricing.set(live.invoiceId, toPricing(live.invoiceId, live));
  }

  const invoicesById = new Map(invoices.map((invoice) => [invoice.id, invoice]));

  const trades: TradeRecord[] = [];
  const seen = new Set<string>();
  for (const trade of [...sellerTrades.items, ...buyerTrades.items]) {
    if (seen.has(trade.id)) continue;
    seen.add(trade.id);
    trades.push(trade);
  }

  /*
   * Only a settled trade is a position. An attempt that was unwound, or one that
   * half-settled, is a trade the buyer does not hold paper against — counting it would
   * inflate the desk's exposure and its weighted yield with paper it never received.
   */
  const positions = buyerTrades.items.filter(isSettledTrade).map((trade) => {
    const invoice = invoicesById.get(trade.invoiceId);
    return toPosition(trade, invoice, invoice ? debtorsById.get(invoice.debtorId) : undefined);
  });

  const notices: string[] = [
    'Bids are public in this market, but this service only lists the mandates you own — so the curve on screen is your own book. Every price beside an invoice is still read against the whole curve, by the venue.',
  ];

  return buildMarket({
    source: 'api',
    asOf,
    seller: { id: sellerId(), name: nameOf(sellerParty, 'Your business') },
    viewer: { id: buyerId(), name: nameOf(buyerParty, 'Your desk') },
    invoices,
    debtors: [...debtorsById.values()],
    mandates,
    positions,
    trades,
    pricing,
    meta: new Map(
      mandates.map((mandate) => [
        mandate.id,
        derivedMeta(mandate, nameOf(buyerParty, 'This desk')),
      ]),
    ),
    // Confirmation links are minted by the venue and emailed to the customer. The seller's
    // screen never sees the token, which is the point of it being single-use.
    tokens: new Map(),
    notices,
    // The venue publishes a customer's earned grade, not the counters behind it.
    debtorHistoryKnown: false,
  });
}

/* -------------------------------------------------------------------------- */
/* Debtor confirmation                                                         */
/* -------------------------------------------------------------------------- */

export async function apiConfirmation(
  token: string,
  signal?: AbortSignal,
): Promise<ConfirmationRecord> {
  const prompt = await api.getConfirmation(token, signal);
  return {
    sellerName: prompt.sellerName,
    debtorName: prompt.debtorName,
    invoiceNumber: prompt.invoiceNumber,
    amount: prompt.amount,
    faceValue: prompt.faceValue,
    dueAt: prompt.dueAt,
    decision: prompt.decision,
  };
}

/* -------------------------------------------------------------------------- */
/* The proof view                                                              */
/* -------------------------------------------------------------------------- */

const HEDERA = CHAINS[ASSET_CHAIN];

/**
 * The same refusal, said once, with how many times it was recorded.
 *
 * The first occurrence keeps its position, so the order the venue returned — which is the
 * order they were written — still reads top to bottom.
 */
/**
 * The asset leg's size, in the words the screen uses: how many units, of which security.
 *
 * A unit here is one minor unit of the invoice currency, so the count is the face value and
 * never has a fractional part. `null` when the venue did not say — a transfer of an unstated
 * size is not a transfer of zero, and this row exists precisely so that a trade moving one
 * unit of a face-value-many issuance is impossible to miss.
 */
function transferredUnits(units: MinorUnits | null, securityId: string | null): string | null {
  if (units === null) return null;
  const counted = `${units.toLocaleString('en-US')} ${units === 1n ? 'unit' : 'units'}`;
  return securityId === null ? counted : `${counted} of ${securityId}`;
}

function collapseRefusals(refusals: TradeProofResponse['refusals']): ProofRecord['refusals'] {
  const byReason = new Map<string, ProofRecord['refusals'][number] & { times: number }>();

  for (const refusal of refusals) {
    /*
     * A separator that cannot occur inside any of the three operands, written as an
     * escape. The same byte typed literally is what made this file read as binary to
     * grep, `file` and every diff tool - an invisible character is a poor trade for a
     * source file nothing can search.
     */
    const key = `${refusal.mandateId}\0${refusal.reasonCode}\0${refusal.reasonText}`;
    const seen = byReason.get(key);
    if (seen) {
      seen.times += 1;
      // A receipt link only appears once the venue has one; take the first that exists.
      seen.hcsExplorerUrl ??= refusal.hcsExplorerUrl;
      continue;
    }
    byReason.set(key, {
      mandateId: refusal.mandateId,
      mandateName: null,
      reasonCode: refusal.reasonCode,
      reasonText: refusal.reasonText,
      times: 1,
      hcsExplorerUrl: refusal.hcsExplorerUrl,
    });
  }

  return [...byReason.values()];
}

export async function apiProof(tradeId: string, signal?: AbortSignal): Promise<ProofRecord> {
  const [trade, proof] = await Promise.all([
    api.getTrade(tradeId, signal),
    api.getTradeProof(tradeId, signal),
  ]);

  return {
    tradeId: proof.tradeId,
    trade,
    instrument: {
      tokenId: proof.invoice.securityId,
      isin: proof.invoice.isin,
      uniquenessHash: proof.invoice.uniquenessHash,
      /*
       * The invoice's own declaration, not this build's default.
       *
       * It was hardcoded null here for as long as the proof contract had no such field, so
       * the row rendered on the fixture path and never on the live one. Reading the venue's
       * value rather than substituting `ATS_REGULATION_TYPE` is the whole point: the two
       * disagreed once, and a screen showing the configured default would have agreed with
       * the wrong one.
       */
      regulation: proof.invoice.regulation,
      maturity: null,
      issuedAt: null,
      issuedTxId: null,
      explorerUrl:
        proof.invoice.securityExplorerUrl ??
        // `/contract/`, not `/token/`. An ATS security is a diamond the factory deployed and
        // the mirror node 404s it as a token, so the old spelling was a dead link on the one
        // screen that exists to be checked. The venue's own link is preferred; this is only
        // the fallback for when it did not send one, and it has to agree with it.
        (proof.invoice.securityId
          ? `${HEDERA.explorerUrl}/contract/${proof.invoice.securityId}`
          : null),
    },
    confirmation: proof.confirmation,
    /*
     * Passed through whole, including `checked: false`. The venue is the only party that
     * knows whether it got an answer out of the node, and this source has no business
     * turning "could not ask" into a no on the way to the screen.
     */
    registry: proof.registry,
    compliance: proof.compliance,
    assetLeg: {
      from: null,
      to: null,
      quantity: transferredUnits(proof.assetLeg.unitsMinor, proof.invoice.securityId),
      transactionId: proof.assetLeg.transactionId,
      holdId: proof.assetLeg.holdId,
      consensusAt: proof.assetLeg.consensusAt,
      explorerUrl: proof.assetLeg.explorerUrl,
    },
    cashLeg: {
      // Read off the venue's own `network`, not assumed. An x402 trade settles in HBAR on
      // Hedera and needs a HashScan link; a vault payout is USDC on Arc and needs ArcScan.
      chain: proof.cashLeg.chain,
      rail: proof.cashLeg.rail,
      from: proof.cashLeg.payer,
      /*
       * The payee, at last, and only on the rail that names one. A vault payout binds the
       * seller's address on chain before delivery, so the escrow lock knows exactly who the
       * money is for. x402 pays whoever the challenge said, and the venue does not publish
       * that, so it stays null rather than being guessed at.
       */
      to: proof.cashLeg.lock?.beneficiary ?? null,
      asset: proof.cashLeg.asset,
      scheme: proof.cashLeg.scheme,
      network: proof.cashLeg.network,
      transaction: proof.cashLeg.transaction,
      settledAmountMinor: proof.cashLeg.settledAmountMinor,
      explorerUrl: proof.cashLeg.explorerUrl,
      lock: proof.cashLeg.lock,
    },
    // Passed straight through. The venue decides whether a receivable has matured and
    // whether anyone has been paid; this source does not get a vote on either.
    payout: proof.maturity,
    /*
     * The venue publishes each leg and names the scheme that bound them. `scheme` is
     * `exact` — that is the x402 scheme the payer signed under, not the protocol, and
     * printing it as "Protocol: exact" said neither thing. The protocol is named here
     * because it is a fact about this build rather than a field the venue happens to omit;
     * the facilitator and the nonce are left null because they are not published.
     */
    settlement:
      proof.cashLeg.rail === null && proof.cashLeg.scheme === null && proof.cashLeg.network === null
        ? null
        : {
            /*
             * Named from the rail the venue recorded, not asserted.
             *
             * This block used to read `x402 delivery versus payment` for every trade,
             * hardcoded — and it disappeared entirely when the scheme and network were both
             * null, which is exactly the shape a vault payout has. So the rail that most
             * needed explaining was the one that got no explanation at all.
             */
            protocol:
              proof.cashLeg.rail === 'arc-vault'
                ? 'Escrowed capital, delivery versus payment'
                : 'x402 delivery versus payment',
            scheme: proof.cashLeg.scheme,
            network: proof.cashLeg.network,
            facilitator: null,
            challengeNonce: null,
            boundAt: null,
            note:
              proof.cashLeg.rail === 'arc-vault'
                ? 'The buyer escrowed this capital on Arc before the invoice existed, so there was nothing to sign. The payout is locked for the seller against the same hash the paper moved under; neither leg settles unless both do, and nothing is wrapped or bridged.'
                : 'Both legs are bound to one x402 challenge. Neither settles unless both do, and nothing is wrapped or bridged.',
          },
    /*
     * One row per mandate per reason, counted.
     *
     * The venue records a refusal receipt on every pricing pass, so an invoice that was
     * quoted ten times carries the same four refusals ten times over. Every one of them is
     * a real receipt and none of them is new information — printing forty identical
     * sentences turns the record a rejected funder is owed into a wall to scroll past.
     */
    refusals: collapseRefusals(proof.refusals),
    invoiceNumber: proof.invoice.invoiceNumber === '' ? null : proof.invoice.invoiceNumber,
    debtorName: null,
    sellerName: null,
    buyerName: null,
    settledAt: proof.settledAt,
  };
}
