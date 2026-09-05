/**
 * Seller onboarding.
 *
 * Two rules carry real weight here and neither is visible in a type.
 *
 * **Email is the identity**, so a repeat call is a sign-in rather than a duplicate. If it
 * were not idempotent a business would get a second, empty book the first time it signed in
 * from another device — and its invoices would be on the other one.
 *
 * **A recorded wallet address is never rebound.** Nothing authenticates this route, and a
 * seller's address is where they expect to be paid, so an address only ever fills a field
 * that is null. The failing version of this route is not one that throws; it is one that
 * quietly accepts the second address.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, createHarness, type Harness } from './helpers.js';

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(() => {
  h.restore();
});

const ARC = '0x1c755e95cb11e5d5af498bb0ea595b56e1adb035';
const OTHER_ARC = '0xa25796399a9b3e8006d2d45ff48a3b830c7f020b';

const body = (over: Record<string, unknown> = {}) => ({
  name: 'Meridian Fabrication',
  email: 'ada@meridian.example',
  ...over,
});

describe('POST /v1/sellers', () => {
  it('creates a seller with 201 and returns the id every other route is scoped by', async () => {
    const res = await call(h.app, 'POST', '/v1/sellers', { body: body({ arcAddress: ARC }) });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.seller.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(res.body.seller.email).toBe('ada@meridian.example');
    expect(res.body.seller.arcAddress).toBe(ARC);
  });

  /*
   * A wallet made from an email address has an address but no Hedera account: the address
   * is an alias, and the account behind it exists only once something funds it. Null here
   * is a fact about Hedera, not a missing write.
   */
  it('records an Arc address without inventing a Hedera account id', async () => {
    const res = await call(h.app, 'POST', '/v1/sellers', { body: body({ arcAddress: ARC }) });

    expect(res.body.seller.arcAddress).toBe(ARC);
    expect(res.body.seller.hederaAccountId).toBeNull();
  });

  it('signs an existing seller back in with 200 rather than creating a second', async () => {
    const first = await call(h.app, 'POST', '/v1/sellers', { body: body({ arcAddress: ARC }) });
    const second = await call(h.app, 'POST', '/v1/sellers', { body: body({ arcAddress: ARC }) });

    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.seller.id).toBe(first.body.seller.id);
  });

  /* Two capitalisations of one address are one business, not two books. */
  it('treats a differently-cased email as the same seller', async () => {
    const first = await call(h.app, 'POST', '/v1/sellers', { body: body() });
    const second = await call(h.app, 'POST', '/v1/sellers', {
      body: body({ email: 'Ada@Meridian.Example' }),
    });

    expect(second.status).toBe(200);
    expect(second.body.seller.id).toBe(first.body.seller.id);
    expect(second.body.seller.email).toBe('ada@meridian.example');
  });

  it('fills a wallet address that was not set at sign-up', async () => {
    const first = await call(h.app, 'POST', '/v1/sellers', { body: body() });
    expect(first.body.seller.arcAddress).toBeNull();

    const second = await call(h.app, 'POST', '/v1/sellers', { body: body({ arcAddress: ARC }) });
    expect(second.status).toBe(200);
    expect(second.body.seller.arcAddress).toBe(ARC);
  });

  /* The rule this route exists to hold. */
  it('refuses to rebind an address that is already on file', async () => {
    await call(h.app, 'POST', '/v1/sellers', { body: body({ arcAddress: ARC }) });
    const rebind = await call(h.app, 'POST', '/v1/sellers', {
      body: body({ arcAddress: OTHER_ARC }),
    });

    expect(rebind.status).toBe(409);
    expect(rebind.body.code).toBe('conflict');
    expect(rebind.body.detail).toContain('where a seller expects to be paid');

    const after = await call(h.app, 'POST', '/v1/sellers', { body: body() });
    expect(after.body.seller.arcAddress).toBe(ARC);
  });

  /* Same wallet, different casing, is the same wallet — a sign-in, not an attack. */
  it('accepts the same address in another casing as a no-op', async () => {
    await call(h.app, 'POST', '/v1/sellers', { body: body({ arcAddress: ARC }) });
    const again = await call(h.app, 'POST', '/v1/sellers', {
      body: body({ arcAddress: ARC.toUpperCase().replace('0X', '0x') }),
    });

    expect(again.status).toBe(200);
    expect(again.body.seller.arcAddress).toBe(ARC);
  });

  it('refuses an address that is not one, rather than storing the string', async () => {
    for (const arcAddress of ['not-an-address', '0x123', ARC.slice(0, -1), `${ARC}ff`]) {
      const res = await call(h.app, 'POST', '/v1/sellers', { body: body({ arcAddress }) });
      expect(res.status).toBe(422);
    }
  });

  it('refuses a Hedera account id that is an EVM address', async () => {
    const res = await call(h.app, 'POST', '/v1/sellers', { body: body({ hederaAccountId: ARC }) });
    expect(res.status).toBe(422);
  });

  it('refuses a body with no email at all', async () => {
    const res = await call(h.app, 'POST', '/v1/sellers', { body: { name: 'Meridian' } });
    expect(res.status).toBe(422);
  });
});

describe('GET /v1/sellers/:id', () => {
  it('returns the seller a sign-in produced', async () => {
    const created = await call(h.app, 'POST', '/v1/sellers', { body: body({ arcAddress: ARC }) });
    const res = await call(h.app, 'GET', `/v1/sellers/${created.body.seller.id}`);

    expect(res.status).toBe(200);
    expect(res.body.seller.name).toBe('Meridian Fabrication');
    expect(res.body.seller.arcAddress).toBe(ARC);
  });

  it('answers 404 for an id nobody has', async () => {
    const res = await call(h.app, 'GET', '/v1/sellers/9f1c6f1e-0000-4000-8000-000000000001');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });

  it('answers 422 for an id that is not a UUID', async () => {
    const res = await call(h.app, 'GET', '/v1/sellers/not-a-uuid');
    expect(res.status).toBe(422);
  });
});
