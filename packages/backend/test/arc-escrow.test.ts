/**
 * Funding a mandate against capital that exists.
 *
 * The route's own comment has always said what it wanted to be — *"the escrow record is the
 * authority on how much landed, never the request body"* — and then said there was no escrow
 * provider, so the body was believed. `MandateVault` on Arc is that provider, and
 * `balanceOf` is a view, so checking costs no key and no gas.
 *
 * The failure this guards is not an exception. It is a mandate quoting capital nobody posted:
 * every price that mandate wins is then a price nobody can honour, which is the one thing the
 * product cannot afford, because the whole claim is that the quote a seller sees is firm.
 *
 * With no vault configured, funding stays recorded rather than verified — the behaviour the
 * README documents. `escrowVerified` on the response is how the two are told apart, so
 * "escrowed" is never something a reader has to assume.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, createHarness, type Harness } from './helpers.js';
import { createDisabledArcEscrow, vaultMandateId, type ArcEscrow } from '../src/services/arc.js';

let h: Harness;

afterEach(() => {
  h.restore();
});

/** A vault holding exactly `deposited` for every mandate. */
function stubVault(deposited: bigint): ArcEscrow {
  return {
    enabled: true,
    depositedFor: () => Promise.resolve(deposited),
    buyerOf: () => Promise.resolve('0x1c755e95cb11e5d5af498bb0ea595b56e1adb035'),
    registerMandate: () => Promise.resolve({ transactionHash: '0xabc' }),
  };
}

async function draftMandate(): Promise<string> {
  const res = await call(h.app, 'POST', '/v1/mandates', {
    body: {
      buyerId: h.seeded.buyerIds['BUY-ASHGROVE'] ?? '',
      ratingFloor: 'B',
      maxTenorDays: 60,
      annualisedYieldBps: 850,
      currency: 'USD',
      exposureLimitMinor: '5000000',
    },
  });
  expect(res.status).toBe(201);
  return res.body.mandate.id as string;
}

describe('funding with a vault configured', () => {
  it('credits capital the vault actually holds', async () => {
    h = await createHarness({ arc: stubVault(5_000_000n) });
    const id = await draftMandate();

    const res = await call(h.app, 'POST', `/v1/mandates/${id}/fund`, {
      body: { amountMinor: '5000000', escrowRef: '0xdeadbeef' },
    });

    expect(res.status).toBe(200);
    expect(res.body.mandate.committed).toBe('5000000');
    expect(res.body.quoting).toBe(true);
    expect(res.body.escrowVerified).toBe(true);
  });

  /* The whole point: a claim about someone else's ledger is not capital. */
  it('refuses to count more than the vault holds', async () => {
    h = await createHarness({ arc: stubVault(5_000_000n) });
    const id = await draftMandate();

    const res = await call(h.app, 'POST', `/v1/mandates/${id}/fund`, {
      body: { amountMinor: '200000000', escrowRef: '0xdeadbeef' },
    });

    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('the vault holds');

    const after = await call(
      h.app,
      'GET',
      `/v1/mandates?buyerId=${h.seeded.buyerIds['BUY-ASHGROVE']}`,
    );
    const mandate = after.body.mandates.find((m: { id: string }) => m.id === id);
    expect(mandate.committed).toBe('0');
    expect(mandate.quoting).toBe(false);
  });

  /*
   * Funding twice must compare against the running total, not each request in isolation.
   * Two deposits of the vault's whole balance are one overdraw, and checking them
   * independently would wave both through.
   */
  it('compares the running total against the vault, not one request at a time', async () => {
    h = await createHarness({ arc: stubVault(5_000_000n) });
    const id = await draftMandate();

    const first = await call(h.app, 'POST', `/v1/mandates/${id}/fund`, {
      body: { amountMinor: '3000000', escrowRef: '0xone' },
    });
    expect(first.status).toBe(200);

    const second = await call(h.app, 'POST', `/v1/mandates/${id}/fund`, {
      body: { amountMinor: '3000000', escrowRef: '0xtwo' },
    });
    expect(second.status).toBe(400);
  });

  it('refuses everything when the vault holds nothing', async () => {
    h = await createHarness({ arc: stubVault(0n) });
    const id = await draftMandate();

    const res = await call(h.app, 'POST', `/v1/mandates/${id}/fund`, {
      body: { amountMinor: '1', escrowRef: '0xdeadbeef' },
    });
    expect(res.status).toBe(400);
  });
});

describe('funding with no vault configured', () => {
  beforeEach(async () => {
    h = await createHarness({ arc: createDisabledArcEscrow() });
  });

  /*
   * Unchanged behaviour, and said out loud. A disabled vault reads as "nothing escrowed"
   * rather than throwing, so the route can ask without one — but that must not become a
   * refusal of all funding, and it must not silently look like verification either.
   */
  it('records the amount and says it was not verified', async () => {
    const id = await draftMandate();

    /*
     * Enough to be refused outright by a vault holding nothing, and inside the mandate's own
     * exposure limit so that what is being tested is the escrow check rather than the
     * unrelated ceiling the store already enforces.
     */
    const res = await call(h.app, 'POST', `/v1/mandates/${id}/fund`, {
      body: { amountMinor: '5000000', escrowRef: 'escrow-ref-from-somewhere' },
    });

    expect(res.status).toBe(200);
    expect(res.body.mandate.committed).toBe('5000000');
    expect(res.body.escrowVerified).toBe(false);
  });

  it('refuses to register a mandate, naming the variable', async () => {
    await expect(createDisabledArcEscrow().registerMandate('any', '0xabc')).rejects.toMatchObject({
      detail: expect.stringContaining('ARC_MANDATE_VAULT_ADDRESS'),
    });
  });
});

describe('which bids are backed', () => {
  const fund = async (id: string, amountMinor: string) =>
    call(h.app, 'POST', `/v1/mandates/${id}/fund`, { body: { amountMinor, escrowRef: '0xref' } });

  const mandates = async () =>
    (
      await call(h.app, 'GET', `/v1/mandates?buyerId=${h.seeded.buyerIds['BUY-ASHGROVE']}`)
    ).body.mandates.filter((m: { escrow?: unknown }) => m.escrow !== undefined);

  it('reports a fully deposited mandate as backed', async () => {
    h = await createHarness({ arc: stubVault(5_000_000n) });
    const id = await draftMandate();
    await fund(id, '5000000');

    const mandate = (await mandates()).find((m: { id: string }) => m.id === id);
    expect(mandate.escrow).toEqual({ checked: true, deposited: '5000000', backed: true });
  });

  /*
   * The distinction the flag exists for. A seeded mandate counted as holding capital the
   * vault never received is precisely the overclaim the funding check refuses, and it must
   * not read as funded just because *some* capital is there.
   */
  it('does not call a partially deposited mandate backed', async () => {
    h = await createHarness({ arc: stubVault(1_000_000n) });
    const id = await draftMandate();
    // Funded before the vault was consulted — how every seeded mandate got its balance.
    await h.store.fundMandate({
      mandateId: id,
      amount: 5_000_000n,
      escrowRef: 'escrow:seeded',
      at: new Date(),
    });

    const mandate = (await mandates()).find((m: { id: string }) => m.id === id);
    expect(mandate.escrow.deposited).toBe('1000000');
    expect(mandate.escrow.backed).toBe(false);
  });

  /* "We could not check" must never render as "nobody posted this". */
  it('answers null rather than zero when the vault cannot be read', async () => {
    h = await createHarness({
      arc: {
        enabled: true,
        depositedFor: () => Promise.reject(new Error('rpc down')),
        buyerOf: () => Promise.resolve(null),
        registerMandate: () => Promise.resolve({ transactionHash: '0x' }),
      },
    });
    const id = await draftMandate();

    const mandate = (await mandates()).find((m: { id: string }) => m.id === id);
    expect(mandate.escrow).toEqual({ checked: true, deposited: null, backed: false });
  });

  it('says it did not check when no vault is configured', async () => {
    h = await createHarness({ arc: createDisabledArcEscrow() });
    const id = await draftMandate();

    const mandate = (await mandates()).find((m: { id: string }) => m.id === id);
    expect(mandate.escrow).toEqual({ checked: false, deposited: null, backed: false });
  });
});

describe('vaultMandateId', () => {
  /*
   * The vault keys capital by uint256 and the venue keys mandates by UUID, so this is the
   * join between them. Stability is the property that matters: a derivation that moved would
   * point an existing mandate at an empty slot, and the mandate would read as unfunded.
   */
  it('is deterministic', () => {
    const uuid = '8b879d02-4593-4d66-82bf-52d4833401b6';
    expect(vaultMandateId(uuid)).toBe(vaultMandateId(uuid));
  });

  it('separates mandates that differ at all', () => {
    const a = vaultMandateId('8b879d02-4593-4d66-82bf-52d4833401b6');
    const b = vaultMandateId('8b879d02-4593-4d66-82bf-52d4833401b7');
    expect(a).not.toBe(b);
  });

  it('fits a uint256', () => {
    const id = vaultMandateId('8b879d02-4593-4d66-82bf-52d4833401b6');
    expect(id).toBeGreaterThan(0n);
    expect(id).toBeLessThan(2n ** 256n);
  });
});
