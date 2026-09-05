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

**This decision was contingent. It is now confirmed (2026-09-01), twice over, and the
contingency is closed.**

**Facture has issued a real bond.** `0.0.10316440` /
`0x9cb3468607a359c214cb27159d5d5853d5e83877`, tx
`0xbe1c381a87d6ebf9936b2a3436fc2da1cd4d93e45d91e50265a64759a91076be`, Reg S, allowlist on.
`gasUsed` **7,016,307** — 46.8% of the 15M ceiling — charged **7.928427 HBAR** at exactly
113.000 tinybar/gas. That lands inside the range predicted from history below, so the
archaeology was sound.

It was also measured from the deployed factory's own history without spending: `0.0.9213391` has
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
  integer on all 24 historical calls (104–126 tinybar/gas), tracks the HBAR price, and is
  independent of the gas limit. Two calls 28 minutes apart with limits of 7,477,718 and
  15,000,000 and near-identical gas used were both charged exactly 105 tinybar/gas.
- **BUT a generous gas limit is NOT free.** Hedera reserves `gasLimit x gasPrice` against the
  balance _up front_, and only _charges_ `gasUsed x gasPrice`. Discovered the hard way on
  2026-09-01: a send at gasLimit 9,000,000 with a 20%-padded price bid was refused for
  insufficient funds on an account holding 9.997 HBAR, because it reserved 12.85 HBAR — against
  a real fee of 7.93. So the rule is: **fees follow gas used, solvency follows the gas limit.**
  Pad the limit for safety, not the price, and size the operator balance against
  `gasLimit x gasPrice`, not against the expected fee.
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

### ATS integration facts — established against a live security, not documentation

Every item below cost a failed call to find. The deployed bond is `0.0.10316440`.

- **The compliance read surface is not what it looks like.** `isAuthorized`,
  `getKycAccountStatus` and `isPaused` **do not exist** and revert with
  `FunctionNotFound(bytes4)` = `0x5416eb98`. The real functions are
  `getControlListType()`, `isInControlList(address)`, `getKycStatusFor(address)` and
  `paused()`.
- **Membership alone does not decide eligibility.** `getControlListType()` returns `true`
  for an allowlist and `false` for a blocklist, and the same list means the opposite thing
  in each case. Reading only `isInControlList` inverts the answer on a blocklist instrument
  and admits exactly the party it was configured to exclude.
- **`getKycStatusFor` returns an enum, not a bool** — `KycStatus { NOT_GRANTED, GRANTED }`,
  so compare against `1`.
- **The ATS README's role hashes are wrong for the deployed contracts.** It lists
  `_CONTROL_LIST_ROLE = 0xca537e1c…`; `constants/roles.sol` defines
  `ROLE_CONTROL_LIST = 0x6ed9a91e…`. Two parallel naming schemes with different hashes.
  Granting the README's constant **succeeds and authorises nothing**. Always take role
  hashes from `contracts/constants/roles.sol`.
- **`clearingActive: true` blocks direct holds** with `ClearingIsActivated()` = `0x5b2e3086`.
  Deploy with it off, or grant `ROLE_CLEARING` and call `deactivateClearing()`.
- **Granting KYC needs a registered issuer.** `grantKyc` reverts with
  `AccountIsNotIssuer(address)` = `0xcd324f53` until the issuer is added via `addIssuer`,
  which needs `ROLE_SSI_MANAGER`.
- **A deployed bond has no supply.** `deployBond` creates the security; `issue(to, amount,
data)` mints, and costs ~465k gas. Holder and receiver must both be allowlisted and KYC'd.
- **`createHoldByPartition` acts on the caller's own tokens.** The venue cannot hold a
  seller's paper unless it is the holder or an authorised ERC-1400 operator.
- **An ECDSA Hedera account has two EVM addresses** — the alias, derived from the public
  key, and the long-zero form, derived from the account number. To a Solidity contract they
  are unrelated keys, so a control-list grant against one is invisible to the other.

### x402

- The facilitator's network id is **`hedera:testnet`**, CAIP-2 style with a colon. The kind
  lookup is an exact string match, and the hyphenated spelling fails **after** the ATS hold
  is placed.
- Pin `@x402/*` at **2.24.0**. Headers are `payment-required` / `payment-signature` /
  `payment-response`; there is no `X-PAYMENT` at v2.
- **Blocky402's `/verify` does not check the payer signature.** Unsigned and wrong-key
  payloads both return `isValid: true`. Settle is the only truth, and paid handlers must be
  side-effect-free because the handler runs between verify and settle.
- A signed payload is valid for ~120 seconds. Sign and settle inside one action.

### Circle agent wallets

- **Circle enforces no spending cap here, and the product must not imply it does.** Spending
  policies are mainnet-only, Arc has no mainnet identifier in Agent Wallets, and
  developer-controlled wallets have no policy engine at all — Circle's own docs say to
  enforce such controls in your application. The mandate cap is ours.
- Use `@circle-fin/developer-controlled-wallets`, not the Agent Wallets CLI.
- Circle's balance response carries the same USDC **twice** — native at 18 decimals and
  ERC-20 at 6. Select by contract address; picking wrong is a factor of a trillion.

### Resolved: one refusal vocabulary

**The contracts moved to `@facture/shared`.** Shared is frozen, it is what the backend records to
HCS, and it is what a funder reads, so it is the authority. `ReasonCodes.sol` now spells every code
that also exists off-chain exactly as shared spells it: `RATING_BELOW_MANDATE`,
`TENOR_EXCEEDS_MANDATE`, `EXPOSURE_EXHAUSTED`, `DEBTOR_CONCENTRATION` and `NOT_KYC_VERIFIED` (was
`KYC_NOT_GRANTED`), beside `MANDATE_NOT_ACTIVE` and `INVOICE_NOT_CONFIRMED`, which already matched.
The paired custom errors moved with them - `RatingBelowMandate`, `TenorExceedsMandate`,
`ExposureExhausted`, `DebtorConcentration` - so the strict path and the event path name a refusal
the same way. Codes with no off-chain counterpart (`MANDATE_UNKNOWN`, `INVOICE_UNKNOWN`,
`INVOICE_ALREADY_ALLOCATED`, `INVOICE_MATURED`, `CONTROL_LIST_BLOCKED`, `INSTRUMENT_PAUSED`,
`COMPLIANCE_PROBE_FAILED`, `NO_GATE_CONFIGURED`, `SETTLEMENT_TIMEOUT`) are venue-internal and stay
contract-side only. Changing one side without the other reintroduces the split; the reasoning is
recorded at the top of `ReasonCodes.sol`.

Two things follow. The live testnet contracts carry the old strings in their bytecode and need
redeploying. And `ON_CHAIN_REASON_CODE` in `packages/agent/src/mandate.ts` still translates to the
old names - it is now an identity map for the codes it covers, and should be retired or corrected.

### Resolved: the maturity payout rail

**A debtor has no wallet, and that is load-bearing rather than missing.** Confirmation works
because the customer is asked to acknowledge their own accounts payable through a link with one
sentence and two buttons — no wallet, no signup. Give them a key to manage and the behavioural
argument collapses. So the payout at maturity **cannot** be a transfer the debtor signs, and any
design that assumes one is wrong at the root.

The money therefore arrives the way it arrives at a factoring house: into a **collection account**
the venue operates, off-chain, by whatever rail the debtor already uses. `POST
/v1/invoices/:id/mature` makes the _obligation_ an on-chain object at the moment of maturity — a
Hedera Scheduled Transaction paying face value to the current holder — and the payment executes
against it when the money is actually there.

- **The schedule must not be drawn on the operator.** A `ScheduleCreateTransaction` executes as
  soon as its required signatures are present, and the operator signs the create. Fund the payout
  from the operator and it fires on the spot, reporting the debtor as having paid at the instant
  the receivable matured. `MATURITY_COLLECTION_ACCOUNT_ID` must be a different account;
  `services/schedule.ts` refuses the configuration rather than trusting a comment.
- **The cash leg stays `pending` even when a payout was scheduled.** A schedule is an obligation,
  not a receipt. It becomes a payment when the collection key signs, which is the venue's
  statement that the debtor's money landed — a separate act from the receivable maturing.
- **The schedule id is persisted** on the holding trade (`trades.maturity_schedule_id`, migration
  `0002`). Without it a second call creates a second schedule: two claims on one face value, and
  no way to tell which obligation the venue meant. Maturity is observable twice by design, so
  this is not hypothetical.
- **A rail that is down cannot un-mature a receivable.** The ledger write and the capital release
  happen first and a scheduling failure comes back as `payoutError`, never as a throw. A null
  `payout` with no error means no collection account is configured; those two are different facts
  and are not collapsed.
- **HBAR only, and no expiration time is set.** An HTS payout owes the holder an association step
  that does not exist yet, and long-term scheduled transactions are network-gated — the default
  schedule lifetime applies. Both are stated in `services/schedule.ts`.
- **Whether the holder was paid is asked, never remembered.** `payoutStatus` reads the schedule
  off the mirror node on every call, and both sides of the transfer come from the executed
  transaction rather than from configuration or the buyer row — a buyer's Hedera account is on
  file in either of its two forms. There is no "paid" flag this service could be wrong about.

**This has run for real (2026-09-02).** MF-2046 matured, schedule `0.0.10331573` sat unsigned, the
collection key signed it, and `0.0.10314099` was credited exactly 6,230,000 tinybars. The
collection account is `0.0.10331559`, created precisely because it must not be the operator. Full
record in [docs/deployments.md](./docs/deployments.md).

Maturity was called four times during that work, and the ledger carries one outcome, one capital
release, one rating tick and one schedule. Idempotency is not theoretical here.

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
