/**
 * The one Privy control this venue actually needs: the seller's wallet may claim, and
 * nothing else.
 *
 * `services/privy.ts` turns an identity token into a verified seller, and that is
 * onboarding — it proves who signed in and records where they expect to be paid. It is not
 * a *control*: an email and an address constrain nothing about what the key can later be
 * asked to sign. This module is the constraint.
 *
 * ## What the seller's key is for, and why that is a small enough surface to name
 *
 * A seller signs nothing to sell. The venue holds the paper, places the hold, and settles
 * both legs — CLAUDE.md draws that boundary and it has not moved. The single exception is
 * collection: an Arc-rail sale opens a `DvpEscrow` lock, and `claim` checks
 * `msg.sender == beneficiary`, so the venue cannot collect for a seller even while holding
 * the public preimage. The key Privy made at sign-in is the only one that can.
 *
 * So the whole legitimate surface of that key is **one function, on one contract, on one
 * chain**. A policy that says exactly that is not a decoration bolted on for a prize
 * requirement; it is the honest description of a wallet that does one thing. The web app
 * confirms the shape from the other end: `privy-provider.tsx` declares Arc and only Arc,
 * and `claim-payout.tsx` is the only place any Privy signer is invoked at all.
 *
 * ## Deny is the default, which is the reason to be careful rather than to be broad
 *
 * Privy evaluates rules and denies anything no rule allowed. That cuts the right way here —
 * an over-narrow rule cannot silently widen the key — but it cuts hard: a condition whose
 * encoding does not match what Privy decodes evaluates false, no rule allows the request,
 * and **the seller cannot collect their money**. A policy that matches nothing is worse
 * than no policy, which is why every condition below is one this repo can point at a
 * decoded field for, and why nothing here degrades quietly when the API refuses a
 * condition. A refused create is loud, at provisioning time, in the operator's hands.
 *
 * ## Why REST rather than `walletApi.createPolicy`
 *
 * `@privy-io/server-auth@1.32.5` ships `walletApi.createPolicy`, and it is tempting because
 * it is already a dependency. It is not used, for two reasons that are the same reason:
 *
 *  1. **Its types are behind the API.** The zod schema shipped in `@privy-io/public-api`
 *     types an `ethereum_transaction` condition's `field` as `'to' | 'value'` — there is no
 *     `chain_id` in it. Privy's current documentation lists `chain_id` on that same field
 *     source and gives a worked example (`value: '8453'` for Base). The package is a stale
 *     copy of a contract the live API has since widened, and going through it would make a
 *     documented condition a compile error.
 *  2. **It cannot send an idempotency key.** Policy creation has no uniqueness constraint on
 *     `name`, so two creates make two policies; `privy-idempotency-key` is the documented
 *     way to make a retry safe, and the SDK surface does not expose the header.
 *
 * Both point at the same conclusion: talk to the documented endpoint. It costs no new
 * dependency — this is `fetch` — and it removes a deprecated SDK surface from the path.
 *
 * ## The contradiction that is left, stated rather than resolved
 *
 * {@link CLAIM_POLICY_CHAIN_SCOPED} exists because the two sources above disagree and this
 * module cannot settle it without spending a real API call. The documentation says
 * `chain_id` is a condition field; the shipped validator says it is not. If the live API
 * still validates against the older schema, {@link createClaimPolicy} fails with Privy's own
 * 400 and the operator sees it. That is the outcome to want. The alternative — retrying
 * without the chain condition — would quietly publish a policy broader than the one this
 * file describes, and a control nobody can trust the scope of is not a control.
 */

import { createHash } from 'node:crypto';
import { arc } from '../chain.js';
import { badRequest } from '../errors.js';
import type { Logger } from '../logger.js';
import { rootLogger } from '../logger.js';
import { getArcEscrow } from './arc.js';

/** Privy's wallet API. The auth API (`auth.privy.io`) is a different host and not this one. */
const PRIVY_API_BASE = 'https://api.privy.io';

/**
 * `DvpEscrow.claim`, as much of it as Privy needs to decode a call.
 *
 * An `ethereum_calldata` condition must carry the contract's ABI — Privy's docs say so even
 * for a function with no arguments — because the policy engine decodes the calldata itself
 * rather than trusting a selector the caller supplies. It is deliberately only this one
 * function: the ABI here is what the policy is allowed to recognise, so adding entries to it
 * is widening the control, not documenting the contract.
 */
export const CLAIM_ABI = [
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'lockId', type: 'bytes32' },
      { name: 'secret', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

/** `claim(bytes32,bytes32)`. Not sent to Privy — kept so a test can pin what the ABI decodes to. */
export const CLAIM_SELECTOR = '0x84cc9dfb';

/**
 * Whether the rule carries a `chain_id` condition. See the module note.
 *
 * Left as a named constant rather than an environment variable on purpose: it is not a
 * per-deployment choice, it is a fact about which of two Privy contracts is live, and the
 * moment it becomes a knob some deployment ships the wider policy without meaning to.
 */
export const CLAIM_POLICY_CHAIN_SCOPED = true;

/** Privy caps a policy name at 50 characters. */
export const CLAIM_POLICY_NAME = 'Facture seller payout claim';

export interface PolicyCondition {
  field_source: 'ethereum_transaction' | 'ethereum_calldata';
  field: string;
  operator: 'eq' | 'in';
  value: string | string[];
  abi?: unknown;
}

export interface PolicyRule {
  name: string;
  method: 'eth_sendTransaction';
  action: 'ALLOW' | 'DENY';
  conditions: PolicyCondition[];
}

export interface PolicyBody {
  name: string;
  version: '1.0';
  chain_type: 'ethereum';
  rules: PolicyRule[];
}

/**
 * The policy, as a value, so a test can read it without a network.
 *
 * The escrow address is a parameter rather than a literal because there is exactly one
 * authority on where a payout lands and it is the vault's own `paymentEscrow()` immutable —
 * `services/arc.ts` reads it and explains at length why a second copy in configuration could
 * only ever disagree. {@link provisionClaimPolicy} is what joins the two; nothing in this
 * module invents an address.
 *
 * Three conditions, and each is one Privy decodes from the request rather than one this
 * venue asserts:
 *
 *  - `to` — the escrow, lowercased. Privy compares the value as a string, and the wallet
 *    sends whatever viem encoded, so a checksummed literal here would be a rule that matches
 *    nothing on a case-sensitive comparison. Lowercase is the form Privy's own examples use.
 *  - `chain_id` — Arc testnet, taken from the shared chain table. Arc is not a chain Privy
 *    lists, and it does not need to be: the condition value is free-form and is compared
 *    against the chain id decoded out of the transaction.
 *  - `function_name` — `claim`, decoded against {@link CLAIM_ABI}.
 *
 * Deliberately **not** a fourth condition on `value`. `claim` is `nonpayable` so a non-zero
 * value reverts on chain anyway, and Arc's native gas token is USDC — meaning a `value`
 * condition would be the one rule here whose encoding this repo cannot check against a
 * decoded field it has seen. A condition that might be compared as `'0'` against `'0x0'` is
 * a coin flip on whether the seller can be paid, bought for a guarantee the contract
 * already makes.
 */
export function claimPolicySpec(escrowAddress: string): PolicyBody {
  const conditions: PolicyCondition[] = [
    {
      field_source: 'ethereum_transaction',
      field: 'to',
      operator: 'eq',
      value: escrowAddress.toLowerCase(),
    },
  ];

  if (CLAIM_POLICY_CHAIN_SCOPED) {
    conditions.push({
      field_source: 'ethereum_transaction',
      field: 'chain_id',
      operator: 'eq',
      // Decimal, as a string. `eip155:` is the CAIP-2 form and belongs to a different field.
      value: String(arc.chainId),
    });
  }

  conditions.push({
    field_source: 'ethereum_calldata',
    field: 'function_name',
    operator: 'eq',
    value: 'claim',
    abi: CLAIM_ABI,
  });

  return {
    name: CLAIM_POLICY_NAME,
    version: '1.0',
    chain_type: 'ethereum',
    rules: [
      {
        name: 'Claim a DvpEscrow payout lock',
        method: 'eth_sendTransaction',
        action: 'ALLOW',
        conditions,
      },
    ],
  };
}

/**
 * What became of an attempt to put the control on a wallet.
 *
 * `attached: false` carries a reason because the ways this fails are not one fact. A wallet
 * whose id the identity token did not carry, a Privy account whose plan has no policy
 * engine, and a policy the API accepted but did not apply are three different problems with
 * three different fixes, and collapsing them into a boolean is how an operator ends up
 * checking the wrong one.
 */
export type PolicyAttachment =
  | { attached: true; policyId: string; walletId: string; alreadyHeld: boolean }
  | { attached: false; reason: string };

export interface PrivyPolicyClient {
  /** False when the control is not configured. Callers must not read that as "attached". */
  readonly enabled: boolean;
  /** The policy every seller's wallet is scoped by, or null when disabled. */
  readonly policyId: string | null;
  /** Creates the policy. An operator action — see {@link provisionClaimPolicy}. */
  createClaimPolicy(escrowAddress: string): Promise<{ policyId: string; body: PolicyBody }>;
  /** Puts {@link policyId} on a wallet, reading first so a returning seller writes nothing. */
  attach(input: {
    walletId: string | null;
    walletAddress: string | null;
  }): Promise<PolicyAttachment>;
}

export interface PrivyPolicyConfig {
  readonly appId: string | undefined;
  readonly appSecret: string | undefined;
  /** Unset disables the control. Nothing here creates a policy on the fly — see below. */
  readonly policyId: string | undefined;
  /**
   * Only needed where the app has an authorization keypair registered in the Privy
   * dashboard, in which case a write to a wallet is refused without a signature over it.
   * Unset simply sends no signature, which is correct for an app that has no such key.
   */
  readonly authorizationPrivateKey?: string | undefined;
  readonly logger?: Logger | undefined;
  /** Test seam. The real client uses the global `fetch`. */
  readonly fetch?: typeof fetch | undefined;
}

/** The sentence every disabled path gives, so "off" reads the same wherever it is reported. */
export const POLICY_NOT_CONFIGURED =
  'PRIVY_WALLET_POLICY_ID is not set, so no policy is applied to seller wallets.';

/**
 * No Privy credentials at all.
 *
 * Refuses naming the variables, in the same shape as issuance with no ATS factory. It does
 * **not** fall back to attaching some default policy, and it does not report success: the
 * whole value of a control is that a reader can tell whether it is on, and a disabled client
 * that answered `attached: true` would be the `escrowVerified` defect again — a fact
 * published and then contradicted by what the code actually did.
 */
export function createDisabledPrivyPolicyClient(): PrivyPolicyClient {
  return {
    enabled: false,
    policyId: null,
    createClaimPolicy: () =>
      Promise.reject(
        badRequest(
          'Creating the claim policy needs Privy credentials. PRIVY_APP_ID and ' +
            'PRIVY_APP_SECRET are not set, so wallet policies are disabled on this deployment.',
        ),
      ),
    attach: () => Promise.resolve({ attached: false, reason: POLICY_NOT_CONFIGURED }),
  };
}

/**
 * Credentials and a policy id are two separate configurations, and the split is the
 * bootstrap.
 *
 * The policy has to exist before its id can be pinned, so a client that refused to do
 * anything without an id could never create the one it needs — the venue would be asking
 * the operator to produce a Privy policy by hand from a JSON body kept in this file, which
 * is exactly the second source of truth {@link claimPolicySpec} exists to avoid. So
 * `createClaimPolicy` needs credentials, `attach` needs credentials **and** an id, and
 * `enabled` describes the second: it is the answer to "is a seller's wallet scoped", not to
 * "can this process reach Privy".
 *
 * The dangerous half of the pair is an id with no credentials. It reads, in a `.env`,
 * exactly like a deployment with the control switched on, and it can never attach anything —
 * so `env.ts` refuses that pairing at boot by name rather than letting it boot quiet.
 */
export function createPrivyPolicyClient(config: PrivyPolicyConfig): PrivyPolicyClient {
  const { appId, appSecret, policyId = null } = config;

  if (appId === undefined || appSecret === undefined) {
    return createDisabledPrivyPolicyClient();
  }

  const log = (config.logger ?? rootLogger).child({ svc: 'privy-policy' });
  const doFetch = config.fetch ?? globalThis.fetch;
  const auth = `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`;

  const request = async (
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> => {
    const url = `${PRIVY_API_BASE}${path}`;
    const headers: Record<string, string> = {
      authorization: auth,
      'privy-app-id': appId,
      'content-type': 'application/json',
    };
    if (idempotencyKey !== undefined) headers['privy-idempotency-key'] = idempotencyKey;
    if (config.authorizationPrivateKey !== undefined && method !== 'GET') {
      const signature = await authorizationSignature({
        method,
        url,
        body,
        appId,
        authorizationPrivateKey: config.authorizationPrivateKey,
      });
      if (signature !== undefined) headers['privy-authorization-signature'] = signature;
    }

    const res = await doFetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });

    const text = await res.text();
    if (!res.ok) {
      /*
       * Privy's own words, not a summary of them. The two failures worth telling apart here
       * — a plan without the policy engine, and a condition the live schema does not know —
       * are both distinguishable only from the message the API sent back.
       */
      throw new Error(`Privy ${method} ${path} answered ${res.status}: ${text.slice(0, 500)}`);
    }
    return text === '' ? {} : (JSON.parse(text) as unknown);
  };

  const walletIdForAddress = async (address: string): Promise<string | null> => {
    const found = await request('POST', '/v1/wallets/address', { address });
    const id = (found as { id?: unknown }).id;
    return typeof id === 'string' && id !== '' ? id : null;
  };

  const policyIdsOf = (wallet: unknown): string[] => {
    const ids = (wallet as { policy_ids?: unknown }).policy_ids;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  };

  return {
    enabled: policyId !== null,
    policyId,

    async createClaimPolicy(escrowAddress) {
      const body = claimPolicySpec(escrowAddress);
      /*
       * A stable key, so a retry inside Privy's 24-hour window returns the policy the first
       * attempt made rather than minting a second one. It is derived from the body, so a
       * changed rule is deliberately a different key: two policies that differ must not
       * collapse into whichever was created first.
       */
      const created = await request('POST', '/v1/policies', body, idempotencyKeyFor(body));
      const id = (created as { id?: unknown }).id;
      if (typeof id !== 'string' || id === '') {
        throw new Error('Privy accepted the policy but returned no id.');
      }
      log.info('claim policy created', { policyId: id, escrowAddress });
      return { policyId: id, body };
    },

    async attach({ walletId, walletAddress }) {
      // Credentials without an id is the provisioning state, not an attachable one.
      if (policyId === null) return { attached: false, reason: POLICY_NOT_CONFIGURED };

      /*
       * The identity token carries a wallet id only for a delegated wallet or one on the
       * unified wallets stack — Privy's own type says so — so an ordinary embedded wallet
       * arrives here with an address and nothing else. Resolving it is a documented endpoint
       * and one extra call on a route that runs once per sign-in.
       */
      const id =
        walletId ?? (walletAddress === null ? null : await walletIdForAddress(walletAddress));
      if (id === null) {
        return {
          attached: false,
          reason:
            'The sign-in carried no Privy wallet id and no address to resolve one from, and a ' +
            'policy is attached to a wallet id rather than an address.',
        };
      }

      /*
       * Ask before writing. A returning seller is the common case, and a PATCH per sign-in
       * would be a write whose only effect is to re-state what the wallet already carries —
       * with a real chance of clobbering another policy someone attached in the dashboard,
       * since `policy_ids` replaces rather than appends.
       */
      const existing = await request('GET', `/v1/wallets/${id}`);
      const held = policyIdsOf(existing);
      if (held.includes(policyId)) {
        return { attached: true, policyId, walletId: id, alreadyHeld: true };
      }

      const updated = await request('PATCH', `/v1/wallets/${id}`, {
        policy_ids: [...held, policyId],
      });

      /*
       * A write is not a receipt. The PATCH returning 200 says Privy accepted the request;
       * whether the wallet now carries the policy is a separate claim, and it is one the
       * response actually answers, so there is no reason to infer it. This repo has shipped
       * "the call succeeded and the transaction failed" twice on chain; the same distinction
       * applies to an API that echoes state back.
       */
      if (!policyIdsOf(updated).includes(policyId)) {
        return {
          attached: false,
          reason: `Privy accepted the update but the wallet does not carry policy ${policyId}.`,
        };
      }

      return { attached: true, policyId, walletId: id, alreadyHeld: false };
    },
  };
}

/**
 * A deterministic idempotency key for a policy body.
 *
 * Not a random UUID, which is what the docs suggest and what would make a retry after a
 * dropped connection create a second identical policy. Hashing the body means "the same
 * policy" and "the same key" are the same statement.
 */
function idempotencyKeyFor(body: PolicyBody): string {
  const digest = createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
  return `facture-policy-${digest.slice(0, 32)}`;
}

/**
 * The `privy-authorization-signature` header, when the app has an authorization keypair.
 *
 * Imported lazily and from `@privy-io/server-auth/wallet-api` rather than the package root,
 * which is where this helper is exported. It is the one thing the SDK does that this module
 * cannot reasonably do itself — a P-256 signature over Privy's own canonical serialisation
 * of the request — so it is worth the import even though everything else here is `fetch`.
 */
async function authorizationSignature(input: {
  method: 'POST' | 'PATCH';
  url: string;
  body: unknown;
  appId: string;
  authorizationPrivateKey: string;
}): Promise<string | undefined> {
  const { generateAuthorizationSignature } = await import('@privy-io/server-auth/wallet-api');
  return generateAuthorizationSignature({
    input: {
      version: 1,
      method: input.method,
      url: input.url,
      body: input.body,
      headers: { 'privy-app-id': input.appId },
    },
    authorizationPrivateKey: input.authorizationPrivateKey,
  });
}

let client: PrivyPolicyClient | undefined;

export function initPrivyPolicyClient(config: PrivyPolicyConfig): PrivyPolicyClient {
  client = createPrivyPolicyClient(config);
  return client;
}

/** Test seam, matching the other services. `undefined` clears it. */
export function setPrivyPolicyClient(next: PrivyPolicyClient | undefined): void {
  client = next;
}

export function getPrivyPolicyClient(): PrivyPolicyClient {
  if (!client) throw new Error('Privy policy client accessed before initPrivyPolicyClient().');
  return client;
}

/**
 * Attach the control, and never let it cost a sign-in.
 *
 * The same rule `publishRefusals` follows, for the same reason. A seller signing in is the
 * venue's own onboarding path, and Privy's policy API being unavailable — or the account's
 * plan not carrying the policy engine at all — is a reason for the wallet to be unscoped,
 * not a reason for the business to be unable to open a book. Throwing here would turn a side
 * service into a failed sign-up.
 *
 * The result is logged and deliberately **not** put on the wire. A field the API publishes
 * and the screen discards is how `escrowVerified` came to tell every buyer the capital was
 * escrowed when nothing had checked; an unread field is a claim waiting to be made falsely.
 * When a screen needs this, the screen is what should ask for it.
 */
export async function attachClaimPolicy(
  input: { walletId: string | null; walletAddress: string | null },
  logger: Logger = rootLogger,
): Promise<PolicyAttachment> {
  const policies = getPrivyPolicyClient();
  const log = logger.child({ svc: 'privy-policy' });

  if (!policies.enabled) return { attached: false, reason: POLICY_NOT_CONFIGURED };

  try {
    const result = await policies.attach(input);
    if (result.attached) {
      log.info('seller wallet scoped to the claim policy', {
        walletId: result.walletId,
        policyId: result.policyId,
        alreadyHeld: result.alreadyHeld,
      });
    } else {
      log.warn('seller wallet not scoped', { reason: result.reason });
    }
    return result;
  } catch (err) {
    // Deliberately not rethrown. See the note above.
    log.warn('seller wallet not scoped', { err });
    return { attached: false, reason: messageOf(err) };
  }
}

/**
 * Create the policy, against the escrow the vault itself names.
 *
 * An operator action rather than something a sign-in triggers, and that is the whole of the
 * idempotency story: policy names carry no uniqueness constraint at Privy, so a venue that
 * created its policy on demand would mint a fresh one on every restart and have no way to
 * tell which of them a wallet was carrying. One policy, created once, pinned in
 * `PRIVY_WALLET_POLICY_ID`.
 *
 * It needs the Arc vault, because the address it scopes to is the vault's own
 * `paymentEscrow()` immutable and there is nowhere else honest to read it from. Provision
 * with `PRIVY_APP_ID`, `PRIVY_APP_SECRET` and `ARC_MANDATE_VAULT_ADDRESS` set, put the id it
 * returns into `PRIVY_WALLET_POLICY_ID`, and restart.
 */
export async function provisionClaimPolicy(): Promise<{ policyId: string; body: PolicyBody }> {
  const escrowAddress = await getArcEscrow().escrowAddress();
  return getPrivyPolicyClient().createClaimPolicy(escrowAddress);
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
