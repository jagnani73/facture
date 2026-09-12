/**
 * The half of a sign-in that is allowed to fail, and what it must not be allowed to do quietly.
 *
 * `POST /v1/sellers` and `POST /v1/buyers` are two calls behind one login. Only the first decides
 * whether the session succeeded — a venue that cannot mint a buyer id must not knock a seller back
 * to the demo book — and that asymmetry is deliberate and is not what these tests question.
 *
 * What they pin is where the second one's failure goes. It used to go nowhere: an empty `.catch`,
 * `signedInBuyerId` left null, and `buyerId()` falling back to `NEXT_PUBLIC_BUYER_ID` with nothing
 * anywhere recording that it had. That fallback stopped being harmless when the screens began
 * resolving real party names — a seller whose desk half failed is shown **the seeded demo desk's
 * actual company name, capital and exposure** as their own, on a page that otherwise looks like a
 * working signed-in session.
 *
 * The sibling file `seller-session.test.ts` says the hook is "glue over Privy and not worth a fake
 * Privy to exercise". That was true of the decoder and has now been false twice — `sign-in.test.tsx`
 * exists because a real session half-existed in a browser, and this exists because half of one
 * failed. Both are states no clean sign-in reaches.
 */

import { cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SellerSessionState } from '@/lib/auth/use-seller-session';
import { ApiError } from '@/lib/api/problem';

/* ── the Privy seam ──────────────────────────────────────────────────────────────────── */

const login = vi.fn();
const logout = vi.fn();
let privy = { ready: true, authenticated: true, login, logout };
let identityToken: string | null = 'identity-token';

vi.mock('@privy-io/react-auth', () => ({
  usePrivy: () => privy,
  useIdentityToken: () => ({ identityToken }),
}));

const signInSeller = vi.fn();
const signInBuyer = vi.fn();

vi.mock('@/lib/api/client', () => ({ api: { signInSeller, signInBuyer } }));

/*
 * `identity.ts` is the real module here — it is what falls back to the configured desk, which is
 * the behaviour under test — so its two constants have to come out of this mock as well. Empty is
 * what they are under vitest anyway, `NEXT_PUBLIC_*` being unset.
 */
vi.mock('@/lib/api/config', () => ({
  signInAvailable: () => true,
  SELLER_ID: '',
  BUYER_ID: 'configured-demo-desk',
}));

/*
 * The masthead's link needs an app router mounted and this file is about the pill beside it, not
 * about routing. Swapped for the anchor it renders anyway.
 */
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { useSellerSession } = await import('@/lib/auth/use-seller-session');
const { SignIn } = await import('@/components/sign-in');
const { buyerId, setSignedInBuyer, setSignedInSeller } = await import('@/lib/api/identity');

/* ── fixtures ────────────────────────────────────────────────────────────────────────── */

const SELLER = {
  id: 'adee1c64-4ba9-46be-9c04-3a37c1ddc895',
  name: 'Meridian Fabrication',
  email: 'ada@meridian.example',
  hederaAccountId: null,
  arcAddress: '0x1c755e95cb11e5d5af498bb0ea595b56e1adb035',
};

const BUYER = {
  id: '2b6f0cc9-04a1-5e35-8f7c-3d1f9f0b1a2e',
  name: 'Meridian Fabrication',
  email: 'ada@meridian.example',
  hederaAccountId: null,
  arcAddress: null,
};

let warned: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  signInSeller.mockReset();
  signInSeller.mockResolvedValue({ seller: SELLER, created: false });
  signInBuyer.mockReset();
  signInBuyer.mockResolvedValue({ buyer: BUYER, created: false });
  privy = { ready: true, authenticated: true, login, logout };
  identityToken = 'identity-token';
  warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  setSignedInSeller(null);
  setSignedInBuyer(null);
  warned.mockRestore();
});

function deskOf(state: SellerSessionState): string {
  if (state.status !== 'signed-in') {
    throw new Error(`expected a signed-in session, got ${state.status}`);
  }
  return state.desk;
}

const refused = () =>
  new ApiError({
    code: 'internal_error',
    status: 500,
    title: 'The venue failed while answering.',
    detail: 'No desk could be minted for this email.',
  });

/* ── tests ───────────────────────────────────────────────────────────────────────────── */

describe('when the desk resolves', () => {
  it('records it, and the screens follow the session rather than the build', async () => {
    const { result } = renderHook(() => useSellerSession());

    await vi.waitFor(() => expect(deskOf(result.current.state)).toBe('resolved'));
    expect(buyerId()).toBe(BUYER.id);
  });

  it('warns about nothing', async () => {
    const { result } = renderHook(() => useSellerSession());

    await vi.waitFor(() => expect(deskOf(result.current.state)).toBe('resolved'));
    expect(warned).not.toHaveBeenCalled();
  });
});

describe('when the desk does not', () => {
  beforeEach(() => {
    signInBuyer.mockRejectedValue(refused());
  });

  /**
   * The property that was already right, and has to stay right. A desk the venue could not mint
   * is not a reason to return somebody to the shared demo book — their invoices are their own and
   * the seller half answered.
   */
  it('leaves the seller signed in', async () => {
    const { result } = renderHook(() => useSellerSession());

    await vi.waitFor(() => expect(result.current.state.status).toBe('signed-in'));
    expect(signInSeller).toHaveBeenCalledTimes(1);
  });

  /**
   * THE ONE THAT MATTERS. Three values rather than two: `resolving` is every ordinary sign-in for
   * a moment, and `unresolved` is the fact a screen can act on — the desk being shown is not this
   * person's. An empty catch made it indistinguishable from a session that had simply not answered
   * yet, which is the same collapse `setSignedInBuyer` was split out to prevent one layer down.
   */
  it('records the desk as unresolved rather than as nothing at all', async () => {
    const { result } = renderHook(() => useSellerSession());

    await vi.waitFor(() => expect(deskOf(result.current.state)).toBe('unresolved'));
    expect(buyerId()).toBe('configured-demo-desk');
  });

  /*
   * The state says a desk did not resolve; only the error says whether the venue was unreachable,
   * refused the token, or answered in a shape this build could not read. None of that survives in
   * a screen that has already fallen back.
   */
  it('logs the reason, which the state cannot carry', async () => {
    const { result } = renderHook(() => useSellerSession());

    await vi.waitFor(() => expect(deskOf(result.current.state)).toBe('unresolved'));
    expect(warned).toHaveBeenCalledTimes(1);
    expect(warned.mock.calls[0]?.[1]).toBeInstanceOf(ApiError);
  });

  /* Observable to a person, not only to a test. */
  it('tells the masthead so, beside the account it did resolve', async () => {
    render(<SignIn />);

    const pill = await screen.findByText('Demo desk');
    expect(pill.getAttribute('title')).toMatch(/shared demo desk rather than yours/i);
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });
});

/*
 * The warning has to stay rare to stay readable. `resolving` is the state every single sign-in
 * passes through, and flashing a warning there would teach a reader to ignore the colour — the
 * reason `demo-reset.mjs` reports invented addresses rather than degrading on them.
 */
describe('the masthead on an ordinary sign-in', () => {
  it('says nothing about the desk at all', async () => {
    render(<SignIn />);

    await vi.waitFor(() => expect(buyerId()).toBe(BUYER.id));
    expect(screen.queryByText('Demo desk')).toBeNull();
  });
});
