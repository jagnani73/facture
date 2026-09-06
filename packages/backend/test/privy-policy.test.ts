/**
 * The Privy control.
 *
 * Sign-in proves who a seller is; it constrains nothing about what their key can later be
 * asked to sign. This is the constraint, and what these tests guard is the one way it fails
 * silently: **a policy that looks right and matches nothing.** Privy denies by default, so a
 * rule whose conditions never match does not leave the wallet permissive — it stops the
 * seller collecting money that is already bound to their address on chain. Both directions
 * are bad and neither raises anything at the time it is configured.
 *
 * So the assertions below are mostly about the body: that it names the escrow the vault
 * itself reports, the Arc chain id, and the one function this key exists to call — rather
 * than being an allow-all that would satisfy a checkbox and protect nobody.
 */

import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/env.js';
import { createLogger } from '../src/logger.js';
import {
  attachClaimPolicy,
  CLAIM_ABI,
  CLAIM_POLICY_NAME,
  claimPolicySpec,
  createDisabledPrivyPolicyClient,
  createPrivyPolicyClient,
  POLICY_NOT_CONFIGURED,
  setPrivyPolicyClient,
  type PolicyBody,
} from '../src/services/privy-policy.js';
import { arc } from '../src/chain.js';
import { TEST_ENV } from './helpers.js';

const ESCROW = '0x7B1e1F0A5e8B2D4c9A3f6E0b8C2d1A4F5e6B7c8D';
const APP = { appId: 'app-id', appSecret: 'app-secret' };
const silent = createLogger('error', { svc: 'test' });

const ruleOf = (body: PolicyBody) => {
  const rule = body.rules[0];
  if (rule === undefined) throw new Error('the policy carries no rule at all');
  return rule;
};

const conditionOn = (body: PolicyBody, field: string) =>
  ruleOf(body).conditions.find((c) => c.field === field);

describe('the claim policy body', () => {
  it('names the escrow, the Arc chain and the claim function', () => {
    const body = claimPolicySpec(ESCROW);

    expect(body.version).toBe('1.0');
    expect(body.chain_type).toBe('ethereum');
    expect(body.name).toBe(CLAIM_POLICY_NAME);

    const rule = ruleOf(body);
    expect(rule.method).toBe('eth_sendTransaction');
    expect(rule.action).toBe('ALLOW');

    expect(conditionOn(body, 'to')).toMatchObject({
      field_source: 'ethereum_transaction',
      operator: 'eq',
      value: ESCROW.toLowerCase(),
    });
    expect(conditionOn(body, 'chain_id')).toMatchObject({
      field_source: 'ethereum_transaction',
      operator: 'eq',
      value: String(arc.chainId),
    });
    expect(conditionOn(body, 'function_name')).toMatchObject({
      field_source: 'ethereum_calldata',
      operator: 'eq',
      value: 'claim',
    });
  });

  /*
   * The failure this whole file is about. A rule with no conditions allows every
   * `eth_sendTransaction` the wallet is ever asked for, which is the same key it had before
   * the policy — a control in name, and one that would pass a "is a policy attached" check.
   */
  it('is not an allow-all', () => {
    const rule = ruleOf(claimPolicySpec(ESCROW));

    expect(rule.conditions.length).toBeGreaterThanOrEqual(3);
    expect(rule.method).not.toBe('*');
    expect(rule.conditions.every((c) => c.value !== '' && c.value.length > 0)).toBe(true);
  });

  /*
   * The chain id is Arc's, which Privy does not list among its own chains — and does not
   * need to, because the condition compares against the chain id decoded out of the
   * transaction rather than against a registry. Pinned as a literal so that a change to the
   * shared chain table cannot silently repoint the policy at a different network: a rule
   * naming the wrong chain is a rule that matches nothing, and the seller cannot be paid.
   */
  it('scopes to Arc testnet as a decimal string, not CAIP-2', () => {
    const value = conditionOn(claimPolicySpec(ESCROW), 'chain_id')?.value;

    expect(value).toBe('5042002');
    expect(value).not.toContain('eip155');
  });

  /*
   * Privy decodes calldata against the ABI the condition carries, so the ABI is what the
   * policy is allowed to recognise rather than documentation of the contract. An extra entry
   * here is a widening of the control, which is why the count is asserted.
   */
  it('carries the claim ABI and nothing else', () => {
    const abi = conditionOn(claimPolicySpec(ESCROW), 'function_name')?.abi;

    expect(abi).toBe(CLAIM_ABI);
    expect(CLAIM_ABI).toHaveLength(1);
    expect(CLAIM_ABI[0].name).toBe('claim');
    expect(CLAIM_ABI[0].inputs.map((i) => i.type)).toEqual(['bytes32', 'bytes32']);
  });

  /*
   * Lowercased deliberately. Privy compares the condition value against the transaction's
   * `to` as a string, and the wallet sends whatever viem encoded — so a checksummed literal
   * is a rule that never fires.
   */
  it('lowercases the escrow address rather than trusting its casing', () => {
    expect(conditionOn(claimPolicySpec(ESCROW), 'to')?.value).toBe(ESCROW.toLowerCase());
    expect(conditionOn(claimPolicySpec(ESCROW), 'to')?.value).not.toBe(ESCROW);
  });
});

describe('configuration', () => {
  it('disables the control when Privy credentials are absent', async () => {
    const client = createPrivyPolicyClient({
      appId: undefined,
      appSecret: undefined,
      policyId: 'p1',
    });

    expect(client.enabled).toBe(false);
    expect(client.policyId).toBeNull();
    await expect(client.createClaimPolicy(ESCROW)).rejects.toThrow('PRIVY_APP_ID');
  });

  /*
   * Credentials without an id is the provisioning state and not an attachable one — the
   * policy has to exist before its id can be pinned. `enabled` answers "is a seller's wallet
   * scoped", so it is false here even though this client can reach Privy.
   */
  it('can create but not attach when the policy id is absent', async () => {
    const client = createPrivyPolicyClient({ ...APP, policyId: undefined });

    expect(client.enabled).toBe(false);
    expect(client.policyId).toBeNull();
    await expect(client.attach({ walletId: 'w1', walletAddress: null })).resolves.toEqual({
      attached: false,
      reason: POLICY_NOT_CONFIGURED,
    });
  });

  /*
   * The dangerous half. A policy id with no credentials reads in a `.env` exactly like a
   * deployment with the control switched on, and can never attach anything — so it is
   * refused at boot by name rather than booting quiet.
   */
  it('refuses a policy id with no credentials, by name', () => {
    expect(() => parseEnv({ ...TEST_ENV, PRIVY_WALLET_POLICY_ID: 'p1' })).toThrow(
      /PRIVY_WALLET_POLICY_ID.*PRIVY_APP_ID/s,
    );
  });

  it('refuses an authorization key with no policy to sign for', () => {
    expect(() =>
      parseEnv({
        ...TEST_ENV,
        PRIVY_APP_ID: 'a',
        PRIVY_APP_SECRET: 'b',
        PRIVY_AUTHORIZATION_PRIVATE_KEY: 'k',
      }),
    ).toThrow(/PRIVY_AUTHORIZATION_PRIVATE_KEY/);
  });

  it('accepts the whole configuration together', () => {
    const env = parseEnv({
      ...TEST_ENV,
      PRIVY_APP_ID: 'a',
      PRIVY_APP_SECRET: 'b',
      PRIVY_WALLET_POLICY_ID: 'p1',
      PRIVY_AUTHORIZATION_PRIVATE_KEY: 'k',
    });

    expect(env.PRIVY_WALLET_POLICY_ID).toBe('p1');
  });

  it('reports not-configured rather than throwing when nothing is set', async () => {
    setPrivyPolicyClient(createDisabledPrivyPolicyClient());

    const result = await attachClaimPolicy({ walletId: 'w1', walletAddress: null }, silent);

    expect(result).toEqual({ attached: false, reason: POLICY_NOT_CONFIGURED });
    setPrivyPolicyClient(undefined);
  });
});

/** A `fetch` that answers a scripted route table and records what it was asked. */
function stubPrivyApi(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: { method: string; path: string; body: unknown; headers: Headers }[] = [];

  const fetchImpl = ((input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const key = `${method} ${url.pathname}`;
    const parsed = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path: url.pathname, body: parsed, headers: new Headers(init?.headers) });

    const route = routes[key];
    if (route === undefined) {
      return Promise.resolve(new Response('no route', { status: 404 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 }),
    );
  }) as typeof fetch;

  return { fetch: fetchImpl, calls };
}

describe('attaching the policy to a wallet', () => {
  const client = (api: ReturnType<typeof stubPrivyApi>) =>
    createPrivyPolicyClient({ ...APP, policyId: 'p1', fetch: api.fetch, logger: silent });

  it('reads the wallet before writing, and writes when the policy is missing', async () => {
    const api = stubPrivyApi({
      'GET /v1/wallets/w1': { body: { id: 'w1', policy_ids: [] } },
      'PATCH /v1/wallets/w1': { body: { id: 'w1', policy_ids: ['p1'] } },
    });

    const result = await client(api).attach({ walletId: 'w1', walletAddress: null });

    expect(result).toEqual({ attached: true, policyId: 'p1', walletId: 'w1', alreadyHeld: false });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/wallets/w1',
      'PATCH /v1/wallets/w1',
    ]);
    expect(api.calls[1]?.body).toEqual({ policy_ids: ['p1'] });
  });

  /*
   * Idempotency, which on this route means a returning seller. Signing in is the common
   * case and a PATCH per sign-in would be a write whose only effect is to restate what the
   * wallet already carries — and `policy_ids` replaces rather than appends, so a blind write
   * is also how another policy attached in the dashboard gets dropped.
   */
  it('writes nothing for a wallet that already carries the policy', async () => {
    const api = stubPrivyApi({
      'GET /v1/wallets/w1': { body: { id: 'w1', policy_ids: ['p1'] } },
    });

    const result = await client(api).attach({ walletId: 'w1', walletAddress: null });

    expect(result).toEqual({ attached: true, policyId: 'p1', walletId: 'w1', alreadyHeld: true });
    expect(api.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('keeps policies the wallet already had rather than replacing them', async () => {
    const api = stubPrivyApi({
      'GET /v1/wallets/w1': { body: { id: 'w1', policy_ids: ['other'] } },
      'PATCH /v1/wallets/w1': { body: { id: 'w1', policy_ids: ['other', 'p1'] } },
    });

    await client(api).attach({ walletId: 'w1', walletAddress: null });

    expect(api.calls[1]?.body).toEqual({ policy_ids: ['other', 'p1'] });
  });

  /*
   * The identity token carries a wallet id only for a delegated wallet or one on the unified
   * wallets stack, so an ordinary embedded wallet arrives with an address and nothing else.
   * A policy attaches to an id, never to an address, so the address has to be resolved.
   */
  it('resolves a wallet id from the address when the token carried none', async () => {
    const api = stubPrivyApi({
      'POST /v1/wallets/address': { body: { id: 'w9', address: ESCROW } },
      'GET /v1/wallets/w9': { body: { id: 'w9', policy_ids: [] } },
      'PATCH /v1/wallets/w9': { body: { id: 'w9', policy_ids: ['p1'] } },
    });

    const result = await client(api).attach({ walletId: null, walletAddress: ESCROW });

    expect(result).toMatchObject({ attached: true, walletId: 'w9' });
    expect(api.calls[0]?.body).toEqual({ address: ESCROW });
  });

  it('says so rather than guessing when there is neither an id nor an address', async () => {
    const api = stubPrivyApi({});

    const result = await client(api).attach({ walletId: null, walletAddress: null });

    expect(result).toMatchObject({ attached: false });
    expect(api.calls).toHaveLength(0);
  });

  /*
   * A write is not a receipt. A 200 says Privy accepted the request; whether the wallet
   * carries the policy is a separate claim, and one the response actually answers — so
   * there is no reason to infer it. This repo has shipped "the call succeeded and the
   * transaction failed" twice on chain.
   */
  it('does not report applied when the response does not carry the policy', async () => {
    const api = stubPrivyApi({
      'GET /v1/wallets/w1': { body: { id: 'w1', policy_ids: [] } },
      'PATCH /v1/wallets/w1': { body: { id: 'w1', policy_ids: [] } },
    });

    const result = await client(api).attach({ walletId: 'w1', walletAddress: null });

    expect(result).toMatchObject({ attached: false });
    expect(result.attached ? '' : result.reason).toContain('does not carry policy p1');
  });

  it('carries Privy authentication on every call', async () => {
    const api = stubPrivyApi({ 'GET /v1/wallets/w1': { body: { id: 'w1', policy_ids: ['p1'] } } });

    await client(api).attach({ walletId: 'w1', walletAddress: null });

    const headers = api.calls[0]?.headers;
    expect(headers?.get('privy-app-id')).toBe('app-id');
    expect(headers?.get('authorization')).toBe(
      `Basic ${Buffer.from('app-id:app-secret').toString('base64')}`,
    );
  });
});

describe('creating the policy', () => {
  it('posts the spec and returns the id Privy minted', async () => {
    const api = stubPrivyApi({ 'POST /v1/policies': { body: { id: 'pol_abc' } } });
    const client = createPrivyPolicyClient({
      ...APP,
      policyId: undefined,
      fetch: api.fetch,
      logger: silent,
    });

    const created = await client.createClaimPolicy(ESCROW);

    expect(created.policyId).toBe('pol_abc');
    expect(api.calls[0]?.body).toEqual(claimPolicySpec(ESCROW));
  });

  /*
   * A deterministic key rather than a random UUID. Policy names carry no uniqueness
   * constraint at Privy, so a retry after a dropped connection would otherwise create a
   * second identical policy and leave the venue unable to say which one a wallet carries.
   */
  it('sends a deterministic idempotency key derived from the body', async () => {
    const one = stubPrivyApi({ 'POST /v1/policies': { body: { id: 'pol_abc' } } });
    const two = stubPrivyApi({ 'POST /v1/policies': { body: { id: 'pol_abc' } } });
    const build = (api: ReturnType<typeof stubPrivyApi>) =>
      createPrivyPolicyClient({ ...APP, policyId: undefined, fetch: api.fetch, logger: silent });

    await build(one).createClaimPolicy(ESCROW);
    await build(two).createClaimPolicy(ESCROW);

    const key = one.calls[0]?.headers.get('privy-idempotency-key');
    expect(key).toBeTruthy();
    expect(two.calls[0]?.headers.get('privy-idempotency-key')).toBe(key);
  });

  it('gives a different key to a different escrow, so two policies cannot collapse', async () => {
    const one = stubPrivyApi({ 'POST /v1/policies': { body: { id: 'a' } } });
    const two = stubPrivyApi({ 'POST /v1/policies': { body: { id: 'b' } } });
    const build = (api: ReturnType<typeof stubPrivyApi>) =>
      createPrivyPolicyClient({ ...APP, policyId: undefined, fetch: api.fetch, logger: silent });

    await build(one).createClaimPolicy(ESCROW);
    await build(two).createClaimPolicy('0x1111111111111111111111111111111111111111');

    expect(one.calls[0]?.headers.get('privy-idempotency-key')).not.toBe(
      two.calls[0]?.headers.get('privy-idempotency-key'),
    );
  });

  /*
   * Loud, at provisioning time, in the operator's hands. The two refusals worth telling
   * apart — a plan with no policy engine, and a condition the live schema does not know —
   * are distinguishable only from what Privy said, so the message is carried rather than
   * summarised.
   */
  it('carries Privy own words when it refuses', async () => {
    const api = stubPrivyApi({
      'POST /v1/policies': { status: 403, body: { error: 'policy engine not enabled' } },
    });
    const client = createPrivyPolicyClient({
      ...APP,
      policyId: undefined,
      fetch: api.fetch,
      logger: silent,
    });

    await expect(client.createClaimPolicy(ESCROW)).rejects.toThrow('policy engine not enabled');
  });

  it('refuses a create that returned no id rather than inventing one', async () => {
    const api = stubPrivyApi({ 'POST /v1/policies': { body: { name: CLAIM_POLICY_NAME } } });
    const client = createPrivyPolicyClient({
      ...APP,
      policyId: undefined,
      fetch: api.fetch,
      logger: silent,
    });

    await expect(client.createClaimPolicy(ESCROW)).rejects.toThrow('returned no id');
  });
});
