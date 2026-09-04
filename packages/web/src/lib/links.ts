/**
 * The two links in the chrome that name a specific trade.
 *
 * "See how a trade is proven" is a good invitation and a bad promise if the reference is
 * one only the demo book has. Against a live venue there is no trade id known at build
 * time, so the invitation points at the book instead — every settled row there carries its
 * own proof link, which is where the claim actually lives.
 */

import { isDemoBook } from '@/lib/data';

/** The demo book's fully-settled trade. Exists only in `src/lib/fixtures.ts`. */
const DEMO_TRADE = 'TRD-4417';

export const proofExample = (): string => (isDemoBook() ? `/proof/${DEMO_TRADE}` : '/book');

export const proofExampleLabel = (): string =>
  isDemoBook() ? 'How a trade is proven' : 'Every settled trade carries its proof';
