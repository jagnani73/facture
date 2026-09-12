/**
 * The on-chain record of what a receivable is, and whether its debtor confirmed it.
 *
 * The product's risk argument is specific: debtor confirmation removes dispute risk, and
 * removing dispute risk is what justifies advancing the **full** face value with no holdback.
 * Until this was recorded on chain, "the debtor confirmed" was a column only the venue could
 * see, and a buyer had to take our word for it.
 *
 * Two rules matter more than the happy path.
 *
 * **A registry that is down must never cost a debtor their answer.** The customer has already
 * acted; returning an error to someone who did nothing wrong because a node was unreachable
 * would be inexcusable, and it would also lose a real-world event the venue cannot recreate.
 *
 * **Nor must it cost a seller their issuance.** Same reasoning as the uniqueness claim: the
 * instrument exists and the invoice is real whether or not a second record of it landed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { call, createHarness, type Harness } from './helpers.js';
import {
  INVOICE_STATUS,
  createDisabledInvoiceRegistry,
  registryId,
  type InvoiceRegistry,
  type RegistryAnswer,
} from '../src/services/invoice-registry.js';

/** The registry this venue actually deployed. A reader checks these answers against it. */
const REGISTRY_ADDRESS = '0x44fe6E29aaDe69085CE53c4694b99EFe4639B7a7';

let h: Harness;

afterEach(() => {
  h.restore();
});

interface Recorded {
  listed: string[];
  statuses: { invoiceId: string; status: number }[];
}

/** A registry that records what it was asked to do, and can be told to fail. */
function recordingRegistry(
  fail: 'none' | 'list' | 'status' = 'none',
  answer: RegistryAnswer = { checked: true, listed: true, confirmed: false },
): {
  registry: InvoiceRegistry;
  seen: Recorded;
} {
  const seen: Recorded = { listed: [], statuses: [] };
  return {
    seen,
    registry: {
      enabled: true,
      address: REGISTRY_ADDRESS,
      lookup: () => Promise.resolve(answer),
      list: (input) => {
        if (fail === 'list') return Promise.reject(new Error('CONTRACT_REVERT_EXECUTED'));
        seen.listed.push(input.invoiceId);
        return Promise.resolve({ transactionHash: '0xlisted' });
      },
      setStatus: (invoiceId, status) => {
        if (fail === 'status') return Promise.reject(new Error('CONTRACT_REVERT_EXECUTED'));
        seen.statuses.push({ invoiceId, status });
        return Promise.resolve({ transactionHash: '0xstatus' });
      },
    },
  };
}

const newInvoice = () => ({
  sellerId: h.seeded.sellerId,
  debtor: { name: 'Kestrel Provisioning', email: 'ap@kestrel.example' },
  invoiceNumber: 'MF-8001',
  faceValue: '5500000',
  currency: 'usd',
  issuedAt: '2026-09-01T00:00:00.000Z',
  dueAt: '2026-12-01T00:00:00.000Z',
});

/** Ask for a confirmation link and answer it as the debtor would. */
async function confirm(invoiceId: string, decision: 'confirmed' | 'disputed') {
  const requested = await call(h.app, 'POST', `/v1/invoices/${invoiceId}/confirmation-request`, {
    body: {},
  });
  const token = String(requested.body.confirmation.link).split('/').at(-1) ?? '';
  return call(h.app, 'POST', `/v1/confirm/${token}`, {
    // A dispute needs a note — the seller has to know what to fix.
    body: decision === 'disputed' ? { decision, note: 'The amount is wrong.' } : { decision },
  });
}

describe('recording a debtor confirmation on chain', () => {
  it('records it, as Confirmed, against that invoice', async () => {
    const { registry, seen } = recordingRegistry();
    h = await createHarness({ invoiceRegistry: registry });

    const created = await call(h.app, 'POST', '/v1/invoices', { body: newInvoice() });
    const invoiceId = created.body.invoice.id as string;

    const answered = await confirm(invoiceId, 'confirmed');
    expect(answered.status).toBe(200);
    expect(seen.statuses).toEqual([{ invoiceId, status: INVOICE_STATUS.Confirmed }]);
  });

  /*
   * A dispute is not a confirmation and must not be written as one. The contract cannot undo
   * a status, so a mistaken `Confirmed` would be a permanent public claim that a customer
   * agreed to an invoice they had just rejected.
   */
  it('writes nothing when the debtor disputes', async () => {
    const { registry, seen } = recordingRegistry();
    h = await createHarness({ invoiceRegistry: registry });

    const created = await call(h.app, 'POST', '/v1/invoices', { body: newInvoice() });
    const answered = await confirm(created.body.invoice.id as string, 'disputed');

    expect(answered.status).toBe(200);
    expect(seen.statuses).toEqual([]);
  });

  /* The customer has already answered. Losing that to an RPC outage is not acceptable. */
  it('still accepts the confirmation when the chain refuses it', async () => {
    const { registry } = recordingRegistry('status');
    h = await createHarness({ invoiceRegistry: registry });

    const created = await call(h.app, 'POST', '/v1/invoices', { body: newInvoice() });
    const invoiceId = created.body.invoice.id as string;

    const answered = await confirm(invoiceId, 'confirmed');
    expect(answered.status).toBe(200);
    expect(answered.body.decision).toBe('confirmed');

    const invoice = await call(h.app, 'GET', `/v1/invoices/${invoiceId}`);
    expect(invoice.body.invoice.status).toBe('confirmed');
  });

  it('does nothing at all when no registry is configured', async () => {
    h = await createHarness({ invoiceRegistry: createDisabledInvoiceRegistry() });

    const created = await call(h.app, 'POST', '/v1/invoices', { body: newInvoice() });
    const answered = await confirm(created.body.invoice.id as string, 'confirmed');
    expect(answered.status).toBe(200);
  });
});

describe('listing after issuance', () => {
  it('does not fail an issuance when the listing is refused', async () => {
    const { registry } = recordingRegistry('list');
    h = await createHarness({ invoiceRegistry: registry });

    const created = await call(h.app, 'POST', '/v1/invoices', { body: newInvoice() });
    expect(created.status).toBe(202);

    // The queue is serial and paced at 0ms in tests; let it drain.
    await new Promise((resolve) => setTimeout(resolve, 80));

    const after = await call(h.app, 'GET', `/v1/invoices/${created.body.invoice.id}`);
    expect(after.body.invoice.issuance.state).not.toBe('failed');
  });
});

describe('with no registry configured', () => {
  beforeEach(async () => {
    h = await createHarness({ invoiceRegistry: createDisabledInvoiceRegistry() });
  });

  it('answers "not checked" rather than "not listed"', async () => {
    await expect(createDisabledInvoiceRegistry().lookup('any')).resolves.toEqual({
      checked: false,
    });
  });

  it('refuses to write, saying no registry is wired', async () => {
    await expect(
      createDisabledInvoiceRegistry().setStatus('any', INVOICE_STATUS.Confirmed),
    ).rejects.toMatchObject({
      detail: expect.stringContaining('No registry is wired'),
    });
  });
});

/**
 * The registry had a reader nowhere in the repo: the venue wrote `list` and `setStatus` and
 * never asked the contract anything back, which made it a write-only record — unlike the
 * uniqueness registry, whose read is what makes its refusal real.
 *
 * The proof view is the right reader, because it is the one screen whose stated purpose is
 * that a reader need not trust this service. Debtor confirmation is what justifies advancing
 * the full face value with no holdback, and until now that claim rested on a column only the
 * venue could see, on a screen built to be checked.
 */
describe('the proof view asks the registry', () => {
  it('reports what the chain says, and where to go and ask it', async () => {
    const { registry } = recordingRegistry('none', {
      checked: true,
      listed: true,
      confirmed: true,
    });
    h = await createHarness({ invoiceRegistry: registry });

    const res = await call(h.app, 'GET', `/v1/trades/${h.seeded.tradeIds['TRD-4417']}/proof`);

    expect(res.status).toBe(200);
    expect(res.body.registry).toEqual({
      checked: true,
      listed: true,
      confirmed: true,
      contractAddress: REGISTRY_ADDRESS,
      explorerUrl: `https://hashscan.io/testnet/contract/${REGISTRY_ADDRESS}`,
    });
  });

  /*
   * A registry saying no is a different fact from a registry that could not be reached, and
   * this is the screen where collapsing them would do the most damage: `confirmed: false`
   * beside the venue's own `confirmation.decision === 'confirmed'` reads as the venue being
   * caught out, when all that happened is that a node did not answer.
   */
  it('answers "not checked" rather than "not confirmed" when it cannot be read', async () => {
    const { registry } = recordingRegistry('none', { checked: false });
    h = await createHarness({ invoiceRegistry: registry });

    const res = await call(h.app, 'GET', `/v1/trades/${h.seeded.tradeIds['TRD-4417']}/proof`);

    expect(res.body.registry.checked).toBe(false);
    expect(res.body.registry.listed).toBeNull();
    expect(res.body.registry.confirmed).toBeNull();
    // The venue's own answer is untouched by the chain's silence.
    expect(res.body.confirmation.decision).toBe('confirmed');
  });

  /* No registry configured is no address, and an address we do not hold is no link. */
  it('offers no link to a registry this deployment does not have', async () => {
    h = await createHarness({ invoiceRegistry: createDisabledInvoiceRegistry() });

    const res = await call(h.app, 'GET', `/v1/trades/${h.seeded.tradeIds['TRD-4417']}/proof`);

    expect(res.status).toBe(200);
    expect(res.body.registry).toEqual({
      checked: false,
      listed: null,
      confirmed: null,
      contractAddress: null,
      explorerUrl: null,
    });
  });
});

describe('registryId', () => {
  it('is deterministic and separates ids that differ at all', () => {
    const a = '8b879d02-4593-4d66-82bf-52d4833401b6';
    const b = '8b879d02-4593-4d66-82bf-52d4833401b7';
    expect(registryId(a)).toBe(registryId(a));
    expect(registryId(a)).not.toBe(registryId(b));
  });

  /* `bytes32(0)` is the contract's "unset" sentinel and every write rejects it. */
  it('never produces the zero hash', () => {
    expect(registryId('')).not.toBe(`0x${'0'.repeat(64)}`);
  });
});

describe('the status enum', () => {
  /*
   * Pinned against `FactureTypes.InvoiceStatus`. These are wire values on a deployed
   * contract: an off-by-one here would record `Matched` where `Confirmed` was meant, which
   * the lifecycle then refuses to move backwards from.
   */
  it('matches the contract, in order', () => {
    expect(INVOICE_STATUS).toEqual({
      Unknown: 0,
      Draft: 1,
      Confirmed: 2,
      Matched: 3,
      Settled: 4,
      Repaid: 5,
      Defaulted: 6,
      Cancelled: 7,
    });
  });
});
