import { describe, expect, it } from "vitest";
import { checkAlerts, type MarketData } from "../src/alerts/engine.js";
import type { StaticAlert, TrailingAlert } from "../src/alerts/models.js";
import {
  barsMayExist,
  crossingOf,
  dayRangeCovers,
  pricePath,
  quotePoint,
  rangeReaches,
  trailStep,
  type PricePoint,
} from "../src/alerts/pricePath.js";
import type { PriceBar } from "../src/models.js";
import type { Quote } from "../src/providers/schwab.js";

// Thursday 2026-10-01, 11:00 Eastern.
const NOW = new Date("2026-10-01T15:00:00.000Z");
const minutesBefore = (m: number) => new Date(NOW.getTime() - m * 60_000);

function bar(minutesAgo: number, open: number, high: number, low: number, close: number): PriceBar {
  return { date: minutesBefore(minutesAgo), open, high, low, close, volume: 1000 };
}

const base = {
  symbol: "ADC",
  status: "live" as const,
  createdAt: "2026-09-01T00:00:00.000Z",
  livePriceAtCreation: 70,
  triggerCount: 0,
  lastTriggeredAt: null,
  lastTriggerPrice: null,
  mutedUntil: null,
  watchingSince: "2026-09-01T00:00:00.000Z",
  watchingSinceApprox: false,
  priceAtWatchStart: null,
  triggerSnapshot: null,
};

function trailing(overrides: Partial<TrailingAlert> = {}): TrailingAlert {
  return {
    ...base,
    id: "t1",
    kind: "trailing",
    side: "below",
    near: 70,
    trailType: "percent",
    trailValue: 5,
    extremePrice: 70,
    extremeAt: "2026-09-01T00:00:00.000Z",
    lastEvaluatedAt: minutesBefore(15).toISOString(),
    ...overrides,
  };
}

function staticAlert(overrides: Partial<StaticAlert> = {}): StaticAlert {
  return {
    ...base,
    id: "s1",
    kind: "static",
    side: "above",
    direction: "up",
    level: 72,
    lastKnownSide: "below",
    lastEvaluatedAt: minutesBefore(15).toISOString(),
    ...overrides,
  };
}

function market(price: number, bars: PriceBar[], range?: { low: number; high: number }) {
  const calls: number[] = [];
  const m: MarketData = {
    getQuotes: async (symbols) => {
      const quote: Quote = { lastPrice: price, totalVolume: 0, ...(range ? { dayLow: range.low, dayHigh: range.high } : {}) };
      return new Map(symbols.map((s) => [s, quote]));
    },
    getIntradayBars: async (_symbol, days) => {
      calls.push(days);
      return bars;
    },
    getDailyBars: async () => [],
  };
  return { m, calls };
}

const check = (alerts: (StaticAlert | TrailingAlert)[], m: MarketData, session: "regular" | "post" | "closed" | null = "regular") =>
  checkAlerts(alerts, m, [], session, new Set(), async () => null, async () => [], { now: NOW });

const at = (price: number): PricePoint => ({ at: NOW, price, fromBar: true });

describe("crossingOf", () => {
  it("is the side a close is on, when it differs", () => {
    expect(crossingOf("below", 72, at(72.5))).toBe("above");
    expect(crossingOf("below", 72, at(71.5))).toBeNull();
  });

  it("treats a price on the level as below, as the snapshot always has", () => {
    expect(crossingOf("below", 72, at(72))).toBeNull();
    expect(crossingOf("above", 72, at(72))).toBe("below");
  });
});

describe("trailStep", () => {
  const alert = trailing();

  it("follows the lowest close and never fires on the close that set it", () => {
    expect(trailStep(alert, 70, at(66))).toEqual({ fire: false, extreme: 66 });
  });

  it("fires on a close 5% above the low", () => {
    expect(trailStep(alert, 66, at(69.3))).toEqual({ fire: true, extreme: 66 });
    expect(trailStep(alert, 66, at(69.29))).toEqual({ fire: false, extreme: 66 });
  });

  it("mirrors for a fall off the high", () => {
    const down = trailing({ side: "above", extremePrice: 100 });
    expect(trailStep(down, 100, at(101))).toEqual({ fire: false, extreme: 101 });
    expect(trailStep(down, 100, at(95))).toEqual({ fire: true, extreme: 100 });
  });
});

describe("pricePath", () => {
  const quote: Quote = { lastPrice: 71, totalVolume: 0 };

  it("replays only completed bars from the watermark, and stops the watermark at the last one", () => {
    const bars = [bar(16, 70, 70, 70, 70), bar(15, 70, 71, 70, 71), bar(2, 71, 71, 71, 71), bar(0.5, 71, 72, 71, 72)];
    const { points, through } = pricePath(trailing(), bars, quote, NOW);
    expect(points.map((p) => p.at)).toEqual([minutesBefore(15), minutesBefore(2)]);
    expect(through).toEqual(minutesBefore(1));
  });

  it("uses the live quote, and moves the watermark to now, when there are no new bars", () => {
    const { points, through } = pricePath(trailing(), [], quote, NOW);
    expect(points).toEqual([quotePoint(71, NOW)]);
    expect(through).toEqual(NOW);
  });

  it("starts an alert with no watermark from the live quote", () => {
    const { points } = pricePath(trailing({ lastEvaluatedAt: undefined }), [bar(5, 1, 1, 1, 1)], quote, NOW);
    expect(points).toEqual([quotePoint(71, NOW)]);
  });
});

describe("dayRangeCovers", () => {
  it("covers a gap inside today's trading date", () => {
    expect(dayRangeCovers(minutesBefore(90), NOW)).toBe(true);
  });

  it("covers the gap from after yesterday's close, and from Friday's close over a weekend", () => {
    expect(dayRangeCovers(new Date("2026-09-30T21:00:00.000Z"), NOW)).toBe(true);
    expect(dayRangeCovers(new Date("2026-09-25T21:00:00.000Z"), new Date("2026-09-28T15:00:00.000Z"))).toBe(true);
  });

  it("does not cover a gap that started before a close, or skipped a weekday", () => {
    expect(dayRangeCovers(new Date("2026-09-30T18:00:00.000Z"), NOW)).toBe(false);
    expect(dayRangeCovers(new Date("2026-09-29T21:00:00.000Z"), NOW)).toBe(false);
  });
});

describe("barsMayExist", () => {
  // Thursday 2026-10-01 21:00 Eastern.
  const evening = new Date("2026-10-02T01:00:00.000Z");

  it("during the regular session, always", () => {
    expect(barsMayExist(minutesBefore(15), NOW, "regular")).toBe(true);
  });

  it("outside it, only for a watermark from before the last close", () => {
    expect(barsMayExist(new Date("2026-10-01T19:50:00.000Z"), evening, "post")).toBe(true);
    expect(barsMayExist(new Date("2026-10-02T00:45:00.000Z"), evening, "post")).toBe(false);
    // Saturday morning: the last close is Friday's.
    expect(barsMayExist(new Date("2026-10-02T21:30:00.000Z"), new Date("2026-10-03T14:00:00.000Z"), "closed")).toBe(false);
  });

  it("goes by the clock when the session isn't known", () => {
    expect(barsMayExist(minutesBefore(15), NOW, null)).toBe(true);
    expect(barsMayExist(new Date("2026-10-02T00:45:00.000Z"), evening, null)).toBe(false);
  });
});

describe("rangeReaches", () => {
  it("asks whether the day touched the level, the low, or the trigger", () => {
    expect(rangeReaches(staticAlert(), 70, 71.9)).toBe(false);
    expect(rangeReaches(staticAlert(), 70, 72)).toBe(true);
    expect(rangeReaches(trailing(), 70, 73)).toBe(false);
    expect(rangeReaches(trailing(), 69.9, 73)).toBe(true);
    expect(rangeReaches(trailing(), 70, 73.5)).toBe(true);
  });
});

describe("checkAlerts over minute bars", () => {
  it("follows the low through the bars and fires on the rise the snapshot would miss", async () => {
    const alert = trailing();
    // Closes down to 67.5, back up through 70.875 (67.5 * 1.05) at 10:50, down to 69 by the check.
    const bars = [bar(14, 70, 70, 67, 67.5), bar(12, 67.5, 68, 67.2, 68), bar(10, 68, 71, 68, 70.9), bar(5, 70.9, 70.9, 69, 69)];
    const { m } = market(69, bars, { low: 67, high: 71 });
    const result = await check([alert], m);

    expect(result.revisits).toHaveLength(1);
    expect(result.revisits[0].triggerPrice).toBe(70.9);
    expect(result.revisits[0].triggeredAt).toBe(minutesBefore(10).toISOString());
    expect(result.revisits[0].session).toBe("regular");
    // Restarted from the firing close, then followed the next close down.
    expect(alert.extremePrice).toBe(69);
    expect(alert.lastEvaluatedAt).toBe(minutesBefore(4).toISOString());
  });

  it("ignores a wick: a low under the trailing low, or a high past the trigger, with closes that don't follow", async () => {
    const alert = trailing();
    const bars = [bar(10, 70, 74, 60, 70.2)];
    const result = await check([alert], market(70.2, bars, { low: 60, high: 74 }).m);
    expect(result.revisits).toEqual([]);
    expect(alert.extremePrice).toBe(70);
  });

  it("doesn't count a wick through a static level as a cross", async () => {
    const alert = staticAlert();
    const result = await check([alert], market(71.5, [bar(10, 71, 73, 71, 71.5)], { low: 71, high: 73 }).m);
    expect(result.revisits).toEqual([]);
    expect(alert.lastKnownSide).toBe("below");
  });

  it("fires a static level crossed and crossed back between checks, and folds the crossing back", async () => {
    const alert = staticAlert();
    const bars = [bar(10, 71, 72.4, 71, 72.3), bar(6, 72.3, 72.3, 71.5, 71.6)];
    const { m } = market(71.6, bars, { low: 71, high: 72.4 });
    const result = await check([alert], m);

    expect(result.revisits).toHaveLength(1);
    expect(result.revisits[0]).toMatchObject({ triggerPrice: 72.3, direction: "up" });
    expect(result.followUps).toHaveLength(1);
    expect(result.followUps[0]).toMatchObject({ reversal: true, followUp: { direction: "down", price: 71.6 } });
    expect(alert.lastKnownSide).toBe("below");
  });

  it("skips the bar fetch when the day's range reaches none of a symbol's alerts", async () => {
    const { m, calls } = market(71, [bar(5, 1, 100, 1, 1)], { low: 70.5, high: 71.5 });
    const alert = staticAlert();
    const result = await check([alert], m);
    expect(calls).toEqual([]);
    expect(result.revisits).toEqual([]);
    expect(alert.lastEvaluatedAt).toBe(NOW.toISOString());
  });

  it("doesn't ask for bars overnight, when there can't be any", async () => {
    const { m, calls } = market(71, []);
    // Quote with no day range (Schwab reports 0 overnight), session closed, watermark after the close.
    const alert = staticAlert({ lastEvaluatedAt: "2026-10-01T20:30:00.000Z" });
    await checkAlerts([alert], m, [], "closed", new Set(), async () => null, async () => [], {
      now: new Date("2026-10-02T06:00:00.000Z"),
    });
    expect(calls).toEqual([]);
  });

  it("fetches when the quote has no day range", async () => {
    const { m, calls } = market(71, []);
    await check([staticAlert()], m);
    expect(calls).toEqual([1]);
  });

  it("falls back to the live quote when the bars can't be fetched", async () => {
    const m: MarketData = {
      ...market(73, []).m,
      getIntradayBars: () => Promise.reject(new Error("HTTP 500")),
    };
    const alert = staticAlert();
    const result = await check([alert], m);
    expect(result.warnings).toEqual([expect.stringContaining("ADC: minute bars unavailable")]);
    expect(result.revisits).toHaveLength(1);
    expect(result.revisits[0].triggerPrice).toBe(73);
  });

  it("never reads a bar twice across two checks", async () => {
    const alert = staticAlert({ direction: "either" });
    const bars = [bar(10, 71, 72.5, 71, 72.5)];
    const first = await check([alert], market(72.5, bars, { low: 71, high: 72.5 }).m);
    expect(first.revisits).toHaveLength(1);
    // Same bars again: everything before the watermark is left alone.
    const second = await check([alert], market(72.5, bars, { low: 71, high: 72.5 }).m);
    expect(second.revisits).toHaveLength(0);
    expect(second.followUps).toHaveLength(0);
  });
});
