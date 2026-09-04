// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/**
 * @title FactureTypes
 * @notice File-level enums shared by the venue contracts and their interfaces.
 * @dev These live in one file rather than on each interface so that `MandateBook`, `IInvoiceRegistry`
 *      and any off-chain ABI consumer agree on the integer encoding. Changing the *order* of any enum
 *      below is a breaking change for already-deployed contracts and for every stored `Mandate` and
 *      `Invoice` record, because enums are stored as their ordinal. Append only.
 */

/**
 * @notice Credit quality of the *debtor* (the business that owes the money), not of the seller.
 *
 * @dev Ordering is load-bearing and deliberate. Mandate matching tests `invoiceRating >= minRating`,
 *      so the ordinals must ascend with credit quality. These ordinals are the on-chain mirror of
 *      `RATING_RANK` in `@facture/shared` (`packages/shared/src/types/rating.ts`), which ranks
 *      `A:4, B:3, C:2, UNRATED:1, D:0`. The two must not drift: the off-chain quote engine decides
 *      what a seller is shown and this enum decides what actually matches, so a disagreement between
 *      them is a venue that quotes paper it will then refuse.
 *
 *      Three properties follow from `D == 0` sitting *below* `Unrated == 1`:
 *
 *      1. A default is information; an absence of history is not. A debtor who has failed to pay is
 *         strictly worse than one nobody has traded with yet, so `D` must not be reachable by a
 *         floor that is merely willing to accept a cold start. A mandate written at floor `Unrated`
 *         reads as "I will price the unknown", not as "I will buy paper on a known defaulter".
 *      2. A debtor with no payment history is still near the wide end of the curve and is excluded
 *         by any mandate that sets a floor above it. This is the on-chain half of the "ratings are
 *         earned, not assigned" rule: a rating is manufactured out of settled payment behaviour, so
 *         absence of history prices as risk rather than as a neutral default.
 *      3. A zero-initialised storage slot decodes to `D`, the worst bucket. An uninitialised or
 *         partially written invoice record therefore cannot accidentally present as investment
 *         grade — it presents as the one rating that every floor a buyer realistically writes
 *         rejects. Failure of the listing path degrades toward refusal, not toward a mispriced
 *         match.
 *
 *      There is intentionally no external rating source. No feed exists for SME debtor credit, so
 *      the venue either manufactures its own record or prices blind.
 */
enum Rating {
    D, // 0 - defaulted; matured unpaid on the venue. Permanent, and below Unrated by design.
    Unrated, // 1 - no settled payment history on the venue yet
    C, // 2 - thin history, or has paid late materially
    B, // 3 - clean history, moderate volume
    A // 4 - consistent on-time settlement
}

/**
 * @notice Lifecycle of a standing bid.
 * @dev `Active` is *not* the zero value. A mandate id that was never posted reads back as
 *      `Uninitialised`, which every matching path rejects, so an unknown id cannot be matched
 *      against as though it were a live bid with a zero balance.
 */
enum MandateStatus {
    Uninitialised, // 0 - no such mandate
    Active, // 1 - accepting matches up to its unallocated balance
    Paused, // 2 - buyer has stopped new matches; existing allocations stand
    Closed // 3 - terminal; no new matches, withdrawal of unallocated capital still permitted
}

/**
 * @notice Lifecycle of a listed receivable.
 * @dev `Confirmed` is the only status a mandate may match against. The transition into it is the
 *      debtor acknowledging their own accounts payable off-chain; that acknowledgement is what
 *      removes dispute risk and is therefore what makes a full advance (no holdback) coherent.
 */
enum InvoiceStatus {
    Unknown, // 0 - not listed
    Draft, // 1 - listed, debtor has not confirmed
    Confirmed, // 2 - debtor acknowledged amount and due date; quotable and matchable
    Matched, // 3 - allocated to a mandate, awaiting settlement
    Settled, // 4 - DvP completed; the buyer holds the instrument
    Repaid, // 5 - debtor paid at maturity; proceeds routed to the holder of record
    Defaulted, // 6 - matured unpaid; buyer takes the loss, debtor rating is marked
    Cancelled // 7 - withdrawn before matching
}

/**
 * @notice Lifecycle of a single mandate-to-invoice allocation.
 * @dev An `Open` match holds capital that is neither withdrawable nor spendable by any other match.
 *      It must resolve to `Settled` or `Cancelled`; there is no path that leaks the allocation.
 */
enum MatchStatus {
    Uninitialised, // 0 - no such match
    Open, // 1 - capital allocated, cross-chain settlement in flight
    Settled, // 2 - price paid out, allocation consumed
    Cancelled // 3 - settlement failed or timed out, allocation returned to unallocated
}
