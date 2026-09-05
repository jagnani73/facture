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

type Route = { status?: number; body: unknown; headers?: Record<string, string> };

/** What the client actually sent. The x402 half of this lives in a header, so it is recorded. */
type Sent = { path: string; headers: Record<string, string> };

/** A fetch that answers from a path→response table and records what it was asked. */
function stubFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const sent: Sent[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const key = `${url.pathname}${url.search}`;
    calls.push(key);
    sent.push({
      path: key,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
    });
    const route = routes[key] ?? routes[url.pathname];
    if (route === undefined) {
      return new Response(JSON.stringify({ error: { message: 'not stubbed' } }), { status: 404 });
    }
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json', ...(route.headers ?? {}) },
    });
  };
  return { fetchImpl, calls, sent };
}

const client = (routes: Record<string, Route>) => {
  const { fetchImpl, calls, sent } = stubFetch(routes);
  return {
    venue: createVenueClient({ baseUrl: 'http://venue.test', fetch: fetchImpl }),
    calls,
    sent,
  };
};

const b64 = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
const unb64 = (value: string): unknown => JSON.parse(Buffer.from(value, 'base64').toString('utf8'));

/** One well-formed v2 requirement, as the venue and the facilitator actually shape it. */
const REQUIREMENTS = {
  scheme: 'exact',
  network: 'hedera:testnet',
  asset: '0.0.0',
  amount: '3918',
  payTo: '0.0.10311549',
  maxTimeoutSeconds: 120,
  extra: { feePayer: '0.0.7162784' },
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
    const challenge = { x402Version: 2, accepts: [REQUIREMENTS] };
    const { venue } = client({
      '/v1/trades': {
        status: 402,
        body: { rail: { chosen: 'x402', reason: 'This bid holds no capital on Arc.' } },
        headers: { 'payment-required': b64(challenge) },
      },
    });

    const armed = await venue.armTrade({ invoiceId: 'invoice-1', quoteId: 'quote-1' });
    expect(armed.status).toBe(402);
    expect(armed.challenge).toEqual(challenge);
    expect(armed.challengeError).toBeNull();
    // The rail comes from the venue's own words, not from the status code it was inferred by.
    expect(armed.rail?.chosen).toBe('x402');
  });

  /*
   * **The challenge is read from the header, not the body.**
   *
   * The venue duplicates `accepts` into its JSON for convenience, and this used to read that
   * copy — which made the agent a client of Facture's response shape rather than of x402.
   * The header is where the protocol puts it and what any other client would read, so a body
   * carrying a challenge while the header carries none is nothing to sign.
   */
  it('ignores a challenge that is only in the body, because the protocol is in the header', async () => {
    const { venue } = client({
      '/v1/trades': { status: 402, body: { x402Version: 2, accepts: [REQUIREMENTS] } },
    });

    const armed = await venue.armTrade({ invoiceId: 'invoice-1', quoteId: 'quote-1' });
    expect(armed.challenge).toBeNull();
    expect(armed.challengeError).toMatch(/payment-required/);
    // Named explicitly, because the v1 spelling is the first thing anyone reaches for.
    expect(armed.challengeError).toMatch(/X-PAYMENT/);
  });

  /*
   * CAIP-2, with a colon. The hyphenated spelling is accepted by every type in the stack and
   * fails at the facilitator's kind lookup — **after** the ATS hold has been placed. Refusing
   * it at the parse is what moves that failure to before the seller's paper is committed.
   */
  it('refuses a challenge whose network is not CAIP-2, rather than passing it on', async () => {
    const { venue } = client({
      '/v1/trades': {
        status: 402,
        body: {},
        headers: {
          'payment-required': b64({
            x402Version: 2,
            accepts: [{ ...REQUIREMENTS, network: 'hedera-testnet' }],
          }),
        },
      },
    });

    const armed = await venue.armTrade({ invoiceId: 'invoice-1', quoteId: 'quote-1' });
    expect(armed.challenge).toBeNull();
    expect(armed.challengeError).toMatch(/CAIP-2/);
  });

  it('carries both legs off a 200, where arming was the settlement', async () => {
    const { venue } = client({
      '/v1/trades': {
        status: 200,
        body: {
          rail: { chosen: 'arc-vault', reason: 'The buyer escrowed this capital on Arc.' },
          cashLeg: { chain: 'arc', rail: 'arc-vault', state: 'settled', transaction: '0xabc' },
          assetLeg: { state: 'executed', transactionId: '0.0.1@1.2', unitsMinor: '4000000' },
          settledAt: '2026-09-03T00:00:00.000Z',
        },
      },
    });

    const armed = await venue.armTrade({ invoiceId: 'invoice-1', quoteId: 'quote-1' });
    expect(armed.status).toBe(200);
    // Nothing to sign, and nothing pretending otherwise.
    expect(armed.challenge).toBeNull();
    expect(armed.challengeError).toBeNull();
    expect(armed.cashLeg?.rail).toBe('arc-vault');
    expect(armed.assetLeg?.transactionId).toBe('0.0.1@1.2');
    expect(armed.settledAt).toBe('2026-09-03T00:00:00.000Z');
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

describe('settleTrade', () => {
  const PAYMENT = {
    x402Version: 2,
    accepted: REQUIREMENTS as never,
    payload: { transaction: 'CgUIARIBAA==' },
  };

  const SETTLED = {
    '/v1/trades': {
      body: {
        trade: { id: 'trade-1' },
        cashLeg: {
          chain: 'hedera',
          rail: 'x402',
          state: 'settled',
          transaction: '0.0.7162784@1788268815.161410978',
          settledAmountMinor: '3918',
        },
        assetLeg: {
          state: 'executed',
          transactionId: '0.0.10311549@1788268822.126538150',
          unitsMinor: '4000000',
        },
        settledAt: '2026-09-03T00:00:00.000Z',
      },
    },
  };

  /*
   * The header name is the whole test. `@x402/*` v2 uses `payment-signature`; the older
   * `X-PAYMENT` spelling is not an alias, and a venue reading v2 sees a request with no
   * signature at all — which it answers by arming a *second* trade rather than by failing.
   */
  it('presents the payload as base64 JSON in payment-signature', async () => {
    const { venue, sent } = client(SETTLED);

    await venue.settleTrade({ invoiceId: 'invoice-1', quoteId: 'quote-1', payment: PAYMENT });

    const header = sent.at(-1)?.headers['payment-signature'];
    expect(header).toBeDefined();
    expect(unb64(header as string)).toEqual(PAYMENT);
    expect(sent.at(-1)?.headers['x-payment']).toBeUndefined();
  });

  /*
   * Both halves send the same body, deliberately. One route serves the exchange so a client
   * cannot pay against a challenge it never received; sending different terms on the second
   * call is answered as a trade that does not exist, not filled at the new ones.
   */
  it('repeats the same terms, so the second half cannot re-price the first', async () => {
    const { venue, sent } = client(SETTLED);

    await venue.armTrade({ invoiceId: 'invoice-1', quoteId: 'quote-1', maxSlippageBps: 25 });
    await venue.settleTrade({
      invoiceId: 'invoice-1',
      quoteId: 'quote-1',
      maxSlippageBps: 25,
      payment: PAYMENT,
    });

    expect(sent).toHaveLength(2);
    expect(sent[0]?.path).toBe('/v1/trades');
    expect(sent[1]?.path).toBe('/v1/trades');
  });

  it('reads both legs back, so the cash transaction is checkable off this database', async () => {
    const { venue } = client(SETTLED);

    const settled = await venue.settleTrade({
      invoiceId: 'invoice-1',
      quoteId: 'quote-1',
      payment: PAYMENT,
    });

    expect(settled.tradeId).toBe('trade-1');
    expect(settled.cashLeg?.rail).toBe('x402');
    expect(settled.cashLeg?.transaction).toBe('0.0.7162784@1788268815.161410978');
    expect(settled.cashLeg?.settledAmountMinor).toBe('3918');
    expect(settled.assetLeg?.transactionId).toBe('0.0.10311549@1788268822.126538150');
    expect(settled.settledAt).toBe('2026-09-03T00:00:00.000Z');
  });

  /*
   * A rejected payment must throw rather than resolve. The caller treats a resolved
   * `settleTrade` as "the cash moved", so a 409 read as success would report a settled trade
   * with a null transaction — the exact shape of a claim nobody can check.
   */
  it('throws on a refused payment rather than reporting a settlement with no transaction', async () => {
    const { venue } = client({
      '/v1/trades': {
        status: 409,
        body: {
          error: {
            code: 'conflict',
            message: 'This trade settles out of the buyer’s escrowed capital on Arc.',
          },
        },
      },
    });

    await expect(
      venue.settleTrade({ invoiceId: 'i', quoteId: 'q', payment: PAYMENT }),
    ).rejects.toMatchObject({ name: 'VenueError', status: 409, code: 'conflict' });
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

/**
 * The budget for arming, and what a timeout on it means.
 *
 * Both of these come from the same live run. The client gave up at ten seconds, the venue
 * kept working, and the trade was armed — hold placed, capital allocated, the seller's paper
 * committed — with nothing on this side knowing. The next tick tried to arm the same invoice
 * and was refused with a 409, which was the venue protecting the invoice rather than a fault.
 */
describe('the trade route has its own timeout', () => {
  /** A fetch that never answers, and resolves only if the caller gives up first. */
  const hangingFetch: typeof globalThis.fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('This operation was aborted', 'AbortError'));
      });
    });

  it('gives arming a longer budget than a read, rather than one shared number', async () => {
    const venue = createVenueClient({
      baseUrl: 'http://venue.test',
      fetch: hangingFetch,
      timeoutMs: 15,
      tradeTimeoutMs: 10_000,
    });

    // The read gives up on its own short budget; the arm is still waiting on its longer one.
    await expect(venue.quote('invoice-1')).rejects.toThrow(VenueError);

    const armed = venue.armTrade({ invoiceId: 'invoice-1', quoteId: 'quote-1' });
    const raced = await Promise.race([
      armed.then(() => 'settled').catch(() => 'gave up'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 60)),
    ]);
    expect(raced).toBe('still waiting');
  });

  /*
   * The message is the whole point. Reported as a plain failure, it sends an operator
   * looking for a bug rather than for the armed trade that needs settling or unwinding.
   */
  it('says an aborted arm may have been armed anyway, because it has been', async () => {
    const venue = createVenueClient({
      baseUrl: 'http://venue.test',
      fetch: hangingFetch,
      tradeTimeoutMs: 10,
    });

    await expect(venue.armTrade({ invoiceId: 'invoice-1', quoteId: 'quote-1' })).rejects.toThrow(
      /may still have armed this trade/,
    );
    await expect(venue.armTrade({ invoiceId: 'invoice-1', quoteId: 'quote-1' })).rejects.toThrow(
      /timeout is not a rollback/,
    );
  });

  /* A read that times out really did do nothing, so it must not claim otherwise. */
  it('does not say that about a read, which changes nothing when it aborts', async () => {
    const venue = createVenueClient({
      baseUrl: 'http://venue.test',
      fetch: hangingFetch,
      timeoutMs: 10,
    });

    await expect(venue.quote('invoice-1')).rejects.not.toThrow(/may still have armed/);
  });
});
