/**
 * Emits the static copies of the Facture mark from `src/lib/mark.ts`.
 *
 *   src/app/icon.svg    the favicon, square, picked up automatically by Next's metadata
 *   public/logo.svg     light ink, for the README and anything off-site
 *   public/logo-dark.svg  the same mark in dark ink
 *
 * Two files rather than one with a media query because GitHub strips `<style>` from
 * README images, so a dark-mode README needs `<picture>` and a second source. Run with
 * `pnpm build:mark` after changing the geometry; the outputs are committed, because a
 * favicon that only exists after a build step is a favicon that is missing in CI.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COLORS,
  CURVE,
  LINE_WIDTH,
  NODE,
  PAR_LINE,
  RULES,
  RULE_WIDTH,
  SQUARE_VIEW_BOX,
  TILE_GROUND,
  VIEW_BOX,
} from '../src/lib/mark.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function render({ viewBox, ink, accent, ground }) {
  const rules = RULES.map(
    (r) => `    <path d="M ${r.x1} ${r.y} H ${r.x2}" stroke-width="${RULE_WIDTH}"/>`,
  ).join('\n');

  // The ground, where there is one, is the view box itself — so the tile stays square
  // and fully painted however the view box is later recentred.
  const [gx, gy, gw, gh] = viewBox.split(' ');
  const backdrop = ground
    ? `\n  <rect x="${gx}" y="${gy}" width="${gw}" height="${gh}" fill="${ground}"/>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="none">${backdrop}
  <g stroke="${ink}" stroke-linecap="butt">
    <path d="${CURVE}" stroke-width="${LINE_WIDTH}"/>
${rules}
  </g>
  <path d="${PAR_LINE}" stroke="${accent}" stroke-width="${LINE_WIDTH}"/>
  <circle cx="${NODE.cx}" cy="${NODE.cy}" r="${NODE.r}" fill="${accent}"/>
</svg>
`;
}

const outputs = [
  ['src/app/icon.svg', { viewBox: SQUARE_VIEW_BOX, ...COLORS.light, ground: TILE_GROUND }],
  ['public/logo.svg', { viewBox: VIEW_BOX, ...COLORS.light }],
  ['public/logo-dark.svg', { viewBox: VIEW_BOX, ...COLORS.dark }],
];

for (const [path, opts] of outputs) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, render(opts));
  console.log('wrote', path);
}
