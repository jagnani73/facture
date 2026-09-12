# Walkthrough

A guided tour of Facture for someone who has never used it. It runs against the dev deployment —
two local processes talking to Hedera testnet and Arc testnet — and it goes in the order a
receivable actually lives: created, acknowledged, offered, priced, sold, delivered, paid.

Budget about **two hours** to do all of it, or twenty minutes for Part 3 alone, which is read-only
and answers most of "what is this".

Three things before you start.

- **Some steps spend real testnet money.** Each one says so in place, with the amount. Nothing in
  Parts 1–3 spends anything.
- **Some steps change the demo book permanently.** There is no undo. Those say so too.
- **This one runs on your machine, and that is deliberate.** There is a hosted copy — the screens at
  <https://facture-ethonline.vercel.app>, the venue at <https://facture-backend-4p7y.onrender.com> —
  and it is the right place to read Part 3, which is read-only and needs nothing installed. It is
  the wrong place for the rest: it has no persistent disk, so a book you change there resets at the
  next deploy, and it sleeps after fifteen idle minutes. Locally, `localhost:8787` is the venue and
  `localhost:3000` is the screens. The chains are shared public testnets either way, so the
  transactions you send are as real as any other transaction on them.

---

## Part 1 · The product in five minutes

Read this first. The screens make sense immediately afterwards and are confusing before.

### The argument

A business is owed $40,000 in sixty days. It does not want to wait, so it sells the invoice to a
factoring house at a discount. That trade happens over the phone: the factor prices the paper
privately, the business takes the number or does not, and no third party ever sees either.

An invoice is a zero-coupon bond. Face value at a fixed date, no coupons in between. The only
reason a market never formed around them is that every invoice is different — different customer,
different amount, different date — so nothing is fungible and there is nothing to quote.

Facture's move is to **standardise the bid instead of the paper.** A buyer writes a standing
mandate — _"anything rated B or better, up to 90 days, I pay 850 basis points annualised, up to
$50,000 total and $10,000 per customer"_ — and funds it. Any invoice that appears is then priced
immediately against every mandate that would take it, because the buyers were already there. The
seller sees a firm price beside their invoice the moment it exists, with no request and no call.

### The five parties

| who                   | what they do                                   | where they appear                                   |
| --------------------- | ---------------------------------------------- | --------------------------------------------------- |
| **Seller**            | is owed money, wants it now                    | `/book`, `/book/new`                                |
| **Customer** (debtor) | owes the money, confirms the debt              | `/confirm/<token>` — one page, no wallet, no signup |
| **Buyer**             | writes and funds standing mandates             | `/mandates`, `/mandates/new`                        |
| **Venue**             | prices, screens, settles, keeps the record     | the backend on `:8787`                              |
| **Agent**             | a buyer that is a process rather than a person | `packages/agent`                                    |

The customer having no wallet is load-bearing rather than a shortcut. Confirmation works because a
customer is asked to acknowledge their own accounts payable through a link with one sentence and
two buttons. Give them a key to manage and they stop answering.

### The life of a receivable

```
draft ─▶ awaiting_confirmation ─▶ confirmed ─▶ listed ─▶ sold ─▶ matured
              │                       │                   │
              └──▶ disputed           └──▶ disputed        └──▶ defaulted
                                                          │
                                                          └──▶ listed   (the resale)
```

Two distinctions do most of the work:

- **`confirmed` is priced. `listed` is for sale.** Every confirmed invoice carries a live price the
  moment the book loads — that is the product's whole claim. It is not an offer until the seller
  offers it, and the venue refuses to arm a trade against anything that is not `listed`.
- **`sold ─▶ listed` is the secondary market.** The buyer who holds the paper puts it back into the
  same standing bids. Less waiting is left than there was, so the same bids pay more for it. That
  is why a receivable that can be exited is worth more on day zero than one that cannot.

### Two chains, and two cash rails

**The paper lives on Hedera.** Each invoice becomes its own zero-coupon bond through Asset
Tokenization Studio — one `deployBond` per receivable, maturity set to the due date, face value as
the maximum supply. Heterogeneous paper on purpose: pooling invoices into one facility would make
them fungible again and collapse the idea back into ordinary securitisation.

**The cash goes one of two ways, and the venue picks by reading the chain rather than a setting:**

- **Arc rail** — the buyer's mandate capital is already escrowed as USDC in `MandateVault` on Arc.
  The sale settles outright, in one call, with no signature: the buyer escrowed the money and wrote
  the terms, so an invoice meeting those terms is a trade they already agreed to. Asking a second
  time is what would make a standing bid not standing.
- **x402 rail** — the mandate is not escrowed, so the buyer pays per trade. `POST /v1/trades`
  answers `402` with a challenge, the buyer signs a Hedera transfer, and repeats the request.

Both answers carry `rail: { chosen, reason }`, so which one ran is stated rather than inferred.

Delivery is an **ATS hold** in both cases: units move out of the seller's free balance into a held
balance bound to the buyer, and the venue executes the hold once the cash has committed. Cash
commits before paper moves, always — reversed, a failed payout leaves a buyer holding paper nobody
paid for, which nothing can recover.

`docs/architecture.md` has four diagrams of this and GitHub renders them. Worth five minutes after
Part 3.

---

## Part 2 · Start it up

### Two processes

```bash
pnpm --filter @facture/backend dev     # the venue      → http://localhost:8787
pnpm --filter @facture/web dev         # the screens    → http://localhost:3000
```

Then check the venue can reach both chains:

```bash
curl http://localhost:8787/health
```

`ok` means Arc's RPC and Hedera's mirror node both answered. It reports reachability rather than an
indexer position, because this venue originates its chain transactions rather than following a
stream — it has no place to be behind. A rail that will not answer is fatal and the response says
which one.

### Who you are

The masthead reads **Demo book · Sign in**, and that is the whole account model.

**Stay signed out for this walkthrough.** Signed out you are looking at a shared demo book with
settled trades and matured receivables in it, and the screens read two ids out of
`packages/web/.env.local`:

- seller `e37a8422-960d-5a77-9825-8964df79ed49` — **Meridian Fabrication**
- buyer `f888dd62-6df0-5600-925e-06469ef0aef6` — **Harrow Point**

So `/book` shows you Meridian's receivables and `/mandates` shows you Harrow Point's bids. You are
looking at one market from both sides at once, which is unusual and deliberate.

Signing in with an email gets you a Privy wallet and an empty book of your own. That is Part 8.

### What is real and what is fiction

The book holds **35 invoices**. Ten have an instrument that exists on Hedera; the other 25 carry
security ids in the `0.0.67xxxxx` range that were never deployed. They price correctly and they
settle nothing.

| invoice                | security       | state today                                       |
| ---------------------- | -------------- | ------------------------------------------------- |
| MF-2046                | `0.0.10316440` | the gas-probe bond, pointed at by hand. `matured` |
| MF-2051                | `0.0.10331926` | its own bond. The clean lifecycle. `matured`      |
| MF-2052                | `0.0.10331928` | its own bond. `matured`                           |
| MF-2052 (a second one) | `0.0.10343726` | the one the agent bought. `sold`                  |
| MF-2061                | `0.0.10348484` | first sale on the Arc rail. `sold`                |
| MF-2070                | `0.0.10363143` | first full Arc lifecycle. `matured`               |
| MF-2071                | `0.0.10363355` | sold on x402. `sold`                              |
| MF-2072                | `0.0.10363420` | **resold once.** `sold`, to a second buyer        |
| MF-2080                | `0.0.10391953` | created, sold, claimed and matured in one sitting |
| MF-2081                | `0.0.10392519` | **`listed` and unsold — the one you can sell**    |

There genuinely are two invoices numbered MF-2052 and two customers called Petra Foods Group. The
second of each came from testing the duplicate check under a different debtor email, which makes it
a different receivable and a legitimate listing. It is recorded rather than deleted, and it is a
fair illustration of what the uniqueness hash keys on.

### The money behind it

Read live on 2026-09-07. Re-read before you spend anything, because these move.

| account                   | holds       | pays for                           |
| ------------------------- | ----------- | ---------------------------------- |
| operator `0.0.10311549`   | 800.95 HBAR | issuance, holds, schedule creation |
| buyer `0.0.10314099`      | 47.93 HBAR  | the x402 cash leg                  |
| collection `0.0.10331559` | 4.81 HBAR   | maturity payouts, nothing else     |
| relayer `0x46783EeC…`     | 411.41 USDC | Arc gas and top-ups                |
| vault `0x217256d0…`       | 4.96 USDC   | escrowed mandate capital           |
| seller `0x2Da63Ac0…`      | 0.53 USDC   | claiming payouts (Arc gas is USDC) |

`pnpm demo:reset` prints all of it and tops the seller and the buyer's wallet up from the relayer.
It does **not** touch the database. Run it if a claim fails for gas; it is not needed otherwise.

---

## Part 3 · The read-only tour

Nothing here writes anything or spends anything. Twenty minutes.

### 3.1 · The book

**`http://localhost:3000/book`**

Every confirmed row carries a price beside it, already there, not behind a button. The page renders
in roughly 200 ms because the whole book is priced in one pass with no chain reads at all.

Look at four rows:

- **MF-2050** and **MF-2049** are grey, _awaiting confirmation_, and have no price. The customer has
  not answered yet.
- **MF-2043** is disputed. Calder & Roe said no, and it will never be sold.
- **MF-2031** defaulted. Orrin Metalworks carries that mark permanently, which is why they are rated
  `D` — below even a customer with no history at all.

The ticker under the masthead is the same book summarised: what is on offer, what it is worth.

### 3.2 · A price nobody asked for

**`http://localhost:3000/book/22e74885-8e34-50f2-8f36-e625f4ca7e99`** — MF-2041

$40,000 from Halden Aerospace, rated A, due 31 October. The page opens with a price on it: around
**800 bps** over 54 days, a discount near $473, proceeds near $39,527, and a count of how many
mandates would take it. The discount is `face × rate × days / 365`, so it shrinks by roughly $9 a
day as the tenor shortens. Read the shape rather than the cents.

Nobody requested that quote. It is read off the curve at the point where this invoice sits — rating
A, tenor 54 days — from standing bids funded weeks ago. The same answer without the browser:

```bash
curl http://localhost:8787/v1/invoices/22e74885-8e34-50f2-8f36-e625f4ca7e99/quote
```

Then two more, in this order, because together they make the curve legible:

- **`/book/460311ff-60d4-54dc-93ce-d5ccbad98b24`** — MF-2048, Sable Interiors, **UNRATED**. Priced
  near 1600 bps. The cold start is real and it is charged for.
- **`/book/1cba5ccd-f5e4-54f6-8d93-ec6bd4d01282`** — MF-2038, Lumen Grid, A-rated, 18 days. The
  tight end, near 675 bps.

Same seller, same market, three prices an order of magnitude apart in cost. Rating and tenor are the
two axes and nothing else moves the number.

### 3.3 · A refusal

**`http://localhost:3000/book/068ac953-19e4-5254-96ea-0b06b8f479f8`** — MF-2047

Orrin Metalworks, rated D, $27,500. Eight mandates considered, none matching, no price — and eight
sentences saying why, one per bid:

> The customer is rated D, and this mandate takes UNRATED or better.

That is the interesting one. The widest bid in the book has a floor of `UNRATED`, the widest a buyer
can actually write, and `D` still ranks below it. A book built to price cold starts refuses a
customer already known to have defaulted.

Other invoices carry the other refusal shapes — a tenor cap, a per-customer concentration cap with
how much of it is left, an exposure limit. Six refusals on one invoice will quote six different
amounts for the same receivable, which is correct: each is what _that_ mandate would have paid at
its own rate.

There is a ninth kind that comes from the security rather than the mandate, and it is the one that
separates this from a spreadsheet. Before a price is quoted, the winning bid is checked against the
instrument's own on-chain control list and KYC state. A buyer the security bars is dropped and the
next bid is priced. When it happens the quote reports `mandatesBarredByInstrument`, and you will see
it for real in Part 4.

### 3.4 · The buyer's side

**`http://localhost:3000/mandates`**

Harrow Point's two standing bids: what each commits, what it has allocated, what is left, the
weighted yield, and a maturity ladder showing when the money comes back.

One reads **Escrowed on Arc** and the other **Not escrowed**, and that difference is what decides
which rail a sale takes. Both say **Agent-run**, which the venue reports from the buyer's own policy
rather than the screen assuming it.

A funder writes a mandate and walks away. The book is what quotes.

### 3.5 · A finished trade

**`http://localhost:3000/proof/6ee70fd1-30a4-49fd-9dc0-3c1100c4aa79`** — MF-2080

The proof view, and the only screen where chain vocabulary is allowed. Read every block:

- **The instrument** — a derived ISIN (`hash(customer, invoice number, face)`, not assigned), the
  Hedera security id, and the SEC regulation the bond was issued under.
- **The compliance decision** — the three checks made against the security itself before the trade:
  is it paused, is the buyer on its control list, does the buyer hold a KYC grant.
- **Both legs** — the cash transaction and the asset transaction, each linked to a public explorer.
- **The registry block** — the chain's own answer on whether this invoice was listed and confirmed,
  read back from `InvoiceRegistry` on every request. If it disagrees with the venue's own column,
  both are shown rather than one being picked.
- **The maturity receipt** — the scheduled payout, and whether it executed.

Four more worth opening, each for one specific reason:

```
/proof/3d129208-a99e-4667-bc4a-1d7bc5a537eb    MF-2051 — the clean x402 lifecycle
/proof/07c9b966-5192-46f4-ae90-b7dab62b11ad    MF-2061 — the first Arc-rail sale
/proof/c0c8ed97-b01d-4c30-b9b2-0ddf7472fa3d    MF-2052 — bought by the agent, unattended
/proof/85c8efbe-9940-4067-97f9-096f0576a377    MF-2046 — the honest mess
```

Open MF-2046 last and read it properly. Its security is the gas-probe bond, pointed at by hand
before a real one existed for that receivable. Ten failed trade rows stand against the one settled
row, three of which actually paid — the buyer paid for this receivable four times and received it
once. Five units are locked in five abandoned holds. None of that is deleted, because a proof view
whose job is being checkable cannot have history quietly removed from underneath it.

### 3.6 · The chain, without trusting the venue

Four claims that are checkable by someone who has not agreed to believe us. Each is one read.

**A refusal you can verify.** Topic [`0.0.10342152`](https://hashscan.io/testnet/topic/0.0.10342152):

```bash
curl https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10342152/messages
```

The payload is a SHA-256 commitment and an opaque receipt id, never the reason. A refusal names the
customer and the amounts, and a topic is public — publishing the text would broadcast one buyer's
exposure and one seller's customer list. The refused party gets their receipt and their sequence
number, hashes it the same way, and compares. The venue cannot change its answer afterwards, and
nobody watching learns anything but that a refusal happened.

**One receivable, one instrument.** `UniquenessRegistry` at `0x8eb9f001…`. A unique index in a
database stops _this_ venue listing a receivable twice and says nothing about the same invoice being
financed elsewhere — and the second financier is a different company, not a second row in our table.
Tested by claiming a receivable this database has no row for and then trying to list it: the venue
answered 409, and nothing local could have refused it.

**The customer's confirmation, in public.** `InvoiceRegistry` at `0x44fe6E29…`. `isConfirmed()` is a
public view. That is the fact the whole risk argument rests on: a full advance with no holdback is
justified _because_ the customer acknowledged the debt, and until this was on chain that was a
column only the venue could see.

**Capital that is actually posted.** `MandateVault` at
[`0x217256d0…`](https://testnet.arcscan.app/address/0x217256d0fdf83ffd81bbc6884ad44f5c02501102) on
Arc holds 4.96 USDC of Harrow Point's mandate capital, deposited by that buyer's own wallet. Five
went in; three settlements have drawn on it. That difference is the argument — a bid is firm because
the money is already there, and the proof is that some of it has left.

---

## Part 4 · Bring a receivable into existence

From here on you are writing. Every step names its cost.

You can follow Parts 4 and 5 with an invoice you create yourself, or take the shortcut in 5.1 and
sell MF-2081, which is already prepared. Doing it yourself is the only way to see 4.1 and 4.4, and
those are where most of the surprises live.

### 4.1 · Add an invoice

**`http://localhost:3000/book/new`** · **spends about 8 HBAR from the operator** · 30–60 seconds

Add one invoice, or paste several from a spreadsheet. The venue answers `202` rather than `201`,
because the instrument does not exist yet — the row appears immediately with a _being added_ pill,
and becomes quotable when `deployBond` lands.

What is happening while that pill is showing:

1. A uniqueness hash is computed from the customer, the invoice number and the face value, and
   claimed on `UniquenessRegistry`. A receivable already claimed there is refused with 409, whether
   or not this database has ever seen it.
2. A checksum-valid ISIN is derived from the same three fields. Asset Tokenization Studio rejects
   arbitrary strings, so this cannot be a label.
3. `deployBond` runs: about 7.02M gas, 7.3–8.9 HBAR, maturity set to the due date, maximum supply
   set to the face value in cents — so the instrument structurally cannot be over-issued against the
   invoice behind it.
4. The invoice's terms are published on `InvoiceRegistry`, as `Draft`.

**Tokenisation happens at onboarding, not at sale.** That is the point of doing it here: when money
moves later, none of this is on the critical path.

Watch it land:

```bash
curl -s http://localhost:8787/v1/invoices/<id> | python -m json.tool
```

`issuanceState` goes `queued` → `issued`, and `securityId` / `securityEvmAddress` fill in. Keep the
EVM address — you need it in 4.4.

### 4.2 · Ask the customer

Your new invoice sits at `awaiting_confirmation`. So do **MF-2050**
(`b874aa34-d0af-5813-ae3a-3eccfcb264cb`) and **MF-2049** (`530009e2-d56c-5410-b003-f70c5d51ff71`) if
you would rather not create one.

On the invoice page, press **Send a reminder**. Or:

```bash
curl -X POST http://localhost:8787/v1/invoices/<id>/confirmation-request
```

There is no mail transport in this build, so outside production the response hands back the link it
would have emailed. **Open the link exactly as given** — it points at
`http://localhost:3000/confirm/<token>`, which is the page a person reads. There is a JSON endpoint
at the same token under `/v1/confirm/`, and following that instead is how this step used to go
wrong.

The page has no masthead, no navigation and no prices on it. One sentence — _"Meridian Fabrication
says you owe them $21,900.00, due 9 October. Is that right?"_ — and two buttons.

Press **Yes**. The invoice turns green and has a price. Press **No** on a different one and it goes
to `disputed` and will never be sold.

In production the link is not returned to the seller, for the obvious reason.

### 4.3 · Offer it for sale

On the invoice page, the panel under the price reads **Not offered yet**, with an **Offer it for
sale** button. Costs nothing, writes nothing to chain.

```bash
curl -X POST http://localhost:8787/v1/invoices/<id>/list
```

The row moves `confirmed → listed`. Until you press it the venue refuses to arm a trade against that
invoice, in a sentence rather than a revert:

> This invoice is confirmed and has not been offered for sale. The price beside it is what the book
> would pay; listing it is what makes that an offer you can fill.

A listed invoice gets a Sell panel and a quiet **Take it off the book** beside it. Try delisting and
relisting — it is free, and it is the cheapest way to feel the `confirmed` / `listed` distinction.

Note what did **not** change: the price. Quoting never depended on listing. Requiring a listing
before an invoice could be priced would have been the tidier model and a slower one, because the
book would render empty until a seller had clicked through every row.

### 4.4 · Prepare the security

**Only for an invoice you created.** MF-2081 is already prepared.
**Spends roughly 1–2 HBAR across ten transactions.**

Open the quote for your new invoice and read `mandatesBarredByInstrument`. It will be non-zero, and
there may be no price at all.

This is the most surprising thing in the product and it is correct. `deployBond` leaves an
instrument with **no supply, an empty control list and no KYC grants**. Nobody is permitted to hold
it, including the seller. A transfer against it reverts without naming any of that.

```bash
pnpm prepare:security <0x-security-address> <units>          # prints a plan, spends nothing
pnpm prepare:security <0x-security-address> <units> --send   # sends it
```

`units` is the face value in minor units — a $20,000 invoice is `2000000`. The script walks ten
transactions, reading before each one so a re-run costs nothing: four role grants, two control-list
entries, an issuer registration, two KYC grants, and the mint.

By default it prepares the seller and the account named by `AGENT_HEDERA_ACCOUNT_ID`. Pass
`--buyer <0.0.x>` to add another.

Then re-read the quote. `mandatesBarredByInstrument` falls and a price appears: the compliance gate
has moved exactly the bids it was supposed to move and nothing else. The check is against the
security's own state on chain, not against anything the venue holds.

---

## Part 5 · Sell it, and get paid

### 5.1 · The sale

**`http://localhost:3000/book/a942c6c9-c141-4041-9a1a-7d4331b5c5bd`** — MF-2081, or your own invoice
from Part 4. **Spends Arc gas and moves escrowed USDC** · one click

$20,000 from Petra Foods Group, rated B, due 16 October. Around **$19,818 at 850 bps over 39
days**, matched by
Harrow Point's escrowed mandate — so this settles on the Arc rail.

Petra being rated B is what makes this demonstrable. It excludes the two A-floor mandates, which are
also the two tightest bids, so the one mandate with capital actually posted wins on merit rather
than by anything being removed.

Press **Sell**. You get `200` with the trade **already settled** — no challenge, no signature. In
that one call, in this order:

1. The seller's paper is held on Hedera, bound to the buyer.
2. `registerMatch` binds the payee and the price on Arc, on chain, before delivery.
3. `executePayout` moves the buyer's escrowed USDC into a `DvpEscrow` lock for the seller.
4. The hold executes and the paper is delivered.
5. The match is committed to the HCS topic as a digest.

**The invoice is marked sold when the cash commits, not when the paper moves.** Reversed, a failed
delivery would leave the invoice quotable with the money already gone, and a second quote would draw
a second payout from the same mandate.

If you would rather see the other rail, sell an invoice whose winning bid is **not** escrowed. You
get `402` with a challenge instead, and settlement needs the buyer to sign a Hedera transfer and
repeat the request. Every seeded row routes this way.

### 5.2 · Claim the payout

An Arc sale does not put money in the seller's wallet. It puts it in a `DvpEscrow` lock, and `claim`
requires `msg.sender == beneficiary` — **the venue cannot collect for the seller even though it
holds the preimage.** The contract tests assert exactly that: the attester, holding the public
secret, is refused.

So this is the one transaction a person signs in the whole product. It is on the proof view, under
the cash leg.

The catch on the demo book: the beneficiary is Meridian Fabrication's address, derived from the
operator key, and a Privy wallet you sign in with is a different key. The button reads the connected
wallet and says so rather than offering a claim that would revert. Read that refusal — it is the
mechanism working.

The preimage is printed on the page and it is not a credential. `claim` needs the caller as well as
the hash, and it writes the secret to storage in the clear anyway. Withholding it once cost a
payout: it used to be returned exactly once, in the settlement response, so a dropped connection
left money nobody could ever claim.

If a claim fails for gas — Arc gas is USDC, so a seller holding nothing can be paid and be unable to
collect — `pnpm demo:reset` tops them up.

### 5.3 · Read your own proof

**`http://localhost:3000/proof/<tradeId>`** — linked from the sale confirmation as **See both
legs**.

Same blocks as 3.5, but now for a trade you made. Check the rail block says `arc-vault` and why,
open both explorer links, and read the registry block — the chain's own answer about the invoice you
listed and the customer who confirmed it.

### 5.4 · Mature it

**No UI. Curl only.** · **spends about 0.1 HBAR from the operator**

Maturity runs in two acts, deliberately.

**First, an obligation:**

```bash
curl -X POST http://localhost:8787/v1/invoices/<id>/mature
```

This writes the settlement outcome, releases the mandate's capital, ticks the customer's rating, and
creates a Hedera Scheduled Transaction paying face value to **whoever holds the paper now** — read
from the newest live settled trade, not from whoever bought it first. It sits unsigned. The cash leg
reports `pending`, correctly: a schedule is an obligation, not a receipt.

The response carries `payout.scheduleId`. Keep it.

**Then, the payment:**

```bash
pnpm sign:payout <0.0.scheduleId>            # plan
pnpm sign:payout <0.0.scheduleId> --sign     # signs, and the schedule executes
```

The collection key lives in `.env.ops` and no service loads it. That separation is the design: a
scheduled transaction executes the moment its required signatures are present, so a payout drawn on
the operator would fire on creation and report the customer as having paid at the instant the
receivable matured. The venue signing is its statement that the money actually landed in the
collection account.

And the reason there is a collection account at all is that **the customer has no wallet.** The
money arrives the way it arrives at a factoring house — off-chain, by whatever rail the customer
already uses — and the on-chain half is the obligation and the payment to the holder.

Two things about the clock:

- A first maturity of a receivable **not yet past due** takes no body and records `on_time`. There
  is no instant left at which the payment could have been late.
- A first maturity of one **already past due** requires `paidAt` and refuses without it. Otherwise
  the only thing left to decide the outcome from is the moment the operator pressed the button, and
  `late` becomes the fallback for "never paid" as well as "paid late" — a default written into a
  customer's permanent record as a payment.

```bash
curl -X POST http://localhost:8787/v1/invoices/<id>/mature \
  -H 'content-type: application/json' -d '{"paidAt":"2026-09-06T00:00:00Z"}'
```

**One sold invoice is past due today: MF-2039**, `fb13a412-dc1f-5d34-84fc-fdf7559cf63f`, which fell
due on 5 September. Try it bodyless first and read the refusal, then supply a `paidAt`. MF-2037 and
MF-2030 join it on the 8th.

A replay is untouched by any of that and still succeeds bodyless whatever the clock says, because
reading a settlement back decides nothing. Call `mature` on the same invoice four times: the ledger
carries one outcome, one capital release, one rating tick and one schedule. That is not theoretical
— MF-2046 was matured four times during debugging.

### 5.5 · The other ending

```bash
curl -X POST http://localhost:8787/v1/invoices/<id>/default
```

**This is permanent and there is no route that takes it back.** Do it on a seeded row you do not
care about, or not at all.

The customer's rating drops to `D` and stays there. The buyer's allocation is **not** released — the
position closes at zero and they take the loss, so giving the capacity back would let the bid quote
again on money that is gone.

It is an act rather than a timer, mirroring the payout signature: only the venue can say the money
is never coming, and a clock left to decide it would mark customers permanently for payments three
days in the post.

This is the half that makes the rating loop worth reading. A grade earned from settled history only
prices anything if the bad history is in it.

---

## Part 6 · The secondary market

### 6.1 · Read the one that happened

```
/proof/04b109ee-be4f-43dc-803a-a4f909064f4f    MF-2072, bought by Harrow Point — superseded
/proof/df2baa17-1d6d-47ac-a48d-4229ec21757d    MF-2072, resold to Kestrel Working Capital
```

MF-2072 was bought once at **1850 bps over 40 days** for proceeds of 391,890, relisted by its
holder, and resold at **1600 bps over 37 days** for **393,512** — to a different buyer, off the same
standing bids. Less waiting left, so the same book paid more for the same paper.

The paper actually moved: `balanceOf` on the instrument reads Harrow Point 0 and Kestrel 400,000,
against 400,000 and 0 before. That also settles who signed — `createHoldByPartition` acts on the
caller's own tokens and the operator holds zero units of this instrument, so an operator-placed hold
could not have moved anything.

Nothing was arranged. Five mandates refused on rating, and the deployed compliance gate refused
Ashgrove Treasury with `CONTROL_LIST_BLOCKED` — the pricing path dropping a barred bid and looking
again. Kestrel won at 1600 against Harrow Point's own 1850 because it is the tighter bid.

### 6.2 · Do one

Open any invoice Harrow Point holds and the panel reads **Sold, and off the book** with **Offer it
for sale again**. Same route as a first listing: `POST /v1/invoices/:id/list` performs
`confirmed → listed` or `sold → listed` depending on where the invoice already is.

Three candidates, all with real bonds behind them:

```
/book/5b852e40-6789-44d7-8477-2ff761a017f3    MF-2061, Calder & Roe, B, due 18 Oct
/book/43f68060-0a14-459d-aee8-f73d81bf2df6    MF-2071, Northwind, A, due 13 Dec
/book/7d9ecd44-2a78-420e-bd9c-8c718caf0fc6    MF-2052, Petra Foods, UNRATED, due 20 Oct
```

**The limit worth understanding.** A resale's hold is signed by whoever holds the paper now, so the
venue can only make the offer while it holds that party's key. `RESALE_SIGNER_PRIVATE_KEY` is
currently Harrow Point's, which is why those three work and **MF-2072 cannot be relisted again** —
Kestrel holds it now and the venue has no key for them. Try it and read the refusal; it arrives at
listing rather than at sale, because failing later would look like a broken instrument rather than a
missing key.

It is the same self-custody wall that stops sellers signing their own asset legs, and a real limit
rather than a temporary one.

Once relisted, read the quote and compare it to what the invoice first sold at. Then either sell it
— which needs the winning bid's buyer to be on that instrument's control list, so expect
`mandatesBarredByInstrument` to be doing work — or delist it. **Delisting a resale returns the
invoice to `sold`, not `confirmed`**, because the holder still holds it, and `confirmed` would say
the receivable is unowned. Maturity reads that to decide who to pay.

---

## Part 7 · The buyer, and the machine

### 7.1 · Write a mandate

**`http://localhost:3000/mandates/new`** · **spends Arc gas and about 0.1 HBAR**

Set a rating floor, a maximum tenor, a rate in basis points, total capital and a per-customer cap.
The screen shows the implied price as you type, so you are writing a bid and watching what it would
pay.

Press the button and two chain writes happen before the row is even quotable:

1. `MandateVault.registerMandate` on Arc opens the cash leg. A deposit against an unregistered
   mandate reverts, so without this the mandate could never be escrowed at all.
2. `MandateBook.postMandate` on Hedera publishes the bid publicly.

**Expect it to end in "recorded and not quoting", and read that carefully.** A mandate's vault bucket
is keyed by its own id, so a brand-new mandate has an empty one, and the venue verifies funding
against the vault rather than believing the request. It parks at `funding` with a message telling
you to deposit and fund again.

The whole design sits in that one refusal. An unfunded bid would make every quote it appears in
soft, and a soft quote is the one thing this product cannot afford.

The mandate book is worth seeing separately. When a trade is armed, the venue asks
`MandateBook.previewMatch`, which reads the rating, the confirmation, the due date and the face value
**out of `InvoiceRegistry`** rather than from whoever is asking. Every other check on that path is
the venue marking its own homework; this is the one verdict it cannot have arranged. It appears on
the settlement response and on the proof view.

It will sometimes disagree with the venue by a minor unit — the contract floors the discount where
the venue ceils it, and counts tenor from a block timestamp where the venue counts UTC midnights.
The disagreement is published rather than reconciled, because refusing a good trade over a rounding
rule would be worse. **Compare the reason code, not the number.**

### 7.2 · The agent

```bash
pnpm --filter @facture/agent start
```

The desk that bought MF-2052 is a process, not a person at a screen. Read the first log line rather
than waiting for a tick. Two fields matter: `cashRails` says which rails this process can actually
settle on, and `x402Payer` names the account that would sign.

**It defaults to `AGENT_DRY_RUN=true`, so what you are watching is a decision and not a spend.** It
reads the book, prices every row against its own mandates, and reports what it would take.

Turning that off is not a verbosity setting. A live run signs and submits a transfer of the buyer's
own HBAR for every trade the venue prices to the x402 rail, and nothing between the decision and
consensus asks a second time.

The proof already exists and needs no live run: `/proof/c0c8ed97-b01d-4c30-b9b2-0ddf7472fa3d`. The
buyer paid exactly the 868,798 tinybars it was quoted and paid **no gas** — the facilitator covered
the whole 258,441 fee, because the payload's transaction id is generated against the facilitator's
account rather than the payer's.

### 7.3 · Take capital back out

```bash
curl -X POST http://localhost:8787/v1/mandates/<id>/withdraw \
  -H 'content-type: application/json' -d '{"amountMinor":10000}'
```

Allocated capital is committed against trades in flight and is not withdrawable — that is what
"firm" means. Only unallocated capital comes back, and the book and the money move together: the
route asks the vault first, so a request that cannot succeed is refused with nothing moved.

---

## Part 8 · The edges worth seeing once

**Sign in as yourself.** Press **Sign in**, use an email, and Privy makes you a wallet. The venue
reads the email out of a signed Privy identity token — not out of the request body — and mints its
own id. Your book is empty and says so, which is the correct answer for a business that has just
arrived. Sign out to get the demo book back.

**The customer never sees any of this.** `/confirm/<token>` is deliberately outside the app layout,
so there is no sign-in and no wallet prompt anywhere near it. Open one while signed in and confirm
that nothing about your session appears on it.

**Delist while a trade is armed.** Sell an invoice that routes to x402 and stop at the `402`. The
Take it off the book control disappears and says why: withdrawing the offer between the challenge
and the buyer's signature is how a confirmed invoice ends up marked sold. Unwind the trade
(`POST /v1/trades/:id/unwind`) and the control comes back.

**A duplicate receivable.** Add an invoice with the same customer, number and face value as one
already in the book. The 409 comes from the chain rather than from the database.

**Everything the screens refuse.** Every state has a loading, a failed and an empty rendering, and
each refusal is a separate fact rather than one absent value. Stop the backend and reload `/book`;
the failure names what did not answer instead of showing an empty market.

---

## What this build does not do

Stated plainly, because each is a decision with reasoning behind it rather than an unfinished edge.

- **Sellers do not self-custody.** The venue holds the paper and places every hold. Moving to
  self-custody needs ERC-1400 operator authorisation — a contract change plus a seller signature on
  the asset leg of every trade.
- **A holder whose key the venue does not hold cannot relist.** Same wall, from the other side. It
  is why MF-2072 is stuck with Kestrel.
- **Partial position sales.** An all-or-nothing exit is a worse instrument, and a worse instrument
  prices wider on day zero. This is the first cut on the cut list that genuinely costs the product.
- **`reclaimPayout` is not automated.** A stranded escrow lock returns its capital to the mandate
  only when someone calls it. That is an operator action, and the code no longer claims otherwise.
- **The Hedera delivery escrow is deployed and deliberately unreached.** The ATS hold already gives
  four of its five properties without the paper leaving the holder's ledger entry, and using it
  would require putting a regulated security inside a contract that would then need its own KYC
  grant on every instrument.

---

## Where to read more

| file                   | what it holds                                                 |
| ---------------------- | ------------------------------------------------------------- |
| `README.md`            | the product argument, at length                               |
| `docs/architecture.md` | four diagrams: the pieces, the path, the rails, the lifecycle |
| `docs/deployments.md`  | every real transaction, with ids you can check                |
| `docs/demo.md`         | the same ground as a thirteen-minute pitch to a judge         |
| `docs/ai-usage.md`     | which parts a model wrote, and which were not its to decide   |
| `CLAUDE.md`            | every constraint that cost a day to find, and why             |
