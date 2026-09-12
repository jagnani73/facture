/**
 * Create the Privy wallet policy, once, and print its id.
 *
 *     pnpm --filter @facture/backend privy:policy
 *
 * The policy scopes a seller's embedded wallet to `DvpEscrow.claim` on Arc, and it exists
 * because "at least one Privy control" is a thing this venue should be able to say truthfully
 * — a wallet that may sign anything is not scoped by an email address.
 *
 * **Creation is deliberately not automatic.** Privy puts no uniqueness constraint on a policy
 * name, so a venue that created one on demand would mint a fresh policy on every restart and
 * then be unable to say which of them a given wallet carries. It is created here, by a person,
 * and its id is pinned in `PRIVY_WALLET_POLICY_ID`.
 *
 * Re-running is safe and is the point of the idempotency key: it is a digest of the policy
 * body, so a retry after a dropped connection returns the same id rather than a second policy,
 * and a genuinely changed rule is a different key and therefore a new policy. Verified against
 * the live API — three runs, one policy.
 *
 * It reads the escrow address off the deployed vault rather than taking it as an argument. The
 * address the policy names has to be the address the venue actually settles into, and a second
 * literal here is how those two come to disagree.
 */

import { ARC_DEPLOYMENTS } from '@facture/shared';
import { loadConfig } from './config.js';
import { EnvValidationError } from './env.js';
import { createLogger, setRootLogger } from './logger.js';
import { initArcEscrow } from './services/arc.js';
import { initPrivyPolicyClient, provisionClaimPolicy } from './services/privy-policy.js';

async function main(): Promise<void> {
  let env;
  try {
    ({ env } = loadConfig());
  } catch (err) {
    if (err instanceof EnvValidationError) {
      // Deliberately not JSON: a human is staring at a failed provisioning run.
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  setRootLogger(createLogger(env.LOG_LEVEL, { svc: 'privy-policy' }));

  if (env.PRIVY_APP_ID === undefined || env.PRIVY_APP_SECRET === undefined) {
    process.stderr.write(
      'PRIVY_APP_ID and PRIVY_APP_SECRET must both be set to create a policy. Unset, seller ' +
        'sign-in is disabled and there is no wallet to scope.\n',
    );
    process.exitCode = 1;
    return;
  }

  initPrivyPolicyClient({
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
    policyId: env.PRIVY_WALLET_POLICY_ID,
    authorizationPrivateKey: env.PRIVY_AUTHORIZATION_PRIVATE_KEY,
  });

  initArcEscrow({
    vaultAddress: ARC_DEPLOYMENTS.mandateVault,
    settlementPrivateKey: env.ARC_SETTLEMENT_PRIVATE_KEY,
    maxFeePerGasGwei: env.ARC_MAX_FEE_PER_GAS_GWEI,
    settlementScalePpm: env.X402_SETTLEMENT_SCALE_PPM,
  });

  const { policyId, body } = await provisionClaimPolicy();
  const escrow = body.rules[0]?.conditions.find((c) => c.field === 'to')?.value;

  process.stdout.write(
    `\npolicy   ${policyId}\n` +
      `name     ${body.name}\n` +
      `escrow   ${String(escrow)}\n` +
      `chain    ${String(body.rules[0]?.conditions.find((c) => c.field === 'chain_id')?.value)}\n` +
      `\nPin it:  PRIVY_WALLET_POLICY_ID=${policyId}\n` +
      'Until that is set and the service restarted, a seller’s wallet stays unscoped.\n',
  );
}

await main();
