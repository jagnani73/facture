<h1 align="center">Facture</h1>

<p align="center">
  <strong>An invoice is a zero-coupon bond that nobody ever priced.</strong>
</p>

<p align="center">
  Hedera &middot; Arc &middot; ATS zero-coupon paper &middot; cross-chain DvP over x402
</p>

---

> **Status: running on testnet.** The five moves below have each happened on chain, more than
> once, for real. A receivable was issued as an ATS zero-coupon bond, priced off a standing mandate,
> checked against the security's own control list, settled delivery-versus-payment, and
> matured — paying its holder par. Addresses, transaction ids and balances either side of each
> of those are in [docs/deployments.md](./docs/deployments.md), which is written so that every
> claim on this page can be checked somewhere that is not us.
> [docs/demo.md](./docs/demo.md) walks the same five moves against the running venue, and
> [docs/ai-usage.md](./docs/ai-usage.md) says which parts a model wrote and which decisions
> were not its to make.
>
> What that does **not** mean: this is a hackathon build on Hedera and Arc testnets, with a
> seeded demo book behind it. The cash leg has two rails — a funded mandate settles out of its
> Arc escrow in USDC, an unfunded one over x402 on Hedera in HBAR under a declared scale — and
> **both have now carried live trades.** Real USDC is escrowed on Arc, deposited by that buyer's
> own wallet, and a sale has been paid out of it and collected by the seller with their own key.
> Where a section describes behaviour the build does not have yet, it says so in place rather
> than leaving you to find out.

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

Two things enforce it, and they answer different questions. A unique index on the hash, written in
the same statement that creates the invoice, means there is no check-then-insert window inside this
venue. And [`UniquenessRegistry`](https://hashscan.io/testnet/contract/0x8eb9f00126bca50226e47b71a75f7b438e81d408)
on Hedera is checked before an invoice is listed and claimed once its instrument exists &mdash; which
is the half a database cannot do, because the second financier is a different company, not a second
row in the first one's table. The registry is append-only and has no release, so a non-zero answer is
a permanent public statement that a receivable is spoken for.

That has been tested the only way it means anything: a receivable **this venue has no row for** was
claimed on chain by another instrument, and listing it came back 409. Nothing local could have
refused it.

If the registry cannot be reached, listing proceeds on the index alone. That is a real reduction in
strength rather than a fallback that pretends otherwise, and it is the honest trade against an RPC
outage stopping a business from listing an invoice.

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

Every refusal is stored with its reason code and its sentence, and committed to a Hedera Consensus
Service topic &mdash; [`0.0.10342152`](https://hashscan.io/testnet/topic/0.0.10342152) &mdash; so
the refused party can check it without trusting us.

**What goes on the topic is a hash, not the reason.** A refusal names the customer and the amounts,
and a topic is public: publishing it would broadcast one buyer's exposure and one seller's customer
list to anyone reading. So the message carries a SHA-256 commitment and an opaque receipt id. We
hand you your receipt, you hash it the same way, and you check it against the digest recorded at
your sequence number. We cannot later claim we gave you a different reason, and nobody watching the
topic learns anything but that a refusal happened.

Consensus attaches after the receipt is written, so a topic that is unavailable costs the
independently checkable copy and never the answer itself. A refusal is always recorded; it is
checkable wherever consensus was reached.

### Settle

Delivery versus payment across two chains, without a bridge. The bond stays on Hedera, the USDC stays
on Arc, and neither side has to move first.

This reads x402 as a settlement protocol rather than an API paywall: the challenge holds the asset
leg, the payment signature is the cash leg, and the facilitator is what makes the two simultaneous.
Nothing is wrapped and nothing crosses.

The honest reason for two chains is not that it is clever. It is that **buyer capital already lives
where stablecoins live.** You do not ask a treasury desk to bridge onto Hedera to buy a $40k
receivable. DvP means it never has to.

Where the build actually is, in four parts, because they are four different claims.

**The cash leg has two rails, and the mandate decides which.** A bid whose capital is escrowed in
`MandateVault` settles out of it, in USDC on Arc, and `POST /v1/trades` answers `200` with both legs
already done &mdash; **no challenge and no signature, because a funded mandate already said yes to
anything meeting its terms. That is what "firm bid" means.** An unfunded bid gets the x402 exchange
instead. Both answers carry the rail and the reason, so nothing is inferred.

**Nine receivables have sold on chain, and six of them took their payment over x402 on
`hedera:testnet`**, in HBAR, with face value in cents mapped to tinybars 1:1 under a declared scale.
The other three are the paragraph below. The Hedera book's `cashLeg()` returns Arc's chain id and the
vault address as immutables recorded at construction, so the cross-chain link cannot be redirected.

**Three sales have now been paid in USDC on Arc.** `MandateVault` held 5 USDC against one mandate,
deposited by that buyer's own wallet; MF-2061 drew 0.014843 of it, the payout locked in
`DvpEscrow`, and the seller claimed it with their own key &mdash; 0.5 &rarr; 0.512972 USDC, the
difference being the gas they paid, because `claim` checks the caller and the venue cannot collect
for them. MF-2070 drew another 0.012326 and matured; its lock still reads `locked`, because the
seller has not claimed it and `reclaimPayout` is not wired. **MF-2080 went the whole way in one
sitting** &mdash; sold out of the escrow, claimed for 0.017943 USDC net of gas, matured `on_time`,
and paid at par by the collection account, with the mandate book's own verdict on the settlement
response beside the venue's. The venue still refuses to count a
mandate as holding more than the vault does; `balanceOf` is a view, so checking costs nothing.

One consequence worth stating, because it surprised us: **the seller claims their own payout.**
`DvpEscrow.claim` requires `msg.sender == beneficiary`, so a payout lands in an escrow lock rather
than a wallet, and Arc gas is USDC &mdash; a seller holding none can be paid and be unable to
collect.

**One of those x402 payments was made by an agent rather than by a person.** `@facture/agent` read
the book, priced it against its own mandate, armed the trade, signed the cash leg with the buyer's
Hedera key and settled &mdash; trade `c0c8ed97-b01d-4c30-b9b2-0ddf7472fa3d`, cash
`0.0.7162784@1788449867.590233238`, paper `0.0.10311549@1788449868.676674741`, and the match
committed to topic [`0.0.10342152`](https://hashscan.io/testnet/topic/0.0.10342152) at sequence 24.
The buyer paid the 868,798 tinybars it was quoted and nothing else: the entire 258,441 fee was
charged to the facilitator, because the payload's transaction id is generated against the
facilitator's account rather than the payer's. Nothing about the invoice was arranged for it: the
customer is unrated, which loses five of the seven mandates outright, a sixth caps tenor at 45 days
against a 47-day invoice, and the one bid left holds no vault capital &mdash; so the venue routed it
to x402 by its own arithmetic rather than by configuration.

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
invoices: customer, amount, invoice number, due date.

A seller signs in with an email address and Privy makes the wallet; there is nothing to install and
no seed phrase to keep. The venue reads the email out of a signed Privy identity token rather than
out of the request, so what it records is what Privy attested rather than what a caller typed, and a
wallet address once recorded is never rebound by signing in again. Signed out, the screens show a
shared **demo book** &mdash; seeded, with settled trades and matured receivables in it, so the market
can be looked at without an account at all.

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
face, against the 2&ndash;5% the same seller pays a factoring house today. The customer confirms, the
seller offers it into the book, and it settles in seconds against the best mandate that accepts this
customer, accepts this tenor, and has exposure left. Offering is the seller's own act: a confirmed
invoice is priced, a listed one is for sale, and arming a trade refuses anything that is not
listed.

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

- **What makes a bid firm.** Matching is bounded by a mandate's unallocated balance, and the escrow
  behind that bound is `MandateVault` on Arc. Funding is checked against what the vault actually
  holds &mdash; `balanceOf` is a view, so it costs nothing to ask &mdash; and a mandate cannot be
  credited with capital nobody deposited. One mandate is backed this way today, with 5 USDC posted
  by that buyer's own wallet. **The six seeded mandates are not**, and still quote against capital
  nobody posted: the check stops that growing rather than undoing it, and the demo book says which
  is which.
- **Where a rating comes from.** Earned on the platform out of settled payment behaviour, starting
  unrated. No oracle, and no invented score.
- **Whether an invoice is real.** Debtor confirmation gates listability, and it is recorded on
  [`InvoiceRegistry`](https://hashscan.io/testnet/contract/0x44fe6E29aaDe69085CE53c4694b99EFe4639B7a7):
  `isConfirmed(invoiceId)` is a public view, so the fact that justifies advancing the full face value
  is checkable without trusting us. The contract cannot express a confirmation at listing &mdash; it
  always writes `Draft` &mdash; so a confirmation the customer never gave is not something the venue
  can assert by setting one field. A uniqueness registry
  keyed on `hash(debtor, invoice number, amount)` means one receivable mints exactly one instrument,
  ever.
- **What a seller does with the USDC.** Claims it, and then nothing. A vault payout lands in a
  `DvpEscrow` lock the seller opens with their own key inside 24 hours — the preimage is on the
  proof view, and it is not a credential, because `claim` checks the caller as well as the hash.
  Past that, cash-out rails are out of scope and are said plainly rather than mocked.
- **Whether market-makers are visible.** They are real agents holding funded mandates, and they are
  presented as exactly that. Fake liquidity is the one thing that would undo every argument above.

  **What caps one is the mandate, and nothing else.** The agent will not bid past its mandate's
  committed capital, and the venue enforces the same bound again when the trade is armed. **Circle
  enforces no spending cap on this path and the product does not claim it does**: spending policies
  are a mainnet Agent Wallets feature, Arc has no mainnet identifier there, and
  developer-controlled wallets have no policy engine at all. A cap we wrote, described as a cap the
  custodian holds, would be the same overclaim as fake liquidity one layer down.

  The agent defaults to a dry run &mdash; it reads the book, prices it, and reports what its
  mandates would take. Run live it does more than arm a trade: it holds the buyer's Hedera key and
  signs a transfer of their own HBAR for every trade that prices to the x402 rail, and nothing
  between that decision and consensus asks a second time. The standing bids in the demo book are
  still seeded rows rather than bids an agent wrote &mdash; but one receivable in that book was
  bought by the agent, with its own key, for real money.

## Architecture

Five packages, two chains, and exactly one moment where a person is asked to sign something.

```mermaid
flowchart LR
    Seller["Seller"]
    Debtor["Customer<br/><i>one sentence, two buttons</i>"]

    subgraph pkgs["pnpm workspace"]
        Web["<b>@facture/web</b><br/>Next.js 15 · React 19"]
        API["<b>@facture/backend</b><br/>Hono · SQLite/drizzle<br/>quote engine · settlement · issuance"]
        Agent["<b>@facture/agent</b><br/>market maker<br/>Circle wallet · Hedera key"]
        Shared["<b>@facture/shared</b><br/>curve · state machines<br/>refusal codes · ISIN · uniqueness hash"]
        Contracts["<b>@facture/contracts</b><br/>Hardhat · imported by nothing"]
    end

    Privy["Privy<br/>email sign-in, wallet made from it"]
    Circle["Circle<br/>developer-controlled wallets"]
    Fac["Blocky402<br/>x402 facilitator"]

    subgraph hed["Hedera testnet · the paper"]
        ATS["ATS bond, one per invoice<br/>deployBond · hold · ControlList · Kyc"]
        Uniq["UniquenessRegistry<br/>0x8eb9f001…"]
        InvReg["InvoiceRegistry<br/>0x44fe6E29…"]
        Topic["HCS topic 0.0.10342152<br/>refusal and match digests"]
        Sched["Scheduled Transaction<br/>maturity pays the holder"]
        Mirror["Mirror node"]
        CashH["x402 cash leg<br/>HBAR transfer"]
    end

    subgraph arcnet["Arc testnet · the money"]
        Vault["MandateVault<br/>0x217256d0…"]
        Esc["DvpEscrow<br/>0x32e3511A…"]
    end

    Dead["<b>Deployed and verified, called by nothing</b><br/>MandateBook · AtsComplianceGate<br/>DvpEscrow on Hedera"]

    Seller -->|"adds invoices, watches the price move"| Web
    Debtor -->|"confirms by link, no wallet"| Web
    Web -->|"REST /v1"| API
    Web -->|"sign-in"| Privy
    API -->|"verifies the identity token"| Privy
    Web -->|"claim: msg.sender must be the beneficiary"| Esc

    Agent -->|"reads the book, arms a trade"| API
    Agent -->|"payment-signature: a signed TransferTransaction"| API
    Agent -->|"pnpm fund"| Circle
    Circle -->|"deposit into this mandate's bucket"| Vault
    Agent -.->|"HBAR balance, pre-flight"| Mirror

    API -->|"deployBond · createHold · executeHold<br/>ControlList · Kyc · paused, before the match"| ATS
    API -->|"checked when an invoice is added,<br/>claimed once its bond exists"| Uniq
    API -->|"list after the claim · setStatus<br/>when the customer answers"| InvReg
    API -->|"ScheduleCreate at maturity"| Sched
    API -.->|"security ids · schedule status · /health"| Mirror
    API -.->|"sha256 digests, never the reason"| Topic
    API -->|"verify, then settle"| Fac
    Fac -->|"adds its signature, pays the fee"| CashH

    API -->|"registerMandate · registerMatch<br/>executePayout · executeRelease"| Vault
    Vault -->|"locks the payout for the seller alone"| Esc
    API -.->|"getLock, read only"| Esc

    Web -.-> Shared
    API -.-> Shared
    Agent -.->|"one vocabulary"| Shared

    Contracts -.->|"hardhat deploy, verified on Sourcify"| Uniq
    Contracts -.-> InvReg
    Contracts -.-> Vault
    Contracts -.-> Esc
    Contracts -.-> Dead

    classDef hedera fill:#1f4e6b,stroke:#14384e,color:#fff
    classDef arc fill:#0d5c4a,stroke:#08402f,color:#fff
    classDef party fill:#3a3a3a,stroke:#222,color:#fff
    classDef pkg fill:#4c3a72,stroke:#33284f,color:#fff
    classDef ext fill:#6b4520,stroke:#4a2f14,color:#fff
    classDef unwired fill:#2b2b2b,stroke:#6b6b6b,color:#bdbdbd
    class ATS,Uniq,InvReg,Topic,Sched,Mirror,CashH hedera
    class Vault,Esc arc
    class Seller,Debtor party
    class Web,API,Agent,Shared,Contracts pkg
    class Privy,Circle,Fac ext
    class Dead unwired
```

Two things the picture cannot say.

`@facture/contracts` is a Hardhat workspace and **no package imports it.** Every ABI the backend
calls is written out beside the call, so nothing in the build ties the TypeScript to the Solidity.
The one thread between them is a test in `@facture/agent` that reads `libraries/ReasonCodes.sol` off
disk and fails if the on-chain refusal strings stop spelling what `@facture/shared` spells, because
`tsc` cannot see a Solidity rename.

The grey box is the other. `MandateBook`, `AtsComplianceGate` and the Hedera `DvpEscrow` are
deployed, verified on Sourcify, and reached by nothing. There is no environment variable for any of
their addresses, so the backend could not call them if it wanted to. The compliance check that does
run reads the security's own `ControlList` and `Kyc` facets over the JSON-RPC relay, which is a
different thing from the gate contract that shares its name.

### A settlement, both rails

```mermaid
sequenceDiagram
    autonumber
    participant S as Seller
    participant V as Venue backend
    participant P as Hedera
    participant A as Arc
    participant F as Blocky402
    participant B as Buyer agent

    S->>V: POST /v1/trades, quoting the price they were shown
    V->>V: re-price against the live curve
    V->>P: read ControlList, Kyc, paused
    V->>P: createHoldByPartition, the seller's whole position
    Note over V,P: The paper is held, not moved.<br/>Neither side has gone first.

    alt the bid's capital is escrowed in MandateVault
        V->>A: registerMatch, binding payee and price, one shot
        V->>A: executePayout, 14,843 USDC minor units leave the vault
        Note over V,A: Cash commits before the paper moves, and the invoice<br/>is marked sold here. Reversed, a failed payout leaves<br/>the buyer holding paper nobody paid for.
        V->>P: executeHold, the units move to the buyer
        V-->>S: 200, both legs done, with the preimage
        S->>A: claim(lockId, secret), signed by the seller alone
    else nothing escrowed behind the bid
        V-->>S: 402 payment-required, carrying the challenge
        Note over S,B: One route, two halves of one exchange. In the recorded<br/>run the agent armed the trade itself, so both halves<br/>were the same caller.
        B->>B: sign a native TransferTransaction, no network needed
        B->>V: the same request again, payment-signature
        V->>F: verify, then settle
        F->>P: 868,798 tinybars to the seller, 258,441 of fee on the facilitator
        V->>P: executeHold, 890,000 units to the buyer
        V-->>B: 200, settled
    end

    V->>P: HCS 0.0.10342152, a digest of the match
```

The two branches are two different receivables, because no invoice sells twice. The Arc figures are
MF-2061, trade `07c9b966-5192-46f4-ae90-b7dab62b11ad`; the x402 figures are the agent's own
purchase, trade `c0c8ed97-b01d-4c30-b9b2-0ddf7472fa3d`. Both are in
[docs/deployments.md](./docs/deployments.md) with the transactions and the balances either side.

A diagram can only draw the path where nothing fails, and the ordering exists for the path where
something does. If the Arc payout lands and the delivery then fails, the money is in an escrow lock
the vault can take back and the seller still holds their position, so waiting recovers it.
`MandateVault.reclaimPayout` is the permissionless call that does that, and **nothing in the backend
makes it** &mdash; recovering a stranded lock is an operator action. Reverse those two steps and a
failed payout leaves the buyer holding paper nobody paid for, which nothing recovers.

Marking the invoice sold at the payout rather than at the delivery is a fix, not a flourish. The
x402 branch has the identical hole and cannot reach it, because a second sale there would need a
second signature; taking that signature away is what made it reachable. It took a double-spend found
in review to notice.

### How a bid gets refused

Every mandate on the book is screened against the invoice, and a screen that fails produces a
sentence rather than silence.

```mermaid
flowchart TD
    Q["one bid, one invoice<br/><i>bestQuote in @facture/shared</i>"] --> St{"invoice confirmed<br/>or listed?"}
    St -->|no| R0["INVOICE_NOT_CONFIRMED<br/><i>once, not once per bid</i>"]
    St -->|yes| Ac{"mandate active?"}
    Ac -->|no| R1["MANDATE_NOT_ACTIVE"]
    Ac -->|yes| Cu{"same currency?"}
    Cu -->|no| R2["CURRENCY_MISMATCH"]
    Cu -->|yes| Rt{"customer's rating<br/>meets the floor?"}
    Rt -->|no| R3["RATING_BELOW_MANDATE"]
    Rt -->|yes| Tn{"tenor inside<br/>the ceiling?"}
    Tn -->|no| R4["TENOR_EXCEEDS_MANDATE"]
    Tn -->|yes| Pr["price it<br/>face · yield · days"]
    Pr --> Ex{"unallocated balance<br/>covers the proceeds?"}
    Ex -->|no| R5["EXPOSURE_EXHAUSTED"]
    Ex -->|yes| Dc{"room left against<br/>this customer?"}
    Dc -->|no| R6["DEBTOR_CONCENTRATION"]
    Dc -->|yes| Win["a candidate<br/><i>lowest yield wins</i>"]
    Win --> Ch{"can that buyer hold<br/>this instrument?"}
    Ch -->|"no, and the read succeeded"| Drop["dropped, price again without it<br/>three passes at most<br/><i>mandatesBarredByInstrument</i>"]
    Drop --> Q
    Ch -->|yes| Quote["the price on the screen"]
    Quote --> Arm{"seller arms the trade:<br/>the gate runs again"}
    Arm -->|refused| F403["403 and a sentence<br/><i>nothing reserved, nothing held</i>"]
    Arm -->|allowed| Go["hold the paper, settle both legs"]

    R3 -.->|"receipt written, digest committed at arm time"| HCS["HCS topic 0.0.10342152"]

    classDef refusal fill:#5c2323,stroke:#3d1616,color:#fff
    classDef ok fill:#3a3a3a,stroke:#222,color:#fff
    classDef hedera fill:#1f4e6b,stroke:#14384e,color:#fff
    class R0,R1,R2,R3,R4,R5,R6,F403 refusal
    class Win,Quote,Go ok
    class Drop,HCS hedera
```

The run underneath it is the agent's own purchase, and nothing about that invoice was arranged. The
customer is `UNRATED`, which loses five of the seven mandates on `RATING_BELOW_MANDATE` before a
price is computed at all. Of the two carrying an `UNRATED` floor, one caps tenor at 45 days against
a 47-day invoice and goes on `TENOR_EXCEEDS_MANDATE`. One bid is left, at 1850 bps, and it holds no
capital in the vault, which is how that trade reached the x402 rail by arithmetic rather than by
configuration.

The last two forks are the ones worth reading twice, because **neither produces a refusal code.**
When an instrument's own control list bars a buyer, the bid did not decline the paper; the paper
declined the bid, and `@facture/shared` has no word for that because the contracts do not either. It
comes back as a count, `mandatesBarredByInstrument`, and at arm time as a 403 carrying a sentence.
On the invoice above that count was 1 and there was no quote at all; once the security was prepared
it was 0 and the quote was 1850 bps, with the six economic refusals identical either side.

The qualifier on that fork is load-bearing too. A bid is dropped when the instrument answers no, and
kept when the instrument cannot be asked, because an indeterminate answer must not move a price: a
relay outage would otherwise drop the three tightest bids on every invoice and quietly widen the
whole curve. Arming refuses on the unknown, since money must not move on one, and that asymmetry is
deliberate.

Two codes in the vocabulary are never produced by the running venue. `NOT_KYC_VERIFIED` is spelled
in `AtsComplianceGate.sol`, and that contract is in the grey box above. `INELIGIBLE_JURISDICTION`
describes a question this venue does not decide, because Reg S scope lives on the instrument. They
stay in the union so that a refusal a funder reads is spelled the same wherever it came from, which
is a different claim from this path emitting them.

One more thing about timing, since the tree does not carry a clock. Refusals are computed on every
quote and returned for the screen; the stored receipt and its HCS digest are written when a seller
actually arms a trade. A price nobody acted on leaves no permanent record of who declined it.

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
