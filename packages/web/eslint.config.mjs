// The web package lints under the workspace root config so that one rule set
// governs every package. Kept as a re-export rather than a copy so the two can
// never drift.
export { default } from '../../eslint.config.mjs';
