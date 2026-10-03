import { describe, expect, it } from "vitest";
import { averageTrueRange } from "../src/indicators/atr.js";
import type { PriceBar } from "../src/models.js";

const bar = (high: number, low: number, close: number): PriceBar => ({ date: new Date(0), open: close, high, low, close, volume: 0 });

describe("averageTrueRange", () => {
  it("needs one more bar than the period, for the first previous close", () => {
    expect(averageTrueRange([bar(11, 9, 10), bar(11, 9, 10)], 2)).toBeNull();
    expect(averageTrueRange([bar(11, 9, 10), bar(11, 9, 10), bar(11, 9, 10)], 2)).toBe(2);
  });

  it("widens a day's range to reach a gap from the previous close", () => {
    // Gap up: the day spans 14-15, but the range runs from yesterday's 10.
    expect(averageTrueRange([bar(11, 9, 10), bar(15, 14, 14.5)], 1)).toBe(5);
    // Gap down the same way.
    expect(averageTrueRange([bar(11, 9, 10), bar(7, 6, 6.5)], 1)).toBe(4);
  });

  it("seeds with a plain mean, then smooths Wilder's way", () => {
    // Ranges 2, 4 seed (2+4)/2 = 3; then 6 gives (3*1 + 6)/2 = 4.5.
    const bars = [bar(10, 10, 10), bar(11, 9, 10), bar(12, 8, 10), bar(13, 7, 10)];
    expect(averageTrueRange(bars, 2)).toBe(4.5);
  });
});
