/**
 * Entrypoint.
 *
 * Order matters: config is parsed before anything else so a misconfigured deploy dies at
 * startup naming the variable, rather than on the first request that needed it.
 */

import { serve } from '@hono/node-server';
import { ARC_DEPLOYMENTS, HEDERA_DEPLOYMENTS } from '@facture/shared';
import { createApp } from './app.js';
import { hedera } from './chain.js';
import type { Config } from './config.js';
import { EnvValidationError, loadConfig } from './config.js';
import { closeDb, getDb } from './db/index.js';
import { createSqliteStore } from './db/sqlite-store.js';
import { setStoreFactory } from './db/store.js';
import { createLogger, rootLogger, setRootLogger } from './logger.js';
import { initAtsAdapter } from './services/ats.js';
import {
  createAtsComplianceGate,
  createOnChainComplianceGate,
  setComplianceGate,
} from './services/compliance.js';
import { createMandateBook, setMandateBook } from './services/mandate-book.js';
import { initArcEscrow } from './services/arc.js';
import { initHcsPublisher } from './services/hcs.js';
import { initIndexer } from './services/indexer.js';
import { initInvoiceRegistry } from './services/invoice-registry.js';
import { initUniquenessRegistry } from './services/uniqueness.js';
import { initPrivyPolicyClient } from './services/privy-policy.js';
import { initPrivyVerifier } from './services/privy.js';
import {
  createStoreIssuanceSink,
  getIssuanceQueue,
  initIssuanceQueue,
  resumeIssuance,
} from './services/issuance.js';
import { createLoggingNotifier, setNotifier } from './services/notifier.js';
import { initScheduleAdapter } from './services/schedule.js';
import { DEFAULT_NETWORK, DEFAULT_SCHEME, initX402Client } from './services/x402.js';

function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof EnvValidationError) {
      // Deliberately not JSON: this is read by a human staring at a failed deploy.
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

function boot(): void {
  const { env, chain } = loadConfigOrExit();
  setRootLogger(createLogger(env.LOG_LEVEL, { svc: 'facture-backend', env: env.NODE_ENV }));
  const log = rootLogger;

  /*
   * Lazily: registering the factory does not open the database file. The first request that
   * needs it opens it, so a health check against a service whose database file is missing
   * or unreadable still answers with a body saying so rather than failing to start at all.
   */
  setStoreFactory(() => createSqliteStore(getDb()));
  setNotifier(createLoggingNotifier(log));
  /*
   * The eligibility decision is a contract call anyone can reproduce. `createAtsComplianceGate`
   * is still what supplies the sentence when the gate refuses — the on-chain gate holds one
   * internally for that — so the direct-facet reader has not lost a caller here, only the
   * branch that chose it instead. See `services/compliance.ts`.
   */
  setComplianceGate(
    createOnChainComplianceGate({
      gateAddress: HEDERA_DEPLOYMENTS.complianceGate,
      logger: log,
    }),
  );

  /*
   * The mandate book. Unset publishes nothing and asks nothing, which is a smaller venue rather
   * than a laxer one: the book decides no outcome here, it only answers beside the venue.
   */
  setMandateBook(
    createMandateBook({
      bookAddress: HEDERA_DEPLOYMENTS.mandateBook,
      operatorKey: env.HEDERA_OPERATOR_KEY,
      logger: log,
    }),
  );

  initAtsAdapter({
    operatorId: env.HEDERA_OPERATOR_ID,
    operatorKey: env.HEDERA_OPERATOR_KEY,
    // Unset disables issuance rather than simulating it — see `services/ats.ts`.
    factoryId: env.ATS_FACTORY_ID,
    gasLimit: env.ISSUANCE_GAS_LIMIT,
    network: hedera.network,
    logger: log,
  });

  initScheduleAdapter({
    operatorId: env.HEDERA_OPERATOR_ID,
    operatorKey: env.HEDERA_OPERATOR_KEY,
    network: hedera.network,
    // Unset disables the maturity payout rail rather than simulating one.
    collectionAccountId: env.MATURITY_COLLECTION_ACCOUNT_ID,
    assetMode: env.X402_ASSET_MODE,
    logger: log,
  });

  initPrivyVerifier({
    // Unset disables seller sign-in rather than trusting an email nobody verified.
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
    logger: log,
  });

  initPrivyPolicyClient({
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
    // Unset leaves a seller's wallet unscoped rather than attaching a weaker default.
    policyId: env.PRIVY_WALLET_POLICY_ID,
    authorizationPrivateKey: env.PRIVY_AUTHORIZATION_PRIVATE_KEY,
    logger: log,
  });

  initArcEscrow({
    vaultAddress: ARC_DEPLOYMENTS.mandateVault,
    settlementPrivateKey: env.ARC_SETTLEMENT_PRIVATE_KEY,
    maxFeePerGasGwei: env.ARC_MAX_FEE_PER_GAS_GWEI,
    // The same scale the Hedera cash leg settles at, so one receivable costs one amount.
    settlementScalePpm: env.X402_SETTLEMENT_SCALE_PPM,
    logger: log,
  });

  initHcsPublisher({
    // Unset records refusals without a consensus copy rather than faking one.
    topicId: env.HCS_REFUSAL_TOPIC_ID,
    operatorId: env.HEDERA_OPERATOR_ID,
    operatorKey: env.HEDERA_OPERATOR_KEY,
    network: hedera.network,
    logger: log,
  });

  initUniquenessRegistry({
    registryAddress: HEDERA_DEPLOYMENTS.uniquenessRegistry,
    operatorKey: env.HEDERA_OPERATOR_KEY,
    logger: log,
  });

  initInvoiceRegistry({
    registryAddress: HEDERA_DEPLOYMENTS.invoiceRegistry,
    operatorKey: env.HEDERA_OPERATOR_KEY,
    logger: log,
  });

  initIndexer(log);

  initIssuanceQueue({
    minIntervalMs: env.ISSUANCE_MIN_INTERVAL_MS,
    maxAttempts: env.ISSUANCE_MAX_ATTEMPTS,
    backoffBaseMs: env.ISSUANCE_BACKOFF_BASE_MS,
    logger: log,
    sink: createStoreIssuanceSink(),
  });

  initX402Client({
    facilitatorUrl: env.X402_FACILITATOR_URL,
    supportedTtlSeconds: env.X402_SUPPORTED_TTL_SECONDS,
    scheme: DEFAULT_SCHEME,
    network: DEFAULT_NETWORK,
    payTo: env.X402_PAY_TO,
    assetMode: env.X402_ASSET_MODE,
    htsAssetId: env.X402_HTS_ASSET_ID,
    assetDecimals: env.X402_ASSET_DECIMALS,
    settlementScalePpm: env.X402_SETTLEMENT_SCALE_PPM,
    logger: log,
  });

  /*
   * Work queued before the process last stopped.
   *
   * Deliberately after the server is configured and deliberately not awaited: resuming opens
   * the database, and a service that refused to start because the database was briefly
   * unreadable would fail exactly the health check that exists to say so. A failure here
   * leaves the jobs where they are, which is the state they were already in.
   */
  void resumeIssuance(log).catch((err: unknown) => {
    log.error('could not resume queued issuance', { err });
  });

  const server = serve({ fetch: createApp().fetch, port: env.PORT, hostname: env.HOST }, (info) => {
    log.info('listening', {
      port: info.port,
      arcChainId: chain.arc.chainId,
      hederaNetwork: chain.hedera.network,
      facilitator: env.X402_FACILITATOR_URL,
      settlementAsset: env.X402_ASSET_MODE,
    });
  });

  const shutdown = (signal: string): void => {
    log.info('shutting down', { signal });
    getIssuanceQueue().stop();
    server.close(() => {
      void closeDb().finally(() => process.exit(0));
    });
    // Do not let a hung socket hold the process open forever.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { err: reason });
  });
}

boot();
