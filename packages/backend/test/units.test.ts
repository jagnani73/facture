/**
 * The venue's one settlement conversion.
 *
 * This function had no test of its own. It was written inside the x402 client, carefully and
 * with its reasoning recorded, and then the Arc escrow was written next to it and did not
 * find it — comparing a mandate's US cents directly against a USDC balance at 6 decimals.
 * On the demo mandate both numbers were `5000000`, four orders of magnitude apart, so the
 * check passed and read as correct.
 *
 * What is pinned here is therefore not the arithmetic for its own sake but the two
 * properties the rails depend on: that one invoice costs the same money on either rail, and
 * that a remainder rounds in the direction that suits what is being asked.
 */

import { describe, expect, it } from 'vitest';
import { toSettlementAmount } from '../src/units.js';

/** USD and EUR. */
const USD = 2;
/** Tinybars. */
const HBAR = 8;
/** USDC on the ERC-20 interface. Never the 18-decimal gas accounting. */
const USDC = 6;
/** The deployment default: one millionth, so a testnet balance can cover a receivable. */
const PPM = 1;

describe('one receivable, one price, either rail', () => {
  /*
   * The property that makes two settlement rails honest. If the same invoice converted to
   * different money depending on which rail settled it, the venue would be quoting a price
   * it only sometimes charges — and a buyer could choose the cheaper chain.
   */
  it('settles the same nominal amount on Hedera and on Arc', () => {
    for (const cents of [5_000_000n, 5_933_178n, 1n, 123_456_789n]) {
      const onHedera = toSettlementAmount(cents, USD, HBAR, PPM);
      const onArc = toSettlementAmount(cents, USD, USDC, PPM);
      /*
       * Equal to the precision of the coarser asset, which is the strongest true statement.
       * HBAR carries 8 decimals and USDC 6, so USDC cannot express the last two digits of a
       * tinybar amount — $59,331.78 is 0.05933178 HBAR and 0.059331 USDC. The difference is
       * the asset's own resolution, not the venue charging two prices, and asserting exact
       * equality here would be asserting something false.
       */
      expect(onHedera / 100n).toBe(onArc);
    }
  });

  it('reads $50,000.00 as 0.05 of the settlement asset on both', () => {
    expect(toSettlementAmount(5_000_000n, USD, HBAR, PPM)).toBe(5_000_000n); // 0.05 HBAR
    expect(toSettlementAmount(5_000_000n, USD, USDC, PPM)).toBe(50_000n); // 0.05 USDC
  });
});

describe('shift before scale', () => {
  /*
   * The ordering the original comment was written to defend. Scaling first truncates
   * $59,331.78 to 0.05 rather than 0.0593 — an error the size of the amount itself.
   */
  it('keeps precision the other order would destroy', () => {
    // 0.05933178 HBAR and 0.059331 USDC, against the 0.05 both would collapse to.
    expect(toSettlementAmount(5_933_178n, USD, HBAR, PPM)).toBe(5_933_178n);
    expect(toSettlementAmount(5_933_178n, USD, USDC, PPM)).toBe(59_331n);
  });

  it('settles the full amount at 1,000,000 ppm', () => {
    expect(toSettlementAmount(5_000_000n, USD, USDC, 1_000_000)).toBe(50_000_000_000n);
  });

  /* An asset with fewer decimals than the currency. Unused here, kept correct anyway. */
  it('divides when the asset is coarser than the currency', () => {
    expect(toSettlementAmount(5_000_000n, USD, 0, 1_000_000)).toBe(50_000n);
  });
});

describe('rounding has a direction', () => {
  /*
   * The hole this closed. At 1 ppm the granularity is a whole dollar, so every amount under
   * $1.00 converts to zero — and zero is satisfied by an empty vault. A payment rounding to
   * zero costs a sub-unit; a *requirement* rounding to zero means capital nobody posted
   * backs a bid, which is the one thing the funding check exists to refuse.
   */
  it('rounds a payment down, so a payer is never billed money the invoice does not owe', () => {
    expect(toSettlementAmount(99n, USD, USDC, PPM)).toBe(0n);
    expect(toSettlementAmount(150n, USD, USDC, PPM)).toBe(1n);
  });

  it('rounds a requirement up, so no amount is backed by nothing', () => {
    expect(toSettlementAmount(1n, USD, USDC, PPM, 'up')).toBe(1n);
    expect(toSettlementAmount(99n, USD, USDC, PPM, 'up')).toBe(1n);
    expect(toSettlementAmount(150n, USD, USDC, PPM, 'up')).toBe(2n);
  });

  it('leaves an exact amount alone whichever way it rounds', () => {
    expect(toSettlementAmount(5_000_000n, USD, USDC, PPM, 'down')).toBe(50_000n);
    expect(toSettlementAmount(5_000_000n, USD, USDC, PPM, 'up')).toBe(50_000n);
  });

  it('defaults to down, which is what the cash leg has always charged', () => {
    expect(toSettlementAmount(99n, USD, USDC, PPM)).toBe(
      toSettlementAmount(99n, USD, USDC, PPM, 'down'),
    );
  });
});
