import { describe, expect, it } from 'vitest';
import {
  generateIsin,
  isValidIsin,
  isinCheckDigit,
  isinForInvoice,
  nsinFromHash,
  parseIsin,
  validateIsin,
} from '../../src/isin/isin.js';

/**
 * Real, issued ISINs. The check-digit implementation is proved against these rather than
 * against a restatement of the algorithm — a wrong implementation tested only against its
 * own output passes happily, and `deployBond` would then reject every issuance.
 */
const REAL_ISINS: [string, string][] = [
  ['US0378331005', 'Apple'],
  ['GB0002634946', 'BAE Systems'],
  ['US5949181045', 'Microsoft'],
  ['US38259P5089', 'Google (former)'],
  ['FR0000131104', 'BNP Paribas'],
  ['DE0005557508', 'Deutsche Telekom'],
  ['NL0000729408', 'Wikipedia worked example'],
  ['AU0000XVGZA3', 'Wikipedia worked example, letters in the NSIN'],
  ['US88160R1014', 'Tesla'],
  ['JP3633400001', 'Toyota'],
  ['CH0038863350', 'Nestle'],
  ['IE00B4BNMY34', 'Accenture'],
  ['CA9861913023', 'Yamana Gold'],
  ['US0231351067', 'Amazon'],
  ['US02079K3059', 'Alphabet class C'],
  ['GB0009252882', 'GSK'],
  ['DE000BAY0017', 'Bayer'],
  ['SE0000108656', 'Ericsson'],
  ['KYG875721634', 'Tencent'],
];

describe('isinCheckDigit', () => {
  it.each(REAL_ISINS)('computes the published check digit of %s (%s)', (isin) => {
    expect(String(isinCheckDigit(isin.slice(0, 11)))).toBe(isin.slice(11));
  });

  it('doubles on the expanded digits, not on the letter values', () => {
    // US expands to 3028, and the 3 and the 0 land in different doubling positions. An
    // implementation that ran Luhn over [30, 28, 0, 3, ...] would produce 3 here.
    expect(isinCheckDigit('US037833100')).toBe(5);
  });
});

describe('validateIsin', () => {
  it.each(REAL_ISINS)('accepts %s (%s)', (isin) => {
    const result = validateIsin(isin);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(isin);
  });

  it('normalises case and surrounding whitespace', () => {
    const result = validateIsin('  us0378331005  ');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('US0378331005');
  });

  it('rejects a plausible-looking ISIN with the wrong check digit', () => {
    const result = validateIsin('XS1084209034');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CHECKSUM_MISMATCH');
      expect(result.error.expectedCheckDigit).toBe(7);
    }
  });

  it('rejects every single-digit corruption of a valid ISIN', () => {
    const valid = 'US0378331005';
    for (let position = 0; position < valid.length; position += 1) {
      for (const replacement of '0123456789') {
        if (valid[position] === replacement) continue;
        const corrupted = valid.slice(0, position) + replacement + valid.slice(position + 1);
        expect(isValidIsin(corrupted)).toBe(false);
      }
    }
  });

  it('rejects the wrong length', () => {
    const short = validateIsin('US037833100');
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.error.code).toBe('INVALID_LENGTH');

    const long = validateIsin('US03783310055');
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error.code).toBe('INVALID_LENGTH');
  });

  it('rejects a malformed shape', () => {
    for (const bad of [
      '1S0378331005', // digit in the country code
      'US-378331005', // punctuation in the NSIN
      'US037833100A', // check digit is not a digit
      'US03783310+5', // symbol in the NSIN
    ]) {
      const result = validateIsin(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_FORMAT');
    }
  });

  it('accepts letters inside the NSIN, which are legal and not a typo', () => {
    // US0378331OO5 — capital O where a zero might be expected — is a well-formed ISIN whose
    // check digit happens to be correct. The checksum is not a spell-checker.
    expect(isValidIsin('US0378331OO5')).toBe(true);
    expect(isValidIsin('AU0000XVGZA3')).toBe(true);
  });
});

describe('generateIsin', () => {
  it('reproduces a real ISIN from its country code and NSIN', () => {
    const result = generateIsin('US', '037833100');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('US0378331005');
  });

  it('left-pads a short NSIN to nine characters', () => {
    const result = generateIsin('US', '1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.slice(0, 11)).toBe('US000000001');
      expect(isValidIsin(result.value)).toBe(true);
    }
  });

  it('normalises case in both arguments', () => {
    const lower = generateIsin('us', '037833100');
    expect(lower.ok).toBe(true);
    if (lower.ok) expect(lower.value).toBe('US0378331005');
  });

  it('rejects a country code that is not two letters', () => {
    for (const bad of ['U', 'USA', 'U1', '12']) {
      const result = generateIsin(bad, '037833100');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_COUNTRY_CODE');
    }
  });

  it('rejects an NSIN that is too long or contains illegal characters', () => {
    for (const bad of ['0123456789', 'ABC-12345', '']) {
      const result = generateIsin('US', bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_NSIN');
    }
  });

  it('always produces something validateIsin accepts', () => {
    for (let n = 0; n < 500; n += 1) {
      const nsin = (n * 7919).toString(36).toUpperCase().slice(0, 9);
      const result = generateIsin('US', nsin === '' ? '0' : nsin);
      expect(result.ok).toBe(true);
      if (result.ok) expect(isValidIsin(result.value)).toBe(true);
    }
  });
});

describe('nsinFromHash / isinForInvoice', () => {
  const HASH = '0x9c22ff5f21f0b81b113e63f7db6da94fedef11b2119b4088b89664fb9a3cb658';

  it('derives a nine-character alphanumeric NSIN', () => {
    const nsin = nsinFromHash(HASH);
    expect(nsin).toHaveLength(9);
    expect(nsin).toMatch(/^[0-9A-Z]{9}$/);
  });

  it('is deterministic — the same invoice always gets the same ISIN', () => {
    // Issuance is paced, retried after BUSY, and occasionally replayed. An ISIN that drifted
    // between attempts would let one receivable acquire two instruments.
    expect(isinForInvoice(HASH)).toBe(isinForInvoice(HASH));
    expect(nsinFromHash(HASH)).toBe(nsinFromHash(HASH));
  });

  it('ignores the 0x prefix and hex casing', () => {
    expect(nsinFromHash(HASH.slice(2))).toBe(nsinFromHash(HASH));
    expect(nsinFromHash(HASH.toUpperCase().replace('0X', '0x'))).toBe(nsinFromHash(HASH));
  });

  it('produces a checksum-valid ISIN for any hash', () => {
    for (let n = 1; n <= 300; n += 1) {
      const hash = `0x${(BigInt(n) * 0x9e3779b97f4a7c15n).toString(16).padStart(64, '0')}`;
      expect(isValidIsin(isinForInvoice(hash))).toBe(true);
    }
  });

  it('gives different invoices different identifiers', () => {
    const a = isinForInvoice(`0x${'11'.repeat(32)}`);
    const b = isinForInvoice(`0x${'22'.repeat(32)}`);
    expect(a).not.toBe(b);
  });

  it('honours a non-default country code', () => {
    expect(isinForInvoice(HASH, 'GB').startsWith('GB')).toBe(true);
  });

  it('rejects something that is not a hash', () => {
    expect(() => nsinFromHash('0xnothex')).toThrow(RangeError);
    expect(() => nsinFromHash('')).toThrow(RangeError);
  });
});

describe('parseIsin', () => {
  it('splits a valid ISIN into its parts', () => {
    const result = parseIsin('US0378331005');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        countryCode: 'US',
        nsin: '037833100',
        checkDigit: 5,
      });
    }
  });

  it('propagates a validation failure rather than parsing garbage', () => {
    const result = parseIsin('US0378331004');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CHECKSUM_MISMATCH');
  });
});
