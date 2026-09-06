# Architecture

Facture is a market for tokenised receivables. Buyers post standing quotes over risk buckets, and
any invoice is priced off the resulting curve the moment it appears. The paper lives on Hedera as
ATS zero-coupon bonds — **one bond per invoice**, never a pool — and the cash lives on Arc as USDC.
The two settle against each other with no bridge and nothing wrapped.

Four diagrams: what the pieces are, the path a receivable takes through them, how the cash leg picks
a rail, and the lifecycle an invoice status follows. Every box and arrow is something the running
build does. Where a contract is deployed and deliberately not called, it says so in place rather
than being drawn as if it were live.

Addresses are testnet. Each one is recorded with the transactions behind it in
[deployments.md](./deployments.md), and [demo.md](./demo.md) walks the same path against the running
venue.

---

## 1. The pieces

Five packages, two chains, and exactly one moment where a person is asked to sign something.

```mermaid
flowchart LR
    Seller["Seller<br/><i>a business owed money</i>"]
    Debtor["Customer<br/><i>confirms by link · no wallet</i>"]

    subgraph pkgs["pnpm workspace"]
        Web["<b>@facture/web</b><br/>Next.js 15 · React 19<br/>book · mandates · proof view"]
        API["<b>@facture/backend</b><br/>Hono · SQLite/drizzle<br/>quote engine · settlement · issuance"]
        Agent["<b>@facture/agent</b><br/>buy-side desk<br/>Circle wallet · Hedera key"]
        Shared["<b>@facture/shared</b><br/>curve · state machines<br/>refusal codes · ISIN · uniqueness hash"]
        Contracts["<b>@facture/contracts</b><br/>Hardhat · imported by no package"]
    end

    Privy["Privy<br/>email sign-in · wallet policy"]
    Circle["Circle<br/>developer-controlled wallets"]
    Fac["Blocky402<br/>x402 facilitator"]

    subgraph hed["Hedera testnet · chain 296 · the paper"]
        ATS["ATS bond — one per invoice<br/>deployBond · hold · ControlList · Kyc"]
        Uniq["UniquenessRegistry<br/>0x8eb9f001…"]
        InvReg["InvoiceRegistry<br/>0x44fe6E29…"]
        Book["MandateBook<br/>0x361f9d4b…"]
        Gate["AtsComplianceGate<br/>0x6d78847e…"]
        Topic["HCS topic 0.0.10342152<br/>refusal and match digests"]
        Sched["Scheduled Transaction<br/>collection account 0.0.10331559"]
        CashH["x402 cash leg<br/>HBAR transfer"]
        Mirror["Mirror node"]
        DvpH["DvpEscrow — delivery leg<br/>0x35a8a43d…<br/><b>deployed, not called</b>"]
    end

    subgraph arcnet["Arc testnet · chain 5042002 · the money"]
        Vault["MandateVault<br/>0x217256d0…"]
        EscA["DvpEscrow — payment leg<br/>0x32e3511A…"]
    end

    Seller -->|"adds invoices, offers them for sale"| Web
    Debtor -->|"one sentence, two buttons"| Web
    Web -->|"REST /v1"| API
    Web -->|"sign-in"| Privy
    API -->|"verifies the identity token<br/>attaches the claim policy"| Privy
    Web -->|"claim — the one signature a person makes"| EscA

    Agent -->|"reads the book, arms a trade"| API
    Agent -->|"payment-signature: a signed TransferTransaction"| API
    Agent -->|"pnpm fund"| Circle
    Circle -->|"deposit into this mandate's bucket"| Vault
    Agent -.->|"HBAR balance, pre-flight"| Mirror

    API -->|"deployBond at onboarding<br/>createHold · executeHold at settlement"| ATS
    API -->|"lookup before listing<br/>claim once the bond exists"| Uniq
    API -->|"list after the claim · setStatus on confirmation<br/>lookup on the proof view"| InvReg
    API -->|"postMandate · creditFunding · previewMatch"| Book
    API -->|"canReceive, before the match"| Gate
    Gate -.->|"paused · control list · KYC"| ATS
    API -.->|"sha256 digests, never the reason"| Topic
    API -->|"ScheduleCreate at maturity"| Sched
    API -.->|"security ids · schedule status<br/>compliance sentences · /health"| Mirror
    API -->|"verify, then settle"| Fac
    Fac -->|"adds its signature, pays the fee"| CashH

    API -->|"registerMandate · registerMatch<br/>executePayout · executeRelease"| Vault
    Vault -->|"locks the payout for the seller alone"| EscA
    API -.->|"payoutOf · getLock, read only"| EscA

    Web -.-> Shared
    API -.-> Shared
    Agent -.->|"one vocabulary"| Shared

    Contracts -.->|"hardhat deploy · verified on Sourcify"| hed
    Contracts -.-> arcnet

    classDef hedera fill:#1f4e6b,stroke:#14384e,color:#fff
    classDef arc fill:#0d5c4a,stroke:#08402f,color:#fff
    classDef party fill:#3a3a3a,stroke:#222,color:#fff
    classDef pkg fill:#4c3a72,stroke:#33284f,color:#fff
    classDef ext fill:#6b4520,stroke:#4a2f14,color:#fff
    classDef unwired fill:#2b2b2b,stroke:#6b6b6b,color:#bdbdbd
    class ATS,Uniq,InvReg,Book,Gate,Topic,Sched,Mirror,CashH hedera
    class Vault,EscA arc
    class Seller,Debtor party
    class Web,API,Agent,Shared,Contracts pkg
    class Privy,Circle,Fac ext
    class DvpH unwired
```

**The frontend and the backend are separate packages and separate origins.** `@facture/web` is a
Next.js app with eight addressable routes; `@facture/backend` is a Hono service over SQLite that
holds every key the venue signs with. The web package talks to it over REST and reaches a chain
directly exactly once, to send the seller's `claim`.

**`@facture/contracts` is imported by nothing.** Every ABI the backend calls is written out beside
the call, so no build step ties the TypeScript to the Solidity. The one thread between them is a
test in `@facture/agent` that reads `libraries/ReasonCodes.sol` off disk and fails if the on-chain
refusal strings stop spelling what `@facture/shared` spells, because `tsc` cannot see a Solidity
rename.

**Six of the seven deployed contracts are in the live path.** The Hedera `DvpEscrow` is the
exception, and it is a stated position rather than a gap: its only designed reader is
`MandateBook.confirmSettlement`, and reaching it would mean moving a regulated security into an
escrow contract that would then need a control-list entry and a KYC grant on every instrument the
venue ever issues. The asset leg is an ATS hold instead, which immobilises the units without them
leaving the seller's ledger entry. The backend has no env var, no ABI entry and no code path that
can address it.

**Each dependency is off, not faked, when it is not configured.** No factory means issuance is
disabled rather than simulated; no vault address means funding is recorded rather than verified; no
topic means a refusal is recorded without a consensus copy. The one exception is the compliance
gate: with no gate address the backend reads the same three facts off the instrument's own facets
over RPC, which is a different route to the same answer rather than a relaxation.

---

## 2. The path a receivable takes

The five moves the product is built around: list, quote, match, settle, mature. Issuance sits before
all of them, at onboarding, so tokenisation is never on the critical path of the moment money moves.

```mermaid
sequenceDiagram
    autonumber
    participant S as Seller
    participant D as Customer
    participant V as Venue backend
    participant H as Hedera
    participant A as Arc

    Note over S,H: Onboarding. Paced, and never while anyone is watching a clock.
    S->>V: POST /v1/invoices
    V->>H: UniquenessRegistry.lookup(hash)
    Note over V,H: hash(debtor, invoice number, face). A non-zero answer<br/>is a permanent public claim by someone else — 409.
    V-->>S: 202, the instrument does not exist yet
    V->>H: deployBond — one ATS zero-coupon bond for this invoice
    V->>H: UniquenessRegistry.claim(hash, instrument)
    V->>H: InvoiceRegistry.list(...)
    Note over V,H: Strictly after the claim: list verifies the hash against<br/>the uniqueness registry rather than trusting its caller.

    S->>V: POST /v1/invoices/:id/confirmation-request
    V->>D: a link carrying one sentence and two buttons
    D->>V: POST /v1/confirm/:token — confirmed
    V->>H: InvoiceRegistry.setStatus(Confirmed)
    Note over D,H: No wallet and no signup. isConfirmed(invoiceId) is a public<br/>view, so the fact that justifies a full advance is checkable.

    S->>V: POST /v1/invoices/:id/list
    Note over S,V: A price is not an offer. Arming refuses anything not listed.

    S->>V: GET /v1/invoices/:id/quote
    V->>V: price every standing mandate, lowest yield wins
    V->>H: AtsComplianceGate.canReceive(instrument, winning buyer)
    V-->>S: the price, already on the screen

    S->>V: POST /v1/trades
    V->>V: re-price against the live curve
    V->>H: canReceive — again, before anything is reserved
    alt the instrument bars that buyer
        V-->>S: 403 and a sentence — nothing reserved, nothing held
        V->>H: HCS 0.0.10342152 — sha256 of the refusal receipt
    else eligible
        V->>H: MandateBook.previewMatch — published, decides nothing
        V->>H: createHoldByPartition — the seller's whole position
        Note over V,H: An ATS hold, not a transfer into escrow. The units leave<br/>the free balance and stay on the seller's ledger entry.
        V->>A: the cash leg, on one of two rails — see diagram 3
        V->>H: executeHoldByPartition — the units move to the buyer
        V->>H: HCS 0.0.10342152 — sha256 of the settled match
        V-->>S: 200, both legs done
    end

    S->>V: POST /v1/invoices/:id/mature
    V->>H: ScheduleCreate — face value to the current holder
    Note over V,H: Drawn on collection account 0.0.10331559, deliberately not the<br/>operator. An obligation, not a payment: it sits unsigned until<br/>the collection key signs, which is the venue's statement that<br/>the debtor's money arrived.
```

**Compliance runs before the match, not at settlement.** That ordering is the argument against
doing this on an AMM: an AMM matches first and discovers the transfer was illegal afterwards, so
non-compliance arrives as a revert. Here an ineligible counterparty is never matched, and the
refusal is a 403 with a sentence.

`AtsComplianceGate.canReceive` is one `eth_call` and it is what decides. When it permits, that is the
whole check. When it refuses, the backend then reads the instrument's own facets — `paused()`,
`getControlListType()`, `isInControlList()`, `getKycStatusFor()` — because a reason code is not
something a seller can act on and a sentence is. If the gate refuses while the facets permit, the
trade is refused and marked indeterminate: settlement must not move on a contradiction, and a
contradiction is not a fact about the buyer either.

The same call runs at quote time, scoped narrowly. `priceOne` screens only the winning bid and, if
it is barred, drops it and prices the next — at most three passes, so the usual cost is one
on-chain read. `priceBook` screens nothing, deliberately: it prices the whole book in one pass, and
checking per row is the N+1 that design exists to avoid. A book price is indicative; the price a
seller acts on is screened. An **unreadable** instrument is not a refusal there, because a relay
outage would otherwise drop the tightest bids on every invoice and quietly widen the curve. Arming
refuses on the unknown, since money must not move on one.

**`MandateBook.previewMatch` is the one verdict on that path the venue cannot have arranged.** It
reads the rating, the confirmation, the due date and the face value out of `InvoiceRegistry` rather
than from the caller. It is a free `eth_call` that decides nothing and is published beside the
venue's own answer, because the book floors the discount where `@facture/shared` ceils it — so the
two legitimately differ by a minor unit on a match both would take. The reason code is the
comparable part, not the number.

**The topic carries a SHA-256 digest, never the reason.** A refusal sentence names the customer and
the amounts, and a topic is public, so publishing one would broadcast a buyer's exposure and a
seller's customer list. The refused party is handed their receipt and their sequence number and
checks the digest themselves. Settled matches are committed the same way, under a separate canonical
form. Neither publisher throws: an unavailable topic costs the independently checkable copy and
never the refusal or the trade.

---

## 3. Two cash rails, and how one is chosen

The asset leg is the same either way — an ATS hold on Hedera, executed once the cash has moved. The
cash leg has two rails and the mandate decides which, by whether its capital is already posted.

```mermaid
flowchart TD
    Arm["POST /v1/trades<br/><i>re-priced, compliance passed</i>"] --> Hold["createHoldByPartition<br/><i>the seller's whole position</i>"]
    Hold --> Choose{"chooseRail<br/>does the vault balance cover the price,<br/>and does the seller have an Arc address?"}

    Choose -->|"yes — capital escrowed"| A1["MandateVault.registerMatch<br/><i>binds payee and price · one shot</i>"]
    A1 --> A2["MandateVault.executePayout<br/><i>USDC leaves the vault into DvpEscrow</i>"]
    A2 --> A3["the invoice is marked sold<br/><i>at the payment, not the delivery</i>"]
    A3 --> A4["executeHoldByPartition<br/><i>units move to the buyer</i>"]
    A4 --> A5["<b>200</b> — both legs done<br/>no challenge, nothing signed"]
    A5 --> A6["the seller claims, with their own key<br/><i>msg.sender == beneficiary</i>"]

    Choose -->|"no — nothing posted"| X1["<b>402</b> payment-required<br/><i>challenge, 180s hold window</i>"]
    X1 --> X2["the buyer signs a native<br/>TransferTransaction"]
    X2 --> X3["the same request again,<br/>payment-signature"]
    X3 --> X4["Blocky402: verify, then settle<br/><i>HBAR moves on Hedera</i>"]
    X4 --> X5["executeHoldByPartition"]
    X5 --> X6["<b>200</b> — settled"]

    A5 --> HCS["HCS 0.0.10342152<br/>sha256 of the match"]
    X6 --> HCS

    classDef arc fill:#0d5c4a,stroke:#08402f,color:#fff
    classDef hedera fill:#1f4e6b,stroke:#14384e,color:#fff
    classDef neutral fill:#3a3a3a,stroke:#222,color:#fff
    class A1,A2,A4,A5,A6 arc
    class X1,X2,X3,X4,X5,X6,HCS hedera
    class Arm,Hold,A3 neutral
```

**A funded mandate settles in one call and answers 200, already settled.** There is nothing for the
buyer to sign: they escrowed the capital and wrote the terms, so an invoice meeting those terms is a
trade they have already agreed to. Asking for a second consent is what would make a standing bid not
standing. Both response bodies carry `rail.chosen` and `rail.reason`, and the receipt and the proof
view print the same thing, so which rail ran is stated rather than inferred.

**The order is chosen by which way a failure hurts.** Cash commits before the paper moves. Reverse
those two and a failed payout leaves the buyer holding paper nobody paid for, which nothing
recovers; this way a failed delivery leaves money in an escrow lock the vault gets back and the
seller keeps their position.

**The invoice is marked sold when the cash commits, not when the delivery lands.** That ordering is
a fix rather than a flourish. With no per-trade signature on this rail, a failed delivery used to
leave the invoice quotable, and a fresh quote drew a second payout from the same mandate — one
receivable paid for twice, silently. The x402 rail has the identical hole and cannot reach it,
because a second sale there needs a second signature.

**The hold windows differ because they are sized for different things.** The x402 challenge window
is 180 seconds, which is how long a buyer has to sign; the vault window is 720, which has to cover
two Arc writes and two receipt waits back to back, and is still far inside the escrow's 24-hour
payment lock.

**Both rails convert through one function.** `toSettlementAmount` in `src/units.ts` is the single
place USD cents become settlement minor units, under `X402_SETTLEMENT_SCALE_PPM`. The scale governs
both rails despite the prefix, deliberately: one receivable has to cost the same money whichever way
it settles, and a per-rail scale factor is how two rails come to quote two prices for one invoice.

**The seller claims their own payout, and that is the one signature a person makes.**
`DvpEscrow.claim` checks `msg.sender == beneficiary`, so the venue cannot collect for a seller even
while holding the public preimage. The key that can is the embedded wallet Privy made at sign-in,
scoped by a wallet policy to that one call: `to` equals the escrow, `chain_id` equals 5042002, and
the decoded calldata names `claim`. Privy denies by default, so that is the whole permission the
wallet holds. Arc gas is USDC, which means a seller holding none can be paid and be unable to
collect — `pnpm demo:reset` funds them.

`MandateVault.reclaimPayout` returns a stranded lock's capital to the mandate. It is permissionless
and **nothing in the backend calls it**; recovering a stranded lock is an operator action.

---

## 4. The invoice lifecycle

The machine lives in `@facture/shared` and the diagram below is drawn from it, not the other way
round. No transition table has been edited to match the code, deliberately: a machine edited to
agree with its callers can never catch them being wrong.

```mermaid
stateDiagram-v2
    [*] --> draft
    draft --> awaiting_confirmation: the seller sends a confirmation link
    awaiting_confirmation --> draft: pulled back to fix a typo
    awaiting_confirmation --> confirmed: the customer acknowledges
    awaiting_confirmation --> disputed: the customer says no
    confirmed --> listed: the seller offers it into the book
    listed --> confirmed: taken off the book
    confirmed --> disputed
    listed --> disputed
    listed --> sold: matched, and both DvP legs settled
    sold --> listed: the secondary market
    sold --> matured: the debtor paid at maturity
    sold --> defaulted: maturity passed unpaid
    sold --> disputed: a dispute surfacing after the sale
    disputed --> confirmed: resolved in the seller's favour
    disputed --> defaulted: resolved against the seller, or never paid
    matured --> [*]
    defaulted --> [*]

    note right of sold
        sold → listed is the one edge with no writer.
        After a sale the units are in the buyer's account,
        and an ATS hold acts on the caller's own tokens —
        so a relist needs the buyer to authorise the venue
        as an ERC-1400 operator, signed with a key no
        wallet this build issues can produce.
    end note
```

Quotability is not the same as listing. A `confirmed` invoice carries an indicative price because
the book renders in one pass with no chain reads, and that is worth keeping. Listing is the seller
offering it, and the offer binds at arm time: **arming refuses anything not listed**, and delisting
is refused while a trade is armed, so a seller cannot withdraw the offer between the 402 and the
buyer's signature.

`matured` and `defaulted` are terminal, and both feed the customer's rating, which never ages off.
The rating is earned on the platform out of settled payment behaviour, starting unrated — there is
no oracle for SME debtor credit and none is invented.

---

## Deployed contracts

All seven are verified on Sourcify, which is what lights HashScan's badge. Transactions, sizes and
the reads that confirm the wiring are in [deployments.md](./deployments.md).

| contract                   | chain        | address                                      | in the live path                                     |
| -------------------------- | ------------ | -------------------------------------------- | ---------------------------------------------------- |
| `UniquenessRegistry`       | Hedera 296   | `0x8eb9f00126bca50226e47b71a75f7b438e81d408` | yes — `lookup` before listing, `claim` after issuance |
| `InvoiceRegistry`          | Hedera 296   | `0x44fe6E29aaDe69085CE53c4694b99EFe4639B7a7` | yes — `list`, `setStatus`, `lookup`                   |
| `MandateBook`              | Hedera 296   | `0x361f9d4b1101898417b2b9148bc8aa522024a38f` | yes — `postMandate`, `creditFunding`, `previewMatch`  |
| `AtsComplianceGate`        | Hedera 296   | `0x6d78847e4ac257da68909c5a4c60ea1dcc060564` | yes — `canReceive`, at quote and again at arm         |
| `DvpEscrow` (delivery leg) | Hedera 296   | `0x35a8a43d2d840f02887cd0427e78f6b0205ded87` | **no, deliberately** — see below                      |
| `MandateVault`             | Arc 5042002  | `0x217256d0fdf83ffd81bbc6884ad44f5c02501102` | yes — the Arc cash rail                               |
| `DvpEscrow` (payment leg)  | Arc 5042002  | `0x32e3511a2f3d941f776df01f6ba66a73caf10d69` | yes — where a vault payout lands                      |

Two more Hedera objects the venue writes to, neither of them a contract: HCS topic
**`0.0.10342152`**, which carries refusal and match digests, and collection account
**`0.0.10331559`**, which pays matured receivables and is deliberately not the operator.

An earlier `AtsComplianceGate` at `0x9a2c848ab62e715d2b49a4710f6451395978abbb` is still live and
still verified. It probed three ATS selectors that do not exist on a deployed diamond and therefore
refused every buyer on every instrument. It is left in place so that an address found in an old note
can be identified rather than guessed at.

The `MandateBook` reads its own cross-chain link from immutables recorded at construction:
`cashLeg()` returns `(5042002, 0x217256d0…)`, the Arc chain id and the vault, so the link cannot be
redirected after deployment.
