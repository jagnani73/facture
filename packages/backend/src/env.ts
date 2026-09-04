/**
 * Environment schema. Parsed once at boot; a bad or missing variable stops the
 * process with a message that names the variable rather than a stack trace.
 *
 * Chain constants (chain ids, RPC URLs, decimals, explorer bases) are NOT here —
 * they live in `@facture/shared` so backend, web and agent cannot disagree.
 * See `src/chain.ts`. Only secrets, endpoints and per-deployment knobs belong here.
 * Where a knob is *bounded* by a chain constant — the Arc gas floor below — the bound is
 * read from shared rather than copied, or the two would eventually disagree in silence.
 */

import { z } from 'zod';
import { arc } from './chain.js';
import { LOG_LEVELS } from './logger.js';

/** Hedera native id form, e.g. `0.0.12345`. */
const ACCOUNT_ID = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'must be a Hedera id in `shard.realm.num` form, e.g. 0.0.12345');

const HEX_32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte hex key');

/**
 * ED25519 keys are DER-encoded with this OID prefix. They hold HBAR and HTS fine but
 * cannot sign EVM transactions, and the failure surfaces late as INVALID_SIGNATURE.
 * Catching it at boot is worth the four lines.
 */
const ED25519_DER_PREFIX = '302e020100300506032b657004220420';

export const envSchema = z
  .object({
    // Server
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().max(65535).default(8787),
    HOST: z.string().min(1).default('0.0.0.0'),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    PUBLIC_BASE_URL: z.url().default('http://localhost:8787'),
    CONFIRMATION_TOKEN_SECRET: z.string().min(32, 'must be at least 32 characters of entropy'),
    CONFIRMATION_TOKEN_TTL_HOURS: z.coerce.number().int().positive().default(168),

    // Hedera
    HEDERA_OPERATOR_ID: ACCOUNT_ID,
    HEDERA_OPERATOR_KEY: z
      .string()
      .min(1)
      .refine((key) => !key.toLowerCase().startsWith(ED25519_DER_PREFIX), {
        message:
          'looks like an ED25519 key. ATS deployment runs over the EVM and ED25519 cannot ' +
          'sign EVM transactions — provision an ECDSA key.',
      }),
    ATS_FACTORY_ID: ACCOUNT_ID.optional(),
    ATS_REGULATION_TYPE: z.enum(['reg-d-506b', 'reg-d-506c', 'reg-s']).default('reg-d-506c'),
    ISSUANCE_GAS_LIMIT: z.coerce.number().int().positive().default(10_000_000),
    ISSUANCE_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(4_000),
    ISSUANCE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),
    ISSUANCE_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(2_000),

    // Arc
    ARC_SETTLEMENT_PRIVATE_KEY: HEX_32,
    ARC_MAX_FEE_PER_GAS_GWEI: z.coerce
      .number()
      .int()
      .min(
        arc.minMaxFeePerGasGwei,
        `Arc rejects anything under ${arc.minMaxFeePerGasGwei} Gwei as \`transaction underpriced\``,
      )
      .default(arc.minMaxFeePerGasGwei),

    // x402 / Blocky402
    X402_FACILITATOR_URL: z.url().default('https://api.testnet.blocky402.com'),
    X402_ASSET_MODE: z.enum(['hbar', 'hts']).default('hbar'),
    X402_HTS_ASSET_ID: ACCOUNT_ID.optional(),
    X402_PAY_TO: ACCOUNT_ID,
    X402_SUPPORTED_TTL_SECONDS: z.coerce.number().int().positive().default(300),

    // Database
    DATABASE_URL: z.string().min(1).startsWith('postgres', 'must be a postgres:// connection URL'),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  })
  .superRefine((env, ctx) => {
    if (env.X402_ASSET_MODE === 'hts' && env.X402_HTS_ASSET_ID === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['X402_HTS_ASSET_ID'],
        message: 'is required when X402_ASSET_MODE=hts',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EnvValidationError';
    this.problems = problems;
  }
}

/**
 * Parses `raw` against the schema. Throws `EnvValidationError` listing every problem
 * at once — one restart per fix is a bad way to configure a service.
 */
export function parseEnv(raw: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(raw);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => {
    const name = issue.path.map(String).join('.') || '(root)';
    const absent = issue.path.length === 1 && raw[name] === undefined;
    return absent && issue.code === 'invalid_type'
      ? `${name} is required but not set`
      : `${name} ${issue.message}`;
  });

  throw new EnvValidationError([...new Set(problems)]);
}
