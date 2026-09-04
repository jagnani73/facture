# `@facture/contracts`

The venue contracts. Everything here sits _alongside_ the instrument, never inside it — each
receivable is issued as a Hedera [Asset Tokenization Studio][ats] zero-coupon bond, and ATS handles
the bond itself. Nothing in this package reimplements or wraps it.

What this package is responsible for is the market around that paper: making sure one receivable
mints one instrument, holding the standing bids and the capital behind them, refusing an ineligible
trade before it is struck rather than after, and settling the two legs across two chains.

## Contracts

| Contract                 | Chain  | What it is for                                                                   |
| ------------------------ | ------ | -------------------------------------------------------------------------------- |
| `UniquenessRegistry.sol` | Hedera | One receivable, one instrument, forever. The anti-double-pledge control.         |
| `MandateBook.sol`        | Hedera | The standing-bid book. Quotes over risk buckets, and the matching engine.        |
| `AtsComplianceGate.sol`  | Hedera | Asks the ATS instrument whether a buyer may hold it, **before** matching.        |
| `MandateVault.sol`       | Arc    | Custody of the buyer's USDC. Opens only on an authorisation from the book.       |
| `DvpEscrow.sol`          | both   | Hash-timelock escrow for one leg of a cross-chain delivery-versus-payment trade. |

Interfaces live in `contracts/interfaces/` and carry the reasoning; implementations carry the
mechanics. If you want to know _why_ something is shaped the way it is, read the interface.

### `UniquenessRegistry`

Maps `keccak256(domain, debtorId, invoiceRef, faceValue) → instrument`. `claim` reverts with
`AlreadyClaimed` if the hash is taken.

The binding is **append-only and permanently binding**: no release, no reassign, no admin override.
A buyer diligencing an instrument has to be able to conclude from `instrumentOf(h) == x` that no
other instrument was ever issued against that receivable, without also reasoning about who holds a
release key. Selling the same receivable to three financiers is the specific fraud factoring has
always had, and roughly what broke Greensill.

Because the binding is irreversible, writes are permissioned. An open registry could be front-run —
the committed fields are all guessable — to bind a hash to a junk address and burn that receivable
forever. The issuer set can censor, which is visible and recoverable; it can never forge or move an
existing binding.

### `MandateBook`

A mandate is a buyer, a rating floor, a tenor ceiling, an annualised yield, a total commitment, an
allocated amount, a per-debtor cap and a status.

**Capital is escrowed at funding.** This is the property everything else here serves. A quote backed
by an allowance or an off-chain promise is indicative; the buyer can spend the same balance
elsewhere or simply not have it. The capital is escrowed in `MandateVault` on Arc and the book holds
an attested view of it (see [Two chains, one book](#two-chains-one-book)); every match is bounded by
`totalCommitted - allocated`. Two invoices racing for one mandate resolve deterministically, and
overcommitment across mandates is structurally impossible rather than policed.

Matching checks, in order, each with its own error type and its own reason code:

| #   | Check                            | Error                                                                | Reason code                               |
| --- | -------------------------------- | -------------------------------------------------------------------- | ----------------------------------------- |
| 1   | mandate known and active         | `MandateUnknown` / `MandateNotActive`                                | `MANDATE_UNKNOWN` / `MANDATE_NOT_ACTIVE`  |
| 2   | invoice known, confirmed, unsold | `InvoiceUnknown` / `InvoiceNotConfirmed` / `InvoiceAlreadyAllocated` | `INVOICE_*`                               |
| 3   | rating ≥ floor                   | `RatingBelowFloor`                                                   | `RATING_BELOW_FLOOR`                      |
| 4   | tenor ≤ ceiling                  | `TenorAboveCeiling` / `InvoiceMatured`                               | `TENOR_ABOVE_CEILING` / `INVOICE_MATURED` |
| 5   | unallocated ≥ price              | `InsufficientUnallocated`                                            | `INSUFFICIENT_UNALLOCATED`                |
| 6   | per-debtor exposure              | `DebtorLimitExceeded`                                                | `DEBTOR_LIMIT_EXCEEDED`                   |
| 7   | instrument eligibility           | `NotEligible`                                                        | whatever the gate returned                |

Eligibility is last because it is the only external call: common refusals stay cheap, and every
state read a decision depends on has already happened before control leaves the contract.

Three entry points share one evaluation and differ only in how they report it:

- **`previewMatch`** — `view`, returns a reason code. Drives the UI's _"three mandates would take
  this"_ and lets a keeper pick a mandate without simulating failures.
- **`tryMatch`** — does not revert on refusal. Emits `MatchRefused(invoiceId, mandateId, reasonCode)`
  and returns `false`. This is the product path, because a reverted call discards its own logs and
  the rejected party needs a receipt they can check without trusting the venue.
- **`matchInvoice`** — strict. Reverts with the typed error above, carrying the offending values.

Prices are **derived, never supplied**. If a caller could state the price, "insufficient
unallocated" would be a check against a number chosen by the party who wants the match to succeed.
The convention is simple discount on face, ACT/365 fixed:

```
discount = faceValue × annualisedYieldBps × tenorDays / (10_000 × 365)
price    = faceValue − discount
```

$40,000 face, 60 days, 1250 bps → $821.92 discount, **$39,178.08** proceeds — the same figures the
root `README.md` quotes, pinned by a test so the two cannot drift apart.

Two consequences of the discount basis, stated rather than discovered later: the buyer's realised
annualised return is a basis point or so _above_ the quoted rate, and rounding favours the seller by
at most one unit.

#### Settling and maturing are proven, not asserted

Neither function that ends a position takes a role, and both are permissionless as a result.

`confirmSettlement(matchId, deliveryLockId)` reads a lock out of the venue's `DvpEscrow` **on
Hedera** and refuses unless that lock is a proof of this trade's delivery: `Claimed`, so a preimage
was revealed; carrying this `matchId` as its trade reference; on the delivery leg; escrowed by this
match's seller; delivering to this match's buyer; and holding the instrument snapshotted at match
time. Each failure has its own error — `DeliveryNotProven`, `DeliveryLockMismatch`,
`DeliveryDepositorMismatch`, `DeliveryBeneficiaryMismatch`, `DeliveryAssetMismatch`.

The point of proving rather than asserting is that it makes settlement **safe to compel**. Once the
buyer has claimed the paper, anyone — the seller especially — can force the payout authorisation, so
a buyer cannot take delivery and then decline to pay, and a keeper that has gone dark cannot hold a
completed trade hostage.

The lock id is presented rather than derived, and that is deliberate. Lock ids in `DvpEscrow` are
caller-supplied and opening a lock is permissionless, so **any** id the book could derive could also
be squatted — a junk lock at the derived id, and the real seller can never open the delivery leg for
that match. Verifying the _contents_ of a presented lock removes the squat: a junk lock fails the
checks, and a lock that passes them is delivery whatever id it was opened under.

What the proof does not cover is quantity. The instrument's unit scale belongs to the issuer, so the
book does not know how many units a face value should be. The buyer's own claim transaction is the
consent that settles that: nobody but the beneficiary can put a lock into `Claimed`.

`confirmMaturity(matchId, holder)` routes redemption to **whoever holds the paper now**, and asks the
instrument rather than believing the caller — `balanceOf(holder) == totalSupply()`, both read through
raw `staticcall`s in the same fail-closed style as the compliance gate. Sole holder, not merely a
holder, so a dusted unit cannot make an address the payee. Maturity is measured from the match's own
`matchedAt + tenorDays`, never from a fresh registry read, so an edited due date cannot bring a live
position forward.

This is the leg that makes the paper transferable at all: paper that pays its first buyer forever
cannot legitimately change hands, because a second buyer would have no way to be paid. It also ends
the buying mandate's exposure to the debtor, exactly once, because `Settled → Matured` is a state
transition rather than a repeatable call.

The one role left in the lifecycle is `setSettler`, and it is much narrower than its name: a settler
can only cancel an open match _early_, returning an allocation to the mandate it came from. It cannot
settle, and it cannot move capital to anyone.

### `AtsComplianceGate`

`canReceive(instrument, buyer) → (ok, reasonCode)`. Never reverts, always fails closed.

It probes the security's **own `ControlList` and `Kyc` facets**, not the ERC-3643
`IdentityRegistry`. The registry's interface is `isVerified(address)` — no token parameter — so
verification is a property of an address rather than of an (address, security) pair, and every
security pointing at one registry shares a single global allowlist. Facture issues one diamond per
invoice, and different invoices carry different offering exemptions (Reg D 506(c) versus Reg S), so
buyer cohorts genuinely differ per instrument. Under a global registry that means one registry
_deployment_ per cohort, and a mis-wired instrument fails silently by authorising the wrong people.
`ControlList` and `Kyc` are already scoped per-instrument and cost zero extra deployments.

Probes are raw `staticcall`s rather than typed interface calls, so a missing facet, a reverting
facet, a gas-exhausted probe and a garbage return all collapse into `COMPLIANCE_PROBE_FAILED`
instead of taking down `previewMatch` for the whole venue. That also makes ATS selector drift
survivable: the tests fail loudly and matching refuses, rather than every match reverting.

### `MandateVault`

Deploys on Arc. Holds every mandate's USDC, tracked per mandate, and has exactly **two** ways out:
`executeRelease` (back to the buyer) and `executePayout` (a settled trade, into the payment escrow).
Both require an authorisation minted by the book on Hedera and relayed by the attester. There is no
withdraw function, no timeout escape and no owner sweep, and adding one would destroy the property
the split depends on. `reclaimPayout` is not a third way out: it moves capital _inward_, out of an
unclaimed payment lock and back into the mandate that funded it, which is why it is permissionless
while the two exits are not.

Four bounds are enforced here rather than assumed, in decreasing order of strength:

1. **Per-mandate accounting.** Every outflow is checked against that mandate's own balance, so no
   authorisation can reach another mandate's capital. Arithmetic, not policy.
2. **Releases are bound to the registered buyer.** `executeRelease` takes no recipient argument and
   always pays `buyerOf(mandateId)`, which is set once and never re-pointable. A compromised
   attester relaying a forged release can only return a buyer's money to that buyer.
3. **Every authorisation is single-use**, keyed by an id the book derives from its own chain id,
   address and nonce — so it cannot be replayed here, against a second vault, or against a
   redeployment. A match, separately, admits at most one payout ever.
4. **Payouts are bound to the registered seller, and leave only toward the escrow.**
   `executePayout(authId, matchId, lockId, secretHash)` takes no beneficiary and no amount: it reads
   `payoutOf(matchId)` — a one-shot binding of payee, mandate and price relayed at **match** time —
   and opens a `DvpEscrow` lock for that seller, at that price, out of that mandate.

Binding at match time rather than at settlement time is the part that does the work: the seller can
read `payoutOf` on Arc **before** they part with the paper. A binding they could only check after
delivering would not be worth checking.

The escrow hop buys three things a direct transfer cannot. A payout stops being irreversible — one
the seller cannot take comes back to the mandate at timeout instead of being burned. Both legs of a
trade become the same kind of object, under the same `tradeRef` and hash, which is what a proof view
needs to show a trade rather than two unrelated transfers. And the cash leg stops being a special
case: the delivery leg was already a lock, now the payment leg is one too.

Stated plainly, because the interface used to promise more: **this does not remove attester trust.**
Authorisation ids are public hashes of a nonce, so a compromised relay can forge one, and with a
forged match registration it can still drain a mandate's balance. Nothing arranged inside this
contract closes that, because Arc cannot read Hedera and the vault can therefore only authenticate
the messenger, never the book. What the bindings change is the shape of the residual: nothing can be
redirected after the fact, every destination is committed before delivery and publicly readable, and
every outflow lands in a contract where it is visible and refundable rather than in an EOA where it
is gone.

### `DvpEscrow`

Deploy one instance per chain — Hedera escrows the bond, Arc escrows the USDC. They never
communicate; only a 32-byte preimage crosses.

**This is not atomic, and the NatSpec says so.** Two independent consensus systems cannot commit one
transaction. What it provides is fair exchange under a liveness assumption: both legs complete, or
both refund, provided each party acts before their own timeout. The dangerous window between the
preimage becoming public on one chain and the counterparty claiming on the other is real and is
managed by timeout parameterisation, not engineered away.

The **ordering rule** is an integrator obligation this contract cannot enforce, because it cannot
see the other chain: the party who generates the secret locks _first_ with the _longer_ timeout and
claims _second_. Reverse it and they can claim at the last moment, leaving the counterparty unable
to. `MIN_LEG_GAP` is published as advisory guidance for the same reason.

The **free-option problem** is disclosed rather than hidden: the preimage holder can decline to
reveal and take the refund. Tolerable here only because settlement windows are minutes and the
priced asset is a fixed-face claim. It would not be tolerable for a volatile pair.

A trusted-attester escrow would avoid both weaknesses and was rejected: it reintroduces exactly the
intermediary the venue exists to remove.

## Supporting files

- `contracts/libraries/FactureTypes.sol` — shared enums. `Rating` ordering is load-bearing:
  matching compares with `>=`, and `Unrated == 0` makes an unrated debtor the _worst_ bucket, so an
  uninitialised slot can never present as investment grade.
- `contracts/libraries/ReasonCodes.sol` — the refusal vocabulary. `bytes32` short strings rather
  than an enum so a gate can surface a code the venue did not compile in.
- `contracts/interfaces/IInvoiceRegistry.sol` — the seam onto invoice truth. The book _reads_ facts
  rather than accepting them as arguments; "rating below floor" only means something if the rating
  is not supplied by the party who wants the match to succeed.
- `contracts/interfaces/ats/IAtsFacets.sol` — the three ATS selectors the gate probes, and nothing
  more.
- `contracts/interfaces/IMandateVault.sol` — the cash leg's contract with the book, and the full
  staleness and trust analysis for the split.
- `contracts/mocks/` — test-only. `MockAtsSecurity` can be told to revert, burn gas or return
  garbage, which is what actually exercises the gate's fail-closed design.

## Two chains, one book

`MandateBook` needs two things that naturally live on different chains: a synchronous pre-trade
compliance answer from an ATS instrument (Hedera) and custody of the buyer's USDC (Arc, where
treasury capital already sits). Neither is negotiable, so rather than pick one, the venue splits
them along the line of **what actually has to be live**:

- **Compliance must be synchronous.** It is a legal fact that has to be exactly right at the instant
  of matching, and "the venue refuses to match" is the whole claim against an AMM that discovers
  illegality at settlement. So the book sits on **Hedera**, beside the paper and the gate, and
  eligibility is a real `staticcall` inside the matching transaction.
- **A funded balance does not have to be synchronous.** It is a number only the buyer can move. So
  the capital stays on **Arc** in `MandateVault`, never bridges, and the book holds an _attested_
  view of it. The buyer's stablecoins never leave the chain stablecoins already live on.

### What makes the attested balance sound

The vault's only exits require an authorisation issued by the book. **A buyer cannot pull capital on
Arc while the book still counts it as committed.** Overcommitment is closed structurally, without a
synchronous balance read.

```
Arc                                    Hedera
───                                    ──────
MandateVault.deposit()
  └─ Deposited(depositRef) ───────────► MandateBook.creditFunding(depositRef)   [attester]
                                          └─ totalCommitted += amount

                                       MandateBook.authoriseRelease()          [buyer]
                                          └─ totalCommitted -= amount   FIRST
MandateVault.executeRelease() ◄─────────── ReleaseAuthorised(authId)     [attester]
  └─ pays buyerOf(mandateId)                                            SECOND
```

The settlement path is the same shape, with the payee bound one step earlier so the seller can check
it before delivering:

```
Arc                                    Hedera
───                                    ──────
                                       MandateBook.matchInvoice()               [matcher]
MandateVault.registerMatch() ◄──────────── Matched(matchId, seller, price)      [attester]
  └─ binds payee, mandate, price
     (the seller reads this BEFORE delivering)

                                       DvpEscrow.openLock() / .claim()          [seller / buyer]
                                       MandateBook.confirmSettlement(lockId)    [anyone]
                                          └─ verifies the claimed delivery lock
                                          └─ allocated -= , committed -=  FIRST
MandateVault.executePayout() ◄──────────── PayoutAuthorised(authId, secretHash) [attester]
  └─ opens a lock for payoutOf(matchId).seller                           SECOND
     └─ seller claims, or it refunds to the mandate
```

### Staleness, and why both windows fail safe

There are exactly two lags, and neither can make the book believe it has more money than it has:

| Window                               | Direction             | Consequence                        |
| ------------------------------------ | --------------------- | ---------------------------------- |
| Arc deposit → Hedera credit          | book **under**-counts | mandate matches less than it could |
| Hedera authorisation → Arc execution | book **under**-counts | book already gave up its claim     |

The second is the load-bearing one, and it is an ordering choice rather than an accident: the book
decrements `totalCommitted` when it _authorises_, before the tokens move. Under an honest attester
the attested balance is therefore a **lower bound** on real withdrawable capital at every instant,
and both windows fail toward refusing a match rather than toward promising money that is not there.

### The honest weak point

Attested-above-real is not reachable by lag. It is reachable only by an attester crediting a deposit
that never happened, after which the book can match a trade the cash leg cannot pay, and the failure
surfaces at settlement. **v1 runs a single trusted attester.** The four bounds under `MandateVault`
limit the damage; the v2 path is an attester threshold or a light-client proof of the Arc deposit
log, and neither changes any interface here.

**This is not atomic and is not described as such.** It is a two-phase commit with a trusted relay.
Attester failure is a _liveness_ failure, not a loss: deposits stop being credited (safe) and
authorised releases stop executing (capital sits on Arc). Recovery is attester **rotation**, never a
timeout escape hatch — a path out of the vault that did not require the book's word would destroy
the exact property the design provides.

## Building and testing

```bash
pnpm --filter @facture/contracts build     # hardhat build (default profile)
pnpm --filter @facture/contracts test      # hardhat test (node:test + viem)
pnpm --filter @facture/contracts typecheck
```

Hardhat 3, ESM, TypeScript config. Solidity 0.8.28 against `evmVersion: cancun`, which Hedera runs.
Every pragma is `^0.8.24` so the compiler can be pinned back to 0.8.24 without a source change if a
relay release ever rejects a Cancun-only opcode.

**The default profile is optimised**, with settings identical to `production`. It used to be
unoptimised on the usual "fast test loop" reasoning, and that stopped being tenable: `MandateBook`
compiles to about 27KB unoptimised against 15KB optimised, and 24,576 is a hard ceiling on both the
simulated test chain and Hedera. An unoptimised profile therefore either cannot deploy the venue's
own book, or has to be told to ignore the ceiling — and ignoring it is worse, because the suite would
then prove a contract works while saying nothing about whether it can be deployed. The cost that was
weighed against turned out to be nothing: a clean build of all 18 files takes about two seconds
either way.

Tests use the Node built-in runner (`node:test`) — that is what `hardhat-toolbox-viem` ships, not
Mocha.

**Getting a network connection.** `hardhat@3.12.0` ships three methods on `NetworkManager`, verified
against the package's shipped `dist/src/types/network.d.ts`:

| Call            | Behaviour                                                | Used by        |
| --------------- | -------------------------------------------------------- | -------------- |
| `getOrCreate()` | reuses a connection keyed by network + chain type        | test files     |
| `create()`      | always opens a fresh connection                          | deploy scripts |
| `connect()`     | **`@deprecated`**, "will be removed in a future version" | nothing here   |

Tutorials and older docs still show `network.connect()`. It compiles and runs in 3.12.0, but it is
marked deprecated in the shipped types, so nothing in this package uses it.

## Deploying

Two chains, and **the order matters** — the book records the vault's chain id and address as
immutables, so the vault has to exist first.

```bash
pnpm --filter @facture/contracts deploy:arc      # DvpEscrow (payment leg), then MandateVault
# copy the printed vault address into FACTURE_MANDATE_VAULT
pnpm --filter @facture/contracts deploy:hedera   # registry, gate, DvpEscrow (delivery leg), book
```

The order **inside** each script matters for the same reason. On Arc the escrow deploys before the
vault, which takes it as an immutable and pays every settled trade into it; on Hedera the escrow
deploys before the book, which takes it as an immutable and reads every settlement proof out of it.
The whole chain runs one way and never doubles back: escrow → vault → book, with a second escrow
beside the book.

`--build-profile production` is not optional and is baked into both scripts.

Afterwards the attester relay has to be pointed at both. It watches `MandateVault.Deposited` on Arc
and calls `MandateBook.creditFunding`, and it watches `MandatePosted` / `Matched` /
`ReleaseAuthorised` / `PayoutAuthorised` on Hedera and calls the vault's `registerMandate`,
`registerMatch` and `execute*`. The two `register*` calls are not optional and are not bookkeeping:
they are the bindings that decide who the vault will pay, and `registerMatch` in particular has to
land **before** the seller delivers, because being able to check it beforehand is the whole point of
it.

Copy `.env.example` to `.env` first. **Hedera keys must be ECDSA** — ED25519 accounts hold HBAR and
HTS tokens fine but cannot sign EVM transactions at all, and the failure surfaces late as
`INVALID_SIGNATURE`.

On Arc, `maxFeePerGas` is pinned at 20 Gwei in the config because anything lower is rejected as
"transaction underpriced". It is a floor, not a tuning knob. Gas there is natively USDC, which is
also why no Paymaster is wired up.

### Gas

The `hederaTestnet` network sets `gas: 9_000_000` (Hardhat 3 calls the field `gas`, not Hardhat 2's
`gasLimit`), and `scripts/deployHedera.ts` overrides it _downward_ per call.

Hedera bills close to the limit a transaction **declares**, not what it consumes. The Ethereum habit
of setting a generous limit and forgetting is a permanent overspend here. 9M is sized off
measurement: `Factory.deployBond` — the heaviest call the venue makes — costs 6,978,091 gas, and
8,158,081 in the heaviest configuration that could be constructed. 9M clears the measured cost by
~29% and the worst case by ~10%, enough headroom for facet-count drift without paying for six
million units of nothing on every call. The 15M per-transaction ceiling would cost roughly double
for no benefit.

Everything else is far cheaper and gets its own override: role grant ~180k, KYC grant ~190k, mint
~465k, warm transfer ~254k.

None of this applies on Arc, which has ordinary EVM refund semantics — an unused limit costs nothing
there, so `deployArc.ts` lets estimation do its job.

## What is stubbed

Signatures, events, errors and storage layout are all deliberate and complete. The bodies left as
`TODO` are the ones that depend on packages outside this one:

- The attester itself is a single trusted relay, and lives outside this package. The v2 replacement
  (threshold attestation, or a light-client proof of the Arc deposit log) needs no interface change
  here. Note that binding the payout to a registered seller did **not** remove this: see the
  `MandateVault` section for exactly what it did and did not close.
- Early cancellation is still a role call. `setSettler` grants the right to cancel an open match
  before its window elapses, including one whose delivery leg has already been claimed — which would
  hand the buyer the bond for nothing. What bounds it is that settlement is permissionless the
  instant the buyer claims, so a settler wanting to strand a delivered trade has to win a race
  against the party being paid. Closing it outright needs a proof that no delivery lock exists, and a
  negative like that cannot be proven against caller-supplied lock ids.
- A reclaimed payout does not re-open its trade. `MandateVault.reclaimPayout` returns the capital to
  the mandate and the book credits it back through the ordinary funding path, but the match stays
  `Settled` and the book cannot mint a second payout authorisation for it. Putting a stranded
  settlement right is an operator matter in v1.
- Partial position sales. Storage is shaped so this does not need a migration — a `Match` already
  snapshots `faceValue` and `price` separately — but the instrument-side split is an ATS partition
  concern and out of scope here.
- `scripts/deployHedera.ts` does not yet verify on HashScan, write an address manifest, or perform HTS
  association. **Association is not optional on Hedera** and is the failure that broke the reference
  x402 proof of concept until it was added explicitly.

[ats]: https://github.com/hashgraph/asset-tokenization-studio
