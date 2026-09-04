/**
 * Boot configuration: validated environment plus the chain table from `@facture/shared`.
 *
 * `loadConfig()` is called once, first thing in `index.ts`, so a misconfigured deploy
 * dies at startup with a readable message instead of on the first request that needs
 * the missing variable.
 */

import { arc, arcChain, hedera } from './chain.js';
import type { Env } from './env.js';
import { EnvValidationError, parseEnv } from './env.js';

export interface Config {
  readonly env: Env;
  readonly isProduction: boolean;
  readonly chain: {
    readonly arc: typeof arc;
    readonly arcChain: typeof arcChain;
    readonly hedera: typeof hedera;
  };
}

let cached: Config | undefined;

export function loadConfig(raw: Record<string, string | undefined> = process.env): Config {
  const env = parseEnv(raw);
  cached = {
    env,
    isProduction: env.NODE_ENV === 'production',
    chain: { arc, arcChain, hedera },
  };
  return cached;
}

/** Memoised accessor. Throws if something reads config before `loadConfig()` ran. */
export function getConfig(): Config {
  if (!cached) {
    throw new Error('Config accessed before loadConfig() — call it first in the entrypoint.');
  }
  return cached;
}

/** Only for tests that need a clean slate between cases. */
export function resetConfig(): void {
  cached = undefined;
}

export { EnvValidationError };
export type { Env };
