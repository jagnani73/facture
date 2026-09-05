<h1 align="center">Facture</h1>

<p align="center">
  <strong>An invoice is a zero-coupon bond that nobody ever priced.</strong>
</p>

<p align="center">
  Hedera &middot; Arc &middot; ATS zero-coupon paper &middot; cross-chain DvP over x402
</p>

---

> **Status: running on testnet.** The five moves below have each happened on chain, once, for
> real. A receivable was issued as an ATS zero-coupon bond, priced off a standing mandate,
> checked against the security's own control list, settled delivery-versus-payment, and
> matured — paying its holder par. Addresses, transaction ids and balances either side of each
> of those are in [docs/deployments.md](./docs/deployments.md), which is written so that every
> claim on this page can be checked somewhere that is not us.
> [docs/demo.md](./docs/demo.md) walks the same five moves against the running venue, and
> [docs/ai-usage.md](./docs/ai-usage.md) says which parts a model wrote and which decisions
> were not its to make.
>
> What that does **not** mean: this is a hackathon build on Hedera and Arc testnets, with a
> seeded demo book behind it. The cash leg that has actually settled ran over x402 on Hedera,
> in HBAR under a declared scale — the Arc contracts are deployed and the Hedera book records
> the Arc vault and chain id as construction-time immutables, but no USDC has crossed that link
> yet. Where a section describes behaviour the build does not have yet, it says so in place
> rather than leaving you to find out.

Factoring is bond pricing done over the phone. A business that is owed money and needs it now calls
a factor, the factor prices the paper privately, and the business takes 2&ndash;5% off the face value
for the privilege of not waiting. There is no screen, no curve, and no second buyer.

Facture is the market that should exist instead.

## Why this exists

The reason invoice finance never developed a market is not regulation and not custody. It is that
**invoices are not fungible.** Every receivable is a different debtor, a different amount and a
different number of days to maturity, so no two are the same asset. An order book needs something to
book, and there is nothing here that repeats.

So price stays bilateral. It gets negotiated once, in private, by whoever picked up the phone.

The move is to stop trying to standardise the paper and **standardise the bid instead.** A buyer does
not post an offer for one invoice; they post a standing quote over a bucket:

> _Any A-rated paper, 60 days or less, at 12.5% annualised, up to $200k of exposure._

Now the assets stay unique and the **buyers** become fungible. Any receivable that arrives is priced
immediately by reading the curve at its own rating and tenor. Nobody waits for a counterparty,
because the counterparties were already there.

### The instrument was always a bond

This only works if a receivable can be described honestly as a tradeable instrument, and it can. A
discounted invoice is a zero-coupon bond: bought below par, redeeming at face on a fixed date, with
the discount being the yield. That is not a metaphor, it is the same instrument.

Hedera's [Asset Tokenization Studio](https://github.com/hashgraph/asset-tokenization-studio) turns
out to agree. `deployBond` initialises every bond at `rate: 0`, carrying a maturity date, a principal
and a face value redeemed at maturity. The default case in ATS is already a discounted receivable; it
just isn't described that way in the docs.

## How it works

Five moves. The paper lives on Hedera, the money lives on Arc, and neither has to travel.

```mermaid
flowchart LR
    SME["Business<br/>owed $40k in 60 days"]
    Bond["ATS zero-coupon bond<br/>maturity · principal · face"]
    Uniq["Uniqueness registry<br/>one receivable, one token"]
    Curve["Standing bids<br/><i>rating × tenor → yield</i>"]
    Match["Match<br/>eligibility checked first"]
    DvP["Cross-chain DvP<br/>neither party moves first"]
    Buyer["Buyer<br/>USDC on Arc"]
    Mat["Maturity<br/>pays the current holder"]

    SME -->|list| Bond
    Bond --> Uniq
    Bond --> Curve
    Buyer --> Curve
    Curve -->|quote| Match
    Match --> DvP
    DvP --> Mat

    classDef hedera fill:#1f4e6b,stroke:#14384e,color:#fff
    classDef arc fill:#0d5c4a,stroke:#08402f,color:#fff
    classDef party fill:#3a3a3a,stroke:#222,color:#fff
    class Bond,Uniq,Mat hedera
    class Buyer,DvP arc
    class SME,Curve,Match party
```

### List

The receivable is issued as an ATS zero-coupon bond. Maturity is the invoice due date, principal is
the face value.

Alongside it, a uniqueness registry keyed on `hash(debtor, invoice_no, amount)` means one receivable
mints exactly one token, ever. That is the cheap half of the fraud problem and it is worth doing on
day one: selling the same receivable to three financiers is the specific fraud that factoring has
always had, and it is roughly what broke Greensill. A registry does not make an invoice real, but it
stops it being sold twice.

Today that uniqueness is enforced by a unique index on the hash, written in the same statement that
creates the invoice, so there is no check-then-insert window for the fraud to fit through. The
`UniquenessRegistry` contract is deployed and the venue does not yet call it, so the guarantee is
currently the venue's rather than the chain's.

### Quote

Bids are standing, not per-asset. They carry a rating floor, a maximum tenor, an annualised yield and
an exposure ceiling, which is how money-market desks have always quoted short paper. A new invoice is
priced by reading the curve where it sits.

A quote is only worth something if it is firm, which means the capital behind a bid has to be
committed rather than merely permitted. Funding is what does that, and a mandate can only match up
to its unallocated balance &mdash; so overcommitment has a structural answer rather than a patch.
See _Buyers do not browse_ below.

### Match

Eligibility is checked against the security's own `ControlList` and `Kyc` facets **before** matching,
not at settlement.

That ordering is the whole argument. An AMM matches first and discovers the transfer is illegal
afterwards, so a non-compliant trade shows up as a revert. Here an ineligible counterparty is never
matched in the first place, and the refusal is a first-class output rather than a failed transaction.

Every refusal is stored with its reason code and its sentence, and the schema carries the HCS topic
and sequence number that would let the refused party check it without trusting us. **Nothing writes
to HCS yet**, so those two fields are null on every trade that really settled. The seeded book fills
them in; the ledger does not.

### Settle

Delivery versus payment across two chains, without a bridge. The bond stays on Hedera, the USDC stays
on Arc, and neither side has to move first.

This reads x402 as a settlement protocol rather than an API paywall: the challenge holds the asset
leg, the payment signature is the cash leg, and the facilitator is what makes the two simultaneous.
Nothing is wrapped and nothing crosses.

The honest reason for two chains is not that it is clever. It is that **buyer capital already lives
where stablecoins live.** You do not ask a treasury desk to bridge onto Hedera to buy a $40k
receivable. DvP means it never has to.

Where the build actually is: the trades that settled ran their cash leg over x402 on
`hedera:testnet`, in HBAR, with face value in cents mapped to tinybars 1:1 under a declared scale.
The Arc leg &mdash; `MandateVault` and the payment-side `DvpEscrow` &mdash; is deployed on Arc
testnet, and the Hedera book's `cashLeg()` returns Arc's chain id and the vault address as
immutables recorded at construction, so the link cannot be redirected. It has not yet carried USDC.
The mechanism is real; the second chain is wired and idle.

### Mature

The debtor pays and settlement routes to whoever holds the token **now**, not whoever bought it
first.

This is not a lifecycle nicety. Without it the paper cannot legitimately change hands, because a
second buyer would have no way to be paid &mdash; so it is load-bearing for the claim that this is a
secondary market at all.

The mechanism follows from something already decided elsewhere on this page: **the debtor has no
wallet**, because confirmation is a link with one sentence and two buttons and a key to manage would
undo that. So the payout cannot be a transfer the debtor signs. It is drawn instead on a collection
account the venue operates, which is how a factoring house already collects and disburses.

Maturity therefore produces an **obligation, not a payment**. It writes a Hedera Scheduled
Transaction paying face value to the current holder, and leaves it unsigned on the ledger where that
holder can read it. Signing it is a separate act &mdash; the venue's statement that the debtor's
money actually arrived &mdash; and only then does the cash leg become a receipt. The venue cannot
quietly collapse the two, because the account being debited is deliberately not the one that creates
the schedule.

## One book, two lives

Seasoned paper is just shorter-tenor paper, so an invoice sold at 4% on day zero lists into the same
bids on day thirty and clears tighter because less time remains. Primary and secondary run through
one book, and the price moves for a reason anyone can follow.

That is not one market counted twice, and the argument is under _Exit_ below: a buyer bids tighter on
paper they know they can exit, so the secondary leg is what makes the primary quote competitive.
Partial position sales sharpen the distinction further, being something the primary leg structurally
cannot do.

## The product

Nobody using Facture needs to know it is on a blockchain. A seller sees invoices with prices beside
them. A buyer sees mandates, exposure and yield. Every primitive here already has a plain financial
name, so that is the name it is given.

The chains surface in exactly one place: a proof view, one click from any trade, showing the on-chain
receipts, the compliance decision and both settlement legs.

### The book

A seller connects a wallet, or has one made from an email address, and adds their outstanding
invoices: customer, amount, invoice number, due date. There is no sign-in in this build &mdash; the
screens are told which seller and which buyer they are looking at by configuration, and the venue
scopes every route by that id.

Each invoice becomes an instrument at this moment, not at the moment of sale. That ordering matters
more than it looks. Tokenisation happens at onboarding, when nobody is watching a clock, so issuance
is never on the critical path of the moment money moves.

### Confirmation

An invoice is grey until the customer confirms it. The seller requests confirmation and the customer
receives a link carrying one sentence &mdash; _Meridian Fabrication says you owe them $40,000, due 30
November. Is that right?_ &mdash; and two buttons. No wallet, no signup.

This works where most attestation schemes do not, and the reason is behavioural rather than
cryptographic. The debtor is not being asked to vouch for a stranger. They are being asked to
acknowledge their own accounts payable, which costs them nothing and which they have no incentive to
deny.

The invoice turns green. Now it has a price.

### The quote is already there

A confirmed invoice carries a live price. Not a button that requests one: the number is simply
present, and it moves as the curve moves and as the due date approaches.

> **$40,000** &middot; due in 60 days &middot; worth **$39,178** today
> 12.5% annualised &middot; three mandates would take this

This is the product. Every other screen exists to make this screen true. Nothing in invoice finance
works this way today, where a price is a phone call and a wait.

### The sale

Face $40,000, sixty days, 12.5% annualised, discount $821.92, proceeds $39,178.08 &mdash; 2.05% of
face, against the 2&ndash;5% the same seller pays a factoring house today. Confirm, and it settles in seconds
against the best mandate that accepts this customer, accepts this tenor, and has exposure left.

### Buyers do not browse

A funder never scrolls through invoices deciding one at a time. They write a mandate &mdash; _any
invoice, customer rated A or better, ninety days or less, at 12.5% annualised, up to $200,000 total
and $50,000 per customer_ &mdash; fund it, and walk away.

Funding is what makes the quote firm, which is the answer to what a standing bid actually commits. A
mandate can only match up to its unallocated balance, so overcommitment has a structural answer
rather than a patch.

This is also how credit desks already work. The job is portfolio policy, not deal-by-deal
underwriting. Standing mandates are not a workaround for the absence of an order book; they are the
correct instrument for paper that will never be fungible.

### Exit

On day thirty a holder lists back into the same book and clears tighter, keeping the carry they
earned, or sells half the position and keeps the rest.

The reason this is not decoration: buyers bid tighter on paper they know they can exit. Remove the
secondary leg and every mandate widens, and the seller gets less on day zero. The two markets are not
sequential features. One prices the other.

Neither half of this is built. A sold invoice cannot be requoted &mdash; the venue answers _this
invoice has already been sold, so it cannot be priced_ &mdash; and partial position sales are
cut-list item 4, so an exit today is all or nothing. This section is the argument for why the
secondary leg is worth building, not a description of a screen that exists.

### Ratings are earned, not assigned

A customer starts unrated, and their first invoice prices at the wide end of the curve. Every invoice
they pay on time tightens it, permanently and visibly.

This is not a preference between two viable options. No external source of truth exists for SME
debtor credit &mdash; there is no feed, oracle or otherwise, that says whether a given customer is
good for $40,000 in sixty days &mdash; so a market in this paper has to manufacture its own record or
price blind. It is also what real factoring houses do, where the proprietary debtor book is the moat.
The cost is a genuine cold start, stated rather than hidden. A seller's
customers becoming an asset the seller owns is the compounding argument for the whole thing.

### Issuance is paced, not instant

A seller adding twenty invoices is twenty seven-million-gas transactions. Hedera throttles on network
gas throughput as well as per-transaction gas, so a burst of those will start returning `BUSY` long
before any single one is refused. Onboarding therefore queues and paces issuance, and the book shows
an invoice as _being added_ until its instrument exists.

This costs nothing, because issuance was already moved off the critical path. Nobody is waiting on it
&mdash; the seller added invoices, and they become quotable as they land.

### Non-recourse, and why there is no holdback

Facture is a non-recourse market, and that is not a preference &mdash; it follows from the pricing. A
mandate is written against the _customer's_ rating, so the risk being priced is the customer's, which
means the buyer carries the loss if the customer does not pay. Pricing on debtor quality and then
handing the loss back to the seller would be incoherent.

It is also a **full advance**. Conventional factoring holds back ten to twenty per cent until the
debtor settles, because the invoice might be disputed, short-paid or already partly satisfied. That
holdback exists to cover dispute risk &mdash; and debtor confirmation removes dispute risk at the
point of listing, because the customer has already acknowledged the amount and the date. Confirmation
is what buys the seller the other fifteen per cent, on the day they sell.

When a customer does default, the buyer takes the loss and that customer's rating takes a permanent
mark, which widens their curve for every seller afterwards. That is the loop that makes an earned
rating self-correcting rather than merely accumulated: the market prices its own mistakes back in.

### The refusal

A mandate that is not eligible for an instrument does not match, and the funder is told why in words
rather than by a reverted transaction. The first one this venue produced for real, against the
tightest bid in the book, read:

> Cordell Credit Partners is not permitted to hold this security by its control list.

That arrived as a 403 with that sentence attached. Nothing was reserved, nothing was held and
nothing moved.

## What is decided, and what is not

Recorded here so they are not relitigated mid-build.

- **One bond per invoice is affordable. Measured on chain, not estimated.** `Factory.deployBond`
  cost **7,016,307 gas** for the first bond this project issued, and 7,024,576 and 7,023,179 for the
  two the venue went on to issue by itself &mdash; about 47% of Hedera's 15M per-transaction ceiling,
  and inside the 6,956,443&ndash;7,310,717 range read off 24 historical calls to the deployed
  factory. That is 7.3&ndash;8.9 HBAR an issuance. Ninety-four facets initialise in that one
  transaction, at roughly 74k each, so the facet count would have to almost double before the
  ceiling binds. Live operations are cheap by comparison: a role grant is 180k, a KYC grant 190k, a
  mint 465k, a transfer 254k warm. Heterogeneous per-invoice paper stands.

- **What makes a bid firm.** Matching is bounded by a mandate's unallocated balance, which is also
  what resolves two invoices arriving against one mandate. That bound is enforced. The escrow behind
  it is not yet: no escrow provider is wired into this build, so funding records the reference and
  the amount rather than reading a confirmed deposit, and the store is the authority on how much
  landed.
- **Where a rating comes from.** Earned on the platform out of settled payment behaviour, starting
  unrated. No oracle, and no invented score.
- **Whether an invoice is real.** Debtor confirmation gates listability, and a uniqueness registry
  keyed on `hash(debtor, invoice number, amount)` means one receivable mints exactly one instrument,
  ever.
- **What a seller does with the USDC.** Nothing, for now. Cash-out rails are out of scope and are
  said plainly rather than mocked.
- **Whether market-makers are visible.** They are real agents holding funded mandates on
  policy-capped wallets, and they are presented as exactly that. Fake liquidity is the one thing that
  would undo every argument above. In this build the agent runs against Circle developer-controlled
  wallets and defaults to a dry run &mdash; it reads the book, prices it, reports what its mandates
  would take, and arms nothing without being told to in so many words. The standing bids in the demo
  book are seeded rows, not bids an agent wrote.

## Prior art

Two projects sit close enough that they should be named rather than hoped over.

**[Mand(ate)](https://ethglobal.com/showcase/mand-ate-3npu6)** built AI-driven invoice escrow where
agents negotiate terms bilaterally. That is the opposite mechanism on the same market: Facture's
argument is that bilateral negotiation is the problem, and a standing-bid book that quotes before
anyone asks is the alternative.

**[Wafer](https://ethglobal.com/showcase/wafer-r4uab)** won Hedera's tokenization track at ETHGlobal
New York 2026 with a NAV-appreciating credit fund and a secondary market on SaucerSwap. The
distinction is the one drawn under _Match_ above: an AMM cannot enforce compliance at the point of
trade, because it has no point of trade at which to ask.

## Licence

Not yet chosen.
