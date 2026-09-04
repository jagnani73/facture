# `@facture/backend`

The API behind the book. Hono on Node, Postgres via Drizzle, Hedera for the paper and Arc
for the cash.

> **Status: skeleton.** Route structure, config, schema and service interfaces are real.
> Most handler and service bodies are `TODO` and return a `501` problem response rather
> than a plausible-looking lie. Nothing has been deployed and no migration has been run.

## Running it

```sh
cp .env.example .env      # then fill in the six required values
pnpm --filter @facture/backend dev
curl localhost:8787/health
```

Config is parsed at boot. A missing or malformed variable stops the process with every
problem listed at once, naming each variable — one restart per fix is a bad way to
configure a service.

| Script        | What it does                                      |
| ------------- | ------------------------------------------------- |
| `dev`         | `tsx watch src/index.ts`                          |
| `build`       | `tsc` to `dist/`                                  |
| `start`       | `node dist/index.js`                              |
| `typecheck`   | `tsc --noEmit`                                    |
| `test`        | `vitest run`                                      |
| `db:generate` | writes SQL into `src/db/migrations`               |
| `db:migrate`  | applies it — **not yet run against any database** |

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

## Services

| Module                     | State                                                            |
| -------------------------- | ---------------------------------------------------------------- |
| `services/quote-engine.ts` | orchestration real, wraps `bestQuote`; data access stubbed       |
| `services/issuance.ts`     | **queue is real** — serial, paced, backoff; `deployBond` stubbed |
| `services/settlement.ts`   | interfaces and leg receipts typed; all three legs stubbed        |
| `services/x402.ts`         | facilitator HTTP client real; payment signing stubbed            |
| `services/rating.ts`       | **bucketing is real and tested**; persistence stubbed            |
| `services/indexer.ts`      | chain heads read for real; cursors in memory                     |

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
except a customer already known to default. The `rating_grade` Postgres enum is declared
worst-first for the same reason: `debtor.rating >= mandate.rating_floor` in SQL has to mean
what `meetsRatingFloor` means in TypeScript.

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
