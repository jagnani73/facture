/**
 * Offering an invoice for sale, and taking the offer back.
 *
 * The venue made listing a real act: `confirmed` is priced, `listed` is for sale, and arming
 * a trade against anything but the second is refused. Two things on this side of the seam
 * can be wrong about that in ways `tsc` cannot see, and both are here.
 *
 * **The decoder.** `listed` is what the caller acts on, so it is read strictly — a response
 * that does not say whether the invoice is on the book must raise `unreadable` naming the
 * field rather than default to a boolean that reads like an answer. The routes also disagree
 * about the name of the idempotent flag (`alreadyListed` on one, `alreadyDelisted` on the
 * other), which is exactly the sort of asymmetry a decoder silently gets half right.
 *
 * **The 200 that did not do the thing.** A venue answering `{ listed: false }` to a list
 * request has accepted the call and not performed it. Reporting that as a standing offer
 * would tell a seller their invoice is for sale and let them find out otherwise at the point
 * of sale, which is the last place anyone wants to learn it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { usingApiMock } = vi.hoisted(() => ({ usingApiMock: vi.fn(() => true) }));

vi.mock('@/lib/api/client', () => ({
  api: { listInvoice: vi.fn(), delistInvoice: vi.fn() },
}));

/*
 * `usingApi` lives in `@/lib/api/config`, not the client. Mocking the wrong module leaves the
 * demo branch running and every assertion below passes against a note nobody wrote.
 */
vi.mock('@/lib/api/config', () => ({ DATA_SOURCE: 'api', usingApi: usingApiMock }));

import { api } from '@/lib/api/client';
import { readInvoiceListing } from '@/lib/api/contract';
import { ApiError } from '@/lib/api/problem';
import { delistInvoice, listInvoice } from '@/lib/data';

const INVOICE_ID = '9f1c6f1e-0000-4000-8000-000000000001';

/** `POST /v1/invoices/:id/list`, as `routes/invoices.ts` renders it. */
const listed = {
  invoice: { id: INVOICE_ID, status: 'listed' },
  listed: true,
  alreadyListed: false,
  message: 'This invoice is on the book and can be sold at the price beside it.',
};

/** `POST /v1/invoices/:id/delist`, which uses the other spelling of the idempotent flag. */
const delisted = {
  invoice: { id: INVOICE_ID, status: 'confirmed' },
  listed: false,
  alreadyDelisted: false,
  message: 'This invoice is off the book.',
};

beforeEach(() => {
  usingApiMock.mockReturnValue(true);
  vi.mocked(api.listInvoice).mockReset();
  vi.mocked(api.delistInvoice).mockReset();
});

/* ── the decoder ─────────────────────────────────────────────────────────────────────── */

describe('readInvoiceListing', () => {
  it('reads the listing state and the venue’s own sentence', () => {
    expect(readInvoiceListing(listed)).toEqual({
      listed: true,
      unchanged: false,
      message: listed.message,
    });
  });

  /* Both routes answer the same shape under two names, and a decoder that knew only one
     would report every repeated delisting as a fresh withdrawal. */
  it('reads either spelling of the idempotent flag', () => {
    expect(readInvoiceListing({ ...listed, alreadyListed: true }).unchanged).toBe(true);
    expect(readInvoiceListing({ ...delisted, alreadyDelisted: true }).unchanged).toBe(true);
    expect(readInvoiceListing(delisted).unchanged).toBe(false);
  });

  /*
   * The decoder rule, at the field the screen turns on. A missing `listed` defaulting to
   * `false` would read as "not on the book" and hide a listing that happened; defaulting to
   * `true` would claim one that did not.
   */
  it('refuses to guess whether the invoice is on the book', () => {
    expect(() => readInvoiceListing({ message: 'ok' })).toThrowError(ApiError);
    try {
      readInvoiceListing({ message: 'ok' });
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('unreadable');
      expect((error as ApiError).detail).toContain('listing.listed');
    }
  });

  it('refuses a listing state that is not a boolean', () => {
    expect(() => readInvoiceListing({ ...listed, listed: 'yes' })).toThrowError(ApiError);
  });

  /* A venue that stops sending the sentence has not failed; the caller writes its own. */
  it('treats the sentence as optional', () => {
    expect(readInvoiceListing({ listed: true, alreadyListed: false }).message).toBeNull();
  });
});

/* ── offering it ─────────────────────────────────────────────────────────────────────── */

describe('listInvoice', () => {
  it('offers the invoice and reports the venue’s sentence', async () => {
    vi.mocked(api.listInvoice).mockResolvedValue(readInvoiceListing(listed));

    const outcome = await listInvoice(INVOICE_ID);

    expect(api.listInvoice).toHaveBeenCalledWith(INVOICE_ID);
    expect(outcome).toEqual({ ok: true, value: undefined, note: listed.message });
  });

  it('says so when the venue wrote nothing because it was already offered', async () => {
    vi.mocked(api.listInvoice).mockResolvedValue({
      listed: true,
      unchanged: true,
      message: null,
    });

    const outcome = await listInvoice(INVOICE_ID);

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.note).toContain('already');
  });

  /*
   * The venue took the request and did not perform it. Not a success with a caveat: the
   * seller is deciding whether their receivable is for sale, and "yes" is the answer that
   * has to be earned.
   */
  it('reports a 200 that left the invoice off the book as a refusal', async () => {
    vi.mocked(api.listInvoice).mockResolvedValue({
      listed: false,
      unchanged: false,
      message: null,
    });

    const outcome = await listInvoice(INVOICE_ID);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('not on the book');
  });

  /*
   * The commonest refusal, and the reason this control exists at all: the venue will not
   * list what a customer has not confirmed. It arrives as a sentence, and the sentence is
   * the venue's rather than a paraphrase of a status code.
   */
  it('passes the venue’s refusal through in words', async () => {
    vi.mocked(api.listInvoice).mockRejectedValue(
      new ApiError({
        code: 'invoice_not_confirmed',
        status: 409,
        title: 'Conflict',
        detail: 'Your customer has not confirmed this invoice yet.',
      }),
    );

    const outcome = await listInvoice(INVOICE_ID);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe(
      'Your customer has not confirmed this invoice yet.',
    );
  });

  /* Nothing is asked of the venue against the demo book, and no note may imply otherwise. */
  it('moves nothing against the demo book, and says so', async () => {
    usingApiMock.mockReturnValue(false);

    const outcome = await listInvoice(INVOICE_ID);

    expect(api.listInvoice).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.note).toContain('Nothing moved');
  });
});

/* ── taking it back ──────────────────────────────────────────────────────────────────── */

describe('delistInvoice', () => {
  it('withdraws the offer and reports the venue’s sentence', async () => {
    vi.mocked(api.delistInvoice).mockResolvedValue(readInvoiceListing(delisted));

    const outcome = await delistInvoice(INVOICE_ID);

    expect(api.delistInvoice).toHaveBeenCalledWith(INVOICE_ID);
    expect(outcome).toEqual({ ok: true, value: undefined, note: delisted.message });
  });

  /*
   * The guard that makes `confirmed -> sold` unreachable. The venue refuses to take an offer
   * off the book underneath a payment in flight, and it names the trade — which is the only
   * thing a seller can act on, so it is passed through whole.
   */
  it('reports the armed-trade refusal with the trade the venue named', async () => {
    const detail =
      'A buyer has armed a trade against this invoice and is settling it ' +
      '(trade 9f1c6f1e-0000-4000-8000-000000000t11). Unwind the trade first.';
    vi.mocked(api.delistInvoice).mockRejectedValue(
      new ApiError({ code: 'conflict', status: 409, title: 'Conflict', detail }),
    );

    const outcome = await delistInvoice(INVOICE_ID);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain(
      '9f1c6f1e-0000-4000-8000-000000000t11',
    );
  });

  /* The mirror of the list case: a 200 that left the offer standing is not a withdrawal. */
  it('reports a 200 that left the invoice on the book as a refusal', async () => {
    vi.mocked(api.delistInvoice).mockResolvedValue({
      listed: true,
      unchanged: false,
      message: null,
    });

    const outcome = await delistInvoice(INVOICE_ID);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('still on the book');
  });

  it('moves nothing against the demo book, and says so', async () => {
    usingApiMock.mockReturnValue(false);

    const outcome = await delistInvoice(INVOICE_ID);

    expect(api.delistInvoice).not.toHaveBeenCalled();
    expect(outcome.ok && outcome.note).toContain('Nothing moved');
  });
});
