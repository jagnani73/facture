'use client';

import Link from 'next/link';

import { signInAvailable } from '@/lib/api/config';
import { useSellerSession } from '@/lib/auth/use-seller-session';
import { elide } from '@/lib/format';

/**
 * The masthead's sign-in control.
 *
 * Two components rather than one because `usePrivy` throws outside a provider, and the
 * provider deliberately renders nothing when no app id is configured. `signInAvailable()` is
 * a build-time constant, so choosing between them cannot change between renders and this is
 * not a conditional hook.
 *
 * What it shows is the seller's **email**, never the business name, and the reason has narrowed
 * without going away. It used to be that the name was a placeholder nobody could correct —
 * `provisionalName` guessing at the email's domain — so rendering it would present a guess as a
 * record. There is a route that corrects it now: a party signs an EIP-712 profile and
 * `PartyRegistry` records it under their own address.
 *
 * The masthead still shows the email because **it cannot tell the two apart**. `SellerRecord.name`
 * is the same field whether it was signed or guessed, and distinguishing them means reading the
 * registry — a chain call this control has no business making on every render. The email is the
 * verified fact in both cases, so it stays, and the name is shown on `/profile`, which has already
 * done that read.
 */
export function SignIn() {
  if (!signInAvailable()) return null;
  return <SignInControl />;
}

function SignInControl() {
  const { state, signIn, signOut } = useSellerSession();

  if (state.status === 'unavailable') return null;

  if (state.status === 'loading') {
    return <span className="label-micro text-muted">…</span>;
  }

  if (state.status === 'signed-out') {
    return (
      <span className="flex items-center gap-2">
        {/*
          Named, not implied. Signed out is not a degraded state here — it is the shared demo
          account, a seeded book with settled trades and matured receivables in it, which is
          what lets the market be looked at without an account. Leaving it unlabelled invites
          the opposite reading: that this is your book and you have no invoices.

          A pill rather than a word, and it no longer hides below `sm`. As quiet grey micro-text
          beside a button it read as a caption for the button, which is the one reading that
          makes it useless: the label is about every figure on the page, not about signing in.

          Deliberately NOT the same fact as `isDemoBook()`, which is about the app running on
          fixtures instead of the venue. This one says whose book you are in on a real venue.
          Two pills reading "Demo book" a few pixels apart, meaning different things, is the
          split vocabulary this codebase keeps paying for elsewhere.
        */}
        <span
          className="inline-flex items-center gap-1.5 rounded-full border border-warn/45 bg-warn-wash px-2.5 py-1 text-[0.6875rem] leading-none font-medium tracking-wide text-warn"
          title="A shared, pre-seeded book. Sign in to get one of your own."
        >
          <span aria-hidden className="size-1.5 rounded-full bg-warn" />
          Demo book
        </span>
        <button
          type="button"
          onClick={signIn}
          className="label-micro h-7 rounded-xs border border-rule px-2 text-muted transition-colors hover:border-rule-strong hover:text-ink"
        >
          Sign in
        </button>
      </span>
    );
  }

  if (state.status === 'signing-in') {
    return <span className="label-micro text-muted">Signing in…</span>;
  }

  /*
   * A failure offers both directions, and the second one is the important one.
   *
   * Retrying is right when the venue was unreachable. It is useless when Privy holds a session
   * it will not issue an identity token for, which is the failure that used to hang here
   * forever — signing in again re-enters the same state. Signing out drops the session and
   * returns to the demo book, which is where the app is meant to sit and the only state a
   * viewer can get useful work out of without an account.
   */
  if (state.status === 'failed') {
    return (
      <span className="flex items-center gap-2">
        <button
          type="button"
          onClick={signIn}
          title={state.message}
          className="label-micro h-7 rounded-xs border border-neg/45 bg-neg-wash px-2 text-neg transition-colors"
        >
          Sign-in failed
        </button>
        <button
          type="button"
          onClick={signOut}
          title="Drop the session and go back to the shared demo book."
          className="label-micro h-7 rounded-xs border border-rule px-2 text-muted transition-colors hover:border-rule-strong hover:text-ink"
        >
          Sign out
        </button>
      </span>
    );
  }

  const { seller } = state;

  return (
    <span className="flex items-center gap-2">
      {/*
        Said out loud, because the fallback underneath it is not a neutral one.

        A buyer sign-in that fails leaves `buyerId()` on `NEXT_PUBLIC_BUYER_ID`, and since the
        screens started resolving real party names that is the seeded demo desk's actual company
        name, its capital and its exposure, rendered as this person's own. The seller half is fine
        and the book is theirs, which is exactly what makes the desk half easy to miss.

        Only `unresolved` renders. `resolving` is the ordinary in-flight state on every sign-in and
        flashing a warning through it would teach a reader to ignore the colour — the same reason
        `demo-reset.mjs` reports invented addresses rather than degrading on them.
      */}
      {state.desk === 'unresolved' ? (
        <span
          className="inline-flex items-center gap-1.5 rounded-full border border-warn/45 bg-warn-wash px-2.5 py-1 text-[0.6875rem] leading-none font-medium tracking-wide text-warn"
          title="The venue did not return a funding desk for this sign-in, so Mandates is showing the shared demo desk rather than yours. Your book is unaffected."
        >
          <span aria-hidden className="size-1.5 rounded-full bg-warn" />
          Demo desk
        </span>
      ) : null}
      <Link
        href="/profile"
        className="label-micro hidden text-muted transition-colors hover:text-ink sm:block"
        title={
          seller.arcAddress
            ? `${seller.email} · wallet ${seller.arcAddress} — edit your profile`
            : `${seller.email} · no wallet recorded — edit your profile`
        }
      >
        {elide(seller.email, 18, 0)}
      </Link>
      <button
        type="button"
        onClick={signOut}
        className="label-micro h-7 rounded-xs border border-rule px-2 text-muted transition-colors hover:border-rule-strong hover:text-ink"
      >
        Sign out
      </button>
    </span>
  );
}
