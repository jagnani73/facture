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

Kept for the record; none of these gate feature work any more. The working notes behind them
lived in `facture-prep/`, outside the repo, which was deleted on 2026-09-06 once nothing
depended on it. The conclusions are written out below.

1. **Gas / per-invoice model.** Resolved — see the architecture decision above. No transaction
   needed; the answer was already in the deployed factory's history.
2. **Arc "Launch on Mainnet" track eligibility. RESOLVED 2026-09-02 — Circle confirmed a
   from-scratch entrant is eligible.** The track is open to this project — **$3,500, not
   the $5,000 recorded here originally; corrected against the prizes page 2026-09-03.** Do not
   relitigate it from the page copy, which is what made it look closed: every "What We're
   Looking For" bullet describes extending a live product, and only the absent Continuity-only
   badge and a requirements clause scoping the Sept-30 mainnet bar explicitly "for the
   Continuity Track" pointed the other way. The copy is written for one kind of entrant and
   the eligibility is wider than the copy; Circle is the authority on that and has answered.

   **The Sept-30 clause is resolved, 2026-09-04, by reading the track's own requirements
   rather than reasoning about the date.** It says projects must be _"deployed **or
   deployment-ready** on Arc mainnet by September 30"_, and the track is called "Launch on Arc
   **Testnet** & Push to Mainnet". Testnet readiness is what gets judged. Arc's public mainnet
   still lands Sept 16, after submissions close, so nothing here may depend on it — that rule
   has not moved. What changed is that nothing needs to.

   The other is no longer true. **USDC has crossed (2026-09-03):** `MandateVault` holds 5 USDC
   against Harrow Point's mandate, deposited by the buyer's own wallet, and funding is verified
   against it. See [docs/deployments.md](./docs/deployments.md).

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
- **Settled: Reg S, not 506(c). No longer reversible — three instruments carry it.** Per the
  deployed contract, Reg S is the only one allowing international investors AND the only one
  without a 6mo–1yr resale hold. Reg D declares a hold that contradicts a holder relisting on
  day 30, and bars the international buyers the cross-chain argument depends on. The
  accreditation rationale for 506(c) does not survive contact with the source: all three are
  `ACCREDITATION_REQUIRED`. Reg S is scoped geographically with
  `AdditionalSecurityData.listOfCountries`, currently `AF,CU,KP,IR,SY`. The probe bond,
  MF-2051 and MF-2052 all decode to `1/0` on chain, so this is now a fact about deployed paper
  rather than a preference.
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

One thing follows: the live testnet contracts carry the old strings in their bytecode and need
redeploying.

**The note that used to stand here about `ON_CHAIN_REASON_CODE` was wrong in both halves, and
is corrected rather than deleted because the wrong version was acted on.** It claimed the map
"still translates to the old names" and was "now an identity map for the codes it covers" — a
self-contradiction, and neither part true. `78faa1a` corrected the values in the same commit
that wrote the sentence. And it is not a full identity: seven codes map to themselves, two are
`null`, and one is a real translation — `INELIGIBLE_JURISDICTION → CONTROL_LIST_BLOCKED`, which
is **correct**, since the book does not decide jurisdiction (`AtsComplianceGate` does, from the
instrument's own `ControlList`) and `ReasonCodes.sol` has no `INELIGIBLE_JURISDICTION` to be
identical to. So the map stays: deleting it would delete the record of the only three places
the two vocabularies do not line up. The seven identities are now compiler-enforced by
`OnChainSpelling`, and a test reads `ReasonCodes.sol` itself — TypeScript cannot see a Solidity
rename, which is the direction that could reopen the split.

### Resolved: issuance works, and how it did not

**Backend issuance had never once succeeded.** The `deployBond` tuple in `services/ats.ts` was
a plausible flattening of the real one — it compiled, typechecked and produced calldata — and
encoded to selector `0x58a038dd`, which the deployed diamond does not have. Every call reverted
with `FunctionNotFound(0x5416eb98)` after 45,540 gas, a status that reads like a contract fault
rather than a calldata one. Nothing could tell the difference, because a wrong selector is not
a wrong type.

- **The real selector is `0x29002951`**, and `DEPLOY_BOND_SELECTOR` is asserted before any
  submission plus in `test/ats.test.ts`. That catches the whole class for free; its absence
  cost every issuance this service ever attempted.
- **The signature is `deployBond(_bondData, _factoryRegulationData)`** with a nested `security`
  struct — resolver (`0xBA2D5FC2…`, the BLR proxy), `maxSupply`, the resolver proxy
  configuration selecting the bond facet set (key `0x…02`, version 1), ERC-20 metadata, an
  `rbacs` array the factory requires at least one admin member in, and the external
  pause/control/KYC lists — beside a separate regulation struct carrying the country scope.
- **`maxSupply` is the face value in minor units**, so an instrument structurally cannot be
  over-issued against the invoice behind it.
- **`clearingActive: false`.** True blocks direct holds with `ClearingIsActivated()`, and a hold
  is the asset leg of every trade.
- **The security id comes from the address the function RETURNED**, resolved through the mirror
  node — never from `contractFunctionResult.contractId`, which is the contract that was
  _called_ and recorded the factory as the instrument for every invoice. ATS does not deploy to
  a long-zero address, so the number cannot be derived arithmetically.
- **Issuance queued before a restart now resumes**, driven off `invoices.issuance_state` rather
  than `issuance_jobs`. The projection is what the book renders and therefore what a seller is
  being told, and the two can disagree — a seeded row carries the projection with no job behind
  it. `failed` is not resumed: `onlyValidISIN` does not become valid on the seventh try.

The venue has now issued `0.0.10331926` (MF-2051) and `0.0.10331928` (MF-2052) itself, at
7,024,576 and 7,023,179 gas — inside the range measured from the factory's history.

### Preparing a deployed security

`deployBond` leaves an instrument with **no supply, an empty allowlist and no KYC**, and a
transfer against it reverts without naming any of that. `scripts/prepare-security.mjs`
(`pnpm prepare:security`) walks the sequence, reading before each step so a re-run costs nothing:
`grantRole` × 4 → `addToControlList` (seller and buyer) → `addIssuer` → `grantKyc` → `issue`.

**It moved into this repo on 2026-09-04**, from `facture-prep/x402-probe/`. Nothing here had ever
granted KYC or written a control list — `services/compliance.ts` only ever read that state — so
the compliance path was invisible to anyone reading the public repo. What changed with the move,
beyond the path:

- **The buyer is named by account id and resolved to its alias** through the mirror node, rather
  than being a hardcoded address. The long-zero form derived from an account number is a
  different key to the contract, so a grant against it authorises nobody; the script refuses one
  rather than guessing. It defaults to `AGENT_HEDERA_ACCOUNT_ID`, which is the account that signs
  the x402 cash leg and therefore the one that has to be able to receive the paper.
- **An unreadable instrument is refused separately from a blocklist one.** `isInControlList`
  means the opposite thing on each, and a silent relay is not a fact about either.
- **A failed step is a `degraded` line rather than a throw**, which is safe only because every
  step reads before it writes.

- **Role hashes come from `contracts/constants/roles.sol`**, never the README:
  `ROLE_CONTROL_LIST` `0x6ed9a91e996c…`, `ROLE_SSI_MANAGER` `0x3120494a82…`, `ROLE_KYC`
  `0x754f499f9f…`, `ROLE_ISSUER` `0x5eeaf5602c…`.
- **`grantKyc` takes five arguments** — `(account, vcId, validFrom, validTo, issuer)` — and
  reverts with `AccountIsNotIssuer` until `addIssuer` has run.
- **Grants target the operator's ALIAS**, not its long-zero address. To a Solidity mapping they
  are unrelated keys and the venue calls from the alias.
- **A read straight after a write lags.** `totalSupply` answered `0` seconds after a successful
  `issue` and the correct figure moments later; the relay trails consensus.

### Resolved: a quote names a bid that can actually take it

The compliance gate ran only when a trade was **armed**, so the book could quote a price from a
mandate whose buyer that security bars. The refusal was correct and legible — a 403 with a
sentence, not a revert — but it arrived after the seller had decided to sell. Observed live on
MF-2051: the tightest bid was 925 bps from a buyer the instrument does not permit.

- **`priceOne` checks the winner, then falls through.** If the winning bid is barred it is
  dropped and the next is priced, up to three passes. Screening every candidate would be an
  on-chain read per bid, which is the cost this design avoids everywhere; screening the one bid
  about to be quoted is normally exactly one read. Past the cap the last price stands and arming
  is still the backstop — the old behaviour, not a new failure.
- **`priceBook` checks nothing, deliberately.** It prices a whole book in one pass, so checking
  per row is the same N+1 it exists to avoid, moved to the mirror node. A book price is
  indicative; `priceOne` is what a seller acts on. **Do not make quoting do N reads.**
- **An indeterminate answer must not move a price.** The gate refuses when it cannot READ the
  instrument, which is right for settlement and wrong for pricing: a relay outage — or a demo
  book whose fixtures point at securities that were never deployed — would drop the three
  tightest bids on every invoice and quietly widen the curve. This was not hypothetical; it
  repriced MF-2041 from 800 to 1850 bps on the first live run. `ComplianceDecision.determinate`
  is the distinction, and `ComplianceCheck.unreadable` is where it comes from.
- **`mandatesBarredByInstrument` is on the wire**, because "no bid" and "this instrument is not
  ready for the buyers who wanted it" are different problems with different fixes.

Verified live: MF-2041 (fixture security, unreadable) quotes 800 bps with nothing barred;
MF-2052 (real security, empty allowlist) quotes nothing with three barred.

### Backend tests are typechecked

`tsconfig.json` covers `src` and `test` with `noEmit`; `tsconfig.build.json` is what emits.
They were excluded before, and turning the check on immediately found four fakes that had
drifted from the seams they stand in for. A fake that no longer matches its interface is a test
passing for the wrong reason.

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

### Resolved: the instrument's regulation comes from the invoice

**MF-2052's row said Reg D 506(c) and its bond went out `1/0`, Reg S.** Found by decoding the
deploy calldata off the mirror node, not by reading either side's code — neither side looked
wrong on its own.

`IssuanceJob.regulationType` was read off the invoice, carried through `issuanceJobFor` into the
queue, and then **ignored**: `deployBond` took `config.regulation` instead. Anything created
through the API agreed only because both came from `ATS_REGULATION_TYPE`; seeded rows carried a
literal written before Reg S was settled, and did not. The wire reports this field per invoice,
so the proof view described Reg S paper as Reg D.

- **The job's value is what deploys now**, and `AtsAdapterConfig.regulation` is gone rather than
  left as a second source. One place has to be wrong for the instrument to be wrong.
- **A test pins each stored spelling to the enum pair the deployed factory checks** — Reg S
  `1/0`, 506(b) `2/1`, 506(c) `2/2`. A wrong mapping is a valid-looking number declaring the
  wrong offering, and a declaration is not something the venue can correct afterwards.
- **Migration `0003` corrects the column default and the stored rows, and is applied** — all 28
  invoices in `packages/backend/data/facture.db` now read `reg-s`, matching what every
  deployed instrument carries.

This is the third field found plumbed to the edge and dropped, after the indexer cursor and the
agent's translation table. Worth checking for directly rather than waiting to trip over.

**`pnpm db:migrate` cannot apply `0003` to a database that has invoices in it, and fails
silently.** drizzle-kit exits 1 having printed nothing but its spinner. Changing a column
default rebuilds the table, and the generated rebuild opens with `PRAGMA foreign_keys=OFF` —
which is **a no-op inside a transaction**, and drizzle-kit wraps every migration in one. So
enforcement stays on and `DROP TABLE invoices` trips the rows in `trades`, `quotes`,
`refusal_receipts`, `settlement_outcomes` and `confirmation_requests` that point at it.
`PRAGMA defer_foreign_keys=ON` does not rescue it: the drop's implicit delete increments the
deferred counter and renaming the replacement table back does not decrement it, so the failure
moves to `COMMIT`. On a fresh database it applies fine, there being no child rows to violate —
which is the only case the generator has in mind.

Against a populated one, use SQLite's documented rebuild order with the pragma **outside** the
transaction (`PRAGMA foreign_keys=OFF; BEGIN; …; COMMIT; PRAGMA foreign_keys=ON;`), then check
`integrity_check` and `foreign_key_check`, and insert the migration's sha256 into
`__drizzle_migrations` so `db:migrate` treats it as done. The full procedure is written at the
top of the migration file. Take a `VACUUM INTO` backup first and not a file copy — the demo
database keeps most of its content in a WAL an order of magnitude larger than the `.db`, so
copying the `.db` alone silently backs up almost nothing.

### Resolved: `/health` reports reachability, because nothing here indexes

`/health` returned **503 from before the first settled trade**. `Indexer.advance()` was the only
writer of a cursor and nothing ever called it, the seed persists `"0"`, so the lag printed as
the whole chain height on both rails.

**This build does not index, and that is not a gap.** The venue _originates_ its chain
transactions rather than following a stream, so everything it stores is a transaction id or a
consensus timestamp — identifiers, not resumable positions. The only position a settlement hook
could record is a transaction the venue submitted itself, and `head − that` measures time since
the last trade, not distance behind the chain; a quiet market would report degraded, which is
the same lie inverted. So `advance()` was removed rather than left waiting for its loop.

What is reported instead is per-rail reachability, which is a real dependency probe: Arc's RPC
carries the cash leg, and Hedera's mirror node is what the compliance gate reads and what a
payout's status is asked of. **The distinction the old cursor comment protected outlives the
cursor** — "not asked yet" and "asked, no answer" must not render as the same thing — and is now
an explicit `state` rather than an inference from a triple of nulls. A failed read builds a
fresh row instead of spreading the last good one, so a stale head cannot ship under a fresh
`lastPolledAt`. viem's 4-second block cache is off for that reason.

### The web package has tests now

vitest + jsdom, `vite-tsconfig-paths` so the `@/` alias comes from tsconfig rather than a second
copy. CSS never runs, so Tailwind and PostCSS stay out of it. **Component and unit only — no
browser or e2e harness**, deliberately.

What it guards is the class `tsc --noEmit` cannot see: a decoder reading the wrong field is
well-typed. `src/lib/api/contract.ts` is tested against its own stated rule — a decoder never
guesses, and a field the screen would render must raise `unreadable` naming the path rather than
default to a zero that looks like a price. `apiMarket` is deliberately uncovered and says why.

Two things this surfaced, neither fixed:

- **The proof view's "Transferred" row is dead on the live path.** The backend publishes
  `assetLeg.unitsMinor` — with a comment saying it exists because a trade that moved one unit of
  a face-value-many issuance is "the kind of claim a proof view exists to make impossible to
  hide" — and the web decoder has no such field, so `apiProof` hardcodes `quantity: null` and the
  row never renders. The fixture path shows it; the real one never does.
- `readInvoice` maps a Hedera native id (`0.0.10331926`) into `instrumentAddress`, typed as a
  viem `Address`. Harmless today — only `isIssued` reads it — and wrong the moment anything
  builds an EVM explorer link from it.

### Resolved: Privy is onboarding, and one signature after the trade

**Decided and built 2026-09-02.** Privy signs a seller in by email and the wallet it makes is
recorded against the business. It touches nothing in the settlement path, and that boundary is
the decision — not a phase one.

`schema.ts` had carried nullable `hederaAccountId` / `arcAddress` on `sellers` since the first
migration, with the comment _"May be a wallet made from an email address; the seller never needs
to know."_ Nothing populated them and there was no seller auth anywhere. So this filled a seam
that had been deliberately left, rather than replacing anything running.

- **The provider is mounted in the `(app)` group, never the root layout.** `/confirm/[token]`
  sits outside that group because a debtor confirms with no wallet and no signup, and that is
  load-bearing: give a customer a key to manage and the behavioural argument collapses. The
  placement is what keeps auth away from them. Verified — the confirm page renders no sign-in
  and no Privy iframe.
- **`POST /v1/sellers` is idempotent on email because a login is only half a sign-in.** Privy
  answers who a person is; only the venue can mint the UUID its routes are scoped by. Nothing
  caches that id — it is recovered by asking again.
- **No chains are declared to Privy, deliberately.** An EVM address is derived from the key, so
  it is the same address everywhere, and the address is all this uses.

**The correction that decided the scope.** The earlier note here said the one thing a user key
must sign is the x402 payload, "which is `signTypedData`-shaped". **That is wrong.**
`@x402/hedera`'s `ClientHederaSigner` builds and signs a **native Hedera `TransferTransaction`**
serialised to base64, and the facilitator verifies it against the payer's on-chain account key
from the mirror node. It is a protobuf body, not EIP-712 and not `eth_sendTransaction`, so a
Privy signer cannot produce it directly. A custom signer over Privy's raw-hash signing might,
but `personal_sign` prefixes EIP-191 and `signTypedData` is EIP-712 — either produces a
signature Hedera rejects. Untested, and not on the path to anything this product needs.

**The seller signs nothing today, and self-custody is not a plumbing change.** Operator and
seller are the same account in the demo, and `createHoldByPartition` acts on the caller's own
tokens, so the venue is the holder and places the hold itself. Moving sellers to self-custody
would require ERC-1400 operator authorisation — a contract change plus a seller signature,
sitting on the asset leg of every trade. Not for a hackathon.

- **Do not touch `packages/agent/src/wallet.ts`.** Circle agent wallets serve a different actor
  solving a different problem, and already work.
- Cost is $0 at this scale. `@privy-io/react-auth@3` declares `react: '^18 || ^19'` and every
  non-React peer is optional, so React 19 was never the risk it looked like. It adds ~3 kB to
  shared JS.
- **Known gap:** the business name is derived from the email domain because Privy cannot know
  it and the venue requires one. Tolerable only because no screen renders it and the venue keeps
  the first name it was given. Correcting it needs a route that can change it, which does not
  exist.
  **Closed: the identity is verified, not claimed.** `POST /v1/sellers` takes **no body**. The
  email and wallet are read out of a Privy **identity token** presented as
  `Authorization: Bearer`, verified in `services/privy.ts`. It used to read an email from a
  request body and believe it, so anyone could have claimed any business.

- **Identity token, never the access token.** The access token carries a DID and nothing
  else, so it would force an API call for the email on every sign-in — `getUser(userId)` is
  deprecated and rate-limited for that reason. The identity token carries the linked accounts
  in its signed payload, so `getUser({ idToken })` verifies and reads locally. The two are
  easy to confuse and the wrong one fails at the signature check, so the refusal names which
  was expected. Privy's `privy-id-token` cookie cannot be used: app and venue are different
  origins.
- **Unset `PRIVY_APP_ID` / `PRIVY_APP_SECRET` disables the route** rather than relaxing it,
  in the same shape as issuance with no ATS factory. Falling back to trusting the caller
  would be reachable only where configuration was forgotten, which is the worst place for it.
- **The rebind refusal is still needed.** A verified token proves who signed in, not that the
  wallet now on that account is the one the business expects to be paid at — account
  recovery, a second linked wallet or a compromised inbox all produce a valid token with a
  different address. A token carrying no wallet says nothing about the one on file and must
  not clear it.
- **An empty email is guarded in two places on purpose.** `VerifiedSeller.email` is typed
  `string`, so `''` satisfies the compiler while being the unique key the table is built on.
  A test found the guard living only in the verifier, where any other verifier could bypass
  it.

### Resolved: refusal receipts are on a topic, as commitments

Topic **`0.0.10342152`**. `refusal_receipts` had carried `hcs_topic_id` and
`hcs_sequence_number` since the first migration, the proof view rendered a link off them, and
the seed filled them in — and nothing had ever written. The fifth mechanism with no caller
found in two days, and the only one propping up a headline product claim.

- **The topic carries a SHA-256 digest, never the reason.** A refusal sentence names the
  debtor and the amounts, and a topic is public — publishing one would broadcast a buyer's
  exposure and a seller's customer list, which is worse than the problem being fixed and is
  something `api-source.ts` already refuses to do. The refused party is handed their receipt
  and their sequence number and checks the digest themselves.
- **The canonical form is an array, not an object.** `JSON.stringify` follows key insertion
  order, so an object would make the digest depend on assignment order. **Field order is now
  a promise**: the digest of the receipt at sequence 1 is pinned as a literal in
  `test/hcs.test.ts`, because changing it silently invalidates every receipt already issued.
  Appending a field is the only safe change, and still needs the version bumped.
- **`publishRefusals` never throws.** A topic that is down costs the checkable copy, not the
  refusal — the alternative is a funder losing the answer they were owed because an unrelated
  service was unavailable. So the claim is that a refusal is always recorded and is checkable
  wherever consensus was reached, **not** that every refusal is on chain.
- **No submit key.** The property wanted is that the venue cannot alter what it already said,
  not that only the venue may speak.

### Resolved: uniqueness is the chain's, not the database's

`UniquenessRegistry` (`0x8eb9f00126bca50226e47b71a75f7b438e81d408`) is in the live path. It
is checked before an invoice is listed and claimed after its instrument exists.

**Of six deployed contracts this was the first ever called**, on 2026-09-03. `MandateBook`,
`InvoiceRegistry`, the Hedera `DvpEscrow` and `AtsComplianceGate` were all deployed and reached
by nothing, with no env var for any of their addresses, so the backend could not have called
them if it wanted to. That was the largest gap between `packages/contracts` and the running
product.

**Seven of eight are wired now.** `InvoiceRegistry` followed on 2026-09-03,
`AtsComplianceGate` and `MandateBook` on 2026-09-06 — see the two sections on them below — and
`PartyRegistry` was deployed on 2026-09-12 with three readers on its first day, so it was never
a sweep finding. The Hedera `DvpEscrow` is the one that stays unreached, and that is a stated
position rather than a gap; the reason is under _"Declined: the Hedera delivery escrow"_.

- **The venue's hash is what gets claimed, never `computeHash`.** The contract's helper would
  mint a second hash for the same receivable — one for the ISIN, another for the registry —
  which is exactly the divergence that makes a uniqueness guarantee worthless. `sameReceivable`
  in shared exists for this comparison and predates anything crossing the boundary.
- **`writeContract` does not mean the transaction succeeded.** The first draft reported a
  second claim on an already-bound receivable as a success, because viem returns once a
  transaction is accepted and the revert happens later. The `deployBond` lesson again: the
  call succeeded and the transaction failed. **Await the receipt and check `status` on every
  Hedera write.**
- **Two deliberate softnesses.** An unreachable registry answers `checked: false` and listing
  proceeds on the database's index — `checked: false` is not `claimed: false`, and failing
  closed would stop a business listing because a second protection blinked. A refused claim
  after issuance cannot fail the issuance, for the same reason.
- Proven against a rival claim, not just our own: a receivable with **no row in this
  database** was claimed on chain and then refused at listing with 409.

### Resolved: the invoice registry carries the confirmation

`InvoiceRegistry` (`0x44fe6E29aaDe69085CE53c4694b99EFe4639B7a7`) is the second deployed
contract in the live path. `isConfirmed(invoiceId)` is a public view, which is what moves
"the debtor confirmed this" from a column only the venue can see to something a buyer can
check — and that confirmation is exactly what justifies advancing the full face value with
no holdback.

- **It composes with the uniqueness registry rather than duplicating it.** `list` verifies
  the hash against `UniquenessRegistry` instead of trusting its caller, so an invoice cannot
  be listed before its receivable is claimed. Both therefore run after issuance, in that
  order, and the ordering is the contract's rather than a convention chosen here.
- **`list` cannot express `Confirmed`.** It always writes `Draft`; confirmation is a separate
  transition because it is a separate real-world event. A dispute writes nothing — the
  lifecycle does not move backwards, so a mistaken `Confirmed` would be a permanent public
  claim that a customer agreed to an invoice they had just rejected.
- **No new disclosure.** Face value and due date are already public on the bond itself
  (`maxSupply` and maturity), so this is an index over facts the instrument carries.
- **Neither write may cost anything real.** A chain that refuses a confirmation must not cost
  the debtor their answer, and a refused listing must not fail an issuance. Both are tested,
  because the natural way to write either is a bare `await`.

**Unwired when this was written: `MandateBook`, the Hedera `DvpEscrow`, and
`AtsComplianceGate`** — three of six. The book was the interesting one, because it reads rating
and confirmation _from the invoice registry_ rather than taking them as arguments, which is
what makes its refusals mean anything, and that registry had just been populated.

**Two of the three were wired on 2026-09-06** and the third is now a declined position; the
sections near the end of this file carry both. The gate turned out not to be dormant but
broken, which is the more useful half of that story.

### Resolved: two settlement rails, and one conversion between them

**Decided 2026-09-03, and by the prize rules rather than by taste.** The Hedera
**AI & Agentic Payments** track ($6,000) requires _"a live x402-gated service on Hedera…
settled through the Blocky402 facilitator"_ plus an agent that completes a real paid request.
`POST /v1/trades` is already exactly that. So replacing the x402 cash leg with an Arc payout —
which the vault and escrow contracts were plainly written for — would forfeit a track, and the
question of whether x402 stays is closed.

**A funded mandate settles out of its escrow on Arc; an unfunded one settles pay-as-you-go
over x402 on Hedera.** Five of seven seeded mandates are unfunded, so the second branch serves
live data rather than a hypothetical. **Which rail settled a trade must be stated on the
receipt and in the proof view, never inferred** — a branch that silently picks the old path
means the old path is what gets demoed, which is now a $6,000 problem rather than an
inelegance.

**Prize amounts, read off the pages 2026-09-04. Pools are not payouts.** Hedera's two tracks
are $6,000 each, and each one reads *"up to 3 teams will receive $2,000"*, so a win is
**$2,000**. Arc's $10,000 is five entries rather than four: **Launch on Arc Testnet & Push to
Mainnet** ($3,500 pool, $2,500 first and $1,000 second), **Best DeFi/Onchain Finance**
($1,667), **Best Agentic Economy with Circle Agent Stack** ($1,667), and two Continuity-only
entries this project cannot enter. Privy is **two $2,500 tracks**. Six tracks are eligible and
the realistic ceiling is about **$14,800**, not the $20,500 you get by reading sponsor totals
as payouts. _"Best DeFi/Onchain Finance Application"_ asks for _"conditional payments, onchain
automation or multi-step settlement"_, which describes vault → escrow → hashlock almost
verbatim. **Tokenization of Anything requires verified contracts on HashScan** — now confirmed
done, see below. Every track requires a public repo.

**The Privy control claim was overstated, then corrected, and the correction has since been
built.** Only the B2B track requires _"at least one Privy control, such as policies, signers,
key quorums, or intents"_; Best financial flow does not. For four days this build had none of
the four — `useSendTransaction`, `useWallets` and identity-token verification, which is an
embedded wallet signing its own transaction, the weakest reading of "signers" available, and
this file already says that email plus an address is not a control.

**Both tracks are satisfied as of 2026-09-06.** A Privy **policy** now scopes each seller's
embedded wallet to `claim` on `DvpEscrow`: `to` equals the escrow, `chain_id` equals 5042002,
and the decoded calldata names `claim`. Privy denies by default, so that is the entire
permission the wallet holds. Policies were chosen over session signers on product grounds — a
delegated signer would let the venue sign as the seller, which removes the one transaction a
person signs, and that transaction is what satisfies the other track. See _"Privy signs exactly
one thing"_ below, and `services/privy-policy.ts`.

### Resolved: one settlement conversion, in one place, with a direction

**The Arc funding check compared USD cents against a USDC balance at 6 decimals, and passed
by coincidence.** A mandate counted as holding $50,000.00 — 5,000,000 cents — was read as
backed by 5,000,000 USDC minor units, which is 5 USDC. Identical digits, four orders of
magnitude apart. `escrow.backed` inherited it, and the screen rendered the vault balance with
the dollar formatter and reported 5 USDC as *"Backed by $50,000.00"*.

- **The conversion already existed and was not found.** `x402.ts` derived it carefully and
  wrote down why, having been caught once already by _"the same digits meaning a different
  thing by accident"_. `arc.ts` was written afterwards, next to it, and did neither. So
  `toSettlementAmount` now lives in `src/units.ts` and both rails import it: **a rule only one
  caller can find is one the next rail gets wrong too.**
- **Rounding has a direction, and it is not the same one for both uses.** A payment rounds
  **down**, so a payer is never billed money the invoice does not owe. A collateral
  requirement rounds **up**: at 1 ppm the granularity is a whole dollar, so rounding down
  required zero USDC for anything under $1.00 and an empty vault backed it — the overclaim the
  check exists to refuse, arriving through the rounding rather than the comparison.
- **`X402_SETTLEMENT_SCALE_PPM` governs both rails despite the prefix**, deliberately: one
  receivable has to cost the same money whichever way it settles, and a per-rail scale factor
  is how two rails come to quote two prices for one invoice. Not renamed, for the reason
  `DATABASE_URL` was not — a rename falls back to the default on every deployment still
  setting the old name.
- **The wire carries `depositedUsdcMinor` and `requiredUsdcMinor`**, because the defect was
  two scales sharing one name, and the required figure is what makes the deposited one mean
  anything. `formatUsdc` is a separate function from `formatMoney` rather than an option on
  it: the two are never interchangeable and the failure is silent.

Verified against the live vault when this was written: Harrow Point needed 0.05 USDC and held
5, backed a hundred times over; the seeded mandates were correctly unbacked. The old comparison
agreed on exactly one of them. **The vault reads 4.972731 USDC on 2026-09-06** — two Arc-rail
sales have drawn on it since.

### Resolved: the seller has an Arc address that can actually be paid

**Meridian Fabrication's `arc_address` was invented**, like the seeded buyers' — and nothing
on the settlement path read it, which is why it survived. `MandateVault` locks a payout
claimable by the match's seller address and no other, so an invented one is a sale that
settles, reports success and pays nobody until `reclaimPayout` returns the money to the buyer
a day later.

- **The correction needed no new key.** `sellers.hedera_account_id` already held the
  operator's ECDSA alias, operator and seller are the same account here, and **an EVM address
  is derived from the key rather than from a chain** — so one key controls the same address on
  Arc as on Hedera. Derived from `HEDERA_OPERATOR_KEY` and checked, not assumed. This is the
  same property that makes a Privy wallet usable, seen from the other end.
- **A second divergence fell out of writing the invariant as a test.** The seed set
  `hederaAccountId: '0.0.5512'` where the live database holds the alias — settlement resolves
  a seller through `accountIdToEvmAddress`, and a fictional id becomes a long-zero address
  holding nothing, so the row **had been corrected by hand and no migration recorded it**. A
  fresh seed now produces a book that can settle. The seeded trades keep their fictional
  `0.0.5512@…` refs: demo history that never happened is a different thing from who a party is.
- **The web fixture book keeps its invented address**, deliberately. That book is fiction end
  to end — fictional trades against securities never deployed — and putting one real address
  into it would make the rest read as real.

### Resolved: the Arc rail pays the seller, and what it cost to make safe

**Built 2026-09-03.** A mandate whose capital is escrowed in `MandateVault` settles on Arc in
USDC. An unfunded one settles pay-as-you-go over x402 on Hedera, unchanged. See the two-rails
decision above for why both stay.

- **A funded mandate settles in ONE call and returns 200, already settled.** There is no
  challenge because there is nothing to sign: the buyer escrowed the capital and wrote the
  terms, so an invoice meeting those terms is a trade they have already agreed to. **A second
  consent would make a standing bid not standing**, which is the product's whole claim. An
  unfunded mandate still gets a 402, and both bodies carry `rail.reason`.
- **The order is chosen by which way a failure hurts.** Hold the paper → `registerMatch` →
  `executePayout` → execute the hold → hand over the preimage. **Cash commits before the
  paper moves.** Reverse those two and a failed payout leaves the buyer holding paper nobody
  paid for, unrecoverable. This way a failed delivery leaves money in an escrow and the seller
  keeps their position.
- **`registerMatch` is one-shot and no binding can ever be corrected** — a second call reverts
  even with identical arguments. So every write reads first. A match whose payout already
  executed is refused rather than retried, because `reclaimPayout` returns the capital while
  leaving `executed` true forever.
- **The seller must claim with their own key.** `DvpEscrow.claim` requires
  `msg.sender == beneficiary`; even the attester holding the public preimage gets
  `NotBeneficiary`. Arc gas is USDC, so **a seller holding nothing cannot claim** and needs a
  top-up. Workable here only because operator and seller are the same account.
- **The preimage is not a credential and is published on the proof view.** The secret alone
  moves nothing — the contract says the hashlock "does not keep anyone out" — and `claim`
  writes it to storage in the clear anyway. It was previously returned exactly once, in the
  settlement response, so a dropped connection left money nobody could ever claim.

**Still not wired: `reclaimPayout`.** It is permissionless and it is what returns a stranded
lock's capital to the mandate — and **nothing in the backend calls it**, though three comments
implied it happened by itself. Corrected rather than deleted, because the wrong version was
committed. Recovering a stranded lock is an operator action today.

### The Arc rail's defects, and why they were all the same defect

An adversarial review of the first Arc-rail commit found a double-spend and five defects
around it. Every one came from the same root, and it is worth stating because it will keep
being true: **on this rail there is no second consent, so every hole the x402 path leaves open
becomes reachable without anyone signing anything.**

- **The invoice stayed for sale after the buyer had paid for it.** The cash leaves
  irreversibly, then the paper moves. A failed delivery left the invoice quotable, the hold
  expired in three minutes, and a fresh quote drew a SECOND payout from the same mandate. One
  receivable, paid for twice, silently. The x402 path has the identical hole and cannot reach
  it, because a second sale needs a second signature. **The invoice is marked sold when the
  cash commits, not when the paper moves.**
- **Compensation released capital that had already left.** `abandon` refunded the mandate on
  every failure, so a bid quoted against USDC sitting in an escrow lock. The signed x402 half
  already carved out `internal_error`; the arming half did not.
- **`unwind` could release a trade whose cash had moved.** An Arc trade sits in
  `awaiting_payment` for its whole settlement and `reclaimExpired` sweeps that state on nearly
  every request. Status alone was a sufficient guard only while `awaiting_payment` meant
  nothing had moved.
- **An x402 signature was accepted against a trade the vault was paying for**, which would
  have taken a second payment and overwritten the row's rail.
- **The hold window was sized for a challenge on a rail with no challenge.** 180 seconds had
  to cover two Arc writes and two receipt waits. `VAULT_HOLD_WINDOW_SECONDS` is 12 minutes.
- **A receipt timeout was reported as a revert.** viem gives up while the transaction is still
  live, and `send` claimed "nothing was written" — so the venue would report failure, release
  the capital, and then the payout would land in a lock nobody recorded. **A timeout is not a
  revert**, and the unknown case now says so.

Two smaller ones worth keeping: the escrow address cached a _rejected promise_, so one RPC
blip would make every lock read "unreadable" for the life of the process — cache the value,
never the promise. And writing a test found an **existing test passing vacuously**: it read
`quote.body.mandateId`, which is undefined because the mandate is named on the quote itself,
so it compared an absent mandate with itself.

### Two more mechanisms nobody calls — one closed

Found while mapping the settlement path. That makes eight and nine, and the pattern holds:
look for the caller before trusting the mechanism.

- **`trades.hcs_topic_id` / `hcs_sequence_number` had a reader and no runtime writer.**
  `proof.ts` rendered them into a HashScan link and only `seed.ts` ever set them, so on every
  live trade that block was null. **Closed:** both rails now commit a settled match to the
  same topic, as a digest and a trade id under `kind: 'facture.match'`. Its canonical form is
  its own, not shared with refusals — one reordering would otherwise invalidate both — and
  the field order is pinned in a test, because a digest anyone holds stops verifying the
  moment it changes. `publishMatch` never throws: the sale has already happened and both legs
  are checkable on chain, so an unavailable topic costs the coordinate, not the trade.
- **`reclaimPayout` is still not wired**, and that is now a deliberate position rather than an
  oversight. It returns a stranded payout's capital to the mandate, it is permissionless, and
  the failure it recovers from should not happen. Automating it would mean the venue writing
  to Arc on a timer for a case that needs judgement about whether the seller simply has not
  claimed yet. **It is an operator action, and the code no longer claims otherwise.**

### Resolved: the agent measures in the wrong unit, and checks the wrong pot

**The note that escrowing capital "starved" the agent was wrong**, and it was acted on. Before
the deposit the wallet held 6 USDC — $6.00 at par — still four orders of magnitude short of a
$6,400 receivable. The deposit did not flip a passing check to a failing one.

`agent.ts` converts USDC to cents **at par and applies no ppm scale**, so it demands the full
face-value dollar amount while the venue charges a millionth of it. Under the venue's own
convention its 0.996822 USDC backs about $996,822 of proceeds. **The agent is not short; it is
measuring in the wrong unit** — the same defect as the Arc funding check, in a third place.

Underneath that is a larger one: the agent checks its **Circle wallet**, and that wallet pays
for neither rail. The Arc rail is paid by the vault; the x402 rail needs a Hedera key the
Circle wallet does not have and cannot produce. The wallet's real job is funding the vault.
**Decided and built.** `checkMandateEscrowed` replaces `checkWalletFunded` and compares no
amounts at all: `backed` is measured against the mandate's WHOLE committed capital, so a
backed bid covers anything `decide` already found headroom for — which is what keeps a second
copy of the venue's ppm scale out of that package. `WALLET_BALANCE_SHORT` became
`MANDATE_NOT_ESCROWED`, with three answers rather than two, because an unreadable vault is not
an unbacked one. The cap survives: it is the mandate's committed capital, enforced by `decide`
here and by the venue again at arm time. The last look before arming was deleted rather than
ported — re-reading the vault per invoice is a mandates fetch per row, and the venue re-decides
the rail anyway. Verified live: the agent takes 2 invoices where it took 0.

### Resolved: the agent pays for its own trades, and why it could not before

**Built 2026-09-03.** `@facture/agent` completes an x402 payment on Hedera. The Hedera **AI &
Agentic Payments** track ($6,000) asks for an agent that completes a real paid request, and
`POST /v1/trades` was already the x402-gated service; what was missing was a buyer that could
sign.

**The agent was not stopping at the 402. It was never receiving one.** `checkMandateEscrowed`
refused any mandate whose capital was not escrowed on Arc, and the venue settles an escrowed
mandate out of the vault — so every trade the agent would arm came back **200, already
settled**, and the x402 branch was unreachable by construction. Nothing errored. The branch
had a log line describing the signature it was waiting for, and that line ran on the Arc path
too, where nothing was waiting and the money had already moved. This is the nineteen-mechanisms
pattern in a form worth watching for separately: the mechanism had a caller, and the caller
could not reach it.

- **`cash.ts` holds the buyer's Hedera key, and no other key can do this job.**
  `@x402/hedera`'s `exact` scheme signs a native `TransferTransaction` serialised to base64,
  verified against the payer's on-chain account key from the mirror node. It is a protobuf
  body, not EIP-712 and not `eth_sendTransaction`, so the Circle Arc wallet cannot produce it
  and neither can a Privy signer. The buyer therefore has two identities on purpose: an Arc
  address that funds the vault, and a Hedera account that pays per trade.
- **`checkCashLegPayable` asks about both rails and takes either.** Escrowed on Arc, or a key
  that can pay on Hedera. The refusal, now `CASH_LEG_UNPAYABLE`, names **both** halves — a
  sentence naming only the vault sends the reader off to deposit USDC to fix a missing key.
  It is the third name for this refusal after `WALLET_BALANCE_SHORT` and
  `MANDATE_NOT_ESCROWED`, and it stays out of shared's `RefusalCode`: the venue never refuses
  for this reason, because it holds two rails and always has one to offer.
- **No price is converted in this package, still.** The pre-flight compares no amounts at all.
  The one comparison is **tinybars against tinybars**, made after the challenge has named the
  figure in the payer's own unit — so the venue's ppm scale stays where it belongs, which is
  the defect this pre-flight was rewritten once already to remove. The pre-flight proves only
  that the payer exists and is not empty, which is exactly what it claims.
- **The challenge is read from the `payment-required` header, not the copy in the body.** The
  venue duplicates `accepts` into its JSON for convenience, and reading that copy would make
  the agent a client of Facture's response shape rather than of x402. A non-CAIP-2 network is
  refused at the parse — before the ATS hold, rather than at the facilitator's kind lookup
  after it.
- **The buyer pays no gas, and that is a property of the payload rather than a courtesy.** The
  transaction id is generated against `extra.feePayer`, the facilitator's account, which is
  also why the payload is only _partially_ signed: it is not submittable until the facilitator
  adds its own signature. A leaked payload is a transfer nobody but the facilitator can
  broadcast, to an account the challenge already named. `extra.feePayer` is read at runtime,
  never pinned.
- **HBAR only, refused early.** An HTS asset needs an explicit association on the receiving
  side, and without one the transfer fails at consensus with
  `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT` — after the venue has held the seller's paper.
- **Signing needs no network, which is what makes it testable.** `freezeWith` wants only the
  node addresses an SDK client already knows and `sign` is arithmetic, so a test decodes the
  signed bytes and checks them against the challenge. That matters because the failure on this
  rail is not an exception: a payload built from the wrong field is a valid signature over the
  wrong transfer, and the facilitator submits it.
- **`AGENT_HEDERA_ACCOUNT_ID` and `AGENT_HEDERA_PRIVATE_KEY` are optional and all-or-nothing.**
  Unset disables the rail rather than relaxing it, in the same shape as issuance with no ATS
  factory. Half a pair behaves exactly like no rail while looking like a working one in a
  `.env`, so it is refused by name. The key is registered with the log redactor from
  `process.env` **before** the schema parses it, because `PrivateKey.fromStringECDSA` throws on
  a bad key and that is the one path guaranteed to run while holding it.
- **A live run now spends.** `AGENT_DRY_RUN=false` with a key set signs and submits a transfer
  of the buyer's HBAR per trade, and nothing between the decision and consensus asks a second
  time. The boot log used to say this process spends nothing directly; that was true while the
  vault settled everything, and it is corrected rather than deleted.

**It has run.** The agent read the book, priced it, armed a trade, signed the cash leg and
settled — trade `c0c8ed97-b01d-4c30-b9b2-0ddf7472fa3d`, cash
`0.0.7162784@1788449867.590233238`, asset `0.0.10311549@1788449868.676674741`, HCS sequence 24.
The buyer's balance moved by exactly the 868,798 tinybars quoted and the facilitator paid the
whole 258,441 fee, so "the buyer pays no gas" is now a reading off the chain rather than a claim
about the library. Full record in [docs/deployments.md](./docs/deployments.md).

Nothing was arranged to make it happen. The customer is UNRATED, which loses five of the seven
mandates on rating; the sixth caps tenor at 45 days against a 47-day invoice. The one bid left
is unescrowed, so the venue routes it to x402 by its own arithmetic.

- **The venue client's timeout was shorter than the operation it invokes, and that is not a
  slow-path problem.** Arming is two Hedera round trips and takes about fifteen seconds; the
  single 10s budget aborted the client while the venue kept working, **and the trade was armed
  anyway** — hold placed, capital allocated, nothing on the agent's side knowing. The next tick
  tried to arm the same invoice and got a 409, which was the venue protecting the invoice
  rather than a fault. `POST /v1/trades` now has its own budget (`FACTURE_API_TRADE_TIMEOUT_MS`,
  60s) and an aborted trade request says the outcome is unknown. **The "a receipt timeout is
  not a revert" rule generalises: a request timeout is not a rollback either.**
- **The proof invoice is the bond issued by accident**, the one recorded as debris while testing
  the duplicate check. It had a real instrument with no supply, an empty allowlist and no KYC,
  so it was the only row that could carry this without anything being invented for it.
- **`prepare-security.mjs` moved exactly one bid.** Before it, `mandatesBarredByInstrument: 1`
  and no quote; after, one match at 1850 bps with the same six refusals underneath. That is the
  compliance-aware pricing doing what it was built for, on a smaller scale than the MF-2052 run
  that established it.

### The full sweep for mechanisms nobody calls — ten more, 2026-09-03

A systematic pass over every export, interface member, column, env var, contract function and
wire field, asking only "what calls this outside its own tests". Nine had been found
one at a time; this found **ten more at once**, which says the pattern was never a run of bad
luck. Ranked by the claim each one falsely supports, not by how odd the code looks.

**Two are fixed in this commit** because they were actively false to a user:

- **`escrowVerified` was published and discarded.** The venue answers it so a reader need not
  infer whether funding was checked against the vault or merely believed — and the web threw
  it away and told every buyer _"The capital is escrowed, so the bid is firm"_, with no vault
  configured, against a browser-generated reference string. The overclaim every other piece
  of that feature exists to prevent, at the one place a human reads the result.
- **Two agent log lines described a spend that does not exist** — see the agent section above.

**The rest stand, and are worth knowing before trusting the claim beside them:**

1. **`ArcEscrow.registerMandate` had no caller.** The vault refuses a deposit against an
   unregistered mandate, so **no mandate created through `POST /v1/mandates` could ever be
   escrowed** — its key is `keccak256(uuid)` and nothing registered it. The one working
   mandate had been registered by hand. Closed operationally first, by `pnpm demo:reset`.
   **Closed properly 2026-09-04:** `POST /v1/mandates` registers the mandate as soon as the
   row is inserted, and `POST /v1/mandates/:id/fund` repairs a missing registration before
   the buyer deposits — registration has to precede the deposit, or the vault reverts
   `MandateNotRegistered`. The address is guarded with viem's strict `isAddress`,
   **deliberately the same check `scripts/demo-reset.mjs` makes**, so the script and the route
   cannot disagree; all three invented seeded buyer addresses fail it.
   `buyerOf` is read before every write, so a binding is never overwritten.
2. **`SettlementOutcome: 'default'` is never produced** and no route writes
   `invoices.status = 'defaulted'`. So the permanent-rating-mark story has no code path, and
   worse: maturing an overdue unpaid receivable records it as **`late`**, which is a default
   written into the ledger as a payment. **Closed 2026-09-04, and both halves of this
   finding are now wrong — including the sharper half.** `POST /v1/invoices/:id/default`
   produces the outcome and writes the status. And maturity no longer records a receivable
   nobody paid as `late`: the root cause was that `late` compared the due date against the
   instant the operator pressed the button, so it was the fallback for both "not paid yet"
   and "never paid". **The payment date is stated now, with `paidAt`**, and absent-and-past-due
   is refused with a sentence rather than guessed at.
3. **`MandateVault.executeRelease` has no caller and is not even in `VAULT_ABI`.** "Withdraw
   unallocated capital" decrements a SQLite row; real USDC in the vault has no path out of it
   in this repo. Migration `0004` fixed a buyer's address _for this call_. **Closed
   2026-09-04:** it is in the ABI and the withdraw route calls it. **Book first, chain
   second**, because a failed release leaves USDC in the vault against a book that no longer
   quotes it, which re-funding recovers; reversed, it leaves a mandate quoting capital that
   has already left. The amount converts through `toSettlementAmount` and rounds **down** —
   the vault's lower-bound invariant survives the smaller book only in that direction.
4. **`@facture/shared/state` is an entire unused module** — both machines, every guard.
   Status changes go through unguarded `updateInvoice({ status })`, so nothing validates a
   lifecycle transition and `IllegalTransition` cannot be constructed at runtime. **It has
   production callers as of 2026-09-04** — `services/settlement.ts` guards `sold -> defaulted`
   in `recordDefault`, and `settleAtMaturity` now guards its own hop to `matured` the same way,
   which is what stopped a `disputed` invoice maturing with a 200. **That is a beginning, not a
   closure:** the edge this venue performs most often is still an unguarded write — both
   settlement paths set `status: 'sold'` straight through `updateInvoice`, and the arm-time
   listing check is what stands in for the machine there.
5. **`listed` is an unreachable invoice status.** Only the seed writes it, so the secondary
   market the README's argument rests on has a table row and no code — which
   `settlement.ts` already concedes in a comment. **Closed 2026-09-04:**
   `POST /v1/invoices/:id/list` writes it and arming refuses anything else, so the status is
   reachable and load-bearing. **The other edge — `sold -> listed`, the relist — landed
   2026-09-06**, so the status is now reachable from both directions and the README's
   secondary-market argument has code under it. See _Resolved: the secondary market_ below,
   including why the wall recorded here for two days was the wrong wall.
6. **`ArcEscrow.buyerOf` is called by nothing, not even a test.** It is the one check that
   would have caught the invented-address problem `0004` fixed by hand. **Closed
   2026-09-04:** it has callers, and direct test coverage.
7. **The agent's entire money-moving surface has no caller** — `transferUsdc`,
   `executeContract`, every wallet-set method. `AGENT_WALLET_SET_ID` is parsed and read by
   nothing. `executeContract` is also the only way the agent could ever deposit into the
   vault, which is the other half of (1).
   **Partly closed 2026-09-04.** `executeContract` and `AGENT_WALLET_SET_ID` have callers:
   `src/vault.ts` posts the agent's own Circle-wallet USDC into `MandateVault`, and
   `pnpm --filter @facture/agent fund` drives it, dry by default with `--execute` as the only
   authorisation. `transferUsdc` still has no caller and should not get one here — a plain
   transfer to the vault address is credited to no `mandateId` and could never be released, so
   the fake wallet in `test/vault.test.ts` makes calling it fatal. The wallet-set provisioning
   methods stay uncalled, being a one-off done outside this process.
8. **`InvoiceRegistry.lookup` is never called.** The venue publishes terms and confirmations
   to chain and never reads them back — write-only, unlike `UniquenessRegistry`, whose read
   is what makes its refusal real. **Closed 2026-09-04.** The proof view asks on every request
   and publishes a `registry` block. `checked: false` keeps `listed` and `confirmed` null
   rather than false, and the screen shows a disagreement between the chain and the venue's
   own column instead of resolving it.
9. **`settlement_outcomes` is a write-only table.** Its header calls it the append-only fact
   behind the `debtors` accumulator, and the counters are incremented in place and cannot be
   rebuilt, because nothing can read the facts. **The write-only half is closed 2026-09-04.**
   `RecordOutcomeResult` carries the outcome the ledger actually holds, read back inside the
   transaction that lost the insert — without which a default landing on an already-recorded
   payment is invisible — and `Store.getOutcome` is a real reader on the live path: it is what
   tells a first maturity from a replay, and the past-due refusal turns on it. **The counters were never derivable, and the schema now
   says so.** They are an opening balance a customer arrives with, plus every outcome this
   venue recorded — 82 counted events against 5 rows in the live book — because
   `settlement_outcomes` keys on `invoice_id` with a foreign key and history predating the
   venue has no invoice to point at. What is pinned instead is the weaker pair that is true:
   every row is inside the counters beside it, and no terminal invoice is missing its row.
10. **`invoices.regulation_type` never reaches the proof screen.** `api-source.ts` hardcodes
    `regulation: null`, so the Reg S declaration renders only from fixtures.
    **Closed 2026-09-04.** `TradeProof.invoice.regulation` carries it, translated from the
    column's kebab spelling to the `RegulationKey` a decoder accepts, each mapping pinned by a
    test. The stored spellings are `reg-d-506b` and `reg-d-506c` — no hyphen before the
    letter, which is not what you would guess from the wire names.

Also dead, lower stakes: `Store.getCursor`/`setCursor` and `indexer_cursors` (residue of the
removed indexer), `InvoiceRegistry.setRating` / `amendDueDate`, and a tail of unused helpers
across all five packages. `setCursor` does have one caller, in `db/seed.ts`; `getCursor` has
none. **`arc.ts` claimed `PAYMENT_LOCK_DURATION` was "read from the deployed
contract" — it is not in the ABI and never read.** The comment was corrected and now says so
outright; the mechanism is still unread, so it is the accusation against the comment that is
stale rather than the finding.

The lesson stands and is now quantified: **twenty-two mechanisms in this repo had a definition,
documentation, and no caller.** Nine came one at a time and ten came at once, from this sweep.
Three arrived after it: `provisionClaimPolicy`, named the twentieth in its own commit message,
and the deployed `AtsComplianceGate` and `MandateBook`, which this file had been carrying as
unwired contracts rather than as sweep findings. They are the same thing and are counted here
as such.

Thirteen have a caller. Ten as of 2026-09-04 — seven outright (1, 2, 3, 5, 6, 8 and 10) and
three only partly (4, 7 and 9, where the caller exists and the claim beside it still does not
hold) — plus those three on 2026-09-06. So the count is **nine**. What remains is the tail below
the numbered list, plus `reclaimPayout`, which stands deliberately and says why.

The Hedera `DvpEscrow` is deliberately **not** on this list, though it has no caller either. It
was never meant to have one: it is `MandateBook.confirmSettlement`'s evidence source, and
`deployHedera.ts` says as much by binding it to the book and nowhere else. A component of a
design this build does not reach is a different thing from a mechanism that lost its caller.

**The last of the twenty-two changes what this pattern costs.** The ones before it were inert:
defined and documented and harmless. `AtsComplianceGate` was not harmless. It probed three ATS
selectors that do not exist and refused every buyer on every instrument, so wiring it unchanged
would have stopped the venue trading. Nothing had ever observed it doing that, which is the
whole difficulty: an uncalled mechanism accumulates documentation describing behaviour nobody
has checked, and the documentation gets more confident with age rather than less.

Look for the caller before believing the comment — including comments written in this file.

### Resolved: the proof view carries the chain's own answer

Two of the sweep's findings met on one screen, so they were closed together.

- **The regulation is per invoice, and now says so.** `TradeProof.invoice.regulation` is
  translated at the wire boundary from the column's kebab spelling to the `RegulationKey` a
  decoder accepts, and a stored value outside that vocabulary publishes `null` rather than a
  guess. The two ends disagree on purpose: the backend refuses to publish a declaration it
  cannot spell, and the web refuses to read a key it does not know, raising `unreadable` and
  naming the path. Folding an unknown spelling to `null` on the reading side would drop a
  declaration that was actually made.
- **`InvoiceRegistry.lookup` has its first caller**, which moves the debtor's confirmation off
  a column only the venue can see. That confirmation is what justifies advancing full face
  value with no holdback, so it is the claim on that screen most worth checking somewhere that
  is not us.
- **Three states per answer, never two.** `checked: false` means no registry is configured or
  the node could not be read, and it renders as that rather than as a no. A registry blinking
  would otherwise print "not confirmed" one line under a confirmation the venue is certain of
  — the `/health` cursor mistake and the `ComplianceDecision.determinate` mistake, in a third
  place.
- **A disagreement is shown, not resolved.** If the chain and the venue's column differ, both
  are rendered as read. Picking one would leave the stronger-looking claim standing alone.
- **`instrumentAddress` and `securityId` are read apart now.** One slot typed as a viem
  `Address` had been taking a Hedera native id, which was harmless only while nothing built an
  EVM link from it.

One thing was deliberately left. `wireInvoice` still publishes the same fact as
`regulationType` in the raw kebab spelling on the invoice resource, so one fact has two names
and two spellings across two endpoints — the split-vocabulary shape this file keeps warning
about. Nothing in the web reads that copy. It stays because changing a published wire field
for a cosmetic win is the trade `X402_SETTLEMENT_SCALE_PPM` already refused.

### Every status write, mapped — the machines and the code disagreed

A read-only pass over every place an invoice or mandate status is written, 2026-09-04. It asks
the sweep's question backwards: not what has no caller, but what the callers actually do.

**Both findings below were closed the same day**, by the section after this one. They are kept
in the tense they were written in because the reasoning is what makes the fix legible — the
point was never the two edges, it was that a machine nobody runs describes nothing.

- **Two edges the running code performs are forbidden by the declared machine.**
  `confirmed -> sold` fires on **every trade, on both rails**, and
  `awaiting_confirmation -> awaiting_confirmation` fires whenever a confirmation link is
  re-requested, which is an unconditional write. Only **6 of 15** declared invoice edges have a
  writer at all. This is why wiring the machine in further is not a free change: dropping the
  `transitionInvoice` guard into the settlement paths would refuse the trade the product made
  this morning.
- **The mandate machine had the same defect as `listed`, and it was not in the nineteen.**
  `'funding'` is written by **nothing anywhere in the repo** — it appears in the status union,
  in the machine, in refusal prose and in fixtures, and nowhere else. `fundMandate` goes
  `draft -> active` in one write, which the machine also forbids, and all seven live mandates
  are `active` with no row ever having held `funding`. **The state is not decorative:** the
  machine's own comment says it is where escrow begins and that a mandate does not quote from
  `draft`, which is exactly the distinction the Arc vault makes between committed capital and
  posted capital.

### Resolved: the product moved to the machines, not the other way round

**Built 2026-09-04**, off the status map above. Both machines now describe what the code does,
and the code performs no edge they forbid. **No transition table changed** — that direction was
chosen deliberately, because a machine edited to match the code is a machine that can never
catch the code being wrong.

- **Listing is an act.** `POST /v1/invoices/:id/list` and `/delist` move an invoice between
  `confirmed` and `listed`, and **arming refuses anything not listed** — which is what closes
  `confirmed -> sold`, the edge every trade in this repo's history performed. `listed` was
  written by nothing but the seed until now, and the README's own "Never cut" path opens with
  the word _List_, so the product was missing its first step.
- **Quotability is unchanged, on purpose.** A `confirmed` invoice still gets an indicative
  price, because the book renders in one pass with no chain reads and that is worth keeping.
  Listing is the seller _offering_ it, and the offer binds at arm time rather than quote time.
  Making `listed` the only quotable status would have been the tidier model and a slower book.
- **Delisting refuses while a trade is armed.** Without that a seller could withdraw the offer
  between the 402 and the buyer's signature. That is the Arc rail's lesson showing up in a
  third place: a hole that was unreachable only because nothing could reach it, made reachable
  by adding the route that reaches it.
- **`funding` is the state the machine always said it was.** `fundMandate` walks
  `draft -> funding -> active` hop by hop, and reaches `active` only when the Arc vault
  actually backs the committed capital. A deployment with no vault promotes straight through,
  because there is nothing to verify — the same call `chooseRail` makes. **An unreadable vault
  parks rather than promotes:** an indeterminate answer must not put a price on the curve.
- **A top-up to an `active` or `exhausted` mandate is still refused when it cannot be verified.**
  That was already deliberate and has not changed. The machine has no `active -> funding` to
  demote into, so the only alternative to refusing is an active mandate quoting capital nobody
  posted.
- **Every mandate status write goes through `transitionMandate`**, and the self-writes in
  `allocate` / `release` / `withdrawFromMandate` omit the column entirely rather than performing
  `X -> X`. `db/status.ts` holds the rules once: a lifecycle rule that drifted between the two
  stores would make the whole suite agree with a store nobody deploys.
- **`escrow.backed` had two copies of its comparison facing opposite directions** — one on the
  list screen, one in the funding route. Now one, used by three callers. That is the same defect
  as the settlement conversion, found in a second place.

**The consequence to know about:** five seeded mandates still quote against capital nobody
posted, and this does not undo that. Seeded rows are inserted `active` directly, so the walk
never runs for them. It stops the next one, which is the position already taken when
`ARC_MANDATE_VAULT_ADDRESS` was first wired.

### The adversarial review, and a guard that was only accidentally safe

**Six confirmed defects against the two commits above, all fixed 2026-09-04.** Backend 391 → 416
tests. They were fixed in one commit because they share the store interface, and the first of them
could have stranded a buyer's real USDC permanently.

- **A failed release could strand the buyer's capital forever.** `withdrawFromMandate` marked a
  mandate `withdrawn` the moment its book hit zero, `fundMandate` refuses a withdrawn mandate, and
  `executeRelease` is reachable only from the withdraw route — so any outcome short of a completed
  release left the USDC in the vault under `keccak256(uuid)` with nothing in this repo able to move
  it. A replacement mandate is a new UUID and a new bucket. **A test had pinned that state and
  called it recoverable.** The route is now **ask, book, chain, close**: every refusal is a view
  call and happens before the book moves, so a buyer who cannot withdraw keeps their capacity
  instead of losing it. Closing became a separate act, and an unknown outcome — a write that
  failed, a receipt that never arrived — leaves the mandate open at a zero balance, because
  funding it again is the only route back into the vault and `withdrawn` was what closed that
  route.
- **The path was reached by ordinary use, not by an outage.** `executePayout` debits the vault on
  every Arc-rail trade and nothing decremented `funded_minor`, so after one settle-and-mature the
  book claimed the whole capital while the vault was short by the proceeds — and the next
  withdrawal was refused as `insufficient`, blaming a deposit that had been fine. Maturity now
  retires the commitment on the Arc rail and releases it plainly on x402, the distinction being
  that the buyer's own HBAR paid for one and the escrowed capital paid for the other. **Not at
  settlement:** while a trade is armed the allocation already holds the proceeds out of
  unallocated, so decrementing the book then would count the same money twice.

**The shape is the reason to write this down. `withdrawn` was harmless for exactly as long as
withdrawal moved nothing but a SQLite row.** Wiring `executeRelease` turned a terminal status into
a way of losing money without changing anything about the status. It is the Arc rail's double-spend
and the delist guard again: **a guard that is load-bearing only because some other constraint
happens to hold, with nothing in the guard naming the constraint.** Wiring the mechanism it was
quietly relying on is what makes the hole reachable.

The other five:

- **Withdrawing in sub-unit slices bled the escrow.** The release quantity took `floor()` per
  call, so at 1 ppm any withdrawal under 100 cents released nothing while the book decremented in
  full — five 99-cent withdrawals took a 500-cent book to 5 with the vault keeping everything. It
  is `requiredFor(F) − requiredFor(F − w)` now, which telescopes. The old lemma stays in the
  comment as the explanation of why the invariant held on every single call while the capital
  drained away across them: **measuring the wrong thing, not rounding it wrongly.**
- **Maturity lost its idempotency for a past-due receivable.** The new past-due refusal ran before
  the ledger was read, so a pure replay was 409ed — breaking the property recorded above as
  exercised four times on MF-2046. It reads the ledger first now and declines to guess only when a
  settlement is actually being recorded. **Deliberately not keyed on status:** the seed writes
  `matured` invoices with no outcome rows behind them, so status would have waved a first write
  past the guard.
- **Two receipts contradicted themselves on replay.** `paidAt` was echoed from the request body
  beside an outcome read from the ledger, so a replay could report `on_time` next to a date that
  would have produced `late`; and `declaredAt` on a replayed default reported the replay time.
  Both come from the row that won now.
- **A default freed the debtor concentration it had just lost money on.** `defaulted` sat in the
  closed-status list, so the per-debtor cap reopened on the exact customer that failed to pay
  while `allocatedMinor` correctly stayed consumed — two figures describing different amounts of
  the same money. The list is `CAPITAL_RETURNED_STATUSES` now and holds only `matured`.
- **`settleAtMaturity` bypassed the machine its sibling treats as authority.** A `disputed`
  invoice matured with a 200, an edge the table does not contain. Guarded, after the never-settled
  check so that refusal keeps its better sentence.

Also corrected, and worth knowing wherever an address is checked: **viem's strict `isAddress`
returns true for any all-lowercase 40-hex string** and compares a checksum only on mixed case. The
seeded invented addresses fail it by accident of how they were typed, and the real one takes the
unchecked path. The comment says what it does and does not establish now, and has stopped calling
itself a gate.

**The root cause behind that is closed too, 2026-09-04.** `db/seed.ts` wrote terminal invoice
statuses and debtor counters with no `settlement_outcomes` rows behind them: MF-2031 was
`defaulted` and MF-2029 `matured`, and neither had a settled trade or a ledger row. Both are
incoherent on their own terms — a receivable cannot default if nobody bought it, because the
buyer is who takes the loss, and maturity routes payment to a holder read from the newest settled
trade. Both now have the position their status implies, against the only bid that could have held
them at the time. **No counter moved**: the seed inserts each debtor net of the outcomes it is
about to record and `recordOutcome` puts them back, with a guard that throws if a stated record is
ever smaller than the settlements seeded against it.

`db:seed` is empty-database-only, so the live book needed the same repair by hand. The rows a
fresh seed produces were transplanted rather than recomputed — the ids are UUIDv5 from fixture
labels and were verified identical on both sides — so both books tell one story about the same two
receivables. All five terminal invoices in the live book now carry exactly one ledger row and a
settled trade. Northwind was deliberately left alone: its live counters are legitimately ahead of
the seed because MF-2051 really matured, and copying the seed over would have deleted a real
settlement.

### Resolved: the secondary market, and why the wall was the wrong wall

**Built 2026-09-06.** `sold -> listed` is in the live path. The section below is the
2026-09-04 decision to decline it, kept because **the reasoning that stopped it was wrong in
a way worth being able to find again** — and wrong in this file's own favourite shape: a
mechanism nobody had called, accumulating a confident description of behaviour nobody had
checked.

**The claim was that a relist needs the venue authorised as an ERC-1400 operator, and that no
wallet this build issues can sign that grant.** The second half is true of Privy signers and
irrelevant. The first half is false, and the deployed diamond says so — probed against
MF-2072 (`0x102a2d37…`) rather than reasoned about:

| probed                            | result                                      |
| --------------------------------- | ------------------------------------------- |
| `isOperatorForPartition`          | **exists** — returns a clean `false`        |
| `authorizeOperatorByPartition`    | **exists** — real custom error `0x796c1f0d` |
| `operatorCreateHoldByPartition`   | absent — `0x5416eb98` FunctionNotFound      |
| `controllerCreateHoldByPartition` | absent — `0x5416eb98`                       |
| `operatorTransferByPartition`     | absent — `0x5416eb98`                       |

So the operator surface is **half present**, which is worse than absent: authorising the venue
as an operator succeeds and then has nothing to spend the authority on. It is exactly the
README-role-hash trap — a grant that works and confers nothing.

**The design that works needs no grant at all: the holder places the hold on their own
tokens**, naming the venue as `escrow` and the new buyer as `to`, and settlement executes it
exactly as it does a first sale. Signing needed no new mechanism either — `invoice-registry.ts`
and `mandate-book.ts` already sign Hedera contract calls with `privateKeyToAccount` over the
JSON-RPC relay, and that path is key-agnostic by construction.

What it cost, and what to know:

- **`trades.seller_id` is a hard FK into `sellers`, and a reselling holder is a buyer.**
  Migration `0009` adds `reseller_buyer_id` (FK into `buyers`) and `superseded_at`. `seller_id`
  keeps naming the originator, because that stays true and issuance, the confirmation link and
  the seller-scoped book all read it for exactly that. `parties.ts` holds the fallback once —
  `sellingPartyOf` — for the reason `units.ts` exists: a rule only one caller can find is one
  the next caller gets wrong.
- **`debtorExposure` double-counted, and the invoice status could not fix it.** Two settled
  trades against one `sold` invoice both matched, so the previous holder's mandate kept
  carrying a concentration it no longer had while the new holder carried their own — one
  receivable, two buyers, both charged. `superseded_at` is the filter, and
  `supersedePosition` sets it in the SAME transaction that frees the capital: superseded but
  not released strands a mandate's money, released but not superseded charges it twice.
- **Freeing is rail-dependent, exactly as maturity is.** Arc-vault paper was paid for with
  escrowed USDC that has already left, so the commitment retires with the allocation; x402
  paper was paid in the buyer's own HBAR, so only the allocation returns.
- **Delisting a resale returns the invoice to `sold`, not `confirmed`.** The holder still
  holds it, and `confirmed` would say the receivable is unowned — which is what maturity reads
  to decide who to pay. Both are declared edges, so this picks between two legal moves.
- **The HCS commitment names the party that SOLD**, which on a resale is the holder. No field
  added and no order changed, so every existing receipt still verifies: the field always meant
  "who sold", it just could only ever be one thing before.
- **`RESALE_SIGNER_ACCOUNT_ID` / `RESALE_SIGNER_PRIVATE_KEY` are custody and are named as
  such.** The venue can only resell for a holder whose key it holds, and it refuses at
  **listing** rather than at arm time — the alternative is an invoice that quotes, matches, and
  then fails with `balanceOf` reporting "holds no units", which reads like a broken instrument
  rather than a missing key. All-or-nothing, in the shape of the agent's Hedera pair.

**Still not built: partial position sales**, cut-list item 4. And a holder the venue has no
key for cannot relist, which is a real limit rather than a temporary one — it is the same
self-custody wall, and honest to state.

---

**The 2026-09-04 decision follows, as written then.** It is wrong about the operator grant and
right about everything above the asset leg, which is why it is kept rather than deleted.

**Decided 2026-09-04.** `sold -> listed` stays unbuilt. The edge is in `invoice-machine.ts` and
its comment is right that without it there is one market rather than two — but the reason it
cannot be built here is the same reason seller self-custody was declined, seen from the other
side of the trade.

**`createHoldByPartition` acts on the caller's own tokens.** After a sale the units are in the
buyer's Hedera account, so for a relist the venue is not the holder and a hold would be placed
against its own zero balance. Making it work needs the previous buyer to authorise the venue as
an ERC-1400 operator, and that is three things rather than one: `authorizeOperatorByPartition`
is not in `ATS_ABI`, the grant is a native Hedera transaction, and it has to be signed by the
buyer's own key. **No wallet this build issues can produce that signature** — a Privy signer
prefixes EIP-191 or types EIP-712 and Hedera rejects both, which is already written down above
as the reason the seller's x402 leg is impossible. The buyer's side is the same fact.

So the honest options were a relist that prices and matches but cannot deliver, or none. A
database row that changes owner while the token does not move is precisely the overclaim the
sweep above exists to catch, and it would break the one property maturity depends on:
settlement routes to whoever holds the paper **now**, read from the newest settled trade.

Worth recording, because it is not obvious from the outside:

- **Pricing is already relist-ready and needs no change.** `quote-engine.ts` never reads
  `sellerId`, and tenor is recomputed from `dueAt` against the clock on every quote, so a
  seasoned invoice would price on its shorter remaining tenor with no code at all. That is the
  README's _"sold at 4% on day zero, lists into the same bids on day thirty and clears
  tighter"_, and the arithmetic behind it works today.
- **`settleAtMaturity` and `recordDefault` are already relist-ready**, because both take the
  holder from the newest settled trade rather than from the invoice row.
- **What is not ready is everything that names the seller.** `routes/trades.ts` reads the seller
  off `invoice.sellerId`, which names the originator forever, and it flows into the hold, the
  Arc `registerMatch` — which is one-shot and uncorrectable — and the HCS match commitment,
  which would publish the wrong seller permanently. `trades.seller_id` is also a foreign key
  into `sellers`, and a previous holder is a buyer with no row in that table, so a relist trade
  could not be inserted at all.
- **`debtorExposure` would double-count.** It sums proceeds over every settled trade on an
  unmatured invoice, so after a relist the previous holder's mandate keeps carrying exposure it
  no longer has. `settlement.ts` already names this as the thing `execute` would have to free.
- **The on-chain registry would not block it, and that is itself a gap.** `InvoiceRegistry`
  models `Matched` and `Settled` and refuses `Settled -> Confirmed`, but the venue only ever
  writes `Draft` and `Confirmed`, so the public record is frozen before the point where it would
  have an opinion.

Everything above the asset leg is about a day's work. The asset leg is not a day's work, and
pretending otherwise is how the row moves without the token.

### Provisioning: `pnpm demo:reset`

Modelled on the `gantry` repo's `demo-reset.mjs` — numbered steps matching the header, a
`degraded` flag rather than throws, a cheat sheet printed before the exit code, and the
relayer reported **first** because every step under it spends what it holds.

- **It does not touch `facture.db`, and must not.** Provisioning and seeding are separate
  there and separate here: the book is 35 invoices, 25 settled trades, seven recorded settlement
  outcomes and ten instruments that exist on Hedera, and `db:seed` remains the
  empty-database-only path.
- **The attester is the relayer.** It holds the float on Arc and tops up the seller and the
  buyer's wallet toward target balances. It cannot refill itself — Arc testnet has no faucet
  this script can call — so a dry relayer is a loud warning rather than a fix.
- **It refuses to send money to an address it cannot verify.** Four seeded parties carry
  invented addresses; topping them up would not fail, it would succeed and burn testnet USDC
  into addresses nobody holds a key for. The seller is verified by **derivation** from
  `HEDERA_OPERATOR_KEY`; everything else must pass an EIP-55 checksum, which catches all four
  because they were typed rather than generated. **That is an accident, not a proof**, and a
  fabricated address with a correct checksum would still get through.
- **It never transfers downward toward a target.** A script that pulled balances down could
  silently undo a rehearsal someone is halfway through.
- **It does not deposit into the vault on the buyer's behalf.** `deposit` pulls from
  `msg.sender`, so a relayer-funded deposit credits the mandate with the venue's money while
  the deployment record calls that capital the buyer's own. `--deposit <usdc>` overrides it
  and labels the result.
- **Invented addresses are reported, never degraded.** Making every run red teaches the reader
  to ignore the colour.

Its first run fixed the live blocker — the seller held **zero** USDC on Arc, and
`DvpEscrow.claim` is beneficiary-only while Arc gas is USDC — and registered Harrow Point's
second mandate, which closes the `registerMandate` finding above: that function had no caller,
so no mandate created through the API could ever be escrowed.

### Corrected: Privy signs two things, and neither is the cash leg

**This section was headed "Privy signs exactly one thing" until 2026-09-12, when a second
arrived: a party's own `ProfileUpdate` on `PartyRegistry`. The count has moved and the boundary
has not.** Both are things a person signs about themselves or to collect money already bound to
them — never a trade, and never the settlement path. The seller still signs nothing to sell.

The x402 half below is unchanged and still true.

**The "onboarding and only onboarding" boundary above was drawn for a reason that does not
cover the Arc rail, and it has moved by exactly one transaction (2026-09-03).**

The reason still stands where it was aimed: a Privy signer **cannot** produce the x402 cash
leg, which is a native Hedera `TransferTransaction` and not EIP-712 or `eth_sendTransaction`.
Nothing about that changed.

What changed is that a second cash rail exists. A sale settled out of the buyer's escrow does
not pay the seller's wallet — it opens a `DvpEscrow` lock, and **`claim` checks
`msg.sender == beneficiary`**, which `MandateVault.test.ts` asserts by refusing the attester
while it holds the public preimage. So the venue cannot collect for a seller under any
circumstances, and the only key that can is the one Privy made at sign-in.

- **Arc is now declared to Privy; Hedera still is not.** The old comment refused to declare
  chains because the app transacted from no wallet. It transacts from one now, on one chain,
  for one call. Hedera stays undeclared because nothing a Privy signer produces is useful
  there.
- **The seller still signs nothing to sell.** Not to list, not to be matched, not to settle —
  the venue holds the paper and places the hold. They sign only to collect money already bound
  to their address on chain, after the trade is done. That is the boundary the original
  decision was protecting, and it is intact.
- **Neither the preimage nor the escrow address is a credential.** `claim` needs the caller as
  well as the hash, and the escrow writes the preimage to storage in the clear the moment
  anyone claims. Publishing both is what makes the payout claimable at all; withholding the
  first once already cost a payout.
- **The button renders for nobody else**, and each refusal is a separate fact: a claimed or
  refunded lock, a missing preimage or escrow address, a wallet that is not the beneficiary.
  Offering a claim that reverts is worse than offering none.

This also satisfies the Privy tracks' "at least one Privy control" requirement — but the
reason to build it is that a seller could not otherwise be paid, and the requirement is
downstream of that.

### Resolved: the deployed gate refused everyone, and nothing could tell

**`AtsComplianceGate` did not merely have no caller. It was wrong, and it would have stopped the
venue trading the moment anything called it** (2026-09-06). It probed `isPaused()`,
`isAuthorized(address)` and `getKycAccountStatus(address)` — the three selectors this file has
recorded since 2026-09-02 as **not existing on a deployed ATS diamond**. Each reverts
`FunctionNotFound`. The gate fails closed by design, so three missing selectors collapsed into
`COMPLIANCE_PROBE_FAILED` and it answered `(false, COMPLIANCE_PROBE_FAILED)` for **every buyer
on every instrument**.

Read off MF-2051 (`0xb50567e02baaf768c834b0663f539db43d5b34b0`) against the buyer at
`0.0.10314099`, whose control list and KYC both say yes:

| probed                       |        | the real one             |                    |
| ---------------------------- | ------ | ------------------------ | ------------------ |
| `isPaused()`                 | revert | `paused()`               | `false`            |
| `isAuthorized(buyer)`        | revert | `isInControlList(buyer)` | `true`             |
| `getKycAccountStatus(buyer)` | revert | `getKycStatusFor(buyer)` | `1` (GRANTED)      |
|                              |        | `getControlListType()`   | `true` (allowlist) |

The old gate refused that buyer. The corrected one permits them.

- **`services/compliance.ts` was correct the whole time**, having been fixed against live paper
  on 2026-09-02. Two halves of one fact, maintained separately, and **the on-chain half was the
  one a third party would call.** That is the split-vocabulary failure this file keeps warning
  about, in its most expensive form.
- **The unit tests passed against a fiction.** `MockAtsSecurity` implemented the same three
  wrong selectors, because it was written from the same misreading as the contract. A fake that
  agrees with the code under test cannot contradict it, and a mock is only evidence about
  behaviour the mock did not choose — selector names are not that.
- **Failing closed is what hid it.** The design's own header sells "a selector that has drifted
  produces a named refusal, never a silent `true`", and that is true and was the right trade.
  What it cannot do is distinguish a _wrong_ selector from an unreachable instrument. Only a
  call against real paper does that, and only once something calls it.
- **Membership is not permission, and the old contract said otherwise in a comment.** It claimed
  `isAuthorized` "already resolves whitelist-versus-blacklist mode internally". It does not
  exist, and had it existed as imagined, reading membership alone still admits exactly the party
  a blocklist excludes. The control list is two probes now, and both must succeed: a readable
  membership bit beside an unreadable mode is not half an answer.
- **KYC is compared against `GRANTED` exactly**, not `!= 0`, which would read every status ATS
  adds later as a valid grant.
- **`PROBE_GAS` is now measured rather than asserted** — the four probes estimate at 49.5k–64.5k
  including intrinsic, so 150k is about 3.4× the dearest.

**The corrected gate is `0x6d78847e4ac257da68909c5a4c60ea1dcc060564`**, Sourcify `exact_match`,
and `MandateBook.setComplianceGate` now points at it. The broken one is still live and still
verified, deliberately — an address found in an old note should be identifiable rather than
mysterious, and verifying it is what lets a reader see for themselves what it did.

**The venue reads it, and the gate decides.** A cross-check that changes no outcome is
decoration. But handing a contract the decision is exactly the risk this finding is about, so
the direct facet reads were demoted rather than deleted: the gate permits and it is one read
instead of four; the gate refuses and the facets supply the sentence, because a reason code is
not something a seller can act on. **If the gate refuses while the facets permit, the trade is
refused and marked indeterminate** — settlement must not move on a contradiction, and a
contradiction is not a fact about the buyer either. That branch costs nothing on the happy path
and would have named this bug on the first trade.

Two things fell out of the redeploy that were separate faults:

- **`deployHedera.ts` redeployed `UniquenessRegistry` unconditionally**, against its own comment
  saying it must outlive a book upgrade. A second run would have minted an empty registry and
  either silently abandoned every claim or made the deploy a no-op nobody noticed. Every
  contract can be reused now, and a reused book is checked against the registry and escrow it is
  actually bound to, because both references are immutable.
- **Wiring authority came from `FACTURE_OWNER` rather than from the chain.** They disagree here:
  the live book's `owner()` is the operator key while the env names another address, so every
  wiring call was skipped with a message telling the reader to run them from a key that holds no
  rights over the book.
- **`verify.mjs` sent whichever build-info `readdirSync` returned first** to every contract.
  Hardhat 3 emits one unit per root source, so the directory holds nineteen and "first" is
  arbitrary; it reported `Contract not found in compiler output` for a contract deployed from
  that very tree.

### Resolved: the chain answers on the match the venue is arming

**`MandateBook` is in the live path as of 2026-09-06**, five days after it was deployed. Three
calls: `postMandate` when a mandate is created, `creditFunding` when it is funded, and
`previewMatch` when a trade is armed.

**`previewMatch` is what makes wiring the book worth doing, and it costs nothing.** It reads the
rating, the confirmation status,
the due date and the face value **out of `InvoiceRegistry`** rather than from whoever is asking
— which is what `IInvoiceRegistry` means by "rating below floor only means something if the
rating is not supplied by the party who wants the match to succeed". Everything else on the arm
path is the venue checking its own homework. This is the one verdict there that the venue
cannot have arranged.

Verified live against all seven mandates and the eight invoices with real instruments. It is not
a rubber stamp: MF-2072 is refused by five of seven on `RATING_BELOW_MANDATE` and taken by the
two with an `UNRATED` floor, which is the same shape as the agent's own run; MF-2071 at 99 days
is taken only by the two 120-day mandates; MF-2070 at 59 days is refused by the 30- and 45-day
ones. MF-2046, MF-2051 and the second MF-2052 answer `INVOICE_UNKNOWN`, because they predate the
registry wiring and were never listed on it.

- **It decides nothing, deliberately.** The book **floors** the discount where
  `@facture/shared` **ceils** it, and computes tenor as `ceil` off `block.timestamp` where the
  venue counts UTC midnights. So the two legitimately differ by a minor unit, and sometimes by a
  whole day of discount, on an invoice both would happily match. Measured: on MF-2072 the book
  prices 392,094 against the venue's 392,093. Refusing on a price mismatch would reject good
  trades for a rounding rule. **Compare the reason code, not the number**, and render a
  disagreement rather than resolving it.
- **Its exposure refusals are a floor, not a mirror, and this is structural.** `_debtorExposure`
  and `allocated` are written by `tryMatch`, which is not wired, so the book evaluates every
  concentration and exposure test against **zero recorded exposure**. Seen live on MF-2080: the
  venue refused mandate 4 with $5,035.62 left against a $40,000 cap, and the book took the same
  match, because as far as it knows that mandate has spent nothing. It still refused mandate 5,
  whose cap is smaller than the price at its own rate — so the check is real, it is just weaker
  in one direction. **`RATING_BELOW_MANDATE`, `TENOR_EXCEEDS_MANDATE`, `INVOICE_UNKNOWN` and
  `INVOICE_NOT_CONFIRMED` are the verdicts worth reading**, because those are the ones measured
  against `InvoiceRegistry` rather than against a balance nothing updates.

- **Three states, never two.** No book configured, a mandate never posted, and a node that would
  not answer are all `checked: false`. Folding any of them into `ok: false` prints a refusal the
  chain never made — the `/health` cursor mistake, `ComplianceDecision.determinate` and the proof
  view's registry block, in a fourth place.
- **`mandates.chain_mandate_id` (migration `0008`) is the join, and it exists here or nowhere.**
  The book MINTS its ids (`++_mandateCount`, no way to supply one); the Arc vault keys capital by
  `uint256(keccak256(uuid))`; the book cannot read Arc and the vault never looks at the book.
  `arc.ts` has carried a warning since it was written that anything posting these mandates would
  have to reconcile the two rather than assume they line up. Without the column a mandate is
  unaddressable the instant the posting transaction returns.
- **Amounts are cents, never USDC.** The book prices from the registry's `faceValue`, which
  issuance lists in the invoice's own minor units, so `EXPOSURE_EXHAUSTED` compares like with
  like. Crediting the vault's 6-decimal figure would put a ppm-scaled number beside a cents one
  on a contract nobody can patch — the `units.ts` defect, reproduced where it is permanent.
- **The venue is the on-chain buyer of every mandate it posts**, because `postMandate` sets
  `buyer = msg.sender` permanently and the real buyers hold no Hedera key. What the book records
  is the venue's standing bid on their behalf. That is also why `authoriseRelease`, which is
  buyer-only, is not wired.
- **`depositRefFor` is the venue's reference, not the vault's.** The book's replay guard was
  designed around a `depositRef` minted inside `MandateVault.deposit`; the buyer deposits from
  their own wallet and the venue observes a balance rather than a deposit, so that reference is
  never seen here. Keying on the mandate and its new cumulative total keeps the guard doing
  something real — this venue cannot credit one funding state twice — while establishing nothing
  about the vault having minted anything. Reading it as the stronger claim would be replay
  protection removed while it still looks present.
- **`scripts/post-mandates.mjs`** covers the seven mandates that predate the wiring; the routes
  cover everything after. All seven are on the book, credited, and answering.

**`tryMatch`, `confirmSettlement`, `confirmMaturity` and `authoriseRelease` stay unwired**, and
the reason is the next section.

### The whole path has run against one receivable

**MF-2080, 2026-09-06.** Created, issued as `0.0.10391953` on the first attempt, confirmed by its
debtor **through the link the venue minted**, prepared, listed, quoted at $19,813.69, sold out of
the Arc escrow with no challenge, claimed by the seller with their own key, matured `on_time`, and
paid at par by the collection account. Every step in one sitting, on one invoice. The record is in
[docs/deployments.md](./docs/deployments.md).

Three things it established that nothing else had:

- **The mandate book's verdict rode on a live settlement response** —
  `{"checked":true,"ok":true,"priceMinor":"1981370"}` beside the venue's own 1,981,369. The
  floor-versus-ceil divergence, published rather than reconciled, on a receivable neither side had
  seen before.
- **Maturity retires the Arc commitment and the buyer re-commits.** `funded_minor` fell 3,757,466
  to 1,776,097, and re-funding needed no new deposit because the USDC was still in the vault. The
  book answered `already-credited`: `depositRefFor` keys on the mandate and its cumulative total,
  and that total had been credited before. The replay guard doing its job in ordinary business
  rather than in a test.
- **The customer's rating did not move.** Eight settlements on time and one late still reads `B`,
  which is what keeps the two tighter A-floor bids out and lets the escrowed mandate win at 850 on
  merit. Ratings are earned slowly, and that is visible rather than asserted.

**Selecting the customer is what makes this demonstrable at all.** A B rating excludes the two
A-floor mandates, which are also the two tightest bids, so the one mandate with capital actually
posted on Arc wins without anything being removed. Pick an A-rated customer and the venue is
perfectly correct and routes to x402, and the escrow, the seller's claim and the maturity payout
are all untouched.

MF-2081 (`0.0.10392519`) is the same invoice made again and left listed, so the demo still has
something to sell.

### Declined: wiring `MandateBook.tryMatch`

**Considered and refused 2026-09-06.** The book evaluates every exposure and concentration
test against zero recorded exposure, because `_debtorExposure` and `allocated` are written by
`tryMatch` and nothing calls it. Wiring it looks like the obvious way to make those refusals
mean something. It would make the book worse.

`tryMatch` strikes a match through `_commitMatch`, and the only paths that decrement what it
writes are `confirmSettlement` (needs a **claimed Hedera `DvpEscrow` delivery lock** — the
escrow declined below), `cancelMatch` (needs `_isSettler`, or waiting out the immutable
`settlementWindow`) and `confirmMaturity` (needs `Settled`, unreachable without the first).
So every match struck would sit `Open` **forever**, permanently inflating on-chain exposure,
and the book would drift out of step with the venue with no way back. `mandate-book.ts` says
this in its own header and is right.

It is also this file's recurring shape, stated at the `withdrawn` finding: _a guard that is
load-bearing only because some other constraint happens to hold._ `_evaluate` refuses with
`INVOICE_ALREADY_ALLOCATED` once `_matchOfInvoice[invoiceId]` is set — a branch that has never
fired, because `previewMatch` is `view` and never sets that slot. Wiring `tryMatch` makes it
reachable for the first time.

**`previewMatch` alone is the correct design**, and the verdicts worth reading stay the ones
measured against `InvoiceRegistry` rather than against a balance nothing updates:
`RATING_BELOW_MANDATE`, `TENOR_EXCEEDS_MANDATE`, `INVOICE_UNKNOWN`, `INVOICE_NOT_CONFIRMED`.

### Resolved: a party says who they are, and signs it

**Built 2026-09-12.** `PartyRegistry` — `0x1C9882714e1ae2555531E1a7eb4E83EBeCA8B2ca` on Hedera,
Sourcify `exact_match` — records what each address says about itself. It is the eighth deployed
contract and **the first the venue does not author**, which is the whole reason it exists.

The gap it closes was in two layers and the on-chain half was worse. On screen, `/book` called every
seller "Your business" and `/mandates` called every funder "Your desk" — two hardcoded literals in
`api-source.ts`, above a comment saying no response carried a name and there was no session. Both
halves of that had stopped being true and the literals outlived them, so the fixture book was the
only place a company was ever named. Underneath, `/proof` published `sellerName`, `buyerName` and
`debtorName` all `null`, and `MandateBook.postMandate` records `buyer = msg.sender` — the venue —
on every standing bid. The market was anonymous to everyone including its own participants.

- **A record can only be written by the key it describes.** The party signs an EIP-712
  `ProfileUpdate`; anyone may relay it; the contract writes whoever the signature recovers to.
  There is no owner, no permissioned writer, and no way for this venue to fill in a profile on
  somebody's behalf. Altering one byte produces a signature recovering to a different address, so a
  forgery writes a stranger's profile rather than the one it was aimed at.
- **The party needs no gas, which is what makes it usable.** A wallet made from an email address
  holds no HBAR on Hedera and no USDC on Arc. Proved rather than argued: a freshly generated key
  holding **nothing** signed, the operator relayed, and the record landed under the signer's address
  while the relayer's stayed empty. `gasUsed` 134,962, transaction `0x6e4781dd…`.
- **The EIP-712 type has one authority**, `@facture/shared/registry/party.ts`, because three
  implementations must agree on it — Solidity verifies, the browser signs, the backend relays. A
  disagreement is not a type error anywhere; it is a valid signature over the wrong message. **Field
  order is a promise**: reordering invalidates every signature in flight and every `recordHash`
  emitted, and a test pins the ordering against the contract's own type string.
- **Roles are a claim, never a permission.** `ROLE_SELLER | ROLE_BUYER` as a bitmask, and a party
  may hold both because selling your own receivables and funding other people's is an ordinary
  combination. Holding `buyer` authorises nothing — capital is still the Arc vault's, eligibility is
  still each instrument's `ControlList` and `Kyc`. An undefined role bit is **refused** on chain
  rather than masked off, and reported rather than dropped when read back.
- **Only what a counterparty would check goes on chain** — roles, display name, legal name, country,
  website, and a `metadataHash` committing to the rest. Email and anything personal stay in the
  venue's own store. The same call the refusal topic already makes by publishing a digest instead of
  the sentence: a public ledger is a poor place for a business's contact book.
- **This closes the provisional-name gap recorded above.** `provisionalName` turns an email domain
  into a label because a sign-in has nothing better to go on, and this file has carried
  _"correcting it needs a route that can change it, which does not exist"_ for over a week. It
  exists now, and the correction is stronger than a text field: the name the venue stores is the
  name the party **signed**, and the same string is on a public chain.
- **A chain that is down costs the public copy, not the profile.** `recordProfile` never throws, in
  the shape `ensureMandateRegistered` established, and answers one of four states — `recorded`,
  `refused`, `unavailable`, `not-configured`. A 200 from `POST /v1/parties/me` does **not** mean the
  chain took it, and a screen reading the status code alone would tell somebody their profile is
  public when only half of it is.
- **`getPartyRegistry()` defaults to disabled rather than throwing**, which is `getMandateBook`'s
  shape and not the one most services here use. `GET /v1/parties/:address` is public, and a boot
  order that had not reached `initPartyRegistry` would turn a question anyone may ask into a 500
  describing an internal wiring mistake.

### The Privy policy denied signing, and nothing would have said so

**Found before shipping, from the docs rather than from a failure.** Privy denies any RPC method no
rule names — _"a policy must include rules for all intended RPC methods… otherwise usage will be
denied"_ — and the pinned policy had exactly one rule, `claim` on `DvpEscrow`. So it **denied
`eth_signTypedData_v4` outright**, and a seller carrying it could not sign a profile at all. The
refusal happens inside the wallet, so there is no transaction to inspect and the venue cannot
distinguish it from a party who has not got round to it yet.

- **The rule was added in place** rather than as a second policy — `privy:policy sync` does it with
  `PATCH /v1/policies/{id}`, same id, so every wallet already carrying it is under the new rules
  without re-attaching. **The stated reason was wrong and the decision was still right.** Privy's
  documentation says only one policy is supported per wallet, and this file asserted that as
  settled; `attachWalletPolicy` writes `policy_ids: [...held, policyId]` and a test asserts a
  two-element array reaching the wire, so the code assumes several are possible. The two have not
  been reconciled and nothing here has observed which is true. Editing in place is the safe
  behaviour under either, which is why the conclusion stands — but it rests on that, not on the
  one-policy claim.
- **The live policy `ptcr8aqgtayakw2gnce5sgie` now carries both rules**, the second scoped to
  `verifyingContract` and `chainId` — one contract, one chain. The key went from one permission to
  two, each naming one contract and one action; it did not become a general-purpose key. This is a
  stronger answer to the Privy tracks' "at least one control" than the single rule was.
- **The first PATCH failed and the failure is the useful part.** Sending the whole spec body was
  refused with `Unrecognized key(s) in object: 'version', 'chain_type'`. Those are create-time facts
  about a policy and an update may not restate them, so the update surface is genuinely narrower
  than the create surface. Learned from the live API, not reasoned out — which is exactly why this
  module passes Privy's own words through instead of summarising them.
- **The verifying contract is lowercased on both sides.** EIP-712 hex-decodes an address so case
  cannot move the digest, but Privy compares this value as a **string**. A checksummed domain
  against a lowercased rule is a seller who cannot sign, failing at the wallet with nothing to
  inspect. The same trap the `to` condition already documents, one field over.

### The review of the party registry, and the hole it found

**Five reviewers over the working tree, 2026-09-12, before any of it was committed.** Three
converged on the same defect and it was a security hole in code written that morning. Recorded
because the shape is one this file already tracks, and because two of the claims in the sections
above were wrong when written.

**The venue never verified the signature.** `PartyRegistry` was the only verifier, and
`recordProfile` never throws — so `routes/parties.ts` computed a `recording` it did not branch on
and ran the upserts regardless. A signed-in caller could present sixty-five bytes of nonsense with
any name they liked, watch the chain revert, and get a 200 and a renamed business. The comment
above the call claimed the ordering prevented exactly that, which it could not: **ordering a call
whose failure is a return value buys nothing, and only a check or a branch does.** Every test used
`'ab'.repeat(65)` against a fake that accepted anything, so the suite could not see it.

- **`recoverProfileSigner` is the fix, and it is better than a branch.** The signer is recovered
  locally with viem before anything is relayed, so authorisation stops depending on whether Hedera
  is reachable — which is what lets the rows be written on `unavailable` — and a signature nobody
  produced never costs the operator a transaction. A `refused` recording now returns early and
  writes nothing.
- **A refusal is a type.** `RegistryRefusal` replaced `detail.includes('refused that profile
update')`, a substring match against user-facing prose thrown one function away. Rewording the
  sentence would have reclassified every contract refusal as an outage with the suite still green,
  and the test for it constructed that sentence by hand — both halves of one contract compared
  against independent copies of a string. It also missed reverts surfaced at `writeContract` rather
  than in the receipt, so a stale nonce was reported as "nothing was lost, try again".

**`createPartyRegistry` was constructed by no test in the repo.** The real client holding the ABI,
the gas, the receipt check and the profile decoder had zero coverage; everything ran against a
hand-written fake, which cannot contradict an ABI it does not have. That single fact explains all
three defects above. `test/party-registry-encoding.test.ts` now pins the `updateProfileFor`
selector against an independent spelling of the Solidity tuple, and every `Profile` field by name —
that struct ends in three consecutive strings and carries two adjacent `uint64`s, so transposing
any neighbouring pair decodes cleanly and renders a lie. Both pins were mutation-checked.

**Three of my own comments asserted checks that did not exist.** The EIP-712 table was described as
"pinned against the contract's own type string" in three places; all three pins were hand-typed
literals, so nothing anywhere compared the table clients actually sign from against the contract.
`packages/shared/test/registry/party.test.ts` now reads `PartyRegistry.sol` off disk, the way
`agent/test/reason-codes.test.ts` already did, and it was checked by renaming a field in the `.sol`
and watching it fail. **A confident comment about a behaviour nobody has verified gets more
confident with age rather than less**, which this file says about other people's code and had not
yet had turned on its own.

Also found and fixed: the length caps counted UTF-16 units while the contract counts bytes, so a
thirty-character Japanese name passed the API and reverted on chain; the signature field was
unbounded on a route that spends operator gas; `MemoryStore` and `SqliteStore` disagreed about
email casing, which could have put two rows behind one unique index; and the storage comment in
`PartyRegistry.sol` said slot 0 when OpenZeppelin's `EIP712` puts the mapping at slot 2.

**On the web side this workstream had not left a gap, it had made an existing one worse.** A failed
buyer sign-in was swallowed by an empty catch. While the screens still said "Your desk" that cost
nothing; once real party names were resolved it rendered the seeded demo desk's **real company
name, capital and exposure** as the viewer's own. It is a third state now — `resolving | resolved | unresolved` — and
the masthead says so. Separately, `reload()` ran only on a successful save, so a relay that
succeeded on chain and then failed over HTTP left the nonce consumed and every retry refused, under
a message saying signing again would fix it.

### Resolved: the buyer is a party this venue can onboard

`POST /v1/buyers` exists, mirroring sellers: identity token only, idempotent on the verified email,
a wallet address filled once and never rebound. `Store.getBuyerByEmail` and `updateBuyerWallet` were
missing on both store implementations and are there now.

- **`buyerId()` reads the session first**, so signing in changes `/mandates` as well as `/book`. It
  was configuration-only before, which was the sharpest version of the identity problem: a viewer
  was two different companies at once and could only change one of them.
- **Sign-in calls both routes**, because both are idempotent on the same verified email and the
  alternative is resolving a buyer id only after a profile is signed — rendering a stranger's
  mandates until then. The cost is an empty desk for somebody who only ever sells. The buyer half
  runs after the seller half and cannot fail the session.
- **The buyers route does NOT attach the seller's claim policy**, and says so at length. That policy
  scopes a wallet to `claim` on `DvpEscrow`, which checks `msg.sender == beneficiary` and is a
  seller's call. Copying it would authorise the one call a buyer can never make and none it needs —
  the README-role-hash trap, where a grant succeeds and confers nothing. A buyer-side policy is
  separate work.

### Still anonymous: the proof view

`/proof` still publishes `sellerName`, `buyerName` and `debtorName` as `null` on the live path, so a
settled trade's public receipt names no party. The registry that would answer it is deployed, wired
and read by three screens — but the proof service has not been changed to ask. Written down here so it is
not found by surprise later: it is the one place the anonymity finding above still stands, and what
is missing is the call, not a decision about how to make it.

### The Arc tracks require an architecture diagram

Read off the ETHOnline prize page 2026-09-06, and **not previously recorded here**. All three
eligible Arc tracks — Best DeFi/Onchain Finance, Best Agentic Economy with Circle Agent Stack,
and Launch on Arc Testnet & Push to Mainnet — carry the same qualification requirement:
_"Functional MVP and diagram: Projects must demonstrate a working frontend and backend plus an
architecture diagram."_

`docs/architecture.md` is that diagram: four Mermaid figures, which GitHub renders natively, so
a judge sees a picture rather than source. The page also confirms the rest of what this file
already records — the Launch track is $3,500 with $2,500 first and $1,000 second and carries no
Continuity-only badge, and _"deployed or deployment-ready on Arc mainnet by September 30"_ is
the clause as written.

### Declined: the Hedera delivery escrow, and the wall it hits

**The Hedera `DvpEscrow` (`0x35a8a43d…`) is the one deployed contract with no caller, and it
stays that way.** Like the secondary market and seller self-custody, this is a stated position
rather than an oversight.

Its only designed reader is `MandateBook.confirmSettlement`, which demands a **claimed delivery
lock** whose `depositor`, `beneficiary` and `asset` equal the match's seller, buyer and
instrument. This venue's asset leg is an **ATS hold**: `createHoldByPartition` moves units from
free balance to held balance and they never leave the seller's ledger entry. Producing the
escrow's proof instead would require, all of it:

- **Moving a regulated security into the escrow contract.** `openLock` does
  `safeTransferFrom(seller → escrow)`, so the escrow address must be on the instrument's
  `ControlList` and hold a KYC grant. It is on neither, on any instrument the venue has issued —
  and adding it means the venue asserting a KYC credential about a smart contract, on every
  receivable it ever lists, because every receivable is its own diamond.
- **The buyer signing `claim`.** `claim` checks `msg.sender == beneficiary`. Six of seven
  mandates have no Hedera key. Same wall as the x402 seller leg and the declined relist.
- **A timeout neither rail satisfies.** `MIN_LOCK_DURATION` is 900 seconds; the x402 challenge
  window is 180 and `VAULT_HOLD_WINDOW_SECONDS` is 720. Raising the x402 window fivefold means
  an unpaid trade holds the seller's whole position five times as long.
- **An ERC-20 facade this repo has never exercised.** `ATS_ABI` carries no `approve`,
  `transfer` or `transferFrom`, and `DvpEscrow.test.ts` opens every lock against `MockUSDC` with
  `LegKind.Payment` — `Delivery` is declared and used nowhere. Given `deployBond`'s wrong
  selector and the three dead compliance selectors, the facade's behaviour is **unestablished**,
  not merely untested.
- **An ordering that contradicts the venue's.** `IDvpEscrow` requires the secret's generator to
  lock first with the longer timeout; the venue generates the secret and its Arc payment lock
  runs a day. A Hedera delivery lock would have to be second and shorter — but `settleFromVault`
  puts the asset leg first on purpose, because reversing it leaves the buyer holding paper
  nobody paid for.

**And the hashlock protects nobody here.** On Arc it is load-bearing: the venue cannot claim for
a seller, and the seller's key is a Privy wallet the venue does not hold. On Hedera the venue is
simultaneously the seller, the hold's escrow and the attester, so adding a hashlock inserts a
party who must now sign to receive delivery in exchange for protecting the venue from itself.
The ATS hold already gives four of the escrow's five properties — units immobilised, only the
named escrow may execute or release, destination pre-bound, expiry — **without the paper leaving
the holder's ledger entry**, which is the only reason the compliance problem above exists.

`FACTURE_DELIVERY_ESCROW` exists in `packages/contracts/.env.example` and is a **deploy-time**
variable only: it lets a redeployed book bind to the existing escrow rather than orphan it. The
backend has no env var, no ABI entry and no code path that can address it, and should not
acquire one without the five things above.

### Contracts are verified on Sourcify

`pnpm --filter @facture/contracts verify`. All seven read `match: null` before it; HashScan's
badge is a Sourcify lookup, so publishing there is what lights it, and the Tokenization track
asks for exactly that. Confirmed in a browser: HashScan renders `UniquenessRegistry ·
VERIFIED`. **Sourcify indexes Arc testnet too**, which was not expected.

Two traps worth keeping. **`server-verify.hashscan.io` is retired** — it answers 308 to
`sourcify.dev/server` and drops the path, so a direct query returns a bare `Cannot GET /` that
reads like a broken endpoint. And **Hardhat 3 prefixes source names with `project/`**, which
Sourcify matches exactly, so `contracts/Foo.sol:Foo` matches nothing.

No `hardhat-verify` plugin: a new dependency here brings an unapproved build script that
breaks `pnpm -r`, and Sourcify's v2 API takes the standard JSON `artifacts/build-info` already
holds.

### Resolved: 82 environment variables, of which 63 were decisions

Every variable in every `.env`, audited 2026-09-12. Asking the usual question first — what
reads this outside its own schema — found almost nothing: **only two variables had no reader
at all**, and the eight whose only readers were `env.ts` and `index.ts` each traced to a real
consumer. The sweeps recorded above had already reached the env layer. Four other defects had
not been looked for, and the first of them could produce a wrong answer rather than noise.

**Five contracts each carried two env names across two packages.** `FACTURE_MANDATE_BOOK` in
`packages/contracts/.env` and `HEDERA_MANDATE_BOOK_ADDRESS` in `packages/backend/.env`, and
so on for the vault, the gate and both registries. They held identical values and **nothing
checked that they did** — a redeploy updates the contracts side and the backend's copy is a
manual paste. The failure is not a crash: the venue keeps running and reads the _previous_
deployment, which here means the superseded `AtsComplianceGate` that refused every buyer on
every instrument. **A stale address reads as a compliance bug rather than a configuration
one**, which is the most expensive kind of wrong answer this codebase can give.

- **`chains/deployments.ts` pins them**, beside the chain constants already pinned for
  exactly this reason — `chains/index.ts` has said since it was written that nothing outside
  that directory should carry a chain id or a token address as a literal. A deployed contract
  is the same kind of fact. The backend and the agent read the pin.
- **`packages/contracts` keeps its `FACTURE_*` variables, and that is not a half-finished
  collapse.** They mean something different: _"reuse this one instead of deploying a new
  one"_, an input to a deploy-time decision where **unset means deploy fresh** — which
  `deployHedera.ts` documents as the way to point a fresh book at an existing registry. A pin
  cannot express that. What is gone is the runtime copy, which is the one that could go stale
  without anyone looking.
- The package also gets no dependency on `@facture/shared`, deliberately: a workspace import
  would put the Hardhat build behind another package's build. Two literals are repeated there
  with a pointer at the authority instead.

**Twelve knobs were not decisions.** `HOST` went because every platform that would host this
injects `PORT` and none injects an interface to bind. `PORT` stays for that same reason, so
the asymmetry between the two is deliberate. `X402_PAY_TO` was a second copy
of `HEDERA_OPERATOR_ID`: the venue is paid where the venue signs, and the only thing a
divergence could express is a challenge naming an account that does not hold the paper being
sold. `X402_ASSET_DECIMALS` is 8 because HBAR is 8, which is a fact about the ledger.
`CONFIRMATION_TOKEN_TTL_HOURS`, `X402_SUPPORTED_TTL_SECONDS`, `CIRCLE_BASE_URL`,
`ARC_BLOCKCHAIN` and `AGENT_HEDERA_NETWORK` had one reachable position each.

**`ATS_REGULATION_TYPE` is the one worth knowing about.** It offered three positions and all
35 invoices in the live book read `reg-s`; the choice is recorded above as settled and no
longer reversible, because deployed instruments carry it. **A declaration cannot be corrected
afterwards, which makes it the worst thing to leave a deployment able to change by accident.**
The three-way mapping onto the factory's enum pairs stays in the schema and stays pinned by a
test — what is fixed is which one this venue declares, not the vocabulary.

**`X402_ASSET_MODE` is gone, and it deleted a working branch.** `hts` was a position no client
here could occupy: an HTS asset needs a receiver-side association nothing in this build
performs, and the agent reads the challenge off the facilitator's `payment-required` header
and refuses a non-HBAR one by name **before** signing. A venue configured into `hts` would
have quoted challenges nobody could pay. `X402_HTS_ASSET_ID` went with it, and so did the
cross-field rule guarding the half-configured pair — the state it protected against can no
longer be expressed. **The agent keeps its own check**: it is a client of x402 rather than of
one venue, so what a payer is asked for is not this repo's to assume.

**Twenty-two lines in the local `.env` files restated their own default**, three of them
looking like overrides and not being — `ISSUANCE_GAS_LIMIT=10000000` against a default written
`10_000_000`, and `ARC_MAX_FEE_PER_GAS_GWEI=20` against `arc.minMaxFeePerGasGwei`. Only
`LOG_LEVEL=debug` and `AGENT_ONCE=true` were real. Those files are gitignored, so this is the
one part of the audit no commit records.

**What was deliberately kept**, because each looked prunable and is not: the four `ISSUANCE_*`
knobs, which are what an operator turns when Hedera throttling bites and that risk is still
open; `ARC_MAX_FEE_PER_GAS_GWEI`, an escape hatch with no fallback under it;
`X402_SETTLEMENT_SCALE_PPM`, already refused a rename for the `DATABASE_URL` reason;
`FACTURE_DELIVERY_ESCROW`, inert and preserving a cheap revival path; and
`NEXT_PUBLIC_SELLER_ID`, which looks like two sources for one decision and is not —
`identity.ts` states the order and names the fallback as the demo account.

**`.env.secondbuyer` was not configuration and is now labelled as such.** Nothing read it; it
holds Kestrel Working Capital's key, used by hand for the first resale because the Arc deposit
pulls from `msg.sender` and the Hedera allowlist grant needs the buyer's own signature. It is
now `.env.kestrel-key-custody`, kept rather than deleted: **it is the only copy of the key
controlling 400,000 units of `0.0.10363420`**, and moving it into `RESALE_SIGNER_PRIVATE_KEY`
would make the venue custodian of a second buyer's position, which is a decision and not a
convenience.

Verified by booting the venue on the fourteen-line `.env` and pricing the live book, not by
typechecking: MF-2081 quotes 850 bps with nothing barred, and `canReceive` at the pinned gate
answers `true` for the buyer that quote names.

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
