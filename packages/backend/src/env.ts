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
    /** This API's own origin, used for resource identifiers a machine reads. */
    PUBLIC_BASE_URL: z.url().default('http://localhost:8787'),
    /**
     * Where the debtor-facing app is served, which is a different origin to this one and
     * cannot be derived from it.
     *
     * The confirmation link is the only URL this venue mints for a person rather than a
     * program, and it has to land on `/confirm/{token}` in the web app. It used to be built
     * against `PUBLIC_BASE_URL`, which pointed it at this API's JSON endpoint — see
     * `services/confirmation.ts` for why no value of that variable could have been right.
     *
     * The default matches the web package's dev server. A deployment that serves the app
     * anywhere else must set this, and the failure if it does not is a link that 404s rather
     * than one that quietly returns the wrong thing.
     */
    PUBLIC_APP_BASE_URL: z.url().default('http://localhost:3000'),
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
    /**
     * The key that signs a resale's ATS hold.
     *
     * **This is custody, and it is named rather than dressed up.** `createHoldByPartition`
     * acts on the caller's own tokens, so a holder reselling has to sign the hold on their
     * own position, and the deployed diamond has no operator route to it — the probes are
     * written up on {@link HoldRequest.holderKey}. A buyer who genuinely self-custodies
     * would sign this themselves; in this build the venue holds the key for the one buyer
     * that has one, and the resale route refuses any other holder rather than pretending.
     *
     * **The key alone, with no account id beside it.** The first version took both and
     * compared the configured id against the holder's — which failed against the live book
     * on the first attempt, because an ECDSA Hedera account has TWO EVM addresses and the
     * two sides had different ones: `0.0.10314099` converts to its long-zero form, while
     * the buyer's row holds the alias derived from the public key. To a Solidity mapping
     * those are unrelated keys, which is the trap already recorded for control-list grants.
     * Deriving the address from the key removes the mismatch by construction, and it is
     * also the address that will actually sign — so the listing check and the hold check
     * cannot disagree.
     *
     * Unset disables resale, the same shape as issuance with no `ATS_FACTORY_ID`.
     */
    RESALE_SIGNER_PRIVATE_KEY: z
      .string()
      .min(1)
      .refine((key) => !key.toLowerCase().startsWith(ED25519_DER_PREFIX), {
        message:
          'looks like an ED25519 key. A hold is an EVM call and ED25519 cannot sign one — ' +
          'the resale signer must be ECDSA.',
      })
      .optional(),
    /**
     * Reg S by default, which is the decision recorded in CLAUDE.md and what the live bond
     * carries. Reg S is the only declaration that both permits international investors and
     * carries no resale hold, and both are load-bearing: a holder relisting on day thirty
     * contradicts a six-month hold, and the cross-chain argument depends on buyers who are
     * not all American. All three require accreditation, so 506(c) buys nothing here.
     */
    ATS_REGULATION_TYPE: z.enum(['reg-d-506b', 'reg-d-506c', 'reg-s']).default('reg-s'),
    ISSUANCE_GAS_LIMIT: z.coerce.number().int().positive().default(10_000_000),
    ISSUANCE_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(4_000),
    ISSUANCE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),
    ISSUANCE_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(2_000),
    /**
     * The account a matured receivable is paid from. Unset disables the payout rail.
     *
     * Must not be the operator. The operator signs the `ScheduleCreate`, so a payout drawn
     * on it would already hold its own required signature and execute on creation — which
     * would report the debtor as having paid at the instant the receivable matured.
     * `services/schedule.ts` refuses that configuration rather than trusting this comment.
     */
    MATURITY_COLLECTION_ACCOUNT_ID: ACCOUNT_ID.optional(),

    /**
     * The HCS topic refusal receipts are committed to. Unset means refusals are recorded and
     * readable but not independently checkable — see `services/hcs.ts`.
     */
    HCS_REFUSAL_TOPIC_ID: ACCOUNT_ID.optional(),

    /**
     * Privy, for seller sign-in. Unset disables the route rather than letting it accept an
     * unverified email — see `services/privy.ts`.
     *
     * The app id is also public and lives in the web package; it is here because verifying
     * a token needs both halves. The secret is a server credential and must never be given
     * a `NEXT_PUBLIC_` prefix, which is an instruction to inline it into the browser bundle.
     */
    PRIVY_APP_ID: z.string().min(1).optional(),
    PRIVY_APP_SECRET: z.string().min(1).optional(),
    /**
     * The Privy wallet policy a signed-in seller's embedded wallet is scoped by. Unset
     * leaves that wallet unscoped — Privy will permit whatever the key is asked to sign —
     * rather than attaching some weaker default; see `services/privy-policy.ts`.
     *
     * It is an id rather than a body because Privy puts no uniqueness constraint on a
     * policy name, so a venue that created its policy on demand would mint a fresh one per
     * restart and be unable to say which one a wallet carried. The policy is created once by
     * `provisionClaimPolicy()` and pinned here.
     */
    PRIVY_WALLET_POLICY_ID: z.string().min(1).optional(),
    /**
     * Only for a Privy app with an authorization keypair registered in the dashboard, where
     * a write to a wallet is refused without a P-256 signature over the request. Unset sends
     * no signature, which is correct for an app that has no such key — it is not a relaxation
     * of anything, because Privy is the one enforcing it either way.
     */
    PRIVY_AUTHORIZATION_PRIVATE_KEY: z.string().min(1).optional(),

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
    /** Smallest-unit exponent of the settlement asset. HBAR is 8; USDC on Hedera is 6. */
    X402_ASSET_DECIMALS: z.coerce.number().int().min(0).max(18).default(8),
    /**
     * Parts-per-million scale on the settled amount. `1_000_000` settles the full amount.
     * Defaults to `1` — one millionth — because a testnet balance cannot cover a six-figure
     * receivable, and a demo that silently settles a coincidental number is worse than one
     * that scales openly.
     *
     * **This governs both rails, despite the `X402_` prefix**, and deliberately so: the Arc
     * escrow converts a mandate's capital at the same scale the Hedera cash leg settles at,
     * so one receivable costs the same money whichever way it goes. A second variable is how
     * the two rails come to quote different prices for one invoice.
     *
     * Not renamed to match, for the reason `DATABASE_URL` was not: a rename falls back to
     * this default on every deployment that still sets the old name, silently, which is the
     * same class of failure as the unit mismatch this was widened to fix.
     */
    X402_SETTLEMENT_SCALE_PPM: z.coerce.number().int().positive().default(1),

    /*
     * Database — SQLite, so this is a path on disk and not a connection URL. Kept under the
     * same name because it is still "where the data is", and a rename would silently fall
     * back to a default on every deploy that had the old one set.
     */
    DATABASE_URL: z
      .string()
      .min(1)
      .refine((value) => value === ':memory:' || !/^[a-z][a-z0-9+.-]*:\/\//i.test(value), {
        message:
          'must be a file path such as ./data/facture.db (or :memory:). Persistence is SQLite; ' +
          'a postgres:// URL has nothing to connect to.',
      }),
  })
  .superRefine((env, ctx) => {
    if (env.X402_ASSET_MODE === 'hts' && env.X402_HTS_ASSET_ID === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['X402_HTS_ASSET_ID'],
        message: 'is required when X402_ASSET_MODE=hts',
      });
    }

    /*
     * Half a configuration must behave like none, and be refused by name.
     *
     * A policy id with no credentials is the dangerous half: in a `.env` it reads exactly
     * like a deployment with the control switched on, and it can never attach anything,
     * because attaching is an authenticated call to Privy. Booting quietly would leave an
     * operator believing every seller's wallet was scoped when none of them was — which is
     * the failure the control exists to make impossible, arriving through configuration.
     */
    if (
      env.PRIVY_WALLET_POLICY_ID !== undefined &&
      (env.PRIVY_APP_ID === undefined || env.PRIVY_APP_SECRET === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['PRIVY_WALLET_POLICY_ID'],
        message:
          'needs PRIVY_APP_ID and PRIVY_APP_SECRET. Attaching a policy is an authenticated ' +
          'call, so an id on its own scopes no wallet while looking as though it does.',
      });
    }

    if (
      env.PRIVY_AUTHORIZATION_PRIVATE_KEY !== undefined &&
      env.PRIVY_WALLET_POLICY_ID === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['PRIVY_AUTHORIZATION_PRIVATE_KEY'],
        message:
          'signs wallet policy writes, and PRIVY_WALLET_POLICY_ID is not set, so there are ' +
          'none to sign.',
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
