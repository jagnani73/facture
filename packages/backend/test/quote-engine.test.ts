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
      /*
       * `readable: true` on both branches: this fake stands in for an instrument that
       * answered, and refusing a buyer is an answer. The unreadable case is the one where
       * the gate got nothing back at all, and it is exercised separately.
       */
      return Promise.resolve(
        barred(input)
          ? {
              allowed: false,
              reason: `${input.mandate.id} may not hold this security.`,
              readable: true,
            }
          : { allowed: true, reason: null, readable: true },
      );
    },
  });
  return { engine, asked };
}

describe('reporting whether the instrument could be read', () => {
  /*
   * Three states, and the third is the one worth pinning. A screen decides whether to offer
   * a link to the instrument off this field, and the book is full of seeded rows naming
   * securities that were never deployed — so folding "nobody asked" into "no" would hide
   * every real instrument, and folding it into "yes" would publish links to contracts that
   * do not exist.
   */
  it('says true when the gate answered', async () => {
    const { engine } = engineRefusing(() => false);
    const live = await engine.priceOne(h.seeded.invoiceIds['INV-2046'] ?? '', marketNow());

    expect(live.quote).not.toBeNull();
    expect(live.instrumentReadable).toBe(true);
  });

  it('says false when the instrument was asked and returned nothing', async () => {
    const engine = createQuoteEngine({
      ...defaultQuoteEngineDeps,
      canHold: () => Promise.resolve({ allowed: true, reason: null, readable: false }),
    });
    const live = await engine.priceOne(h.seeded.invoiceIds['INV-2046'] ?? '', marketNow());

    /*
     * Still quoted. An unreadable instrument must not move a price — that is the rule the
     * whole `determinate` distinction exists for — so this reports the unreadability beside
     * a price rather than instead of one.
     */
    expect(live.quote).not.toBeNull();
    expect(live.instrumentReadable).toBe(false);
  });

  it('says null when no gate is configured, rather than false', async () => {
    // `canHold` is optional on the deps, and absent means "do not ask" — a deployment with
    // no gate prices exactly as it did before this field existed.
    const { canHold: _noGate, ...withoutGate } = defaultQuoteEngineDeps;
    const engine = createQuoteEngine(withoutGate);
    const live = await engine.priceOne(h.seeded.invoiceIds['INV-2046'] ?? '', marketNow());

    expect(live.quote).not.toBeNull();
    expect(live.instrumentReadable).toBeNull();
  });

  it('keeps an instrument that answered once, even if a later pass cannot reach it', async () => {
    /*
     * The loop reads the same instrument up to three times. A definitive read on pass one
     * followed by a relay timeout on pass two was reporting the whole invoice as unreadable
     * — a contract that had demonstrably just answered. The question is whether it EVER
     * answered, so the `true` sticks.
     */
    const invoiceId = h.seeded.invoiceIds['INV-2041'] ?? '';
    let call = 0;
    const engine = createQuoteEngine({
      ...defaultQuoteEngineDeps,
      canHold: () => {
        call += 1;
        return Promise.resolve(
          call === 1
            ? { allowed: false, reason: 'barred by the control list', readable: true }
            : { allowed: true, reason: null, readable: false },
        );
      },
    });

    const live = await engine.priceOne(invoiceId, marketNow());

    expect(call).toBeGreaterThan(1);
    expect(live.instrumentReadable).toBe(true);
  });

  it('says null for every row of a priced book, because nothing there asks a chain', async () => {
    const ids = [h.seeded.invoiceIds['INV-2046'] ?? '', h.seeded.invoiceIds['INV-2041'] ?? ''];
    const { engine } = engineRefusing(() => false);
    const book = await engine.priceBook(ids, marketNow());

    expect(book).toHaveLength(2);
    // The N+1 this method exists to avoid. If this ever answers, pricing started paying for
    // one on-chain read per row of the seller's book.
    for (const row of book) expect(row.instrumentReadable).toBeNull();
  });
});

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
