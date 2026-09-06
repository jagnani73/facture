/**
 * The control that crosses a seller from priced to for sale.
 *
 * Confirmed and listed are different permissions at the venue — the first is quotable, the
 * second is sellable — and the whole risk in this component is offering a button for a
 * decision the venue has already refused. Every branch below is one of those refusals, and
 * each renders nothing rather than something disabled with an apology on it.
 *
 * The other half is the boundary that must not move: **listing is the seller's act.** A sale
 * that quietly listed first would collapse the distinction the venue just built, so what is
 * asserted here is which call each button makes, and that a refused call leaves the book
 * unread rather than triggering a re-read that would report the same thing back.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Invoice, InvoiceStatus } from '@/lib/domain';

vi.mock('@/lib/data', () => ({
  listInvoice: vi.fn(),
  delistInvoice: vi.fn(),
}));

import { delistInvoice, listInvoice } from '@/lib/data';
import { OfferControl } from '@/components/offer-control';

const INVOICE_ID = '9f1c6f1e-0000-4000-8000-000000000001';

const invoice = (status: InvoiceStatus): Invoice => ({
  id: INVOICE_ID,
  sellerId: '9f1c6f1e-0000-4000-8000-0000000005e1',
  debtorId: '9f1c6f1e-0000-4000-8000-00000000debt',
  faceValue: 4_000_000n,
  currency: 'USD',
  invoiceNumber: 'MF-2041',
  issuedAt: '2026-08-31T00:00:00.000Z',
  dueAt: '2026-10-31T00:00:00.000Z',
  status,
  uniquenessHash: '0xabc',
  instrumentAddress: '0x9cb3468607a359c214cb27159d5d5853d5e83877',
  isin: 'USQ72738QUM6',
});

const onChanged = vi.fn();

const offer = (
  status: InvoiceStatus,
  over: { armed?: boolean; issuance?: 'issued' | 'pending' | 'failed' } = {},
) =>
  render(
    <OfferControl
      invoice={invoice(status)}
      issuance={over.issuance ?? 'issued'}
      armed={over.armed ?? false}
      onChanged={onChanged}
    />,
  );

const listButton = () => screen.queryByRole('button', { name: /offer it for sale/i });
const withdrawButton = () => screen.queryByRole('button', { name: /take it off the book/i });

beforeEach(() => {
  onChanged.mockReset();
  vi.mocked(listInvoice).mockReset();
  vi.mocked(delistInvoice).mockReset();
  vi.mocked(listInvoice).mockResolvedValue({ ok: true, value: undefined, note: 'On the book.' });
  vi.mocked(delistInvoice).mockResolvedValue({ ok: true, value: undefined, note: 'Off the book.' });
});

afterEach(cleanup);

/* ── every reason this offers nothing ────────────────────────────────────────────────── */

describe('when there is no listing decision to make', () => {
  /*
   * Listing requires a deployed security, because paper has to be deliverable before it can
   * be offered. The invoice page says so in its own words directly below this control, so a
   * disabled button here would say it a second time and invite a click at it.
   */
  it('offers nothing while the instrument is still being deployed', () => {
    const { container } = offer('confirmed', { issuance: 'pending' });
    expect(container.firstChild).toBeNull();
  });

  it('offers nothing when issuance failed', () => {
    const { container } = offer('confirmed', { issuance: 'failed' });
    expect(container.firstChild).toBeNull();
  });

  /*
   * `sold` is the interesting one. Relisting seasoned paper is the secondary market and the
   * venue refuses it outright, because the holder rather than the original seller would be
   * the one offering it.
   */
  it.each<InvoiceStatus>([
    'draft',
    'awaiting_confirmation',
    'sold',
    'matured',
    'disputed',
    'defaulted',
  ])('offers nothing against a %s invoice', (status) => {
    const { container } = offer(status);
    expect(container.firstChild).toBeNull();
  });
});

/* ── a confirmed invoice ─────────────────────────────────────────────────────────────── */

describe('a confirmed invoice', () => {
  it('offers listing, and nothing that would sell it', () => {
    offer('confirmed');

    expect(listButton()).not.toBeNull();
    expect(withdrawButton()).toBeNull();
    /*
     * The 409 this control exists to prevent. Arming a trade requires `listed`, so a Sell
     * button here would be a refusal with a price beside it — and the seller would have no
     * way to do the thing the refusal asks of them.
     */
    expect(screen.queryByRole('button', { name: /sell/i })).toBeNull();
  });

  it('says the price is not an offer anybody has accepted', () => {
    offer('confirmed');
    expect(screen.getByText(/not for sale until you offer it/i)).toBeTruthy();
  });

  it('lists on the venue, then re-reads the book', async () => {
    offer('confirmed');
    fireEvent.click(listButton() as HTMLElement);

    await waitFor(() => expect(screen.getByText('On the book.')).toBeTruthy());
    expect(listInvoice).toHaveBeenCalledWith(INVOICE_ID);
    expect(delistInvoice).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  /*
   * A refusal changed nothing, so re-reading the book would spend a request to be told the
   * same thing — and would replace the reason on screen with a page that looks untouched.
   */
  it('shows a refusal and does not re-read the book', async () => {
    vi.mocked(listInvoice).mockResolvedValue({
      ok: false,
      reason: 'Your customer has not confirmed this invoice yet.',
    });

    offer('confirmed');
    fireEvent.click(listButton() as HTMLElement);

    await waitFor(() =>
      expect(screen.getByText('Your customer has not confirmed this invoice yet.')).toBeTruthy(),
    );
    expect(onChanged).not.toHaveBeenCalled();
  });
});

/* ── a listed invoice ────────────────────────────────────────────────────────────────── */

describe('a listed invoice', () => {
  it('offers the way back off the book, not the way on to it', () => {
    offer('listed');

    expect(withdrawButton()).not.toBeNull();
    expect(listButton()).toBeNull();
  });

  it('says withdrawing costs the offer and not the price', () => {
    offer('listed');
    expect(screen.getByText(/stays confirmed and keeps its price/i)).toBeTruthy();
  });

  it('withdraws on the venue, then re-reads the book', async () => {
    offer('listed');
    fireEvent.click(withdrawButton() as HTMLElement);

    await waitFor(() => expect(screen.getByText('Off the book.')).toBeTruthy());
    expect(delistInvoice).toHaveBeenCalledWith(INVOICE_ID);
    expect(listInvoice).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  /*
   * The guard that makes `confirmed -> sold` unreachable rather than merely unusual. The
   * venue refuses to withdraw an offer with a trade armed against it, so the button is not
   * offered — and the reason it is not there is stated, because a seller looking for it is
   * owed the way out, which is unwinding the trade.
   */
  it('does not offer withdrawal while a buyer is settling against it', () => {
    offer('listed', { armed: true });

    expect(withdrawButton()).toBeNull();
    expect(screen.getByText(/cannot be taken back/i)).toBeTruthy();
    expect(screen.getByText(/unwind the trade/i)).toBeTruthy();
  });
});
