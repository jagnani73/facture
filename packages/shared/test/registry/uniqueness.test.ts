import { describe, expect, it } from 'vitest';
import {
  UNIQUENESS_DOMAIN,
  canonicalUniquenessInput,
  canonicaliseDebtorId,
  canonicaliseInvoiceNumber,
  sameReceivable,
  uniquenessHash,
  uniquenessHashOf,
} from '../../src/registry/uniqueness.js';

const DEBTOR = 'DEBTOR-9';
const NUMBER = 'INV-001';
const FACE = 4_000_000n;

describe('canonicalisation', () => {
  it('produces the documented encoding, exactly', () => {
    expect(canonicalUniquenessInput(DEBTOR, NUMBER, FACE)).toBe(
      'facture/uniqueness/v1|8:debtor-9|7:inv-001|7:4000000',
    );
  });

  it('is versioned, so a rule change cannot silently rewrite old hashes', () => {
    expect(UNIQUENESS_DOMAIN).toBe('facture/uniqueness/v1');
    expect(canonicalUniquenessInput(DEBTOR, NUMBER, FACE).startsWith(UNIQUENESS_DOMAIN)).toBe(true);
  });

  it('length-prefixes fields, so no two field splits can collide', () => {
    // Under a naive "join with a separator", ('ab', 'c') and ('a', 'bc') would hash the same.
    expect(canonicalUniquenessInput('ab', 'c', 0n)).not.toBe(
      canonicalUniquenessInput('a', 'bc', 0n),
    );
    expect(uniquenessHash('ab', 'c', 0n)).not.toBe(uniquenessHash('a', 'bc', 0n));
  });

  it('length-prefixes in UTF-8 bytes, not UTF-16 code units', () => {
    // 'é' is one code unit but two bytes. A code-unit length would not survive a Solidity or
    // Go reimplementation of this encoding.
    expect(canonicalUniquenessInput('é', 'x', 0n)).toContain('|2:é|');
  });
});

describe('invoice number normalisation', () => {
  it('case-folds', () => {
    expect(canonicaliseInvoiceNumber('INV-001')).toBe('inv-001');
    expect(uniquenessHash(DEBTOR, 'INV-001', FACE)).toBe(uniquenessHash(DEBTOR, 'inv-001', FACE));
  });

  it('strips every space, not just the ends — one extra space is the obvious attack', () => {
    for (const variant of ['INV-001', ' INV-001', 'INV-001 ', 'INV - 001', 'I N V - 0 0 1']) {
      expect(canonicaliseInvoiceNumber(variant)).toBe('inv-001');
      expect(uniquenessHash(DEBTOR, variant, FACE)).toBe(uniquenessHash(DEBTOR, NUMBER, FACE));
    }
  });

  it('strips non-breaking and other exotic whitespace too', () => {
    // A no-break space and a thin space survive a naive trim() and a / +/ collapse.
    const exotic = 'INV\u00A0-\u2009001';
    expect(canonicaliseInvoiceNumber(exotic)).toBe('inv-001');
    expect(uniquenessHash(DEBTOR, exotic, FACE)).toBe(uniquenessHash(DEBTOR, NUMBER, FACE));
  });

  it('folds full-width characters through NFKC', () => {
    // The same invoice number typed on a Japanese keyboard.
    expect(canonicaliseInvoiceNumber('ＩＮＶ－００１')).toBe('inv-001');
    expect(uniquenessHash(DEBTOR, 'ＩＮＶ－００１', FACE)).toBe(
      uniquenessHash(DEBTOR, NUMBER, FACE),
    );
  });

  it('keeps separators, so different numbering schemes stay different', () => {
    // A false collision refuses an honest invoice with no way for the seller to fix it, so
    // punctuation is deliberately NOT stripped.
    expect(canonicaliseInvoiceNumber('INV-001')).not.toBe(canonicaliseInvoiceNumber('INV001'));
    expect(uniquenessHash(DEBTOR, 'INV-001', FACE)).not.toBe(
      uniquenessHash(DEBTOR, 'INV001', FACE),
    );
  });
});

describe('debtor id normalisation', () => {
  it('trims and case-folds', () => {
    expect(canonicaliseDebtorId('  DEBTOR-9 ')).toBe('debtor-9');
  });

  it('matches a checksummed EVM address against its lower-case form', () => {
    const checksummed = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
    expect(uniquenessHash(checksummed, NUMBER, FACE)).toBe(
      uniquenessHash(checksummed.toLowerCase(), NUMBER, FACE),
    );
  });

  it('does not strip internal whitespace from an id', () => {
    // Ids are opaque. Collapsing inside one would merge two genuinely distinct debtors.
    expect(canonicaliseDebtorId('a b')).toBe('a b');
  });
});

describe('uniquenessHash', () => {
  it('is a 32-byte hex string', () => {
    expect(uniquenessHash(DEBTOR, NUMBER, FACE)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(uniquenessHash(DEBTOR, NUMBER, FACE)).toBe(uniquenessHash(DEBTOR, NUMBER, FACE));
  });

  it('changes when any of the three inputs changes', () => {
    const base = uniquenessHash(DEBTOR, NUMBER, FACE);
    expect(uniquenessHash('DEBTOR-8', NUMBER, FACE)).not.toBe(base);
    expect(uniquenessHash(DEBTOR, 'INV-002', FACE)).not.toBe(base);
    expect(uniquenessHash(DEBTOR, NUMBER, FACE + 1n)).not.toBe(base);
  });

  it('distinguishes amounts that differ by a single minor unit', () => {
    // The same invoice re-listed a cent lighter is a different receivable to the registry,
    // which is why the amount is part of the key rather than a tolerance.
    expect(uniquenessHash(DEBTOR, NUMBER, 4_000_000n)).not.toBe(
      uniquenessHash(DEBTOR, NUMBER, 3_999_999n),
    );
  });

  it('takes the amount as minor units, never a formatted string', () => {
    expect(canonicalUniquenessInput(DEBTOR, NUMBER, 4_000_000n)).toContain('7:4000000');
  });

  it('agrees with the object form', () => {
    expect(uniquenessHashOf({ debtorId: DEBTOR, invoiceNumber: NUMBER, faceValue: FACE })).toBe(
      uniquenessHash(DEBTOR, NUMBER, FACE),
    );
  });

  it('rejects inputs that canonicalise to nothing', () => {
    expect(() => uniquenessHash('   ', NUMBER, FACE)).toThrow(RangeError);
    expect(() => uniquenessHash(DEBTOR, '   ', FACE)).toThrow(RangeError);
  });

  it('rejects a negative face value', () => {
    expect(() => uniquenessHash(DEBTOR, NUMBER, -1n)).toThrow(RangeError);
  });

  it('accepts a zero face value', () => {
    expect(uniquenessHash(DEBTOR, NUMBER, 0n)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('sameReceivable', () => {
  it('compares hashes case-insensitively', () => {
    const hash = uniquenessHash(DEBTOR, NUMBER, FACE);
    expect(sameReceivable(hash, hash.toUpperCase().replace('0X', '0x'))).toBe(true);
  });

  it('separates different receivables', () => {
    expect(
      sameReceivable(uniquenessHash(DEBTOR, NUMBER, FACE), uniquenessHash(DEBTOR, 'INV-002', FACE)),
    ).toBe(false);
  });
});
