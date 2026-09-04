# `@facture/shared`

The domain vocabulary every other package speaks. Types, pure maths, state machines and chain
constants — no network, no database, no chain client — so the backend, the web app, the agent and
the contract tooling can all import it without pulling in each other's runtime.

```bash
pnpm --filter @facture/shared build      # tsc -> dist/
pnpm --filter @facture/shared typecheck
pnpm --filter @facture/shared test       # vitest
```

Consumers import from `dist`, so `build` has to run before another package can resolve it.

## What is in here

| Path           | What it holds                                                              |
| -------------- | -------------------------------------------------------------------------- |
| `src/types`    | `Invoice`, `Debtor`, `Mandate`, `Quote`, `Trade`, `Refusal`, money helpers |
| `src/state`    | Transition tables for `InvoiceStatus` and `MandateStatus`                  |
| `src/pricing`  | The curve: `tenorDays`, `priceInvoice`, `impliedYieldBps`, `bestQuote`     |
| `src/isin`     | Checksum-valid ISINs for `deployBond`                                      |
| `src/registry` | `uniquenessHash` — one receivable, one instrument, ever                    |
| `src/chains`   | Arc, Hedera, x402 and ATS constants                                        |

Subpath exports mirror the directories (`@facture/shared/pricing`, `/state`, `/isin`, `/registry`,
`/chains`, `/types`), and the root barrel re-exports everything.

## The four decisions worth knowing before you use it

### 1. Money is `bigint` minor units, and the discount rounds up

```ts
discount = ceil(faceValue × yieldBps × tenorDays / (10_000 × 365))
proceeds = faceValue − discount
```

Simple discount, actual/365, no compounding — money-market convention for paper under a year, which
is what an invoice is. The whole calculation is one exact rational: multiply first, divide once, no
intermediate float anywhere on the money path.

The single division **rounds up, in the buyer's favour**, so the realised yield is never below the
yield the mandate published. A mandate is a standing commitment to buy at a stated price, and a
venue that occasionally paid a hundredth of a basis point less than advertised would be making that
bid soft. At most one minor unit moves, it always moves the same way, and the seller sees the exact
proceeds before confirming.

`impliedYieldBps` rounds the other way, **down**, which makes the round trip exact:
`impliedYieldBps(face, priceInvoice(face, y, t).proceeds, t) === y` for any invoice where
`faceValue × tenorDays ≥ 3_650_000` — i.e. anything above a hundred-dollar invoice with a day to
run. Rounding both directions the same way would drift a basis point on every re-quote of seasoned
paper.

```ts
priceInvoice(4_000_000n, 1250, 60);
// { discount: 82_192n, proceeds: 3_917_808n }  →  $821.92 off $40,000.00, seller gets $39,178.08
```

Tenor is UTC calendar days, so a quote does not change between 09:00 and 23:00 on the same day, and
past-due clamps to zero rather than pricing an overdue invoice above its face.

### 2. Refusals explain themselves

Eligibility is checked _before_ matching, so an ineligible counterparty is never matched and the
refusal is a first-class output rather than a reverted transaction. `bestQuote` returns the best
price **and** a `RefusalReceipt` for every mandate that did not match:

```ts
const { quote, mandate, refusals, matches } = bestQuote(invoice, book, debtor);

refusals[0].humanReason;
// 'The customer is rated C, and this mandate takes A or better.'
```

Each refusal code is a discriminated union member carrying the _operands of the comparison that
failed_, so the sentence can name both sides. `mandateId` is `null` when the refusal is about the
invoice itself — an unconfirmed invoice is refused once, not once per bid on the book. `hcsMessageId`
is filled in after the receipt is published to HCS.

Best means **lowest yield**, which is the smallest discount and the most money for the seller. Ties
break on unallocated depth, then on mandate id so the same invoice never shows two different
counterparties on two refreshes.

Capacity is tested against the **proceeds**, not the face value: the mandate pays the discounted
price today and is repaid face at maturity, so the cash it needs on hand is the proceeds.

### 3. State machines return a `Result`, never throw

```ts
invoiceMachine.transition('sold', 'listed');
// { ok: true, value: 'listed' }        ← the secondary market

invoiceMachine.transition('draft', 'sold');
// { ok: false, error: { code: 'ILLEGAL_TRANSITION', allowed: ['awaiting_confirmation'], reason: … } }
```

Both tables are written out completely, and every edge is justified in a comment next to it. The
ones that carry an argument:

- `sold -> listed` — a holder relisting seasoned paper. Without this edge there is one market, not
  two, and the claim that the secondary leg tightens the primary quote does not hold.
- `awaiting_confirmation -> draft` but not `confirmed -> draft` — the seller can fix a typo while the
  debtor has not answered; editing an acknowledged amount would silently void the acknowledgement.
- No `sold -> confirmed` — un-selling is an unwind of two settlement legs on two chains, not a status
  write.
- `matured` and `defaulted` are terminal; a mandate's `withdrawn` is terminal. Reopening a mandate is
  a new mandate with a new id, because the old one's bid was published to the book.

The tables carry no guards that need a clock, a database or a chain — those belong at the call site.
`confirmed -> listed` is legal in the table even though the caller must also check the instrument
exists, because issuance is paced and an invoice sits confirmed-but-not-yet-issued for minutes.

### 4. The uniqueness hash is aggressively canonicalised

```
keccak256("facture/uniqueness/v1|8:debtor-9|7:inv-001|7:4000000")
```

A mismatch here is a double-pledge hole, so normalisation errs towards _catching_ duplicates:

- NFKC, then **all** Unicode whitespace stripped from the invoice number, then case-folded. An
  attacker re-listing a paid-out invoice reaches for one extra space, and no honest debtor issues
  two invoices whose numbers differ only by whitespace.
- Separators are **kept** — `INV-001` and `INV001` stay distinct, because a false collision refuses
  an honest invoice with no way for the seller to fix it.
- Debtor ids are trimmed and lower-cased, which also makes a checksummed EVM address match its
  lower-case form.
- Fields are **length-prefixed in UTF-8 bytes**, so no two field splits can collide — under a naive
  join, `('ab', 'c')` and `('a', 'bc')` would hash the same.

The domain string is versioned. Changing any rule above changes the hash of every existing invoice,
so it needs a new version and a migration, never an edit in place.

## ISINs

ATS rejects any `deployBond` whose ISIN fails `onlyValidISIN`, so every invoice needs one. These are
**synthetic**: no National Numbering Agency allocated them, and they must not be shown to a user as
registered security identifiers.

```ts
isinForInvoice(invoice.uniquenessHash); // 'USF93WE56JW0' — stable for the life of the invoice
```

The NSIN is derived from the uniqueness hash, so a retried or replayed issuance always produces the
same identifier — an ISIN that drifted between attempts would let one receivable acquire two
instruments. The check digit is Luhn over the letter-expanded body, and it is tested against
nineteen real ISINs (Apple, BAE, Nestlé, Tencent…) rather than against a restatement of the same
algorithm.

## Chain constants

No chain id, RPC URL, token address or regulation number should appear as a literal anywhere else in
the monorepo. Two decimal traps are documented at their definitions, because both fail silently by a
factor of 10^10 or more:

- **Arc USDC** — gas accounting is 18 decimals, the ERC-20 interface is 6, same underlying balance.
  All balance and transfer logic uses the ERC-20 interface.
- **Hedera HBAR** — the native ledger uses 8 (tinybars), the JSON-RPC relay reports 18.

Also recorded next to the config that needs them: `maxFeePerGas` on Arc must be at least 20 gwei;
HTS tokens need explicit association by the receiver; ECDSA keys are required for anything EVM on
Hedera; and `extra.feePayer` for x402 must be fetched at runtime from `GET /supported`, never
hardcoded.

## Tests

`vitest run` — 167 tests over the parts where a silent bug is expensive: the curve maths (including
the worked example and a case where `Number` loses a minor unit), the ISIN checksum, every ordered
pair of both state machines, and the uniqueness canonicalisation.
