/**
 * The venue's one settlement conversion.
 *
 * Invoice money is minor units of the invoice's currency (2 for USD and EUR). Every
 * settlement asset has its own exponent — 8 for HBAR, 6 for USDC — and a mandate's capital,
 * a trade's proceeds and a vault's balance are all quoted in one of them. Turning the first
 * into the second is the only place those two scales are allowed to meet.
 *
 * **This lives here rather than beside either rail because it was written beside one of
 * them and the other did not find it.** `x402.ts` derived the conversion carefully, wrote
 * down why, and settled the Hedera cash leg through it. `arc.ts` was written afterwards and
 * compared a mandate's USD cents directly against a USDC balance at 6 decimals — the same
 * digits meaning a different thing by accident, which is the exact failure the x402 comment
 * describes having already fixed once. On the demo mandate the two numbers were identical
 * (5,000,000 cents against 5,000,000 USDC minor units, four orders of magnitude apart) so
 * the check passed and read as correct.
 *
 * A rule that only one caller can find is a rule the next rail will get wrong too. Both
 * import it from here now, and a third rail has one obvious place to look.
 */

/**
 * Converts an invoice amount into a settlement asset's smallest unit.
 *
 * Two conversions, kept separate on purpose because only one of them is arithmetic.
 *
 * The first is a real decimals change: invoice money is minor units of its currency (2 for
 * USD and EUR) and the asset has its own exponent (8 for HBAR, 6 for USDC). That part is
 * exact and stays in `bigint`.
 *
 * The second is a **declared convention, not a market rate**. One unit of invoice currency
 * is settled as one unit of the settlement asset. There is no FX here and none is implied;
 * a real deployment prices the cash leg against an actual rate. `scalePpm` then shrinks the
 * result so a testnet balance can cover it. Both are surfaced in the x402 challenge
 * description so a reader of the proof view sees the convention rather than inferring a
 * rate that was never quoted.
 *
 * Because both rails apply the same `scalePpm`, one invoice settles as the same nominal
 * amount whichever way it goes: $50,000 is 0.05 HBAR on Hedera and 0.05 USDC on Arc. That
 * property is what makes two settlement rails honest rather than two different prices for
 * one receivable, and it is the reason a per-rail scale factor is not offered.
 *
 * ## Rounding has a direction, and it depends on what is being asked
 *
 * Scaling means a sub-unit remainder is always possible, and which way it goes is a
 * decision rather than a detail. **A payment rounds down**, the default: the amount is what
 * a payer is charged, and rounding up bills them for money the invoice does not owe. **A
 * collateral requirement rounds up**: it is the amount capital must reach to count as
 * backing, and rounding down asks for less than the position implies.
 *
 * The difference is not academic at this scale. At 1 ppm the granularity is a whole dollar,
 * so rounding a requirement down means every amount under $1.00 requires zero — and an
 * empty vault backs it. That is the failure the funding check exists to prevent, arriving
 * through the rounding rather than through the comparison.
 *
 * Before this existed the amount was the invoice's minor units passed through unchanged,
 * which silently read as tinybars — the same digits meaning a different thing by accident.
 */
export type SettlementRounding = 'down' | 'up';

export const toSettlementAmount = (
  amountMinor: bigint,
  currencyDecimals: number,
  assetDecimals: number,
  scalePpm: number,
  rounding: SettlementRounding = 'down',
): bigint => {
  /*
   * One division, at the end. Scaling before the decimals shift truncates catastrophically:
   * 5,933,178 minor units scaled by 1 ppm gives 5 before the shift ever runs, so $59,331.78
   * would settle as 0.05 rather than 0.0593 — a rounding error the size of the amount.
   *
   * For every pair this build uses the asset has more decimals than the currency (8 for
   * HBAR, 6 for USDC, against 2 for USD and EUR), so `shift` is positive and this is
   * arithmetically identical to shifting and then scaling. The negative branch is kept
   * correct rather than merely present: dividing once at the end truncates once, where
   * dividing at each step truncates twice.
   */
  const shift = assetDecimals - currencyDecimals;
  const numerator = amountMinor * BigInt(scalePpm) * (shift >= 0 ? 10n ** BigInt(shift) : 1n);
  const denominator = 1_000_000n * (shift < 0 ? 10n ** BigInt(-shift) : 1n);

  const floor = numerator / denominator;
  return rounding === 'up' && numerator % denominator !== 0n ? floor + 1n : floor;
};
