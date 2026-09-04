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

| Route               | What it is                                                                        |
| ------------------- | --------------------------------------------------------------------------------- |
| `/`                 | The thesis. An invoice is a zero-coupon bond that nobody ever priced.             |
| `/book`             | **The seller's book.** The core screen. Quotable invoices carry a live price.     |
| `/book/[invoiceId]` | One invoice: face, tenor, annualised rate, discount, proceeds, and a sell action. |
| `/book/new`         | Add invoices — single entry, or pasted straight out of a spreadsheet.             |
| `/confirm/[token]`  | The debtor confirmation page. One sentence, two buttons, no account.              |
| `/mandates`         | The buyer's side: standing bids, exposure used, weighted yield, maturity ladder.  |
| `/mandates/new`     | Write a mandate, with the implied price and its matches shown as you type.        |
| `/proof/[tradeId]`  | The audit view. The only screen where chain vocabulary is allowed.                |

Worth opening against the demo book: `/book/INV-2041` (four mandates would take it, at 8.00%),
`/book/INV-2046` and `/book/INV-2047` (confirmed, and one clears at 18.50% while nothing at all
will take the other — for two different reasons, both named), `/confirm/kq7m2xhd`,
`/proof/TRD-4417`.

`/confirm/[token]` deliberately sits outside the `(app)` route group, so it inherits none of the
market chrome — no masthead, no nav, no bid prices. Somebody's accounts payable clerk should not be
shown a page of paper prices to acknowledge their own ledger entry. The record that page reads
(`ConfirmationRecord`) has no price on it at all, so there is nothing to leak even by accident, and
every state of the page — loading, failed, expired, answered — renders through the same bare shell.

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
| `money`           | The only sanctioned way to put an amount on screen.                               |
| `ui/primitives`   | Card, Button, Field, Row, Label, PageHeader.                                      |
| `ui/async`        | Waiting, and not getting an answer. Both written the way a refusal is written.    |

## Where the domain stops and the UI starts

`src/lib/domain.ts` is the **only** file that imports `@facture/shared`; everything else imports
from it. That is the seam, and it is deliberately thin: eligibility, ranking, refusals and the curve
maths are all the shared package's, so the screen and the venue cannot disagree about who would take
an invoice or at what price.

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
| `src/lib/data/index.ts`          | The door. Reads, and the four things a person can actually do.                                                                                 |
| `src/lib/data/hooks.ts`          | `useMarket`, `useConfirmation`, `useProof` — three states, never a fourth.                                                                     |

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

### Loading and failing

Three states, handled on all nine routes. A screen either has the venue's figures, is waiting for
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
- **Confirmation links.** Tokens are minted by the venue and emailed to the customer, so the
  seller's screen never sees one and "preview what they see" appears only against the demo book.
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

### A note on the README's worked example

The root README quotes "$40,000 · due in 60 days · worth $39,180 today · 8.0% annualised · three
mandates would take this". The fixtures reproduce the tenor and the rate exactly. The proceeds come
out at **$39,473.97** (discount $526.03), which is what the shared package's simple-discount
actual/365 pricer gives for those terms — `$39,180` corresponds to about 12.5% annualised, not 8%.
Worth confirming which number the root README should carry.

## What is not here yet

- **Nothing has been run against the real service.** The client is written against the frozen zod
  schemas and the renderers in `packages/backend/src/wire.ts`, and it has been exercised end to end
  against a stand-in serving those exact shapes — not against the service with a database behind it.
  Where the wire and the domain disagree on a name the mapping is spelled out in
  `src/lib/api/contract.ts`, which is the only file that has to change if a shape moves.
- **Selling needs a quote reference.** `POST /v1/trades` requires a `quoteId`, and only
  `GET /v1/invoices/:id/quote` mints one — the batched book listing does not. The client asks for it
  per quotable invoice. Without one the sale says so and does not proceed, rather than inventing
  one: a seller must never be filled at a price they were not shown.
- **No polling.** The quote route is described by the service as cheap and safe to poll, but the
  book reads once and offers a refresh. `driftBps` in `src/components/market-tick.ts` still makes
  the demo book's prices move; against a live venue it is switched off, because a wobble the venue
  did not produce is a made-up price.
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
