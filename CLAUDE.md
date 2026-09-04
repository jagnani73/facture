# Facture — working instructions

Market for tokenised receivables. Buyers post standing quotes over risk buckets; any invoice is
priced off the resulting yield curve the moment it appears. Paper lives on Hedera as ATS
zero-coupon bonds, cash lives on Arc as USDC, and the two settle against each other without a
bridge.

Built for ETHOnline 2026 (Sept 4–16). **Classic / from-scratch track** — no pre-existing
project-specific code may enter this repo, and version control history has to show the work. See
[README.md](./README.md) for the product argument.

---

## Architecture decision

**One ATS zero-coupon bond per invoice. Heterogeneous paper, not a pooled facility.**

Each receivable is its own `deployBond` — maturity is the invoice due date, principal is the face
value, rate stays at the `0` it initialises to. The whole thesis depends on the assets staying
unique: the interesting claim is that you standardise the _bid_ rather than the paper, and pooling
invoices into one facility makes the assets fungible instead, which collapses the idea into
ordinary securitisation.

**This decision was contingent. It is now confirmed (2026-09-01) and the contingency is closed.**

Measured from the deployed ATS factory's own history rather than by spending: `0.0.9213391` has
27 `deployBond` calls on the mirror node, 24 successful with charged fees.

- Real Hedera `gasUsed`: **6,956,443 – 7,310,717, median 6,976,378**. `gas_used` equals
  `gas_consumed` on every call.
- That is **~47% of the 15M per-transaction ceiling**; fifteen of those calls ran at a full 15M
  limit. The facet count would have to roughly double before the ceiling binds.
- Cost is **7.28 – 8.85 HBAR per issuance**.
- The local-Hardhat figure of 6,978,091 lands within 0.02% of the live median, so it was an
  accurate Hedera predictor after all.

The pooled-facility fallback is not needed. Heterogeneous per-invoice paper stands.

---

## Day-one blockers — ALL RESOLVED 2026-09-01

Kept for the record; none of these gate feature work any more. Full evidence lives outside the
repo in `facture-prep/BLOCKERS.md`.

1. **Gas / per-invoice model.** Resolved — see the architecture decision above. No transaction
   needed; the answer was already in the deployed factory's history.
2. **Arc "Launch on Mainnet" track eligibility.** Still open, but it is a prize question, not an
   architectural one. The Continuity-only badge is _absent_ from that track, yet its copy reads
   "Take a project you own — an existing MVP, open source repo, or live product", which a
   from-scratch entrant cannot satisfy. Genuinely ambiguous; ask Circle before counting the $5,000.
3. **Blocky402 facilitator.** `GET /supported` returns 200 and advertises `hedera:testnet` under
   x402 v2, scheme `exact`. Fee payer `0.0.7162784` is ECDSA and holds ~290,667 HBAR, so funding
   is not the risk. Read `extra.feePayer` at runtime, never hardcode it. **It remains a single
   point of failure**: `github.com/blockydevs/blocky402` is a 404, so it cannot be self-hosted.
4. **ECDSA keys.** Resolved. Operator `0.0.10311549`, 1000 HBAR, `ECDSA_SECP256K1` confirmed on
   the ledger rather than merely in the portal UI. Second party `0.0.10314099`, 10 HBAR, hollow
   until its first fee payment.

### Corrections to earlier assumptions

- **There is no 20% gas refund cap on this path.** `charged_tx_fee / gas_used` is an exact
  integer on all 24 calls (104–126 tinybar/gas), tracks the HBAR price, and is independent of the
  gas limit. Two calls 28 minutes apart with limits of 7,477,718 and 15,000,000 and near-identical
  gas used were both charged exactly 105 tinybar/gas. **So "set gasLimit 9M not 15M" is not
  justified on cost** — a generous limit is free and avoids out-of-gas.
- **Throttling is still open.** Hedera throttles on network gas throughput, and whether that
  budget is charged against the gas _limit_ or gas _used_ is untested. Issuance pacing stays a
  real design concern; it just is not a cost concern.
- **The faucet gives 10 HBAR/day anonymously, not 100.** The 100/day figure in the docs is the
  signed-in rate. A portal account is needed for a pre-issued book.

---

## Hard constraints

Researched, not assumed. Violating these costs days.

### Asset Tokenization Studio

- **Partitions cannot carry distinct instruments.** Maturity date, currency and nominal value are
  set once per security, and `initializeMaturity` reverts on a second call. Ten invoices cannot be
  ten partitions of one bond. The `…ByPartition` facets are lockup/tranche/clearing segmentation of
  the _same_ instrument.
- **No batch issuance.** The `batchMint` / `batchTransfer` / mass-payout facets operate on many
  holders of one security. Ten invoices means ten separate `deployBond` transactions.
- **Every deployment needs a checksum-valid ISIN** (`onlyValidISIN`) **and a declared SEC
  regulation type** (`onlyValidRegulation` — Reg D 506(b)/506(c) or Reg S). Generate valid fake
  ISINs ahead of time; arbitrary strings are rejected.
- **Regulation enum values, verified against the deployed factory (v6.0.0 text at
  `0.0.9213391`):** `RegulationType { NONE, REG_S, REG_D }` = 0,1,2 and
  `RegulationSubType { NONE, REG_D_506_B, REG_D_506_C }` = 0,1,2. So Reg D 506(b) = `2/1`,
  506(c) = `2/2`, Reg S = `1/0`.
- **The regulation block is disclosure metadata, not enforcement.** `regulation.sol` defines only
  `build*` constructors plus `checkRegulationTypeAndSubType`; there is no check or enforce
  function for resale hold, accreditation or international investors, and `resaleHoldPeriod`
  appears nowhere in contract logic. Eligibility is enforced by `ControlList` and `Kyc`, as
  already decided below. None of it can revert a trade.
- **Open: Reg S is probably the right declaration, not 506(c).** Per the deployed contract, Reg S
  is the only one allowing international investors AND the only one without a 6mo–1yr resale
  hold. Reg D declares a hold that contradicts a holder relisting on day 30, and bars the
  international buyers the cross-chain argument depends on. The accreditation rationale for
  506(c) does not survive contact with the source: all three are `ACCREDITATION_REQUIRED`.
  Scope Reg S geographically with `AdditionalSecurityData.listOfCountries`. Reversible until the
  first instrument is issued; changes the refusal copy.
- **`Loan`, `BondFixedRate` and `BondKpiLinkedRate` are not deployable.** They exist in the
  `SecurityType` enum with some backing domain data, but the shipped factory exposes only
  `deployBond` (always `BondVariableRate`), `deployEquity` and `deployDepositToken`. Ignore any
  doc or blog that implies otherwise.
- **Do not lean on coupon scheduling.** There is a checked-in internal note about a recent
  regression in the scheduled-task / coupon-listing path. We are zero-coupon anyway; keep it that
  way.
- **Use `ControlList` and `Kyc`, not the ERC-3643 `IdentityRegistry`.** The registry interface is
  `isVerified(address)` with no token parameter, so many securities pointing at one registry share
  a single global allowlist, and per-invoice cohorts would need a registry deployment each.
  `ControlList` and `Kyc` live on each security's own diamond, need zero extra deployments, and
  are already scoped per-instrument. Leave `identityRegistry` and `compliance` at `address(0)`.
- Issuance is heavy and slow. **Pre-issue the book; issue exactly one invoice live** to prove the
  path. Demo time goes to the light operations — transfers, holds, KYC grants, redemption.

### Hedera

- **ECDSA keys for anything touching the EVM.** ED25519 accounts hold HBAR and HTS fine but cannot
  sign EVM transactions, cannot drive the Agent Kit's EVM tools, and cannot run Harness Tier 3.5
  on-chain validation. Failures surface late as `INVALID_SIGNATURE`.
- **Every HTS token requires explicit association by the receiver** before it can be received —
  including USDC on Hedera and any ATS security token. This broke the reference x402 PoC until a
  manual associate step was added.
- **8 vs 18 decimals.** The native ledger uses 8 for HBAR (tinybars); the JSON-RPC relay scales to
  18 to match Ethereum tooling. Never mix native-SDK HBAR math with EVM `msg.value` math in one
  calculation.
- **Scheduled Transactions are one-shot**, not a streaming primitive. `ScheduleCreateTransaction`
  schedules exactly one transaction pending signatures or expiry. Recurring behaviour is
  app-layer, or via the Hedera Schedule Service system contract at `0x16b`. There is no
  Superfluid-style continuous stream. One-shot maturity settlement is a correct use; "streaming"
  is not.
- Prefer **native services over generic Solidity** — HTS, HCS, Schedule Service, Mirror Node. Every
  Hedera prize winner across recent ETHGlobal events leaned this way, including winners of tracks
  that did not require it.
- Accounts and contracts have both a native ID (`0.0.x`) and an EVM address (`0x…`); different APIs
  want different forms. x402 `PaymentRequirements` reference HTS assets by `0.0.x`.

### Arc

- **Testnet only.** Chain ID `5042002`, RPC `https://rpc.testnet.arc.io`, explorer
  `https://testnet.arcscan.app`, faucet `https://faucet.circle.com`. Public mainnet lands Sept 16,
  after submissions close — nothing may depend on it.
- **Skip StableFX.** It is KYB/AML-gated and not self-serve. EURC is on Arc testnet, so App Kit's
  swap covers any FX demo without the gated product.
- **Skip Paymaster.** Gas on Arc is already natively USDC, so it is redundant there.
- **`maxFeePerGas` below 20 Gwei fails** as "transaction underpriced". Set at least 20.
- **USDC decimals.** Native gas accounting is 18 decimals, the ERC-20 interface is 6, same
  underlying balance. Use the ERC-20 interface for all balance and transfer logic.
- Wire up the Arc MCP server so docs in context stay current:
  `claude mcp add --transport http arc-docs https://docs.arc.io/mcp`

### x402

Hedera's scheme and Circle's Nanopayments are both x402 payment schemes, and the client registers
schemes per network — so one service can offer both rails and let the payer choose. Pin exact
`@x402/*` versions early: header naming shifted between spec versions
(`PAYMENT-REQUIRED`/`PAYMENT-SIGNATURE`/`PAYMENT-RESPONSE` in v2 vs older `X-PAYMENT`), and blog
examples do not all agree with shipped packages.

---

## Cut list

Ordered by what leaves the product most intact, not by which track is cheapest to lose. A prize is
downstream of the product being right; it is never a reason to ship less of one.

1. **The x402 paid pricing feed.** Barely a cut. Once mandates set the price, a metered price feed is
   a leftover from an earlier design and is not part of this product. Note this is only the _data_
   use of x402 — x402 as the settlement leg stays, and is load-bearing.
2. **Autonomous operation of mandates.** The product needs mandates that are funded. Whether an agent
   or a person operates one is incidental to whether it works.
3. **Live issuance during the demo.** Staging, not product. Tokenisation happens at onboarding
   either way.
4. **Partial position sales.** The first cut that genuinely costs the product: an all-or-nothing exit
   is a worse instrument, and a worse instrument prices wider on day zero.

### Never cut

> List → instant quote from a standing bid → compliance-checked match → DvP settle → maturity pays
> the current holder.

If a change threatens that path, it is the change that goes.

---

## Conventions

- pnpm workspace. Keep packages small and separable so cut-list items detach cleanly.
- Verify with `pnpm lint` and `tsc --noEmit` rather than full builds during development.
- Real commit history matters here — ETHGlobal disqualifies single-commit repos and large
  unexplained drops. Commit incrementally throughout.
- AI tool usage must be documented in the submission: which parts, which files. Keep spec and
  planning artifacts in-repo if any spec-driven workflow is used.
- Update this file whenever an architectural decision changes, especially the contingent one at the
  top.
