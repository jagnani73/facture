/**
 * The buyer's key.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * WHAT THESE TESTS CAN PROVE WITHOUT A LEDGER
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * More than expected, and it is worth saying why. `@x402/hedera`'s client scheme builds and
 * signs a `TransferTransaction` entirely locally — `freezeWith` needs only the node addresses
 * an SDK client already knows, and `sign` is arithmetic. So the payload can be decoded here
 * and checked against what the challenge asked for, which turns "the SDK was called" into
 * "the signed bytes pay this amount to this account and no other".
 *
 * That is the assertion worth having, because the failure mode on this rail is not an
 * exception. A payload built from the wrong field is a valid signature over the wrong
 * transfer, and the facilitator submits it.
 *
 * Every key below is generated in-process and holds nothing.
 */

import { PrivateKey } from '@hiero-ledger/sdk';
import { inspectHederaTransaction } from '@x402/hedera';
import { describe, expect, it } from 'vitest';
import {
  CashLegError,
  createCashLegSigner,
  selectRequirements,
  type PaymentChallenge,
} from '../src/cash.js';

/* ── fixtures ────────────────────────────────────────────────────────────────────────── */

const PAYER = '0.0.10314099';
const PAY_TO = '0.0.10311549';
const FEE_PAYER = '0.0.7162784';

const requirements = (over: Record<string, unknown> = {}) => ({
  scheme: 'exact',
  network: 'hedera:testnet' as `${string}:${string}`,
  asset: '0.0.0',
  amount: '3918',
  payTo: PAY_TO,
  maxTimeoutSeconds: 120,
  extra: { feePayer: FEE_PAYER },
  ...over,
});

const challenge = (...accepts: ReturnType<typeof requirements>[]): PaymentChallenge => ({
  x402Version: 2,
  accepts: accepts.length > 0 ? accepts : [requirements()],
});

const signer = (over: { accountId?: string; network?: `${string}:${string}` } = {}) =>
  createCashLegSigner({
    accountId: over.accountId ?? PAYER,
    privateKey: PrivateKey.generateECDSA().toStringDer(),
    network: over.network ?? 'hedera:testnet',
  });

/** A fetch that answers one body, or one status, and nothing else. */
const stubFetch =
  (route: { status?: number; body?: unknown; throws?: boolean }): typeof globalThis.fetch =>
  async () => {
    if (route.throws === true) throw new Error('mirror node unreachable');
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };

/* ── tests ───────────────────────────────────────────────────────────────────────────── */

describe('configuration is rejected at boot, not at the first trade', () => {
  /*
   * A key that does not parse is a configuration error, and the expensive time to find out
   * is when a challenge arrives — by which point the venue has already held the seller's
   * paper against a payment this process cannot make.
   */
  it('refuses an EVM address where a ledger account id belongs', () => {
    expect(() =>
      createCashLegSigner({
        accountId: '0x2Da63Ac0F6AE2C3059091d8DF38b3175a237ee71',
        privateKey: PrivateKey.generateECDSA().toStringDer(),
        network: 'hedera:testnet',
      }),
    ).toThrow(/Hedera account id/);
  });

  /*
   * CAIP-2 with a colon. The hyphenated spelling is the one that reached the facilitator
   * once already and failed there — after the ATS hold was placed.
   */
  it('refuses a network id that is not CAIP-2', () => {
    expect(() =>
      createCashLegSigner({
        accountId: PAYER,
        privateKey: PrivateKey.generateECDSA().toStringDer(),
        network: 'hedera-testnet' as `${string}:${string}`,
      }),
    ).toThrow(/CAIP-2/);
  });

  /**
   * The message must name the variable and the rule, and nothing else.
   *
   * This is the one code path guaranteed to run when the key is wrong, so an error that
   * echoed what it was given would put a spendable key wherever the error goes.
   */
  it('refuses an unreadable key without putting the key in the message', () => {
    const secret = 'definitely-not-a-key-0123456789abcdef';
    let message = '';
    try {
      createCashLegSigner({ accountId: PAYER, privateKey: secret, network: 'hedera:testnet' });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/AGENT_HEDERA_PRIVATE_KEY/);
    expect(message).not.toContain(secret);
  });
});

describe('selectRequirements', () => {
  it('takes the HBAR option on this payer’s own network', () => {
    const chosen = selectRequirements(challenge(), 'hedera:testnet');
    expect(chosen.asset).toBe('0.0.0');
    expect(chosen.amount).toBe('3918');
  });

  /*
   * Not `accepts[0]`. A resource may offer several rails — Hedera's scheme and Circle's
   * Nanopayments are both x402 schemes, and a client registers schemes per network — so
   * choosing by scheme and network is what keeps this a client of the protocol rather than
   * of this venue's current configuration.
   */
  it('picks by network and scheme rather than by position', () => {
    const chosen = selectRequirements(
      challenge(
        requirements({ network: 'eip155:5042002', asset: '0x3600', amount: '14843' }),
        requirements(),
      ),
      'hedera:testnet',
    );
    expect(chosen.network).toBe('hedera:testnet');
    expect(chosen.amount).toBe('3918');
  });

  it('refuses a challenge for another chain, and names what was offered', () => {
    expect(() =>
      selectRequirements(challenge(requirements({ network: 'eip155:5042002' })), 'hedera:testnet'),
    ).toThrow(/eip155:5042002/);
  });

  it('refuses a scheme this payer has not registered', () => {
    expect(() =>
      selectRequirements(challenge(requirements({ scheme: 'upto' })), 'hedera:testnet'),
    ).toThrow(/upto/);
  });

  /*
   * HTS is refused here rather than at consensus. Every HTS token — USDC on Hedera
   * included — needs an explicit association on the receiving side, and without one the
   * transfer fails as `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT` after the venue has held the paper.
   */
  it('refuses an HTS asset, because association is a step this agent has not taken', () => {
    expect(() =>
      selectRequirements(challenge(requirements({ asset: '0.0.429274' })), 'hedera:testnet'),
    ).toThrow(/association/i);
  });

  /*
   * The fee payer is the facilitator's, read at runtime from its own `GET /supported`. A
   * pinned value works right up until it rotates the payer, at which point every payment
   * fails as an opaque signature mismatch — so its absence is refused rather than defaulted.
   */
  it('refuses a challenge with no fee payer rather than guessing one', () => {
    expect(() =>
      selectRequirements(challenge(requirements({ extra: {} })), 'hedera:testnet'),
    ).toThrow(/feePayer/);
  });

  it('raises a CashLegError marked unsupported, so the loop can tell it from a fault', () => {
    try {
      selectRequirements(challenge(requirements({ asset: '0.0.429274' })), 'hedera:testnet');
      expect.unreachable('should have refused an HTS asset');
    } catch (err) {
      expect(err).toBeInstanceOf(CashLegError);
      expect((err as CashLegError).kind).toBe('unsupported');
    }
  });
});

describe('sign', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════
   * THE ASSERTION THAT MATTERS
   * ═══════════════════════════════════════════════════════════════════════════════════
   *
   * The signed bytes are decoded and checked against the challenge. A payload assembled
   * from the wrong field would still be a valid signature — over the wrong transfer — and
   * the facilitator would submit it, so "it signed something" is not a useful claim.
   */
  it('signs a transfer of exactly the amount asked, to exactly the account asked', async () => {
    const signed = await signer().sign(challenge());
    const tx = inspectHederaTransaction(signed.payload.payload['transaction'] as string);

    expect(tx.hasNonTransferOperations).toBe(false);
    expect(tx.tokenTransfers).toEqual({});
    // Two entries and no others: the payer down, the payee up, by the same figure.
    expect(tx.hbarTransfers).toEqual([
      { accountId: PAY_TO, amount: '3918' },
      { accountId: PAYER, amount: '-3918' },
    ]);
  });

  /**
   * **The buyer pays no gas, and this is where that comes from.**
   *
   * The transaction id is generated against the facilitator's account, which makes the
   * facilitator the fee payer — and is also why the payload is only *partially* signed. It
   * is not submittable until the facilitator adds its own signature, so a leaked payload is
   * a transfer nobody but the facilitator can broadcast, to an account the challenge named.
   */
  it('draws the fee from the facilitator, not from the buyer', async () => {
    const signed = await signer().sign(challenge());
    const tx = inspectHederaTransaction(signed.payload.payload['transaction'] as string);

    expect(tx.transactionIdAccountId).toBe(FEE_PAYER);
    expect(signed.feePayer).toBe(FEE_PAYER);
    expect(tx.transactionIdAccountId).not.toBe(PAYER);
  });

  /*
   * The canonical v2 envelope, `{ x402Version, accepted, payload }`. `accepted` is not
   * redundancy: the facilitator matches the signed transfer against the requirements the
   * resource server hands it, and a payload that did not say which option it took could not
   * be checked against the right one.
   */
  it('returns the canonical payload, carrying the requirements it signed', async () => {
    const signed = await signer().sign(challenge());

    expect(signed.payload.x402Version).toBe(2);
    expect(signed.payload.accepted.payTo).toBe(PAY_TO);
    expect(signed.payload.accepted.network).toBe('hedera:testnet');
    expect(Object.keys(signed.payload).sort()).toEqual(['accepted', 'payload', 'x402Version']);
  });

  /*
   * The amount comes back as a `bigint` in the asset's own smallest unit, which is what the
   * agent compares its balance against. Returning the string would invite a `Number` on it,
   * and this is a package where one such coercion has already cost a hundredfold error.
   */
  it('reports the amount as a bigint in tinybars, for the balance check to use', async () => {
    const signed = await signer().sign(challenge());
    expect(signed.amount).toBe(3918n);
    expect(typeof signed.amount).toBe('bigint');
  });
});

describe('balanceTinybars', () => {
  const withFetch = (route: Parameters<typeof stubFetch>[0]) =>
    createCashLegSigner({
      accountId: PAYER,
      privateKey: PrivateKey.generateECDSA().toStringDer(),
      network: 'hedera:testnet',
      fetch: stubFetch(route),
    });

  it('reads tinybars off the mirror node as a bigint', async () => {
    const balance = await withFetch({
      body: { balance: { balance: 4_827_974_750 } },
    }).balanceTinybars();
    expect(balance).toBe(4_827_974_750n);
  });

  /*
   * `null`, never zero, on every failure below. The caller draws a real distinction between
   * "the payer is empty" and "we could not ask" — the first is a refusal it can explain to
   * someone, the second is a reason not to act at all — and collapsing them into `0n` would
   * report an unreachable mirror node as an unfunded buyer.
   */
  it('answers null rather than zero when the mirror node refuses', async () => {
    expect(await withFetch({ status: 404, body: {} }).balanceTinybars()).toBeNull();
  });

  it('answers null rather than zero when the mirror node is unreachable', async () => {
    expect(await withFetch({ throws: true }).balanceTinybars()).toBeNull();
  });

  it('answers null on a body it does not recognise', async () => {
    expect(await withFetch({ body: { balance: {} } }).balanceTinybars()).toBeNull();
  });

  /*
   * The mirror node emits tinybars as a JSON number, so anything above 2^53 has already
   * been rounded by `JSON.parse` before it gets here. A rounded balance is not one this
   * process can claim to have read, so it is reported as unreadable rather than as a figure
   * that is quietly wrong. About 90 million HBAR — far above any account in this system.
   */
  it('will not report a balance JSON.parse has already rounded', async () => {
    const balance = await withFetch({
      body: { balance: { balance: Number.MAX_SAFE_INTEGER + 10 } },
    }).balanceTinybars();
    expect(balance).toBeNull();
  });
});
