# Demo script

Five moves, in the order the README argues them: list, quote, match, settle, mature. Written
against the venue as it actually runs on 2026-09-03, with the ids and transaction hashes it
actually holds, so a judge can check a claim instead of taking it. Prices and tenors are as of that
date and shorten by a day each day; the invoice statuses were re-read on 2026-09-04, after listing
became something a seller does.

Everything below is either a URL to open or a request to send. Where a move is staged rather than
live, it says so in place. Where the thing on screen is a fiction from the seeded book rather than
a receivable with a bond behind it, it says that too — a demo that blurs the two is worth less than
one that does not, because the whole product claim is that a price can be checked.

Budget about **thirteen minutes** for the five moves, plus two for the proof view, two for the
on-chain guarantees at the end, and ninety seconds more if the agent is shown. Staging is separate
and is described last.

---

## Before you start

Two processes, both already running in the sessions this was written in:

| what    | command                              | address                 |
| ------- | ------------------------------------ | ----------------------- |
| venue   | `pnpm --filter @facture/backend dev` | `http://localhost:8787` |
| screens | `pnpm --filter @facture/web dev`     | `http://localhost:3000` |

### Demo book, or your own

The masthead says **Demo book · Sign in**, and that is the whole of the account model.

- **Signed out** you are looking at the shared demo book: a seeded seller with 30 invoices,
  settled trades and matured receivables in it. Nothing to create, nothing to fund, and it is
  labelled rather than implied.
- **Sign in** with an email address and Privy makes a wallet. The venue reads the email out of a
  signed Privy identity token — not out of the request body — and mints the id its routes are
  scoped by. Your book starts empty and says so.

For a demo, **stay signed out**. The seeded book is where the settled trades and the matured
receivables are. Sign in only if someone asks to see onboarding, and expect an empty book on the
other side, which is the correct answer for a business that has just arrived.

Signed out, the screens read their identity from `packages/web/.env.local`:

- seller `e37a8422-960d-5a77-9825-8964df79ed49` — Meridian Fabrication
- buyer `f888dd62-6df0-5600-925e-06469ef0aef6` — Harrow Point

Those ids appear in every seller-scoped and buyer-scoped request below. They are UUIDv5 derived
from fixture labels, so they survive a reseed unchanged.

**The buyer is Harrow Point deliberately.** It is the agent-operated desk, it is the buyer in both
settled trades, and it holds the one mandate actually escrowed on Arc — so its two bids show a
backed one and an unbacked one side by side.

**`GET /health` reads `ok`.** It reports per-rail reachability rather than an indexer lag, because
this build originates its chain transactions rather than following a stream and has no position to
be behind. A rail that will not answer is fatal and says which one.

```
curl http://localhost:8787/health
```

### What is real and what is seeded

The book holds 30 invoices. **Five of them have an instrument that exists on Hedera:**

| invoice | security       | what it is                                              |
| ------- | -------------- | ------------------------------------------------------- |
| MF-2051 | `0.0.10331926` | its own bond, deployed by the venue. The clean one.     |
| MF-2052 | `0.0.10331928` | its own bond, deployed by the venue.                    |
| MF-2046 | `0.0.10316440` | the gas-probe bond, pointed at by hand. A stand-in.     |
| MF-2061 | `0.0.10348484` | its own bond. The one that sold on the Arc rail.        |
| MF-2052 | `0.0.10343726` | a **second** MF-2052. The one the agent bought. `sold`. |

The other 25 carry security ids in the `0.0.67xxxxx` range that were never deployed —
`https://testnet.mirrornode.hedera.com/api/v1/contracts/0.0.6751909` answers `Not found`. They
price correctly and they settle nothing. The seeded settled trades carry invented `0x…` cash
hashes and a seeded HCS topic (`0.0.6741301`) with no messages on it. Do not open those; they are
the demo book, not the ledger. The **real** refusal topic is `0.0.10342152` and does have messages.

**There are two invoices numbered MF-2052 and two customers called Petra Foods Group.** The second
of each was created while testing the duplicate check: posting under a different debtor email made
a different customer, hence a different receivable, hence a legitimate listing. It is recorded in
[deployments.md](./deployments.md) rather than deleted. If it comes up, that is the answer — and it
is a fair illustration of what the uniqueness hash keys on.

**That accident is now the agent's proof, and it reads `sold`.** It was the one row in the book with
a real instrument and nothing else depending on it — no supply, an empty allowlist, no KYC — and its
customer being `UNRATED` is what routed it to the single unescrowed mandate that would take it, and
therefore to the x402 rail. `@facture/agent` bought it with the buyer's own Hedera key on
2026-09-03, trade `c0c8ed97-b01d-4c30-b9b2-0ddf7472fa3d`. See _Move 4_.

**Show MF-2051.** It was issued its own bond by the venue's own issuance queue, sold against a
funded standing bid, and matured paying its holder par, with no stand-in anywhere in the chain of
custody. MF-2046 is the earlier, messier proof and is covered under _Move 5_ as exactly that.

---

## Move 1 — List

**`http://localhost:3000/book`** · about 2 minutes

The seller's book. Every confirmed row carries a price beside it, already there, not behind a
button. The page renders in about 200 ms because `priceBook` prices the whole book in one pass and
does no on-chain reads.

Point at three rows and move on:

- **MF-2050** and **MF-2049** are grey — _awaiting confirmation_. No price. This is Move 2.
- **MF-2043** is disputed. Calder & Roe said no, and it will not be sold.
- **MF-2031** defaulted, and Orrin Metalworks carries the mark permanently. That is why the
  customer is rated `D`, which ranks below even a cold start.

Then say what already happened before the screen was opened: each of those invoices became an ATS
zero-coupon bond at the moment it was added to the book, not at the moment of sale. Tokenisation is
onboarding work, so it is never on the critical path when money moves.

**Then do the move it is named after.** A price is not an offer. Open any confirmed invoice and
the panel under the price reads _Not offered yet_, with an **Offer it for sale** button —
`POST /v1/invoices/:id/list`, which moves the row `confirmed → listed`. Until a seller presses it
the venue refuses to arm a trade against that invoice, in a sentence rather than a revert:

> This invoice is confirmed and has not been offered for sale. The price beside it is what the
> book would pay; listing it is what makes that an offer you can fill.

A listed invoice gets the Sell panel instead, with a quiet **Take it off the book** beside it
(`POST /v1/invoices/:id/delist`). That control disappears entirely while a trade is armed, and
says why: a seller withdrawing the offer between the 402 and the buyer's signature is the hole the
Arc rail taught us to look for.

**The book holds five confirmed invoices and one listed — MF-2038.** So most rows need offering
before anything can take them, and whichever invoice the demo sells has to be offered first.
Quoting is untouched by any of it: every confirmed row still carries a live price the moment the
screen loads. Requiring a listing before an invoice could be priced would have been the tidier
model and a slower one: the book would render empty until a seller had clicked through every row.

Say plainly that this is new, on 2026-09-04. `listed` was written by nothing but the seed until
then, so the README's own "Never cut" path opened with the word _List_ while the product performed
no listing. The step existed in the lifecycle and nowhere else.

**If you want to show it live** — `http://localhost:3000/book/new` adds an invoice and the venue
answers `202`, because the instrument does not exist yet. The row appears immediately with a _being
added_ pill and becomes quotable when `deployBond` lands, roughly 30–60 seconds later. That
transaction is real: about 7.02M gas and 8 HBAR against the operator, which holds 858 HBAR.

The cut list in `CLAUDE.md` calls live issuance staging rather than product, and it is right. Do
this only if there is time to spare.

## Move 2 — Quote

**`http://localhost:3000/book/22e74885-8e34-50f2-8f36-e625f4ca7e99`** (MF-2041) · about 2 minutes

$40,000 from Halden Aerospace, rated A, 59 days out. The page opens with a price already on it:

> **800 bps** · 59 days · discount **$517.27** · proceeds **$39,482.73** · four mandates would take
> this

Nobody requested that quote. It is read off the curve where this invoice sits — rating A, tenor 59
— from standing bids that were funded weeks ago. The same call from the terminal, if the screen is
easier to doubt than a response body:

```
curl http://localhost:8787/v1/invoices/22e74885-8e34-50f2-8f36-e625f4ca7e99/quote
```

Round trip is about 500 ms, of which the mirror-node read screening the winning bid is most.

Two more worth opening, in this order, because they make the curve legible:

- **MF-2048**, `460311ff-60d4-54dc-93ce-d5ccbad98b24` — an unrated customer, priced at **1600 bps**.
  The cold start is real and it is charged for.
- **MF-2038**, `1cba5ccd-f5e4-54f6-8d93-ec6bd4d01282` — A-rated, 23 days, **675 bps**, the tight
  end. It is also the one row already offered for sale, so it is the one a Sell click can reach.

Then the buyer's side: **`http://localhost:3000/mandates`**. Three standing bids, their committed
capital, what each has allocated and what is left. A funder writes a mandate and walks away; the
book is what quotes.

## Move 3 — Match, and the refusal

**`http://localhost:3000/book/068ac953-19e4-5254-96ea-0b06b8f479f8`** (MF-2047) · about 3 minutes

Vantage Clinical, rated D. Seven mandates considered, none matching, no price — and seven sentences
saying why, one per bid:

> The customer is rated D, and this mandate takes UNRATED or better.

That last one is the interesting one. The widest bid in the book has a floor of `UNRATED`, which is
the widest a buyer can actually write, and `D` still ranks below it. A book built to price cold
starts refuses a customer already known to have defaulted.

MF-2038 carries the other two kinds in the same list, if you want them:

> This mandate caps exposure to Lumen Grid Utilities at $120,000.00, and only $25,603.84 of that is
> left against the $127,752.72 this invoice needs.

**Now the refusal that is the actual argument.** The refusals above are the venue's own mandate
terms. The one that separates this from a spreadsheet is read off the security itself, before
anything is matched. It happened on MF-2051 on 2026-09-02:

> Cordell Credit Partners is not permitted to hold this security by its control list.

Cordell held the tightest bid in the book at 925 bps. Arming the trade returned **403 with that
sentence** — not a reverted transaction, not a failed transfer. The trade then settled against
Harrow Point at 850 bps, which won on price rather than by anything being removed. The full record
is in [deployments.md](./deployments.md#the-refusal-happened-first-and-said-why).

**Say plainly that this exact 403 is now hard to reproduce, and why.** It was a real wrinkle: the
gate ran at arming, so the book could quote a price from a bid whose buyer the instrument bars.
Commit `4b90e1f` moved the check into pricing — `priceOne` screens the winning bid and, if it is
barred, drops it and looks again, up to three passes. The refusal now arrives before the seller
decides to sell rather than after, which is the correct place for it and also the reason a judge
cannot trigger it by clicking Sell today. It surfaces instead as `mandatesBarredByInstrument` on the
quote response.

That count reads `0` on every invoice in the book right now, because every instrument that could bar
a bid has since matured or sold and the other 25 securities do not exist to be read. An unreadable
instrument is deliberately not treated as a refusal — the gate is indeterminate, not negative, and
letting a relay outage widen the whole curve was a bug that repriced MF-2041 from 800 to 1850 bps
on its first live run.

**The cleanest record of the new behaviour is MF-2052**, in
[deployments.md](./deployments.md#a-second-clean-lifecycle--mf-2052-2026-09-02). Before its bond was
prepared, the book quoted nothing for it — `mandatesMatching: 0`, `mandatesBarredByInstrument: 3`,
`quote: null`. Three funded bids passed every economic test and were dropped because the security
did not permit their buyers, and the seller was told that instead of being shown a price nobody
could take. After the ten preparation transactions the same call answered 850 bps with nothing
barred, and the four economic refusals were identical either side. One table, showing the gate
moving exactly the bids it was supposed to move and nothing else.

The compliance decision that _was_ made is on the proof view, under Move 5.

## Move 4 — Settle

Delivery versus payment, one route, **two rails**, and which one runs is decided by whether the
buyer's capital is already posted.

- **An unfunded mandate** gets the x402 exchange: `POST /v1/trades` with `{invoiceId, quoteId}`
  answers `402` carrying the challenge, the buyer signs it and repeats the same request with a
  `PAYMENT-SIGNATURE` header, and that is the leg that moves money.
- **A mandate escrowed on Arc** answers **`200`, already settled**. There is no challenge because
  there is nothing to sign: the buyer escrowed the capital and wrote the terms, so an invoice
  meeting those terms is a trade they have already agreed to. Asking for a second consent is what
  would make a standing bid not standing.

Both bodies carry `rail: { chosen, reason }`, so the answer to "why this one" is on the wire rather
than inferred. `cashLeg.rail` says the same thing on the receipt, and the proof view prints it.

**Sell renders only on an invoice that has been offered.** MF-2038 is the only row already on the
book, so anything else needs Move 1's offer step first. Arming re-reads the status rather than
trusting the screen, so an invoice taken off the book between the quote and the Sell click is
refused rather than sold.

**Everything a judge can click in the demo book routes to the x402 rail, and that is worth saying
out loud rather than letting someone discover it by clicking Sell.** The escrowed mandate quotes 850
bps, and every invoice in Move 2 is taken by a tighter Ashgrove bid that is not escrowed. Exercising
the Arc rail needs a B-rated invoice the escrowed mandate wins on merit — and every seeded one that
qualifies carries a never-deployed `0.0.67xxxxx` security id, so it prices and settles nothing. The
rail has carried a trade, on an invoice added to the book rather than seeded into it: MF-2061,
below.

On MF-2051 both legs are on chain and both can be checked without a browser:

**Asset leg** — an ATS hold, executed:

```
curl https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10311549-1788340765-589124475
```

`CONTRACTCALL`, `SUCCESS`. Hold `1`, 1,225,000 units — the seller's whole position.

**Cash leg** — x402 `exact` on `hedera:testnet`:

```
curl https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1788340765-029692827
```

`CRYPTOTRANSFER`, `SUCCESS`, and the transfer list is the whole claim:

```
0.0.10314099   -1,217,012      the buyer
0.0.10311549   +1,217,012      the seller
0.0.7162784      -270,272      the facilitator, paying the fee
```

The buyer paid exactly the quoted proceeds and paid **no gas**. The facilitator `0.0.7162784` is
the fee payer, read from its `GET /supported` at runtime rather than hardcoded.

**One thing to state rather than let a judge discover.** This trade settled in HBAR on Hedera, not
in USDC on Arc, because it took the x402 rail. Face value in cents maps to tinybars 1:1 under a
declared scale (`X402_SETTLEMENT_SCALE_PPM`), so $12,170.12 of proceeds is 1,217,012 tinybars.

The Arc rail exists and the backend drives it: `chooseRail` reads the vault, `registerMatch` binds
the payee and the price **on chain before delivery**, and `executePayout` moves the buyer's escrowed
USDC into `DvpEscrow` locked for the seller. The ordering is chosen by which way a failure hurts —
the cash commits into escrow before the paper moves, so a failed delivery leaves money that returns
to the mandate rather than a buyer holding paper nobody paid for.

**A trade has now taken it.** MF-2061 — a B-rated receivable the escrowed mandate won on merit,
because the two tighter bids carry an A floor — settled out of the vault on 2026-09-03, and the
seller collected with their own key. Cash `0x96c5c862…` on Arc, paper
`0.0.10311549@1788439835.810844400` on Hedera, claim `0x290928b2…`. The seller's balance moved
0.5 → 0.512972 USDC: they received 0.014843 and paid their own gas, because `claim` requires
`msg.sender == beneficiary` and the venue cannot collect for them.

Two operational facts a rehearsal has to include, both of which surprised us:

- **The seller claims their own payout.** `DvpEscrow.claim` requires `msg.sender == beneficiary`;
  even the attester holding the public preimage is refused. Arc gas is USDC, so a seller holding
  nothing can be paid into the escrow and be unable to collect. `pnpm demo:reset` funds them.
- **`reclaimPayout` is not wired.** A stranded lock returns its capital to the mandate only when
  someone calls it, and nothing in the backend does. That is an operator action.

### The buyer on the other side can be an agent, and once was

**`pnpm --filter @facture/agent start`** · about 90 seconds

The desk that bought MF-2052 is a process, not a person at a screen. Start it and read the first log
line rather than waiting for a tick:

```
pnpm --filter @facture/agent start
```

Two fields on that line are the ones to point at. `cashRails` says which rails this process can
actually settle on — `["arc-vault", "x402-hedera"]` with a Hedera key configured, `["arc-vault"]`
alone without one — and `x402Payer` names the account that would sign. Both are printed at boot for
a reason: with no key the agent refuses every unescrowed bid and looks like a desk that simply found
nothing to buy, which is the same log as half the book being unreachable.

**It defaults to `AGENT_DRY_RUN=true`, so what you are watching is a decision and not a spend.** It
reads the book, prices every row against its own mandates, and reports what it would take. Turning
that off is not a verbosity setting: a live run signs and submits a transfer of the buyer's own HBAR
for every trade the venue prices to the x402 rail, and nothing between the decision and consensus
asks a second time. Say that out loud before anyone suggests flipping it during a demo.

**The settled proof already exists and needs no live run.** On 2026-09-03 the agent armed and paid
for the second MF-2052 by itself, at 1850 bps against Harrow Point's unescrowed mandate:

| trade | `c0c8ed97-b01d-4c30-b9b2-0ddf7472fa3d`                                |
| ----- | --------------------------------------------------------------------- |
| cash  | `0.0.7162784@1788449867.590233238` — CRYPTOTRANSFER, SUCCESS          |
| asset | `0.0.10311549@1788449868.676674741` — CONTRACTCALL, SUCCESS, hold `2` |
| match | topic `0.0.10342152`, sequence 24                                     |

```
curl https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1788449867-590233238
```

The transfer list is where to look. The buyer `0.0.10314099` paid exactly the 868,798 tinybars it
was quoted, the seller received them, and the whole 258,441 fee went to the facilitator
`0.0.7162784` — because the payload's transaction id is generated against the facilitator's account
rather than the payer's.

**Nothing about the invoice was arranged.** Its customer is `UNRATED`, which loses five of the seven
mandates on rating; a sixth caps tenor at 45 days against a 47-day invoice; and the one bid left
holds no capital in the vault, so `chooseRail` sent it to x402 by arithmetic rather than by
configuration.

Its proof view is `http://localhost:3000/proof/c0c8ed97-b01d-4c30-b9b2-0ddf7472fa3d`.

**That invoice carries three trade rows, and only one settled.** The first run's client aborted at
ten seconds while the venue was still arming — the hold was placed anyway and nothing on the agent's
side knew — and the second was refused `409`, which was the venue protecting the invoice rather than
a fault. The first was unwound by hand and `POST /v1/trades` now has its own 60-second budget. If a
judge opens the trade list, that is the answer.

## Move 5 — Mature

**`http://localhost:3000/proof/3d129208-a99e-4667-bc4a-1d7bc5a537eb`** · about 4 minutes

The proof view for MF-2051, and the only screen in the product where chain vocabulary is allowed.
It carries the ISIN `US0P7LQIQII6` — derived from `hash(debtor, invoice number, face)`, not
assigned — the security `0.0.10331926`, the compliance decision with its three checks, both
settlement legs, and the maturity receipt.

Maturity ran in two acts, deliberately.

**First, an obligation.** `POST /v1/invoices/:id/mature` wrote the settlement outcome, released the
mandate's capital, and created a Hedera Scheduled Transaction paying face value to whoever held the
paper. It sat unsigned. The cash leg reported `pending`, correctly — a schedule is not a receipt.

**Then, the payment.** The collection key signed, the schedule executed, and the holder was
credited. Both are on the same transaction id:

```
curl https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10311549-1788340781-520345720
```

Two records come back: the `SCHEDULECREATE`, and a `CRYPTOTRANSFER` with `scheduled: true`:

```
0.0.10331559   -1,225,000      the collection account
0.0.10314099   +1,225,000      the holder
```

Exactly par, to the holder at maturity rather than to whoever bought it first. The schedule itself
is readable on its own:

```
curl https://testnet.mirrornode.hedera.com/api/v1/schedules/0.0.10332092
```

`memo: Facture maturity e17669e8-a246-51b4-9c9c-746ca88fb860` — the invoice id, on the ledger.

**What that first call needs depends on the clock, and it did not used to.** A first maturity of a
receivable not yet past due takes no body and records `on_time`; there is no instant left at which
the payment could have been late. A first maturity of one **already past due requires `paidAt`**
and refuses without it, because the only other thing left to decide the outcome from is the moment
the operator pressed the button. That is how `late` came to be the fallback for "never paid" as
well as for "paid late", written into a customer's permanent record either way.

```
curl -X POST http://localhost:8787/v1/invoices/<id>/mature \
  -H 'content-type: application/json' -d '{"paidAt":"2026-09-07T00:00:00Z"}'
```

A **replay** is untouched by that and still succeeds bodyless whatever the clock says, because
reading a settlement back decides nothing — which is what keeps this the route for asking whether
the collection key has signed. MF-2046 was matured four times and the ledger carries one outcome.

**Read the date before a rehearsal, because this will bite later in the month.** No sold invoice is
past due on 4 September — the earliest is MF-2039 on the 5th — but five of the sixteen sold rows
fall due on or before the 16th: MF-2039, MF-2037 and MF-2030, MF-2033, MF-2036. Each needs a
`paidAt` from the day after it falls due. And if the money genuinely never arrived,
`POST /v1/invoices/:id/default` is the other answer, and the one that marks the customer.

The reason the money comes from `0.0.10331559` and not from the operator is worth thirty seconds.
A scheduled transaction executes the moment its required signatures are present, and the operator
signs the create — so a payout drawn on the operator would fire on creation, reporting the debtor as
having paid at the instant the receivable matured. The collection account exists precisely so the
obligation can sit unsigned. `services/schedule.ts` refuses the configuration where the two are the
same account rather than trusting a comment.

And the reason there is a collection account at all: **the debtor has no wallet**. Confirmation
works because the customer is asked to acknowledge their own accounts payable through a link with
one sentence and two buttons. Give them a key to manage and that stops being true.

### If MF-2046 comes up

It will, because it is the largest position in the book and the first thing that ever settled. Its
proof view is
`http://localhost:3000/proof/85c8efbe-9940-4067-97f9-096f0576a377`, and it is honest rather than
clean:

- Its security is the **gas-probe bond**, still named `Facture Gas Probe Bond` on chain. MF-2046 was
  pointed at it by hand so DvP could be proven against a real ATS security before one existed for
  that receivable. So its instrument's maturity is the probe's, not MF-2046's due date, and the
  proof view shows a correct derived ISIN beside a security named for a probe.
- **Ten failed trade rows** stand against the one settled row, from five settlement attempts
  abandoned during debugging. **Three of those paid**: the buyer paid for this receivable four times
  and received it once, overpaying by 17,799,534 tinybars. That is the cost of a paid handler that
  was not side-effect-free between verify and settle, and it is why that rule is now written down.
- **Five units are locked** in the five abandoned holds, outside both free balances, because an ATS
  hold moves units out of `balanceOf`.

None of that is deleted, because a proof view whose job is being checkable cannot have history
quietly removed from underneath it. Say it before a judge finds it.

---

## Confirmation, if the debtor question comes up

The confirmation move sits between adding an invoice and offering it, and takes about a minute.
MF-2050
(`b874aa34-d0af-5813-ae3a-3eccfcb264cb`) and MF-2049 (`530009e2-d56c-5410-b003-f70c5d51ff71`) are
both waiting on it.

```
curl -X POST http://localhost:8787/v1/invoices/b874aa34-d0af-5813-ae3a-3eccfcb264cb/confirmation-request
```

There is no mail transport in this build, so outside production the response hands back the link it
would have emailed. It points at the venue's JSON endpoint,
`http://localhost:8787/v1/confirm/<token>`; the page a human reads is
**`http://localhost:3000/confirm/<token>`** with the same token. Take the token from the response
and open the second one.

That page has no masthead, no nav and no prices on it. One sentence — _"Meridian Fabrication says
you owe them $21,900.00, due 9 October. Is that right?"_ — and two buttons. The invoice turns green
and has a price, and the seller can then offer it. In production the link is not returned to the
seller, because a seller who can read it can confirm their own invoices.

---

## URLs, collected

### Screens — `http://localhost:3000`

Eight addressable routes, plus a 404 page — nine page files under `src/app`. Each of the eight
renders a loading, a failed and an empty state rather than only the happy path.

| route               | what it is                                                |
| ------------------- | --------------------------------------------------------- |
| `/`                 | the thesis                                                |
| `/book`             | the seller's book — the core screen                       |
| `/book/new`         | add invoices, singly or pasted from a spreadsheet         |
| `/book/[invoiceId]` | one invoice, its price, and what selling it would mean    |
| `/mandates`         | standing bids, exposure, weighted yield, maturity ladder  |
| `/mandates/new`     | write a mandate, with the implied price shown as you type |
| `/proof/[tradeId]`  | the audit view, one click from any trade                  |
| `/confirm/[token]`  | the debtor's page. Deliberately outside the market layout |
| — (404)             | `not-found`                                               |

Ready to paste:

```
http://localhost:3000/book
http://localhost:3000/book/1cba5ccd-f5e4-54f6-8d93-ec6bd4d01282   MF-2038, 675 bps, the listed one
http://localhost:3000/book/22e74885-8e34-50f2-8f36-e625f4ca7e99   MF-2041, 800 bps, four bids
http://localhost:3000/book/068ac953-19e4-5254-96ea-0b06b8f479f8   MF-2047, rated D, no bid
http://localhost:3000/book/460311ff-60d4-54dc-93ce-d5ccbad98b24   MF-2048, unrated, 1600 bps
http://localhost:3000/mandates
http://localhost:3000/proof/3d129208-a99e-4667-bc4a-1d7bc5a537eb  MF-2051, the clean lifecycle
http://localhost:3000/proof/6f0654c7-99fc-4f4c-a4fb-d0e7d2626b2e  MF-2052, second clean lifecycle
http://localhost:3000/proof/07c9b966-5192-46f4-ae90-b7dab62b11ad  MF-2061, the Arc rail
http://localhost:3000/proof/c0c8ed97-b01d-4c30-b9b2-0ddf7472fa3d  MF-2052 again, bought by the agent
http://localhost:3000/proof/85c8efbe-9940-4067-97f9-096f0576a377  MF-2046, the honest mess
```

The mandates screen is worth a deliberate stop: Harrow Point's two bids render `Escrowed on Arc`
and `Not escrowed`, and both say `Agent-run` — which the venue reports from the buyer's own policy
rather than the screen assuming it.

### Venue — `http://localhost:8787`

```
GET  /health
POST /v1/sellers                               sign in; Bearer a Privy identity token, no body
GET  /v1/sellers/:id
POST /v1/invoices                              202, and queues a real deployBond
GET  /v1/invoices?sellerId=…                   the book
GET  /v1/invoices/:id
POST /v1/invoices/:id/confirmation-request
POST /v1/invoices/:id/list                     the seller offers it: confirmed → listed
POST /v1/invoices/:id/delist                   listed → confirmed; refused while a trade is armed
POST /v1/invoices/:id/mature                   bodyless until it is past due, then `paidAt`
POST /v1/invoices/:id/default                  the debtor never paid; the rating mark is permanent
GET  /v1/invoices/:id/quote                    the price that is already there
GET  /v1/confirm/:token                        public, token-authenticated
POST /v1/confirm/:token
POST /v1/mandates
GET  /v1/mandates?buyerId=…                    carries `escrow` and `operator` per bid
GET  /v1/mandates/exposure?buyerId=…
POST /v1/mandates/:id/fund                     verified against the Arc vault
POST /v1/mandates/:id/withdraw                 409 or 503 problem+json on a refusal, nothing moved
GET  /v1/mandates/:id/exposure
POST /v1/trades                                settles outright on a funded mandate (200);
                                               otherwise arms first (402), settles on the second
POST /v1/trades/:id/unwind
GET  /v1/trades?sellerId=…|buyerId=…
GET  /v1/trades/:id
GET  /v1/trades/:id/proof
```

### Checkable without trusting us

The mirror node is the source a judge can read directly. HashScan renders the same data with a
browser in front of it.

```
https://testnet.mirrornode.hedera.com/api/v1/contracts/0.0.10331926      MF-2051's bond
https://testnet.mirrornode.hedera.com/api/v1/contracts/0.0.10331928      MF-2052's bond
https://testnet.mirrornode.hedera.com/api/v1/contracts/0.0.10316440      the gas-probe bond
https://testnet.mirrornode.hedera.com/api/v1/contracts/0.0.10348484      MF-2061's bond
https://testnet.mirrornode.hedera.com/api/v1/contracts/0.0.10343726      the agent's MF-2052
https://testnet.mirrornode.hedera.com/api/v1/schedules/0.0.10332092      MF-2051's payout
https://testnet.mirrornode.hedera.com/api/v1/schedules/0.0.10331573      MF-2046's payout
https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10311549-1788340765-589124475
https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1788340765-029692827
https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10311549-1788340781-520345720
https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1788449867-590233238
https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10342152/messages
```

---

## Move 6 — the guarantees, if there is time

Three claims the product makes that are now checkable by someone who has not agreed to trust the
venue. Each is one read. This is the strongest two minutes in the demo and it needs no UI.

### A refusal you can verify without us

Topic [`0.0.10342152`](https://hashscan.io/testnet/topic/0.0.10342152).

```
https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10342152/messages
```

The payload is a SHA-256 commitment and an opaque receipt id — **not** the reason. Say why: a
refusal names the customer and the amounts, and a topic is public, so publishing it would broadcast
one buyer's exposure and one seller's customer list. The refused party is handed their receipt and
their sequence number, hashes it the same way, and compares. We cannot change our answer after the
fact, and nobody watching learns anything but that a refusal happened.

### One receivable, one instrument — across venues, not just ours

Registry [`0x8eb9f00126bca50226e47b71a75f7b438e81d408`](https://hashscan.io/testnet/contract/0x8eb9f00126bca50226e47b71a75f7b438e81d408).

The point to make: a unique index stops **this** venue listing a receivable twice and can say
nothing about the same invoice being financed somewhere else — and the second financier is a
different company, not a second row in our table.

That was tested by claiming a receivable this venue has **no row for** —
`0xd57e1311a31458e8e38bfaaed4b69b3a8045ff725cbe3156527f83a6821ee945`, standing in for a rival — and
then trying to list it. The venue answered **409**. Nothing local could have refused it, because
there was nothing local.

### The debtor confirmation, in public

Registry [`0x44fe6E29aaDe69085CE53c4694b99EFe4639B7a7`](https://hashscan.io/testnet/contract/0x44fe6E29aaDe69085CE53c4694b99EFe4639B7a7).

`isConfirmed(invoiceId)` is a public view, and MF-2052 reads `true`
(`0x10b35612b7f88d6e9c7094bded16b0751a3c10201fac4d2b48afb62e59f2dcbd`). That is the fact the whole
risk argument rests on: a full advance with no holdback is justified **because** the customer
acknowledged the debt, and until this was on chain that was a column only we could see.

The contract cannot express a confirmation at listing — `list` always writes `Draft` — so a
confirmation the customer never gave is not something we could assert by setting one field.

### Capital that is actually posted

Vault [`0x217256d0fdf83ffd81bbc6884ad44f5c02501102`](https://testnet.arcscan.app/address/0x217256d0fdf83ffd81bbc6884ad44f5c02501102)
on Arc holds Harrow Point's mandate capital, deposited by that buyer's own wallet. The mandates
screen shows `Escrowed on Arc` on that bid and `Not escrowed` on the other.

Be precise about what this is: **capital backing a bid, and a rail that has drawn on it once.** 5
USDC went in; MF-2061 took 0.014843 out through `executePayout`, and the balance reads 4.985157.
That difference is the whole argument — a bid is firm because the money is already there, and the
proof is that some of it has left.

And five seeded mandates still quote against capital nobody posted; the funding check stops that
growing rather than undoing it, which is why the screen labels each bid rather than claiming the
book is uniformly backed. The screen now prints both figures — what the vault holds and what the
mandate needs — because the check that compares them used to compare raw digits four orders of
magnitude apart and agree with itself.

---

## Staging

None of this is on the demo clock. All of it costs real testnet HBAR.

**Issuance is paced and slow.** One `deployBond` is about 7.02M gas and 7.3–8.9 HBAR, and the queue
holds a 4-second minimum interval between submissions because Hedera throttles on network gas
throughput as well as per transaction. Twenty invoices is twenty of those. Pre-issue the book.

**A deployed bond is not a tradeable one.** `deployBond` leaves an instrument with no supply, an
empty allowlist and no KYC, and a transfer against it reverts without naming any of that.
`facture-prep/x402-probe/prepare-security.mjs` walks the ten transactions that fix it — four role
grants, two control-list entries, an issuer registration, two KYC grants, and the mint — reading
before each step so a re-run costs nothing. It lives outside this repo because it carries keys.

**Balances, read on 2026-09-02:**

| account                   | balance     | what it pays for                   |
| ------------------------- | ----------- | ---------------------------------- |
| operator `0.0.10311549`   | 881.73 HBAR | issuance, holds, schedule creation |
| buyer `0.0.10314099`      | 48.34 HBAR  | the cash leg                       |
| collection `0.0.10331559` | 4.87 HBAR   | maturity payouts, and nothing else |

**Resetting the book is not free and mostly not worth it.** Deleting `packages/backend/data/facture.db*`
and re-running `db:migrate` then `db:seed` restores the 28 seeded invoices with their ids
unchanged, because every seeded id is a UUIDv5 of its fixture label. But MF-2051 and MF-2052 seed
as drafts with no instrument, so the queue immediately spends two `deployBond` calls on them, and
they then need `prepare-security.mjs` before either can trade. The Harrow Point mandate that won
MF-2051 at 850 bps was created live and is **not** in the seed, so it would have to be written and
funded again through `/mandates/new`. Run the demo against the book as it stands.
