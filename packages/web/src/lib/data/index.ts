/**
 * One door for every screen.
 *
 * Which side of the seam answers is decided once, in `src/lib/api/config.ts`, and never
 * again. No component imports `fixtures` and no component imports `api/client`; they ask
 * here, and get the same shapes either way.
 *
 * The actions at the bottom are the four things a person can actually do in this product —
 * add invoices, answer a confirmation, write and fund a mandate, sell an invoice. Against
 * the demo book they resolve locally and say so on screen: nothing moved, this is demo
 * data. Against the service they are the real calls, and a failure comes back as a
 * sentence rather than a thrown stack.
 */

import type { MinorUnits, Rating } from '@/lib/domain';
import { api } from '@/lib/api/client';
import { BUYER_ID, DATA_SOURCE, SELLER_ID, usingApi } from '@/lib/api/config';
import { describeFailure } from '@/lib/api/problem';
import { apiConfirmation, apiMarket, apiProof } from './api-source';
import { fixtureConfirmation, fixtureMarket, fixtureProof } from './fixture-source';
import type { ConfirmationRecord, Market, ProofRecord } from './types';

export type {
  ConfirmationRecord,
  InvoicePricing,
  MandateMatch,
  Market,
  ProofRecord,
} from './types';
export { DATA_SOURCE, usingApi } from '@/lib/api/config';

/** True when the numbers on screen are the demo book rather than a live venue. */
export const isDemoBook = (): boolean => DATA_SOURCE === 'fixtures';

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

export function loadMarket(signal?: AbortSignal): Promise<Market> {
  return usingApi() ? apiMarket(signal) : Promise.resolve(fixtureMarket());
}

/**
 * What is already in hand.
 *
 * The demo book lives in this process, so there is nothing to wait for and a screen should
 * not flash a spinner at data it already has. Wrapped in a box rather than returned bare,
 * because `null` is a legitimate answer — "no invoice behind that token" — and it must not
 * be confused with "nothing available yet".
 */
export function marketIfImmediate(): { value: Market } | null {
  return usingApi() ? null : { value: fixtureMarket() };
}

export function confirmationIfImmediate(
  token: string,
): { value: ConfirmationRecord | null } | null {
  return usingApi() ? null : { value: fixtureConfirmation(token) };
}

export function proofIfImmediate(tradeId: string): { value: ProofRecord | null } | null {
  return usingApi() ? null : { value: fixtureProof(tradeId) };
}

export async function loadConfirmation(
  token: string,
  signal?: AbortSignal,
): Promise<ConfirmationRecord | null> {
  return usingApi() ? apiConfirmation(token, signal) : fixtureConfirmation(token);
}

export async function loadProof(
  tradeId: string,
  signal?: AbortSignal,
): Promise<ProofRecord | null> {
  return usingApi() ? apiProof(tradeId, signal) : fixtureProof(tradeId);
}

/**
 * Just enough to title a page, without dragging the whole book onto the server render.
 * Never throws: a page title is not worth failing a route over.
 */
export async function loadInvoiceLabel(
  invoiceId: string,
): Promise<{ invoiceNumber: string; customer: string } | null> {
  try {
    if (!usingApi()) {
      const market = fixtureMarket();
      const invoice = market.getInvoice(invoiceId);
      return invoice
        ? { invoiceNumber: invoice.invoiceNumber, customer: market.debtorNameOf(invoice) }
        : null;
    }
    const detail = await api.getInvoice(invoiceId);
    return {
      invoiceNumber: detail.invoice.invoiceNumber,
      customer: detail.debtor?.name ?? 'Customer',
    };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

/** Every action answers the same way: it worked, or here is why it did not, in words. */
export type Outcome<T = undefined> =
  { ok: true; value: T; note: string | null } | { ok: false; reason: string };

/** The note attached to a demo-book action, so no screen ever implies money moved. */
const DEMO_NOTE = 'Nothing moved — this book is demo data.';

export interface NewInvoiceDraft {
  customer: string;
  /** The venue needs somewhere to send the confirmation link. */
  customerEmail: string;
  reference: string;
  amountMinor: MinorUnits;
  /** `YYYY-MM-DD`. */
  dueOn: string;
}

export async function addInvoices(
  drafts: readonly NewInvoiceDraft[],
): Promise<Outcome<{ added: number; refused: { reference: string; reason: string }[] }>> {
  if (!usingApi()) {
    return {
      ok: true,
      value: { added: drafts.length, refused: [] },
      note: `${DEMO_NOTE} In the live market each of these queues for issuance and becomes quotable as it lands.`,
    };
  }

  const issuedAt = new Date().toISOString();
  const refused: { reference: string; reason: string }[] = [];
  let added = 0;

  for (const draft of drafts) {
    try {
      await api.createInvoice({
        sellerId: SELLER_ID,
        debtor: { name: draft.customer, email: draft.customerEmail },
        invoiceNumber: draft.reference,
        faceValue: draft.amountMinor,
        currency: 'USD',
        issuedAt,
        dueAt: `${draft.dueOn}T00:00:00.000Z`,
      });
      added += 1;
    } catch (error) {
      refused.push({
        reference: draft.reference,
        reason: describeFailure(error, `adding ${draft.reference}`),
      });
    }
  }

  return {
    ok: true,
    value: { added, refused },
    note:
      added === 0
        ? null
        : 'Issuance is paced, so these become quotable as they land rather than all at once.',
  };
}

export async function requestConfirmation(invoiceId: string): Promise<Outcome> {
  if (!usingApi()) {
    return {
      ok: true,
      value: undefined,
      note: `${DEMO_NOTE} In the live market your customer gets a link with one sentence and two buttons.`,
    };
  }
  try {
    await api.requestConfirmation(invoiceId);
    return { ok: true, value: undefined, note: 'Your customer has been sent the link.' };
  } catch (error) {
    return { ok: false, reason: describeFailure(error, 'the request to your customer') };
  }
}

export async function answerConfirmation(
  token: string,
  decision: 'confirmed' | 'disputed',
  note?: string,
): Promise<Outcome> {
  if (!usingApi()) return { ok: true, value: undefined, note: null };
  try {
    await api.decideConfirmation(token, decision, note);
    return { ok: true, value: undefined, note: null };
  } catch (error) {
    return { ok: false, reason: describeFailure(error, 'your answer') };
  }
}

export interface NewMandateInput {
  /** `D` is deliberately not writable: a floor that accepts a defaulter is not a bid. */
  ratingFloor: Exclude<Rating, 'D'>;
  maxTenorDays: number;
  annualisedYieldBps: number;
  exposureLimit: MinorUnits;
  perDebtorLimit: MinorUnits;
}

/**
 * Write the mandate, then fund it. Two calls because they are two different commitments:
 * a mandate is a draft until capital is escrowed behind it, and an unfunded bid would make
 * every quote on the book soft.
 */
export async function writeAndFundMandate(
  input: NewMandateInput,
): Promise<Outcome<{ mandateId: string | null }>> {
  if (!usingApi()) {
    return {
      ok: true,
      value: { mandateId: null },
      note: `${DEMO_NOTE} In the live market the capital is escrowed at this point, which is what makes the bid firm.`,
    };
  }

  let mandateId: string;
  try {
    const mandate = await api.createMandate({
      buyerId: BUYER_ID,
      ratingFloor: input.ratingFloor,
      maxTenorDays: input.maxTenorDays,
      annualisedYieldBps: input.annualisedYieldBps,
      currency: 'USD',
      exposureLimitMinor: input.exposureLimit,
      ...(input.perDebtorLimit > 0n ? { perDebtorLimitMinor: input.perDebtorLimit } : {}),
    });
    mandateId = mandate.id;
  } catch (error) {
    return { ok: false, reason: describeFailure(error, 'writing that mandate') };
  }

  try {
    await api.fundMandate(mandateId, {
      amountMinor: input.exposureLimit,
      escrowRef: `web-${Date.now()}`,
    });
  } catch (error) {
    return {
      ok: false,
      reason: `The mandate was written, but funding it did not go through, so it is not quoting yet. ${describeFailure(error, 'the funding')}`,
    };
  }

  return {
    ok: true,
    value: { mandateId },
    note: 'The capital is escrowed, so the bid is firm. Matching is bounded by the unallocated balance.',
  };
}

export type SaleOutcome =
  | { ok: true; state: 'settled'; note: string }
  | { ok: true; state: 'payment_required'; note: string }
  | { ok: false; reason: string };

/**
 * Sell one invoice.
 *
 * `quoteId` is not optional at the venue and it is not optional here: the curve moves, and
 * a seller must never be filled at a price they were not shown. If the price on screen did
 * not come with a reference, the sale says so and does not proceed.
 */
export async function sellInvoice(invoiceId: string, quoteId: string | null): Promise<SaleOutcome> {
  if (!usingApi()) {
    return {
      ok: true,
      state: 'settled',
      note: `${DEMO_NOTE} In the live market the money is with you before this message finishes rendering, and your customer still pays on the due date.`,
    };
  }

  if (quoteId === null) {
    return {
      ok: false,
      reason:
        'The venue priced this invoice but did not hand back a reference for the price, and a sale has to name the exact quote the seller was shown. Nothing was sold.',
    };
  }

  try {
    const result = await api.executeTrade({ invoiceId, quoteId, maxSlippageBps: 0 });
    if (result.status === 'payment_required') {
      return {
        ok: true,
        state: 'payment_required',
        note: 'The paper is held and the buyer has been asked to sign the cash leg. Neither leg settles unless both do; if the payment never arrives the hold expires and your position was never encumbered.',
      };
    }
    return {
      ok: true,
      state: 'settled',
      note: 'Settled. Delivery against payment, in one step, with nothing held back.',
    };
  } catch (error) {
    return { ok: false, reason: describeFailure(error, 'this sale') };
  }
}
