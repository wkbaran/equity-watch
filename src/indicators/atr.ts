/**
 * Average true range: how far a stock typically moves in a day, in dollars,
 * for judging whether a holding's stop sits inside its ordinary noise.
 *
 * A day's true range is its high-to-low span widened to reach the previous
 * close, so an overnight gap counts - a gap is exactly what jumps a stop.
 * Averaged with Wilder's smoothing, the convention charting tools use for
 * ATR(14): a plain mean of the first `period` ranges, then each later range
 * weighted 1/period. Seeded from more history than the period, so the result
 * no longer depends on where the fetch happened to start.
 *
 * Fewer than `period + 1` bars means no ATR (null), never an average of what
 * is there, the same rule as the moving averages.
 */

import type { PriceBar } from "../models.js";

export const ATR_PERIOD = 14;

export function averageTrueRange(bars: PriceBar[], period = ATR_PERIOD): number | null {
  if (bars.length < period + 1) {
    return null;
  }
  const ranges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const { high, low } = bars[i];
    const prevClose = bars[i - 1].close;
    ranges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  let atr = ranges.slice(0, period).reduce((sum, r) => sum + r, 0) / period;
  for (const r of ranges.slice(period)) {
    atr = (atr * (period - 1) + r) / period;
  }
  return atr;
}
