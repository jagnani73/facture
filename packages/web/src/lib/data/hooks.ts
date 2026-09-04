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

import { useCallback, useEffect, useMemo, useState } from 'react';

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

/** The whole market: the book, the curve, the mandates, and a price against every row. */
export function useMarket(): AsyncResource<Market> {
  const load = useCallback((signal: AbortSignal) => loadMarket(signal), []);
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
