import { describe, expect, it } from 'vitest';
import { accumulate, assess, emptyRecord } from '../src/services/rating.js';

const at = new Date('2026-09-01T00:00:00Z');

function withOutcomes(...outcomes: ('on_time' | 'late' | 'default')[]) {
  return outcomes.reduce(
    (record, outcome) => accumulate(record, outcome, 4_000_000n, at),
    emptyRecord('debtor-1'),
  );
}

describe('rating bucketing', () => {
  it('starts UNRATED, which is the cold start the product states rather than hides', () => {
    const assessment = assess(emptyRecord('debtor-1'));
    expect(assessment.rating).toBe('UNRATED');
    expect(assessment.score).toBe(0);
    expect(assessment.nextGradeAt).toBe(1);
  });

  it('tightens one grade at a time as invoices settle on time', () => {
    expect(assess(withOutcomes('on_time')).rating).toBe('C');
    expect(assess(withOutcomes(...Array<'on_time'>(4).fill('on_time'))).rating).toBe('B');
    expect(assess(withOutcomes(...Array<'on_time'>(8).fill('on_time'))).rating).toBe('A');
  });

  it('counts a late payment as costing two on-time ones', () => {
    const record = withOutcomes('on_time', 'on_time', 'on_time', 'on_time', 'late');
    expect(record.settledLate).toBe(1);
    expect(assess(record).score).toBe(2);
    expect(assess(record).rating).toBe('C');
  });

  it('marks a default permanently, whatever the record before it', () => {
    const record = withOutcomes(...Array<'on_time'>(20).fill('on_time'), 'default');
    const assessment = assess(record);
    expect(assessment.rating).toBe('D');
    expect(assessment.permanentlyMarked).toBe(true);
    expect(assessment.nextGradeAt).toBeNull();
  });

  it('does not credit a defaulted face value as settled', () => {
    expect(withOutcomes('default').settledFaceValue).toBe(0n);
    expect(withOutcomes('on_time').settledFaceValue).toBe(4_000_000n);
  });
});
