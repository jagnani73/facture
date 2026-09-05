'use client';

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
 * What it shows is the seller's **email**, never the derived business name. The email is the
 * fact — it is what identifies the seller to the venue and what the wallet was made from —
 * and the name is a placeholder this build cannot yet let anyone correct. Rendering the
 * placeholder would present a guess as a record.
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
        */}
        <span
          className="label-micro hidden text-muted sm:block"
          title="A shared, pre-seeded book. Sign in to get one of your own."
        >
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

  if (state.status === 'failed') {
    return (
      <button
        type="button"
        onClick={signIn}
        title={state.message}
        className="label-micro h-7 rounded-xs border border-neg/45 bg-neg-wash px-2 text-neg transition-colors"
      >
        Sign-in failed
      </button>
    );
  }

  const { seller } = state;

  return (
    <span className="flex items-center gap-2">
      <span
        className="label-micro hidden text-muted sm:block"
        title={
          seller.arcAddress
            ? `${seller.email} · wallet ${seller.arcAddress}`
            : `${seller.email} · no wallet recorded`
        }
      >
        {elide(seller.email, 18, 0)}
      </span>
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
