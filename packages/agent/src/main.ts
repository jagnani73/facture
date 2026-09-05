/**
 * Entry point for one market-maker agent.
 *
 * Boots in a deliberate order, and the order is the point:
 *
 * 1. Load `.env`.
 * 2. **Register the credentials with the logger's redactor** — before the schema is parsed,
 *    before the Circle client is built, before anything can throw. An error raised while
 *    constructing the API client can carry the key inside an axios config dump, and the
 *    redactor has to already know what to look for by then.
 * 3. Parse and validate the environment.
 * 4. Build the venue client, the wallet client and the agent, and run.
 *
 * The process defaults to a **dry run**: it reads the book, prices it, reports what its
 * mandates would take, and arms nothing. Moving money requires `AGENT_DRY_RUN=false` in so
 * many words, because Circle will not stop a spend and neither will anything else once the
 * pre-flight in `mandate.ts` has passed.
 */

import { createMarketMaker } from './agent.js';
import { loadEnv, secretsOf } from './env.js';
import { createLogger, registerSecret, scrub } from './logger.js';
import { createVenueClient } from './venue.js';
import { createWalletClient } from './wallet.js';
import type { TokenBlockchain } from '@circle-fin/developer-controlled-wallets';

async function main(): Promise<void> {
  loadDotEnv();

  // Step 2, and it must stay here. See the file header.
  registerSecret(process.env['CIRCLE_API_KEY']);
  registerSecret(process.env['CIRCLE_ENTITY_SECRET']);

  const env = loadEnv();
  for (const secret of secretsOf(env)) registerSecret(secret);

  const logger = createLogger({
    level: env.LOG_LEVEL,
    bindings: { svc: 'facture-agent', buyerId: env.AGENT_BUYER_ID },
  });

  const wallet = createWalletClient({
    apiKey: env.CIRCLE_API_KEY,
    entitySecret: env.CIRCLE_ENTITY_SECRET,
    baseUrl: env.CIRCLE_BASE_URL,
    blockchain: env.ARC_BLOCKCHAIN as TokenBlockchain,
    usdcAddress: env.ARC_USDC_ADDRESS,
    logger,
  });

  const venue = createVenueClient({
    baseUrl: env.FACTURE_API_URL,
    timeoutMs: env.FACTURE_API_TIMEOUT_MS,
  });

  const agent = createMarketMaker(
    {
      buyerId: env.AGENT_BUYER_ID,
      sellerIds: env.AGENT_SELLER_IDS,
      walletId: env.AGENT_WALLET_ID,
      mandateIds: env.AGENT_MANDATE_IDS,
      maxSlippageBps: env.AGENT_MAX_SLIPPAGE_BPS,
      dryRun: env.AGENT_DRY_RUN,
    },
    { venue, wallet, logger },
  );

  logger.info('market maker starting', {
    venue: env.FACTURE_API_URL,
    blockchain: env.ARC_BLOCKCHAIN,
    walletId: env.AGENT_WALLET_ID,
    sellers: env.AGENT_SELLER_IDS.length,
    mandates: env.AGENT_MANDATE_IDS?.length ?? 'all active',
    dryRun: env.AGENT_DRY_RUN,
    pollIntervalMs: env.AGENT_POLL_INTERVAL_MS,
    /*
     * Said out loud on every boot, because the opposite is the natural assumption and the
     * assumption is expensive. Circle's developer-controlled wallets have no policy engine;
     * spending policies are a mainnet Agent Wallets feature and Arc is testnet-only.
     */
    /*
     * Honest about what this process does and does not do. It arms trades; it moves no money
     * — the vault settles the cash leg and the agent's wallet is read, never spent. So the
     * cap that binds is the mandate's own committed capital, which `decide` enforces here and
     * the venue enforces again at arm time. Circle still enforces nothing, which is why the
     * clause survives.
     */
    capEnforcedBy:
      "the mandate's committed capital, enforced here and again by the venue — " +
      'Circle enforces no spending cap, and this process spends nothing directly',
  });

  const stop = (signal: string): void => {
    logger.info('shutting down', { signal });
    agent.stop();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  if (env.AGENT_ONCE) {
    const report = await agent.tick();
    logger.info('single tick complete', {
      walletUsdc: report.walletUsdc,
      spendableMinor: report.spendableMinor,
      taken: report.taken.length,
      refused: report.refused.length,
      committedThisTick: report.committedThisTick,
      errors: report.errors,
    });
    return;
  }

  await agent.run(env.AGENT_POLL_INTERVAL_MS);
}

/**
 * Load `packages/agent/.env` if it is there.
 *
 * `process.loadEnvFile` rather than a dotenv dependency: it is built into Node 20.12+ and
 * this package already requires Node 22. A missing file is not an error — in a container
 * the environment arrives from the orchestrator, and `loadEnv` will name whatever is
 * actually missing.
 */
function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env here. Anything genuinely required is reported by the schema, by name.
  }
}

main().catch((cause: unknown) => {
  /*
   * The last line this process may write, and the one most likely to carry a credential —
   * an axios error from a rejected Circle call serialises its own request configuration.
   * Scrubbed before it goes anywhere.
   */
  const message = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
  process.stderr.write(`${scrub(message)}\n`);
  process.exitCode = 1;
});
