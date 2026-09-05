# `@facture/agent`

The market maker. A process that holds funded mandates on a Circle wallet, reads the venue's book
on a loop, and arms a trade on whatever its mandates will take.

```bash
pnpm --filter @facture/agent start       # tsx src/main.ts
pnpm --filter @facture/agent typecheck
pnpm --filter @facture/agent test        # vitest
```

There is no build step: this package is run, not imported.

## Why it exists

The README's argument turns on standing bids being real. A quote on a seller's screen is only
worth what is behind it, so the thing posting those bids has to be an actual counterparty with
actual money — not a row in a fixtures file dressed up as one. Fake liquidity is the single claim
that would undo every other one in the product.

That is also why this package can be cut without the product changing shape. Mandates need to be
_funded_; whether a person or a process operates one is incidental. It is item 2 on the cut list
for exactly that reason.

**In the current demo book the standing bids are seeded rows, not bids this agent wrote.** The
agent runs, prices the book and reports what it would take; it has not been the source of the
liquidity in any settled trade so far.

| Path             | What it holds                                                        |
| ---------------- | -------------------------------------------------------------------- |
| `src/agent.ts`   | One tick: read mandates, read the book, price, arm                   |
| `src/mandate.ts` | The pure decision — whether a mandate takes an invoice, and why not  |
| `src/wallet.ts`  | Transport over Circle Developer-Controlled Wallets. No product logic |
| `src/venue.ts`   | The venue's HTTP surface, typed                                      |
| `src/env.ts`     | Configuration, validated at startup                                  |

## The three things to know before changing anything

### 1. The cap is ours. Circle enforces nothing.

Circle's Developer-Controlled Wallets have **no policy engine** — Circle's own documentation says
to enforce such controls in your application. The spending-policy product that does exist requires
a _mainnet_ Agent Wallet, and Arc has no mainnet identifier in Agent Wallets at all. So there is no
configuration of Circle, on this chain, that would enforce a mandate.

It could not express one anyway. Circle offers flat per-transaction and rolling-window caps; a
mandate is a rating×tenor bucket with a per-debtor sub-limit and a lifetime ceiling. No arrangement
of those primitives produces it.

Every check in `mandate.ts` therefore runs **before** any Circle call. If `decide` returns an
acceptance it did not mean, money moves, and nothing downstream will catch it.

### 2. The balance is read from the chain every tick, never from memory

An agent quoting from a remembered balance is backing the seller's screen with this process's
belief rather than with money. So each tick re-reads the wallet's USDC balance from Circle, and
re-reads it again immediately before any live arm.

Local state covers only the thing the chain cannot answer — how much _this tick_ has already
promised — because two invoices considered a millisecond apart would otherwise both be told the
same dollar is free.

### 3. It refuses in the venue's vocabulary, not its own

A refusal has to read the same in a `MatchRefused` event, in the API and here, or the product's
claim that every refusal names its reason quietly stops being true. The codes come from
`@facture/shared`, and `ON_CHAIN_REASON_CODE` records the only three places the two vocabularies
do not line up — one real translation (`INELIGIBLE_JURISDICTION → CONTROL_LIST_BLOCKED`, decided by
the compliance gate rather than the book) and two refusals the on-chain book cannot model. The
identities are enforced by the type, and a test reads `ReasonCodes.sol` directly, because
TypeScript cannot see a Solidity rename.

## Configuration

See [`.env.example`](./.env.example). Two settings decide whether this process can spend:

- **`AGENT_DRY_RUN` defaults to `true`.** The agent reads, prices and reports; it arms nothing.
  Turning it off is what makes the mandate cap load-bearing.
- **`AGENT_MAX_SLIPPAGE_BPS` defaults to `0`** — the price it arms at is the price it was quoted.

`CIRCLE_API_KEY` and `CIRCLE_ENTITY_SECRET` are secrets and are never committed. USDC on Arc is
6 decimals through the ERC-20 interface while native gas accounting is 18; selecting the wrong one
is a factor of a trillion, so balances are always selected by contract address.
