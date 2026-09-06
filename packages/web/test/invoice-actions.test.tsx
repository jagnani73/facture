/**
 * What the invoice screen lets a seller do, and what it must not.
 *
 * The control itself is covered in `offer-control.test.tsx`; what is pinned here is the
 * wiring around it, which is where the 409 actually lived. The venue now refuses to arm a
 * trade against anything but a `listed` invoice, and this screen is the only place a seller
 * would press Sell — so a Sell button beside a confirmed invoice is a refusal with a price
 * next to it, and no way on screen to do the thing the refusal asks for.
 *
 * Rendered against the demo book, which is real data rather than a fixture written for this
 * file: it carries both statuses on purpose, so the two cases below are the book as shipped.
 *
 * The armed case is the one thing the book has no row for, and it is the case where being
 * wrong is expensive: withdrawing an offer underneath a payment already in flight is how a
 * confirmed invoice would end up marked sold. So the trade is substituted rather than
 * invented into the fixtures, and what is asserted is that this screen reads the trade's
 * settlement state rather than assuming nobody is mid-settlement.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { held } = vi.hoisted(() => ({ held: { market: null as unknown } }));

vi.mock('@/lib/data/hooks', () => ({ useMarket: () => held.market }));

import { readTrade } from '@/lib/api/contract';
import type { Market } from '@/lib/data';
import { fixtureMarket } from '@/lib/data/fixture-source';
import { InvoiceDetailView } from '@/components/views/invoice-detail-view';

/** The demo book's two open statuses, both priced. */
const CONFIRMED = 'INV-2041';
const LISTED = 'INV-2038';

/** Held on Hedera, cash leg unsigned — the venue's own definition of an armed trade. */
const armedTrade = readTrade({
  id: '9f1c6f1e-0000-4000-8000-000000000t11',
  invoiceId: LISTED,
  mandateId: 'MND-01',
  sellerId: 'SEL-MERIDIAN',
  buyerId: 'BUY-ASHGROVE',
  faceValue: '12840000',
  annualisedYieldBps: 800,
  tenorDays: 30,
  discountMinor: '84000',
  proceedsMinor: '12756000',
  currency: 'USD',
  status: 'awaiting_payment',
  createdAt: '2026-09-01T10:00:00.000Z',
  assetLeg: { state: 'held', chain: 'hedera-testnet' },
  cashLeg: { state: 'pending', chain: 'arc-testnet' },
});

const show = (invoiceId: string, market: Market = fixtureMarket()) => {
  held.market = { status: 'ready', data: market, reload: vi.fn() };
  return render(<InvoiceDetailView invoiceId={invoiceId} />);
};

const sellButton = () => screen.queryByRole('button', { name: /^sell for/i });
const listButton = () => screen.queryByRole('button', { name: /offer it for sale/i });
const withdrawButton = () => screen.queryByRole('button', { name: /take it off the book/i });

beforeEach(() => {
  held.market = null;
});

afterEach(cleanup);

describe('a confirmed invoice', () => {
  /*
   * The defect this whole change exists to fix. Sell used to be the only action on this
   * screen, and against the live venue it answered 409 for every invoice the seller had not
   * offered — which was all of them, because nothing could offer one.
   */
  it('is led to listing rather than to a sale', () => {
    show(CONFIRMED);

    expect(listButton()).not.toBeNull();
    expect(sellButton()).toBeNull();
    expect(withdrawButton()).toBeNull();
  });

  /* Quotability did not change with any of this: the price is there the moment it loads. */
  it('still carries its price', () => {
    show(CONFIRMED);
    expect(screen.getByText('Proceeds to you')).toBeTruthy();
  });
});

describe('a listed invoice', () => {
  it('is the one a seller can actually sell', () => {
    show(LISTED);

    expect(sellButton()).not.toBeNull();
    expect(listButton()).toBeNull();
  });

  it('can be taken back off the book while nobody is settling against it', () => {
    show(LISTED);
    expect(withdrawButton()).not.toBeNull();
  });

  /*
   * The armed trade is added to the book's trades rather than handed back by
   * `tradeForInvoice`, because that accessor is not what the screen asks. It answers "which
   * trade does this invoice's card describe" and prefers a settled one — so an invoice
   * carrying an abandoned attempt beside a live one would report nobody was settling. The
   * screen scans them all, which is what the venue's own guard does.
   */
  it('cannot be withdrawn while a buyer is settling against it', () => {
    const book = fixtureMarket();
    show(LISTED, { ...book, trades: [...book.trades, armedTrade] });

    expect(withdrawButton()).toBeNull();
    expect(screen.getByText(/cannot be taken back/i)).toBeTruthy();
    // Selling is still offered: the venue's guard is on withdrawal, not on the sale.
    expect(sellButton()).not.toBeNull();
  });

  /*
   * The hole the scan closes, stated as a case: an unwound attempt is more recent than the
   * live one, so the accessor that heads the trade card would hand back the unwound trade.
   * Withdrawing here would be refused by the venue with a payment already in flight.
   */
  it('sees a live trade even when a later attempt was abandoned', () => {
    const book = fixtureMarket();
    const abandoned = {
      ...armedTrade,
      id: 'TRD-ABANDONED',
      status: 'unwound' as const,
      executedAt: '2026-09-01T11:00:00.000Z',
    };
    show(LISTED, { ...book, trades: [...book.trades, armedTrade, abandoned] });

    expect(withdrawButton()).toBeNull();
  });
});
