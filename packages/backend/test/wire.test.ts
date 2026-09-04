import { refusalReceipt } from '@facture/shared';
import type { Quote } from '@facture/shared';
import { describe, expect, it } from 'vitest';
import { money, moneyString, wireQuote, wireRefusalReceipt } from '../src/wire.js';

const quote: Quote = {
  invoiceId: 'INV-1',
  mandateId: 'MND-1',
  annualisedYieldBps: 800,
  tenorDays: 60,
  faceValue: 4_000_000n,
  discount: 52_603n,
  proceeds: 3_947_397n,
  currency: 'USD',
  asOf: '2026-09-01T00:00:00.000Z',
  expiresAt: '2026-09-01T00:05:00.000Z',
};

describe('inbound money', () => {
  it('parses a decimal string of minor units to a bigint', () => {
    expect(moneyString.parse('4000000')).toBe(4_000_000n);
  });

  it('carries amounts past 2^53 without loss, which is the whole reason for the string', () => {
    const beyondDouble = '9007199254740993'; // 2^53 + 1
    expect(moneyString.parse(beyondDouble)).toBe(9_007_199_254_740_993n);
    // The JSON-number route silently rounds this to 2^53. That is the failure being avoided.
    expect(Number(beyondDouble)).toBe(9_007_199_254_740_992);
  });

  it('rejects a major-unit decimal rather than guessing the scale', () => {
    // Accepting "40000.00" would be a hundredfold error in whichever direction we guessed.
    expect(moneyString.safeParse('40000.00').success).toBe(false);
    expect(moneyString.safeParse('4e7').success).toBe(false);
    expect(moneyString.safeParse('-4000000').success).toBe(false);
    expect(moneyString.safeParse('04000000').success).toBe(false);
  });
});

describe('outbound money', () => {
  it('renders base 10, never exponential notation', () => {
    expect(money(4_000_000n)).toBe('4000000');
    expect(money(10n ** 24n)).toBe('1000000000000000000000000');
  });

  it('renders every amount on a quote as a string, and leaves the rest alone', () => {
    const wire = wireQuote(quote);
    expect(wire.faceValue).toBe('4000000');
    expect(wire.discount).toBe('52603');
    expect(wire.proceeds).toBe('3947397');
    expect(wire.tenorDays).toBe(60);
    expect(wire.annualisedYieldBps).toBe(800);
    // The point of the exercise: this is what `c.json` does, and it used to throw.
    expect(() => JSON.stringify(wire)).not.toThrow();
  });

  it('converts refusal operands structurally, so a new variant cannot reintroduce the throw', () => {
    const receipt = refusalReceipt(
      'INV-1',
      'MND-1',
      {
        code: 'DEBTOR_CONCENTRATION',
        debtorId: 'DBT-PETRA',
        debtorName: 'Petra Foods Group',
        required: 5_933_178n,
        remainingForDebtor: 4_000_000n,
        maxPerDebtor: 4_000_000n,
        currency: 'USD',
      },
      '2026-09-01T00:00:00.000Z',
    );

    const wire = wireRefusalReceipt(receipt);
    expect(wire.detail.required).toBe('5933178');
    expect(wire.detail.remainingForDebtor).toBe('4000000');
    expect(wire.detail.debtorName).toBe('Petra Foods Group');
    // The sentence is denormalised onto the receipt and must survive untouched.
    expect(wire.humanReason).toBe(receipt.humanReason);
    expect(() => JSON.stringify(wire)).not.toThrow();
  });
});
