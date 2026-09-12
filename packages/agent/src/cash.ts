/**
 * The cash leg, signed.
 *
 * This module is the buyer's key. It turns an x402 challenge from the venue into a signed
 * payment payload, and it does nothing else — it decides no trade, reads no book, and
 * compares no balance against a price. `agent.ts` decides; this signs what it is told to.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A HEDERA SIGNER AND NOT THE CIRCLE WALLET
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * `@x402/hedera`'s `exact` scheme signs a **native Hedera `TransferTransaction`**,
 * serialised to base64, and the facilitator verifies it against the payer's on-chain
 * account key from the mirror node. It is a protobuf body — not EIP-712, not
 * `eth_sendTransaction`. So no EVM signer produces it: not the Circle agent wallet, which
 * is an Arc EVM wallet with no Hedera account, and not a Privy embedded wallet, whose raw
 * signing is prefixed EIP-191 or typed EIP-712 either way.
 *
 * That is the whole reason this file exists as its own key rather than reusing one the
 * agent already holds. The buyer therefore has two identities, deliberately: an Arc address
 * that funds the vault, and a Hedera account that pays per trade. Which one settles is the
 * venue's choice, not this process's — see `chooseRail` in the backend.
 *
 * ## The fee payer is not us
 *
 * `createPartiallySignedTransferTransaction` sets the transaction id against
 * `requirements.extra.feePayer` — the facilitator's account — so the payer signs a transfer
 * of exactly the quoted proceeds and pays **no gas**. The transaction is *partially* signed
 * for that reason: it is not submittable until the facilitator adds its own signature, which
 * is what makes handing it over safe. A payload that leaked is a transfer nobody but the
 * facilitator can broadcast, to an account the challenge already named.
 *
 * ## HBAR only, and that is checked rather than assumed
 *
 * The venue settles in HBAR (`0.0.0`, tinybars, 8dp), and no longer carries a mode that
 * would make it do otherwise. An HTS asset would owe this payer an association step that
 * does not exist here, and an unassociated receiver fails at consensus with
 * `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT` — after the venue has armed the asset leg.
 *
 * **The check below stays even so.** The challenge is read off the facilitator's
 * `payment-required` header, not off Facture's response shape, so what a payer is asked for
 * is not this repo's to assume — this agent is a client of x402 rather than of one venue.
 * A non-HBAR challenge is refused before anything is signed, by name.
 */

import { PrivateKey } from '@hiero-ledger/sdk';
import {
  HBAR_ASSET_ID,
  SUPPORTED_HEDERA_NETWORKS,
  createClientHederaSigner,
  isHbarAsset,
  isValidHederaEntityId,
  mirrorNodeUrlForNetwork,
} from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { z } from 'zod';

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * The wire shapes
 * ───────────────────────────────────────────────────────────────────────────────────── */

/**
 * A CAIP-2 network id, narrowed to the template type `@x402/core` requires.
 *
 * The cast is the one in this file, and it is placed immediately after the regex that proves
 * the shape rather than at a call site further away. `@x402/core` types `network` as
 * `` `${string}:${string}` ``, which no `z.string()` satisfies — and the alternative to
 * narrowing here is asserting at every use, which is how the hyphenated spelling got as far
 * as the facilitator once already.
 */
const caip2 = z
  .string()
  .regex(/^[^:\s]+:[^:\s]+$/, 'must be CAIP-2 with a colon, like hedera:testnet')
  .transform((value) => value as `${string}:${string}`);

/**
 * One option the venue will accept payment on.
 *
 * Parsed rather than trusted: this object is what gets signed, and every field of it ends
 * up in a transfer. `amount` is a decimal string in the asset's smallest unit — read with
 * `BigInt`, never `Number`, for the reason `venue.ts` sets out at length.
 */
export const paymentRequirementsSchema = z
  .object({
    scheme: z.string().min(1),
    network: caip2,
    asset: z.string().min(1),
    amount: z.string().regex(/^(0|[1-9]\d*)$/, 'must be a non-negative integer, as a string'),
    payTo: z.string().min(1),
    /*
     * Both required, because x402 v2 requires them. `extra` in particular is where the
     * facilitator's fee payer lives, and a challenge without it is one no Hedera payment can
     * be built from — so treating it as optional would only move the failure from parsing to
     * signing, past the point where the seller's paper is already held.
     */
    maxTimeoutSeconds: z.number().int().positive(),
    extra: z.record(z.string(), z.unknown()),
  })
  /* Unknown keys are kept: the payload is signed over the whole object, and dropping a
   * field the facilitator checks would produce a signature that verifies against nothing. */
  .passthrough();

export type PaymentRequirements = z.infer<typeof paymentRequirementsSchema>;

/**
 * The `payment-required` challenge, as x402 v2 shapes it.
 *
 * `accepts` is a list because a resource may offer several rails. The venue offers one
 * today; picking by scheme and network rather than taking `accepts[0]` is what keeps this a
 * client of the protocol rather than of this venue's current configuration.
 */
export const paymentChallengeSchema = z.object({
  x402Version: z.number().int().positive(),
  accepts: z.array(paymentRequirementsSchema).min(1),
  resource: z.unknown().optional(),
});

export type PaymentChallenge = z.infer<typeof paymentChallengeSchema>;

/**
 * The canonical x402 v2 `PaymentPayload`, which is what goes back in `payment-signature`.
 *
 * `accepted` carries the requirements this payload was signed against. That is not
 * redundancy: the facilitator matches the signed transfer against the requirements the
 * resource server sends it, and a payload that did not say which option it took could not
 * be checked against the right one.
 */
export interface PaymentPayload {
  readonly x402Version: number;
  readonly accepted: PaymentRequirements;
  readonly payload: Record<string, unknown>;
}

/** A signed cash leg, and the facts about it worth reporting without decoding protobuf. */
export interface SignedCashLeg {
  readonly payload: PaymentPayload;
  /** What this pays, in the asset's smallest unit. Tinybars for HBAR. */
  readonly amount: bigint;
  readonly asset: string;
  readonly network: string;
  readonly payTo: string;
  /** The facilitator account that will add its signature and pay the gas. */
  readonly feePayer: string;
}

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * Errors
 * ───────────────────────────────────────────────────────────────────────────────────── */

/**
 * A challenge this payer will not sign, and why.
 *
 * Separate from a signing failure on purpose. `unsupported` means the venue asked for
 * something this key cannot pay — a different chain, an HTS token, a scheme not registered
 * here — and it is a configuration fact that will be true again next tick. A thrown SDK
 * error is a transient one.
 */
export class CashLegError extends Error {
  constructor(
    message: string,
    readonly kind: 'unsupported' | 'signing_failed',
  ) {
    super(message);
    this.name = 'CashLegError';
  }
}

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * The signer
 * ───────────────────────────────────────────────────────────────────────────────────── */

export interface CashLegSigner {
  /** The payer, as the ledger knows it. `0.0.x`, never an EVM address. */
  readonly payerAccountId: string;
  readonly network: string;
  /**
   * The payer's HBAR balance in tinybars, from the mirror node, or `null` when it could
   * not be read.
   *
   * `null` is not zero and the caller must not treat it as either a pass or a fail without
   * saying which — the same distinction the venue draws between an unreadable vault and an
   * empty one.
   */
  balanceTinybars(): Promise<bigint | null>;
  /** Sign one challenge. Throws {@link CashLegError} rather than returning a null payload. */
  sign(challenge: PaymentChallenge): Promise<SignedCashLeg>;
}

export interface CashLegSignerConfig {
  /** `0.0.x`. The account whose key signs, and whose balance pays. */
  readonly accountId: string;
  /** ECDSA. An ED25519 key holds HBAR fine but cannot sign for anything EVM-adjacent. */
  readonly privateKey: string;
  /** CAIP-2, with a colon: `hedera:testnet`. The hyphenated spelling fails at the facilitator. */
  readonly network: string;
  readonly fetch?: typeof globalThis.fetch | undefined;
  /** Bounded so a slow mirror node cannot stall a tick. */
  readonly timeoutMs?: number | undefined;
}

/**
 * Build the signer. Throws on a malformed account id or key, at boot rather than at the
 * first trade — a key this process cannot parse is a configuration error, and discovering
 * it while a hold is open on the seller's paper is the expensive time to find out.
 */
export function createCashLegSigner(config: CashLegSignerConfig): CashLegSigner {
  if (!isValidHederaEntityId(config.accountId)) {
    throw new Error(
      `AGENT_HEDERA_ACCOUNT_ID must be a Hedera account id like 0.0.1234, not an EVM address. ` +
        'The x402 cash leg is a native transfer and references accounts by ledger id.',
    );
  }
  if (!(SUPPORTED_HEDERA_NETWORKS as readonly string[]).includes(config.network)) {
    throw new Error(
      `AGENT_HEDERA_NETWORK must be one of ${SUPPORTED_HEDERA_NETWORKS.join(', ')} — CAIP-2 ` +
        'with a colon. The facilitator matches this string exactly.',
    );
  }

  /*
   * Parsed once, here, so a bad key fails at boot. `fromStringECDSA` rather than
   * `fromString`: the latter guesses at the curve, and a key silently read as ED25519
   * produces signatures the facilitator rejects as `signature_invalid` — which reads like
   * the payload is wrong rather than the key type.
   */
  let key: PrivateKey;
  try {
    key = PrivateKey.fromStringECDSA(config.privateKey);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    // The key itself never appears here. See the header of `env.ts`.
    throw new Error(`AGENT_HEDERA_PRIVATE_KEY is not a readable ECDSA private key: ${reason}`);
  }

  const signer = createClientHederaSigner(config.accountId, key, { network: config.network });
  const scheme = new ExactHederaScheme(signer);
  const doFetch = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;
  const mirrorNode = mirrorNodeUrlForNetwork(config.network);

  return {
    payerAccountId: signer.accountId,
    network: config.network,

    async balanceTinybars() {
      const url = `${mirrorNode}/api/v1/accounts/${encodeURIComponent(config.accountId)}`;
      try {
        const response = await doFetch(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return null;
        const parsed = mirrorAccountSchema.safeParse(await response.json());
        return parsed.success ? parsed.data.balance.balance : null;
      } catch {
        // Unreachable mirror node. `null`, not zero — the caller decides what that means.
        return null;
      }
    },

    async sign(challenge) {
      const accepted = selectRequirements(challenge, config.network);

      /*
       * The scheme returns only `{ x402Version, payload }` — the version and the
       * scheme-specific body. The envelope around it is assembled here because
       * `PaymentPayload` is a core type rather than a scheme one, and `accepted` is the
       * field that tells the facilitator which option was taken.
       */
      let result;
      try {
        result = await scheme.createPaymentPayload(challenge.x402Version, accepted);
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new CashLegError(`the cash leg could not be signed: ${reason}`, 'signing_failed');
      }

      return {
        payload: { x402Version: result.x402Version, accepted, payload: result.payload },
        amount: BigInt(accepted.amount),
        asset: accepted.asset,
        network: accepted.network,
        payTo: accepted.payTo,
        feePayer: feePayerOf(accepted),
      };
    },
  };
}

/* ───────────────────────────────────────────────────────────────────────────────────── *
 * Choosing what to sign
 * ───────────────────────────────────────────────────────────────────────────────────── */

/**
 * Pick the one option in `accepts` this payer can actually settle.
 *
 * Exported because it is the whole of the decision and is worth testing without a key. The
 * refusals are separate sentences rather than one "unsupported challenge", because the
 * three causes have three different fixes: the wrong chain is a configuration mismatch, an
 * HTS asset needs an association, and a missing fee payer is the facilitator's side.
 */
export function selectRequirements(
  challenge: PaymentChallenge,
  network: string,
): PaymentRequirements {
  const onThisNetwork = challenge.accepts.filter((r) => r.network === network);
  if (onThisNetwork.length === 0) {
    const offered = [...new Set(challenge.accepts.map((r) => r.network))].join(', ');
    throw new CashLegError(
      `this payer settles on ${network} and the venue offered ${offered || 'nothing'}. ` +
        'Note the network id is CAIP-2 with a colon; the hyphenated spelling matches nothing.',
      'unsupported',
    );
  }

  const exact = onThisNetwork.filter((r) => r.scheme === 'exact');
  if (exact.length === 0) {
    const offered = [...new Set(onThisNetwork.map((r) => r.scheme))].join(', ');
    throw new CashLegError(
      `only the 'exact' scheme is registered on this payer, and the venue offered ${offered}.`,
      'unsupported',
    );
  }

  /*
   * HBAR only. An HTS challenge is refused here rather than at consensus: the receiver
   * needs an explicit association for every HTS token including USDC on Hedera, and the
   * failure lands as `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT` after the venue has already held the
   * seller's paper.
   */
  const hbar = exact.find((r) => isHbarAsset(r.asset));
  if (hbar === undefined) {
    const offered = [...new Set(exact.map((r) => r.asset))].join(', ');
    throw new CashLegError(
      `this payer settles native HBAR (${HBAR_ASSET_ID}) and the venue asked for ${offered}. ` +
        'An HTS asset needs an explicit association on both sides, which this agent has not made.',
      'unsupported',
    );
  }

  // Read once here so `sign` cannot produce a payload the SDK will reject a line later.
  feePayerOf(hbar);
  return hbar;
}

/**
 * The facilitator account that pays the gas.
 *
 * **Read at runtime, never hardcoded.** It is `GET /supported`'s answer on the venue's side
 * and arrives in `extra`; a pinned value works right up until the facilitator rotates the
 * payer, at which point every payment fails as an opaque signature mismatch.
 */
function feePayerOf(requirements: PaymentRequirements): string {
  const feePayer = requirements.extra['feePayer'];
  if (typeof feePayer !== 'string' || feePayer.length === 0) {
    throw new CashLegError(
      'the challenge carries no extra.feePayer, so there is no account to draw the fee from. ' +
        'The facilitator supplies this; it is never pinned on this side.',
      'unsupported',
    );
  }
  return feePayer;
}

/**
 * Only the one field is read; the mirror node's account body is large and mostly irrelevant.
 *
 * **The safe-integer bound is enforced rather than assumed.** The mirror node emits tinybars
 * as a JSON number, and `JSON.parse` has already rounded anything above 2^53 by the time this
 * schema sees it — so a value at the ceiling is one this process cannot claim to have read.
 * That is about 90 million HBAR, far above any account here, and the guard costs nothing: it
 * turns a silently wrong balance into `null`, which the caller already knows how to treat as
 * "unreadable" rather than as a number.
 */
const mirrorAccountSchema = z.object({
  balance: z.object({
    balance: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .transform((v) => BigInt(v)),
  }),
});
