/**
 * `pnpm --filter @facture/agent fund` — post the agent's own capital into `MandateVault`.
 *
 * The buyer side of the product, done by the buyer rather than by hand. The venue writes
 * the mandate and registers it on the vault; this puts the money behind it, out of the
 * Circle wallet this process holds, so that "the capital is escrowed, so the bid is firm"
 * is a statement about this agent rather than about a deposit somebody made for it.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * IT DOES NOTHING WITHOUT `--execute`
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * A run with no flags reads the venue and the vault, prints exactly the plan a live run
 * would carry out, and moves nothing. `--execute` is the only thing that authorises a
 * spend, and it has to be typed at the command line each time — there is no environment
 * variable that turns it on, deliberately.
 *
 * **`AGENT_DRY_RUN` does not govern this script.** It governs the trading loop in
 * `main.ts`, where the thing being guarded is arming trades on a timer. A funding run is a
 * deliberate act by an operator who is watching it, so it is guarded by the argument they
 * type rather than by a setting they left in a `.env` months ago.
 *
 * ```
 *   pnpm --filter @facture/agent fund                       # plan every mandate, spend nothing
 *   pnpm --filter @facture/agent fund -- --mandate <uuid>   # plan one
 *   pnpm --filter @facture/agent fund -- --execute          # actually deposit
 *   pnpm --filter @facture/agent fund -- --mandate <uuid> --amount 2.5 --execute
 *   pnpm --filter @facture/agent fund -- --idempotency-key <uuid> --execute   # resume, never repeat
 * ```
 */

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, type Address } from 'viem';
import { ARC_DEPLOYMENTS } from '@facture/shared';
import { loadEnv, secretsOf, type Env } from './env.js';
import { createLogger, registerSecret, scrub, type Logger } from './logger.js';
import { createVenueClient, type VenueClient } from './venue.js';
import {
  createArcVaultReader,
  executeDeposit,
  planDeposit,
  vaultMandateId,
  type DepositPlan,
  type DepositReceipt,
  type DepositRefusal,
  type VaultReader,
} from './vault.js';
import {
  createWalletClient,
  formatTokenAmount,
  USDC_DECIMALS,
  type WalletClient,
} from './wallet.js';
import type { TokenBlockchain } from '@circle-fin/developer-controlled-wallets';

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * Arguments
 * ───────────────────────────────────────────────────────────────────────────────────── */

export interface FundArgs {
  readonly execute: boolean;
  readonly mandateIds: readonly string[];
  /** Raw decimal USDC, exactly as typed. Parsed later, where the scale is documented. */
  readonly amount: string | null;
  readonly idempotencyKey: string | null;
}

/**
 * Parse `argv`. Exported for the test, because the one flag that matters is the one that
 * spends and a parser that defaulted it the wrong way would be a silent live run.
 */
export function parseArgs(argv: readonly string[]): FundArgs {
  const mandateIds: string[] = [];
  let execute = false;
  let amount: string | null = null;
  let idempotencyKey: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    switch (arg) {
      case '--execute':
        execute = true;
        break;
      case '--mandate': {
        const value = argv[++i];
        if (value === undefined) throw new Error('--mandate needs a mandate id');
        for (const id of value.split(',').map((p) => p.trim()))
          if (id.length > 0) mandateIds.push(id);
        break;
      }
      case '--amount': {
        const value = argv[++i];
        if (value === undefined) throw new Error('--amount needs a decimal USDC amount');
        amount = value;
        break;
      }
      case '--idempotency-key': {
        const value = argv[++i];
        if (value === undefined) throw new Error('--idempotency-key needs a value');
        idempotencyKey = value;
        break;
      }
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return { execute, mandateIds, amount, idempotencyKey };
}

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * One mandate's outcome, for the summary
 * ───────────────────────────────────────────────────────────────────────────────────── */

export type MandateOutcome =
  | { readonly kind: 'refused'; readonly mandateId: string; readonly refusal: DepositRefusal }
  | { readonly kind: 'planned'; readonly mandateId: string; readonly plan: DepositPlan }
  | { readonly kind: 'done'; readonly mandateId: string; readonly receipt: DepositReceipt };

/**
 * Whether an outcome needs an operator to do something. `ALREADY_BACKED` does not — it is
 * the answer a healthy desk gives — and a dry run's plan does not either.
 */
const needsAttention = (outcome: MandateOutcome): boolean =>
  outcome.kind === 'refused'
    ? outcome.refusal.code !== 'ALREADY_BACKED'
    : outcome.kind === 'done' && outcome.receipt.state !== 'deposited';

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * The run
 * ───────────────────────────────────────────────────────────────────────────────────── */

export interface FundDeps {
  readonly env: Env;
  readonly args: FundArgs;
  readonly venue: VenueClient;
  readonly reader: VaultReader;
  readonly wallet: WalletClient;
  readonly logger: Logger;
}

export async function fund(deps: FundDeps): Promise<readonly MandateOutcome[]> {
  const { env, args, venue, reader, wallet, logger } = deps;

  const walletSummary = await wallet.getWallet(env.AGENT_WALLET_ID);
  const walletAddress = getAddress(walletSummary.address);

  /*
   * The one thing `AGENT_WALLET_SET_ID` is for. A Circle wallet id is an opaque UUID, so a
   * wrong one is indistinguishable from a right one until money leaves it; the set is the
   * only cheap statement a deployment can make about which wallets are its own.
   */
  if (
    env.AGENT_WALLET_SET_ID !== undefined &&
    env.AGENT_WALLET_SET_ID !== walletSummary.walletSetId
  ) {
    throw new Error(
      `AGENT_WALLET_ID ${env.AGENT_WALLET_ID} belongs to wallet set ` +
        `${walletSummary.walletSetId}, not to AGENT_WALLET_SET_ID. Refusing to spend from a ` +
        'wallet this deployment does not claim.',
    );
  }

  const settlementToken = getAddress(await reader.settlementToken());

  const wanted = new Set([...(env.AGENT_MANDATE_IDS ?? []), ...args.mandateIds]);
  const all = await venue.mandates(env.AGENT_BUYER_ID);
  const targets = wanted.size === 0 ? all : all.filter((m) => wanted.has(m.terms.id));

  for (const id of wanted) {
    if (!all.some((m) => m.terms.id === id)) {
      throw new Error(`mandate ${id} is not one of buyer ${env.AGENT_BUYER_ID}'s mandates`);
    }
  }

  /*
   * `--amount` names one deposit, so it may only be given when one mandate is targeted.
   * Spread over several it would be either a per-mandate amount or a total, and there is no
   * reading of it that an operator could not reasonably have meant the other way.
   */
  if (args.amount !== null && targets.length !== 1) {
    throw new Error(
      `--amount applies to a single mandate; ${targets.length} are targeted. Add --mandate <uuid>.`,
    );
  }
  const override = args.amount === null ? undefined : parseUsdc(args.amount);

  const balance = await wallet.usdcBalance(env.AGENT_WALLET_ID);
  /*
   * `null` is Circle omitting a token the wallet has never held, which is not the same fact
   * as a balance of zero — but it is the same amount, and for the purpose of "can this
   * wallet pay" they are interchangeable. `planDeposit` refuses either way.
   */
  let budget = balance?.amount ?? 0n;

  logger.info('funding run', {
    buyerId: env.AGENT_BUYER_ID,
    walletId: env.AGENT_WALLET_ID,
    walletAddress,
    walletUsdcMinor: budget,
    vault: reader.vaultAddress,
    settlementToken,
    mandates: targets.length,
    execute: args.execute,
  });

  const outcomes: MandateOutcome[] = [];

  for (const mandate of targets) {
    const id = mandate.terms.id;
    const key = vaultMandateId(id);

    let registeredBuyer: Address;
    let deposited: bigint;
    let allowance: bigint;
    try {
      /*
       * Read before every write, and read all three: registration decides whether a deposit
       * is even legal, the balance decides how much is missing, and the allowance decides
       * whether the first of the two writes can be skipped.
       */
      registeredBuyer = getAddress(await reader.buyerOf(key));
      deposited = await reader.depositedFor(key);
      allowance = await reader.allowance(walletAddress, reader.vaultAddress);
    } catch (cause) {
      outcomes.push({
        kind: 'refused',
        mandateId: id,
        refusal: {
          code: 'VAULT_UNREADABLE',
          mandateId: id,
          detail:
            'Arc could not be read, so whether this mandate is registered and what it holds ' +
            `are both unknown: ${cause instanceof Error ? cause.message : String(cause)}`,
        },
      });
      continue;
    }

    const planned = planDeposit({
      mandateId: id,
      backing: mandate.vault,
      walletAddress,
      walletUsdcMinor: budget,
      registeredBuyer,
      depositedUsdcMinor: deposited,
      standingAllowanceUsdcMinor: allowance,
      settlementToken,
      usdcAddress: reader.usdcAddress,
      overrideAmountUsdcMinor: override,
    });

    if (!planned.ok) {
      logger.info('not depositing', { ...planned.error });
      outcomes.push({ kind: 'refused', mandateId: id, refusal: planned.error });
      continue;
    }

    const plan = planned.value;

    /*
     * The venue's `depositedUsdcMinor` and the chain's `balanceOf` answer the same question
     * and can disagree — the venue read it a moment earlier, on a different connection. The
     * chain's is what the plan used; the disagreement is only worth a line.
     */
    const venueSaw = mandate.vault?.depositedUsdcMinor ?? null;
    if (venueSaw !== null && venueSaw !== deposited) {
      logger.debug('venue and chain disagree on what the vault holds', {
        mandateId: id,
        venue: venueSaw,
        chain: deposited,
      });
    }

    if (!args.execute) {
      outcomes.push({ kind: 'planned', mandateId: id, plan });
      /*
       * The dry run debits its own budget too, so planning two deposits out of one wallet
       * reports the second one honestly instead of telling both that the same dollar is
       * free. Same reason `agent.ts` keeps a running budget inside a tick.
       */
      budget -= plan.amountUsdcMinor;
      continue;
    }

    const receipt = await executeDeposit(plan, {
      wallet,
      walletId: env.AGENT_WALLET_ID,
      reader,
      logger,
      /*
       * One key per mandate per run. An operator resuming an `unknown` outcome passes the
       * same `--idempotency-key`, and Circle replays the original request rather than
       * making a second deposit — which is the difference between recovering and paying
       * twice.
       */
      idempotencyKey: `${args.idempotencyKey ?? runKey}-${id}`,
    });

    logger.info('deposit finished', {
      mandateId: id,
      state: receipt.state,
      amountUsdcMinor: plan.amountUsdcMinor,
      depositedAfterUsdcMinor: receipt.depositedAfterUsdcMinor,
      transaction: receipt.deposit?.id ?? receipt.approve?.id ?? null,
      txHash: receipt.deposit?.txHash ?? null,
      explorerUrl: receipt.explorerUrl,
    });

    outcomes.push({ kind: 'done', mandateId: id, receipt });
    if (receipt.state !== 'failed') budget -= plan.amountUsdcMinor;
  }

  return outcomes;
}

/**
 * One idempotency key for the whole run, so a resumed run reuses one value rather than a
 * value per mandate an operator would have to collect from the log.
 */
const runKey = randomUUID();

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * Reporting
 * ───────────────────────────────────────────────────────────────────────────────────── */

const usdc = (minor: bigint): string => `${formatTokenAmount(minor, USDC_DECIMALS)} USDC`;

export function summarise(outcomes: readonly MandateOutcome[], args: FundArgs): string {
  const lines: string[] = [];
  for (const outcome of outcomes) {
    const id = outcome.mandateId.slice(0, 8);
    if (outcome.kind === 'refused') {
      lines.push(`  ${id}  ${outcome.refusal.code}\n           ${outcome.refusal.detail}`);
      continue;
    }
    if (outcome.kind === 'planned') {
      const p = outcome.plan;
      lines.push(
        `  ${id}  would deposit ${usdc(p.amountUsdcMinor)}  ` +
          `(vault holds ${usdc(p.depositedUsdcMinor)} of ${usdc(p.requiredUsdcMinor)} required)` +
          (p.approvalUsdcMinor === 0n ? '\n           a standing allowance already covers it' : ''),
      );
      continue;
    }
    lines.push(
      `  ${id}  ${outcome.receipt.state.toUpperCase()}\n           ${outcome.receipt.detail}`,
    );
    if (outcome.receipt.explorerUrl !== null) {
      lines.push(`           ${outcome.receipt.explorerUrl}`);
    }
  }

  const header = args.execute
    ? 'Funding run — capital was moved where a line says DEPOSITED.'
    : 'Dry run. Nothing was submitted. Add --execute to deposit.';

  return `\n${header}\n\n${lines.join('\n') || '  no mandates targeted'}\n`;
}

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * Entry point
 * ───────────────────────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // No .env here; the schema names anything genuinely missing.
  }

  // Same order as `main.ts`, and for the same reason: the redactor has to know the
  // credentials before anything that could throw while holding them.
  registerSecret(process.env['CIRCLE_API_KEY']);
  registerSecret(process.env['CIRCLE_ENTITY_SECRET']);
  registerSecret(process.env['AGENT_HEDERA_PRIVATE_KEY']);

  const env = loadEnv();
  for (const secret of secretsOf(env)) registerSecret(secret);

  const args = parseArgs(process.argv.slice(2));
  const logger = createLogger({
    level: env.LOG_LEVEL,
    bindings: { svc: 'facture-agent-fund', buyerId: env.AGENT_BUYER_ID },
  });

  const wallet = createWalletClient({
    apiKey: env.CIRCLE_API_KEY,
    entitySecret: env.CIRCLE_ENTITY_SECRET,
    baseUrl: env.CIRCLE_BASE_URL,
    blockchain: env.ARC_BLOCKCHAIN as TokenBlockchain,
    usdcAddress: env.ARC_USDC_ADDRESS,
    logger,
  });

  const outcomes = await fund({
    env,
    args,
    logger,
    wallet,
    venue: createVenueClient({
      baseUrl: env.FACTURE_API_URL,
      timeoutMs: env.FACTURE_API_TIMEOUT_MS,
      tradeTimeoutMs: env.FACTURE_API_TRADE_TIMEOUT_MS,
    }),
    reader: createArcVaultReader({
      vaultAddress: ARC_DEPLOYMENTS.mandateVault,
      rpcUrl: env.ARC_RPC_URL,
      usdcAddress: env.ARC_USDC_ADDRESS,
    }),
  });

  process.stdout.write(summarise(outcomes, args));
  if (outcomes.some(needsAttention)) process.exitCode = 1;
}

/**
 * `"2.5"` → `2_500_000n`. The only decimal an operator types on this path.
 *
 * Deliberately not a conversion between an invoice amount and USDC — that scale belongs to
 * the venue and is read off the wire. This is a USDC amount typed as USDC.
 */
function parseUsdc(input: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(input.trim());
  if (match === null) {
    throw new Error(`--amount must be a USDC amount with at most 6 decimal places, got ${input}`);
  }
  const [, whole = '0', fraction = ''] = match;
  return BigInt(whole + fraction.padEnd(USDC_DECIMALS, '0'));
}

/*
 * Run only when this file IS the process, never when a test imports `parseArgs` or `fund`
 * from it. Without the guard, importing this module to unit-test the argument parser boots a
 * real Circle client and reads the venue — and with `--execute` anywhere in the ambient
 * argv, spends. That is not hypothetical: the first draft here had no guard, and `vitest
 * run` executed `main` and failed on a missing vault address rather than on the test.
 */
const entry = process.argv[1];
if (entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry)) {
  main().catch((cause: unknown) => {
    const message = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
    process.stderr.write(`${scrub(message)}\n`);
    process.exitCode = 1;
  });
}
