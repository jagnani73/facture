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
2. **Arc "Launch on Mainnet" track eligibility. RESOLVED 2026-09-02 — Circle confirmed a
   from-scratch entrant is eligible.** The track is open to this project — **$3,500, not
   the $5,000 recorded here originally; corrected against the prizes page 2026-09-03.** Do not
   relitigate it from the page copy, which is what made it look closed: every "What We're
   Looking For" bullet describes extending a live product, and only the absent Continuity-only
   badge and a requirements clause scoping the Sept-30 mainnet bar explicitly "for the
   Continuity Track" pointed the other way. The copy is written for one kind of entrant and
   the eligibility is wider than the copy; Circle is the authority on that and has answered.

   One thing that was true before the answer still is: **Arc's public mainnet lands Sept 16,
   after submissions close**, so nothing in this project may depend on it — whatever "push to
   mainnet" is judged on, it cannot be a mainnet transaction made before the deadline.

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
self-contradiction, and neither part true. `e6edbe6` corrected the values in the same commit
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
transfer against it reverts without naming any of that. `facture-prep/x402-probe/prepare-security.mjs`
walks the sequence, reading before each step so a re-run costs nothing:
`grantRole` × 4 → `addToControlList` (seller and buyer) → `addIssuer` → `grantKyc` → `issue`.

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

**Of six deployed contracts this was the first ever called.** `MandateBook`,
`InvoiceRegistry`, the Hedera `DvpEscrow` and `AtsComplianceGate` are still deployed and
reached by nothing — `compliance.ts` reads the ATS security's own facets, not the gate — and
there is no env var for any of their addresses, so the backend could not call them if it
wanted to. That is the largest remaining gap between `packages/contracts` and the running
product.

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

**Still unwired: `MandateBook`, the Hedera `DvpEscrow`, and `AtsComplianceGate`** — three of
six. The book is the interesting one: it reads rating and confirmation _from the invoice
registry_ rather than taking them as arguments, which is what makes its refusals mean
anything, and that registry is now populated.

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

**Prize amounts, corrected against the page.** Arc's mainnet track is **$3,500**, not the
$5,000 recorded above; Arc totals $10,000 across four tracks, and *"Best DeFi/Onchain Finance
Application"* asks for *"conditional payments, onchain automation or multi-step settlement"*,
which describes vault → escrow → hashlock almost verbatim. **Privy is $5,000 across two
tracks Facture fits unusually well** — both require _"at least one Privy control (policies,
signers, key quorums, intents)"_, and email plus an address is not one, so that is the
cheapest unclaimed money on the board. **Tokenization of Anything ($6,000) requires verified
contracts on HashScan** — unconfirmed, and worth checking. Every track requires a public repo.

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

Verified against the live vault: Harrow Point needs 0.05 USDC and holds 5, backed a hundred
times over; the seeded mandates are correctly unbacked. The old comparison agreed on exactly
one of them.

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

**Not yet run against the live facilitator.** Everything above is what the code does and what
the payload decodes to, not a settlement record. The recipe it reproduces is proven —
`facture-prep/x402-probe/settle-venue.mjs` closed 22 trades this way — but this agent has not
made one.

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
   mandate had been registered by hand. **Closed operationally by `pnpm demo:reset`**, which
   registers any active mandate that is missing; it is still not called from the funding
   route, so a mandate written between resets stays unescrowable until the next one.
2. **`SettlementOutcome: 'default'` is never produced** and no route writes
   `invoices.status = 'defaulted'`. So the permanent-rating-mark story has no code path, and
   worse: maturing an overdue unpaid receivable records it as **`late`**, which is a default
   written into the ledger as a payment.
3. **`MandateVault.executeRelease` has no caller and is not even in `VAULT_ABI`.** "Withdraw
   unallocated capital" decrements a SQLite row; real USDC in the vault has no path out of it
   in this repo. Migration `0004` fixed a buyer's address _for this call_.
4. **`@facture/shared/state` is an entire unused module** — both machines, every guard.
   Status changes go through unguarded `updateInvoice({ status })`, so nothing validates a
   lifecycle transition and `IllegalTransition` cannot be constructed at runtime.
5. **`listed` is an unreachable invoice status.** Only the seed writes it, so the secondary
   market the README's argument rests on has a table row and no code — which
   `settlement.ts` already concedes in a comment.
6. **`ArcEscrow.buyerOf` is called by nothing, not even a test.** It is the one check that
   would have caught the invented-address problem `0004` fixed by hand.
7. **The agent's entire money-moving surface has no caller** — `transferUsdc`,
   `executeContract`, every wallet-set method. `AGENT_WALLET_SET_ID` is parsed and read by
   nothing. `executeContract` is also the only way the agent could ever deposit into the
   vault, which is the other half of (1).
8. **`InvoiceRegistry.lookup` is never called.** The venue publishes terms and confirmations
   to chain and never reads them back — write-only, unlike `UniquenessRegistry`, whose read
   is what makes its refusal real.
9. **`settlement_outcomes` is a write-only table.** Its header calls it the append-only fact
   behind the `debtors` accumulator, and the counters are incremented in place and cannot be
   rebuilt, because nothing can read the facts.
10. **`invoices.regulation_type` never reaches the proof screen.** `api-source.ts` hardcodes
    `regulation: null`, so the Reg S declaration renders only from fixtures.

Also dead, lower stakes: `Store.getCursor`/`setCursor` and `indexer_cursors` (residue of the
removed indexer), `InvoiceRegistry.setRating` / `amendDueDate`, and a tail of unused helpers
across all five packages. **`arc.ts` claims `PAYMENT_LOCK_DURATION` is "read from the deployed
contract" — it is not in the ABI and never read**; the 24-hour figure is prose beside a
hardcoded constant.

The lesson stands and is now quantified: **nineteen mechanisms in this repo have a definition,
documentation, and no caller.** Look for the caller before believing the comment — including
comments written in this file.

### Provisioning: `pnpm demo:reset`

Modelled on the `gantry` repo's `demo-reset.mjs` — numbered steps matching the header, a
`degraded` flag rather than throws, a cheat sheet printed before the exit code, and the
relayer reported **first** because every step under it spends what it holds.

- **It does not touch `facture.db`, and must not.** Provisioning and seeding are separate
  there and separate here: the book is 29 invoices, 27 trades and two proven lifecycles, and
  `db:seed` remains the empty-database-only path.
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

### Corrected: Privy signs exactly one thing, and it is not the cash leg

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
