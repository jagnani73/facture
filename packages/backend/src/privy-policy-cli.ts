/**
 * Create the Privy wallet policy, or bring an already-pinned one up to date.
 *
 *     pnpm --filter @facture/backend privy:policy            # create, and print the id to pin
 *     pnpm --filter @facture/backend privy:policy sync       # rewrite the pinned policy
 *
 * The policy scopes a seller's embedded wallet to two named things — `DvpEscrow.claim` on Arc,
 * and an EIP-712 `ProfileUpdate` for `PartyRegistry` on Hedera — and it exists because "at
 * least one Privy control" is a thing this venue should be able to say truthfully; a wallet
 * that may sign anything is not scoped by an email address.
 *
 * **Creation is deliberately not automatic.** Privy puts no uniqueness constraint on a policy
 * name, so a venue that created one on demand would mint a fresh policy on every restart and
 * then be unable to say which of them a given wallet carries. It is created here, by a person,
 * and its id is pinned in `PRIVY_WALLET_POLICY_ID`.
 *
 * Re-running `create` is safe and is the point of the idempotency key: it is a digest of the
 * policy body, so a retry after a dropped connection returns the same id rather than a second
 * policy, and a genuinely changed rule is a different key and therefore a new policy. Verified
 * against the live API — three runs, one policy.
 *
 * **`sync` is what that last clause makes necessary.** A changed rule under `create` is a new
 * policy with a new id, and every wallet already provisioned keeps carrying the old one — so
 * on a deployment whose id is already pinned, creating is the wrong move and rewriting is the
 * right one. Privy supports one policy per wallet, so there is no additive third option. See
 * `syncWalletPolicy` for the whole argument.
 *
 * Both read the escrow address off the deployed vault rather than taking it as an argument.
 * The address the policy names has to be the address the venue actually settles into, and a
 * second literal here is how those two come to disagree. The party registry comes from the
 * pin in `@facture/shared`, for the same reason.
 */

import { ARC_DEPLOYMENTS } from '@facture/shared';
import { loadConfig } from './config.js';
import { EnvValidationError } from './env.js';
import { createLogger, setRootLogger } from './logger.js';
import { initArcEscrow } from './services/arc.js';
import {
  initPrivyPolicyClient,
  provisionWalletPolicy,
  syncWalletPolicy,
  type PolicyBody,
} from './services/privy-policy.js';

const COMMANDS = ['create', 'sync'] as const;
type Command = (typeof COMMANDS)[number];

const isCommand = (value: string): value is Command =>
  (COMMANDS as readonly string[]).includes(value);

/** What a rule's condition says, or `—`. Absent and empty are the same thing to a reader here. */
const conditionOf = (body: PolicyBody, method: string, field: string): string =>
  String(
    body.rules.find((r) => r.method === method)?.conditions.find((c) => c.field === field)?.value ??
      '—',
  );

/**
 * The body, as the operator needs to check it.
 *
 * Every rule, not just the first. A policy that is denying something is denying it because a
 * rule is missing, and a printout that only showed the rule you already knew about is exactly
 * how that goes unnoticed.
 */
function describe(policyId: string, body: PolicyBody): string {
  return (
    `\npolicy   ${policyId}\n` +
    `name     ${body.name}\n` +
    `rules    ${body.rules.map((r) => r.method).join(', ')}\n` +
    `escrow   ${conditionOf(body, 'eth_sendTransaction', 'to')}\n` +
    `chain    ${conditionOf(body, 'eth_sendTransaction', 'chain_id')}\n` +
    `registry ${conditionOf(body, 'eth_signTypedData_v4', 'verifyingContract')}\n` +
    `chain    ${conditionOf(body, 'eth_signTypedData_v4', 'chainId')}\n`
  );
}

async function main(): Promise<void> {
  const requested = process.argv[2] ?? 'create';
  if (!isCommand(requested)) {
    process.stderr.write(
      `Unknown command "${requested}". Expected one of: ${COMMANDS.join(', ')}.\n`,
    );
    process.exitCode = 1;
    return;
  }

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

  /*
   * Refused here as well as in the client, because the client's message is the right one for a
   * caller and this one is the right one for a person at a terminal: it names the command they
   * should have run instead.
   */
  if (requested === 'sync' && env.PRIVY_WALLET_POLICY_ID === undefined) {
    process.stderr.write(
      'PRIVY_WALLET_POLICY_ID is not set, so there is no pinned policy to bring up to date. ' +
        'Run `privy:policy` with no argument to create one, then pin the id it prints.\n',
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

  if (requested === 'sync') {
    const { policyId, body } = await syncWalletPolicy();
    process.stdout.write(
      `${describe(policyId, body)}` +
        '\nRewritten in place, so the id does not change and every wallet already carrying it\n' +
        'is under the rules above from the next request. Nothing to re-attach, nothing to pin.\n',
    );
    return;
  }

  const { policyId, body } = await provisionWalletPolicy();
  process.stdout.write(
    `${describe(policyId, body)}` +
      `\nPin it:  PRIVY_WALLET_POLICY_ID=${policyId}\n` +
      'Until that is set and the service restarted, a seller’s wallet stays unscoped.\n',
  );
}

await main();
