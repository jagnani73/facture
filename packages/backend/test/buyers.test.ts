/**
 * Buyer onboarding.
 *
 * The same three rules as `test/sellers.test.ts`, asserted against the other actor, and none
 * of them is visible in a type.
 *
 * **The identity comes from the token.** The route takes no body, so there is no field a
 * caller could use to claim someone else's desk — and a desk is what mandates, committed
 * capital and exposure ladders are scoped by.
 *
 * **Email is the identity**, so a repeat call is a sign-in rather than a duplicate. A second
 * row for one desk is a second empty set of mandates beside the funded ones, which is worse
 * here than on the seller side: the desk could commit the same money again under the new id
 * while the venue counted no exposure against it.
 *
 * **A recorded wallet address is never rebound.** `MandateVault.deposit` pulls from
 * `msg.sender` and `ArcEscrow.buyerOf` binds a mandate to one address permanently, so
 * quietly accepting a second address does not misdirect a payment — it desynchronises the
 * venue from the chain, and the symptom is a mandate reading unfunded while its USDC sits in
 * the vault. The failing version of this route is not one that throws.
 *
 * One thing is asserted here by its **absence**: no Privy seller wallet policy is attached.
 * That policy permits `claim` on `DvpEscrow`, which is a seller's collection call and one a
 * buyer can never make. Privy denies by default, so attaching it would grant a call this
 * wallet must not make while granting nothing it needs — the README-role-hash trap again.
 * `does not attach the seller wallet policy` is the test that says so.
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
import { createDisabledPrivyVerifier, setPrivyVerifier } from '../src/services/privy.js';

let h: Harness;

afterEach(() => {
  h.restore();
});

const ARC = '0x1c755e95cb11e5d5af498bb0ea595b56e1adb035';
const OTHER_ARC = '0xa25796399a9b3e8006d2d45ff48a3b830c7f020b';

describe('POST /v1/buyers', () => {
  beforeEach(async () => {
    h = await createHarness();
  });

  const signIn = (headers = signedIn()) => call(h.app, 'POST', '/v1/buyers', { headers, body: {} });

  it('creates a buyer with 201 from the token alone', async () => {
    const res = await signIn();

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.buyer.email).toBe('ada@meridian.example');
    expect(res.body.buyer.arcAddress).toBe(ARC);
    expect(res.body.buyer.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  /*
   * The harness seeds four desks, and a new sign-in must not collide with any of them. That
   * is the state a real first sign-in arrives in — a book that already has buyers in it —
   * rather than the empty table the route would pass against trivially.
   */
  it('adds a desk beside the seeded ones rather than matching one', async () => {
    const before = h.store.buyers.size;
    expect(before).toBeGreaterThan(0);

    const res = await signIn();

    expect(res.status).toBe(201);
    expect(h.store.buyers.size).toBe(before + 1);
  });

  /*
   * A wallet made from an email address has an address but no Hedera account: the address is
   * an alias, and the account behind it exists only once something funds it. Null here is a
   * fact about Hedera, not a missing write — and on this side it is why a desk cannot settle
   * over the x402 rail until it has one.
   */
  it('records the Arc address without inventing a Hedera account id', async () => {
    const res = await signIn();
    expect(res.body.buyer.arcAddress).toBe(ARC);
    expect(res.body.buyer.hederaAccountId).toBeNull();
  });

  it('signs an existing buyer back in with 200 rather than creating a second', async () => {
    const first = await signIn();
    const second = await signIn();

    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.buyer.id).toBe(first.body.buyer.id);
  });

  /* Signing in from a device that had no wallet yet, then from one that does. */
  it('fills a wallet address the first sign-in did not carry', async () => {
    setPrivyVerifier(stubPrivy({ walletAddress: null }));
    const first = await signIn();
    expect(first.body.buyer.arcAddress).toBeNull();

    setPrivyVerifier(stubPrivy({ walletAddress: ARC }));
    const filled = await signIn();
    expect(filled.status).toBe(200);
    expect(filled.body.buyer.arcAddress).toBe(ARC);
  });

  /*
   * The rule this route exists to hold. A verified token proves who signed in; it does not
   * prove the wallet now on that account is the one this desk's capital is posted from, and
   * the vault's binding cannot be corrected afterwards.
   */
  it('answers 409 when a later token carries a different wallet', async () => {
    const created = await signIn();
    expect(created.body.buyer.arcAddress).toBe(ARC);

    setPrivyVerifier(stubPrivy({ walletAddress: OTHER_ARC }));
    const rebind = await signIn();

    expect(rebind.status).toBe(409);
    expect(rebind.body.code).toBe('conflict');
    expect(rebind.body.detail).toContain('where a buyer funds mandates from');

    const after = await h.store.getBuyerByEmail('ada@meridian.example');
    expect(after?.arcAddress).toBe(ARC);
  });

  /* Same wallet in another casing is the same wallet — a sign-in, not an attack. */
  it('accepts the same address in another casing as a no-op', async () => {
    await signIn();

    setPrivyVerifier(stubPrivy({ walletAddress: ARC.toUpperCase().replace('0X', '0x') }));
    const again = await signIn();

    expect(again.status).toBe(200);
    expect(again.body.buyer.arcAddress).toBe(ARC);
  });

  /* A token with no wallet says nothing about the address on file, and must not clear it. */
  it('does not clear a recorded address when a later token carries none', async () => {
    await signIn();

    setPrivyVerifier(stubPrivy({ walletAddress: null }));
    const again = await signIn();

    expect(again.status).toBe(200);
    expect(again.body.buyer.arcAddress).toBe(ARC);
  });

  /* Two capitalisations of one address are one desk, not two sets of mandates. */
  it('treats a differently-cased email as the same buyer', async () => {
    const first = await signIn();

    setPrivyVerifier(stubPrivy({ email: 'ADA@Meridian.Example' }));
    const second = await signIn();

    expect(second.status).toBe(200);
    expect(second.body.buyer.id).toBe(first.body.buyer.id);
  });

  it('derives a desk name from the verified email, not from the caller', async () => {
    const res = await signIn();
    expect(res.body.buyer.name).toBe('Meridian');
  });

  /*
   * A desk that arrived by a person signing in is a human desk, and the column that marks an
   * agent-operated one is left null. Fake liquidity is the one thing that would undo the
   * whole argument, so an agent is never disguised as a human — and a human is never
   * labelled an agent by a route that cannot know either way.
   */
  it('does not mark a signed-in desk as agent-operated', async () => {
    const res = await signIn();
    const row = h.store.buyers.get(res.body.buyer.id);
    expect(row?.agentPolicy).toBeNull();
  });

  /*
   * `agentPolicy` is deliberately absent from the wire. A field the API publishes and the
   * screen discards is how `escrowVerified` came to tell every buyer the capital was
   * escrowed when nothing had checked it — and this particular field says whether the
   * liquidity on the other side of a trade is a person, which is the last thing that should
   * reach a client that has no code to render it.
   */
  it('does not publish the agent policy on the wire', async () => {
    const res = await signIn();

    expect(Object.keys(res.body).sort()).toEqual(['buyer', 'created']);
    expect(Object.keys(res.body.buyer).sort()).toEqual([
      'arcAddress',
      'createdAt',
      'email',
      'hederaAccountId',
      'id',
      'name',
    ]);
  });
});

/**
 * The policy that is deliberately not attached.
 *
 * `routes/sellers.ts` scopes the wallet a sign-in arrives with, and the obvious thing to do
 * on this route is copy the call. It would be the wrong policy: `sellerWalletPolicySpec`
 * permits `claim` on `DvpEscrow`, which is how a **seller** collects an Arc-rail payout, and
 * `claim` checks `msg.sender == beneficiary`. A buyer is never the beneficiary.
 *
 * Privy denies by default, which is what turns a harmless-looking copy into a real fault:
 * the wallet would hold permission for a call it can never legitimately make, and be denied
 * the one it exists to make — funding a mandate. That is this codebase's README-role-hash
 * trap, a grant that succeeds and authorises nothing.
 *
 * So this is asserted rather than left to the absence of a line. A configured policy client
 * that is never consulted is a stronger statement than no policy client at all, because it
 * would have recorded the call had one been made.
 */
describe('POST /v1/buyers and the wallet policy', () => {
  it('does not attach the seller wallet policy', async () => {
    const policies = recordingPolicyClient();
    h = await createHarness({ policies });

    const res = await call(h.app, 'POST', '/v1/buyers', { headers: signedIn(), body: {} });

    expect(res.status).toBe(201);
    expect(policies.attached).toEqual([]);
  });

  /* Nor on a returning sign-in, where the seller route scopes a second time. */
  it('does not attach it on a returning sign-in either', async () => {
    const policies = recordingPolicyClient();
    h = await createHarness({ policies });

    await call(h.app, 'POST', '/v1/buyers', { headers: signedIn(), body: {} });
    const second = await call(h.app, 'POST', '/v1/buyers', { headers: signedIn(), body: {} });

    expect(second.status).toBe(200);
    expect(policies.attached).toEqual([]);
  });
});

describe('POST /v1/buyers — the credential', () => {
  beforeEach(async () => {
    h = await createHarness();
  });

  it('refuses with 401 when no Authorization header is sent', async () => {
    const res = await call(h.app, 'POST', '/v1/buyers', { body: {} });
    expect(res.status).toBe(401);
    expect(res.body.detail).toContain('Privy identity token');
  });

  it.each([
    ['a bare token with no scheme', VALID_ID_TOKEN],
    ['the wrong scheme', `Basic ${VALID_ID_TOKEN}`],
    ['Bearer with nothing after it', 'Bearer'],
    ['an empty header', ''],
  ])('refuses %s before asking Privy anything', async (_label, authorization) => {
    const res = await call(h.app, 'POST', '/v1/buyers', {
      headers: { authorization },
      body: {},
    });
    expect(res.status).toBe(401);
    expect(res.body.detail).toContain('Authorization: Bearer');
  });

  it('refuses a token Privy will not verify', async () => {
    const res = await call(h.app, 'POST', '/v1/buyers', {
      headers: signedIn('a-token-from-somewhere-else'),
      body: {},
    });
    expect(res.status).toBe(401);
  });

  /*
   * Privy documents the identity token payload as possibly incomplete. A token that verifies
   * but carries no email cannot identify a buyer here, and saying so is better than
   * inventing one — an emailless row would claim the identity of every other emailless desk,
   * because email is the unique key this table is built on.
   */
  it('refuses a verified token that carries no email', async () => {
    setPrivyVerifier(stubPrivy({ email: '' }));

    const res = await call(h.app, 'POST', '/v1/buyers', { headers: signedIn(), body: {} });
    expect(res.status).toBe(401);
    expect(res.body.detail).toContain('a buyer is identified by email here');
  });

  /* A refused sign-in writes nothing. Half a desk is not a state this table may hold. */
  it('creates no row when the token carries no email', async () => {
    const before = h.store.buyers.size;
    setPrivyVerifier(stubPrivy({ email: '' }));

    await call(h.app, 'POST', '/v1/buyers', { headers: signedIn(), body: {} });

    expect(h.store.buyers.size).toBe(before);
  });

  /*
   * The whole point. With no Privy credentials there is no way to verify anyone, so the route
   * refuses rather than falling back to believing a caller — which would be reachable only
   * where configuration was forgotten.
   */
  it('refuses entirely when Privy is not configured, rather than trusting the caller', async () => {
    setPrivyVerifier(createDisabledPrivyVerifier());

    const res = await call(h.app, 'POST', '/v1/buyers', { headers: signedIn(), body: {} });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('PRIVY_APP_ID');
  });
});

describe('GET /v1/buyers/:id', () => {
  beforeEach(async () => {
    h = await createHarness();
  });

  it('returns the buyer a sign-in produced', async () => {
    const created = await call(h.app, 'POST', '/v1/buyers', { headers: signedIn(), body: {} });
    const res = await call(h.app, 'GET', `/v1/buyers/${created.body.buyer.id}`);

    expect(res.status).toBe(200);
    expect(res.body.buyer.email).toBe('ada@meridian.example');
    expect(res.body.buyer.arcAddress).toBe(ARC);
  });

  /* A seeded desk reads back the same way as a signed-in one; there is one buyer resource. */
  it('returns a seeded desk too', async () => {
    const id = h.seeded.buyerIds['BUY-HARROW'] ?? '';
    const res = await call(h.app, 'GET', `/v1/buyers/${id}`);

    expect(res.status).toBe(200);
    expect(res.body.buyer.email).toBe('ops@harrowpoint.example');
  });

  it('answers 404 for an id nobody has', async () => {
    const res = await call(h.app, 'GET', '/v1/buyers/9f1c6f1e-0000-4000-8000-000000000001');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });

  it('answers 422 for an id that is not a UUID', async () => {
    const res = await call(h.app, 'GET', '/v1/buyers/not-a-uuid');
    expect(res.status).toBe(422);
  });
});
