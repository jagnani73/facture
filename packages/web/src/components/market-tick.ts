'use client';

import { useEffect, useState } from 'react';

/**
 * One timer for the whole page.
 *
 * Every live price on screen is reading the same curve, so they should move on
 * the same beat rather than each running its own interval. Subscribers get the
 * tick count; the first render is always tick 0 so the server's HTML and the
 * browser's first paint agree and hydration is quiet.
 *
 * THROWAWAY: `driftBps` stands in for a curve that actually moves. It goes when
 * mandates are live and the curve moves because a funder changed their bid.
 */

const INTERVAL_MS = 4000;

let tick = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<(value: number) => void>();

function ensureTimer(): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    tick += 1;
    for (const listener of listeners) listener(tick);
  }, INTERVAL_MS);
}

export function useMarketTick(enabled = true): number {
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    // Adopt the running count so a late-mounting cell is in step with the rest.
    setValue(tick);
    listeners.add(setValue);
    ensureTimer();

    return () => {
      listeners.delete(setValue);
      if (listeners.size === 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, [enabled]);

  return value;
}

/** Deterministic per-seed, per-tick wobble in basis points. Zero at tick 0. */
export function driftBps(seed: string, currentTick: number, amplitude = 6): number {
  if (currentTick === 0) return 0;

  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  const wave = Math.sin((Math.abs(hash) % 997) + currentTick * 1.37) * 43758.5453;
  const fraction = wave - Math.floor(wave);
  return Math.round((fraction * 2 - 1) * amplitude);
}
