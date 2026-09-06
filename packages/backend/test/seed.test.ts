/**
 * The demo book, priced.
 *
 * These are the two claims the market makes about itself, and they are asserted against
 * the real curve rather than restated:
 *
 * - **MF-2046 clears at 18.50%**, from the wide end of the book, because every tighter bid
 *   refuses it. A market does not go silent on paper it dislikes; it quotes it worse.
 * - **MF-2047 is refused by every mandate**, because `D` ranks below `UNRATED` and even
 *   the widest floor a buyer can write still excludes a customer known to default.
 *
 * Nothing here asserts a number that the seed also asserts. Prices come out of
 * `bestQuote`, exposure comes out of the store's aggregate over settled trades, and the
 * rating comes out of the ladder — so a change to any of the three fails here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MARKET_NOW_ISO, marketNow } from '../src/db/seed.js';
import { ZERO_ADDRESS, accountIdToEvmAddress } from '../src/services/ats.js';
import { quoteEngine } from '../src/services/quote-engine.js';
import { ratingService } from '../src/services/rating.js';
import { createHarness, type Harness } from './helpers.js';

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(() => {
  h.restore();
});

describe('the seeded book', () => {
  it('gives every customer the grade the ladder actually produces', async () => {
    const grades = await Promise.all(
      Object.entries(h.seeded.debtorIds).map(async ([label, id]) => {
        const assessment = await ratingService.ratingFor(id);
        return [label, assessment.rating] as const;
      }),
    );

    expect(Object.fromEntries(grades)).toEqual({
      'DBT-LUMEN': 'A',
      'DBT-HALDEN': 'A',
      'DBT-ASHFIELD': 'A',
      'DBT-NORTHWIND': 'B',
      'DBT-CALDER': 'B',
      'DBT-PETRA': 'C',
      'DBT-VANTAGE': 'C',
      'DBT-ORRIN': 'D',
      'DBT-SABLE': 'UNRATED',
    });
  });

  /*
   * The seller's Arc address is where a sale's proceeds land once the vault pays out:
   * `MandateVault` locks a payout claimable by that address and no other, so an invented one
   * is a payout that settles, reports success, and pays nobody until it is reclaimed to the
   * buyer a day later. Three of the four seeded buyer desks are invented on both chains and
   * say so; this one must not be.
   *
   * The check is that it is the *same key* as the Hedera side rather than merely non-empty,
   * because "looks like an address" is exactly what the invented one also satisfied. An EVM
   * address is derived from the key rather than from a chain, so one ECDSA key controls the
   * same address on Arc as on Hedera — which is what makes this derivable rather than chosen.
   */
  it('gives the seller an Arc address its own key controls', async () => {
    const seller = await h.store.getSeller(h.seeded.sellerId);

    expect(seller?.arcAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(seller?.arcAddress?.toLowerCase()).toBe(seller?.hederaAccountId?.toLowerCase());
  });

  /*
   * The same defect on the Hedera side, and the property is not "looks like an address".
   *
   * `accountIdToEvmAddress` is what every on-chain path resolves a counterparty through —
   * the compliance gate at arm time, the ATS transfer, the hold. It passes a `0x…` alias
   * through and converts a `0.0.x` to the long-zero form derived from the account *number*,
   * which is a different key to the security's own `ControlList` and `Kyc` mappings. So an
   * invented `0.0.x` produces a perfectly well-formed address that no grant can ever reach,
   * and the venue finds that out at the gate rather than here. Harrow Point's row said
   * `0.0.6098467` while the live database held the alias, corrected by hand.
   *
   * Long-zero is the shape — twelve zero bytes then the entity number — and a key-derived
   * alias having them is a one-in-2^96 accident, so this is a heuristic and it is the right
   * way round: it fails rather than passes when it cannot tell.
   * `scripts/prepare-security.mjs` refuses a buyer on the same test.
   */
  const reachableOnChain = (accountId: string | null | undefined): boolean => {
    const evm = accountIdToEvmAddress(accountId);
    return evm !== ZERO_ADDRESS && !/^0x0{24}/.test(evm);
  };

  it('gives every settling party a Hedera identity a grant can actually reach', async () => {
    const seller = await h.store.getSeller(h.seeded.sellerId);
    const harrow = await h.store.getBuyer(h.seeded.buyerIds['BUY-HARROW'] ?? '');

    /*
     * The two parties a live trade in this book resolves on chain: the venue holds and moves
     * the paper as the seller, and Harrow Point is the desk whose mandate is really escrowed
     * and whose account really signs the x402 cash leg. No seeded position sits on Harrow
     * Point's mandate, so this is the only thing standing between its identity and fiction.
     */
    const parties: readonly (readonly [string, string | null | undefined])[] = [
      ['Meridian Fabrication', seller?.hederaAccountId],
      ['Harrow Point', harrow?.hederaAccountId],
    ];

    expect(Object.fromEntries(parties.map(([who, id]) => [who, reachableOnChain(id)]))).toEqual({
      'Meridian Fabrication': true,
      'Harrow Point': true,
    });

    /*
     * And the buyer's two wallet columns are two keys, unlike the seller's. Operator and
     * seller are the same account here, so one key controls both of the seller's; the buyer
     * funds the vault from a Circle wallet that cannot produce a native Hedera
     * `TransferTransaction`, so the x402 leg needs a key of its own. Asserting these equal
     * would import the seller's fact into a party it is not true of.
     */
    expect(accountIdToEvmAddress(harrow?.hederaAccountId).toLowerCase()).not.toBe(
      harrow?.arcAddress?.toLowerCase(),
    );
  });

  /*
   * The complement, said out loud rather than left to a comment: the other three desks are
   * invented and stay that way. Each resolves to a long-zero address — well formed, and a
   * key no `ControlList` grant reaches — which is fine for a desk that only ever holds demo
   * history and is not fine for one a live trade fills. If a fourth desk is ever wired to a
   * real key, this fails and the fix is to move it into the check above, not to relax this.
   */
  it('leaves the three demo desks unreachable on chain rather than plausible', async () => {
    const desks = ['BUY-ASHGROVE', 'BUY-CORDELL', 'BUY-TESSELLATE'];
    const resolved = await Promise.all(
      desks.map(async (label) => {
        const buyer = await h.store.getBuyer(h.seeded.buyerIds[label] ?? '');
        return [label, reachableOnChain(buyer?.hederaAccountId)] as const;
      }),
    );

    expect(Object.fromEntries(resolved)).toEqual({
      'BUY-ASHGROVE': false,
      'BUY-CORDELL': false,
      'BUY-TESSELLATE': false,
    });
  });

  it('derives mandate allocation from settled trades rather than a stored number', async () => {
    const mandateId = h.seeded.mandateIds['MND-03'] ?? '';
    const mandate = await h.store.getMandate(mandateId);
    const exposure = (await h.store.debtorExposure([mandateId])).get(mandateId) ?? {};
    const petra = h.seeded.debtorIds['DBT-PETRA'] ?? '';
    const writtenOff = await h.store.getTrade(h.seeded.tradeIds['POS-16'] ?? '');

    // POS-07: $36,000 face at 1250 bps over 84 days -> $3,496,438 of outlay.
    expect(exposure[petra]).toBe(3_496_438n);
    /*
     * Tessellate's three open positions plus the one it wrote off. A default releases
     * nothing — the position closed at zero and the buyer is out the money — so POS-16's
     * outlay is still allocated, while POS-15's came back when Northwind paid. Read off the
     * trade rather than typed in, so the two cannot be made to agree by editing this line.
     */
    expect(mandate?.allocatedMinor).toBe(
      3_496_438n + 925_835n + 2_425_513n + (writtenOff?.proceedsMinor ?? 0n),
    );
  });
});

/**
 * The rating ledger under the book, and the one invariant it can actually carry.
 *
 * The counters on `debtors` are an **opening balance** — a customer's record from before
 * this venue existed — plus every outcome the venue has since recorded, so they cannot be
 * rebuilt from `settlement_outcomes` and nothing here pretends they can. What must hold is
 * the weaker pair below: every row in the table is inside the counters beside it, and no
 * terminal invoice is missing its row.
 *
 * The second one is the test that would have caught this. MF-2029 and MF-2031 shipped as
 * `matured` and `defaulted` with no settled trade and no ledger row behind either — a
 * receivable that defaulted on nobody and matured into nobody's hands, since both paths
 * read the holder off the newest settled trade.
 */
describe('the rating ledger behind the seeded book', () => {
  /** Terminal, and reached only by settling: `disputed` never sold, so it settles nothing. */
  const CLOSED = new Set(['matured', 'defaulted']);

  const outcomesFor = (debtorId: string) =>
    [...h.store.outcomes.values()].filter((o) => o.debtorId === debtorId);

  it('has a settled trade and a recorded outcome behind every terminal invoice', async () => {
    const closed = [...h.store.invoices.values()].filter((i) => CLOSED.has(i.status));

    expect(closed.map((i) => i.invoiceNumber).sort()).toEqual(['MF-2029', 'MF-2031']);
    for (const invoice of closed) {
      const settled = [...h.store.trades.values()].filter(
        (t) => t.invoiceId === invoice.id && t.status === 'settled',
      );
      const onLedger = await h.store.getOutcome(invoice.debtorId, invoice.id);

      expect(settled).toHaveLength(1);
      expect(onLedger).not.toBeNull();
      expect(onLedger?.faceValue).toBe(invoice.faceValue);
      expect(onLedger?.outcome).toBe(invoice.status === 'matured' ? 'on_time' : 'default');
    }
  });

  it('carries every recorded outcome inside the counters it was added to', async () => {
    for (const debtor of h.store.debtors.values()) {
      const rows = outcomesFor(debtor.id);
      const count = (outcome: string): number => rows.filter((o) => o.outcome === outcome).length;

      expect(debtor.settledOnTime).toBeGreaterThanOrEqual(count('on_time'));
      expect(debtor.settledLate).toBeGreaterThanOrEqual(count('late'));
      expect(debtor.defaulted).toBeGreaterThanOrEqual(count('default'));

      // A default settles nothing, so only the paid rows are inside the face-value total.
      const paid = rows
        .filter((o) => o.outcome !== 'default')
        .reduce((sum, o) => sum + o.faceValue, 0n);
      expect(debtor.settledFaceValue).toBeGreaterThanOrEqual(paid);

      for (const row of rows) {
        expect(debtor.lastSettlementAt?.getTime() ?? 0).toBeGreaterThanOrEqual(
          row.occurredAt.getTime(),
        );
      }
    }
  });

  it('counts settlements it has no row for, which is the opening balance', async () => {
    const lumen = await h.store.getDebtor(h.seeded.debtorIds['DBT-LUMEN'] ?? '');
    const counted = [...h.store.debtors.values()].reduce(
      (sum, d) => sum + d.settledOnTime + d.settledLate + d.defaulted,
      0,
    );

    /*
     * Twenty-one settlements and not one row. A customer arrives at a factoring venue with
     * a payment record it did not witness, and without one every grade on day one would be
     * `UNRATED` and the curve would be flat — so this gap is the demo book working, not the
     * ledger being incomplete. The schema comment used to describe the counters as derived
     * from the table, which is what makes the difference worth pinning.
     */
    expect(lumen?.settledOnTime).toBe(21);
    expect(outcomesFor(lumen?.id ?? '')).toHaveLength(0);
    expect(counted).toBeGreaterThan(h.store.outcomes.size);
  });

  it('marks Orrin exactly once for MF-2031, on the ledger and in the counters', async () => {
    const orrin = h.seeded.debtorIds['DBT-ORRIN'] ?? '';
    const debtor = await h.store.getDebtor(orrin);
    const row = await h.store.getOutcome(orrin, h.seeded.invoiceIds['INV-2031'] ?? '');

    // The one default the book claims is the one the ledger holds, at the face value the
    // invoice states. A counter of 1 beside no row is a mark on a customer nobody can check.
    expect(debtor?.defaulted).toBe(1);
    expect(row?.outcome).toBe('default');
    expect(row?.faceValue).toBe(1_580_000n);
    // Declared a week after it fell due, not on the day: `recordDefault` refuses a
    // receivable that still has until the end of its due date to be paid.
    expect(row?.occurredAt.toISOString()).toBe('2026-08-27T00:00:00.000Z');
  });
});

describe('MF-2046 — the invoice the wide end of the book exists for', () => {
  it('clears at 18.50% annualised, against the only bid that will take it', async () => {
    const live = await quoteEngine.priceOne(h.seeded.invoiceIds['INV-2046'] ?? '', marketNow());

    expect(live.rating).toBe('C');
    expect(live.tenorDays).toBe(94);
    expect(live.quote?.annualisedYieldBps).toBe(1850);
    expect(live.quote?.mandateId).toBe(h.seeded.mandateIds['MND-06']);

    // $62,300 face, 94 days at 1850 bps: discount $2,968.22, proceeds $59,331.78.
    expect(live.quote?.faceValue).toBe(6_230_000n);
    expect(live.quote?.discount).toBe(296_822n);
    expect(live.quote?.proceeds).toBe(5_933_178n);
    expect(live.matchesAvailable).toBe(1);
  });

  it('is refused by the other five, each naming a different comparison', async () => {
    const live = await quoteEngine.priceOne(h.seeded.invoiceIds['INV-2046'] ?? '', marketNow());
    const byMandate = new Map(live.refusals.map((r) => [r.mandateId, r.code]));

    expect(live.refusals).toHaveLength(5);
    // Three bids sit above Petra Foods' C.
    expect(byMandate.get(h.seeded.mandateIds['MND-01'] ?? '')).toBe('RATING_BELOW_MANDATE');
    expect(byMandate.get(h.seeded.mandateIds['MND-05'] ?? '')).toBe('RATING_BELOW_MANDATE');
    expect(byMandate.get(h.seeded.mandateIds['MND-02'] ?? '')).toBe('RATING_BELOW_MANDATE');
    // The unrated book will not go past 45 days; this invoice has 94 to run.
    expect(byMandate.get(h.seeded.mandateIds['MND-04'] ?? '')).toBe('TENOR_EXCEEDS_MANDATE');
    // The ladder that does take C caps Petra at $40,000, and POS-07 already used most of it.
    expect(byMandate.get(h.seeded.mandateIds['MND-03'] ?? '')).toBe('DEBTOR_CONCENTRATION');
  });

  it('explains the concentration refusal in words, with both sides of the comparison', async () => {
    const live = await quoteEngine.priceOne(h.seeded.invoiceIds['INV-2046'] ?? '', marketNow());
    const refusal = live.refusals.find((r) => r.code === 'DEBTOR_CONCENTRATION');

    expect(refusal?.humanReason).toContain('Petra Foods Group');
    expect(refusal?.humanReason).toContain('$40,000.00');
    expect(refusal?.humanReason).toContain('$5,035.62');
  });
});

describe('MF-2047 — the invoice nothing will take', () => {
  it('has no price, because D ranks below UNRATED on shared’s scale', async () => {
    const live = await quoteEngine.priceOne(h.seeded.invoiceIds['INV-2047'] ?? '', marketNow());

    expect(live.rating).toBe('D');
    expect(live.quote).toBeNull();
    expect(live.matchesAvailable).toBe(0);
  });

  it('is refused by all six mandates, every one of them on the rating', async () => {
    const live = await quoteEngine.priceOne(h.seeded.invoiceIds['INV-2047'] ?? '', marketNow());

    expect(live.refusals).toHaveLength(6);
    expect(live.candidatesConsidered).toBe(6);
    expect(new Set(live.refusals.map((r) => r.code))).toEqual(new Set(['RATING_BELOW_MANDATE']));
    // Including the widest floor a buyer can actually write.
    const widest = live.refusals.find((r) => r.mandateId === h.seeded.mandateIds['MND-06']);
    expect(widest?.humanReason).toBe(
      'The customer is rated D, and this mandate takes UNRATED or better.',
    );
  });
});

describe('MF-2041 — the ordinary case, for contrast', () => {
  it('is filled by the tightest bid at 8.00%, not by the deepest one', async () => {
    const live = await quoteEngine.priceOne(h.seeded.invoiceIds['INV-2041'] ?? '', marketNow());

    expect(live.rating).toBe('A');
    expect(live.tenorDays).toBe(60);
    expect(live.quote?.annualisedYieldBps).toBe(800);
    // $40,000 over 60 days at 8%: $52.60 discount, $39,473.97 proceeds — 0.13% of face.
    expect(live.quote?.discount).toBe(52_603n);
    expect(live.quote?.proceeds).toBe(3_947_397n);
    expect(live.matchesAvailable).toBeGreaterThanOrEqual(3);
  });

  it('prices tighter as the due date approaches, off the same curve', async () => {
    const invoiceId = h.seeded.invoiceIds['INV-2041'] ?? '';
    const today = await quoteEngine.priceOne(invoiceId, marketNow());
    const inThirtyDays = await quoteEngine.priceOne(
      invoiceId,
      new Date(Date.parse(MARKET_NOW_ISO) + 30 * 86_400_000),
    );

    expect(inThirtyDays.tenorDays).toBe(30);
    expect(inThirtyDays.quote?.proceeds).toBeGreaterThan(today.quote?.proceeds ?? 0n);
    // Seasoned paper reaches a shorter bucket, so a tighter bid can now take it.
    expect(inThirtyDays.quote?.annualisedYieldBps).toBe(675);
  });
});
