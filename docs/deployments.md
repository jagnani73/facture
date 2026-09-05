# Deployed addresses

Testnet only. Recorded 2026-09-01, re-verified against chain 2026-09-02.

Every address, size and transaction below was read back from Hedera rather than copied from a
deploy log. Where the chain and an earlier note disagreed, the chain won.

## Hedera testnet (chain 296)

The live venue, redeployed after the refusal-code rename in `e6edbe6`.

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
- `uniquenessRegistry()` is **not** exposed as a getter and reverts. That address is recorded
  here from deployment rather than read back, and is the one line in this table that on-chain
  state does not confirm.

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

### Four orphan bonds

Two rounds of deployment happened before the record was correct, and their bonds exist with
nothing pointing at them. They are listed because a security with no owner is exactly the kind
of thing that should not be discovered later by accident.

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
| key         | ECDSA, held in `facture-prep`, never in git  |
| created by  | `0.0.10311549`, 5 HBAR                       |

It exists because it must not be the operator. A `ScheduleCreateTransaction` executes the
moment its required signatures are present and the operator signs the create, so a payout
drawn on the operator would fire on the spot — reporting the debtor as having paid at the
instant the receivable matured. Keeping the payer separate is what lets the obligation sit
unsigned.

### Idempotency, tested by accident

Maturity was called **four times** on MF-2046 while the read-back was being built. The
ledger records exactly one `on_time` outcome, the mandate's `allocated_minor` returned to
zero once, Petra Foods Group's on-time count moved from 5 to 6 rather than to 9, and one
schedule exists rather than four. The stored `trades.maturity_schedule_id` is what stops the
second call arranging a second claim on the same face value.

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
settled trade. It was the attempt before `c1bc54f`, and its recorded "unitsMinor does not track
face value" gap was fixed by that commit. The settled trade is the one above.
