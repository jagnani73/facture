/**
 * x402 — read here as a *settlement* protocol rather than an API paywall.
 *
 * The 402 challenge holds the asset leg, the payment signature is the cash leg, and the
 * facilitator is what makes the two simultaneous. Nothing is wrapped and nothing crosses a
 * bridge.
 */

export interface X402Config {
  readonly facilitatorUrl: string;
  /**
   * `GET {facilitatorUrl}{supportedPath}` — the authoritative list of schemes, networks and
   * per-network `extra` the facilitator will settle.
   */
  readonly supportedPath: string;
  readonly settlePath: string;
  readonly verifyPath: string;
  /** x402 protocol version pinned for this build. */
  readonly version: number;
}

/**
 * Blocky402's testnet facilitator, chosen over the x402.org one because the reference PoC
 * notes the latter may not settle HBAR.
 */
export const X402_TESTNET: X402Config = {
  facilitatorUrl: 'https://api.testnet.blocky402.com',
  supportedPath: '/supported',
  settlePath: '/settle',
  verifyPath: '/verify',
  version: 2,
};

/**
 * NEVER HARDCODE `extra.feePayer`.
 *
 * The fee payer is a facilitator-side account that can rotate. It must be read at runtime
 * from `GET /supported` for the exact scheme/network pair being used, and copied into the
 * `PaymentRequirements.extra` of the challenge. A stale value produces a settlement that
 * verifies locally and then fails at the facilitator.
 */
export const X402_FEE_PAYER_SOURCE = 'GET /supported -> kinds[].extra.feePayer' as const;

/**
 * Header names as of x402 v2. They changed between spec versions — older material uses
 * `X-PAYMENT` — so pin the `@x402/*` package versions and read these rather than typing
 * header strings at call sites.
 */
export const X402_HEADERS = {
  paymentRequired: 'PAYMENT-REQUIRED',
  paymentSignature: 'PAYMENT-SIGNATURE',
  paymentResponse: 'PAYMENT-RESPONSE',
} as const;

/**
 * Scheme identifiers. Hedera's scheme and Circle's Nanopayments are both x402 schemes and
 * the client registers schemes per network, so one service can offer both rails and let the
 * payer choose which chain they settle on.
 */
export const X402_SCHEMES = {
  exact: 'exact',
} as const;
