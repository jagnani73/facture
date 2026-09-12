# `@facture/agent`

The market maker. A process that reads the venue's book on a loop, arms a trade on whatever its
mandates will take, and pays for it. It carries two identities on purpose: a Circle wallet on Arc,
whose one job is putting capital into `MandateVault`, and a Hedera key that signs the x402 cash leg
per trade.

```bash
pnpm --filter @facture/agent start       # tsx src/main.ts
pnpm --filter @facture/agent fund        # plan a vault deposit; nothing moves without --execute
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

**In the current demo book the standing bids are seeded rows, not bids this agent wrote** — it
operates them rather than having written them. It has settled a trade end to end, though: it read
the book, priced it, armed the trade, signed the cash leg with the buyer's own Hedera key and paid
the quoted proceeds. Trade `c0c8ed97-b01d-4c30-b9b2-0ddf7472fa3d`, cash
`0.0.7162784@1788449867.590233238`. See [`docs/deployments.md`](../../docs/deployments.md).

| Path             | What it holds                                                          |
| ---------------- | ---------------------------------------------------------------------- |
| `src/main.ts`    | Boot order, the tick loop, and a stop that lets the current tick drain |
| `src/agent.ts`   | One tick: read mandates, read the book, price, arm, pay                |
| `src/mandate.ts` | The pure decision — whether a mandate takes an invoice, and why not    |
| `src/cash.ts`    | The buyer's Hedera key, and the x402 cash leg it signs                 |
| `src/wallet.ts`  | Transport over Circle Developer-Controlled Wallets. No product logic   |
| `src/vault.ts`   | Posting the agent's own capital into `MandateVault` on Arc             |
| `src/fund.ts`    | The `fund` command: read, plan, and only on request, deposit           |
| `src/venue.ts`   | The venue's HTTP surface, typed                                        |
| `src/env.ts`     | Configuration, validated at startup                                    |
| `src/logger.ts`  | Structured logging, with the secret redactor registered before the env |

## The four things to know before changing anything

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

### 2. The pre-flight asks about both rails, and there is no last look

A trade this process arms has to be payable by something. `checkCashLegPayable` takes either
answer: the mandate's capital escrowed in `MandateVault`, or a Hedera key with a balance to sign
with. The refusal, `CASH_LEG_UNPAYABLE`, names **both** halves — a sentence mentioning only the
vault sends the reader off to deposit USDC to fix a missing key. It converts no prices: the one
comparison is tinybars against tinybars, made after the challenge has named the figure in the
payer's own unit, so the venue's ppm scale stays in the venue.

**There used to be a second wallet read immediately before arming, and it is deliberately gone.**
The reasoning was that the balance had to be true at the moment money was promised. The reasoning
was sound and the pot was wrong — the Circle wallet settles neither rail. The vault reading taken at
the top of the tick is not re-fetched to replace it either, because the venue re-decides the rail at
arm time: `chooseRail` reads the vault on every `POST /v1/trades` and drops to x402 if the capital
is no longer there, so a stale reading here costs a wasted arm, never a bad settlement. Paying for
that certainty would mean a mandates fetch per invoice, which is the N+1 the venue's own pricing
path exists to avoid.

Local state covers only the thing no chain can answer — how much _this tick_ has already promised —
because two invoices considered a millisecond apart would otherwise both be told the same dollar is
free.

### 3. It refuses in the venue's vocabulary, not its own

A refusal has to read the same in a `MatchRefused` event, in the API and here, or the product's
claim that every refusal names its reason quietly stops being true. The codes come from
`@facture/shared`, and `ON_CHAIN_REASON_CODE` records the only three places the two vocabularies
do not line up — one real translation (`INELIGIBLE_JURISDICTION → CONTROL_LIST_BLOCKED`, decided by
the compliance gate rather than the book) and two refusals the on-chain book cannot model. The
identities are enforced by the type, and a test reads `ReasonCodes.sol` directly, because
TypeScript cannot see a Solidity rename.

### 4. The wallet's one job is funding the vault

The Circle wallet pays for neither settlement rail. A funded mandate settles out of `MandateVault`,
which the venue draws on with its own key; an unfunded one settles over x402 on Hedera, and that
needs a native Hedera signature no Circle wallet can produce. So the balance this process reads
every tick has exactly one place it can be put to work, and that is the vault.

`pnpm fund` reads the venue and the vault, plans a deposit per mandate, and carries it out only if
you ask:

```bash
pnpm --filter @facture/agent fund                       # plan every mandate, spend nothing
pnpm --filter @facture/agent fund -- --mandate <uuid>   # plan one
pnpm --filter @facture/agent fund -- --execute          # deposit
```

- **`--execute` is the only thing that authorises a spend**, and it is typed rather than
  configured. `AGENT_DRY_RUN` governs the trading loop; it does not govern this.
- **It never registers a mandate.** `deposit` reverts against an unregistered one, and registering
  is `POST /v1/mandates` on the venue: one-shot, and it names the only address a release may ever
  pay. An unregistered mandate is refused with a sentence pointing at that route.
- **It will not fund a mandate registered to another address.** The deposit would be credited
  anyway — `deposit` pulls from `msg.sender` and asks nothing about who — but `executeRelease` pays
  `buyerOf` and takes no recipient argument, so the capital could only ever come back to somebody
  else.
- **It converts nothing.** The deposit is `requiredUsdcMinor` off the venue's own mandate row, less
  what the vault already holds. The ppm scale behind that figure stays in the venue, where its one
  copy belongs.
- **A deposit Circle has not reported on comes back as unknown, never as failed**, and the vault
  balance is read again either way. A balance that moved is a deposit that happened, whatever the
  transaction state says.

## Configuration

See [`.env.example`](./.env.example). Three settings decide what this process can spend, and on
which command:

- **`AGENT_DRY_RUN` defaults to `true`.** The agent reads, prices and reports; it arms nothing.
  Turning it off is what makes the mandate cap load-bearing. It governs `start`, not `fund`.
- **`AGENT_MAX_SLIPPAGE_BPS` defaults to `0`** — the price it arms at is the price it was quoted.
- **The vault address is not configurable**, and that is what stops `fund` depositing
  somewhere the venue never reads. Both processes take it from `@facture/shared`, so they
  cannot name different deployments.
- **`AGENT_HEDERA_ACCOUNT_ID` and `AGENT_HEDERA_PRIVATE_KEY` are optional and all-or-nothing.**
  Unset disables the x402 rail rather than relaxing it. Half a pair behaves exactly like no rail
  while looking like a working one in a `.env`, so it is refused by name. With both set and
  `AGENT_DRY_RUN=false`, a live run signs and submits a transfer of the buyer's own HBAR for every
  trade the venue prices on that rail, and nothing between the decision and consensus asks a second
  time. The key is registered with the log redactor from `process.env` **before** the schema parses
  it, because `PrivateKey.fromStringECDSA` throws on a bad key and that is the one path guaranteed
  to run while holding it.

`CIRCLE_API_KEY` and `CIRCLE_ENTITY_SECRET` are secrets and are never committed. USDC on Arc is
6 decimals through the ERC-20 interface while native gas accounting is 18; selecting the wrong one
is a factor of a trillion, so balances are always selected by contract address.
