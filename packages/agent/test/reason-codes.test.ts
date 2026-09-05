/**
 * One vocabulary, pinned from both ends.
 *
 * `libraries/ReasonCodes.sol` and `@facture/shared` were deliberately made to spell every
 * overlapping refusal identically, because a proof view showing the chain saying one word and
 * the API another disproves the exact claim it exists to demonstrate. TypeScript defends one
 * end of that on its own: rename a code in shared and {@link ON_CHAIN_REASON_CODE} no longer
 * compiles. Nothing in TypeScript can see the other end, so these tests read the contract
 * source and compare against the strings it actually declares. A rename on either side fails
 * here rather than in front of a funder.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REFUSAL_CODES } from '@facture/shared';
import { AGENT_EMITTED_REFUSAL_CODES, ON_CHAIN_REASON_CODE } from '../src/mandate.js';

/**
 * `bytes32 internal constant NAME = "VALUE";` — the shape every emitted code is declared in.
 *
 * The captured half is the *value*, not the name, because the value is what a `MatchRefused`
 * event carries and therefore what this agent would be reading back. `NONE` is `bytes32(0)`
 * with no string literal and is skipped by construction, which is right: it is the sentinel
 * for "not refused" and is never emitted.
 */
const DECLARED_CODE = /bytes32\s+internal\s+constant\s+\w+\s*=\s*"([^"]+)"\s*;/g;

const REASON_CODES_SOL = new URL(
  '../../contracts/contracts/libraries/ReasonCodes.sol',
  import.meta.url,
);

const emittedOnChain: ReadonlySet<string> = new Set(
  [...readFileSync(REASON_CODES_SOL, 'utf8').matchAll(DECLARED_CODE)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  ),
);

describe('the on-chain refusal vocabulary', () => {
  it('reads real constants out of ReasonCodes.sol', () => {
    // Without this, a regex that had stopped matching would make every assertion below pass
    // by describing an empty set — the failure mode a cross-layer check exists to rule out.
    expect(emittedOnChain.size).toBeGreaterThan(10);
    expect(emittedOnChain.has('EXPOSURE_EXHAUSTED')).toBe(true);
    expect(emittedOnChain.has('NONE')).toBe(false);
  });

  it('names a code the contract really declares, wherever it names one at all', () => {
    for (const [code, onChain] of Object.entries(ON_CHAIN_REASON_CODE)) {
      if (onChain === null) continue;
      expect(emittedOnChain.has(onChain), `${code} maps to ${onChain}`).toBe(true);
    }
  });

  it('translates exactly one refusal, and says which', () => {
    // Derived rather than listed. A code added to shared, or a value quietly changed, shows up
    // here as a new line instead of slipping past a hand-maintained list of exceptions.
    const translated = Object.entries(ON_CHAIN_REASON_CODE)
      .filter(([code, onChain]) => onChain !== null && onChain !== code)
      .map(([code, onChain]) => `${code} -> ${String(onChain)}`);

    expect(translated).toEqual(['INELIGIBLE_JURISDICTION -> CONTROL_LIST_BLOCKED']);
  });

  it('leaves exactly the currency and escrow refusals without an on-chain equivalent', () => {
    const unmodelled = Object.entries(ON_CHAIN_REASON_CODE)
      .filter(([, onChain]) => onChain === null)
      .map(([code]) => code)
      .sort();

    /*
     * `MANDATE_NOT_ESCROWED` replaced `WALLET_BALANCE_SHORT`, and it is `null` here for a
     * sharper reason than its predecessor was. The venue does not refuse an unescrowed bid
     * at all — it reroutes to x402 — so there is no on-chain refusal for this to be the same
     * as. It is the agent declining to arm what it cannot finish, which is a fact about the
     * agent rather than about the trade.
     */
    expect(unmodelled).toEqual(['CURRENCY_MISMATCH', 'MANDATE_NOT_ESCROWED']);
  });

  it('spells every other refusal the same on both sides', () => {
    // The two tests above account for the three exceptions, so everything not named by them
    // has to be an identity. Stated as its own assertion because that is the product claim.
    for (const code of REFUSAL_CODES) {
      if (code === 'INELIGIBLE_JURISDICTION' || code === 'CURRENCY_MISMATCH') continue;
      expect(ON_CHAIN_REASON_CODE[code]).toBe(code);
      expect(emittedOnChain.has(code)).toBe(true);
    }
  });

  it('accounts for every code either layer knows about', () => {
    for (const code of REFUSAL_CODES) {
      expect(ON_CHAIN_REASON_CODE).toHaveProperty(code);
    }
    for (const code of AGENT_EMITTED_REFUSAL_CODES) {
      expect(ON_CHAIN_REASON_CODE).toHaveProperty(code);
    }
  });

  it('refuses under shared’s spelling for everything this agent can itself produce', () => {
    // This is why the one translation is harmless. `INELIGIBLE_JURISDICTION` is decided by a
    // diamond the agent has not called and is absent from AGENT_EMITTED_REFUSAL_CODES, so no
    // refusal this agent can reach carries a name the venue's own records do not use.
    for (const code of AGENT_EMITTED_REFUSAL_CODES) {
      const onChain = ON_CHAIN_REASON_CODE[code];
      if (onChain === null) continue;
      expect(onChain).toBe(code);
      expect(emittedOnChain.has(code)).toBe(true);
    }
  });
});
