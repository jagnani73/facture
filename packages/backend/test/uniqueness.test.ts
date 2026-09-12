/**
 * One receivable, one instrument — the on-chain half.
 *
 * The unique index in SQLite already stops *this* venue listing a receivable twice, and every
 * test of that behaviour still passes. What is tested here is the part the index cannot do:
 * noticing that the same invoice is already financed **somewhere else**, which is the fraud as
 * it actually happens. The second financier is a different company, not a second row in the
 * first one's table.
 *
 * Two things must not drift.
 *
 * **An unreadable registry is not a clean bill of health.** `checked: false` and
 * `claimed: false` are different answers, and collapsing them turns an RPC outage into a
 * confident "nobody has claimed this" on the one question the fraud argument rests on.
 *
 * **A failed claim must not fail an issuance.** The registry is an additional protection; a
 * seller whose invoice cannot be listed because a second guarantee was unavailable is worse
 * off than one protected by the first guarantee alone.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, createHarness, type Harness } from './helpers.js';
import {
  claimedByAnother,
  createDisabledUniquenessRegistry,
  type UniquenessRegistry,
} from '../src/services/uniqueness.js';

let h: Harness;

afterEach(() => {
  h.restore();
});

const OURS = '0xb50567e02baaf768c834b0663f539db43d5b34b0';
const THEIRS = '0x1f2cf9c8f259291cb667cf24956a8e0150c8bc2e';

/** A registry where every hash resolves to `instrument`, or to nothing when null. */
function stubRegistry(instrument: string | null): UniquenessRegistry {
  return {
    enabled: true,
    lookup: () => Promise.resolve({ checked: true, instrument }),
    claim: () => Promise.resolve({ transactionHash: '0xclaimed' }),
  };
}

const invoice = () => ({
  sellerId: h.seeded.sellerId,
  debtor: { name: 'Kestrel Provisioning', email: 'ap@kestrel.example' },
  invoiceNumber: 'MF-9001',
  faceValue: '5500000',
  currency: 'usd',
  issuedAt: '2026-09-01T00:00:00.000Z',
  dueAt: '2026-11-01T00:00:00.000Z',
});

describe('listing against the registry', () => {
  it('accepts a receivable nobody has claimed', async () => {
    h = await createHarness({ uniqueness: stubRegistry(null) });
    const res = await call(h.app, 'POST', '/v1/invoices', { body: invoice() });
    expect(res.status).toBe(202);
  });

  /* The fraud the registry exists for, and the one the unique index cannot see. */
  it('refuses a receivable another venue already financed', async () => {
    h = await createHarness({ uniqueness: stubRegistry(THEIRS) });

    const res = await call(h.app, 'POST', '/v1/invoices', { body: invoice() });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('duplicate_receivable');
  });

  /*
   * Falling back to the database's guarantee is correct; reporting it as "unclaimed" is not.
   * Failing closed instead would stop a business listing an invoice because a second,
   * additive protection was briefly unavailable.
   */
  it('still lists when the registry cannot be read', async () => {
    h = await createHarness({
      uniqueness: {
        enabled: true,
        lookup: () => Promise.resolve({ checked: false }),
        claim: () => Promise.resolve({ transactionHash: '0x' }),
      },
    });

    const res = await call(h.app, 'POST', '/v1/invoices', { body: invoice() });
    expect(res.status).toBe(202);
  });

  it('still lists when no registry is configured', async () => {
    h = await createHarness({ uniqueness: createDisabledUniquenessRegistry() });
    const res = await call(h.app, 'POST', '/v1/invoices', { body: invoice() });
    expect(res.status).toBe(202);
  });

  /* The venue's own index is unchanged, and is still the fast path. */
  it('still refuses the same receivable twice within this venue', async () => {
    h = await createHarness({ uniqueness: stubRegistry(null) });

    await call(h.app, 'POST', '/v1/invoices', { body: invoice() });
    const second = await call(h.app, 'POST', '/v1/invoices', { body: invoice() });

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('duplicate_receivable');
  });
});

describe('claiming after issuance', () => {
  /*
   * A registry that refuses the claim leaves the venue exactly where it was — its own unique
   * index — and a seller whose invoice became unlistable because a second, additive
   * protection was unavailable is worse off than one protected by the first alone.
   *
   * Worth a test rather than trust, because the claim happens inside the issuance sink: the
   * natural way to write that code is `await registry.claim(...)` with nothing around it, and
   * the failure would then surface as an invoice stuck in `issuing` for reasons nobody could
   * see from the row.
   */
  it('does not fail an issuance when the claim is refused', async () => {
    h = await createHarness({
      uniqueness: {
        enabled: true,
        lookup: () => Promise.resolve({ checked: true, instrument: null }),
        claim: () => Promise.reject(new Error('AlreadyClaimed')),
      },
    });

    const res = await call(h.app, 'POST', '/v1/invoices', { body: invoice() });
    expect(res.status).toBe(202);

    // The queue is serial and paced at 0ms in tests; let it drain.
    await new Promise((resolve) => setTimeout(resolve, 60));

    const invoiceId = res.body.invoice.id as string;
    const after = await call(h.app, 'GET', `/v1/invoices/${invoiceId}`);
    expect(after.body.invoice.issuance.state).not.toBe('failed');
  });
});

describe('claimedByAnother', () => {
  it('is false when the chain was never asked', () => {
    expect(claimedByAnother({ checked: false }, null)).toBe(false);
  });

  it('is false when nobody has claimed it', () => {
    expect(claimedByAnother({ checked: true, instrument: null }, null)).toBe(false);
  });

  it('is true when someone else holds it', () => {
    expect(claimedByAnother({ checked: true, instrument: THEIRS }, OURS)).toBe(true);
    expect(claimedByAnother({ checked: true, instrument: THEIRS }, null)).toBe(true);
  });

  /*
   * Our own claim is not somebody else's. Hex from a chain call and hex from `keccak256`
   * differ in case and mean the same address, which is why the comparison is
   * `sameReceivable` rather than `===` — a case-sensitive check would report the venue's own
   * instrument as a rival's and refuse a receivable it had itself issued.
   */
  it('is false for our own instrument, whatever the case', () => {
    expect(claimedByAnother({ checked: true, instrument: OURS.toUpperCase() }, OURS)).toBe(false);
    expect(claimedByAnother({ checked: true, instrument: OURS }, OURS.toUpperCase())).toBe(false);
  });
});

describe('with no registry configured', () => {
  beforeEach(async () => {
    h = await createHarness({ uniqueness: createDisabledUniquenessRegistry() });
  });

  it('answers "not checked" rather than "not claimed"', async () => {
    await expect(createDisabledUniquenessRegistry().lookup('0xabc')).resolves.toEqual({
      checked: false,
    });
  });

  it('refuses to claim, saying no registry is wired', async () => {
    await expect(createDisabledUniquenessRegistry().claim('0xabc', OURS)).rejects.toMatchObject({
      detail: expect.stringContaining('No uniqueness registry is wired'),
    });
  });
});
