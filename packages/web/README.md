# @facture/web

The Facture front end. Next.js 15 (App Router), React 19, TypeScript strict, Tailwind v4.

Nobody using this application needs to know it is on a blockchain. A seller sees invoices with
prices beside them; a buyer sees mandates, exposure and yield. Every primitive in this market
already has a plain financial name, so that is the name it is given. The chains surface in exactly
one place — `/proof/[tradeId]`, one click from any trade.

```bash
pnpm --filter @facture/shared build     # web typechecks against shared's dist
pnpm --filter @facture/web dev          # http://localhost:3000
pnpm --filter @facture/web typecheck
pnpm --filter @facture/web lint
pnpm --filter @facture/web build
```

## Routes

| Route               | What it is                                                                       |
| ------------------- | -------------------------------------------------------------------------------- |
| `/`                 | The thesis. An invoice is a zero-coupon bond that nobody ever priced.            |
| `/book`             | **The seller's book.** The core screen. Quotable invoices carry a live price.    |
| `/book/[invoiceId]` | One invoice: face, tenor, rate, discount, proceeds, and offering it for sale.    |
| `/book/new`         | Add invoices — single entry, or pasted straight out of a spreadsheet.            |
| `/confirm/[token]`  | The debtor confirmation page. One sentence, two buttons, no account.             |
| `/mandates`         | The buyer's side: standing bids, exposure used, weighted yield, maturity ladder. |
| `/mandates/new`     | Write a mandate, with the implied price and its matches shown as you type.       |
| `/proof/[tradeId]`  | The audit view. The only screen where chain vocabulary is allowed.               |

Worth opening against the demo book: `/book/INV-2041` (four mandates would take it, at 8.00%),
`/book/INV-2046` and `/book/INV-2047` (confirmed, and one clears at 18.50% while nothing at all
will take the other — for two different reasons, both named), `/confirm/kq7m2xhd`,
`/proof/TRD-4417`.

`/confirm/[token]` deliberately sits outside the `(app)` route group, so it inherits none of the
market chrome — no masthead, no nav, no bid prices. Somebody's accounts payable clerk should not be
shown a page of paper prices to acknowledge their own ledger entry. The record that page reads
(`ConfirmationRecord`) has no price on it at all, so there is nothing to leak even by accident, and
every state of the page — loading, failed, expired, answered — renders through the same bare shell.

The Privy provider is mounted in the `(app)` group and **not** in the root layout, which is what
keeps sign-in away from that page: a debtor confirms with no wallet and no signup, and giving a
customer a key to manage collapses the behavioural argument the whole product rests on. A seller
signs in by email and the wallet Privy makes is recorded against the business; the only thing that
wallet ever signs is `ClaimPayout`, on the proof view, after the trade is done.

## Design direction

Short-dated credit paper. The reference is a printed money-market page, not a dashboard: warm ecru
stock, ink that is not quite black, hairline rules carrying the structure instead of shadows, and a
single deep teal for anything actionable. Semantics are deliberately desaturated — this is a
document, not a status board.

Three typefaces, three jobs:

- **Newsreader** — the editorial voice. A screen-native text serif drawn for news, which is what a
  page of paper prices is.
- **Archivo** — the chrome. A grotesque that holds up at label sizes without competing with figures.
- **JetBrains Mono** — the ledger column. Genuinely tabular, unambiguous zero.

All three are variable fonts, loaded and self-hosted through `next/font/google`.

Every colour, radius and type stack is a CSS custom property on `:root` in `src/app/globals.css`.
Dark mode redefines the same tokens under `prefers-color-scheme` (guarded so an explicit light
choice still wins) and again under `[data-theme='dark']` for the toggle — so light and dark are the
same layout on different stock, and no component carries a `dark:` variant. Nothing new may define
a colour only inside a media query; the loading and failure states use the same tokens as
everything else.

Digits align everywhere: `tabular-nums` is applied at the base layer to tables and anything marked
`data-num`, and the `num` utility sets the mono stack with tabular figures for every figure that
sits in a column.

## Components

`src/components/`

| Component         | Notes                                                                             |
| ----------------- | --------------------------------------------------------------------------------- |
| `price-cell`      | The live quote. Not a button that fetches one — the number is there and it moves. |
| `rating-chip`     | Earned A–D grade, carrying its settled-invoice count as the reason for itself.    |
| `status-pill`     | The invoice state machine, with a sentence of explanation on every state.         |
| `mandate-card`    | A standing bid as its owner reads it, with the policy restated as a sentence.     |
| `exposure-meter`  | Utilisation stacked by customer, with the per-customer cap drawn as a tick.       |
| `maturity-ladder` | When the money comes back, bucketed by tenor.                                     |
| `refusal-notice`  | A refusal in words, naming its reason. Never "transaction reverted".              |
| `curve-strip`     | The curve — which is nothing but the standing bids, plotted.                      |
| `market-ticker`   | The masthead's strip of figures, read from the market rather than assembled.      |
| `offer-control`   | List and delist. Quotable and sellable are different permissions.                 |
| `claim-payout`    | The one transaction a person signs — collecting an Arc escrow lock.               |
| `money`           | The only sanctioned way to put an amount on screen.                               |
| `ui/primitives`   | Card, Button, Field, Row, Label, PageHeader.                                      |
| `ui/async`        | Waiting, and not getting an answer. Both written the way a refusal is written.    |

## Where the domain stops and the UI starts

`src/lib/domain.ts` is the seam onto `@facture/shared`, and every piece of market logic goes through
it. It is deliberately thin: eligibility, ranking, refusals and the curve maths are all the shared
package's, so the screen and the venue cannot disagree about who would take an invoice or at what
price.

One file imports shared directly and is not domain logic — `privy-provider.tsx` takes `ARC_TESTNET`
to declare the one chain the app transacts on, and a chain id read from anywhere else is how a
provider ends up pointed at a different network than the venue. The invariant is that **market
logic** comes through `domain.ts`, not that the import appears nowhere else.

- **`bestQuote(invoice, mandates, debtor, { asOf })`** is what the venue matches on. Against the
  demo book it is also what produces every price on screen. Against the live venue the price comes
  from `GET /v1/invoices/:id/quote` instead, and `bestQuote` is used only where there is nothing for
  the venue to price: the mandate composer's "what it would take today", and the price preview on a
  invoice that has not been added yet. Both are simulations of a bid that does not exist, and they
  say so.
- **`explainRefusal`** writes the refusal sentences. `refusal-notice.tsx` owns only the short
  clause forms, for table cells with no room for a sentence.
- `src/lib/pricing.ts` holds what a screen needs and the domain does not: portfolio views
  (`Position`, weighted yield, the maturity ladder), the curve projection, and the rating copy.

### Money and the server/client boundary

Money is `bigint` minor units — cents for USD, per the shared package's `CURRENCY_DECIMALS`. A raw
`bigint` is never rendered; it becomes a string only in `src/lib/format.ts`, which builds on
shared's own `formatMinorUnits` so a figure on screen matches a figure on a receipt.

Because a `bigint` cannot be relied on to cross the Server Component boundary, any subtree that
handles money renders inside a **client container that owns its own data** (`src/components/views/*`).
Server pages are thin: they await `params` and pass string ids down. Presentational components with
no hooks (`money`, `status-pill`, `rating-chip`, `exposure-meter`, `maturity-ladder`,
`refusal-notice`, `curve-strip`) carry no `'use client'` directive and work in both worlds.

## Data

Every screen reads the market through **`src/lib/data`**, and nothing else — no component imports
`fixtures` and no component imports the API client. That module has two implementations of one
interface, and which one answers is decided in exactly one place:

| File                             | What it is                                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/api/config.ts`          | Picks the source. `NEXT_PUBLIC_API_BASE_URL` set → the service; unset → the demo book. `NEXT_PUBLIC_FACTURE_DATA_SOURCE` overrides either way. |
| `src/lib/api/client.ts`          | One function per backend route, requests shaped by the zod schemas in `packages/backend/src/routes/`.                                          |
| `src/lib/api/contract.ts`        | The only place a wire value becomes a domain value, read against `packages/backend/src/wire.ts`.                                               |
| `src/lib/api/problem.ts`         | RFC 9457 `application/problem+json`, turned into a sentence.                                                                                   |
| `src/lib/data/api-source.ts`     | The live book.                                                                                                                                 |
| `src/lib/data/fixture-source.ts` | The demo book, over the untouched `src/lib/fixtures.ts`.                                                                                       |
| `src/lib/data/index.ts`          | The door. Reads, and the seven things a person can actually do.                                                                                |
| `src/lib/data/hooks.ts`          | `useMarket`, `useConfirmation`, `useProof` — three states, never a fourth.                                                                     |
| `src/lib/settlement.ts`          | Where a trade actually got to. Six states, derived from the legs first.                                                                        |

Swapping back is one environment variable. See [`.env.example`](./.env.example).

The seller and buyer ids are required in `api` mode: the venue scopes `/v1/invoices` and
`/v1/mandates` by a `z.uuid()`, so a missing or malformed one is caught here and reported by name
rather than arriving as a 422 on every screen at once.

### Money on the wire

The backend owns this rule in `packages/backend/src/wire.ts` and this package obeys it: **an amount
is a decimal string of minor units on the wire and a `bigint` in the app.** `JSON.parse` produces a
double, exact only below 2^53, and a per-debtor exposure ladder passes that without anything looking
wrong. `contract.ts` converts in both directions, and rejects a `number` where an amount belongs
rather than coercing it — a `number` there means the convention was dropped, and accepting it
quietly reintroduces exactly the silent corruption the convention exists to prevent.

### The sale has five endings, and only one of them is a sale

`POST /v1/trades` is one route carrying **two settlement rails**, and it answers in five
ways. Three of them were previously collapsed into "it worked" or "it failed", which made the
screen claim things that had not happened. `SaleOutcome` in `src/lib/data/index.ts` names all
five and `SellPanel` gives three of them their own panel.

`settled` is now reachable two ways, and the difference decides the sentence a seller reads.
A funded mandate settles on the **first** call and comes back `200`; an unfunded one settles
on the second, after the challenge. So `SaleOutcome.settled` carries `rail`, and it is not
defaulted to x402 — asserting the wrong rail would describe a payment protocol that never
ran, on the screen where a seller decides whether to trust the venue. A vault settlement also
says that the proceeds are in an escrow the seller still has to claim, which the x402 sentence
has no reason to mention.

- **Settled.** Both legs. The only ending that is a sale, and the only one drawn in the
  positive colour.
- **402, `awaiting_payment`.** The paper is **held** on Hedera and the cash leg is unsigned.
  Nothing has moved. The panel shows the challenge the other side was handed — scheme,
  network, asset, amount, `payTo`, expiry — and says the amount is the settlement asset's
  own smallest unit rather than the invoice's currency.
- **403, `refused`.** The compliance refusal, checked against the security's own
  `ControlList` and `Kyc` facets **before** matching. Nothing was reserved, nothing was held
  and nothing moved. This is the product's distinguishing claim, so it is not styled as a
  failure and does not use the word — see below.
- **500 carrying "half-settled".** The payment settled and the security did not transfer.
  **The money moved.** See below.
- **Everything else, `failed`,** in words.

### The refusal, and the trace inside it

Against a live ATS security the venue's 403 detail is a sentence — _"Harrow Point is not
permitted to hold this security by its control list."_ Against an instrument it cannot read,
the same field arrives as `COMPLIANCE_PROBE_FAILED:` followed by a whole viem call trace —
contract address, selector, ABI docs link, library version — inline, and then the closing
sentence. All of it is true and none of it is the answer.

`splitDetail` in `src/lib/api/problem.ts` lifts out any parenthesis containing a line break
and reads a leading `SCREAMING_CODE:` as a label. The sentence stands on its own, the code
becomes a chip, and the trace sits behind a disclosure. `explainApiError` uses the split
sentence everywhere, so no screen can print a stack trace where a reason belongs.

### The half-settled trade

The cash leg settled and the asset leg did not. The venue answers 500 and deliberately does
**not** unwind, because releasing a hold against a payment that actually happened turns a
reconcilable state into a lost one. So this must never render as a generic failure, and it
is the only thing in this package drawn in the negative colour with a `role="alert"`:

- `/book` carries a banner naming every half-settled trade and the id to quote;
- the invoice's own trade card is headed by what happened rather than by "Sold";
- `/proof/[tradeId]` opens with it, names which leg moved, prints no settlement date, and
  labels the failed leg's timestamp "Last consensus" rather than "Finalised".

`settlementStateOf` derives this from the **leg states** rather than the venue's `status`,
which is `failed` for a half-settled trade — true of the trade and misleading about the
cash. The venue's own status is read where the legs do not answer, which is where it
separates `preparing` from `awaiting_payment`.

Two facts about the venue's data made this necessary rather than decorative: an invoice can
carry many trades (`tradeForInvoice` prefers the settled one, then the most recent, so a
failed attempt cannot render as "Sold"), and `settledAt` stays populated on a trade the
venue later marks `failed` (so the proof view reads the legs, not the timestamp).

### Loading and failing

Three states, handled on all eight routes. A screen either has the venue's figures, is waiting for
them, or says in words what happened — there is no fourth state where a number is shown that nobody
stands behind. `Pending` is a ruled gap where a figure will be; `Failure` names what was being read
and what came back, with the technical trace kept to a footnote and a retry beside it. Nothing on
any screen is allowed to say that something reverted, which is the same rule refusals follow.

Against the demo book the waiting state is skipped entirely: the data is already in the process, so
`useMarket` starts `ready` on the first render and the server's HTML matches the browser's first
paint.

### What the venue does not expose

Stated on screen rather than left as an empty panel:

- **Other funders' mandates.** No route lists every bid, so in `api` mode the curve is the buyer's
  own book. Prices are unaffected — the venue prices against the whole curve server-side, which is
  also why no price attached to a real invoice is computed locally.
- **A customer's settled/unpaid/confirmed counts.** The debtor projection carries the earned grade
  but not the counters behind it, so the invoice page shows the grade and says the counts are not
  published rather than printing "0 settled" beside an `A`.
- **Which mandates matched.** The quote route answers _how many_ would take an invoice, never which;
  a seller does not choose a counterparty. The invoice page shows the count and the nearest refusal
  instead of a ranked list.
- **Confirmation delivery.** There is no mail transport in this build, so the venue mints the token
  and hands the link back outside production — and the seller is given it rather than told their
  customer "has been sent the link", which is what this layer used to say after discarding the
  response. In production `link` is `null` on purpose: a seller who can read it can confirm their
  own invoices, which is the behavioural argument undone in one field. A null link and a failed
  request stay different answers.
- **Mandate names.** A standing bid has no name at the venue, so it is labelled by its own policy —
  "A or better, 60 days".

### The demo book

`src/lib/fixtures.ts` is unchanged and is still the fallback, so `pnpm --filter @facture/web dev`
with nothing else running shows a market rather than nine error pages. The clock is frozen at
`MARKET_NOW` (`2026-09-01T09:32:00Z`), so tenors, ladders and prices are identical on the server and
in the browser, and the demo reads the same on any day of the week.

The book is consistent by construction rather than by hand. Three things are derived:

- every position's **outlay** is `priceInvoice(face, bid, tenor at purchase)`;
- every mandate's **`allocated`** capital and **`debtorExposure`** are summed from its own open
  positions;
- every **uniqueness hash and ISIN** is computed from the invoice, exactly as the registry and the
  issuance path would compute them.

So the refusals on screen are the refusals this data actually produces. Two confirmed invoices need
the wide end of the book, for different reasons:

- **INV-2046** — Petra Foods, rated C, 94 days. Three mandates sit above its rating floor, one holds
  too much of that customer already, and one will not run 94 days. It clears at **18.50%** against
  the single bid left, because a market does not go silent on paper it dislikes — it quotes it
  worse, and the price itself carries the information.
- **INV-2047** — Orrin Metalworks, rated **D**. They failed to pay an invoice on this market, and
  `D` ranks _below_ `UNRATED` in the shared scale, so **all six** mandates refuse it — including the
  two whose floor is `UNRATED`. That is the root README's "the market prices its own mistakes back
  in", visible on a screen.

Both mandates holding Orrin paper bought it before the default. The dates say so.

### The README's worked example, and why the screen shows a different price

The root README quotes "$40,000 · due in 60 days · worth **$39,178** today · 12.5% annualised", and
it has said exactly that since its first commit. It checks out: the shared package's simple-discount
actual/365 pricer gives discount $821.92 and proceeds $39,178.08 on those terms, 2.05% of face.

`INV-2041` is those terms in the fixture book — $40,000, sixty days from `MARKET_NOW` — and it
clears at **8.00%** for $39,473.97, because 8.00% is the tightest standing bid this demo book
happens to carry. Both numbers are right; they are prices from two different curves, which is the
product's own point. The note that used to stand here read the two as one quote and reported the
README as internally inconsistent. It is not.

## What is not here yet

- **The cash leg is not always Arc, and the page no longer assumes it is.** This deployment
  settles the cash leg in HBAR through the Blocky402 facilitator, so the venue answers
  `chain: "hedera"` on network `hedera:testnet` — CAIP-2, with a **colon**. `readChainKey` in
  `contract.ts` reconciles the wire's `hedera`/`arc` to shared's `hedera-testnet`/`arc-testnet`,
  and the proof view reads the chain, its id and its explorer off that rather than hardcoding
  ArcScan. An explorer link that 404s makes a worse claim than an absent one, and this is the
  one screen whose whole job is being checkable somewhere that is not us.
- **The x402 challenge shape is decoded, not passed through.** `PaymentRequirements` is
  `{ scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra }` — `amount`, **not**
  `maxAmountRequired` — and `resource` / `description` / `mimeType` are a sibling `resource`
  object on `PaymentRequired` rather than fields inside the requirements. The 402 body carries
  both `accepts` and `resource`; the `payment-required` header carries a whole `PaymentRequired`
  and is read as a cross-check. A body still sending `maxAmountRequired` is reported as
  unreadable by that name rather than guessed at, because the old spelling fails at settle time
  as an opaque rejection.
- **Refusal receipts are collapsed.** The venue writes a receipt on every pricing pass, so an
  invoice quoted repeatedly accumulates the identical refusal dozens of times. `apiProof`
  collapses them to one row per mandate per reason with a count, which also removes a React
  duplicate-key collision the raw list produced.
- **Only a settled trade is a position.** A buyer's holdings are derived from
  `GET /v1/trades?buyerId=…`, and an attempt that was unwound or half-settled is not paper the
  desk holds — counting it inflated exposure and weighted yield.
- **Selling needs a quote reference.** `POST /v1/trades` requires a `quoteId`, and only
  `GET /v1/invoices/:id/quote` mints one — the batched book listing does not. The client asks for it
  per quotable invoice. Without one the sale says so and does not proceed, rather than inventing
  one: a seller must never be filled at a price they were not shown.
- **No polling.** The quote route is described by the service as cheap and safe to poll, but the
  book reads once and offers a refresh. `driftBps` in `src/components/market-tick.ts` still makes
  the demo book's prices move; against a live venue it is switched off, because a wobble the venue
  did not produce is a made-up price. `PriceCell` renders the venue's own `quote.proceeds`
  whenever the rate on screen is the rate the venue named, and falls back to the local pricer only
  where the demo book's wobble has moved off it — both go through the same shared pricer and agree
  to the cent, but a market with two opinions about its own price has one too many.
- **Buyer positions are derived from trades.** There is no positions route, so a buyer's holdings
  are `GET /v1/trades?buyerId=…` joined to the invoices behind them, and a holding whose invoice is
  not on this seller's book says the customer is not disclosed rather than guessing one.
- `GET /v1/mandates/exposure` and `/v1/mandates/:id/exposure` are wired in the client but no screen
  depends on them: their aggregation shape is not fixed anywhere, and the mandates page computes the
  same figures from the mandates it already holds.
- Mandates have no detail route of their own; `MandateCard` takes an optional `href` for when they
  do.
- ESLint runs the workspace root config (re-exported from `eslint.config.mjs`). The Next and
  react-hooks plugins are not wired up yet.
- Everything is USD. `Currency` is threaded through `format.ts`, the wire contract and the fixtures
  so EUR is a data change rather than a code change, but nothing exercises it.
