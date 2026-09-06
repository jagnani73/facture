# Deployed addresses

Testnet only. Recorded 2026-09-01, re-verified against chain 2026-09-03. Sections carry their own
dates; where one contradicted a later one, the later one has been kept and the earlier corrected in
place rather than deleted.

Every address, size and transaction below was read back from Hedera rather than copied from a
deploy log. Where the chain and an earlier note disagreed, the chain won.

## Hedera testnet (chain 296)

The live venue, redeployed after the refusal-code rename in `78faa1a`.

| contract                   | address                                      | bytes  |
| -------------------------- | -------------------------------------------- | ------ |
| `MandateBook`              | `0x361f9d4b1101898417b2b9148bc8aa522024a38f` | 15,046 |
| `InvoiceRegistry`          | `0x44fe6E29aaDe69085CE53c4694b99EFe4639B7a7` | 5,075  |
| `DvpEscrow` (delivery leg) | `0x35a8a43d2d840f02887cd0427e78f6b0205ded87` | 4,412  |
| `UniquenessRegistry`       | `0x8eb9f00126bca50226e47b71a75f7b438e81d408` | 1,554  |
| `AtsComplianceGate`        | `0x9a2c848ab62e715d2b49a4710f6451395978abbb` | 983    |

Wiring verified by `eth_call` against the book itself:

- `invoiceRegistry()` returns `0x44fe6E29…`, the registry above.
- `complianceGate()` returns `0x9A2C848A…`, the gate above.
- `cashLeg()` returns `(5042002, 0x217256d0…)` — the Arc chain id and vault, both immutables.
  The cross-chain link is recorded at construction and cannot be redirected.
- `uniquenessRegistry()` is **not** exposed as a getter and reverts, so the book cannot be
  asked which registry it points at. The address was confirmed a different way on 2026-09-03:
  reading the contract at it returns 1,554 bytes matching the table, `owner()` is the
  operator's alias, and it accepted a `claim` from that key. Every line in this table is now
  confirmed by on-chain state.

### Superseded, still live

The pre-rename venue was never destroyed and still answers on chain. It is wired to its own
registry and gate, and to the same Arc vault, so it looks healthy and is not. Nothing in the
repo points at it; this table exists so an address found in an old note can be identified
rather than trusted.

| contract             | address                                      | bytes  |
| -------------------- | -------------------------------------------- | ------ |
| `MandateBook`        | `0xcfafef6086caede6fad096523bd6e23db44e0d60` | 15,052 |
| `InvoiceRegistry`    | `0x471336f1058Ada6e4d79BD2F50e0CFED39883874` | 5,075  |
| `DvpEscrow`          | `0x7522344a12efbbbf5a7f43c05a69f26fa668eed6` | 4,412  |
| `UniquenessRegistry` | `0x82ab4e85640b14070d337ef4d4d02c8974e7b0a8` | 1,554  |
| `AtsComplianceGate`  | `0xc65e6a706a98c847cad85ffda1f7e008b50f8af8` | 982    |

The size differences are the rename itself: `MandateBook` lost six bytes and
`AtsComplianceGate` gained one when the refusal strings changed length.

## Arc testnet (chain 5042002)

| contract                  | address                                      | bytes |
| ------------------------- | -------------------------------------------- | ----- |
| `MandateVault`            | `0x217256d0fdf83ffd81bbc6884ad44f5c02501102` | 5,519 |
| `DvpEscrow` (payment leg) | `0x32e3511a2f3d941f776df01f6ba66a73caf10d69` | 4,412 |

Deploy order runs one way and never doubles back: Arc escrow, Arc vault, then the Hedera book
which records the vault. Deploying both contracts cost 0.047 USDC.

### USDC has crossed — 2026-09-03

The Arc leg was deployed and idle from the first day. `MandateVault` now holds real capital
against a real mandate, deposited by the buyer's own wallet.

|                   |                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| mandate           | `8b879d02-4593-4d66-82bf-52d4833401b6`, Harrow Point                                                         |
| vault key         | `uint256(keccak256(uuid))` = `15346442137576820289478969865486017349700696992123142042335952903215516347363` |
| buyer registered  | `0x1C755e95CB11E5D5aF498bb0EA595b56e1adb035` — the Circle agent wallet                                       |
| `registerMandate` | `0x86c198869e9ee8aa3ea8ef62eede563a5881b2fc8acba0b6c778f3fadfb3c08d`, 48,503 gas                             |
| top-up            | `0x69d933f0691ab84e2db41c03caf9d645e021018e8afd51c5ace821dee487b4b6`                                         |
| deposited         | **5,000,000 minor units — 5 USDC**                                                                           |

Balances either side, read from the ERC-20 interface:

| account                | before | after    |
| ---------------------- | ------ | -------- |
| vault `0x217256d0…`    | 0      | 5        |
| buyer `0x1c755e95…`    | 6      | 0.996822 |
| attester `0x46783EeC…` | 94.951 | 93.949   |

The buyer was topped up 5 → 6 first, because Arc gas is USDC and the native and ERC-20 views
are **one balance**: depositing all five would have left nothing to pay for depositing them.

`registerMandate` had to come first — a deposit against an unregistered mandate reverts,
which is the vault refusing capital with no way out. It also forced a correction:
**Harrow Point's `arc_address` was invented**, like every seeded buyer's, and
`executeRelease` returns capital to the registered address, so an invented one is a release
nobody can receive. Migration `0004` points it at the wallet that exists.

`ARC_MANDATE_VAULT_ADDRESS` is set on the demo deployment, so funding is now verified against
this vault. **Five seeded mandates still quote against capital nobody posted** — the check
guards the funding path and does not retroactively unfund anything, so that is stopped from
growing rather than undone.

## The uniqueness registry, in the live path — 2026-09-03

`UniquenessRegistry` at `0x8eb9f00126bca50226e47b71a75f7b438e81d408` had been deployed since
day one and called by nothing. It is now checked before an invoice is listed and claimed
after its instrument exists.

The address is also no longer the one line in this file that on-chain state does not confirm:
reading it back gives **1,554 bytes**, matching the table above exactly, with
`owner() = 0x2Da63Ac0…` — the operator's alias.

|                    |                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `setIssuer`        | `0x26c0065983e987fdbf55cf0d4b709f48afdd760ed429bc7a88091d43ce1cdbe3`, 47,777 gas                          |
| first claim        | MF-2052's hash → its own instrument, `0x122633d75d4730e6f02c3dc7a8cf6ca2a2cb1ba96bb834ea238acda79be80845` |
| rival claim (test) | `0xd57e1311a31458e8e38bfaaed4b69b3a8045ff725cbe3156527f83a6821ee945` → `0x…dEaD`                          |

The contract does not make its deployer an issuer implicitly, so the `IssuerSet` log is a
complete history of who has ever been able to write a permanent binding.

### The proof that matters

A unique index stops **this** venue listing a receivable twice. The interesting question is
whether the same invoice can be financed here _and somewhere else_, and no database can
answer it.

So a receivable this venue has never listed — Petra Foods, `MF-9999`, $9,900 — was claimed on
chain against `0x…dEaD`, standing in for a rival financier. Listing it then returned **409**.
There is no row for that receivable anywhere in this database; nothing local could have
refused it.

### A bond issued by accident

`0.0.10343726`, roughly 8 HBAR, and invoice `7d9ecd44-2a78-420e-bd9c-8c718caf0fc6`.

Testing the duplicate check, an `MF-2052` was posted with `ap@petrafoods.example` rather than
the seeded `payables@petrafoods.example`. `upsertDebtor` keys on email, so that created a
**second Petra Foods Group** debtor, which made a different `debtorId`, which made a different
uniqueness hash — correctly, because to this venue that is a different customer's invoice. It
listed, issued, and cost real gas.

Recorded rather than removed, for the same reason as the MF-2046 debris: a book whose job is
to be checkable cannot have history quietly deleted from underneath it. The consequences to
know about are that the demo book holds **two invoices named MF-2052** and two debtors
called Petra Foods Group — the seeded one rated `B`, the accidental one `UNRATED`.

## The invoice registry, in the live path — 2026-09-03

`InvoiceRegistry` at `0x44fe6E29aaDe69085CE53c4694b99EFe4639B7a7` is the second deployed
contract the running product calls. Reading it back: 5,075 bytes matching the table,
`owner()` the operator's alias, `uniquenessRegistry()` returning `0x8eb9f001…` — the exact
registry wired the same day — and the operator **already an attester**, so no grant was
needed.

|                        |                                                                      |
| ---------------------- | -------------------------------------------------------------------- |
| invoice                | MF-2052, `4af57501-ba14-50b8-bc7f-11f07edfea13`                      |
| `list`                 | `0xea2bf309c9142033cd3edee84beeb71a401f08003f0a5d2fff898d21b380070e` |
| `setStatus(Confirmed)` | `0x10b35612b7f88d6e9c7094bded16b0751a3c10201fac4d2b48afb62e59f2dcbd` |
| before                 | `listed: false, confirmed: false`                                    |
| after                  | **`listed: true, confirmed: true`**                                  |

`isConfirmed(invoiceId)` is a public view, so the confirmation the product's risk argument
rests on — full advance, no holdback, because dispute risk was removed — is now checkable by
someone who has not agreed to trust the venue.

Listing cannot run before the uniqueness claim: `list` verifies the hash against the
uniqueness registry rather than trusting its caller. That ordering is the contract's.

**Nothing new is disclosed.** The face value and due date go on chain here and are already
public — issuance sets the bond's `maxSupply` to the face value and its maturity to the due
date. Identifiers are opaque `bytes32`, and no customer name or email is written.

## Refusal receipts on HCS — 2026-09-03

|               |                                                                |
| ------------- | -------------------------------------------------------------- |
| topic         | `0.0.10342152`                                                 |
| create tx     | `0.0.10311549@1788400397.382626486`                            |
| memo          | `Facture refusal receipts v1 — sha256 commitments, no reasons` |
| submit key    | none — anyone may write                                        |
| first message | sequence `1`, consensus `1788400454.638258247`                 |

A message is a SHA-256 commitment and an opaque receipt id, and nothing else:

```json
{ "v": 1, "kind": "facture.refusal", "receiptId": "…", "digest": "572e74b3…524b8a3d" }
```

**The reason is deliberately absent.** A refusal sentence names the debtor and the amounts,
so publishing one would put a buyer's exposure and a seller's customer list on a public
stream. The refused party is given their receipt and their sequence number, hashes the
receipt the same way, and compares — which proves the venue did not change its answer without
revealing the answer to anyone else. Read back from the mirror node to confirm the payload
carries no reason, rating, tenor, mandate or buyer.

**No submit key, on purpose.** The property wanted is that the venue cannot alter what it
already said, not that only the venue may speak. A forged message commits to a digest that
matches no receipt anyone holds, and the sequence number is what binds a receipt to a
message, so an open topic adds noise rather than weakness.

The digest of the receipt at sequence 1 is pinned as a literal in `test/hcs.test.ts`: it is a
promise already made to whoever holds that receipt, so the canonical field order can never be
changed quietly.

## ATS security (the paper)

|              |                                                                      |
| ------------ | -------------------------------------------------------------------- |
| bond         | `0.0.10316440` / `0x9cb3468607a359c214cb27159d5d5853d5e83877`        |
| name         | `Facture Gas Probe Bond`                                             |
| symbol       | `FCTPRB`                                                             |
| ISIN         | `US0000000010`                                                       |
| regulation   | Reg S (`1/0`), allowlist on, clearing later deactivated              |
| excluded     | `AF,CU,KP,IR,SY`                                                     |
| supply       | 12,460,000                                                           |
| `deployBond` | 7,016,307 gas against an 8,000,000 limit, 7.928427 HBAR              |
| deploy tx    | `0xbe1c381a87d6ebf9936b2a3436fc2da1cd4d93e45d91e50265a64759a91076be` |

Name, symbol, ISIN and the excluded-country list are decoded from that transaction's own
calldata, which is the only unambiguous record of what the bond carries — the security exposes
no ISIN getter.

### This bond is a stand-in, and the demo has to say so

It was deployed as a gas probe, which is what it is still called on chain. MF-2046 was pointed
at it by hand so the DvP path could be proven against a real ATS security before one existed
for that receivable.

So `security_id` on MF-2046 is a borrowed pointer, and three things follow:

- The instrument's **maturity is the probe's**, not MF-2046's due date of 2026-12-04.
- **MF-2046's ISIN is `USQ72738QUM6`, and that is correct.** It is derived, not assigned —
  `isinForInvoice(uniquenessHash(debtor, number, face))` — and recomputing it from the stored
  invoice reproduces it exactly, along with its uniqueness hash
  `0xdba9a871e75014b413303f6586081405c733680ff6f5f798524aa8197b5d78ee`. The bond's
  `US0000000010` is the probe's own ISIN. These two values are not in conflict, and **the
  database is not the side to change**: overwriting a derived ISIN would break the invariant
  that ties one to the receivable it describes.
- A proof view for MF-2046 therefore shows a correct ISIN beside a security named for a gas
  probe. Issuing MF-2046 its own bond is the fix; until then this is a known blemish, stated
  rather than papered over.

## Instruments issued by the venue — 2026-09-02

The first bonds deployed by Facture itself rather than by a probe script. Both went through
the ordinary path: the issuance queue picked them up, paced them, and `deployBond` ran with
the invoice's own derived ISIN and a name taken from the seller and the invoice number.

| invoice | security       | EVM address                                  | ISIN           | gas       |
| ------- | -------------- | -------------------------------------------- | -------------- | --------- |
| MF-2051 | `0.0.10331926` | `0xb50567e02baaf768c834b0663f539db43d5b34b0` | `US0P7LQIQII6` | 7,024,576 |
| MF-2052 | `0.0.10331928` | `0x1f2cf9c8f259291cb667cf24956a8e0150c8bc2e` | `USCY30T912O5` | 7,023,179 |

Decoded from MF-2051's own calldata: name `Meridian Fabrication receivable MF-2051`, symbol
`FACF2051`, ISIN `US0P7LQIQII6`, excluded countries `AF,CU,KP,IR,SY`, Reg S. Both gas figures
land inside the 6,956,443–7,310,717 range measured from the factory's history, so the
archaeology in CLAUDE.md holds for calls this service makes as well.

### Why these are the first

Backend issuance had never once succeeded. The `deployBond` tuple was a plausible flattening
of the real one — it compiled, it typechecked, it produced calldata — and encoded to selector
`0x58a038dd`, which the diamond does not have. Every call reverted with
`FunctionNotFound(0x5416eb98)` after 45,540 gas, which reads like a contract fault rather than
a calldata one. The real selector is `0x29002951`, and a test now asserts the encoding matches
it without spending a transaction.

Two failed attempts on the old encoding are on chain and cost 45,540 gas each:
`0.0.10311549@1788339438.757403377` and `0.0.10311549@1788339442.795193807`.

### Two orphan bonds

A round of deployment happened before the record was correct, and its bonds exist with nothing
pointing at them. They are listed because a security with no owner is exactly the kind of thing
that should not be discovered later by accident.

This heading used to say **four**, counting the two wrong-encoding attempts above alongside
these. Those two never deployed anything — they reverted at 45,540 gas — so there is no
instrument to orphan, and only these two exist.

| security       | EVM address                                  | why orphaned                    |
| -------------- | -------------------------------------------- | ------------------------------- |
| `0.0.10331886` | `0x966089c73a03943a4a80fae9e99c5610c3504bef` | recorded under the factory's id |
| `0.0.10331888` | `0x4ffbc298a80319ecfa37bfd31ad6ef0962ea8ece` | recorded under the factory's id |

Both were deployed correctly and are perfectly good instruments; only the id written against
the invoice was wrong, so the invoices were re-issued once that was fixed and these were left
behind. Roughly 16 HBAR of testnet gas.

## Accounts

| role                   | id             | address                                      |
| ---------------------- | -------------- | -------------------------------------------- |
| operator / seller      | `0.0.10311549` | `0x2Da63Ac0F6AE2C3059091d8DF38b3175a237ee71` |
| security admin / buyer | `0.0.10314099` | `0xA25796399A9B3E8006d2d45Ff48a3B830C7f020B` |
| Arc deployer           | —              | `0x46783EeC3ec6e37f39F1EBc915b0b4996233b6A6` |
| Circle agent wallet    | —              | `0x1c755e95cb11e5d5af498bb0ea595b56e1adb035` |

## First settled trade — 2026-09-01

One receivable sold end to end on testnet. Both legs, against each other.

Trade `85c8efbe-9940-4067-97f9-096f0576a377`, hold `7`.

|           |                                                                         |
| --------- | ----------------------------------------------------------------------- |
| invoice   | MF-2046, Petra Foods Group, face $62,300, due 2026-12-04                |
| priced at | 1850 bps, proceeds 5,933,178, discount 296,822                          |
| units     | 6,229,994 — the seller's whole position                                 |
| asset leg | `executeHoldByPartition`, tx `0.0.10311549@1788268822.126538150`        |
| cash leg  | x402 `exact` on `hedera:testnet`, tx `0.0.7162784@1788268815.161410978` |
| payer     | `0.0.10314099`                                                          |

Both transactions read `SUCCESS` on the mirror node. The cash leg moved `0.0.10314099
-5,933,178` and `0.0.10311549 +5,933,178`, with the facilitator `0.0.7162784` as payer, so the
buyer paid the exact quoted proceeds and paid **no gas**. The asset leg's contract call cost
the seller 30,764,363 tinybars, which is the venue's cost rather than the buyer's.

Position afterwards, read from the security: seller `0`, buyer `12,459,995`. The seller sold
out, which is what an all-or-nothing exit means.

## First matured receivable — 2026-09-02

MF-2046 matured and its holder was paid par, on chain. This is the leg the README calls
load-bearing: without it the paper cannot legitimately change hands, because a second buyer
would have no way to be paid.

It ran in two acts, deliberately.

**Maturity created an obligation, not a payment.** `POST /v1/invoices/:id/mature` wrote the
settlement outcome, released the mandate's capital and created a Hedera Scheduled
Transaction paying face value to whoever held the paper. The schedule sat on the ledger
unsigned — one signature, the operator's on the `ScheduleCreate`, which does not satisfy a
transfer debiting a different account. The cash leg reported `pending`, correctly.

**Signing it was the payment.** The collection key signed, the schedule executed, and the
holder was credited.

|                   |                                                              |
| ----------------- | ------------------------------------------------------------ |
| invoice           | MF-2046, face $62,300, holder Harrow Point                   |
| holder account    | `0.0.10314099`                                               |
| schedule          | `0.0.10331573`                                               |
| `ScheduleCreate`  | `0.0.10311549@1788337866.334186498`                          |
| `ScheduleSign`    | `0.0.10331559@1788337932.208192528`                          |
| executed at       | `1788337936.807617267`                                       |
| executed transfer | `0.0.10311549@1788337866.334186498` (`scheduled: true`)      |
| amount            | 6,230,000 tinybars — the face value under the declared scale |

Balances either side of the signature, read from the mirror node:

| account                   | before        | after         | delta      |
| ------------------------- | ------------- | ------------- | ---------- |
| collection `0.0.10331559` | 500,000,000   | 492,283,899   | -7,716,101 |
| holder `0.0.10314099`     | 4,827,974,750 | 4,834,204,750 | +6,230,000 |

The holder received exactly the face value. The collection account paid that plus 1,486,101
tinybars of fees, which is the venue's cost and not the holder's.

### The collection account

| field       | value                                        |
| ----------- | -------------------------------------------- |
| account     | `0.0.10331559`                               |
| EVM address | `0x54027f5e33f9ea9fb4f3ee7e1ce77b1908b7e9bf` |
| key         | ECDSA, in `.env.ops`, gitignored             |
| created by  | `0.0.10311549`, 5 HBAR                       |

It exists because it must not be the operator. A `ScheduleCreateTransaction` executes the
moment its required signatures are present and the operator signs the create, so a payout
drawn on the operator would fire on the spot — reporting the debtor as having paid at the
instant the receivable matured. Keeping the payer separate is what lets the obligation sit
unsigned.

Sign one by hand with `pnpm sign:payout <schedule id> --sign`. The script checks the key
against the account on the ledger before it submits anything, and refuses a schedule that has
already executed.

### Idempotency, tested by accident

Maturity was called **four times** on MF-2046 while the read-back was being built. The
ledger records exactly one `on_time` outcome, the mandate's `allocated_minor` returned to
zero once, Petra Foods Group's on-time count moved from 5 to 6 rather than to 9, and one
schedule exists rather than four. The stored `trades.maturity_schedule_id` is what stops the
second call arranging a second claim on the same face value.

## A clean lifecycle — MF-2051, 2026-09-02

Every earlier proof involved the gas-probe bond somewhere. This one does not: MF-2051 was
issued its own instrument by the venue, sold, and matured, and the ISIN on its proof view is
the one its own bond carries.

| step        |                                                                                |
| ----------- | ------------------------------------------------------------------------------ |
| instrument  | `0.0.10331926`, `Meridian Fabrication receivable MF-2051`, ISIN `US0P7LQIQII6` |
| supply      | 1,225,000 units to the seller, `maxSupply` equal to face                       |
| confirmed   | _"Meridian Fabrication says you owe them $12,250.00, due 30 September."_       |
| quoted      | 850 bps, 28 days, proceeds 1,217,012, discount 7,988 — 0.65% of face           |
| asset leg   | hold `1`, 1,225,000 units, `0.0.10311549@1788340765.589124475`                 |
| cash leg    | x402 `exact`, `0.0.7162784@1788340765.029692827`, payer `0.0.10314099`         |
| maturity    | schedule `0.0.10332092`, executed `0.0.10311549@1788340781.520345720`          |
| holder paid | `0.0.10314099` +1,225,000 tinybars — par                                       |

Trade `3d129208-a99e-4667-bc4a-1d7bc5a537eb`.

### The refusal happened first, and said why

The tightest standing bid was Cordell Credit Partners at 925 bps. Arming the trade returned
**403**, not a reverted transaction:

> Cordell Credit Partners is not permitted to hold this security by its control list.

Cordell is a seeded buyer with no allowlist entry on this instrument. The trade settled only
after a real funded bid existed from a buyer the security actually permits — Harrow Point at
850 bps, which won the auction on price rather than by anything being removed from the book.

**A wrinkle worth naming, and this run is what found it.** The compliance gate ran only when a
trade was armed, so the book could show a price from a bid whose buyer cannot hold that
security. The refusal was correct and legible, and it arrived after the seller had decided to
sell. `3ea7592` moved the check into pricing on the same day: `priceOne` screens the winning
bid and, if it is barred, drops it and looks again, at most three passes. `priceBook` screens
nothing, deliberately — checking per row is the same on-chain read per row this design avoids
everywhere. A book price is indicative; `priceOne` is what a seller acts on. The MF-2052 run
below is that fix working.

### Preparing a security

`deployBond` leaves an instrument with no supply, an empty allowlist and no KYC, and a transfer
against it reverts without naming any of that. `scripts/prepare-security.mjs` —
`pnpm prepare:security <0x-security> <units>` — walks the sequence, reading before each step so a
re-run is free:

```
grantRole × 4      the deployer holds DEFAULT_ADMIN_ROLE and nothing else
addToControlList   seller and buyer — the list is an ALLOW list here
addIssuer          grantKyc reverts with AccountIsNotIssuer until this exists
grantKyc           seller and buyer, five arguments including the issuer
issue              face-value-many units to the seller
```

Role hashes come from `contracts/constants/roles.sol`, never the ATS README:

| role                | hash                                                                 |
| ------------------- | -------------------------------------------------------------------- |
| `ROLE_CONTROL_LIST` | `0x6ed9a91e996c6475ecdc28ecbdbe9bd1122fc62b30cdbe6da8271884b51ec74d` |
| `ROLE_SSI_MANAGER`  | `0x3120494a82251fe85b0403877539486dbfcf0f94c20741a3229cfad31f625ee1` |
| `ROLE_KYC`          | `0x754f499f9fdfbb089d12bdec817a6863d593d8a3ea7f546c00a5cafd20957bfc` |
| `ROLE_ISSUER`       | `0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f` |

All ten transactions succeeded first time. Grants target the operator's **alias**, not its
long-zero address — to a Solidity mapping they are unrelated keys, and the venue calls from the
alias.

## A second clean lifecycle — MF-2052, 2026-09-02

The same path again on the venue's other own-issued instrument, and worth recording separately
because the interesting part happened before the trade did.

MF-2052's bond existed, with supply, allowlist and KYC all empty. The book quoted **nothing**
for it: `mandatesMatching: 0`, `mandatesBarredByInstrument: 3`, `quote: null`. That is the
compliance-aware pricing from `3ea7592` working — three funded bids passed every economic test
and were dropped because the security does not permit their buyers, and the seller was told so
instead of being shown a price nobody could take.

`prepare-security.mjs` ran the ten-step sequence against
`0x1f2cf9c8f259291cb667cf24956a8e0150c8bc2e`, all succeeding first time, and the same quote
became:

|                              | before preparation | after   |
| ---------------------------- | ------------------ | ------- |
| `mandatesConsidered`         | 7                  | 7       |
| `mandatesMatching`           | 0                  | 3       |
| `mandatesBarredByInstrument` | 3                  | 0       |
| quote                        | `null`             | 850 bps |

The four economic refusals — two `RATING_BELOW_MANDATE`, one `DEBTOR_CONCENTRATION`, one
`TENOR_EXCEEDS_MANDATE` — are unchanged either side, which is the point: preparing the
instrument moved exactly the bids the instrument was blocking.

| step        |                                                                        |
| ----------- | ---------------------------------------------------------------------- |
| instrument  | `0.0.10331928`, ISIN `USCY30T912O5`, Petra Foods Group, face $8,900    |
| supply      | 890,000 units to the seller                                            |
| quoted      | 850 bps, 48 days, proceeds 880,051, discount 9,949                     |
| asset leg   | hold `1`, 890,000 units, `0.0.10311549@1788345829.699348346`           |
| cash leg    | x402 `exact`, `0.0.7162784@1788345825.712636474`, payer `0.0.10314099` |
| maturity    | schedule `0.0.10332936`, signed `0.0.10331559@1788345863.327351895`    |
| holder paid | `0.0.10314099` +890,000 tinybars — par                                 |

Trade `6f0654c7-99fc-4f4c-a4fb-d0e7d2626b2e`. Balances either side of the signature: collection
`0.0.10331559` 489,572,390 → 487,187,144 (-2,385,246), holder `0.0.10314099` 4,833,332,687 →
4,834,222,687 (+890,000). The holder received exactly face; the 1,495,246 difference is the
venue's fee, not the holder's.

### The regulation on chain is Reg S, and the row said otherwise

Decoding this bond's own `deployBond` calldata gives `regulationType 1, regulationSubType 0` —
Reg S, as decided. The invoice row said `reg-d-506c`, because the job carried the row's value to
the adapter and the adapter used a venue-wide config value instead. Fixed in `c810389`, and
migration `0003` has since been applied to `packages/backend/data/facture.db`: all 28 invoices
read `reg-s`, the column default matches, and `integrity_check` and `foreign_key_check` are both
clean with every row count unchanged — 28 invoices, 27 trades, 99 quotes, 91 refusal receipts.

It could not be applied by `pnpm db:migrate`, which fails silently on a populated database
because the rebuild's `PRAGMA foreign_keys=OFF` is a no-op inside the transaction drizzle-kit
wraps it in. The working procedure and why the obvious alternatives do not help are recorded at
the top of the migration file.

## Debris on MF-2046

Five settlement attempts were abandoned during debugging on 2026-09-01 before the trade above
succeeded. They are recorded rather than deleted, because a proof view whose job is being
checkable cannot have history quietly removed from underneath it.

**Ten failed trade rows** stand on MF-2046 against the one settled row.

**Three of them paid.** Each is a `SUCCESS` `CRYPTOTRANSFER` of 5,933,178 tinybars from
`0.0.10314099` to `0.0.10311549`, on a trade that then failed:

| trade      | cash transaction                   |
| ---------- | ---------------------------------- |
| `6ea0c378` | `0.0.7162784@1788256564.913218923` |
| `93e3b3dc` | `0.0.7162784@1788256743.999159944` |
| `6e1470e5` | `0.0.7162784@1788256891.347441683` |

So the buyer paid for this receivable four times and received it once, overpaying by
**17,799,534 tinybars**. That is the concrete cost of a paid handler that is not
side-effect-free between verify and settle, and it is why that rule is in CLAUDE.md.

**Five units are locked.** Supply is 12,460,000, the seller's free balance is `0` and the
buyer's is `12,459,995`. The missing five sit in the five abandoned holds — one unit each,
outside both free balances, since an ATS hold moves units out of `balanceOf`.

One trap worth naming: `6e1470e5`'s asset transaction reads `SUCCESS` on chain while its trade
row says `failed`. An earlier version of this file cited that transaction pair as the first
settled trade. It was the attempt before `e0af611`, and its recorded "unitsMinor does not track
face value" gap was fixed by that commit. The settled trade is the one above.

## The vault's units, and a seller who could not be paid — 2026-09-03

Nothing new went on chain. Two things already on chain were being read wrongly, and both sat
directly under the Arc payout leg.

### `MandateVault` was read in the wrong units

`balanceOf` answers in USDC ERC-20 minor units — 6 decimals. A mandate's committed capital is
minor units of its own currency, 2 for USD. The funding check compared them directly.

|                                       | value on chain / in the row | means             |
| ------------------------------------- | --------------------------- | ----------------- |
| `mandates.funded_minor` (`8b879d02…`) | `5000000`                   | **$50,000.00**    |
| vault `balanceOf`                     | `5000000`                   | **5.000000 USDC** |

`5000000 > 5000000` is false, so the deposit was accepted. Identical digits, four orders of
magnitude apart. The mandates screen inherited it and reported the vault as holding
`$50,000.00`.

Read back through the fix, against the live vault:

| mandate                  | committed   | needs     | vault holds | backed             |
| ------------------------ | ----------- | --------- | ----------- | ------------------ |
| Harrow Point `8b879d02…` | $50,000.00  | 0.05 USDC | 5 USDC      | **yes**, 100× over |
| Harrow Point `402cfa47…` | $200,000.00 | 0.2 USDC  | 0           | no                 |
| Ashgrove `8c6bc777…`     | $500,000.00 | 0.5 USDC  | 0           | no                 |

The old comparison agreed on exactly one row, by coincidence. Also read from the vault while
checking: `settlementToken` `0x3600…` (USDC), `paymentEscrow` `0x32e3511A2F…` — the deployed
Arc escrow — and `attester` and `owner` both `0x46783EeC…`, the key in
`ARC_SETTLEMENT_PRIVATE_KEY`. **Nothing needs redeploying for the payout leg.**

### What the payout leg has to work with

Read from the deployed bytecode rather than the source, so these are the bounds that will
actually apply:

| bound                                | value           |                                     |
| ------------------------------------ | --------------- | ----------------------------------- |
| `DvpEscrow.MIN_LOCK_DURATION`        | 900s (15 min)   |                                     |
| `DvpEscrow.MAX_LOCK_DURATION`        | 172,800s (48 h) |                                     |
| `DvpEscrow.MIN_LEG_GAP`              | 3,600s (1 h)    |                                     |
| `MandateVault.PAYMENT_LOCK_DURATION` | 86,400s (24 h)  | inside the band with a day to spare |

USDC on Arc, ERC-20 view, 2026-09-03:

| account                   | USDC       | note                                                   |
| ------------------------- | ---------- | ------------------------------------------------------ |
| attester `0x46783EeC…`    | 213.949511 | topped up since the 93.949 recorded above; gas is fine |
| vault `0x217256d0…`       | 5          | Harrow Point's escrowed mandate                        |
| escrow `0x32e3511A…`      | 0          | nothing locked yet                                     |
| buyer/agent `0x1c755e95…` | 0.996822   |                                                        |
| **seller `0x2Da63Ac0…`**  | **0**      | **can receive; cannot pay gas to claim**               |

The last row is the one with a consequence. Arc gas is USDC, so a seller holding nothing can
be paid into the escrow and then cannot afford the transaction that claims it.

**It matters. `DvpEscrow.claim` requires `msg.sender == beneficiary`** — the venue cannot
submit the claim for a seller even while holding the public preimage, and
`MandateVault.test.ts` asserts exactly that by refusing the attester with `NotBeneficiary`.
So the seller needs an Arc gas top-up before any payout is claimable, and that is a step the
demo includes rather than discovers. `pnpm demo:reset` is what does it.

### The seller's Arc address was invented

`sellers.arc_address` was `0x2Ee0aB7c…`, fabricated exactly as the seeded buyers' were, and
`0004` fixed the buyer side for the reason that was about to apply here: `MandateVault` locks
a payout claimable by the match's seller address alone, so an invented one is a sale that
settles, reports success and pays nobody until `reclaimPayout` returns the money a day later.

It survived because **nothing on the settlement path read it** — the column is written by
`POST /v1/sellers`, rendered, and paid to by nothing.

No new key was needed. `HEDERA_OPERATOR_KEY` derives to
`0x2Da63Ac0F6AE2C3059091d8DF38b3175a237ee71`, which is what `sellers.hedera_account_id`
already held; one ECDSA key controls the same address on every EVM chain.

|                                 | before        | after         |
| ------------------------------- | ------------- | ------------- |
| `sellers.arc_address` (live)    | `0x2Ee0aB7c…` | `0x2Da63Ac0…` |
| `SELLER.hederaAccountId` (seed) | `0.0.5512`    | `0x2Da63Ac0…` |

The seed's `0.0.5512` was a second divergence, found by writing the invariant as a test: the
live row already held the alias, because settlement resolves a seller through
`accountIdToEvmAddress` and a fictional id becomes a long-zero address holding nothing. The
row **had been corrected by hand with no migration recording it**, so a fresh seed produced a
book that could not settle.

Migration `0005_meridian_real_arc_wallet` — a plain UPDATE, applied after a `VACUUM INTO`
backup. Six migrations applied at that point, `integrity_check` ok, `foreign_key_check` clean,
29 invoices and 27 trades intact. The book has traded since: eight migrations applied, 30 invoices
and 33 trades as of 2026-09-04.

## The Arc rail, in the build — 2026-09-03

Nothing new deployed. `MandateVault` and the Arc `DvpEscrow` were reached by nothing until
now; the backend calls both. What follows is what the code does and what the chain is
configured to allow. **The settlement record is below** — MF-2061 took this rail the same day,
so the caveat that stood here, that no live trade had settled on it, is closed.

|                      |                                                                                |
| -------------------- | ------------------------------------------------------------------------------ |
| rail chosen when     | the mandate's vault balance covers the trade AND the seller has an Arc address |
| what runs            | `registerMatch` → `executePayout` → ATS `executeHold`                          |
| what the seller gets | a lock in `DvpEscrow` `0x32e3511A…`, claimable for 24 h                        |
| who may claim        | **the beneficiary only** — `msg.sender == beneficiary`                         |
| the preimage         | published on the proof view; not a credential                                  |

### Two operational facts the demo has to include

**The seller needs Arc gas.** `claim` must be sent by the beneficiary, Arc gas is USDC, and
`0x2Da63Ac0…` holds **0 USDC**. It can be paid and then cannot afford the transaction that
collects. A top-up from the attester (213.95 USDC available) is a prerequisite, not a detail.

**`reclaimPayout` is not wired.** It is the permissionless call that returns a stranded lock's
capital to the mandate, and nothing in the backend makes it. A payout whose delivery failed
sits until an operator calls it by hand. Three comments in the first commit implied this
happened by itself; they are corrected rather than deleted, because the wrong version shipped.

### What the review caught before any of it ran

An adversarial pass over the first Arc-rail commit found a **double-spend**: a failed delivery
left the invoice quotable, the hold expired in three minutes, and a fresh quote drew a second
payout from the same funded mandate — one receivable paid for twice, with no second signature
anywhere, because this rail's premise is that none is needed. Fixed by marking the invoice
sold when the cash commits rather than when the paper moves. Five related defects went with
it; the full list is in CLAUDE.md.

The verification that matters for anyone reading this later: **the x402 rail has the same
hole and cannot reach it.** Every Arc defect was a pre-existing hole made reachable by
removing the buyer's per-trade signature. That is the thing to check first when adding
anything else to this rail.

## Contract source is verified — 2026-09-03

Hedera's Tokenization track asks for a "public GitHub repo with **verified contracts on
HashScan**", and every contract read `match: null` on Sourcify before this. HashScan's badge is
a Sourcify lookup, so publishing the source there is what lights it.

`pnpm --filter @facture/contracts verify` does it, and is safe to re-run — it asks Sourcify
first and sends nothing for a contract already verified.

| contract             | chain   | result      |
| -------------------- | ------- | ----------- |
| `UniquenessRegistry` | 296     | match       |
| `InvoiceRegistry`    | 296     | match       |
| `MandateBook`        | 296     | exact match |
| `DvpEscrow`          | 296     | exact match |
| `AtsComplianceGate`  | 296     | match       |
| `MandateVault`       | 5042002 | exact match |
| `DvpEscrow`          | 5042002 | exact match |

Confirmed in a browser rather than from the API alone: HashScan's contract page for
`0.0.10319485` renders **`UniquenessRegistry` · VERIFIED · Partial Match**. Sourcify's `match`
is HashScan's "partial" and `exact_match` is its "full"; the difference is whether the embedded
metadata hash matches too, and the badge reads verified either way.

**Sourcify indexes Arc testnet as well**, which was not expected — both Arc contracts verified
against chain 5042002.

Two things worth writing down because they cost time:

- **`server-verify.hashscan.io` is retired.** It answers `308` to `https://sourcify.dev/server`
  and drops the path, so every direct query against it returns a bare Express `Cannot GET /`
  that looks like a broken endpoint rather than a redirect. HashScan migrated to the main
  Sourcify instance; verify there.
- **Hardhat 3 prefixes source names with `project/`.** Sourcify matches the contract identifier
  against a key in the standard JSON input exactly, so `contracts/Foo.sol:Foo` matches nothing
  and `project/contracts/Foo.sol:Foo` is the identifier to send.

No `hardhat-verify` plugin was added. A new dependency in this workspace brings an unapproved
build script that breaks `pnpm -r` until `allowBuilds` is edited by hand, and Sourcify's v2 API
takes the solc standard JSON that `artifacts/build-info` already contains.

## The Arc rail has carried a trade — 2026-09-03

**MF-2061.** A receivable sold, paid in USDC on Arc out of capital the buyer escrowed before
the invoice existed, and collected by the seller with their own key. The caveat that stood in
the README and the demo script until today — _no trade has taken the Arc rail_ — is closed.

|            |                                                                                    |
| ---------- | ---------------------------------------------------------------------------------- |
| invoice    | MF-2061, `5b852e40-6789-44d7-8477-2ff761a017f3`, $15,000 face, 45 days             |
| customer   | Calder & Roe, rated **B**                                                          |
| instrument | `0.0.10348484` / `0xf982958c1c89fb402ac3ecf360b791edf3108ca3`, ISIN `USABMT8HS428` |
| issuance   | `0.0.10311549@1788439625.100623187`                                                |
| trade      | `07c9b966-5192-46f4-ae90-b7dab62b11ad`                                             |
| mandate    | `8b879d02…`, Harrow Point, 850 bps — **the escrowed one**                          |
| proceeds   | $14,842.80 → **14,843 USDC minor units** at 1 ppm                                  |

**Why this invoice routed to Arc, by the book's own arithmetic rather than by arrangement.**
The two tighter bids (675 and 800 bps) carry an **A** floor and refuse a B-rated customer; the
only other B-taker quotes 925. So 850 wins on merit, and that mandate is the one with capital
in the vault. Nothing was seeded, re-pointed or hand-edited to make this happen — the earlier
demo invoices route to x402 for the same reason, because their customers are rated A.

### Both legs

| leg   | transaction                                                                |
| ----- | -------------------------------------------------------------------------- |
| cash  | `0x96c5c8625dde0c10b5469aa05cab572ac33c01504f391bae551b285091094318` (Arc) |
| asset | `0.0.10311549@1788439835.810844400` (Hedera), SUCCESS, 445,892 gas         |
| claim | `0x290928b2b5d7d3323cb09954ab63e5fda8e7ea6367122d3a2b939802802841fa` (Arc) |

Read off chain afterwards, not from the receipt:

|                           | before | after        |
| ------------------------- | ------ | ------------ |
| vault, mandate `8b879d02` | 5 USDC | 4.985157     |
| `DvpEscrow` on Arc        | 0      | 0.014843 → 0 |
| seller `0x2Da63Ac0…`      | 0.5    | **0.512972** |

The seller's delta is 0.012972 rather than 0.014843 because **they paid their own gas**, which
is the whole point: `claim` requires `msg.sender == beneficiary`, so the venue could not have
collected for them. `demo:reset` had funded that account earlier the same day, and without it
this last step could not have run at all.

`payoutOf(matchId)` reads `seller 0x2Da63Ac0…, price 14843, executed true`, and the lock's
`tradeRef` equals the match id — the two legs are paired on chain rather than only in this
database. The lock is now `Claimed` and the escrow holds the preimage in the clear, which is
the cross-chain channel working exactly as `IDvpEscrow` describes.

### What this proves, precisely

The paper never left Hedera and the cash never left Arc. Nothing was wrapped and nothing
bridged. The buyer signed nothing for this trade — their mandate had already agreed to
anything meeting its terms, which is what makes a standing bid firm — and the seller signed
exactly once, to collect money already bound to their address.

## The agent paid for a trade itself — 2026-09-03

**`@facture/agent` completed an x402 payment on Hedera.** It read the book, priced it against
its own mandate, armed the trade, signed the cash leg with the buyer's key, and settled. The
Hedera **AI & Agentic Payments** track asks for an agent that completes a real paid request;
this is that request.

|            |                                                                                    |
| ---------- | ---------------------------------------------------------------------------------- |
| invoice    | MF-2052 (the accidental one), `7d9ecd44-2a78-420e-bd9c-8c718caf0fc6`               |
| customer   | Petra Foods Group (the accidental debtor), rated **UNRATED**, $8,900, 47 days      |
| instrument | `0.0.10343726` / `0x9bd731f0f200c9834488bb04fcc03d33415e56bd`, ISIN `USP84OSPO8Q3` |
| trade      | `c0c8ed97-b01d-4c30-b9b2-0ddf7472fa3d`                                             |
| mandate    | `402cfa47…`, Harrow Point, 1850 bps — **the unescrowed one**                       |
| priced at  | proceeds 868,798, discount 21,202                                                  |
| payer      | `0.0.10314099`, the buyer's own Hedera account                                     |

### Why this invoice, and why this rail

Neither was arranged. The customer is **UNRATED**, so five of the seven mandates refuse on
rating. Of the two with an UNRATED floor, `ac66e63d` caps tenor at 45 days and this invoice
matures in 47, so it refuses on tenor. That leaves `402cfa47` alone, at 1850 bps — and
`402cfa47` holds no capital in the Arc vault, so `chooseRail` sends it to x402.

The invoice itself is the bond issued by accident while testing the duplicate check, recorded
above as debris. It had a real instrument, no supply, an empty allowlist and no KYC, which made
it the one row in the book that could carry this proof without anything being invented for it.

### Preparing it, and what that proved on its own

`prepare-security.mjs` ran the ten-step sequence against
`0x9bd731f0f200c9834488bb04fcc03d33415e56bd`, all ten succeeding first time, and issued 890,000
units. `totalSupply` read `0` immediately afterwards and 890,000 moments later, which is the
relay lag recorded in CLAUDE.md behaving exactly as described.

The quote either side of that is the compliance-aware pricing working, and it is worth keeping
because it is a smaller version of the MF-2052 result from 2026-09-02:

|                              | before preparation | after    |
| ---------------------------- | ------------------ | -------- |
| `mandatesConsidered`         | 7                  | 7        |
| `mandatesMatching`           | 0                  | 1        |
| `mandatesBarredByInstrument` | 1                  | 0        |
| quote                        | `null`             | 1850 bps |

Six mandates refuse either side and only the seventh moved, which is the point: preparing the
instrument changed exactly the one bid the instrument was blocking, and no economics with it.

### Both legs

| leg   | transaction                                                           |
| ----- | --------------------------------------------------------------------- |
| cash  | `0.0.7162784@1788449867.590233238` — CRYPTOTRANSFER, SUCCESS          |
| asset | `0.0.10311549@1788449868.676674741` — CONTRACTCALL, SUCCESS, hold `2` |

Read off the mirror node rather than from the receipt. The cash transaction's transfer list is
four entries, and two of them are the trade:

```
0.0.10311549   +868,798      the seller
0.0.10314099   -868,798      the buyer
0.0.7162784    -258,441      the facilitator, paying the fee
0.0.802        +258,441
```

**The buyer paid the quoted proceeds and nothing else.** Its balance went 4,834,222,687 →
4,833,353,889, a difference of exactly 868,798 tinybars, and the entire 258,441 fee was charged
to the facilitator. That is the property `createPartiallySignedTransferTransaction` produces by
setting the transaction id against `extra.feePayer`, and it is now visible on chain rather than
argued from the library.

The asset leg cost 445,892 gas and 49,048,120 tinybars, charged to the venue.

Positions afterwards, read from the security: `totalSupply` 890,000, **seller 0, buyer
890,000**. The seller sold out, which is what an all-or-nothing exit means.

The settled match was committed to HCS topic `0.0.10342152` at **sequence 24**, consensus
`1788449877.017792587`:

```json
{ "v": 1, "kind": "facture.match", "tradeId": "c0c8ed97…", "digest": "4784c4f3…029ba8e4" }
```

### It took three attempts, and the first two are the interesting part

**The agent's venue client timed out at ten seconds while the venue was still working**, and
the trade was armed anyway — trade `fff97c93`, hold `1`, capital allocated, compliance recorded
as allowed. Nothing on the agent's side knew. The second attempt tried to arm the same invoice
and was refused **409**, which was the venue protecting the invoice from being armed twice
rather than a fault; that attempt is on the books as `c705a88d`, failed, with no hold.

`fff97c93` was then unwound by hand, which released hold `1` and returned the capital, and the
third run went through end to end.

Two things came out of it. Arming is two Hedera round trips and takes about fifteen seconds, so
`POST /v1/trades` now has its own timeout defaulting to 60 seconds while reads keep the shorter
one. And an aborted trade request now says the venue may have armed it anyway, because
reporting a timeout as a plain failure sends whoever reads the log looking for a bug instead of
for the armed trade that needs settling.

**So this invoice carries three trade rows: one unwound, one failed, and one settled.** Recorded
rather than tidied away, for the same reason as the MF-2046 debris.

## The first full Arc-rail lifecycle — MF-2070, 2026-09-04

Issued, sold out of the buyer's escrow, and matured. The Arc rail had carried a trade before this
one; this is the first receivable to go all the way on it.

|               |                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------- |
| invoice       | MF-2070, `4ec34f9d-cbac-4727-9cdb-88aaaa36625a`, $12,500 face, 60 days                    |
| instrument    | `0.0.10363143`                                                                            |
| trade         | `72d8448e-5281-4ad8-b311-1d35d4242eb9`, hold `1`                                          |
| mandate       | `8b879d02-4593-4d66-82bf-52d4833401b6` — Harrow Point at 850 bps, the escrowed one        |
| proceeds      | 1,232,534 cents, settled as **12,326 USDC minor**                                         |
| cash, Arc     | `0xd28dfbbb52c137ac25b68c41807df7370cd618b3bc2174b0c17611cce161632b`, payer `0x1c755e95…` |
| asset, Hedera | `0.0.10311549@1788523694.708650693`                                                       |
| escrow lock   | `0x8d423031a260c768c15df1134451e43e85d03e824b00dcb6aef9bbae0449cfc6`                      |
| preimage      | `0xd997a4c4698fa65edb5c90c82305676b35a6ba3f54de0fb81bbdb345eafe8d91`                      |
| HCS match     | topic `0.0.10342152`, sequence **32**                                                     |
| maturity      | schedule `0.0.10363391`, outcome `on_time`                                                |

### It is also the evidence behind the rounding fix

This is the trade where the Arc rail charged 12,326 for proceeds the x402 rail would have charged
12,325 for. The payment leg was calling `usdcRequiredFor`, which rounds **up** because it sizes a
collateral requirement, while `toSettlementAmount` rounds **down** so a payer is never billed money
the invoice does not owe. `units.ts` states that rule, and `arc.ts` says "up, unlike the payment
leg" directly above the function the payment leg was calling.

At a 1 ppm scale an inexact division is the ordinary case rather than an edge, so the two rails
quoted different money for one receivable most of the time. It matters more than a cent suggests:
**`registerMatch` binds the price on chain and is one-shot**, so the wrong figure was permanent per
trade. It survived because the rails-agree test that existed compared `toSettlementAmount` with
itself.

## Two more x402 settlements — MF-2071 and MF-2072, 2026-09-04

|            | MF-2071                                          | MF-2072                                          |
| ---------- | ------------------------------------------------ | ------------------------------------------------ |
| invoice    | `43f68060-0a14-459d-aee8-f73d81bf2df6`           | `5fb64009-2923-47a0-bb73-17374e871348`           |
| instrument | `0.0.10363355`                                   | `0.0.10363420`                                   |
| trade      | `6ba856df-4be0-4296-ab6c-04a82c2c413b`, hold `2` | `04b109ee-be4f-43dc-803a-a4f909064f4f`, hold `2` |
| mandate    | `402cfa47…` at 1850 bps, unescrowed              | the same                                         |
| proceeds   | 759,452 cents, face $8,000                       | 391,890 cents, face $4,000                       |
| cash       | `0.0.7162784@1788524693.933989558`               | `0.0.7162784@1788525051.116962644`               |
| payer      | `0.0.10314099`                                   | `0.0.10314099`                                   |
| asset      | `0.0.10311549@1788524701.373225965`              | `0.0.10311549@1788525052.964567515`              |
| HCS match  | sequence 43                                      | sequence 54                                      |

Each carries an `unwound` trade row before the settled one — `8ae840a2…` and `9fdde9ca…` — which is
the signature of the recorded agent run on MF-2052, where a client timeout armed a trade nothing on
the agent's side knew about.

**Whether these two were agent ticks or hand-driven cannot be told from the ledger**, because the
agent and the operator sign the x402 leg with the same key. They are recorded as x402 settlements
and nothing here claims more.

## The Privy wallet policy — `ptcr8aqgtaya`, 2026-09-06

Created by `pnpm privy:policy` and pinned as `PRIVY_WALLET_POLICY_ID`. It scopes a signed-in
seller's embedded wallet to one call — `claim` on `DvpEscrow` — under three conditions: `to` equals
the escrow, `chain_id` equals 5042002, and the decoded calldata names `claim`. Privy denies by
default, so that is the whole permission the wallet holds.

Confirmed against the live API rather than the docs: four runs produced one policy, because the
idempotency key digests the policy body, and all three conditions read back intact.

The escrow address is read off the deployed vault rather than passed in. The address the policy
names has to be the address the venue settles into, and a second literal is how those come to
disagree.

## The corrected compliance gate — `0x6d78847e…`, 2026-09-06

`AtsComplianceGate` was redeployed because the original was wrong, not because it was old. It
probed `isPaused()`, `isAuthorized(address)` and `getKycAccountStatus(address)`, none of which
exists on a deployed ATS diamond, and therefore refused every buyer on every instrument. CLAUDE.md
carries the full account.

|                |                                                                          |
| -------------- | ------------------------------------------------------------------------ |
| corrected gate | `0x6d78847e4ac257da68909c5a4c60ea1dcc060564`, Sourcify `exact_match`     |
| superseded     | `0x9a2c848ab62e715d2b49a4710f6451395978abbb`, still live, still verified |
| rewired        | `MandateBook.setComplianceGate`, from the owner key                      |

Read against MF-2051 (`0xb50567e02baaf768c834b0663f539db43d5b34b0`) and the buyer at
`0.0.10314099`, whose control list and KYC both say yes:

```
old gate  canReceive(MF-2051, buyer) -> (false, COMPLIANCE_PROBE_FAILED)
new gate  canReceive(MF-2051, buyer) -> (true,  NONE)
```

And against an address nobody allowlisted, which is where the difference is most useful, because
the old gate could not say why it was refusing anyone:

```
old gate  -> (false, COMPLIANCE_PROBE_FAILED)
new gate  -> (false, CONTROL_LIST_BLOCKED)
```

Cross-checked against the raw facets on all five deployed instruments plus the gas-probe bond, and
they agree on every one. A nonexistent address still answers `COMPLIANCE_PROBE_FAILED`, so the
fail-closed property is intact.

The superseded gate stays on the Sourcify list deliberately, for the same reason the superseded
venue table exists above: an address found in an old note should be identifiable rather than
mysterious, and verifying it is what lets a reader see what it did.

## The mandate book carries the venue's bids — 2026-09-06

`MandateBook` (`0x361f9d4b1101898417b2b9148bc8aa522024a38f`) had been deployed since 2026-09-01 and
called by nothing. All seven mandates are now posted and credited, by
`node scripts/post-mandates.mjs --execute`.

| on-chain id | mandate     | buyer                   | terms                     | credited   |
| ----------- | ----------- | ----------------------- | ------------------------- | ---------- |
| 1           | `8c6bc777…` | Ashgrove Treasury       | A / 60d / 800 bps         | 50,000,000 |
| 2           | `5362b32a…` | Cordell Credit Partners | B / 90d / 925 bps         | 25,000,000 |
| 3           | `76b9eb67…` | Ashgrove Treasury       | A / 30d / 675 bps         | 40,000,000 |
| 4           | `3ab6b705…` | Tessellate Capital      | C / 120d / 1250 bps       | 15,000,000 |
| 5           | `ac66e63d…` | Ashgrove Treasury       | UNRATED / 45d / 1600 bps  | 6,000,000  |
| 6           | `402cfa47…` | Harrow Point            | UNRATED / 120d / 1850 bps | 20,000,000 |
| 7           | `8b879d02…` | Harrow Point            | B / 90d / 850 bps         | 3,757,466  |

Amounts are invoice-currency minor units — cents — because the book prices from
`InvoiceRegistry.faceValue`, which issuance lists in cents. Mandate 7 reads 3,757,466 rather than
its original 5,000,000 because maturity retires the Arc-rail commitment.

### What `previewMatch` answers, read live

Asked of every mandate against every invoice with a real instrument. It is not a rubber stamp, and
the pattern it produces is the venue's own:

| invoice                            | tenor | answer                                                                                     |
| ---------------------------------- | ----- | ------------------------------------------------------------------------------------------ |
| MF-2072                            | 39d   | taken by 5 and 6; **`RATING_BELOW_MANDATE`** from the other five, the debtor being UNRATED |
| MF-2071                            | 99d   | taken by 4 and 6; **`TENOR_EXCEEDS_MANDATE`** from the five shorter mandates               |
| MF-2070                            | 59d   | taken by five; refused by the 30-day and 45-day mandates                                   |
| MF-2052                            | 44d   | taken by five; **`RATING_BELOW_MANDATE`** from the two A-floor mandates                    |
| MF-2046, MF-2051, MF-2052 (second) | —     | **`INVOICE_UNKNOWN`** — issued before the registry was wired, so never listed on it        |

**The book and the venue price the same trade one cent apart, by design.** On MF-2072 the book
returns 392,094 and the venue quotes 392,093: the book **floors** the discount and
`@facture/shared` **ceils** it, each deliberately, in opposite parties' favour. So the venue
compares the reason code and publishes both prices, rather than treating a mismatch as a refusal.

## A receivable that has not been sold yet — MF-2080, 2026-09-06

Every other instrument in this document is spent. All eight receivables with a real bond behind
them are `sold` or `matured`, and the five `confirmed` invoices left in the book point at
`0.0.67…` fixtures that were never deployed — so the venue could be shown pricing and refusing,
and could not be shown selling. This one exists to close that gap: it is listed, it is priced, and
nothing has taken it.

|            |                                                                    |
| ---------- | ------------------------------------------------------------------ |
| invoice    | MF-2080, `e04e8e68-3cbd-4407-b4d7-6c2be7f31d4c`, $20,000 face      |
| customer   | Petra Foods Group, rated **B**                                     |
| due        | 2026-10-16, 40 days                                                |
| instrument | `0.0.10391953` / `0xd531fa1c68e445367c171f6d054bfa16ac329490`      |
| ISIN       | `USKOMFRL9QD0`, Reg S                                              |
| supply     | 2,000,000 units, held by the seller                                |
| status     | `listed` — offered, priced, unsold                                 |
| quote      | **$19,813.69 at 850 bps over 40 days**                             |
| matched by | `8b879d02…`, Harrow Point's escrowed mandate, so it settles on Arc |

**The customer was chosen so the funded mandate wins.** A B rating excludes the two mandates with
an `A` floor, which are also the two tightest bids at 800 and 675 bps. What is left is led by
Harrow Point at 850, and that is the one mandate with capital actually posted in the Arc vault — so
a sale here settles out of escrow with no signature, opens a `DvpEscrow` lock the seller can claim
with their own Privy wallet, and can then be matured. It is the only route through the product
that exercises all of it.

Petra Foods rather than Calder & Roe for a duller reason: the funded mandate already carries
$14,842.80 of exposure to Calder & Roe against a $30,000 per-debtor cap, and $0 against Petra
Foods, so the cap does not bind.

### What it cost, and what each step proved

Ten preparation transactions plus the issuance, all first-attempt:

- `deployBond` — one attempt, no retry. The instrument existed about thirty seconds after the
  invoice was created.
- The debtor confirmed **through the link the venue minted**, opened as given. That is the first
  time that has been possible: until the same day, the link pointed at the JSON endpoint and
  `docs/demo.md` told a presenter to rebuild the URL by hand.
- `prepare-security` ran the four role grants, two control-list entries, `addIssuer`, two KYC
  grants and the mint. `totalSupply` and the seller's balance both read `0` immediately after and
  `2,000,000` eight seconds later, which is the relay lag this file already records rather than a
  failure.
- The book then priced it at 850 bps with **`mandatesBarredByInstrument: 0`** and four refusals
  underneath — two on rating, two on debtor concentration, each a sentence.

### The on-chain book was asked, and agreed

`MandateBook.previewMatch` against all seven mandates, the first invoice listed on the registry
since the book was wired:

| mandate | the book                | the venue               |
| ------- | ----------------------- | ----------------------- |
| 1, 3    | `RATING_BELOW_MANDATE`  | `RATING_BELOW_MANDATE`  |
| 5       | `DEBTOR_CONCENTRATION`  | `DEBTOR_CONCENTRATION`  |
| 7       | takes it at **1981370** | takes it at **1981369** |

One minor unit apart, on a receivable neither side had seen before. The book floors the discount
and `@facture/shared` ceils it, each deliberately and in opposite parties' favour, which is why the
venue compares the reason code rather than the number.

**Mandate 4 is where they part company, and it is not a rounding difference.** The venue refuses it
with $5,035.62 left against a $40,000 debtor cap; the book takes it. `_debtorExposure` is written
by `tryMatch`, which is not wired, so the book tests every concentration limit against zero
recorded exposure. Its rating, tenor and registry verdicts are the ones worth reading.
