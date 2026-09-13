/**
 * Choosing a starting alert level for a position that has none.
 *
 * The rule: **10% above the current price.**
 *
 * This started as "10% above basis, or the current price, whichever is
 * higher", but every branch collapsed onto the same answer once each case was
 * worked through, and basis dropped out of the level entirely:
 *
 *   - **Well above basis** (a position up 33%): basis+10% is already in the
 *     past and sits far below price, so it would fire instantly and mean
 *     nothing. Price is the only sensible reference.
 *   - **Below basis** (a position down 69%): basis+10% is a demand that the
 *     position roughly triple before you hear anything. Price again.
 *   - **Between the two**: price+10% is above basis+10% whenever price is
 *     above basis, so price wins there as well.
 *
 * So one number, one reference: tell me when this moves 10% up from here.
 * Basis still decides *whether* a position is interesting elsewhere (the
 * above-basis and stagnant alerts in engine.ts) - it just doesn't set this
 * level. Deliberately not volatility-scaled: a flat 10% is the whole rule.
 *
 * A useful side effect: the level is always comfortably clear of the live
 * price, which matters because an alert *at* the live price has no side to
 * fire on and `addAlert` rejects it outright.
 */

/** Fraction above the current price used as the starting target. */
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
    level: round2(currentPrice * (1 + COVER_ABOVE_PRICE)),
    pctFromBasis: blendedBasis > 0 ? ((currentPrice - blendedBasis) / blendedBasis) * 100 : 0,
  };
}
