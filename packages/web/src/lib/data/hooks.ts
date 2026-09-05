'use client';

/**
 * Reading the market from a component.
 *
 * Three states, and every screen handles all three. There is no fourth state where a
 * number is shown that nobody stands behind — a screen either has the venue's figures, is
 * waiting for them, or says in words why it does not have them.
 *
 * Against the demo book the first state is skipped entirely: the data is already in the
 * process, so the hook starts `ready` on the very first render. That keeps the server's
 * HTML and the browser's first paint identical, which is what the frozen clock in
 * `fixtures.ts` was for in the first place.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { SELLER_ID } from '@/lib/api/config';
import { sellerId, subscribe } from '@/lib/api/identity';

import {
  confirmationIfImmediate,
  loadConfirmation,
  loadMarket,
  loadProof,
  marketIfImmediate,
  proofIfImmediate,
  type ConfirmationRecord,
  type Market,
  type ProofRecord,
} from './index';

export type Async<T> =
  { status: 'loading' } | { status: 'ready'; data: T } | { status: 'failed'; error: unknown };

export type AsyncResource<T> = Async<T> & { reload: () => void };

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError';

function useAsyncResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  /** Already in hand — the demo book. `null` means it has to be fetched. */
  immediate: { value: T } | null,
): AsyncResource<T> {
  const [state, setState] = useState<Async<T>>(() =>
    immediate === null ? { status: 'loading' } : { status: 'ready', data: immediate.value },
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (immediate !== null) {
      setState({ status: 'ready', data: immediate.value });
      return;
    }

    const controller = new AbortController();
    let live = true;
    setState({ status: 'loading' });

    load(controller.signal).then(
      (data) => {
        if (live) setState({ status: 'ready', data });
      },
      (error: unknown) => {
        if (live && !isAbort(error)) setState({ status: 'failed', error });
      },
    );

    return () => {
      live = false;
      controller.abort();
    };
  }, [load, immediate, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  return useMemo(() => ({ ...state, reload }), [state, reload]);
}

/**
 * Whose book is being read, as a value a render can depend on.
 *
 * The identity lives in a module rather than in React, because the data layer is plain async
 * code called from hooks rather than a component. That is fine for reading it and useless for
 * *reacting* to it, which is what this bridges: signing in changes the module's answer, and
 * nothing would re-render or re-fetch without a subscription.
 *
 * The server snapshot is deliberately the configured seller. There is no session on the
 * server, so that is what it rendered, and returning anything else here would be a hydration
 * mismatch dressed up as a fresh value.
 */
function useCurrentSeller(): string {
  return useSyncExternalStore(subscribe, sellerId, () => SELLER_ID);
}

/** The whole market: the book, the curve, the mandates, and a price against every row. */
export function useMarket(): AsyncResource<Market> {
  const seller = useCurrentSeller();
  /*
   * `loadMarket` reads the current seller itself, so `seller` is not passed to it — it is
   * named here because that is what makes the fetch re-run when someone signs in or out.
   * Without it the identity would change and the screen would keep showing the previous
   * seller's book until the next navigation, which is the whole feature failing silently.
   */
  const load = useCallback((signal: AbortSignal) => loadMarket(signal), [seller]);
  const immediate = useMemo(() => marketIfImmediate(), []);
  return useAsyncResource(load, immediate);
}

/** What one customer is being asked to acknowledge. Never carries a price. */
export function useConfirmation(token: string): AsyncResource<ConfirmationRecord | null> {
  const load = useCallback((signal: AbortSignal) => loadConfirmation(token, signal), [token]);
  const immediate = useMemo(() => confirmationIfImmediate(token), [token]);
  return useAsyncResource(load, immediate);
}

export function useProof(tradeId: string): AsyncResource<ProofRecord | null> {
  const load = useCallback((signal: AbortSignal) => loadProof(tradeId, signal), [tradeId]);
  const immediate = useMemo(() => proofIfImmediate(tradeId), [tradeId]);
  return useAsyncResource(load, immediate);
}
