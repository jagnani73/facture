/**
 * Environment schema. Parsed once at boot; a bad or missing variable stops the process with
 * a message that names the variable rather than a stack trace.
 *
 * **No error raised here ever contains a value.** The formatter below prints the variable
 * name and the rule it broke, and nothing else — a schema failure on `CIRCLE_ENTITY_SECRET`
 * that helpfully echoed what it received would put the secret in the log on the one code
 * path guaranteed to run when something is wrong.
 *
 * Chain constants — chain ids, RPC URLs, token addresses, decimals — are **not** here. They
 * live in `@facture/shared` so the backend, the web app and this agent cannot disagree. The
 * only chain-shaped variables below are overrides, and each defaults to the shared value.
 */

import { ARC_TESTNET } from '@facture/shared';
import { z } from 'zod';
import { LOG_LEVELS } from './logger.js';

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

export const envSchema = z.object({
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  // ── Circle ────────────────────────────────────────────────────────────────────────
  /**
   * Circle API key and entity secret. Both are credentials; both are registered with the
   * logger's redactor at boot so they cannot reach stdout even inside an axios error dump.
   */
  CIRCLE_API_KEY: z.string().min(1, 'is required'),
  CIRCLE_ENTITY_SECRET: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be 32 bytes of hex — 64 hex characters, no 0x prefix'),
  CIRCLE_BASE_URL: z.string().url().optional(),

  // ── Arc ───────────────────────────────────────────────────────────────────────────
  /** Circle's identifier for the chain. Testnet only: Arc mainnet lands after submissions close. */
  ARC_BLOCKCHAIN: z.string().min(1).default('ARC-TESTNET'),
  /**
   * USDC's ERC-20 address. 6 decimals on that interface; Arc's native gas accounting uses
   * 18 over the same balance, and the two must never meet in one calculation.
   */
  ARC_USDC_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte EVM address')
    .default(ARC_TESTNET.tokens.USDC.address),

  // ── The venue ─────────────────────────────────────────────────────────────────────
  FACTURE_API_URL: z.string().url().default('http://localhost:8787'),
  FACTURE_API_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** The buyer whose mandates this process operates. */
  AGENT_BUYER_ID: z.string().min(1, 'is required — the buyer whose mandates this agent operates'),
  /**
   * Sellers whose books this agent watches, comma-separated. The venue exposes the book per
   * seller today; when a buyer-side book route exists, this goes away.
   */
  AGENT_SELLER_IDS: z
    .string()
    .min(1, 'is required — comma-separated seller ids whose books this agent reads')
    .transform(csv)
    .refine((ids) => ids.length > 0, 'must name at least one seller'),
  /** Restrict to these mandates. Absent means every active mandate the buyer holds. */
  AGENT_MANDATE_IDS: z.string().transform(csv).optional(),

  // ── The wallet ────────────────────────────────────────────────────────────────────
  /** Circle wallet holding the mandates' capital. Its balance is what makes a bid firm. */
  AGENT_WALLET_ID: z.string().min(1, 'is required — the Circle wallet backing these mandates'),
  AGENT_WALLET_SET_ID: z.string().min(1).optional(),

  // ── The loop ──────────────────────────────────────────────────────────────────────
  AGENT_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
  AGENT_MAX_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(500).default(0),
  /**
   * Decide and report, arm nothing. **Defaults on.** Arming a trade commits the mandate and
   * puts a hold on the Hedera leg, so it is opt-in: an operator has to say `false` in so
   * many words before this process can move money.
   */
  AGENT_DRY_RUN: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** One pass and exit, rather than polling. For a demo, a cron, or a smoke test. */
  AGENT_ONCE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parse `process.env`.
 *
 * Throws with every failing variable named at once, rather than one per run. The message is
 * built from issue paths and rule descriptions only — never from the received value.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;

  const lines = result.error.issues.map((issue) => {
    const name = issue.path.join('.') || '<environment>';
    const message = issue.code === 'invalid_type' ? 'is required' : issue.message;
    return `  ${name}: ${message}`;
  });
  throw new Error(`Invalid environment:\n${lines.join('\n')}`);
}

/** Every value in `env` that must never be logged. Fed to the logger's redactor at boot. */
export const secretsOf = (env: Env): readonly string[] => [
  env.CIRCLE_API_KEY,
  env.CIRCLE_ENTITY_SECRET,
];
