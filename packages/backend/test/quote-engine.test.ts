/**
 * Pricing, and the one place it touches a chain.
 *
 * The gate that decides who may hold a security used to run only when a trade was ARMED. So
 * the book could quote a price from a bid whose buyer that instrument bars, and the seller
 * found out after deciding to sell — a 403 with a good sentence, arriving too late to be
 * useful. Observed live on MF-2051: the tightest bid was 925 bps from a buyer the security
 * does not permit to hold it.
 *
 * The rule these tests hold down is that `priceOne` quotes a price someone can actually take,
 * and that it pays at most a handful of reads to do it.
 */

import { describe, expect, it } from 'vitest';
import type { Invoice, Mandate } from '@facture/shared';
import { createQuoteEngine, defaultQuoteEngineDeps } from '../src/services/quote-engine.js';
import { createHarness, type Harness } from './helpers.js';
import { MARKET_NOW_ISO } from '../src/db/seed.js';
import { afterEach, beforeEach } from 'vitest';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(() => {
  h.restore();
});

const marketNow = (): Date => new Date(MARKET_NOW_ISO);

/** An engine whose only difference from production is who may hold the paper. */
function engineRefusing(barred: (input: { invoice: Invoice; mandate: Mandate }) => boolean) {
  const asked: string[] = [];
  const engine = createQuoteEngine({
    ...defaultQuoteEngineDeps,
    canHold: (input) => {
      asked.push(input.mandate.id);
      return Promise.resolve(
        barred(input)
          ? { allowed: false, reason: `${input.mandate.id} may not hold this security.` }
          : { allowed: true, reason: null },
      );
    },
  });
  return { engine, asked };
}

describe('pricing against an instrument that bars a buyer', () => {
  it('quotes the best bid when nothing is barred', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2046'] ?? '';
    const { engine, asked } = engineRefusing(() => false);

    const live = await engine.priceOne(invoiceId, marketNow());

    expect(live.quote).not.toBeNull();
    expect(live.excludedByCompliance).toBe(0);
    // Exactly one read: the winner, and only the winner.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBe(live.quote?.mandateId);
  });

  it('drops the winning bid and quotes the next one that can hold it', async () => {
    // INV-2041 is the case that matters: four bids would take it, so there is somewhere to
    // fall through TO. An invoice with a single match has no second-best to quote.
    const invoiceId = h.seeded.invoiceIds['INV-2041'] ?? '';
    const unchecked = await createQuoteEngine(defaultQuoteEngineDeps).priceOne(
      invoiceId,
      marketNow(),
    );
    const tightest = unchecked.quote?.mandateId ?? '';
    expect(tightest).not.toBe('');

    const { engine } = engineRefusing(({ mandate }) => mandate.id === tightest);
    const live = await engine.priceOne(invoiceId, marketNow());

    expect(live.excludedByCompliance).toBe(1);
    expect(live.quote).not.toBeNull();
    expect(live.quote?.mandateId).not.toBe(tightest);
    /*
     * And the price is worse, which is the honest consequence. A seller barred from the
     * tightest bid should see the next one rather than a number nobody will honour.
     */
    expect(live.quote?.annualisedYieldBps ?? 0).toBeGreaterThan(
      unchecked.quote?.annualisedYieldBps ?? 0,
    );
  });

  it('gives up after a bounded number of passes rather than reading the whole book', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2041'] ?? '';
    const { engine, asked } = engineRefusing(() => true);

    const live = await engine.priceOne(invoiceId, marketNow());

    /*
     * Every bid barred is the pathological case. It must cost a fixed number of reads, not
     * one per mandate — screening the whole curve on chain is the cost this design avoids.
     */
    expect(asked.length).toBeLessThanOrEqual(3);
    expect(live.excludedByCompliance).toBeLessThanOrEqual(3);
  });

  it('does not ask when there is no bid to check', async () => {
    // Nothing to check when nothing matched: the gate is asked about a WINNER, and an
    // invoice with no bid on the curve does not have one.
    const { engine, asked } = engineRefusing(() => true);

    const live = await engine.priceOne(h.seeded.invoiceIds['INV-2049'] ?? '', marketNow());

    if (live.quote === null) {
      expect(asked).toHaveLength(0);
      expect(live.excludedByCompliance).toBe(0);
    }
  });

  it('prices exactly as before when no gate is wired', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2046'] ?? '';
    const { canHold: _omitted, ...withoutGate } = defaultQuoteEngineDeps;

    const plain = await createQuoteEngine(withoutGate).priceOne(invoiceId, marketNow());
    const { engine } = engineRefusing(() => false);
    const checked = await engine.priceOne(invoiceId, marketNow());

    // A deployment with no gate is a deployment that prices the way it always did.
    expect(plain.quote?.mandateId).toBe(checked.quote?.mandateId);
    expect(plain.excludedByCompliance).toBe(0);
  });
});

describe('the book screen', () => {
  it('does not pay an on-chain read per row', async () => {
    const ids = Object.values(h.seeded.invoiceIds);
    const { engine, asked } = engineRefusing(() => true);

    const priced = await engine.priceBook(ids, marketNow());

    /*
     * `priceBook` prices a whole book in one pass. Checking the winner per row would be the
     * same N+1 it exists to avoid, moved from the database to the mirror node — so a book
     * price is indicative and `priceOne` is the one a seller acts on.
     */
    expect(asked).toHaveLength(0);
    expect(priced.every((row) => row.excludedByCompliance === 0)).toBe(true);
  });
});
