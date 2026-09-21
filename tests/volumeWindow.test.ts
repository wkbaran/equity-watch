import { describe, expect, it } from "vitest";
import { checkAlerts, type MarketData } from "../src/alerts/engine.js";
import type { VolumeAlert, VolumePeriodUnit } from "../src/alerts/models.js";
import { parseVolumePeriod } from "../src/ops/validate.js";
import { MAX_INTRADAY_HISTORY_DAYS } from "../src/indicators/movingAverage.js";

/**
 * Schwab's price history accepts `period` for periodType=day only as 1-5 or
 * 10. Asking for anything else is a 400 on every check, which looks exactly
 * like a quiet market: nothing fires and nothing is reported.
 */
const SCHWAB_DAY_PERIODS = [1, 2, 3, 4, 5, 10];

function volumeAlert(periodValue: number, periodUnit: VolumePeriodUnit): VolumeAlert {
  return {
    id: "v1",
    symbol: "TEST",
    status: "live",
    createdAt: "2026-09-01T00:00:00.000Z",
    livePriceAtCreation: 100,
    triggerCount: 0,
    lastTriggeredAt: null,
    lastTriggerPrice: null,
    mutedUntil: null,
    watchingSince: "2026-09-01T00:00:00.000Z",
    watchingSinceApprox: false,
    priceAtWatchStart: null,
    triggerSnapshot: null,
    kind: "volume",
    volume: { threshold: 1_000_000, mode: "period", periodValue, periodUnit },
  };
}

/** Records every `daysBack` the engine asks for. */
function recordingMarket(asked: number[]): MarketData {
  return {
    getQuotes: async (symbols: string[]) => new Map(symbols.map((s) => [s, { lastPrice: 100, totalVolume: 0 }])),
    getIntradayBars: async (_symbol: string, daysBack: number) => {
      asked.push(daysBack);
      return [];
    },
    getDailyBars: async () => [],
  };
}

describe("the day count a sub-day volume window asks Schwab for", () => {
  it("is always a period Schwab accepts, including the window sizes that used to fail", async () => {
    // 120h is five days: the old code computed ceil(5) + 1 = 6 and clamped
    // only at 10, so it asked for 6 and got a 400 on every single check.
    for (const [value, unit] of [
      [30, "m"],
      [45, "s"],
      [2, "h"],
      [4, "h"],
      [96, "h"],
      [120, "h"],
      [168, "h"],
      [192, "h"],
      [240, "h"],
      [14_400, "m"],
    ] as Array<[number, VolumePeriodUnit]>) {
      const asked: number[] = [];
      await checkAlerts([volumeAlert(value, unit)], recordingMarket(asked), []);
      expect(asked, `${value}${unit}`).toHaveLength(1);
      expect(SCHWAB_DAY_PERIODS, `${value}${unit} asked for ${asked[0]}`).toContain(asked[0]);
    }
  });

  it("still asks for the smallest period that covers a short window", async () => {
    const asked: number[] = [];
    await checkAlerts([volumeAlert(30, "m")], recordingMarket(asked), []);
    // Today plus yesterday: enough for a 30-minute window across a session gap.
    expect(asked[0]).toBe(2);
  });

  it("asks for no minute bars at all for a window given in days", async () => {
    const asked: number[] = [];
    await checkAlerts([volumeAlert(3, "d")], recordingMarket(asked), []);
    expect(asked).toEqual([]);
  });
});

describe("volume window validation", () => {
  it("takes the windows a person actually types", () => {
    for (const raw of ["45s", "30m", "2h", "1d", "5d", "10d", "20d", "96h", "240h"]) {
      expect(parseVolumePeriod(raw).ok, raw).toBe(true);
    }
  });

  it("refuses a sub-day window longer than the minute history that measures it", () => {
    // Snapping the request keeps it legal, but 1-minute bars only go back ten
    // days, so a longer window would report a number quietly short of the
    // truth. Days are measured from daily bars over a date range instead.
    const tooLong = parseVolumePeriod("241h");
    expect(tooLong.ok).toBe(false);
    expect(tooLong.ok === false && tooLong.error).toContain(`only ${MAX_INTRADAY_HISTORY_DAYS} days`);
    expect(tooLong.ok === false && tooLong.error).toContain('"11d"');
    expect(parseVolumePeriod("14401m").ok).toBe(false);
    // The same length expressed in days is fine.
    expect(parseVolumePeriod("11d").ok).toBe(true);
    expect(parseVolumePeriod("60d").ok).toBe(true);
  });

  it("refuses a zero-length window", () => {
    expect(parseVolumePeriod("0m").ok).toBe(false);
    expect(parseVolumePeriod("0d").ok).toBe(false);
  });
});
