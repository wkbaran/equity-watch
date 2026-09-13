import { describe, expect, it } from "vitest";
import type { PriceBar } from "../src/models.js";
import {
  aggregateBars,
  bucketKey,
  dailyLookbackDays,
  ema,
  intradaySessionsNeeded,
  levelAt,
  maLabel,
  parseMaSpec,
  schwabIntradayPeriod,
  sma,
} from "../src/indicators/movingAverage.js";

/** A daily bar stamped the way Schwab stamps them: exchange midnight, i.e. early morning UTC. */
function daily(day: string, close: number, extra: Partial<PriceBar> = {}): PriceBar {
  return { date: new Date(`${day}T05:00:00Z`), open: close, high: close, low: close, close, volume: 100, ...extra };
}

/** A 1-minute bar at an ISO UTC instant. */
function minute(iso: string, close: number): PriceBar {
  return { date: new Date(iso), open: close, high: close + 1, low: close - 1, close, volume: 10 };
}

describe("sma", () => {
  it("is null until a full window exists, then the mean of the last `period` values", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it("never averages a short window, and rejects a non-positive period", () => {
    expect(sma([10, 20], 3)).toEqual([null, null]);
    expect(() => sma([1], 0)).toThrow();
  });
});

describe("ema", () => {
  it("seeds with the SMA of the first period, then smooths with 2/(period+1)", () => {
    // Seed avg(2,4,6)=4; k=0.5: 8*.5+4*.5=6; 20*.5+6*.5=13.
    expect(ema([2, 4, 6, 8, 20], 3)).toEqual([null, null, 4, 6, 13]);
  });

  it("weights the latest value more than an SMA does", () => {
    expect(ema([2, 4, 6, 8, 20], 3)[4]!).toBeGreaterThan(sma([2, 4, 6, 8, 20], 3)[4]!);
  });

  it("is all null with fewer values than the period", () => {
    expect(ema([1, 2], 9)).toEqual([null, null]);
  });
});

describe("bucketKey", () => {
  // 13:37 UTC in September is 09:37 Eastern.
  const at = new Date("2026-09-11T13:37:00Z");

  it("aligns intraday bars to the exchange clock", () => {
    expect(bucketKey(at, "1m")).toBe("2026-09-11T0577");
    expect(bucketKey(at, "2m")).toBe("2026-09-11T0576");
    expect(bucketKey(at, "5m")).toBe("2026-09-11T0575");
    expect(bucketKey(at, "15m")).toBe("2026-09-11T0570");
  });

  it("uses the exchange date for daily and the Monday of the week for weekly", () => {
    // 23:30 Eastern Friday is Saturday in UTC; still Friday's day and week.
    const lateFriday = new Date("2026-09-12T03:30:00Z");
    expect(bucketKey(lateFriday, "1D")).toBe("2026-09-11");
    expect(bucketKey(lateFriday, "1W")).toBe("2026-09-07");
  });
});

describe("aggregateBars", () => {
  it("builds 5-minute bars from 1-minute bars", () => {
    // 09:30-09:39 Eastern, closes 1..10.
    const bars = Array.from({ length: 10 }, (_, i) => minute(`2026-09-11T13:${30 + i}:00Z`, i + 1));
    const five = aggregateBars(bars, "5m").map((b) => b.bar);
    expect(five).toHaveLength(2);
    expect(five[0]).toMatchObject({ open: 1, high: 6, low: 0, close: 5, volume: 50 });
    expect(five[1]).toMatchObject({ open: 6, high: 11, low: 5, close: 10, volume: 50 });
  });

  it("keeps a holiday-shortened week as one weekly bar", () => {
    // 2026-09-07 is Labor Day.
    const bars = [daily("2026-09-04", 1), daily("2026-09-08", 2), daily("2026-09-11", 3), daily("2026-09-14", 4)];
    expect(aggregateBars(bars, "1W").map((b) => b.bar.close)).toEqual([1, 3, 4]);
  });

  it("does not mutate its input", () => {
    const bars = [daily("2026-09-08", 1), daily("2026-09-09", 2)];
    aggregateBars(bars, "1W");
    expect(bars[0].close).toBe(1);
  });
});

describe("levelAt", () => {
  it("uses only bars completed before the instant's own bar (daily)", () => {
    const bars = [daily("2026-09-08", 10), daily("2026-09-09", 20), daily("2026-09-10", 30), daily("2026-09-11", 40)];
    const level = levelAt(bars, { maType: "sma", period: 2, timeframe: "1D" });
    // Mid-session on the 11th: the 11th's own bar is still forming.
    expect(level(new Date("2026-09-11T18:00:00Z"))).toBe(25);
    expect(level(new Date("2026-09-12T14:00:00Z"))).toBe(35);
    // Not enough completed bars yet.
    expect(level(new Date("2026-09-09T18:00:00Z"))).toBeNull();
  });

  it("steps once per intraday bar", () => {
    const bars = Array.from({ length: 10 }, (_, i) => minute(`2026-09-11T13:${30 + i}:00Z`, i + 1));
    const level = levelAt(bars, { maType: "sma", period: 2, timeframe: "5m" });
    expect(level(new Date("2026-09-11T13:41:00Z"))).toBe(7.5);
    expect(level(new Date("2026-09-11T13:37:00Z"))).toBeNull();
  });
});

describe("parseMaSpec", () => {
  it("parses type, period, and timeframe", () => {
    expect(parseMaSpec("sma200@1W")).toEqual({ maType: "sma", period: 200, timeframe: "1W" });
    expect(parseMaSpec("EMA9@5m")).toEqual({ maType: "ema", period: 9, timeframe: "5m" });
    expect(parseMaSpec("sma20@1d")).toEqual({ maType: "sma", period: 20, timeframe: "1D" });
  });

  it("rejects unknown types, timeframes, and out-of-range periods", () => {
    expect(() => parseMaSpec("wma9@1D")).toThrow(/Invalid moving average/);
    expect(() => parseMaSpec("sma9@3m")).toThrow(/Invalid moving average/);
    expect(() => parseMaSpec("sma0@1D")).toThrow(/between 1 and 200/);
    expect(() => parseMaSpec("sma201@1D")).toThrow(/between 1 and 200/);
  });
});

describe("maLabel", () => {
  it("reads naturally for each timeframe", () => {
    expect(maLabel({ maType: "sma", period: 200, timeframe: "1W" })).toBe("200-week SMA");
    expect(maLabel({ maType: "ema", period: 9, timeframe: "1D" })).toBe("9-day EMA");
    expect(maLabel({ maType: "ema", period: 9, timeframe: "5m" })).toBe("9-bar EMA on 5-minute bars");
  });
});

describe("history windows", () => {
  it("gives EMAs four periods of warm-up", () => {
    expect(dailyLookbackDays({ maType: "sma", period: 200, timeframe: "1W" })).toBe(200 * 7 + 21);
    expect(dailyLookbackDays({ maType: "ema", period: 200, timeframe: "1W" })).toBe(800 * 7 + 21);
  });

  it("sizes intraday fetches in sessions and snaps to periods Schwab accepts", () => {
    // 200 x 15 min = 3000 min = 7.7 regular sessions.
    expect(intradaySessionsNeeded({ maType: "sma", period: 200, timeframe: "15m" })).toBe(9);
    expect(schwabIntradayPeriod(9)).toBe(10);
    expect(schwabIntradayPeriod(3)).toBe(3);
    expect(schwabIntradayPeriod(40)).toBe(10);
  });
});
