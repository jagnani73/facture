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

const listButton = () => screen.queryByRole('button', { name: /^offer it for sale$/i });
const relistButton = () => screen.queryByRole('button', { name: /offer it for sale again/i });
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

  it('offers nothing against sold paper whose instrument never landed', () => {
    const { container } = offer('sold', { issuance: 'failed' });
    expect(container.firstChild).toBeNull();
  });

  /*
   * `sold` used to be on this list, because relisting was refused outright. It is a resale
   * now and has its own suite below. What is left here is paper with no listing decision in
   * it at all: two statuses that are the customer's business rather than the seller's, and
   * three that are finished.
   */
  it.each<InvoiceStatus>(['draft', 'awaiting_confirmation', 'matured', 'disputed', 'defaulted'])(
    'offers nothing against a %s invoice',
    (status) => {
      const { container } = offer(status);
      expect(container.firstChild).toBeNull();
    },
  );
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

  /*
   * The copy used to say the invoice "stays confirmed and keeps its price", which stopped
   * being true when the venue learned to relist: withdrawing a resale returns the invoice to
   * `sold`, and `sold` is not quotable, so it keeps neither. There is no flag on `Invoice`
   * saying which of the two this is and none was invented — the copy names both outcomes,
   * and what is pinned here is that it does, in a component that cannot tell them apart.
   */
  it('says where withdrawing puts it, in both of the two places it can go', () => {
    offer('listed');

    const said = screen.getByText(/goes back to what it was before the offer/i);
    expect(said.textContent).toMatch(/confirmed if nobody has bought it/i);
    expect(said.textContent).toMatch(/held by its buyer if somebody has/i);
    expect(screen.queryByText(/stays confirmed and keeps its price/i)).toBeNull();
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

/* ── a sold invoice: the resale ──────────────────────────────────────────────────────── */

/**
 * The secondary market, from the only screen that can start one.
 *
 * `sold` rendered nothing here until the venue learned to perform `sold -> listed`, and the
 * change is one branch rather than a second control: the same `POST /v1/invoices/:id/list`
 * carries both edges, so what is asserted first is that no new call was invented for it.
 *
 * The rest is the honesty of the copy. A resale is signed by whoever holds the paper now, and
 * whether the venue holds that key is not a fact about the invoice — so this is the one place
 * in this component where the button can be refused with nothing on screen having predicted
 * it, and the seller is owed both halves of that: what a resale is worth, and who it belongs
 * to.
 */
describe('a sold invoice', () => {
  it('offers the resale, and nothing that would withdraw an offer nobody made', () => {
    offer('sold');

    expect(relistButton()).not.toBeNull();
    expect(withdrawButton()).toBeNull();
  });

  /*
   * The reason a resale is worth making, and it is the same reason a buyer bids tighter on
   * day zero. Seasoned paper is shorter paper: the same standing bids pay more for it than
   * they did, because less of the wait is left.
   */
  it('says why the same bids price it tighter than they did', () => {
    offer('sold');

    const said = screen.getByText(/same standing bids/i);
    expect(said.textContent).toMatch(/less of the wait is left/i);
    expect(said.textContent).toMatch(/price it tighter/i);
  });

  /*
   * Whose decision it is. The reader of this screen is the original seller, and after a sale
   * they are not the holder — so copy addressed to them as the owner would be describing
   * somebody else's paper. The refusal the venue can raise is named in the same breath,
   * because it is the one this component cannot rule out before the click.
   */
  it('says the offer is the holder’s, and that the venue needs their key to make it', () => {
    offer('sold');

    const said = screen.getByText(/the offer is the holder/i);
    expect(said.textContent).toMatch(/rather than yours/i);
    expect(said.textContent).toMatch(/holds their key/i);
  });

  it('relists through the listing call, then re-reads the book', async () => {
    offer('sold');
    fireEvent.click(relistButton() as HTMLElement);

    await waitFor(() => expect(screen.getByText('On the book.')).toBeTruthy());
    expect(listInvoice).toHaveBeenCalledWith(INVOICE_ID);
    expect(delistInvoice).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  /*
   * The refusal that has no button-shaped equivalent: the venue holds no key for the current
   * holder, so the resale it would have to sign is not the venue's to sign. It arrives as a
   * sentence after the click, and it is shown rather than paraphrased.
   */
  it('shows the venue refusing a resale it cannot sign, and does not re-read the book', async () => {
    vi.mocked(listInvoice).mockResolvedValue({
      ok: false,
      reason:
        'This paper is held by Ashgrove Credit, and the venue holds no key for them. A resale ' +
        'is signed by the holder, so they would have to offer it themselves.',
    });

    offer('sold');
    fireEvent.click(relistButton() as HTMLElement);

    await waitFor(() => expect(screen.getByText(/holds no key for them/i)).toBeTruthy());
    expect(onChanged).not.toHaveBeenCalled();
  });
});
