/**
 * Seller onboarding.
 *
 * Three rules carry real weight here and none of them is visible in a type.
 *
 * **The identity comes from the token.** The route takes no body, so there is no field a
 * caller could use to claim someone else's business. The first version of this route read an
 * email out of the request and believed it.
 *
 * **Email is the identity**, so a repeat call is a sign-in rather than a duplicate. If it
 * were not idempotent a business would get a second, empty book the first time it signed in
 * from another device — and its invoices would be on the other one.
 *
 * **A recorded wallet address is never rebound.** A verified token proves who signed in, not
 * that the wallet now attached to that account is the one the business expects to be paid at.
 * The failing version of this route is not one that throws; it is one that quietly accepts
 * the second address.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  call,
  createHarness,
  recordingPolicyClient,
  signedIn,
  stubPrivy,
  VALID_ID_TOKEN,
  type Harness,
} from './helpers.js';
import {
  createDisabledPrivyVerifier,
  provisionalName,
  setPrivyVerifier,
} from '../src/services/privy.js';

let h: Harness;

afterEach(() => {
  h.restore();
});

const ARC = '0x1c755e95cb11e5d5af498bb0ea595b56e1adb035';
const OTHER_ARC = '0xa25796399a9b3e8006d2d45ff48a3b830c7f020b';

describe('POST /v1/sellers', () => {
  beforeEach(async () => {
    h = await createHarness();
  });

  const signIn = (headers = signedIn()) =>
    call(h.app, 'POST', '/v1/sellers', { headers, body: {} });

  it('creates a seller with 201 from the token alone', async () => {
    const res = await signIn();

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.seller.email).toBe('ada@meridian.example');
    expect(res.body.seller.arcAddress).toBe(ARC);
    expect(res.body.seller.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  /*
   * A wallet made from an email address has an address but no Hedera account: the address is
   * an alias, and the account behind it exists only once something funds it. Null here is a
   * fact about Hedera, not a missing write.
   */
  it('records the Arc address without inventing a Hedera account id', async () => {
    const res = await signIn();
    expect(res.body.seller.arcAddress).toBe(ARC);
    expect(res.body.seller.hederaAccountId).toBeNull();
  });

  it('signs an existing seller back in with 200 rather than creating a second', async () => {
    const first = await signIn();
    const second = await signIn();

    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.seller.id).toBe(first.body.seller.id);
  });

  /* Signing in from a device that had no wallet yet, then from one that does. */
  it('fills a wallet address the first sign-in did not carry', async () => {
    setPrivyVerifier(stubPrivy({ walletAddress: null }));
    const first = await signIn();
    expect(first.body.seller.arcAddress).toBeNull();

    setPrivyVerifier(stubPrivy({ walletAddress: ARC }));
    const filled = await signIn();
    expect(filled.status).toBe(200);
    expect(filled.body.seller.arcAddress).toBe(ARC);
  });

  /*
   * The rule this route exists to hold. A verified token proves who signed in; it does not
   * prove the wallet now on that account is the one the business expects to be paid at.
   */
  it('answers 409 when a later token carries a different wallet', async () => {
    const created = await signIn();
    expect(created.body.seller.arcAddress).toBe(ARC);

    setPrivyVerifier(stubPrivy({ walletAddress: OTHER_ARC }));
    const rebind = await signIn();

    expect(rebind.status).toBe(409);
    expect(rebind.body.code).toBe('conflict');
    expect(rebind.body.detail).toContain('where a seller expects to be paid');

    const after = await h.store.getSellerByEmail('ada@meridian.example');
    expect(after?.arcAddress).toBe(ARC);
  });

  /* Same wallet in another casing is the same wallet — a sign-in, not an attack. */
  it('accepts the same address in another casing as a no-op', async () => {
    await signIn();

    setPrivyVerifier(stubPrivy({ walletAddress: ARC.toUpperCase().replace('0X', '0x') }));
    const again = await signIn();

    expect(again.status).toBe(200);
    expect(again.body.seller.arcAddress).toBe(ARC);
  });

  /* A token with no wallet says nothing about the address on file, and must not clear it. */
  it('does not clear a recorded address when a later token carries none', async () => {
    await signIn();

    setPrivyVerifier(stubPrivy({ walletAddress: null }));
    const again = await signIn();

    expect(again.status).toBe(200);
    expect(again.body.seller.arcAddress).toBe(ARC);
  });

  /* Two capitalisations of one address are one business, not two books. */
  it('treats a differently-cased email as the same seller', async () => {
    const first = await signIn();

    setPrivyVerifier(stubPrivy({ email: 'ada@meridian.example' }));
    const second = await signIn();

    expect(second.status).toBe(200);
    expect(second.body.seller.id).toBe(first.body.seller.id);
  });

  it('derives a business name from the verified email, not from the caller', async () => {
    const res = await signIn();
    expect(res.body.seller.name).toBe('Meridian');
  });
});

describe('POST /v1/sellers — the credential', () => {
  beforeEach(async () => {
    h = await createHarness();
  });

  it('refuses with 401 when no Authorization header is sent', async () => {
    const res = await call(h.app, 'POST', '/v1/sellers', { body: {} });
    expect(res.status).toBe(401);
    expect(res.body.detail).toContain('Privy identity token');
  });

  it.each([
    ['a bare token with no scheme', VALID_ID_TOKEN],
    ['the wrong scheme', `Basic ${VALID_ID_TOKEN}`],
    ['Bearer with nothing after it', 'Bearer'],
    ['an empty header', ''],
  ])('refuses %s before asking Privy anything', async (_label, authorization) => {
    const res = await call(h.app, 'POST', '/v1/sellers', {
      headers: { authorization },
      body: {},
    });
    expect(res.status).toBe(401);
    expect(res.body.detail).toContain('Authorization: Bearer');
  });

  it('refuses a token Privy will not verify', async () => {
    const res = await call(h.app, 'POST', '/v1/sellers', {
      headers: signedIn('a-token-from-somewhere-else'),
      body: {},
    });
    expect(res.status).toBe(401);
  });

  /*
   * Privy documents the identity token payload as possibly incomplete. A token that verifies
   * but carries no email cannot identify a seller here, and saying so is better than
   * inventing one.
   */
  it('refuses a verified token that carries no email', async () => {
    setPrivyVerifier(stubPrivy({ email: '' }));

    const res = await call(h.app, 'POST', '/v1/sellers', { headers: signedIn(), body: {} });
    expect(res.status).toBe(401);
  });

  /*
   * The whole point. With no Privy credentials there is no way to verify anyone, so the route
   * refuses rather than falling back to believing a caller — which is the behaviour it was
   * written to remove, and would be reachable only where configuration was forgotten.
   */
  it('refuses entirely when Privy is not configured, rather than trusting the caller', async () => {
    setPrivyVerifier(createDisabledPrivyVerifier());

    const res = await call(h.app, 'POST', '/v1/sellers', { headers: signedIn(), body: {} });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('PRIVY_APP_ID');
  });
});

/**
 * The Privy control, from the route's side.
 *
 * The policy is what makes the seller's key a key that can only collect — see
 * `test/privy-policy.test.ts` for what it says. What matters here is the other half:
 * scoping a wallet is a call to a third party, and a third party being unavailable must
 * not stop a business opening a book. That is the same rule `publishRefusals` follows, and
 * it is easy to lose, because the natural way to write the call is a bare `await`.
 */
describe('POST /v1/sellers and the wallet policy', () => {
  afterEach(() => {
    h.restore();
  });

  it('scopes the wallet the sign-in arrived with', async () => {
    const policies = recordingPolicyClient();
    h = await createHarness({ policies });

    const res = await call(h.app, 'POST', '/v1/sellers', { headers: signedIn(), body: {} });

    expect(res.status).toBe(201);
    expect(policies.attached).toEqual([{ walletId: 'kxy2test4wallet8id', walletAddress: ARC }]);
  });

  /*
   * A returning seller is a sign-in, not a duplicate, and their wallet is the one that needs
   * scoping now. Cheap to repeat: the client reads the wallet before it writes.
   */
  it('scopes on a returning sign-in too', async () => {
    const policies = recordingPolicyClient();
    h = await createHarness({ policies });

    await call(h.app, 'POST', '/v1/sellers', { headers: signedIn(), body: {} });
    const second = await call(h.app, 'POST', '/v1/sellers', { headers: signedIn(), body: {} });

    expect(second.status).toBe(200);
    expect(policies.attached).toHaveLength(2);
  });

  /*
   * The whole point of the never-throws rule. An unavailable Privy policy API — or an
   * account whose plan carries no policy engine — costs the control, not the account.
   */
  it('signs a seller in even when the policy API is down', async () => {
    const policies = recordingPolicyClient({ throws: 'privy policy api unreachable' });
    h = await createHarness({ policies });

    const res = await call(h.app, 'POST', '/v1/sellers', { headers: signedIn(), body: {} });

    expect(res.status).toBe(201);
    expect(res.body.seller.email).toBe('ada@meridian.example');
  });

  it('signs a seller in when the policy could not be attached', async () => {
    const policies = recordingPolicyClient({
      result: { attached: false, reason: 'no wallet id' },
    });
    h = await createHarness({ policies });

    const res = await call(h.app, 'POST', '/v1/sellers', { headers: signedIn(), body: {} });

    expect(res.status).toBe(201);
  });

  /*
   * Deliberately absent from the response. A field the API publishes and the screen discards
   * is how `escrowVerified` came to tell every buyer the capital was escrowed when nothing
   * had checked it — so this is asserted rather than left to drift into the wire.
   */
  it('does not publish the attachment on the wire', async () => {
    h = await createHarness({ policies: recordingPolicyClient() });

    const res = await call(h.app, 'POST', '/v1/sellers', { headers: signedIn(), body: {} });

    expect(Object.keys(res.body).sort()).toEqual(['created', 'seller']);
    expect(JSON.stringify(res.body)).not.toContain('policy');
  });

  /*
   * With no policy configured the harness runs the disabled client, which is what every
   * other test in this file has been exercising. Sign-in is unaffected, which is the state
   * the deployment is in today.
   */
  it('signs a seller in with no policy configured at all', async () => {
    h = await createHarness();

    const res = await call(h.app, 'POST', '/v1/sellers', { headers: signedIn(), body: {} });

    expect(res.status).toBe(201);
  });
});

describe('GET /v1/sellers/:id', () => {
  beforeEach(async () => {
    h = await createHarness();
  });

  it('returns the seller a sign-in produced', async () => {
    const created = await call(h.app, 'POST', '/v1/sellers', { headers: signedIn(), body: {} });
    const res = await call(h.app, 'GET', `/v1/sellers/${created.body.seller.id}`);

    expect(res.status).toBe(200);
    expect(res.body.seller.email).toBe('ada@meridian.example');
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

describe('provisionalName', () => {
  it('builds a readable label from the email domain', () => {
    expect(provisionalName('ada@meridian.example')).toBe('Meridian');
    expect(provisionalName('ap@meridian-fabrication.example')).toBe('Meridian Fabrication');
    expect(provisionalName('ada@petra_foods.co.uk')).toBe('Petra Foods');
  });

  /* The venue requires a non-empty name, so there is no input that may produce one. */
  it('never produces an empty name', () => {
    for (const email of ['ada@', 'ada', '', '@example.com']) {
      expect(provisionalName(email).length).toBeGreaterThan(0);
    }
  });
});
