import { describe, expect, it } from 'vitest';
import {
  impliedYieldBps,
  priceInvoice,
  priceInvoiceAt,
  tenorDays,
  tenorDaysSigned,
} from '../../src/pricing/curve.js';
import { formatMinorUnits } from '../../src/types/money.js';

/**
 * The worked example from the product spec, in minor units:
 * face $40,000.00, 60 days, 1250 bps -> discount $821.92, proceeds $39,178.08.
 */
const FACE_40K = 4_000_000n;

describe('priceInvoice — the worked example', () => {
  it('prices 40,000.00 over 60 days at 1250 bps to 821.92 / 39,178.08', () => {
    const result = priceInvoice(FACE_40K, 1250, 60);

    expect(result.discount).toBe(82_192n);
    expect(result.proceeds).toBe(3_917_808n);
    expect(formatMinorUnits(result.discount, 'USD')).toBe('821.92');
    expect(formatMinorUnits(result.proceeds, 'USD')).toBe('39,178.08');
  });

  it('rounds the discount up: the exact value is 821.9178..., not 821.91', () => {
    // 4_000_000 * 1250 * 60 / 3_650_000 = 82_191.7808...
    // Rounded up, in the buyer's favour, so the realised yield is never below the bid.
    const { discount } = priceInvoice(FACE_40K, 1250, 60);
    expect(discount).toBe(82_192n);
    expect(discount).not.toBe(82_191n);
  });

  /**
   * The README's headline screen reads "$40,000 · due in 60 days · worth $39,180 today ·
   * 8.0% annualised". Those two numbers do not describe the same trade: $39,180 of proceeds
   * on 60-day paper is 12.5%, and 8.0% on the same paper leaves $39,473.97. The maths is
   * pinned here for both so the discrepancy is visible rather than argued about.
   */
  it('prices the same invoice at 800 bps to 526.03 / 39,473.97', () => {
    const result = priceInvoice(FACE_40K, 800, 60);
    expect(result.discount).toBe(52_603n);
    expect(result.proceeds).toBe(3_947_397n);
  });
});

describe('priceInvoice — conventions', () => {
  it('is simple, not compound: one year at 1000 bps discounts exactly a tenth of face', () => {
    // Actual/365, so 365 days at 10% is exactly 10% of face with no compounding term.
    expect(priceInvoice(FACE_40K, 1000, 365).discount).toBe(400_000n);
  });

  it('is linear in tenor: 30 days is half of 60 days at the same yield', () => {
    const thirty = priceInvoice(FACE_40K, 1250, 30).discount;
    const sixty = priceInvoice(FACE_40K, 1250, 60).discount;
    expect(thirty).toBe(41_096n);
    expect(sixty).toBe(82_192n);
    // Doubling holds here because both remainders round up to the same place; it is a
    // property of these numbers, not a guarantee of the convention.
    expect(thirty * 2n).toBe(sixty);
  });

  it('always conserves face: discount + proceeds === faceValue', () => {
    for (const bps of [0, 1, 250, 800, 1250, 5000, 9999]) {
      for (const days of [0, 1, 7, 30, 60, 90, 365, 720]) {
        const { discount, proceeds } = priceInvoice(FACE_40K, bps, days);
        expect(discount + proceeds).toBe(FACE_40K);
      }
    }
  });

  it('prices at face when there is no time left to run', () => {
    const result = priceInvoice(FACE_40K, 1250, 0);
    expect(result.discount).toBe(0n);
    expect(result.proceeds).toBe(FACE_40K);
  });

  it('prices at face when the yield is zero', () => {
    expect(priceInvoice(FACE_40K, 0, 60).proceeds).toBe(FACE_40K);
  });

  it('is monotonic: a wider yield always pays the seller less', () => {
    let previous = priceInvoice(FACE_40K, 0, 60).proceeds;
    for (const bps of [100, 500, 800, 1250, 2000, 5000]) {
      const proceeds = priceInvoice(FACE_40K, bps, 60).proceeds;
      expect(proceeds).toBeLessThan(previous);
      previous = proceeds;
    }
  });

  it('is monotonic in tenor: longer paper always pays the seller less', () => {
    let previous = priceInvoice(FACE_40K, 1250, 0).proceeds;
    for (const days of [1, 15, 30, 60, 90, 180, 365]) {
      const proceeds = priceInvoice(FACE_40K, 1250, days).proceeds;
      expect(proceeds).toBeLessThan(previous);
      previous = proceeds;
    }
  });

  it('never lets the discount exceed face, even at an absurd yield', () => {
    const result = priceInvoice(FACE_40K, 1_000_000, 365);
    expect(result.discount).toBe(FACE_40K);
    expect(result.proceeds).toBe(0n);
  });

  /**
   * The reason the money path is `bigint`. At 10^18 minor units the IEEE-754 route gives
   * ...452 where the exact answer is ...453 — one minor unit, arrived at silently.
   */
  it('stays exact where Number would lose a unit', () => {
    const huge = 1_000_000_000_000_000_000n;
    const { discount } = priceInvoice(huge, 1250, 60);

    expect(discount).toBe(20_547_945_205_479_453n);
    const viaFloat = BigInt(Math.ceil((Number(huge) * 1250 * 60) / 3_650_000));
    expect(viaFloat).not.toBe(discount);
  });
});

describe('priceInvoice — preconditions', () => {
  it('rejects a negative face value', () => {
    expect(() => priceInvoice(-1n, 1250, 60)).toThrow(RangeError);
  });

  it('rejects a negative yield', () => {
    expect(() => priceInvoice(FACE_40K, -1, 60)).toThrow(RangeError);
  });

  it('rejects a fractional basis point', () => {
    expect(() => priceInvoice(FACE_40K, 12.5, 60)).toThrow(RangeError);
  });

  it('rejects a negative or fractional tenor', () => {
    expect(() => priceInvoice(FACE_40K, 1250, -1)).toThrow(RangeError);
    expect(() => priceInvoice(FACE_40K, 1250, 60.5)).toThrow(RangeError);
  });
});

describe('impliedYieldBps', () => {
  it('reads the worked example back as 1250 bps', () => {
    const result = impliedYieldBps(FACE_40K, 3_917_808n, 60);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(1250);
  });

  it('round-trips every yield exactly at realistic sizes', () => {
    for (const bps of [1, 50, 250, 800, 1250, 2000, 4321, 9999]) {
      for (const days of [1, 7, 30, 60, 90, 365]) {
        const priced = priceInvoice(FACE_40K, bps, days);
        const back = impliedYieldBps(FACE_40K, priced.proceeds, days);
        expect(back.ok).toBe(true);
        if (back.ok) expect(back.value).toBe(bps);
      }
    }
  });

  it('rounds down, so it never overstates what the buyer earned', () => {
    // Proceeds one minor unit above the 1250 bps price imply slightly less than 1250.
    const result = impliedYieldBps(FACE_40K, 3_917_809n, 60);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(1249);
  });

  it('refuses a zero tenor rather than dividing by it', () => {
    const result = impliedYieldBps(FACE_40K, 3_917_808n, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ZERO_TENOR');
  });

  it('refuses proceeds above face or below zero', () => {
    const above = impliedYieldBps(FACE_40K, FACE_40K + 1n, 60);
    expect(above.ok).toBe(false);
    if (!above.ok) expect(above.error.code).toBe('PROCEEDS_OUT_OF_RANGE');

    const below = impliedYieldBps(FACE_40K, -1n, 60);
    expect(below.ok).toBe(false);
    if (!below.ok) expect(below.error.code).toBe('PROCEEDS_OUT_OF_RANGE');
  });

  it('refuses a non-positive face value', () => {
    const result = impliedYieldBps(0n, 0n, 60);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NON_POSITIVE_FACE');
  });
});

describe('tenorDays', () => {
  it('counts UTC calendar days to maturity', () => {
    expect(tenorDays('2026-11-30T00:00:00.000Z', '2026-10-01T00:00:00.000Z')).toBe(60);
  });

  it('does not depend on the time of day a quote is asked for', () => {
    const due = '2026-11-30T00:00:00.000Z';
    expect(tenorDays(due, '2026-10-01T00:00:01.000Z')).toBe(60);
    expect(tenorDays(due, '2026-10-01T23:59:59.999Z')).toBe(60);
  });

  it('is zero on the due date itself', () => {
    expect(tenorDays('2026-11-30T00:00:00.000Z', '2026-11-30T18:00:00.000Z')).toBe(0);
  });

  it('clamps past-due to zero rather than pricing above face', () => {
    expect(tenorDays('2026-01-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')).toBe(0);
    expect(priceInvoiceAt(FACE_40K, 1250, '2026-01-01', '2026-03-01').proceeds).toBe(FACE_40K);
  });

  it('reports the signed day count separately, for diagnostics', () => {
    expect(tenorDaysSigned('2026-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z')).toBe(-30);
  });

  it('crosses a DST boundary without gaining or losing a day', () => {
    // Northern-hemisphere clocks change inside this window; UTC arithmetic does not care.
    expect(tenorDays('2026-11-30T00:00:00.000Z', '2026-10-25T00:00:00.000Z')).toBe(36);
  });

  it('accepts Date objects as well as ISO strings', () => {
    const due = new Date('2026-11-30T00:00:00.000Z');
    const asOf = new Date('2026-10-01T00:00:00.000Z');
    expect(tenorDays(due, asOf)).toBe(60);
  });

  it('rejects an unparseable instant', () => {
    expect(() => tenorDays('not-a-date', '2026-10-01')).toThrow(RangeError);
  });
});

describe('priceInvoiceAt', () => {
  it('is priceInvoice composed with tenorDays', () => {
    const fromDate = priceInvoiceAt(
      FACE_40K,
      1250,
      '2026-11-30T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z',
    );
    expect(fromDate.proceeds).toBe(3_917_808n);
    expect(fromDate.tenorDays).toBe(60);
  });
});
