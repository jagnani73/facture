# AI tool usage

ETHGlobal asks entrants to say which parts of a project were built with AI assistance and which
files those were. This is that statement, reconstructed from the repository rather than from memory:
42 commits, their messages, their diffs, and the two documents the work was steered by.

The short version: **a model did nearly all of the typing, and a person made every decision the
typing was constrained by.** That division is not a hedge. It is legible in the repo, because the
constraints were written down before the code was, and the file they were written down in is
`CLAUDE.md`.

---

## The tool

[Claude Code](https://claude.com/claude-code), Anthropic's CLI, driven by one person in an
interactive terminal. No autonomous agent loop, no code generation service, no scaffolding
generator. Model choice varied across sessions and the repository does not record which model
wrote which commit, so this document does not claim one.

Supporting tools in the same sessions: MCP servers for PostgreSQL inspection and for Arc's live
documentation. `.mcp.json` is gitignored because it carries a connection string, which is why the
configuration itself is not in the tree — see commit `369abfe`.

**No AI attribution appears in any commit message**, by the author's standing preference. `git log`
carries no `Co-Authored-By` trailer and no generated-with footer. That is a formatting choice, not a
claim of hand-authorship, and this file exists so the choice does not amount to a misrepresentation.

## Shape of the work

42 commits, 2026-09-01 12:57 through 2026-09-02 18:18. Two days.

The first seven landed within 90 seconds of each other — a workspace scaffold, five package
skeletons and the two steering documents, staged together rather than developed commit by commit.
Everything after `685f821` is incremental, and the later history reads like what it was: a feature
landing, a live transaction failing, and a fix commit naming exactly what the failure was.

| package              | tracked lines | what it is                                           |
| -------------------- | ------------- | ---------------------------------------------------- |
| `packages/backend`   | 19,506        | Hono venue, SQLite store, ATS/x402/schedule adapters |
| `packages/web`       | 11,826        | Next.js screens, one data seam over API or fixtures  |
| `packages/contracts` | 9,292         | 19 Solidity files, Hardhat, deploy scripts           |
| `packages/agent`     | 4,294         | market-maker on Circle developer-controlled wallets  |
| `packages/shared`    | 4,075         | domain types, ISIN, pricing, state machines          |
| docs and READMEs     | 2,862         | five READMEs, `CLAUDE.md`, `docs/`                   |

30 test files, 9,491 lines. Written in the same sessions as the code they cover.

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
`AtsComplianceGate`, `InvoiceRegistry`, their interfaces, the mocks, and 3,182 lines of Hardhat
tests. The refusal vocabulary in `libraries/ReasonCodes.sol` was later renamed to match
`@facture/shared` exactly (`e6edbe6`), because two spellings of one refusal is a bug that only
surfaces when a funder reads a receipt.

**`packages/backend`** — the whole venue. Routes, the quote engine, the settlement service, the
issuance queue and its pacing, the ATS adapter, the x402 client, the schedule adapter, the SQLite
store and its migrations, the 1,025-line seeded demo book, and the tests.

**`packages/web`** — every screen, the fixture book, and the data seam that lets the same components
render against the venue or against fixtures.

**`packages/agent`** — the market maker, its Circle wallet client, its mandate pre-flight, and a
logger with a secret redactor registered before the environment is parsed.

**The documentation**, including `docs/deployments.md`, the four package READMEs, and the upstream
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
declare Reg S followed from that reading. `cb9d567` then changed one default in `env.ts`. The
research was hours; the diff was one line.

**The maturity payout rail.** The constraint that a debtor has no wallet is a product decision with
a behavioural argument behind it, and it rules out an entire class of design. Once stated, the model
built the collection-account rail, the schedule, the idempotency, and the read-back —
`services/schedule.ts`, now 394 lines, plus tests — across two commits.

**The compliance-at-quote fix.** The problem was noticed by a person watching a live run: MF-2051
quoted 925 bps from a buyer the instrument bars, and the 403 arrived after the seller had decided to
sell. The decision about how to fix it — check the winner and fall through, never screen the whole
book, treat an unreadable instrument as indeterminate rather than negative — is a judgement about
what a quote is allowed to cost. `4b90e1f` is the model implementing that judgement.

## What the model got wrong

Naming these is the point of the exercise. Every one is a commit in this repository.

**The `deployBond` tuple that never once worked** (`cb9d567`) is the flagship. The struct the
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

- `6ee1f16` — the compliance service called `isAuthorized`, `getKycAccountStatus` and `isPaused`.
  None exist. The real surface is `getControlListType()`, `isInControlList(address)`,
  `getKycStatusFor(address)` and `paused()`. It also read membership without reading list _type_,
  which inverts the answer on a blocklist instrument and admits exactly the party it was configured
  to exclude.
- `314d395` — `executeHold` called with the wrong argument shape.
- `8b165fe` — the security id was taken from `contractFunctionResult.contractId`, which is the
  contract that was _called_. Every invoice was recorded as owning the factory. Two perfectly good
  bonds are orphaned on testnet because of it, listed in `deployments.md` for exactly that reason.

Two more, of different kinds:

- `a591465` deleted a 754-line PostgreSQL store written the same day and replaced it with SQLite.
  The reasoning in the new file — a file on disk cannot be a container that failed to start — is
  right, and it should have been the first choice.
- `344465c` fixes a `tsx watch` invocation whose flags were in an order that does not work. Trivial,
  and it took a run to find.

One correction ran the other way. The local Hardhat figure of 6,978,091 gas for `deployBond` was
written off as an unreliable predictor of a real Hedera network. It landed within 0.02% of the live
median of 6,976,378.

## What was not AI at all

- Key material and account provisioning. Faucet funding, the operator, the buyer, and the collection
  account that exists specifically so that a payout cannot be drawn on the operator.
- Every transaction run by hand rather than by the venue: the contract deployments on both chains,
  and the ten-transaction sequence that turns a deployed bond into a tradeable one. Those live in
  `facture-prep`, outside this repository, because they carry keys.
- The archaeology on the deployed ATS factory `0.0.9213391` — 27 historical `deployBond` calls read
  off the mirror node to price issuance without spending anything.
- Reading the deployed contract's own source for the regulation enum values rather than trusting
  documentation.
- Deciding, on the failures above, that the answer was a guard against the whole class rather than a
  patch to the one instance.

## Reproducing this claim

```
git log --format='%h %ad %s' --date=short          # 42 commits, two days
git log --stat cb9d567                             # the selector fix
git show 7430e05                                   # README and CLAUDE.md, first commit of prose
```

`CLAUDE.md` is the constraint record. `docs/deployments.md` is the chain record, and every figure in
it was read back from the network rather than copied from a log. Where the two disagreed, the chain
won, and the disagreement is written down.
