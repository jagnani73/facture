/**
 * Asset Tokenization Studio constants.
 *
 * `deployBond` enforces two modifiers that reject anything ad hoc: `onlyValidISIN` (see
 * `src/isin`) and `onlyValidRegulation`. Only three regulation combinations are accepted,
 * and they are enumerated here so no caller writes a bare number into a factory call.
 */

/** The three regulation combinations ATS accepts. */
export const REGULATION_KEYS = ['REG_D_506_B', 'REG_D_506_C', 'REG_S'] as const;

export type RegulationKey = (typeof REGULATION_KEYS)[number];

export interface Regulation {
  readonly key: RegulationKey;
  /** For UI and for refusal sentences. */
  readonly label: string;
  /**
   * ATS `RegulationType` enum value.
   *
   * NOTE: these numeric values must be checked against the deployed factory ABI before the
   * first real `deployBond`. They follow the ATS enum as published (NONE=0, REG_S=1,
   * REG_D=2 / subtype NONE=0, 506_B=1, 506_C=2), but a factory upgrade could reorder them
   * and the failure mode is a silently mis-registered security, not a revert.
   */
  readonly regulationType: number;
  /** ATS `RegulationSubType` enum value. `REG_S` has no subtype. */
  readonly regulationSubType: number;
  readonly accreditedInvestorsOnly: boolean;
  readonly generalSolicitationAllowed: boolean;
  /** Whether the offering is restricted to buyers outside the United States. */
  readonly offshoreOnly: boolean;
}

export const REGULATIONS: Readonly<Record<RegulationKey, Regulation>> = {
  /** Private placement, no general solicitation, accredited (plus limited non-accredited). */
  REG_D_506_B: {
    key: 'REG_D_506_B',
    label: 'Reg D 506(b)',
    regulationType: 2,
    regulationSubType: 1,
    accreditedInvestorsOnly: true,
    generalSolicitationAllowed: false,
    offshoreOnly: false,
  },
  /** Private placement with general solicitation; every buyer must be verified accredited. */
  REG_D_506_C: {
    key: 'REG_D_506_C',
    label: 'Reg D 506(c)',
    regulationType: 2,
    regulationSubType: 2,
    accreditedInvestorsOnly: true,
    generalSolicitationAllowed: true,
    offshoreOnly: false,
  },
  /** Offshore offering; no US buyers. */
  REG_S: {
    key: 'REG_S',
    label: 'Reg S',
    regulationType: 1,
    regulationSubType: 0,
    accreditedInvestorsOnly: false,
    generalSolicitationAllowed: true,
    offshoreOnly: true,
  },
} as const;

export const isRegulationKey = (v: unknown): v is RegulationKey =>
  typeof v === 'string' && (REGULATION_KEYS as readonly string[]).includes(v);

/**
 * Default for paper issued in this build.
 *
 * 506(c) rather than 506(b): the book is publicly visible, which is general solicitation,
 * and 506(b) does not permit it. The cost is that every buyer must be verified accredited
 * before matching — which is exactly the `Kyc` facet check that already gates a match.
 */
export const DEFAULT_REGULATION: RegulationKey = 'REG_D_506_C';

/**
 * ATS constraints that shape calling code. Kept here so they are visible at the call site
 * rather than only in the repo's CLAUDE.md.
 */
export const ATS_CONSTRAINTS = {
  /**
   * One `deployBond` per invoice. Partitions cannot carry distinct instruments — maturity,
   * currency and nominal are set once per security and `initializeMaturity` reverts on a
   * second call — so ten invoices are ten deployments, not ten partitions.
   */
  oneBondPerInvoice: true,
  /** No batch issuance. `batchMint` spreads one security across holders, not many securities. */
  batchIssuanceSupported: false,
  /** Measured cost of `Factory.deployBond` in the repo's default configuration. */
  deployBondGas: 6_978_091,
  /** Heaviest configuration measured. Still 54% of Hedera's 15M per-transaction ceiling. */
  deployBondGasWorstCase: 8_158_081,
  /** What the ATS deploy scripts ship for this call on both Hedera networks. */
  deployBondGasLimit: 10_000_000,
  /** Hedera's per-transaction gas ceiling. */
  hederaTransactionGasCeiling: 15_000_000,
  /**
   * Compliance lives on each security's own diamond. `identityRegistry` and `compliance`
   * stay at `address(0)` — the ERC-3643 registry interface is `isVerified(address)` with no
   * token parameter, so one registry across many securities is a single global allowlist.
   */
  useControlListAndKyc: true,
  /** Zero-coupon by construction. `deployBond` initialises `rate: 0` and we leave it there. */
  couponRate: 0,
} as const;
