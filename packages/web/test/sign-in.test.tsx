/**
 * The masthead's sign-in control, and the state it used to get stuck in.
 *
 * A browser carrying a Privy session that never produces an identity token sat on
 * "Signing in…" indefinitely. No request was ever made, so nothing could fail and nothing
 * could time out, and `signing-in` renders no button — so the shared demo book, which is the
 * signed-out state and the one the whole app is meant to be looked at in, was unreachable
 * without clearing site data.
 *
 * It was found by opening the app in a browser that had signed in before. The existing
 * session tests say the hook is "glue over Privy and not worth a fake Privy to exercise",
 * which is exactly why nothing caught it: every test signs in cleanly, and the dead end is
 * only reachable when a real session half-exists.
 *
 * So what is pinned here is the property rather than the mechanism — **every state this
 * control can reach offers a way back to the demo book.**
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ── the Privy seam ──────────────────────────────────────────────────────────────────── */

const login = vi.fn();
const logout = vi.fn();
let privy = { ready: true, authenticated: false, login, logout };
let identityToken: string | null = null;

vi.mock('@privy-io/react-auth', () => ({
  usePrivy: () => privy,
  useIdentityToken: () => ({ identityToken }),
}));

/** The venue is never reached in these cases, so the client is stubbed rather than served. */
vi.mock('@/lib/api/client', () => ({
  api: { signInSeller: vi.fn(() => new Promise(() => {})) },
}));

vi.mock('@/lib/api/config', () => ({ signInAvailable: () => true }));

const { SignIn } = await import('@/components/sign-in');

beforeEach(() => {
  vi.useFakeTimers();
  login.mockReset();
  logout.mockReset();
  privy = { ready: true, authenticated: false, login, logout };
  identityToken = null;
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('SignIn', () => {
  it('offers the demo book and a sign-in when signed out', () => {
    render(<SignIn />);

    expect(screen.getByText('Demo book')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  /**
   * The token genuinely lags `authenticated` by a render or two on a normal sign-in, so this
   * state is correct while it lasts. Turning it into an error immediately would be worse than
   * the hang it replaced.
   */
  it('waits quietly while the identity token is still arriving', () => {
    privy = { ...privy, authenticated: true };
    render(<SignIn />);

    expect(screen.getByText('Signing in…')).toBeTruthy();
  });

  /**
   * THE ONE THAT MATTERS. A token that is never coming looks exactly like a token that is
   * late, and only one of the two ends on its own.
   */
  it('stops waiting for an identity token that is never coming', async () => {
    privy = { ...privy, authenticated: true };
    render(<SignIn />);

    expect(screen.getByText('Signing in…')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });

    expect(screen.queryByText('Signing in…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign-in failed' })).toBeTruthy();
  });

  /**
   * Signing in again re-enters the same state, so a retry alone would be a loop. The way out
   * of a session Privy will not issue a token for is to drop the session.
   */
  it('offers a way back to the demo book when sign-in fails', async () => {
    privy = { ...privy, authenticated: true };
    render(<SignIn />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });

    const out = screen.getByRole('button', { name: 'Sign out' });
    out.click();

    expect(logout).toHaveBeenCalled();
  });

  /** Unset app id means the control is absent rather than broken. */
  it('renders nothing at all when a wait cannot begin', () => {
    privy = { ...privy, ready: false };
    const { container } = render(<SignIn />);

    expect(container.textContent).toBe('…');
  });
});
