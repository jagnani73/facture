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

const baseEnvSchema = z.object({
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

  // ── Arc ───────────────────────────────────────────────────────────────────────────
  /** Arc JSON-RPC. Defaults to the shared chain config; override only for a private node. */
  ARC_RPC_URL: z.string().url().default(ARC_TESTNET.rpcUrl),

  // ── The venue ─────────────────────────────────────────────────────────────────────
  FACTURE_API_URL: z.string().url().default('http://localhost:8787'),
  FACTURE_API_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /**
   * The budget for `POST /v1/trades` alone, which is a different kind of call.
   *
   * Arming a trade is two Hedera round trips and took about fifteen seconds the first time
   * it ran for real, so the ten seconds that suits every other route is not enough — the
   * client gave up while the venue was still working and the trade was armed anyway. Kept
   * separate rather than raising the shared budget, because a hung read should not stall
   * the loop for a minute to accommodate a write.
   */
  FACTURE_API_TRADE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
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
  /**
   * The wallet set `AGENT_WALLET_ID` is expected to belong to.
   *
   * Optional, and read by exactly one thing: the funding path checks the wallet about to
   * spend really is in this set before approving anything. A wallet id is an opaque UUID
   * with no visible relationship to the deployment that made it, so pasting the wrong one
   * looks identical to pasting the right one right up until the money leaves the wrong
   * wallet. One read of `getWallet` turns that into a refusal.
   *
   * It was parsed and read by nothing at all before that — one of the mechanisms this
   * repo's sweep counted.
   */
  AGENT_WALLET_SET_ID: z.string().min(1).optional(),

  // ── Hedera — the x402 cash leg ────────────────────────────────────────────────────
  /**
   * The buyer's Hedera account and key, for signing x402 payments.
   *
   * **Optional, and its absence disables a rail rather than relaxing one.** With no key the
   * agent trades only against mandates whose capital is escrowed on Arc — a coherent desk,
   * just one that cannot take an unfunded bid. Falling back to arming those anyway would
   * reserve a seller's paper against a payment nothing here could make.
   *
   * The key must be **ECDSA**. An ED25519 account holds HBAR perfectly well and cannot
   * produce a signature the facilitator will accept, and the failure surfaces late as an
   * opaque `signature_invalid` rather than as anything naming the curve.
   */
  AGENT_HEDERA_ACCOUNT_ID: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, 'must be a Hedera account id like 0.0.1234, not an EVM address')
    .optional(),
  AGENT_HEDERA_PRIVATE_KEY: z.string().min(1, 'must not be empty when set').optional(),

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

/**
 * The schema, plus the one rule that spans two variables.
 *
 * An account id with no key, or a key with no account id, is a half-configured rail — and
 * half a rail behaves exactly like no rail while looking exactly like a working one in a
 * `.env`. It is refused by name rather than ignored, because the symptom otherwise is the
 * agent quietly refusing every unescrowed bid and nothing saying why.
 */
export const envSchema = baseEnvSchema.refine(
  (env) =>
    (env.AGENT_HEDERA_ACCOUNT_ID === undefined) === (env.AGENT_HEDERA_PRIVATE_KEY === undefined),
  {
    path: ['AGENT_HEDERA_PRIVATE_KEY'],
    message:
      'must be set together with AGENT_HEDERA_ACCOUNT_ID — set both to enable the x402 cash ' +
      'leg on Hedera, or neither to trade only against mandates escrowed on Arc',
  },
);

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

/**
 * Every value in `env` that must never be logged. Fed to the logger's redactor at boot.
 *
 * The Hedera key belongs here for a reason the Circle credentials do not have: it is the one
 * secret that appears in a *stack trace*. `PrivateKey.fromStringECDSA` throws on a malformed
 * key, and an SDK that echoed what it was given would put a spendable key on stderr on the
 * one code path guaranteed to run when the configuration is wrong.
 */
export const secretsOf = (env: Env): readonly string[] =>
  [env.CIRCLE_API_KEY, env.CIRCLE_ENTITY_SECRET, env.AGENT_HEDERA_PRIVATE_KEY].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
