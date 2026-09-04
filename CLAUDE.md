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

**This decision is contingent and unverified.** A single `deployBond` fans out into roughly 96
internal facet-initialisation calls inside one transaction, against Hedera's 15M per-transaction
gas ceiling. Measure this before building anything on top of it. If it does not fit, the fallback
is a pooled facility and the product argument has to be rewritten — do not discover this in week
two.

---

## Day-one blockers

Resolve all four before feature work. Each can invalidate part of the architecture.

1. **Deploy one ATS bond on Hedera testnet and measure gas + wall clock.** Decides whether the
   per-invoice model survives (see above).
2. **Ask Circle in Discord whether a fresh project qualifies for the Launch on Mainnet track.**
   Arc mainnet goes live Sept 16, three days after submissions close, so the track has to mean
   "mainnet-ready, deployed by Sept 30". One question, $5,000.
3. **Confirm the Blocky402 testnet facilitator settles the chosen token.** The reference PoC notes
   that the x402.org testnet facilitator may not handle HBAR and recommends Blocky402's endpoint
   for it specifically.
4. **Provision ECDSA keys everywhere.** Not optional, see below.

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
