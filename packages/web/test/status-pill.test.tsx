/**
 * The pill, which is the only thing on the book that says where an invoice got to.
 *
 * Two axes cross here and they used to be one. Status is the seller's lifecycle; issuance is
 * tokenisation, and it has three states rather than two because `issued === false` covered
 * both "still being added" and "nobody is coming". The bug this file exists to keep out was
 * exactly that collapse: a failed issuance rendered as "Being added", pulsing, for as long as
 * anyone cared to look at it.
 *
 * So the cases below fix the crossing rather than the labels — which axis wins, and what the
 * losing one is allowed to still say.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { INVOICE_STATUSES, type Invoice } from '@/lib/domain';
import { StatusPill, explainStatus, issuanceDisplayOf, statusMeta } from '@/components/status-pill';

// `globals` is off, so React Testing Library's own auto-cleanup never registers.
afterEach(cleanup);

const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: '9f1c6f1e-0000-4000-8000-000000000001',
  sellerId: '9f1c6f1e-0000-4000-8000-0000000005e1',
  debtorId: '9f1c6f1e-0000-4000-8000-00000000debt',
  faceValue: 6_230_000n,
  currency: 'USD',
  invoiceNumber: 'MF-2051',
  issuedAt: '2026-08-01T00:00:00.000Z',
  dueAt: '2026-11-01T00:00:00.000Z',
  status: 'confirmed',
  uniquenessHash: '0xabc',
  ...over,
});

/** An invoice whose instrument actually landed: both halves, per `isIssued`. */
const ISSUED = {
  instrumentAddress: '0x9cb3468607a359c214cb27159d5d5853d5e83877',
  isin: 'USQ72738QUM6',
} as const;

describe('issuanceDisplayOf', () => {
  it('is issued once the instrument and its ISIN are both there', () => {
    expect(issuanceDisplayOf(invoice(ISSUED))).toBe('issued');
    expect(issuanceDisplayOf(invoice({ ...ISSUED, issuance: { state: 'issued' } }))).toBe('issued');
  });

  it('is pending while tokenisation is genuinely still on its way', () => {
    expect(issuanceDisplayOf(invoice())).toBe('pending');
    expect(issuanceDisplayOf(invoice({ issuance: { state: 'queued', attempts: 2 } }))).toBe(
      'pending',
    );
    expect(issuanceDisplayOf(invoice({ issuance: { state: 'issuing' } }))).toBe('pending');
  });

  /*
   * Half an instrument is not an instrument. `isIssued` wants the address and the ISIN
   * because a bond that cannot be named cannot be delivered.
   */
  it('is pending when only half the instrument arrived', () => {
    expect(issuanceDisplayOf(invoice({ instrumentAddress: ISSUED.instrumentAddress }))).toBe(
      'pending',
    );
    expect(issuanceDisplayOf(invoice({ isin: ISSUED.isin }))).toBe('pending');
  });

  it('is failed when issuance stopped and will not resume', () => {
    expect(issuanceDisplayOf(invoice({ issuance: { state: 'failed', attempts: 3 } }))).toBe(
      'failed',
    );
  });

  /*
   * The regression, stated as a rule. A failed issuance and a queued one both lack an
   * instrument, so anything reading `!isIssued` alone reports the first as the second.
   */
  it('reads a failed issuance as failed rather than as still being added', () => {
    const failed = invoice({ issuance: { state: 'failed', error: 'onlyValidISIN' } });
    expect(issuanceDisplayOf(failed)).not.toBe('pending');
    expect(statusMeta(failed.status, issuanceDisplayOf(failed)).label).toBe('Could not add');
  });

  /*
   * A failure that landed after the instrument did is still an instrument the venue holds,
   * and this ordering is what says so.
   */
  it('lets a failure override an instrument that is already on chain', () => {
    expect(issuanceDisplayOf(invoice({ ...ISSUED, issuance: { state: 'failed' } }))).toBe('failed');
  });
});

describe('statusMeta', () => {
  it('gives every invoice status its own rendering', () => {
    const labels = INVOICE_STATUSES.map((status) => statusMeta(status).label);
    expect(new Set(labels).size).toBe(INVOICE_STATUSES.length);
    for (const status of INVOICE_STATUSES) {
      const meta = statusMeta(status);
      expect(meta.label).not.toBe('');
      // One sentence in a seller's words, not a code and not the status name again.
      expect(meta.explain.length).toBeGreaterThan(20);
      expect(meta.pulse ?? false).toBe(false);
    }
  });

  it('defaults to the status alone when nothing is said about issuance', () => {
    expect(statusMeta('confirmed')).toEqual(statusMeta('confirmed', 'issued'));
    expect(explainStatus('sold')).toBe(statusMeta('sold', 'issued').explain);
  });

  /*
   * A pulsing grey chip says "wait". That is the right thing to say about a queued issuance
   * and the wrong thing to say about one that stopped, so a failure takes the pill whatever
   * the lifecycle underneath it says.
   */
  it('says "could not add" under every status when issuance failed, and never pulses', () => {
    for (const status of INVOICE_STATUSES) {
      const meta = statusMeta(status, 'failed');
      expect(meta.label).toBe('Could not add');
      expect(meta.pulse ?? false).toBe(false);
      // The negative palette, deliberately: this needs a person, not patience.
      expect(meta.dot).toBe('bg-neg');
      expect(meta.chip).toContain('neg');
    }
  });

  it('says "being added" under every status while issuance is pending, and pulses', () => {
    for (const status of INVOICE_STATUSES) {
      const meta = statusMeta(status, 'pending');
      expect(meta.label).toBe('Being added');
      expect(meta.pulse).toBe(true);
      expect(meta.dot).toBe('bg-idle');
    }
  });

  it('hands the status back its own rendering once the instrument lands', () => {
    for (const status of INVOICE_STATUSES) {
      expect(statusMeta(status, 'issued').label).not.toBe('Being added');
      expect(statusMeta(status, 'issued').label).not.toBe('Could not add');
    }
  });

  it('explains a failed issuance without promising it will keep trying', () => {
    const explain = explainStatus('confirmed', 'failed');
    expect(explain).toContain('will not keep trying');
    expect(explainStatus('confirmed', 'pending')).toContain('paced');
  });
});

describe('<StatusPill>', () => {
  const dotOf = (label: string): Element => {
    const dot = screen.getByText(label).querySelector('span[aria-hidden]');
    if (dot === null) throw new Error(`no indicator dot rendered beside "${label}"`);
    return dot;
  };

  it('renders the label and hangs the explanation off the chip', () => {
    render(<StatusPill status="confirmed" />);
    const pill = screen.getByText('Confirmed');
    expect(pill.getAttribute('title')).toBe(explainStatus('confirmed'));
  });

  it('animates the dot only while something is genuinely still happening', () => {
    render(<StatusPill status="confirmed" issuance="pending" />);
    expect(dotOf('Being added').className).toContain('animate-pulse');
  });

  /* The whole regression, at the one place a reader actually sees it. */
  it('does not animate a failed issuance', () => {
    render(<StatusPill status="confirmed" issuance="failed" />);
    expect(screen.queryByText('Being added')).toBeNull();
    expect(dotOf('Could not add').className).not.toContain('animate-pulse');
  });

  it('does not animate a settled invoice', () => {
    render(<StatusPill status="matured" />);
    expect(dotOf('Settled').className).not.toContain('animate-pulse');
  });

  it('renders every status without an issuance axis being given', () => {
    for (const status of INVOICE_STATUSES) {
      cleanup();
      render(<StatusPill status={status} size="md" />);
      expect(screen.getByText(statusMeta(status).label)).toBeTruthy();
    }
  });
});
