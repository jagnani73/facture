/**
 * Asking a customer to confirm, and what the seller is told happened.
 *
 * This screen told every seller "Your customer has been sent the link." **There is no mail
 * transport in this build.** The venue returns the confirmation link precisely because
 * nothing sends it — `routes/invoices.ts` says so beside the field — and this layer threw
 * the response away, so an honest answer became a false one on the way to the screen.
 *
 * It matters more than a wording slip. The debtor's acknowledgement is what justifies
 * advancing the full face value with no holdback, so "your customer has been asked" is the
 * load-bearing claim of the whole product. A seller who believes it was delivered waits for
 * an answer to a question nobody received.
 *
 * The two answers the venue can give are different facts and are kept apart here: a link in
 * hand is not a link on its way, and production withholds the link on purpose, because a
 * seller who can read it can confirm their own invoices.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { usingApiMock } = vi.hoisted(() => ({ usingApiMock: vi.fn(() => true) }));

vi.mock('@/lib/api/client', () => ({ api: { requestConfirmation: vi.fn() } }));
vi.mock('@/lib/api/config', () => ({ DATA_SOURCE: 'api', usingApi: usingApiMock }));

import { api } from '@/lib/api/client';
import { requestConfirmation } from '@/lib/data';

const INVOICE_ID = '9f1c6f1e-0000-4000-8000-000000000001';
const SENT_TO = 'ap@meridian-fabrication.test';
const LINK = 'http://localhost:3000/confirm/abc123';

beforeEach(() => {
  usingApiMock.mockReturnValue(true);
  vi.mocked(api.requestConfirmation).mockReset();
});

describe('requestConfirmation', () => {
  it('hands the seller the link when the venue returns one', async () => {
    vi.mocked(api.requestConfirmation).mockResolvedValue({
      sentTo: SENT_TO,
      expiresAt: '2026-09-11T09:32:00.000Z',
      link: LINK,
    });

    const result = await requestConfirmation(INVOICE_ID);

    expect(result.ok).toBe(true);
    expect(result.ok && result.note).toContain(LINK);
    expect(result.ok && result.note).toContain(SENT_TO);
  });

  /*
   * The regression this file exists for. Any wording is acceptable except one that asserts
   * a delivery, so the claim is tested rather than the sentence.
   */
  it('never claims the link was delivered', async () => {
    for (const link of [LINK, null]) {
      vi.mocked(api.requestConfirmation).mockResolvedValue({
        sentTo: SENT_TO,
        expiresAt: '2026-09-11T09:32:00.000Z',
        link,
      });

      const result = await requestConfirmation(INVOICE_ID);

      expect(result.ok).toBe(true);
      expect(result.ok && result.note).not.toMatch(/\bhas been sent\b|\bwe sent\b|\bemailed\b/i);
    }
  });

  it('says something different when the link is withheld', async () => {
    vi.mocked(api.requestConfirmation).mockResolvedValue({
      sentTo: SENT_TO,
      expiresAt: '2026-09-11T09:32:00.000Z',
      link: null,
    });

    const result = await requestConfirmation(INVOICE_ID);

    expect(result.ok).toBe(true);
    expect(result.ok && result.note).toContain(SENT_TO);
    expect(result.ok && result.note).not.toContain('http');
  });

  it('reports a refusal as a refusal', async () => {
    vi.mocked(api.requestConfirmation).mockRejectedValue(new Error('nope'));

    const result = await requestConfirmation(INVOICE_ID);

    expect(result.ok).toBe(false);
  });
});
