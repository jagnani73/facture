/**
 * Who the screens are actually looking at, as opposed to who the build was configured for.
 *
 * `config.ts` answers the second question and always has: `NEXT_PUBLIC_SELLER_ID` names a
 * seller and every seller-side route is scoped by it. That is fine for a demo and useless
 * for a product, because it means the answer to "whose book is this" is baked in at build
 * time and identical for everyone who opens the page.
 *
 * This module is the seam between the two. It resolves an identity in one order — **a
 * signed-in session first, the configured id second** — so signing in changes whose book
 * renders, and signing out falls back to exactly the behaviour that exists today. Nothing
 * here knows what a session is made of; `setSignedInSeller` is called with an id the venue
 * returned, and where that id came from is the caller's business.
 *
 * ## Why this is a module-level value and not React state
 *
 * `lib/data/api-source.ts` is not a component. It is called from hooks but it is plain
 * async code, and threading an id through every call site would put the same argument on
 * fifteen functions to serve one caller. So the current identity lives here and is read at
 * call time — which is the reason `sellerId()` is a function and `SELLER_ID` is a constant.
 * A constant would be captured at module load and could never change.
 *
 * `subscribe` exists so React can render off this without polling: it is the shape
 * `useSyncExternalStore` wants, and it is why setting the same id twice deliberately
 * notifies nobody — a re-render on every sign-in check would be a loop.
 *
 * ## Nothing is persisted here
 *
 * There is no localStorage. A reload drops the signed-in id on purpose: the session belongs
 * to whatever authenticates the user, and the venue's id is recovered by signing in again.
 * `POST /v1/sellers` is idempotent on email precisely so that recovery is a normal call
 * rather than a special one, and caching the id locally would be a second, staler answer to
 * a question the venue can always answer.
 */

import { BUYER_ID, SELLER_ID } from './config';

let signedInSellerId: string | null = null;
const listeners = new Set<() => void>();

/** The seller whose book should render. Session first, configuration second. */
export const sellerId = (): string => signedInSellerId ?? SELLER_ID;

/**
 * The buyer whose mandates should render.
 *
 * Configuration only, for now. Onboarding covers sellers: a funder is still set up by hand
 * and there is no `POST /v1/buyers` behind which a session could produce one.
 */
export const buyerId = (): string => BUYER_ID;

/** True when the seller on screen is a signed-in one rather than the configured default. */
export const isSignedIn = (): boolean => signedInSellerId !== null;

/**
 * Whether the screens are showing the shared demo account rather than someone's own book.
 *
 * The same fact as `!isSignedIn()`, named separately because it is the one the product says
 * out loud. The configured seller is not a fallback in the user's eyes — it is **the demo
 * account**: a shared, pre-seeded book with settled trades and matured receivables in it, so
 * that the market can be looked at without an account and without pretending an empty page is
 * a market.
 *
 * The distinction is load-bearing beyond labelling. Capital behind a demo mandate is the
 * venue's own, and capital behind yours is yours, so which account is in view decides whose
 * money a deposit moves. Saying "buyer capital is escrowed" over the demo book without that
 * distinction would be the kind of overclaim this project keeps having to walk back.
 */
export const isDemoAccount = (): boolean => signedInSellerId === null;

/** `null` signs out, which restores the configured identity rather than clearing it. */
export function setSignedInSeller(id: string | null): void {
  const next = id === null || id.trim() === '' ? null : id.trim();
  if (next === signedInSellerId) return;
  signedInSellerId = next;
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Why the screens cannot ask the venue anything yet, in words, or `null` when they can.
 *
 * The venue validates these as UUIDs and answers 422 otherwise, which would surface as "the
 * venue rejected the request" on every screen at once. Catching it here means the message
 * can name what is actually wrong — and, since a session satisfies the seller side, it must
 * not keep naming an environment variable once someone has signed in.
 */
export function explainMissingIdentity(kind: 'seller' | 'buyer'): string | null {
  const value = kind === 'seller' ? sellerId() : buyerId();
  if (UUID.test(value)) return null;

  if (kind === 'seller' && signedInSellerId !== null) {
    return `Signed in, but the venue returned "${signedInSellerId}" as this business's id, which is not a UUID.`;
  }

  const variable = kind === 'seller' ? 'NEXT_PUBLIC_SELLER_ID' : 'NEXT_PUBLIC_BUYER_ID';
  if (value === '') {
    return `${variable} is not set, so this build does not know which ${kind} to ask the venue about.`;
  }
  return `${variable} is "${value}", which is not a UUID. The venue identifies a ${kind} by UUID and will refuse anything else.`;
}
