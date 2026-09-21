/**
 * The one rounding used for prices, levels and percentages.
 *
 * `Math.round(n * f) / f`, not `Number(n.toFixed(places))`: the two disagree on
 * binary-representation edges — `(1.005).toFixed(2)` is "1.00" while this gives
 * 1.01 — and rounding is load-bearing here. `holdings cover` must round a level
 * *before* comparing it against a live price, because `100 * 1.1` is
 * 110.00000000000001, which beats a price of 110 raw but rounds back onto it,
 * producing an alert at exactly the live price that has no side to fire on.
 * Two algorithms in a codebase where that matters is a trap, so there is one.
 */
export function round(n: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}
