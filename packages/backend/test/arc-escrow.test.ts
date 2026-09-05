/**
 * A mandate's cash leg: opening it, funding it against capital that exists, and closing it.
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
 *
 * Either end of that life had a hole in it, and both were the same shape — a vault function
 * with a definition, a comment and no caller:
 *
 * - **`registerMandate` had none**, so `deposit` reverted `MandateNotRegistered` and no mandate
 *   written through the API could ever be escrowed. A provisioning script picked them up
 *   between rehearsals; anything created in between was stuck.
 * - **`executeRelease` had none, and was not even in the ABI**, so "withdraw unallocated
 *   capital" moved a SQLite row and real USDC in the vault had no path out of the contract.
 *
 * What these tests hold down is mostly what the venue must NOT do: bind an address nobody can
 * be shown to hold, overwrite a binding that is permanent, release more than the book gave
 * back, or let a chain that is down cost a business act it has no business costing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, createHarness, fakeArcEscrow, type Harness, type JsonBody } from './helpers.js';
import {
  createDisabledArcEscrow,
  payableArcAddress,
  releaseAuthId,
  usdcRequiredFor,
  vaultMandateId,
  type ArcEscrow,
} from '../src/services/arc.js';

let h: Harness;

afterEach(() => {
  h.restore();
});

/**
 * Parts-per-million scale these tests convert at, matching the deployment default.
 *
 * Written out rather than imported so the arithmetic below is readable on the page: at 1 ppm
 * a USD amount in cents becomes USDC minor units by dividing by 100, because the decimals
 * shift multiplies by 10^4 and the scale divides by 10^6. So $50,000.00 — 5,000,000 cents —
 * needs 50,000 USDC minor units, which is 0.05 USDC.
 */
const SCALE_PPM = 1;

/** USDC minor units needed to back `amountMinor` US cents. Spelled out at each call site. */
const needs = (amountMinor: bigint): bigint => usdcRequiredFor(amountMinor, 'USD', SCALE_PPM);

/**
 * A vault holding exactly `deposited` USDC minor units for every mandate.
 *
 * `requiredFor` delegates to the service's own conversion rather than reimplementing it. A
 * stub that converted independently could agree with a broken service and disagree with a
 * fixed one, which is how the original defect stayed invisible: the numbers matched.
 */
function stubVault(deposited: bigint): ArcEscrow {
  return fakeArcEscrow({
    depositedFor: () => Promise.resolve(deposited),
    buyerOf: () => Promise.resolve('0x1c755e95cb11e5d5af498bb0ea595b56e1adb035'),
  });
}

async function draftMandate(): Promise<string> {
  const res = await call(h.app, 'POST', '/v1/mandates', {
    body: {
      buyerId: h.seeded.buyerIds['BUY-ASHGROVE'] ?? '',
      ratingFloor: 'B',
      maxTenorDays: 60,
      annualisedYieldBps: 850,
      currency: 'USD',
      exposureLimitMinor: '50000000',
    },
  });
  expect(res.status).toBe(201);
  return res.body.mandate.id as string;
}

describe('funding with a vault configured', () => {
  it('credits capital the vault actually holds', async () => {
    // 0.05 USDC, exactly what $50,000.00 converts to. Funding the cent above would refuse.
    h = await createHarness({ arc: stubVault(needs(5_000_000n)) });
    const id = await draftMandate();

    const res = await call(h.app, 'POST', `/v1/mandates/${id}/fund`, {
      body: { amountMinor: '5000000', escrowRef: '0xdeadbeef' },
    });

    expect(res.status).toBe(200);
    expect(res.body.mandate.committed).toBe('5000000');
    expect(res.body.quoting).toBe(true);
    expect(res.body.escrowVerified).toBe(true);
  });

  /*
   * The whole point, kept: a claim about someone else's ledger is not capital.
   *
   * It is now kept by the state rather than by a refusal. The commitment is recorded — so the
   * buyer does not have to re-state an amount they have already given once their deposit
   * lands — and the mandate sits in `funding`, which is not a status the book quotes. What
   * must never happen is a bid on the curve backed by a request body, and that is what
   * `quoting: false` is asserting.
   */
  it('parks an unbacked funding rather than putting it on the curve', async () => {
    // One USDC minor unit short of backing $50,000.00.
    h = await createHarness({ arc: stubVault(needs(5_000_000n) - 1n) });
    const id = await draftMandate();

    const res = await call(h.app, 'POST', `/v1/mandates/${id}/fund`, {
      body: { amountMinor: '5000000', escrowRef: '0xdeadbeef' },
    });

    expect(res.status).toBe(200);
    expect(res.body.mandate.status).toBe('funding');
    expect(res.body.quoting).toBe(false);
    expect(res.body.escrow.state).toBe('short');
    expect(res.body.message).toContain('the vault holds');

    const after = await call(
      h.app,
      'GET',
      `/v1/mandates?buyerId=${h.seeded.buyerIds['BUY-ASHGROVE']}`,
    );
    const mandate = after.body.mandates.find((m: { id: string }) => m.id === id);
    expect(mandate.committed).toBe('5000000');
    expect(mandate.quoting).toBe(false);
  });

  /*
   * The other half of the same rule, and the one that makes the state worth having: funding
   * again is how a parked bid gets re-checked, and it goes live the moment the money is there.
   */
  it('promotes a parked bid once the deposit lands', async () => {
    let deposited = 0n;
    h = await createHarness({
      arc: fakeArcEscrow({
        depositedFor: () => Promise.resolve(deposited),
        buyerOf: () => Promise.resolve('0x1c755e95cb11e5d5af498bb0ea595b56e1adb035'),
      }),
    });
    const id = await draftMandate();

    const parked = await call(h.app, 'POST', `/v1/mandates/${id}/fund`, {
      body: { amountMinor: '5000000', escrowRef: '0xdeadbeef' },
    });
    expect(parked.body.mandate.status).toBe('funding');

    deposited = needs(5_000_000n);

    // Zero more capital: the amount was already committed, and what changed is the vault.
    const live = await call(h.app, 'POST', `/v1/mandates/${id}/fund`, {
      body: { amountMinor: '0', escrowRef: '0xdeadbeef' },
    });

    expect(live.status).toBe(200);
    expect(live.body.mandate.status).toBe('active');
    expect(live.body.mandate.committed).toBe('5000000');
    expect(live.body.quoting).toBe(true);
  });

  /*
   * An indeterminate answer must not make a bid firm. The parallel is the compliance gate
   * rather than the settlement rail: a bid going live is a price appearing on the curve, and
   * a price must never move on a read that failed.
   */
  it('does not go live on a vault that could not be read', async () => {
    h = await createHarness({
      arc: fakeArcEscrow({ depositedFor: () => Promise.reject(new Error('rpc down')) }),
    });
    const id = await draftMandate();

    const res = await call(h.app, 'POST', `/v1/mandates/${id}/fund`, {
      body: { amountMinor: '5000000', escrowRef: '0xdeadbeef' },
    });

    expect(res.status).toBe(200);
    expect(res.body.mandate.status).toBe('funding');
    expect(res.body.escrow.state).toBe('unreadable');
    expect(res.body.escrowVerified).toBe(false);
  });

  /*
   * Funding twice must compare against the running total, not each request in isolation.
   * Two deposits of the vault's whole balance are one overdraw, and checking them
   * independently would wave both through.
   */
  it('compares the running total against the vault, not one request at a time', async () => {
    // Backs $30,000 once. Two of them is $60,000 and the vault has not grown.
    h = await createHarness({ arc: stubVault(needs(3_000_000n)) });
    const id = await draftMandate();

    const first = await call(h.app, 'POST', `/v1/mandates/${id}/fund`, {
      body: { amountMinor: '3000000', escrowRef: '0xone' },
    });
    expect(first.status).toBe(200);

    /*
     * Refused rather than parked, and that is the one case that still is: the first funding
     * made this bid firm, and the machine has no `active -> funding` to demote it into. So
     * there is nowhere to put an unverifiable top-up except on the curve, which is exactly
     * what must not happen.
     */
    const second = await call(h.app, 'POST', `/v1/mandates/${id}/fund`, {
      body: { amountMinor: '3000000', escrowRef: '0xtwo' },
    });
    expect(second.status).toBe(400);
    expect(second.body.detail).toContain('the vault holds');
  });

  it('quotes nothing when the vault holds nothing', async () => {
    h = await createHarness({ arc: stubVault(0n) });
    const id = await draftMandate();

    const res = await call(h.app, 'POST', `/v1/mandates/${id}/fund`, {
      body: { amountMinor: '1', escrowRef: '0xdeadbeef' },
    });
    expect(res.status).toBe(200);
    expect(res.body.mandate.status).toBe('funding');
    expect(res.body.quoting).toBe(false);
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
    h = await createHarness({ arc: stubVault(needs(5_000_000n)) });
    const id = await draftMandate();
    await fund(id, '5000000');

    const mandate = (await mandates()).find((m: { id: string }) => m.id === id);
    expect(mandate.escrow).toEqual({
      state: 'backed',
      checked: true,
      depositedUsdcMinor: '50000',
      requiredUsdcMinor: '50000',
      backed: true,
    });
  });

  /*
   * The arithmetic, pinned as a literal rather than computed, because the digits are the
   * whole finding: $50,000.00 is 5,000,000 US cents and 0.05 USDC is 50,000 USDC minor
   * units, and the two were compared as though they were one number.
   *
   * A change to the conversion should fail here and be argued for, not land quietly — every
   * mandate's funded status moves with it.
   */
  it('converts dollars to USDC rather than comparing the digits', async () => {
    h = await createHarness({ arc: stubVault(needs(5_000_000n)) });
    const id = await draftMandate();
    await fund(id, '5000000');

    const mandate = (await mandates()).find((m: { id: string }) => m.id === id);
    expect(mandate.committed).toBe('5000000');
    expect(mandate.escrow.requiredUsdcMinor).toBe('50000');
  });

  /*
   * The regression, stated as the case that used to be wrong. 0.1 USDC genuinely backs a
   * $50,000 mandate at this scale, and the old comparison called it unbacked because
   * 100,000 is less than 5,000,000 — the same two scales confused, in the direction that
   * accuses a funded buyer rather than the one that flatters an unfunded one.
   */
  it('backs a mandate whose deposit the old digit comparison would have rejected', async () => {
    h = await createHarness({ arc: stubVault(100_000n) });
    const id = await draftMandate();
    await fund(id, '5000000');

    const mandate = (await mandates()).find((m: { id: string }) => m.id === id);
    expect(mandate.escrow.backed).toBe(true);
  });

  /*
   * The distinction the flag exists for. A seeded mandate counted as holding capital the
   * vault never received is precisely the overclaim the funding check refuses, and it must
   * not read as funded just because *some* capital is there.
   */
  it('does not call a partially deposited mandate backed', async () => {
    // 0.001 USDC against a mandate needing 0.05 — a fiftieth of its capital.
    h = await createHarness({ arc: stubVault(1_000n) });
    const id = await draftMandate();
    // Funded before the vault was consulted — how every seeded mandate got its balance.
    await h.store.fundMandate({
      mandateId: id,
      amount: 5_000_000n,
      escrowRef: 'escrow:seeded',
      at: new Date(),
      // Firm without the vault having been asked, which is exactly the state a seeded
      // mandate is in — and the point of the case: `active` does not imply `backed`.
      firm: true,
    });

    const mandate = (await mandates()).find((m: { id: string }) => m.id === id);
    expect(mandate.escrow.depositedUsdcMinor).toBe('1000');
    expect(mandate.escrow.requiredUsdcMinor).toBe('50000');
    expect(mandate.escrow.backed).toBe(false);
  });

  /* "We could not check" must never render as "nobody posted this". */
  it('answers null rather than zero when the vault cannot be read', async () => {
    h = await createHarness({
      arc: fakeArcEscrow({ depositedFor: () => Promise.reject(new Error('rpc down')) }),
    });
    const id = await draftMandate();

    const mandate = (await mandates()).find((m: { id: string }) => m.id === id);
    expect(mandate.escrow).toEqual({
      state: 'unreadable',
      checked: true,
      depositedUsdcMinor: null,
      requiredUsdcMinor: '0',
      backed: false,
    });
  });

  it('says it did not check when no vault is configured', async () => {
    h = await createHarness({ arc: createDisabledArcEscrow() });
    const id = await draftMandate();

    const mandate = (await mandates()).find((m: { id: string }) => m.id === id);
    expect(mandate.escrow).toEqual({
      state: 'not-required',
      checked: false,
      depositedUsdcMinor: null,
      requiredUsdcMinor: '0',
      backed: false,
    });
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

/**
 * The buyer whose Arc address is real.
 *
 * Harrow Point's is the Circle wallet the agent operates, and it is lowercase, which viem's
 * strict `isAddress` accepts — an unchecksummed address is unchecked, not wrong. Every other
 * seeded buyer carries an invented one, and `seed.ts` says so.
 */
const HARROW_ARC = '0x1c755e95cb11e5d5af498bb0ea595b56e1adb035';

/** The same twenty bytes, checksummed, as a chain call would answer them. */
const HARROW_ARC_CHECKSUMMED = '0x1C755e95CB11E5D5aF498bb0EA595b56e1adb035';

/** Ashgrove Treasury's, invented and mixed-case, so it fails its EIP-55 checksum. */
const INVENTED_ARC = '0x9C41f5A8B2e70dD3c1A4e88F6b0C25dE7a913F04';

/**
 * A vault that answers, and remembers every write it was asked for.
 *
 * The assertion that matters on this path is usually the ABSENCE of a write: `registerMandate`
 * is one-shot and `executeRelease` moves real money, so "it did not send" is the property, and
 * a fake that only returned success could not express it.
 */
function recordingVault(overrides: Partial<ArcEscrow> = {}): {
  vault: ArcEscrow;
  registered: { mandateUuid: string; buyer: string }[];
  released: { mandateUuid: string; amountUsdcMinor: bigint }[];
} {
  const registered: { mandateUuid: string; buyer: string }[] = [];
  const released: { mandateUuid: string; amountUsdcMinor: bigint }[] = [];
  const vault = fakeArcEscrow({
    registerMandate: (mandateUuid, buyer) => {
      registered.push({ mandateUuid, buyer });
      return Promise.resolve({ transactionHash: '0xregistered' });
    },
    executeRelease: (input) => {
      released.push(input);
      return Promise.resolve({ transactionHash: '0xreleased', authId: '0xauth' });
    },
    ...overrides,
  });
  return { vault, registered, released };
}

const createMandate = async (buyerLabel: string): Promise<JsonBody> =>
  call(h.app, 'POST', '/v1/mandates', {
    body: {
      buyerId: h.seeded.buyerIds[buyerLabel] ?? '',
      ratingFloor: 'B',
      maxTenorDays: 60,
      annualisedYieldBps: 850,
      currency: 'USD',
      exposureLimitMinor: '50000000',
    },
  });

describe('opening a mandate cash leg', () => {
  /*
   * The finding, stated as the behaviour that closes it. Without this call the vault refuses
   * the buyer's deposit outright, so the mandate is not merely unfunded — it is unfundable,
   * and every quote it would have made would have been backed by nothing.
   */
  it('registers the mandate on the vault when it is written', async () => {
    const { vault, registered } = recordingVault();
    h = await createHarness({ arc: vault });

    const res = await createMandate('BUY-HARROW');

    expect(res.status).toBe(201);
    expect(res.body.escrowRegistration.state).toBe('registered');
    expect(registered).toEqual([{ mandateUuid: res.body.mandate.id, buyer: HARROW_ARC }]);
  });

  /*
   * `registerMandate` reverts `MandateAlreadyRegistered` on a second call and there is no
   * update path, so asking first is the only way to tell a re-run from a first attempt without
   * spending a transaction to be told.
   */
  it('does not write again when the binding is already there', async () => {
    const { vault, registered } = recordingVault({
      // Checksummed, as a chain answers; the row holds it lowercase. Same twenty bytes.
      buyerOf: () => Promise.resolve(HARROW_ARC_CHECKSUMMED),
    });
    h = await createHarness({ arc: vault });

    const res = await createMandate('BUY-HARROW');

    expect(res.body.escrowRegistration.state).toBe('already-registered');
    expect(registered).toEqual([]);
  });

  /*
   * The binding is permanent and it names the ONLY address a release may ever pay. An invented
   * one is not a mistake anyone can correct — it is capital with a way in and no way out — so
   * refusing to register is strictly better than registering: the vault then refuses the
   * deposit too, and the money never gets in to be stranded.
   */
  it('refuses an address that fails its checksum rather than binding it forever', async () => {
    const { vault, registered } = recordingVault();
    h = await createHarness({ arc: vault });

    const res = await createMandate('BUY-ASHGROVE');

    expect(res.status).toBe(201);
    expect(res.body.escrowRegistration.state).toBe('unpayable');
    expect(res.body.escrowRegistration.detail).toContain('EIP-55');
    expect(registered).toEqual([]);
  });

  /* A vault bound to somebody else is a fact to report, never a write to attempt. */
  it('reports a binding to a different address instead of trying to correct it', async () => {
    const { vault, registered } = recordingVault({
      buyerOf: () => Promise.resolve(INVENTED_ARC),
    });
    h = await createHarness({ arc: vault });

    const res = await createMandate('BUY-HARROW');

    expect(res.body.escrowRegistration.state).toBe('bound-elsewhere');
    expect(res.body.escrowRegistration.buyer).toBe(INVENTED_ARC);
    expect(registered).toEqual([]);
  });

  /*
   * Writing a bid is a business act. A vault that cannot be reached costs the registration and
   * must not cost the mandate — the same trade `services/uniqueness.ts` makes when the registry
   * is down, where `checked: false` is deliberately not `claimed: false`.
   */
  it('still writes the mandate when the vault cannot be read', async () => {
    const { vault, registered } = recordingVault({
      buyerOf: () => Promise.reject(new Error('rpc down')),
    });
    h = await createHarness({ arc: vault });

    const res = await createMandate('BUY-HARROW');

    expect(res.status).toBe(201);
    expect(res.body.escrowRegistration.state).toBe('unavailable');
    expect(res.body.escrowRegistration.detail).toContain('rpc down');
    expect(registered).toEqual([]);

    const stored = await h.store.getMandate(res.body.mandate.id as string);
    expect(stored).not.toBeNull();
  });

  it('still writes the mandate when the registration itself reverts', async () => {
    const { vault } = recordingVault({
      registerMandate: () => Promise.reject(new Error('reverted on Arc')),
    });
    h = await createHarness({ arc: vault });

    const res = await createMandate('BUY-HARROW');

    expect(res.status).toBe(201);
    expect(res.body.escrowRegistration.state).toBe('unavailable');
  });

  it('says there is no cash leg at all when no vault is configured', async () => {
    h = await createHarness({ arc: createDisabledArcEscrow() });

    const res = await createMandate('BUY-HARROW');

    expect(res.status).toBe(201);
    expect(res.body.escrowRegistration.state).toBe('disabled');
    expect(res.body.escrowRegistration.detail).toContain('ARC_MANDATE_VAULT_ADDRESS');
  });

  /*
   * The repair, and the reason it is worth a view call on a route that already reads the
   * vault: a buyer whose deposit reverted is otherwise told only that "the vault holds 0",
   * which is true and sends them to look at their wallet instead of at the registration.
   */
  it('registers a mandate that missed its first attempt, and says why funding failed', async () => {
    const { vault, registered } = recordingVault();
    h = await createHarness({ arc: vault });
    // Written straight to the store, as a mandate created while the chain was unreachable is.
    const mandate = await h.store.insertMandate({
      buyerId: h.seeded.buyerIds['BUY-HARROW'] ?? '',
      ratingFloor: 'B',
      maxTenorDays: 60,
      annualisedYieldBps: 850,
      currency: 'USD',
      exposureLimitMinor: 50_000_000n,
      perDebtorLimitMinor: null,
      status: 'draft',
    });

    const res = await call(h.app, 'POST', `/v1/mandates/${mandate.id}/fund`, {
      body: { amountMinor: '5000000', escrowRef: '0xdeadbeef' },
    });

    // This bid cannot go live — the deposit had to come first and could not have — but the
    // next call can put it there, and the message says which of the two problems the buyer
    // has. Being told only "the vault holds 0" sends them to look at their wallet instead of
    // at the registration that was never written.
    expect(res.status).toBe(200);
    expect(res.body.mandate.status).toBe('funding');
    expect(res.body.message).toContain('can be funded');
    expect(registered).toEqual([{ mandateUuid: mandate.id, buyer: HARROW_ARC }]);
  });
});

describe('closing a mandate cash leg', () => {
  /** A funded mandate belonging to the one buyer with a real address. */
  async function fundedMandate(committedMinor: bigint): Promise<string> {
    const created = await createMandate('BUY-HARROW');
    const id = created.body.mandate.id as string;
    /*
     * Funded straight through the store rather than through the route: what is under test here
     * is the release, and going via `POST /fund` would make every case depend on the funding
     * check's own arithmetic as well.
     */
    await h.store.fundMandate({
      mandateId: id,
      amount: committedMinor,
      escrowRef: 'escrow:test',
      at: new Date(),
      firm: true,
    });
    return id;
  }

  const withdraw = (id: string, amountMinor?: string) =>
    call(h.app, 'POST', `/v1/mandates/${id}/withdraw`, {
      body: amountMinor === undefined ? {} : { amountMinor },
    });

  /* The finding: the book gave the capacity back and the money never moved. */
  it('returns the USDC, converted out of the mandate own units', async () => {
    const { vault, released } = recordingVault({
      buyerOf: () => Promise.resolve(HARROW_ARC_CHECKSUMMED),
      depositedFor: () => Promise.resolve(needs(5_000_000n)),
    });
    h = await createHarness({ arc: vault });
    const id = await fundedMandate(5_000_000n);

    const res = await withdraw(id, '5000000');

    expect(res.status).toBe(200);
    expect(res.body.withdrawn).toBe('5000000');
    expect(res.body.release.state).toBe('released');
    // $50,000.00 is 5,000,000 US cents and 50,000 USDC minor units. The two are not one
    // number, which is the defect this conversion exists to close.
    expect(res.body.release.amountUsdcMinor).toBe('50000');
    expect(released).toEqual([{ mandateUuid: id, amountUsdcMinor: 50_000n }]);
  });

  /*
   * Rounding, pinned as a literal because the direction is a decision rather than a detail.
   *
   * A release rounds DOWN where a backing requirement rounds up, and the pair is what keeps
   * `vaultBalance >= requiredFor(committed)` standing over the smaller book a withdrawal
   * leaves: `ceil(a) - floor(b) >= ceil(a - b)` for every remainder. Round the release up and
   * a mandate quoting real capital ends up standing on an empty vault.
   */
  it('rounds the release down, leaving the remainder as backing', async () => {
    const { vault, released } = recordingVault({
      buyerOf: () => Promise.resolve(HARROW_ARC),
      depositedFor: () => Promise.resolve(needs(5_000_100n)),
    });
    h = await createHarness({ arc: vault });
    const id = await fundedMandate(5_000_100n);

    // One cent past $50,000.00, which scales to 50,000.01 USDC minor units.
    await withdraw(id, '5000001');

    expect(released).toEqual([{ mandateUuid: id, amountUsdcMinor: 50_000n }]);
    // The same amount as a backing requirement rounds the other way, and must keep doing so.
    expect(needs(5_000_001n)).toBe(50_001n);
  });

  /* Below a whole USDC minor unit there is nothing to move, and `executeRelease` reverts on it. */
  it('sends nothing when the withdrawal scales below one USDC minor unit', async () => {
    const { vault, released } = recordingVault({
      buyerOf: () => Promise.resolve(HARROW_ARC),
      depositedFor: () => Promise.resolve(1_000n),
    });
    h = await createHarness({ arc: vault });
    const id = await fundedMandate(5_000_000n);

    const res = await withdraw(id, '99');

    expect(res.body.release.state).toBe('dust');
    expect(res.body.release.amountUsdcMinor).toBe('0');
    expect(released).toEqual([]);
  });

  /* Read before you write: the vault would revert, and a doomed transaction costs gas to be told. */
  it('does not send a release the vault cannot cover', async () => {
    const { vault, released } = recordingVault({
      buyerOf: () => Promise.resolve(HARROW_ARC),
      depositedFor: () => Promise.resolve(needs(5_000_000n) - 1n),
    });
    h = await createHarness({ arc: vault });
    const id = await fundedMandate(5_000_000n);

    const res = await withdraw(id, '5000000');

    expect(res.body.release.state).toBe('insufficient');
    expect(released).toEqual([]);
  });

  /*
   * `executeRelease` pays `buyerOf` and takes no recipient, which is the bound that stops a
   * compromised relay redirecting a buyer's capital. The other half is this: a vault bound to
   * an address the venue does not believe is the buyer's is one the venue declines to trigger,
   * because the alternative is moving their money to a stranger on their own instruction.
   */
  it('refuses to trigger a release toward an address that is not the buyer on file', async () => {
    const { vault, released } = recordingVault({
      buyerOf: () => Promise.resolve(INVENTED_ARC),
      depositedFor: () => Promise.resolve(needs(5_000_000n)),
    });
    h = await createHarness({ arc: vault });
    const id = await fundedMandate(5_000_000n);

    const res = await withdraw(id, '5000000');

    expect(res.body.release.state).toBe('bound-elsewhere');
    expect(res.body.release.buyer).toBe(INVENTED_ARC);
    expect(released).toEqual([]);
  });

  /*
   * The order, asserted as the invariant `IMandateVault` asks for: the attested balance must
   * never exceed the real one, so the book decrements first and a failed release leaves USDC
   * in the vault against a book that no longer quotes it. That is recoverable by funding
   * again; the reverse — a mandate quoting capital that has already left — is not.
   */
  it('does not un-withdraw the book when the release fails', async () => {
    const { vault } = recordingVault({
      buyerOf: () => Promise.resolve(HARROW_ARC),
      depositedFor: () => Promise.resolve(needs(5_000_000n)),
      executeRelease: () => Promise.reject(new Error('Arc did not confirm executeRelease in time')),
    });
    h = await createHarness({ arc: vault });
    const id = await fundedMandate(5_000_000n);

    const res = await withdraw(id, '5000000');

    expect(res.status).toBe(200);
    expect(res.body.withdrawn).toBe('5000000');
    expect(res.body.release.state).toBe('unavailable');
    // A timeout is not a revert, and the message must not claim nothing moved.
    expect(res.body.release.detail).toContain('did not confirm');

    const after = await h.store.getMandate(id);
    expect(after?.fundedMinor).toBe(0n);
  });

  /*
   * Only unallocated capital may leave. The store's lock is what refuses the withdrawal, and
   * what this pins is that the release cannot route around it — the vault is asked for exactly
   * what the book gave back and never for the committed total.
   */
  it('releases only what the book actually gave back', async () => {
    const { vault, released } = recordingVault({
      buyerOf: () => Promise.resolve(HARROW_ARC),
      depositedFor: () => Promise.resolve(needs(5_000_000n)),
    });
    h = await createHarness({ arc: vault });
    const id = await fundedMandate(5_000_000n);
    // Committed against a trade in flight, and therefore not the buyer's to pull.
    await h.store.allocate(id, 3_000_000n);

    // No amount: "everything unallocated", which is $20,000 of the $50,000 committed.
    const res = await withdraw(id);

    expect(res.body.withdrawn).toBe('2000000');
    expect(released).toEqual([{ mandateUuid: id, amountUsdcMinor: 20_000n }]);

    const refused = await withdraw(id, '3000000');
    expect(refused.status).toBe(409);
    expect(released).toHaveLength(1);
  });

  it('moves the book alone when no vault is configured', async () => {
    h = await createHarness({ arc: createDisabledArcEscrow() });
    const id = await fundedMandate(5_000_000n);

    const res = await withdraw(id, '5000000');

    expect(res.status).toBe(200);
    expect(res.body.withdrawn).toBe('5000000');
    expect(res.body.release.state).toBe('disabled');
  });

  it('refuses to release with no vault, naming the variable', async () => {
    await expect(
      createDisabledArcEscrow().executeRelease({ mandateUuid: 'any', amountUsdcMinor: 1n }),
    ).rejects.toMatchObject({
      detail: expect.stringContaining('ARC_MANDATE_VAULT_ADDRESS'),
    });
  });
});

describe('payableArcAddress', () => {
  /*
   * The same tripwire `scripts/demo-reset.mjs` uses, and it has to stay the same one: a route
   * and a provisioning script disagreeing about which addresses are real is how a binding
   * nobody can receive at gets written by whichever of the two is less careful.
   */
  it('accepts a real wallet, checksummed or lowercase', () => {
    expect(payableArcAddress(HARROW_ARC)).toEqual({ ok: true, address: HARROW_ARC });
    expect(payableArcAddress(HARROW_ARC_CHECKSUMMED).ok).toBe(true);
  });

  /* All three invented buyer addresses fail here, because they were typed rather than derived. */
  it('rejects a mixed-case address whose checksum was never computed', () => {
    expect(payableArcAddress(INVENTED_ARC).ok).toBe(false);
  });

  it('rejects the zero address by name rather than by revert', () => {
    const answer = payableArcAddress(`0x${'0'.repeat(40)}`);
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.reason).toContain('zero address');
  });

  it('rejects a missing address', () => {
    expect(payableArcAddress(null).ok).toBe(false);
    expect(payableArcAddress('').ok).toBe(false);
  });
});

describe('releaseAuthId', () => {
  /*
   * The one id on this path that is minted rather than derived. `MandateVault._consumed` makes
   * every authorisation single-use, so two withdrawals sharing an id would leave the second one
   * permanently refused — a buyer unable to take their own capital out.
   */
  it('is fresh on every call', () => {
    expect(releaseAuthId()).not.toBe(releaseAuthId());
  });

  it('is a bytes32 the vault will accept', () => {
    expect(releaseAuthId()).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
