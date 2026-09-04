import { describe, expect, it } from 'vitest';
import {
  compareRating,
  isRating,
  meetsRatingFloor,
  RATING_RANK,
  RATINGS,
  type Rating,
} from '../../src/types/rating.js';

describe('the rating scale', () => {
  it('is platform-scoped notation, not agency notation', () => {
    // These grades are earned from settled payments on Facture. S&P notation would claim
    // an authority the score does not have, so it must not parse as a rating.
    for (const agency of ['AAA', 'AA', 'BBB', 'BB', 'CCC', 'Aa2', 'investment grade']) {
      expect(isRating(agency)).toBe(false);
    }
    expect(RATINGS).toEqual(['A', 'B', 'C', 'UNRATED', 'D']);
  });

  it('ranks every grade, and the array order is the ranking', () => {
    const ranks = RATINGS.map((r) => RATING_RANK[r]);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    expect(new Set(ranks).size).toBe(RATINGS.length);
  });

  it('ranks a defaulted customer BELOW an unrated one', () => {
    // A default is information; an absence of history is not.
    expect(RATING_RANK.D).toBeLessThan(RATING_RANK.UNRATED);
    expect(compareRating('UNRATED', 'D')).toBeLessThan(0);
  });
});

describe('meetsRatingFloor', () => {
  it('accepts a grade at or above the floor', () => {
    expect(meetsRatingFloor('A', 'A')).toBe(true);
    expect(meetsRatingFloor('A', 'C')).toBe(true);
    expect(meetsRatingFloor('C', 'B')).toBe(false);
  });

  it('excludes both unrated and defaulted customers at a floor of C', () => {
    expect(meetsRatingFloor('UNRATED', 'C')).toBe(false);
    expect(meetsRatingFloor('D', 'C')).toBe(false);
  });

  it('accepts everything except a defaulted customer at a floor of UNRATED', () => {
    // `UNRATED` is the widest floor a buyer can write, and it is still not "anything".
    const accepted = RATINGS.filter((r) => meetsRatingFloor(r, 'UNRATED'));
    expect(accepted).toEqual(['A', 'B', 'C', 'UNRATED']);
    expect(meetsRatingFloor('D', 'UNRATED')).toBe(false);
  });
});

describe('compareRating', () => {
  it('sorts best credit first, defaulted last', () => {
    const shuffled: Rating[] = ['UNRATED', 'A', 'D', 'C', 'B'];
    expect([...shuffled].sort(compareRating)).toEqual(['A', 'B', 'C', 'UNRATED', 'D']);
  });
});
