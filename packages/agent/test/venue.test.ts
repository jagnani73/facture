/**
 * Reading the venue.
 *
 * Two things are load-bearing here and neither is obvious from the shapes:
 *
 * 1. **Money crosses the wire as a decimal string of minor units and is read as `bigint`.**
 *    A response that carried an amount as a JSON number is rejected rather than coerced —
 *    it means the two services disagree about the representation, and a `number` is exact
 *    only below 2^53.
 * 2. **A mandate matches against what it funded, not what it intends to fund.** The
 *    escrowed balance is what makes a bid firm; the buyer's written ceiling is not money.
 */

import { describe, expect, it } from 'vitest';
import { createVenueClient, VenueError } from '../src/venue.js';

type Route = { status?: number; body: unknown };

/** A fetch that answers from a path→response table and records what it was asked. */
function stubFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const key = `${url.pathname}${url.search}`;
    calls.push(key);
    const route = routes[key] ?? routes[url.pathname];
    if (route === undefined) {
      return new Response(JSON.stringify({ error: { message: 'not stubbed' } }), { status: 404 });
    }
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

const client = (routes: Record<string, Route>) => {
  const { fetchImpl, calls } = stubFetch(routes);
  return {
    venue: createVenueClient({ baseUrl: 'http://venue.test', fetch: fetchImpl }),
    calls,
  };
};

const MANDATE = {
  id: 'mandate-a',
  buyerId: 'buyer-1',
  ratingFloor: 'A',
  maxTenorDays: 90,
  annualisedYieldBps: 1250,
  currency: 'USD',
  exposureLimit: '20000000',
  perDebtorLimit: '5000000',
  committed: '20000000',
  allocated: '3917808',
  unallocated: '16082192',
  status: 'active',
  quoting: true,
  debtorExposure: { 'debtor-1': '3917808' },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const BOOK_ROW = {
  id: 'invoice-1',
  sellerId: 'seller-1',
  debtorId: 'debtor-1',
  invoiceNumber: 'INV-1',
  faceValue: '4000000',
  currency: 'USD',
  issuedAt: '2026-09-01T00:00:00.000Z',
  dueAt: '2026-10-31T00:00:00.000Z',
  status: 'listed',
  instrumentAddress: '0xabc0000000000000000000000000000000000001',
  debtor: { id: 'debtor-1', name: 'Northwind Trading', rating: 'A' },
  quote: null,
  tenorDays: 60,
  mandatesMatching: 1,
};

describe('mandates', () => {
  it('reads every amount as a bigint of minor units', async () => {
    const { venue } = client({
      '/v1/mandates?buyerId=buyer-1&limit=200': { body: { mandates: [MANDATE] } },
    });

    const [mandate] = await venue.mandates('buyer-1');
    expect(mandate).toBeDefined();
    if (mandate === undefined) return;

    expect(mandate.terms.totalCommitted).toBe(20_000_000n);
    expect(mandate.terms.maxPerDebtor).toBe(5_000_000n);
    expect(mandate.allocations.total).toBe(3_917_808n);
    expect(mandate.allocations.byDebtor['debtor-1']).toBe(3_917_808n);
    for (const amount of [
      mandate.terms.totalCommitted,
      mandate.terms.maxPerDebtor,
      mandate.allocations.total,
      mandate.exposureLimit,
    ]) {
      expect(typeof amount).toBe('bigint');
    }
  });

  it('matches against escrowed capital, not the written ceiling', async () => {
    // Written for $200,000, funded to $30,000 so far. Only $30,000 is firm.
    const partiallyFunded = {
      ...MANDATE,
      committed: '3000000',
      allocated: '0',
      unallocated: '3000000',
    };
    const { venue } = client({
      '/v1/mandates?buyerId=buyer-1&limit=200': { body: { mandates: [partiallyFunded] } },
    });

    const [mandate] = await venue.mandates('buyer-1');
    expect(mandate?.terms.totalCommitted).toBe(3_000_000n);
    expect(mandate?.exposureLimit).toBe(20_000_000n);
  });

  it('does not let escrow above the written ceiling raise the cap', async () => {
    const overFunded = { ...MANDATE, committed: '99000000', unallocated: '95082192' };
    const { venue } = client({
      '/v1/mandates?buyerId=buyer-1&limit=200': { body: { mandates: [overFunded] } },
    });

    const [mandate] = await venue.mandates('buyer-1');
    // Capital the buyer said they did not want deployed stays undeployed.
    expect(mandate?.terms.totalCommitted).toBe(20_000_000n);
    expect(mandate?.escrowedCapital).toBe(99_000_000n);
  });

  it('treats an absent per-customer cap as "the pool is the only cap"', async () => {
    const { venue } = client({
      '/v1/mandates?buyerId=buyer-1&limit=200': {
        body: { mandates: [{ ...MANDATE, perDebtorLimit: null }] },
      },
    });
    const [mandate] = await venue.mandates('buyer-1');
    expect(mandate?.terms.maxPerDebtor).toBe(20_000_000n);
  });

  it('rejects an amount sent as a JSON number rather than guessing a scale', async () => {
    const { venue } = client({
      '/v1/mandates?buyerId=buyer-1&limit=200': {
        body: { mandates: [{ ...MANDATE, committed: 20000000 }] },
      },
    });
    await expect(venue.mandates('buyer-1')).rejects.toThrow(VenueError);
    await expect(venue.mandates('buyer-1')).rejects.toThrow(/cannot read/i);
  });

  it('rejects a decimal amount — minor units are integers', async () => {
    const { venue } = client({
      '/v1/mandates?buyerId=buyer-1&limit=200': {
        body: { mandates: [{ ...MANDATE, committed: '200000.00' }] },
      },
    });
    await expect(venue.mandates('buyer-1')).rejects.toThrow(/minor units/i);
  });
});

describe('the book', () => {
  it('unions several sellers and deduplicates by invoice id', async () => {
    const { venue, calls } = client({
      '/v1/invoices?sellerId=seller-1&limit=100': {
        body: { invoices: [BOOK_ROW], nextCursor: null },
      },
      '/v1/invoices?sellerId=seller-2&limit=100': {
        body: { invoices: [BOOK_ROW, { ...BOOK_ROW, id: 'invoice-2' }], nextCursor: null },
      },
    });

    const rows = await venue.book(['seller-1', 'seller-2']);
    expect(rows.map((r) => r.invoiceId).sort()).toEqual(['invoice-1', 'invoice-2']);
    expect(calls).toHaveLength(2);
  });

  it('follows the cursor', async () => {
    const { venue } = client({
      '/v1/invoices?sellerId=seller-1&limit=100': {
        body: { invoices: [BOOK_ROW], nextCursor: 'page-2' },
      },
      '/v1/invoices?sellerId=seller-1&limit=100&cursor=page-2': {
        body: { invoices: [{ ...BOOK_ROW, id: 'invoice-2' }], nextCursor: null },
      },
    });
    const rows = await venue.book(['seller-1']);
    expect(rows).toHaveLength(2);
  });

  it('marks quotable status from the shared domain constant, not a local list', async () => {
    const statuses = ['draft', 'awaiting_confirmation', 'confirmed', 'listed', 'sold', 'disputed'];
    const { venue } = client({
      '/v1/invoices?sellerId=seller-1&limit=100': {
        body: {
          invoices: statuses.map((status, i) => ({ ...BOOK_ROW, id: `i-${i}`, status })),
          nextCursor: null,
        },
      },
    });

    const rows = await venue.book(['seller-1']);
    const quotable = rows.filter((r) => r.quotable).map((r) => r.status);
    expect(quotable.sort()).toEqual(['confirmed', 'listed']);
  });

  it('drops a row with no debtor rather than guessing UNRATED', async () => {
    // A rating is the first thing a mandate screens on. Assuming one would quote paper
    // whose credit the venue has not disclosed.
    const { venue } = client({
      '/v1/invoices?sellerId=seller-1&limit=100': {
        body: { invoices: [{ ...BOOK_ROW, debtor: null }], nextCursor: null },
      },
    });
    expect(await venue.book(['seller-1'])).toEqual([]);
  });

  it('reports whether the ATS instrument exists yet — issuance is paced', async () => {
    const { venue } = client({
      '/v1/invoices?sellerId=seller-1&limit=100': {
        body: {
          invoices: [BOOK_ROW, { ...BOOK_ROW, id: 'invoice-2', instrumentAddress: null }],
          nextCursor: null,
        },
      },
    });
    const rows = await venue.book(['seller-1']);
    expect(rows.find((r) => r.invoiceId === 'invoice-1')?.issued).toBe(true);
    expect(rows.find((r) => r.invoiceId === 'invoice-2')?.issued).toBe(false);
  });
});

describe('quote', () => {
  it('carries the quote id a trade is executed against', async () => {
    const { venue } = client({
      '/v1/invoices/invoice-1/quote': {
        body: {
          invoiceId: 'invoice-1',
          rating: 'A',
          tenorDays: 60,
          quoteId: 'quote-1',
          quote: {
            invoiceId: 'invoice-1',
            mandateId: 'mandate-a',
            annualisedYieldBps: 1250,
            tenorDays: 60,
            faceValue: '4000000',
            discount: '82192',
            proceeds: '3917808',
            currency: 'USD',
            asOf: '2026-09-01T00:00:00.000Z',
            expiresAt: '2026-09-01T00:05:00.000Z',
          },
        },
      },
    });

    const quote = await venue.quote('invoice-1');
    expect(quote.quoteId).toBe('quote-1');
    expect(quote.mandateId).toBe('mandate-a');
    expect(quote.proceeds).toBe(3_917_808n);
    expect(typeof quote.proceeds).toBe('bigint');
  });

  it('reports no quote id when nothing on the book will take the paper', async () => {
    const { venue } = client({
      '/v1/invoices/invoice-1/quote': {
        body: { invoiceId: 'invoice-1', rating: 'D', tenorDays: 60, quoteId: null, quote: null },
      },
    });
    const quote = await venue.quote('invoice-1');
    expect(quote.quoteId).toBeNull();
    expect(quote.proceeds).toBeNull();
  });
});

describe('armTrade', () => {
  it('treats 402 as the success case — it is the x402 challenge, not a failure', async () => {
    const challenge = { x402Version: 2, accepts: [{ scheme: 'exact', network: 'hedera-testnet' }] };
    const { venue } = client({ '/v1/trades': { status: 402, body: challenge } });

    const armed = await venue.armTrade({ invoiceId: 'invoice-1', quoteId: 'quote-1' });
    expect(armed.status).toBe(402);
    expect(armed.challenge).toEqual(challenge);
  });

  it('surfaces the venue’s own error code so the loop can tell a race from an outage', async () => {
    const { venue } = client({
      '/v1/trades': {
        status: 409,
        body: { error: { code: 'quote_expired', message: 'That quote has expired.' } },
      },
    });

    await expect(venue.armTrade({ invoiceId: 'i', quoteId: 'q' })).rejects.toMatchObject({
      name: 'VenueError',
      status: 409,
      code: 'quote_expired',
    });
  });
});

describe('transport failures', () => {
  it('reports a non-JSON body as a venue error rather than a parse crash', async () => {
    const fetchImpl: typeof globalThis.fetch = async () =>
      new Response('<html>502 Bad Gateway</html>', { status: 502 });
    const venue = createVenueClient({ baseUrl: 'http://venue.test', fetch: fetchImpl });
    await expect(venue.mandates('buyer-1')).rejects.toThrow(/not JSON/);
  });

  it('reports a network failure with status 0, distinguishable from an HTTP error', async () => {
    const fetchImpl: typeof globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const venue = createVenueClient({ baseUrl: 'http://venue.test', fetch: fetchImpl });
    await expect(venue.mandates('buyer-1')).rejects.toMatchObject({ status: 0 });
  });
});
