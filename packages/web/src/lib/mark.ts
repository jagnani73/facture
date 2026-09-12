/**
 * The Facture mark, as geometry.
 *
 * A zero-coupon discount curve pulling to par: the ink arc rises out of a ruled ledger
 * page and meets a teal par line at a single node — the one payment, on the maturity
 * date, that the whole instrument consists of. The three rules beneath it are the book
 * the curve is read off.
 *
 * This module is the ONLY place the geometry exists. The React component renders it
 * inline so it inherits the live theme, and `scripts/build-mark.mjs` emits the static
 * files (the favicon, and the light/dark pair the README uses) from these same numbers.
 * Four hand-maintained copies of one mark is four chances for them to stop being the
 * same mark.
 *
 * Coordinates are the mark's own units, cropped tight: no padding is baked in, so a
 * caller decides its own breathing room. Square contexts pad with `SQUARE_VIEW_BOX`.
 */

/** Tight crop around the drawn mark — 795 x 422, no dead canvas. */
export const VIEW_BOX = '0 0 795 422';

/**
 * The same mark centred in a square, with a margin. Favicons and avatars are square, and
 * letterboxing a 1.88:1 mark is the cost of the mark being that shape. The margin is here
 * because this view box is the one that gets a printed ground behind it, and a tile whose
 * ink runs to the edge reads as a crop rather than as a page.
 */
export const SQUARE_VIEW_BOX = '-34.5 -221 864 864';

/** The curve and its par line carry the eye, so they are the heavier weight. */
export const LINE_WIDTH = 26;

/** The ledger beneath is structure, not subject. Hairlines, as everywhere else in the app. */
export const RULE_WIDTH = 20;

/** The discount curve: steep out of the page, flattening as it approaches par. */
export const CURVE = 'M 13 422 C 13 222 273 34 523 34';

/** Par. The curve does not cross it, it arrives at it and stops. */
export const PAR_LINE = 'M 523 34 H 795';

/** The redemption node, where the curve meets par. */
export const NODE = { cx: 523, cy: 34, r: 34 } as const;

/**
 * The book: three rules, 60 apart, each inset a constant 24 from the curve's edge and
 * shortening as they descend. The bottom rule's underside is flush with the foot of the
 * curve, so the mark sits on one baseline rather than two.
 */
export const RULES: readonly { x1: number; x2: number; y: number }[] = [
  { x1: 87, x2: 613, y: 292 },
  { x1: 60, x2: 453, y: 352 },
  { x1: 50, x2: 358, y: 412 },
];

/**
 * Static colours, for the files that render outside a stylesheet. In the app the mark
 * takes its ink from `currentColor` and its accent from `--accent`, so it follows the
 * theme toggle rather than only the operating system. These are the same token values
 * as `globals.css` and must not drift from them.
 */
export const COLORS = {
  light: { ink: '#1a1815', accent: '#0d6e76' },
  dark: { ink: '#ece5d6', accent: '#46a8ab' },
} as const;

/**
 * The favicon's ground, and the only place the mark carries one.
 *
 * It is the light stock in both themes on purpose: a browser draws favicons against
 * chrome this page does not control and cannot measure, so a mark that changes ground
 * with the operating system is a mark that is sometimes invisible and always a different
 * tile. One printed tile, recognised in a row of twenty, beats two correct ones.
 */
export const TILE_GROUND = '#f8f3ea';
