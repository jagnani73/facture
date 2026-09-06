# AI tool usage

ETHGlobal asks entrants to say which parts of a project were built with AI assistance and which
files those were. This is that statement, reconstructed from the repository rather than from memory:
131 commits, their messages, their diffs, and the two documents the work was steered by. Every count
below was recomputed from the tree on 2026-09-06 rather than carried forward.

The short version: **a model did nearly all of the typing, and a person made every decision the
typing was constrained by.** That division is not a hedge. It is legible in the repo, because the
constraints were written down before the code was, and the file they were written down in is
`CLAUDE.md`.

---

## The tool

[Claude Code](https://claude.com/claude-code), Anthropic's CLI, driven by one person in an
interactive terminal. No autonomous agent loop, no code generation service, no scaffolding
generator. Sessions ran in two shapes: one person and one model working through a
problem, and — on the second and third days — orchestrating sessions that fanned parallel agents
across package boundaries that could not collide, then reviewed and committed their work. Model
choice varied across sessions and the repository does not record which model wrote which commit, so
this document does not claim one.

Supporting tools in the same sessions: MCP servers for PostgreSQL inspection and for Arc's live
documentation. `.mcp.json` is gitignored because it carries a connection string, which is why the
configuration itself is not in the tree — see commit `c49c830`.

**No AI attribution appears in any commit message**, by the author's standing preference. `git log`
carries no `Co-Authored-By` trailer and no generated-with footer. That is a formatting choice, not a
claim of hand-authorship, and this file exists so the choice does not amount to a misrepresentation.

## Shape of the work

131 commits, 2026-09-04 through 2026-09-06. Three days: 23, then 79, then 29.

The first seven span two hours and twenty-two minutes and 28,283 inserted lines — a workspace
scaffold, four package skeletons, the two steering documents and an upstream bug report — each
landing whole rather than developed commit by commit. Everything after `4a9aae6` is incremental, and
the later history reads like what it was: a feature landing, a live transaction failing, and a fix
commit naming exactly what the failure was.

| package              | tracked lines | what it is                                                         |
| -------------------- | ------------- | ------------------------------------------------------------------ |
| `packages/backend`   | 34,756        | Hono venue, SQLite store, ATS/x402/Arc/schedule/HCS/chain adapters |
| `packages/web`       | 17,461        | Next.js screens, one data seam over API or fixtures                |
| `packages/contracts` | 9,908         | 19 Solidity files, Hardhat, deploy and Sourcify-verify scripts     |
| `packages/agent`     | 9,445         | market-maker on a Circle wallet and a Hedera key                   |
| `packages/shared`    | 4,075         | domain types, ISIN, pricing, state machines                        |
| docs and READMEs     | 6,543         | six READMEs, `CLAUDE.md`, `docs/`                                  |

60 test files, 21,882 lines. The figure printed here before counted four `vitest.config.ts` files in
the lines and not in the files, which overstated the lines by 42; both now come off one list. 1,150
of those tests run under vitest — backend 498, web 231, agent 237, shared 184 — and the contracts
package adds 134 more under Hardhat. Written in the same sessions as the code they cover.
`packages/web` had no test runner at all until the second day; it was added specifically because
`tsc --noEmit` cannot see a decoder reading the wrong field.

## What the human decided

This is the half that matters, and it is auditable: `CLAUDE.md` is a record of constraints
researched by a person, verified against a live network or a deployed contract's source, and then
handed to the model as non-negotiable. It is not a description of the code. It is the set of things
the code was not allowed to get wrong.

**The architectural decision.** One ATS zero-coupon bond per invoice, heterogeneous paper rather
than a pooled facility. The reasoning is a product argument — pooling invoices makes the assets
fungible and collapses the idea into ordinary securitisation — and it was made contingent on gas,
then closed by measurement. The model did not choose this and could not have; the alternative
compiles just as well.

**The hard constraints**, every one of them researched before any code depended on it:

- ATS partitions cannot carry distinct instruments; `initializeMaturity` reverts on a second call.
- There is no batch issuance. Ten invoices is ten `deployBond` transactions.
- Use `ControlList` and `Kyc`, not the ERC-3643 `IdentityRegistry`, because `isVerified(address)`
  has no token parameter and would make one allowlist global across every security.
- Reg S rather than Reg D 506(c), read out of the deployed factory's own source rather than a blog.
- ECDSA keys for anything touching the EVM. Every HTS token needs explicit association.
- Scheduled Transactions are one-shot. "Streaming" is not a thing on this network.
- Arc testnet only. `maxFeePerGas` below 20 Gwei fails as underpriced. Skip StableFX and Paymaster.
- Circle enforces no spending cap on this path, and the product must not imply that it does.

**The cut list, and its ordering.** Which parts of the product go first if time runs out, ordered by
what leaves the product most intact rather than by which prize is cheapest to lose. And the
never-cut path underneath it: list → quote → compliance-checked match → DvP settle → maturity pays
the current holder.

**The corrections to the model's own generalisations.** Two are worth naming because the model had
been reasoning from the wrong one:

- There is no 20% gas refund cap on this path. `charged_tx_fee / gas_used` is an exact integer
  across 24 historical calls.
- But a generous gas limit is not free either. Hedera reserves `gasLimit × gasPrice` up front and
  charges `gasUsed × gasPrice`. Discovered by a send being refused for insufficient funds against a
  fee it could easily have paid.

**The scope decisions on days two and three**, every one of which the model raised as a question
rather than resolved on its own:

- **Privy signs exactly one thing.** It signs a seller in and records the wallet, and it touches
  nothing in the settlement path — the boundary is the decision, not a first phase. What settled it
  was a fact the model had earlier stated backwards and then corrected: the x402 cash leg is a
  **native Hedera `TransferTransaction`**, not `signTypedData`, so a Privy signer cannot produce it
  at all. The boundary then moved by exactly one transaction, and by necessity rather than by taste:
  a sale settled out of the buyer's escrow opens a `DvpEscrow` lock, `claim` checks
  `msg.sender == beneficiary`, and the venue therefore cannot collect for a seller under any
  circumstances. The only key that can is the one Privy made at sign-in. The seller still signs
  nothing to _sell_ — not to list, not to be matched, not to settle.
- **And the key is allowed exactly that one thing.** A Privy wallet policy, created once by
  `pnpm --filter @facture/backend privy:policy` and pinned in `PRIVY_WALLET_POLICY_ID`, carries a
  single ALLOW rule over `eth_sendTransaction` with three conditions Privy decodes for itself: the
  escrow address, read off the deployed vault rather than written down a second time; Arc's chain id
  `5042002`; and a `function_name` of `claim`, decoded against an ABI holding that one function.
  Everything no rule allowed is denied. `services/privy-policy.ts` attaches it at sign-in and
  swallows its own failures, because an unavailable policy API should cost the control rather than
  the account. Creating it is deliberately not automatic: Privy puts no uniqueness constraint on a
  policy name, so a venue that created one on demand would mint a fresh policy per restart and then
  be unable to say which one a given wallet carries. An email and an address are not a control; this
  is.
- **Escrow is funded from the buyer's own wallet**, not the venue's, because depositing the venue's
  USDC and calling it escrowed buyer capital would have been a fresh overclaim of exactly the kind
  the README had just been corrected for.
- **A demo account, or your own** — the framing came from the human, and it resolved the honesty
  problem by construction: capital behind a demo mandate is the venue's, capital behind yours is
  yours, and which account is in view decides whose money moves.
- **`UniquenessRegistry` before `MandateBook`** when picking which deployed contract to wire first.
- **The machines were not edited to match the code.** Both state machines forbade edges the running
  product performed on every trade, and declared states nothing ever wrote. The tidier fix is to
  correct the transition tables; the decision was the other direction, because a machine edited to
  match the code can never catch the code being wrong. What that cost was a route — listing is an
  act now, and arming refuses anything not listed.
- **The secondary market was declined rather than deferred**, and the reasoning is written down so
  it is not relitigated: `createHoldByPartition` acts on the caller's own tokens, so after a sale
  the venue is not the holder, and no wallet this build issues can produce the ERC-1400 operator
  grant that would fix it. The honest options were a relist that prices and matches but cannot
  deliver, or none.
- **Nothing is pushed** without being asked, and it still has not been.

**The product argument in `README.md`.** The thesis — that invoices are not fungible so you
standardise the bid instead, that a discounted invoice already _is_ a zero-coupon bond, that debtor
confirmation works for behavioural rather than cryptographic reasons — is the human's. The prose
was drafted and redrafted with the model; the claims are not the model's to make.

## What the model wrote

Essentially all of the source. Concretely, and by the seam it was asked to hold:

**`packages/shared`** — domain types, the ISIN generator and its check digit, the pricing curve and
`bestQuote`, the uniqueness hash, the invoice and mandate state machines, and the chain constant
tables. Written first, so nothing downstream could invent its own copy of a chain id.

**`packages/contracts`** — `MandateBook`, `DvpEscrow`, `MandateVault`, `UniquenessRegistry`,
`AtsComplianceGate`, `InvoiceRegistry`, their interfaces, the mocks, and 3,280 lines of Hardhat
tests. The refusal vocabulary in `libraries/ReasonCodes.sol` was later renamed to match
`@facture/shared` exactly (`78faa1a`), because two spellings of one refusal is a bug that only
surfaces when a funder reads a receipt.

**`packages/backend`** — the whole venue. Routes, the quote engine, the settlement service, the
issuance queue and its pacing, the ATS adapter, the x402 client, the schedule adapter, the SQLite
store and its nine migrations, the 1,292-line seeded demo book, and the tests.

**`packages/web`** — every screen, the fixture book, and the data seam that lets the same components
render against the venue or against fixtures.

**`packages/agent`** — the market maker, its Circle wallet client, its mandate pre-flight, and a
logger with a secret redactor registered before the environment is parsed. Two files in this package
spend. `src/cash.ts` holds the buyer's Hedera key and signs the x402 cash leg, a native
`TransferTransaction` whose transaction id is generated against the facilitator's account so the
buyer pays the quoted proceeds and no gas. It signs without touching the network, which is what
makes it testable: `freezeWith` wants only the node addresses an SDK client already knows, and
`sign` is arithmetic, so a test decodes the signed bytes and checks them against the challenge. That
mattered, because the failure on this rail is not an exception. A payload built from the wrong field
is a valid signature over the wrong transfer, and the facilitator submits it. `src/vault.ts` came
after it and posts the agent's own Circle-wallet USDC into `MandateVault` — the one thing that
wallet is for, since it pays for neither settlement rail — and `src/fund.ts` is the command that
drives it: with no flags it reads the venue and the vault, prints the plan and moves nothing, and
`--execute` is the only thing that authorises a spend.

**The documentation**, including `docs/deployments.md`, the five package READMEs, and the upstream
bug report in `docs/upstream/`. Every address and gas figure in the deployment record was read back
from Hedera and pasted in by the model; a human decided that reading it back rather than copying a
deploy log was the rule.

**This file and `docs/demo.md`** were written by Claude Code as well, reading the repository and the
running services. They are not exempt.

## Where the division actually shows

Three cases, all recoverable from `git log`.

**The regulation type.** A person read `regulation.sol` in the deployed factory and found that the
block is disclosure metadata with no enforcement path — no resale-hold check, no accreditation
check, `resaleHoldPeriod` appearing nowhere in contract logic — and that all three regulation types
are `ACCREDITATION_REQUIRED`, which killed the stated rationale for choosing 506(c). The decision to
declare Reg S followed from that reading. `9833a3b` then changed one default in `env.ts`. The
research was hours; the diff was one line.

**The maturity payout rail.** The constraint that a debtor has no wallet is a product decision with
a behavioural argument behind it, and it rules out an entire class of design. Once stated, the model
built the collection-account rail, the schedule, the idempotency, and the read-back —
`services/schedule.ts`, now 394 lines, plus tests — across two commits.

**The compliance-at-quote fix.** The problem was noticed by a person watching a live run: MF-2051
quoted 925 bps from a buyer the instrument bars, and the 403 arrived after the seller had decided to
sell. The decision about how to fix it — check the winner and fall through, never screen the whole
book, treat an unreadable instrument as indeterminate rather than negative — is a judgement about
what a quote is allowed to cost. `3ea7592` is the model implementing that judgement.

## What the model got wrong

Naming these is the point of the exercise. Every one is a commit in this repository.

**The `deployBond` tuple that never once worked** (`9833a3b`) is the flagship. The struct the
backend encoded was a plausible flattening of the real one. It compiled. It typechecked. It produced
calldata. It encoded to selector `0x58a038dd`, which the deployed diamond does not have — so every
issuance the service ever attempted reverted with `FunctionNotFound(0x5416eb98)` after 45,540 gas, a
status that reads like a contract fault rather than a calldata one. Nothing in the codebase could
tell the difference, because a wrong selector is not a wrong type. Two of those failures are on
chain.

The failure mode generalises: **a model asked to integrate with an unfamiliar external interface
will produce something that satisfies every check the language can perform and is still wrong.**
The fix was not a better struct. It was `DEPLOY_BOND_SELECTOR`, asserted before submission and in
`test/ats.test.ts`, which catches the whole class without spending a transaction.

The same pattern, three more times:

- `ca94b22` — the compliance service called `isAuthorized`, `getKycAccountStatus` and `isPaused`.
  None exist. The real surface is `getControlListType()`, `isInControlList(address)`,
  `getKycStatusFor(address)` and `paused()`. It also read membership without reading list _type_,
  which inverts the answer on a blocklist instrument and admits exactly the party it was configured
  to exclude.
- `db06cfa` — `executeHold` called with the wrong argument shape.
- `4ba0816` — the security id was taken from `contractFunctionResult.contractId`, which is the
  contract that was _called_. Every invoice was recorded as owning the factory. Two perfectly good
  bonds are orphaned on testnet because of it, listed in `deployments.md` for exactly that reason.

Two more, of different kinds:

- `b69ba9f` deleted a 754-line PostgreSQL store written the same day and replaced it with SQLite.
  The reasoning in the new file — a file on disk cannot be a container that failed to start — is
  right, and it should have been the first choice.
- `494ea2a` fixes a `tsx watch` invocation whose flags were in an order that does not work. Trivial,
  and it took a run to find.

One correction ran the other way. The local Hardhat figure of 6,978,091 gas for `deployBond` was
written off as an unreliable predictor of a real Hedera network. It landed within 0.02% of the live
median of 6,976,378.

### The dominant failure mode, once there was enough code to see it

**A mechanism built carefully, commented well, and called by nothing.** This is the single most
distinctive result in the project, and it is not a coding error — every one of them typechecks,
reads well in review, and is invisible to a test suite that never asks whether anybody calls it.

**Twenty-two were found.** Nine came one at a time, tripped over rather than looked for; ten came at
once, from a deliberate pass over every export, interface member, column, env var, contract function
and wire field, asking only _what calls this outside its own tests_. That the systematic pass more
than doubled the count in one sitting is the finding: they were never a run of bad luck, and looking
for them is a different activity from reviewing code. Three more arrived after that pass was
supposed to have ended it — `provisionClaimPolicy`, named the twentieth in its own commit message
(`3962b0b`), and the deployed `AtsComplianceGate` and `MandateBook`, which `CLAUDE.md` had been
carrying as unwired contracts rather than as sweep findings and which got their first callers on the
third day.

`AtsComplianceGate` is the one worth reading, because having no caller turned out not to be its
worst property. It probed `isPaused()`, `isAuthorized(address)` and `getKycAccountStatus(address)` —
three functions a deployed ATS diamond does not have — so every probe reverted `FunctionNotFound`,
the gate failed closed, and it refused every buyer on every instrument, including ones the
instrument affirmatively permits. `services/compliance.ts` had carried the right four selectors
since `ca94b22`, corrected against live paper: two halves of one fact maintained apart, and the
on-chain half was the one a third party would call. Its contract tests all passed, because
`MockAtsSecurity` implemented the same three wrong selectors. **A mock built from the same
misreading as the code under test cannot contradict it.**

The running tally — which have a caller now, which stand, and which stand deliberately — is kept in
`CLAUDE.md` under **"The full sweep for mechanisms nobody calls"**, because it changes with the
code and a number copied here would be stale within a day. `reclaimPayout` is the one that stands on
purpose: it recovers a stranded payout, it is permissionless, and automating it would mean the venue
writing to Arc on a timer for a case that needs a judgement about whether the seller has simply not
claimed yet.

Six of them, as a sample of how they present:

| what                         | how it presented                                                                                                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Indexer.advance()`          | `/health` returned 503 from before the first settled trade. Nothing ever advanced the cursor, so the lag printed as the whole chain height.                                                                                        |
| HCS refusal receipts         | The schema had the topic and sequence columns, the proof view rendered a link off them, and the seed filled them in. Nothing had ever written to a topic.                                                                          |
| `IssuanceJob.regulationType` | Read off the invoice, carried through two layers, then ignored — the adapter used a venue-wide config value. MF-2052's row said Reg D 506(c) while its bond went out Reg S.                                                        |
| `identity.ts` `subscribe`    | Written so a sign-in could re-render the book. Nothing subscribed, so signing in changed the identity and the screen kept showing the previous seller's invoices.                                                                  |
| `assetLeg.unitsMinor`        | The venue published it precisely so a trade moving one unit of a face-value-many issuance could not hide. The decoder had no such field, so the row rendered on the fixture path and never on the live one. `34924a1` gave it one. |
| `UniquenessRegistry`         | Deployed on day one, backing the README's sharpest fraud claim, and called by nothing until day two.                                                                                                                               |

The lesson the model kept relearning: **the test that would have caught each of these is not a test
of the mechanism, it is a test that something reaches it.** Several of the fixes are exactly that.

### Three more from the second day

- **`writeContract` does not mean the transaction succeeded.** The first draft of the uniqueness
  service reported a _second_ claim on an already-bound receivable as a success, because viem
  returns once a transaction is accepted and the revert lands later. That is the `deployBond` lesson
  wearing a different hat — the call succeeded and the transaction failed — and it was reporting the
  precise failure the registry exists to prevent as if prevented. Found by testing the contract's
  own guarantee rather than the happy path.
- **A derivation that could return an empty string.** The business name is derived from the email
  domain; `provisionalName('')` returned `''`, which the venue would have refused on a field nobody
  typed. A test caught it before anything ran.
- **A test that asserted only the hostname.** The proof view's security link was built as
  `/token/…` for what is a diamond **contract** — the mirror node 404s it — and the test asserted
  the URL contained `hashscan.io`, which every wrong HashScan URL also does.

### Two more, found only by running the agent against the live venue

Both were invisible to the test suite and to `tsc`, and neither is a bug in the sense of a wrong
line. They are the same class as the table above, one turn further on.

**A branch with a caller that could not reach it.** The agent was written to arm a trade, take the
`402`, sign the challenge and settle. It never took a `402`. Its pre-flight refused any mandate
whose capital was not escrowed on Arc — and the venue settles an escrowed mandate out of the vault,
answering `200` with both legs already done. So every trade the agent was willing to arm went down
the Arc branch, and the x402 branch was **unreachable by construction rather than by choice**.
Nothing errored. The branch even had a log line describing the signature it was waiting for, and
that line ran on the Arc path too, where nothing was waiting and the money had already moved. The
fix was a gate that asks about both rails and takes either, and a refusal that names both halves,
because a sentence naming only the vault sends the reader off to deposit USDC to fix a missing key.

**A client that gave up while the venue was still working.** Arming is two Hedera round trips and
takes about fifteen seconds; the agent's venue client had one timeout for everything and it
defaulted to ten. So the client aborted — and **the trade was armed anyway.** Hold placed, capital
allocated, the seller's paper committed, and nothing on the agent's side knew. The next tick tried
the same invoice and got a `409`, which was the venue protecting it rather than a fault, and the log
said "failed to act", which sends an operator looking for a bug instead of for the armed trade that
needs settling. `POST /v1/trades` now has its own budget, and an aborted trade request says what is
true: the outcome is unknown and the venue may have armed it. A read that aborts really did do
nothing, and says so separately.

The second one is a lesson `CLAUDE.md` had already recorded earlier the same day, about a different
library: **a timeout is not a revert.** It says the client stopped waiting, never that the server
stopped working, and code that reports one as a failure is asserting something it does not know.
Written down once against viem's receipt wait on the Arc rail, then learned again from scratch
against `fetch` in the agent, where the comment calls it a rollback rather than a revert and means
the same thing.

### Day three, and a guard that was only accidentally safe

The third day carried on closing the sweep above — giving callers to mechanisms that had none. An
adversarial review of that work found six defects, and the first of them is the one worth reading,
because it is a shape rather than a slip.

**Wiring a mechanism made an old guard dangerous without changing the guard.**
`withdrawFromMandate` had always marked a mandate `withdrawn` once its book hit zero, and
`fundMandate` refuses a withdrawn one. That was harmless for exactly as long as withdrawal moved
nothing but a SQLite row. Then `MandateVault.executeRelease` — one of the sweep's ten — was given
its caller, and the same status became a way to lose money: any outcome short of a completed release
left real USDC in the vault under `keccak256(uuid)` with nothing in the repo able to move it, and a
replacement mandate is a new UUID and a new bucket. **A test had pinned that state and called it
recoverable.** The route is ask-book-chain-close now, an unknown outcome leaves the mandate open at
a zero balance, and closing is a separate act.

It is the same shape as the Arc rail's double-spend and the delist guard: **a guard that holds only
because some other constraint happens to hold, with nothing in the guard naming the constraint.**
Wiring the mechanism it was quietly relying on is what makes the hole reachable — which means
closing a dead-mechanism finding is exactly when to re-read the guards around it.

The other five were ordinary and are listed in `CLAUDE.md`. Two are worth a line: withdrawing in
sub-unit slices bled the escrow, because the release quantity took `floor()` per call and five
99-cent withdrawals at 1 ppm released nothing while the book decremented in full — measuring the
wrong thing rather than rounding it wrongly, and the invariant held on every single call while the
capital drained across them. And a default freed the debtor concentration it had just lost money on,
because `defaulted` sat in the list of statuses that return capital.

### And one careless act, recorded rather than tidied away

While testing the duplicate check the model posted an invoice under a slightly different debtor
email, which created a second customer, a different uniqueness hash, and a legitimate listing that
issued a real bond for about 8 HBAR. `0.0.10343726` exists because of it. It is in
`docs/deployments.md` with its cause, on the same principle as every other blemish here: a book
whose job is to be checkable cannot have history quietly removed from underneath it.

## What was not AI at all

- Key material and account provisioning. Faucet funding, the operator, the buyer, and the collection
  account that exists specifically so that a payout cannot be drawn on the operator.
- Every transaction run by hand rather than by the venue: the contract deployments on both chains,
  and the ten-transaction sequence that turns a deployed bond into a tradeable one. The deployment
  transactions were driven from `facture-prep`, outside this repository, because they carry keys;
  that directory was deleted on 2026-09-06. Two sequences have since moved in:
  `scripts/prepare-security.mjs`, which reads the operator key from `packages/backend/.env`, and
  `scripts/sign-maturity-payout.mjs`, which reads the collection key from `.env.ops`. Neither
  holds a key of its own — the extraction was assisted, the runs against live instruments were
  not.
- The archaeology on the deployed ATS factory `0.0.9213391` — 27 historical `deployBond` calls read
  off the mirror node to price issuance without spending anything.
- Reading the deployed contract's own source for the regulation enum values rather than trusting
  documentation.
- Deciding, on the failures above, that the answer was a guard against the whole class rather than a
  patch to the one instance.

## Reproducing this claim

```
git log --format='%h %ad %s' --date=short          # 131 commits, three days
git log --stat 9833a3b                             # the selector fix
git show 1456033                                   # README and CLAUDE.md, first commit of prose
git show bea7201                                   # a mechanism with no caller, removed
git show fcf7b64                                   # a deployed contract, finally called
git show 64239a3                                   # the systematic sweep, ten more at once
git show f7fde24                                   # what the adversarial review caught
```

`CLAUDE.md` is the constraint record. `docs/deployments.md` is the chain record, and every figure in
it was read back from the network rather than copied from a log. Where the two disagreed, the chain
won, and the disagreement is written down.
