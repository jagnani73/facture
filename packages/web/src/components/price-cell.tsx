'use client';

import { useEffect, useRef, useState } from 'react';

import type { MinorUnits } from '@/lib/domain';
import { priceInvoice } from '@/lib/domain';
import { formatMoney, formatRate } from '@/lib/format';
import { driftBps, useMarketTick } from './market-tick';

/**
 * The live price.
 *
 * This is the product. It is not a button that fetches a quote — the number is
 * simply there, and it moves, because the standing bids behind it move and the
 * due date keeps getting closer. A seller should be able to leave this screen
 * open and watch what their book is worth.
 *
 * When no mandate will take the invoice it says so in words and names the
 * nearest miss, because "no price" with no reason is the thing this market
 * exists to stop happening.
 */

export interface PriceCellProps {
  /** Seeds the drift so each row moves independently but reproducibly. */
  seed: string;
  faceValue: MinorUnits;
  tenorDays: number;
  /** Tightest standing bid that will take this invoice, or null for no bid. */
  bestRateBps: number | null;
  /**
   * The proceeds the venue itself quoted, where a venue quoted them.
   *
   * Preferred over re-deriving from `faceValue` and `bestRateBps` whenever the rate on
   * screen is the rate the venue named. Both routes go through the same shared pricer and
   * agree to the cent today, but a market with two opinions about its own price has one too
   * many — so the venue's figure is the one rendered, and the local pricer is what draws the
   * demo book's wobble between ticks.
   */
  quotedProceeds?: MinorUnits | undefined;
  takers: number;
  /** Why nobody is bidding, in one clause. Only read when `bestRateBps` is null. */
  noBidReason?: string | undefined;
  size?: 'row' | 'hero' | undefined;
  live?: boolean | undefined;
}

export function PriceCell({
  seed,
  faceValue,
  tenorDays,
  bestRateBps,
  quotedProceeds,
  takers,
  noBidReason,
  size = 'row',
  live = true,
}: PriceCellProps) {
  const tick = useMarketTick(live && bestRateBps !== null);
  const hero = size === 'hero';

  if (bestRateBps === null) {
    return (
      <div className={hero ? '' : 'text-right'}>
        <div className={`text-muted ${hero ? 'font-serif text-2xl' : 'text-sm'}`}>No bid</div>
        <div className="mt-1 text-xs text-faint">
          {noBidReason ?? 'No standing bid reaches this invoice'}
        </div>
      </div>
    );
  }

  const rateBps = Math.max(1, bestRateBps + driftBps(seed, tick));
  const proceeds =
    rateBps === bestRateBps && quotedProceeds !== undefined
      ? quotedProceeds
      : priceInvoice(faceValue, rateBps, tenorDays).proceeds;

  return (
    <LivePrice
      proceeds={proceeds}
      rateBps={rateBps}
      baseRateBps={bestRateBps}
      takers={takers}
      hero={hero}
    />
  );
}

function LivePrice({
  proceeds,
  rateBps,
  baseRateBps,
  takers,
  hero,
}: {
  proceeds: MinorUnits;
  rateBps: number;
  baseRateBps: number;
  takers: number;
  hero: boolean;
}) {
  const previous = useRef(proceeds);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);

  useEffect(() => {
    const before = previous.current;
    if (proceeds === before) return;
    setFlash(proceeds > before ? 'up' : 'down');
    previous.current = proceeds;
    const id = setTimeout(() => setFlash(null), 900);
    return () => clearTimeout(id);
  }, [proceeds]);

  const moved = rateBps - baseRateBps;
  const flashClass = flash === 'up' ? 'flash-up' : flash === 'down' ? 'flash-down' : '';

  return (
    <div className={hero ? '' : 'text-right'}>
      <div
        className={[
          'num rounded-xs leading-none',
          hero ? 'text-4xl font-medium tracking-tight' : 'text-[0.95rem] font-medium',
          flashClass,
        ].join(' ')}
        data-num
      >
        {formatMoney(proceeds)}
      </div>
      <div
        className={[
          'mt-1.5 flex items-baseline gap-1.5 text-xs text-muted',
          hero ? '' : 'justify-end',
        ].join(' ')}
      >
        <span className="num" data-num>
          {formatRate(rateBps)}
        </span>
        <span aria-hidden className="text-faint">
          ·
        </span>
        <span>
          {takers} {takers === 1 ? 'mandate' : 'mandates'} would take this
        </span>
        {moved !== 0 ? (
          <span
            aria-hidden
            title={`${moved > 0 ? 'Wider' : 'Tighter'} by ${Math.abs(moved)} bps since you opened this page`}
            className={`num ${moved < 0 ? 'text-pos' : 'text-neg'}`}
          >
            {moved < 0 ? '▾' : '▴'}
          </span>
        ) : null}
      </div>
    </div>
  );
}
