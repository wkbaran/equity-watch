/**
 * Choosing a starting alert level for a position that has none.
 *
 * The rule: **10% above the current price or the basis, whichever is higher**
 * (the user's call, 2026-09-16).
 *
 * It was price-only for a while, on the argument that basis+10% fires instantly
 * on a position that has already run and is unreachable on one that has fallen.
 * Taking the higher of the two keeps the first half of that (above basis, price
 * is higher, so price wins and nothing fires instantly) and accepts the second:
 * on a position under water the level now sits at basis+10%, which is a target
 * worth hearing about rather than a 10% bounce off a low.
 *
 * The cost is real on a deep loser: at 69% down, basis+10% is more than triple
 * the price, so the alert is effectively silent. That only matters for a
 * position with no alert at all, which in practice means a fresh buy, where
 * price and basis are close. Watch for it if an old, beaten-down position ever
 * loses its alert.
 *
 * Deliberately not volatility-scaled: a flat 10% is the whole rule. The level
 * is also always clear of the live price - an alert *at* the live price has no
 * side to fire on and `addAlert` rejects it outright.
 */

/** Fraction above the reference (the higher of price and basis) used as the starting target. */
export const COVER_ABOVE_PRICE = 0.1;

export interface CoverLevel {
  level: number;
  /** How far the position currently sits from basis, for reporting only. */
  pctFromBasis: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function coverLevel(blendedBasis: number, currentPrice: number): CoverLevel {
  return {
    level: round2(Math.max(currentPrice, blendedBasis) * (1 + COVER_ABOVE_PRICE)),
    pctFromBasis: blendedBasis > 0 ? ((currentPrice - blendedBasis) / blendedBasis) * 100 : 0,
  };
}
