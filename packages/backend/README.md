# `@facture/backend`

The API behind the book. Hono on Node, SQLite via Drizzle, Hedera for the paper and Arc
for the cash.

> **Status: implemented, undeployed.** Every route and service body is written and
> exercised by tests — nothing returns `501` any more. The database is the one dependency
> that is fully real: `pnpm db:migrate && pnpm db:seed` builds the whole demo book in a
> file. What is _not_ done is the part that needs a chain: no ATS factory is configured and
> no contract has been deployed. The two seams that reach one (`services/ats.ts`,
> `services/compliance.ts`) fail loudly rather than simulating, which is why
> `ATS_FACTORY_ID` being unset disables issuance instead of faking it.

## Running it

```sh
cp .env.example .env      # then fill in the required values; DATABASE_URL is a file path
pnpm --filter @facture/backend db:migrate  # creates the file and its 12 tables
pnpm --filter @facture/backend db:seed     # the demo book
pnpm --filter @facture/backend dev
curl localhost:8787/health
```

Config is parsed at boot. A missing or malformed variable stops the process with every
problem listed at once, naming each variable — one restart per fix is a bad way to
configure a service.

| Script        | What it does                                            |
| ------------- | ------------------------------------------------------- |
| `dev`         | `tsx watch src/index.ts`                                |
| `build`       | `tsc` to `dist/`                                        |
| `start`       | `node dist/index.js`                                    |
| `typecheck`   | `tsc --noEmit`                                          |
| `test`        | `vitest run`                                            |
| `db:generate` | writes SQL into `src/db/migrations`                     |
| `db:migrate`  | applies it, creating the SQLite file if it is not there |
| `db:seed`     | fills that file with the demo book (`src/db/seed.ts`)   |

## Routes

Grouped by actor. `/health` sits outside the version prefix because it is operational,
not product surface.

| Method | Path                                    | Actor  |                                                     |
| ------ | --------------------------------------- | ------ | --------------------------------------------------- |
| GET    | `/health`                               | ops    | service status, indexer cursor vs chain head, queue |
| POST   | `/v1/invoices`                          | seller | create; queues issuance, returns `202`              |
| GET    | `/v1/invoices`                          | seller | the book, each row with a live price                |
| GET    | `/v1/invoices/:id`                      | seller | detail incl. issuance state                         |
| POST   | `/v1/invoices/:id/confirmation-request` | seller | email the debtor a confirmation link                |
| GET    | `/v1/confirm/:token`                    | debtor | one sentence, two buttons — no wallet, no signup    |
| POST   | `/v1/confirm/:token`                    | debtor | confirm or dispute                                  |
| GET    | `/v1/invoices/:id/quote`                | seller | best live quote **plus refusals**                   |
| POST   | `/v1/mandates`                          | buyer  | post a standing bid                                 |
| POST   | `/v1/mandates/:id/fund`                 | buyer  | escrow — this is what makes the quote firm          |
| GET    | `/v1/mandates`                          | buyer  | list                                                |
| GET    | `/v1/mandates/exposure`                 | buyer  | exposure across the book                            |
| GET    | `/v1/mandates/:id/exposure`             | buyer  | exposure for one mandate                            |
| POST   | `/v1/mandates/:id/withdraw`             | buyer  | withdraw unallocated capital only                   |
| POST   | `/v1/trades`                            | both   | execute a sale (DvP)                                |
| GET    | `/v1/trades`                            | both   | list                                                |
| GET    | `/v1/trades/:id`                        | both   | detail                                              |
| GET    | `/v1/trades/:id/proof`                  | both   | the audit view, one click from any trade            |

Errors are `application/problem+json` with a stable `code` and the request id, so a client
can branch on the failure without matching on prose.

A **refusal is not an error.** A mandate that will not take a piece of paper is reported
in the `200` quote body with a reason in words and an HCS receipt reference, because
telling a funder why they were not matched is a product output, not a failure.

`POST /v1/trades` is **both halves of one x402 exchange**, not two routes. The first
request arms the trade and answers `402` carrying `PAYMENT-REQUIRED`; the buyer signs the
challenge and repeats the same request with `PAYMENT-SIGNATURE`, which is the leg that
moves money. Splitting them would let a client execute a payment against a challenge it
never received.

`GET /v1/invoices/:id/quote` returns a `quoteId` beside the price. A trade is executed
against that id because a seller must never be filled at a price they were not shown; an
identical unexpired quote is reused rather than rewritten, so the route stays safe to poll.

## Services

| Module                     | What it does                                                         |
| -------------------------- | -------------------------------------------------------------------- |
| `services/quote-engine.ts` | wraps `bestQuote`; `priceOne`, and `priceBook` in one batched pass   |
| `services/issuance.ts`     | serial, paced, backoff; persists queue state through `IssuanceSink`  |
| `services/ats.ts`          | `deployBond` and the ATS hold, over `@hiero-ledger/sdk`              |
| `services/compliance.ts`   | the pre-match `ControlList` / `Kyc` / `isPaused` probe; fails closed |
| `services/settlement.ts`   | prepare / execute / unwind / maturity, both legs                     |
| `services/x402.ts`         | facilitator client — `supported`, `verify`, `settle`                 |
| `services/rating.ts`       | the ladder, plus the idempotent outcome ledger behind it             |
| `services/confirmation.ts` | debtor tokens: HMAC tag checked first, SHA-256 stored                |
| `services/notifier.ts`     | **no mail transport** — the link is logged, and that is said plainly |
| `services/indexer.ts`      | chain heads read for real; cursors persisted                         |

### The persistence seam

`src/db/store.ts` is the interface every route and service reads and writes through, and
there are two implementations: `sqlite-store.ts` (Drizzle over `better-sqlite3`) and
`memory-store.ts`. The second is not a convenience — it is why the orchestration in the
routes is real, exercised code rather than something that first executes on a stage with a
database behind it. It implements the same clamping, the same idempotency and the same "a
withdrawal loses to an allocation" ordering, because a fake that is easier to satisfy than
the real thing tests nothing.

The engine is SQLite because this is a demo and a file on disk cannot be down, cannot
refuse a connection and cannot be a container that did not start. `DATABASE_URL` is
therefore a path, not a URL. Three consequences are load-bearing and are written up where
they live:

- **Money is a `TEXT` column read into `bigint`** (`bigintText` in `schema.ts`).
  `better-sqlite3` returns INTEGERs as JS `number`s, which lose precision above 2^53 with
  nothing to indicate it. Nothing sums or compares an amount in SQL — `debtorExposure` and
  `recordOutcome` do that arithmetic in JS, inside a transaction.
- **Instants are `INTEGER` epoch milliseconds**, mapped to and from `Date` by Drizzle, so
  they stay absolute, sort numerically, and leave `projections.ts` untouched.
- **There is no `SELECT … FOR UPDATE`, and it is not needed.** SQLite admits one writer at
  a time, so every contended write is one `BEGIN IMMEDIATE` transaction instead. See the
  header of `sqlite-store.ts` before "restoring" anything.

A Postgres implementation existed and was deleted rather than carried; the seam is what
makes that reversible.

`src/db/seed.ts` fills either one with the demo book, which is the same market the web
package renders from its fixtures — including the two invoices that carry the argument:
**MF-2046** clearing at 18.5% from the wide end of the book, and **MF-2047** refused by
every mandate because `D` ranks below `UNRATED`.

### Why issuance is a queue

One `deployBond` per invoice, ~7M gas, ~94 facet initialisations in a single transaction.
Hedera throttles on network gas throughput as well as per-transaction gas, so a seller
adding twenty invoices at once starts getting `BUSY` back long before any single
deployment is refused. Issuance runs strictly serially with a pacing floor and exponential
backoff with jitter, and the invoice reads as _being added_ until its instrument exists.

This costs nothing, because tokenisation happens at onboarding rather than at sale — it
was never on the critical path of the moment money moves.

### Why the x402 client looks the way it does

Two traps, both already hit by the reference PoC:

- Blocky402's docs snippets still show the legacy `X-PAYMENT` header. The shipped
  `@x402/*` **2.24.0** packages speak v2: `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` /
  `PAYMENT-RESPONSE`. Follow the SDK, not the docs.
- `extra.feePayer` is fetched at runtime from `GET /supported` and cached, never
  hardcoded. Hardcoding works until the facilitator rotates the payer, then fails as an
  opaque signature mismatch.

Settlement is in **HBAR** (`asset: 0.0.0`) by default. Every HTS token — USDC on Hedera
included — needs explicit association by the receiver before it can be received, on both
sides, so HTS sits behind `X402_ASSET_MODE=hts`.

### How a rating is earned

A debtor starts `UNRATED`. `score = settledOnTime - 2 * settledLate`, and a late payment
costs two on-time ones because lateness leads the default the buyer actually cares about.

| Condition         | Grade          |
| ----------------- | -------------- |
| any default, ever | `D`, permanent |
| score ≥ 8         | `A`            |
| score ≥ 4         | `B`            |
| score ≥ 1         | `C`            |
| otherwise         | `UNRATED`      |

The scale is `A | B | C | D | UNRATED` and it is deliberately not agency notation: these
grades are earned from settled payments on Facture and nothing outside it recognises them,
so borrowing `AAA` would claim an authority the score does not have.

`D` ranks **below** `UNRATED` in `RATING_RANK` — a default is information, an absence of
history is not. A mandate with a floor of `C` therefore excludes unrated _and_ defaulted
customers, and a floor of `UNRATED` — the widest a buyer can write — accepts everything
except a customer already known to default. `RATING_GRADE` in `schema.ts` is still declared
worst-first because that tuple _is_ the ladder — but on SQLite it is documentation, not
behaviour: the column is `TEXT`, so a SQL comparison would order it alphabetically and get
the answer backwards. Every rating-floor decision is taken by `meetsRatingFloor` in
TypeScript, over rows the store deliberately over-fetches.

Not in v1, in rough order of how much they matter: magnitude weighting (ten $500 invoices
do not prove a debtor good for $50k), recency decay, and concentration (a history from one
seller is worth less than the same history from five). See `services/rating.ts`.

## Notes for whoever picks this up

- **Module resolution is `NodeNext`, not the workspace default `bundler`.** This package
  actually runs on Node, so relative imports carry `.js` extensions and `tsc` output is
  runnable as-is. Everything else in the repo can stay on `bundler`.
- **`src/chain.ts` is the only adapter onto `@facture/shared`'s chain table.** Shared
  exports whole chain objects — `ARC_TESTNET`, `HEDERA_TESTNET`, `CHAINS` keyed by
  `ChainKey` — plus the explorer URL builders. This file flattens them onto the shape the
  rest of the backend reads, so a change in shared lands in one place. Chain constants are
  read from shared rather than the environment so there is one source of truth; where an
  env knob is _bounded_ by one (the Arc 20 Gwei gas floor), `env.ts` reads the bound from
  here rather than carrying its own copy.
- **The domain vocabulary is `@facture/shared`'s, not this package's.** `Invoice.faceValue`
  and `Invoice.dueAt`, `Mandate.minRating`, `bestQuote(invoice, mandates, debtor)`
  positionally, `SettlementLegState` spelling the escrowed state `held`. `src/db/schema.ts`
  carries `Expect<Drift<…>>` assertions that fail the typecheck — naming the missing member
  — if the DB enums fall behind `InvoiceStatus`, `Rating` or `MandateStatus`.
- Money is `bigint` minor units internally — columns and every arithmetic path — and a
  decimal string on the wire, because a JSON number is an IEEE-754 double and amounts pass
  2^53. **`src/wire.ts` owns both directions and is the only place that decides:**
  `moneyString` parses inbound, `money` renders outbound, `wireQuote` / `wireRefusalReceipt`
  convert the domain records that carry amounts. Do not open-code a second amount regex.
  Wire field names are the domain names — `faceValue`, matching `Invoice.faceValue` in
  shared and the `face_value` column — so nothing has to be translated between layers.
- Tests are excluded from `tsconfig.json` (they would land in `dist/`); vitest type-checks
  them itself.
- **The ABI fragments in `services/ats.ts` are transcribed, not generated.** ATS is a
  ~94-facet diamond this project neither deploys nor controls, and a facet upgrade can
  reorder a struct. Verify them against the pinned factory before the first real
  `deployBond`. A drifted selector comes back as `CONTRACT_REVERT_EXECUTED`, which
  `isRetryable` classifies as terminal, so an invoice fails visibly on the first attempt
  rather than burning six.
- **`ATS_FACTORY_ID` unset disables issuance; it does not simulate it.** A plausible
  security id for an instrument that does not exist would survive as far as the proof
  view, which is the one screen whose whole job is to be checkable.
- **The debtor's maturity payment has no rail here.** `settleAtMaturity` finds the current
  holder, records the outcome and releases the mandate's capital, and reports the cash leg
  as `pending` with the payout requirement built. Marking it `settled` would put a payment
  on the proof view that nobody made.
