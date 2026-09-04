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

Worth opening: `/book/INV-2041` (three mandates would take it, at 8.00%), `/book/INV-2046` and
`/book/INV-2047` (confirmed, and nothing will take either — for two different reasons, both named),
`/confirm/kq7m2xhd`, `/proof/TRD-4417`.

`/confirm/[token]` deliberately sits outside the `(app)` route group, so it inherits none of the
market chrome — no masthead, no nav, no bid prices. Somebody's accounts payable clerk should not be
shown a page of paper prices to acknowledge their own ledger entry.

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
same layout on different stock, and no component carries a `dark:` variant.

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
| `money`           | The only sanctioned way to put an amount on screen.                               |
| `ui/primitives`   | Card, Button, Field, Row, Label, PageHeader.                                      |

## Where the domain stops and the UI starts

`src/lib/domain.ts` is the **only** file that imports `@facture/shared`; everything else imports
from it. That is the seam, and it is deliberately thin: eligibility, ranking, refusals and the curve
maths are all the shared package's, so the screen and the venue cannot disagree about who would take
an invoice or at what price.

- **`bestQuote(invoice, mandates, debtor, { asOf })`** produces every price on every screen — the
  book, the invoice detail, the landing page's live figure, the mandate composer's "what it would
  take today", and the refusals on the buyer page. None of it is a display approximation of a
  number computed elsewhere.
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

All fixtures live behind `src/lib/fixtures.ts`. Swapping to the real API is one file: the module
keeps its exported shape (`invoices`, `mandates`, `getInvoice(id)`, …) and the bodies become fetches.
No component reaches past it.

The clock is frozen at `MARKET_NOW` (`2026-09-01T09:32:00Z`). Tenors, ladders and prices are then
identical on the server and in the browser — nothing hydrates differently to how it rendered — and
the demo reads the same on any day of the week.

The book is consistent by construction rather than by hand. Three things are derived:

- every position's **outlay** is `priceInvoice(face, bid, tenor at purchase)`;
- every mandate's **`allocated`** capital and **`debtorExposure`** are summed from its own open
  positions;
- every **uniqueness hash and ISIN** is computed from the invoice, exactly as the registry and the
  issuance path would compute them.

So the refusals on screen are the refusals this data actually produces. Two confirmed invoices carry
no bid, on purpose and for different reasons:

- **INV-2046** — Petra Foods, rated C, 94 days. Three mandates are above its rating floor, one holds
  too much of that customer already, and one will not run 94 days.
- **INV-2047** — Orrin Metalworks, rated **D**. They failed to pay an invoice on this market, and
  `D` ranks _below_ `UNRATED` in the shared scale, so no floor short of `D` reaches them. That is
  the README's "the market prices its own mistakes back in", visible on a screen.

Both mandates holding Orrin paper bought it before the default. The dates say so.

### A note on the README's worked example

The root README quotes "$40,000 · due in 60 days · worth $39,180 today · 8.0% annualised · three
mandates would take this". The fixtures reproduce the tenor, the rate and the taker count exactly.
The proceeds come out at **$39,473.97** (discount $526.03), which is what the shared package's
simple-discount actual/365 pricer gives for those terms — `$39,180` corresponds to about 12.5%
annualised, not 8%. Worth confirming which number the root README should carry.

## What is not here yet

- No backend calls. Selling an invoice, funding a mandate and answering a confirmation all resolve
  locally, and every one of those screens says on it that nothing moved.
- `driftBps` in `src/components/market-tick.ts` stands in for a curve that actually moves. It goes
  when mandates are live and the curve moves because a funder changed their bid.
- Mandates have no detail route of their own; `MandateCard` takes an optional `href` for when they
  do.
- ESLint runs the workspace root config (re-exported from `eslint.config.mjs`). The Next and
  react-hooks plugins are not wired up yet.
- Everything is USD. `Currency` is threaded through `format.ts` and the fixtures so EUR is a data
  change rather than a code change, but nothing exercises it.
