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
 * 4. Build the venue client, the wallet client, the Hedera signer and the agent, and run.
 *
 * The process defaults to a **dry run**: it reads the book, prices it, reports what its
 * mandates would take, and arms nothing. Moving money requires `AGENT_DRY_RUN=false` in so
 * many words, because Circle will not stop a spend and neither will anything else once the
 * pre-flight in `mandate.ts` has passed.
 *
 * That warning is sharper than it was. With `AGENT_HEDERA_PRIVATE_KEY` set, a live run does
 * not merely arm trades — it signs and submits a transfer of the buyer's HBAR for every
 * trade the venue prices on the x402 rail. Nothing between here and consensus asks a second
 * time.
 */

import { createMarketMaker } from './agent.js';
import { createCashLegSigner } from './cash.js';
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
  /*
   * Registered from `process.env` rather than from the parsed environment, because the
   * schema itself can reject this value and the rejection is a thrown error. A key
   * registered only after `loadEnv` returns is a key that was unprotected during the one
   * call most likely to throw while holding it.
   */
  registerSecret(process.env['AGENT_HEDERA_PRIVATE_KEY']);

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
    tradeTimeoutMs: env.FACTURE_API_TRADE_TIMEOUT_MS,
  });

  /*
   * The buyer's Hedera key, or nothing.
   *
   * Built here rather than lazily inside the agent so a malformed key stops the process at
   * boot. The alternative is finding out at the moment a challenge arrives, which is after
   * the venue has held the seller's paper — the expensive time to learn that a key does not
   * parse. `env.ts` has already refused a half-configured pair, so one of these being set is
   * enough to know both are.
   */
  const cash =
    env.AGENT_HEDERA_ACCOUNT_ID === undefined || env.AGENT_HEDERA_PRIVATE_KEY === undefined
      ? null
      : createCashLegSigner({
          accountId: env.AGENT_HEDERA_ACCOUNT_ID,
          privateKey: env.AGENT_HEDERA_PRIVATE_KEY,
          network: env.AGENT_HEDERA_NETWORK,
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
    { venue, wallet, logger, cash },
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
     * Which rails this process can settle on, said at boot.
     *
     * Worth a line because the failure it prevents is silent: with no Hedera key the agent
     * refuses every unescrowed bid and looks like a desk that simply found nothing to buy.
     * Naming the rails means the difference between "no invoice matched" and "half the book
     * was unreachable" is visible before the first tick rather than inferred from refusals.
     */
    cashRails: cash === null ? ['arc-vault'] : ['arc-vault', 'x402-hedera'],
    x402Payer: cash?.payerAccountId ?? null,
    x402Network: cash?.network ?? null,
    /*
     * Said out loud on every boot, because the opposite is the natural assumption and the
     * assumption is expensive. Circle's developer-controlled wallets have no policy engine;
     * spending policies are a mainnet Agent Wallets feature and Arc is testnet-only.
     */
    /*
     * Honest about what this process does, and it now does more than it used to.
     *
     * The line here used to read "this process spends nothing directly", which was true
     * while the vault settled every trade and the Circle wallet was only ever read. It is
     * false on the x402 rail: the key in `cash.ts` signs a transfer of the buyer's own HBAR,
     * per trade. So the claim is narrowed to what still holds — the cap is the mandate's
     * committed capital, `decide` enforces it here, the venue enforces it again at arm time,
     * and Circle enforces nothing anywhere on this path.
     */
    capEnforcedBy:
      "the mandate's committed capital, enforced here and again by the venue — " +
      'Circle enforces no spending cap on developer-controlled wallets, and none of it ' +
      'applies to the Hedera key, which spends directly',
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
      x402PayerTinybars: report.x402.balanceTinybars,
      taken: report.taken.length,
      /** How many actually paid, which is a different number from how many were taken. */
      settled: report.taken.filter((t) => t.settlement !== null).length,
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
