/**
 * x402 facilitator client (Blocky402 testnet).
 *
 * Facture reads x402 as a settlement protocol rather than an API paywall: the challenge
 * holds the asset leg, the payment signature is the cash leg, and the facilitator is
 * what makes the two simultaneous. Nothing is wrapped and nothing crosses chains.
 *
 * Two things about this integration are easy to get wrong:
 *
 *  1. HEADER NAMES. Blocky402's own docs snippets still show the legacy `X-PAYMENT`
 *     header. The shipped `@x402/*` 2.24.0 packages speak v2:
 *     `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`. Follow the SDK.
 *
 *  2. `extra.feePayer` IS NOT A CONSTANT. It is read at runtime from `GET /supported`
 *     for the chosen (scheme, network) pair and cached. Hardcoding it works until the
 *     facilitator rotates the payer and then fails as an opaque signature mismatch.
 *
 * Default asset is HBAR (`0.0.0`). Every HTS token — USDC on Hedera included — requires
 * explicit association by the receiver before it can be received, on both the payer and
 * the receiver side, which is a manual step that broke the reference PoC. HTS therefore
 * sits behind `X402_ASSET_MODE=hts` rather than being the default.
 */

import { upstreamUnavailable } from '../errors.js';
import type { Logger } from '../logger.js';
import { rootLogger } from '../logger.js';

/** x402 v2 wire headers. Do not reintroduce `X-PAYMENT`. */
export const X402_HEADERS = {
  /** Server -> client, on the 402. Carries the accepted `PaymentRequirements`. */
  required: 'PAYMENT-REQUIRED',
  /** Client -> server. Carries the signed payment payload. */
  signature: 'PAYMENT-SIGNATURE',
  /** Server -> client, on success. Carries the settlement receipt. */
  response: 'PAYMENT-RESPONSE',
} as const;

export const X402_VERSION = 2;

/**
 * The 402 challenge, as this service builds it.
 *
 * **Settled empirically on 2026-09-01, not inferred from docs.** Three 0.001 HBAR payments
 * were signed, verified and settled against `https://api.testnet.blocky402.com`, and
 * confirmed on the mirror node. The shape below is the one the facilitator accepted,
 * verbatim, and it matches `@x402/core` 2.24.0 rather than the earlier v2 spelling:
 *
 * ```json
 * { "scheme": "exact", "network": "hedera:testnet", "asset": "0.0.0",
 *   "amount": "100000", "payTo": "0.0.7162784", "maxTimeoutSeconds": 120,
 *   "extra": { "feePayer": "0.0.7162784" } }
 * ```
 *
 * So it is `amount`, not `maxAmountRequired`, and `resource` / `description` / `mimeType`
 * are NOT requirements fields — they live on `PaymentRequired.resource: ResourceInfo`,
 * a sibling of `accepted`. Sending the old spelling fails as an opaque rejection at settle
 * time rather than a type error, which is why this was worth one live round trip.
 *
 * `extra.feePayer` is **mandatory** — the Hedera signer throws without it — and must be
 * read from `GET /supported` at runtime rather than hardcoded.
 *
 * Two behaviours of this facilitator that the type cannot express, both proven:
 * `POST /verify` does **not** check the payer signature (unsigned and wrong-key payloads
 * both return `isValid: true`), so it is worthless as a gate and settle is the only truth.
 * And a signed payload is valid for only ~120 seconds, so sign and settle inside one
 * action.
 */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  /** Hedera references HTS assets by native id. `0.0.0` is HBAR. */
  asset: string;
  /** Amount in the asset's smallest unit, as a decimal string. v2 calls this `amount`. */
  amount: string;
  /** Native id `0.0.x` of the receiving account. */
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

/**
 * The `resource` sibling of `accepted` on a `PaymentRequired`. These three fields used to
 * be written into the requirements themselves; in 2.24.0 they are their own object.
 */
export interface ResourceInfo {
  resource: string;
  description: string;
  mimeType: string;
}

export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: { feePayer?: string } & Record<string, unknown>;
}

export interface SupportedResponse {
  kinds: SupportedKind[];
}

export interface VerifyResult {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleResult {
  success: boolean;
  errorReason?: string;
  transaction?: string;
  network?: string;
  payer?: string;
}

export interface X402ClientOptions {
  facilitatorUrl: string;
  /** Cache life for `GET /supported`, seconds. */
  supportedTtlSeconds: number;
  network: string;
  scheme: string;
  payTo: string;
  assetMode: 'hbar' | 'hts';
  htsAssetId: string | undefined;
  /** Smallest-unit exponent of the settlement asset. HBAR is 8 (tinybars). */
  assetDecimals: number;
  /**
   * Parts-per-million scale applied to the settled amount, so a testnet account can
   * actually pay a six-figure receivable. `1_000_000` means settle the full amount.
   */
  settlementScalePpm: number;
  timeoutMs?: number;
  logger?: Logger;
}

/** HBAR as an x402 asset reference on Hedera. */
export const HBAR_ASSET = '0.0.0';

/** Tinybars. */
export const HBAR_DECIMALS = 8;

/**
 * Converts an invoice amount into the settlement asset's smallest unit.
 *
 * Two conversions, kept separate on purpose because only one of them is arithmetic.
 *
 * The first is a real decimals change: invoice money is minor units of its currency (2 for
 * USD and EUR) and the asset has its own exponent (8 for HBAR, 6 for USDC). That part is
 * exact and stays in `bigint`.
 *
 * The second is a **declared convention, not a market rate**. One unit of invoice currency
 * is settled as one unit of the settlement asset. There is no FX here and none is implied;
 * a real deployment prices the cash leg against an actual rate. `scalePpm` then shrinks the
 * result so a testnet balance can cover it. Both are surfaced in the challenge description
 * so a reader of the proof view sees the convention rather than inferring a rate that was
 * never quoted.
 *
 * Before this existed the amount was the invoice's minor units passed through unchanged,
 * which silently read as tinybars — the same digits meaning a different thing by accident.
 */
export const toSettlementAmount = (
  amountMinor: bigint,
  currencyDecimals: number,
  assetDecimals: number,
  scalePpm: number,
): bigint => {
  /*
   * Shift first, scale second. The other order truncates: scaling 5,933,178 minor units by
   * 1 ppm gives 5 before the decimals shift ever runs, so $59,331.78 settles as 0.05 rather
   * than 0.0593 — a rounding error of the same order as the amount itself.
   */
  const shift = assetDecimals - currencyDecimals;
  const shifted =
    shift >= 0 ? amountMinor * 10n ** BigInt(shift) : amountMinor / 10n ** BigInt(-shift);
  return (shifted * BigInt(scalePpm)) / 1_000_000n;
};

/**
 * Defaults for the (scheme, network) pair we settle on. `GET /supported` is the authority
 * — `feePayer()` fails loudly if the facilitator does not advertise this pair, which is
 * the check that matters. Schemes register per network, so registering Circle's
 * Nanopayments alongside Hedera's would let one service offer both rails.
 */
export const DEFAULT_SCHEME = 'exact';
/**
 * CAIP-2 style, with a **colon** — not `hedera-testnet`.
 *
 * Verified against the live facilitator: `GET /supported` advertises `hedera:testnet`, and
 * the kind lookup is an exact string match, so a hyphen produces
 * `No supported kind for scheme=exact network=hedera-testnet` at settle time — after the
 * ATS hold has already been placed. That ordering is what makes the typo expensive: the
 * asset leg is armed and must then be unwound.
 */
export const DEFAULT_NETWORK = 'hedera:testnet';

export class X402Client {
  readonly #opts: X402ClientOptions;
  readonly #log: Logger;
  readonly #timeoutMs: number;
  #supported: { value: SupportedResponse; expiresAt: number } | undefined;
  #inFlight: Promise<SupportedResponse> | undefined;

  constructor(opts: X402ClientOptions) {
    this.#opts = opts;
    this.#log = (opts.logger ?? rootLogger).child({ svc: 'x402' });
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /** The asset this deployment settles in. HBAR unless HTS is explicitly enabled. */
  get asset(): string {
    if (this.#opts.assetMode === 'hbar') return HBAR_ASSET;
    if (!this.#opts.htsAssetId) {
      throw new Error('X402_ASSET_MODE=hts requires X402_HTS_ASSET_ID.');
    }
    return this.#opts.htsAssetId;
  }

  /**
   * `GET /supported`, cached for `supportedTtlSeconds`. Concurrent callers share one
   * request so a burst of quotes does not become a burst of facilitator round-trips.
   */
  async supported(): Promise<SupportedResponse> {
    const now = Date.now();
    if (this.#supported && this.#supported.expiresAt > now) return this.#supported.value;
    if (this.#inFlight) return this.#inFlight;

    this.#inFlight = this.#fetchSupported()
      .then((value) => {
        this.#supported = { value, expiresAt: Date.now() + this.#opts.supportedTtlSeconds * 1000 };
        return value;
      })
      .finally(() => {
        this.#inFlight = undefined;
      });

    return this.#inFlight;
  }

  async #fetchSupported(): Promise<SupportedResponse> {
    const body = await this.#request<SupportedResponse>('GET', '/supported');
    this.#log.debug('facilitator kinds', { count: body.kinds.length });
    return body;
  }

  /**
   * The fee payer for our (scheme, network). Runtime-resolved, never hardcoded.
   * Goes into `PaymentRequirements.extra` so the payer signs against the right account.
   */
  async feePayer(): Promise<string> {
    const { kinds } = await this.supported();
    const kind = kinds.find(
      (k) => k.scheme === this.#opts.scheme && k.network === this.#opts.network,
    );
    if (!kind) {
      throw upstreamUnavailable(
        'x402 facilitator',
        `No supported kind for scheme=${this.#opts.scheme} network=${this.#opts.network}.`,
      );
    }
    const feePayer = kind.extra?.feePayer;
    if (typeof feePayer !== 'string' || feePayer.length === 0) {
      throw upstreamUnavailable(
        'x402 facilitator',
        'Supported kind carries no extra.feePayer; cannot build payment requirements.',
      );
    }
    return feePayer;
  }

  /**
   * Invoice money in the settlement asset's smallest units, under this client's own
   * decimals and scale.
   *
   * Exposed because the cash leg is not the only thing that has to name an amount in the
   * settlement asset — the maturity payout is denominated the same way, and a caller that
   * reached for the environment variables instead would be a second definition of the
   * convention. Two legs of one receivable disagreeing about what a unit of its currency
   * settles as is not a difference anyone would notice until money moved.
   */
  settlementAmount(amountMinor: bigint, currencyDecimals: number): bigint {
    return toSettlementAmount(
      amountMinor,
      currencyDecimals,
      this.#opts.assetDecimals,
      this.#opts.settlementScalePpm,
    );
  }

  /**
   * Builds the 402 challenge for one trade's cash leg.
   *
   * Returns the requirements and the resource description separately, because in
   * `@x402/core` 2.24.0 they are siblings on `PaymentRequired` rather than one flat object.
   */
  async buildRequirements(input: {
    amountMinor: bigint;
    currencyDecimals: number;
    resource: string;
    description: string;
    maxTimeoutSeconds?: number;
  }): Promise<{ accepted: PaymentRequirements; resource: ResourceInfo }> {
    const feePayer = await this.feePayer();
    const amount = toSettlementAmount(
      input.amountMinor,
      input.currencyDecimals,
      this.#opts.assetDecimals,
      this.#opts.settlementScalePpm,
    );
    return {
      accepted: {
        scheme: this.#opts.scheme,
        network: this.#opts.network,
        asset: this.asset,
        amount: amount.toString(),
        payTo: this.#opts.payTo,
        maxTimeoutSeconds: input.maxTimeoutSeconds ?? 120,
        extra: { feePayer },
      },
      resource: {
        resource: input.resource,
        description: input.description,
        mimeType: 'application/json',
      },
    };
  }

  /** `POST /verify` — is the signature good for these requirements? No state change. */
  async verify(paymentPayload: unknown, requirements: PaymentRequirements): Promise<VerifyResult> {
    return this.#request<VerifyResult>('POST', '/verify', {
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements: requirements,
    });
  }

  /** `POST /settle` — submits the cash leg. This is the money-moving call. */
  async settle(paymentPayload: unknown, requirements: PaymentRequirements): Promise<SettleResult> {
    return this.#request<SettleResult>('POST', '/settle', {
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements: requirements,
    });
  }

  async #request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.#opts.facilitatorUrl.replace(/\/$/, '')}${path}`;
    const signal = AbortSignal.timeout(this.#timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        signal,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw upstreamUnavailable(
        'x402 facilitator',
        `${method} ${path} did not complete: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw upstreamUnavailable(
        'x402 facilitator',
        `${method} ${path} returned ${res.status}. ${text.slice(0, 300)}`,
      );
    }

    return (await res.json()) as T;
  }
}

/**
 * Signing the buyer's side of the cash leg.
 *
 * **This backend never signs.** It is the resource server: it issues the challenge and
 * hands the facilitator what comes back. The payment is signed by whoever holds the
 * buyer's key — a wallet, or the agent package — with `@x402/fetch`
 * (`wrapFetchWithPayment`) and the `@x402/hedera` scheme registration, both pinned to
 * 2.24.0. A venue that could sign a buyer's payment would be a venue that could spend a
 * buyer's money.
 *
 * The interface is kept here because the signed payload's shape is this module's
 * vocabulary, and because schemes register per network: registering Hedera's alongside
 * Circle's Nanopayments is what would let one service offer both rails and let the payer
 * choose which chain they settle on.
 */
export interface PaymentSigner {
  sign(requirements: PaymentRequirements): Promise<unknown>;
}

let client: X402Client | undefined;

export function initX402Client(opts: X402ClientOptions): X402Client {
  client = new X402Client(opts);
  return client;
}

export function getX402Client(): X402Client {
  if (!client) throw new Error('x402 client accessed before initX402Client().');
  return client;
}
