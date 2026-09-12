import type { Address } from 'viem';

/**
 * What Facture has deployed, and where.
 *
 * ## Why this is a pin and not configuration
 *
 * Every address here used to live in **two** env files under **two** names —
 * `FACTURE_MANDATE_BOOK` in `packages/contracts/.env` and `HEDERA_MANDATE_BOOK_ADDRESS` in
 * `packages/backend/.env`, and so on for five contracts. They held identical values, but
 * nothing checked that they did: a redeploy updates the contracts side and the backend's
 * copy is a manual paste that can simply be forgotten.
 *
 * The failure that shape produces is not a crash. The venue keeps running and reads the
 * *previous* deployment — which is a live scenario here, because the superseded
 * `AtsComplianceGate` at `0x6d78847e`'s predecessor is still deployed and still verified on
 * purpose, and it refused every buyer on every instrument. A stale address would read as a
 * compliance bug rather than as a configuration one, which is the most expensive kind of
 * wrong answer this codebase can give.
 *
 * So the addresses are committed, in one place, beside the chain constants that are already
 * pinned for exactly this reason — `chains/index.ts` has said since it was written that
 * nothing outside that directory should carry a chain id, an RPC URL or a token address as
 * a literal. A deployed contract is the same kind of fact.
 *
 * ## What this is NOT
 *
 * It is not a substitute for `packages/contracts/.env`. Those `FACTURE_*` variables mean
 * something different: **"reuse this one instead of deploying a new one"**, an input to a
 * deploy-time decision, where unset means *deploy fresh*. That semantic cannot be expressed
 * by a pin and is not duplicated here. After a deploy that mints a new address, update this
 * file — `deployHedera.ts` prints what it resolved for precisely that purpose.
 *
 * Full provenance for every address, including transaction ids and the reasoning behind
 * each deployment, is in `docs/deployments.md`.
 */

/** Hedera testnet. The paper, the book, and the registries that make its refusals checkable. */
export const HEDERA_DEPLOYMENTS = {
  /**
   * One receivable, one instrument. Checked before an invoice is listed and claimed after
   * its instrument exists. Deliberately outlives a book upgrade: it is never redeployed
   * alongside one, because abandoning its claims would make the guarantee worthless.
   */
  uniquenessRegistry: '0x8eb9f00126Bca50226e47B71a75F7B438E81D408' as Address,

  /**
   * The debtor's confirmation as a public view, which is what justifies advancing full face
   * value with no holdback. Also where `MandateBook` reads rating, tenor and face value
   * from, rather than from whoever wants the match to succeed.
   */
  invoiceRegistry: '0x44fe6E29aaDe69085CE53c4694b99EFe4639B7a7' as Address,

  /**
   * The corrected gate, deployed 2026-09-06. Its predecessor probed three ATS selectors that
   * do not exist and refused every buyer on every instrument; that one is still live and
   * still verified so an address found in an old note stays identifiable.
   */
  complianceGate: '0x6D78847E4AC257dA68909c5A4C60Ea1dCc060564' as Address,

  /** Standing bids on chain. `previewMatch` is the one verdict the venue cannot have arranged. */
  mandateBook: '0x361f9D4B1101898417b2b9148bC8aA522024A38f' as Address,

  /**
   * Deployed and deliberately unreached — see "Declined: the Hedera delivery escrow" in
   * CLAUDE.md. It is `MandateBook.confirmSettlement`'s evidence source, and the ATS hold
   * already gives four of its five properties without the paper leaving the holder's ledger
   * entry. Pinned so that a redeployed book can bind to it rather than orphan it.
   */
  deliveryEscrow: '0x35a8A43d2D840f02887cd0427e78F6B0205ded87' as Address,

  /**
   * What each address says about itself, signed by that address. Deployed 2026-09-12.
   *
   * The only contract here a party writes to directly rather than the venue writing on their
   * behalf, and that is its whole point: `MandateBook.postMandate` records `buyer = msg.sender`,
   * so every standing bid on the public book belongs to the venue. A profile cannot, because the
   * registry writes whoever the EIP-712 signature recovers to and the venue only relays.
   *
   * It has no owner and nothing takes it as a constructor argument, so unlike
   * {@link HEDERA_DEPLOYMENTS.uniquenessRegistry} it can be redeployed alone. A fresh one costs
   * each party one re-signature rather than abandoning a guarantee — but it does invalidate every
   * signature in flight, because the EIP-712 domain binds to this address.
   */
  partyRegistry: '0x1C9882714e1ae2555531E1a7eb4E83EBeCA8B2ca' as Address,
} as const;

/** Arc testnet. Where mandate capital is escrowed and the cash leg settles. */
export const ARC_DEPLOYMENTS = {
  /**
   * Buyer capital, keyed by `uint256(keccak256(mandateUuid))`. The book mints its own ids
   * and cannot read Arc, so the two are joined by `mandates.chain_mandate_id` and nowhere
   * else — see `services/arc.ts`.
   */
  mandateVault: '0x217256d0FDF83ffd81bbC6884Ad44f5C02501102' as Address,
} as const;
