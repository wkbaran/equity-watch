import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { revisitsToBreakoutAlerts } from "../src/alerts/bridge.js";
import { addAlert, checkAlerts, type MarketData } from "../src/alerts/engine.js";
import { describeMaAlert, evaluateMaAlert, type PathPoint } from "../src/alerts/maEngine.js";
import type { MaAlert } from "../src/alerts/models.js";
import type { RevisitEntry } from "../src/alerts/revisit.js";
import { loadAlerts } from "../src/alerts/store.js";
import type { PriceBar } from "../src/models.js";
import type { Quote } from "../src/providers/schwab.js";

function makeMa(overrides: Partial<MaAlert> = {}): MaAlert {
  return {
    id: "m1",
    symbol: "TEST",
    status: "live",
    createdAt: "2026-01-01T00:00:00.000Z",
    livePriceAtCreation: 100,
    triggerCount: 0,
    lastTriggeredAt: null,
    lastTriggerPrice: null,
    mutedUntil: null,
    watchingSince: "2026-01-01T00:00:00.000Z",
    watchingSinceApprox: false,
    priceAtWatchStart: null,
    triggerSnapshot: null,
    kind: "ma",
    maType: "sma",
    period: 20,
    timeframe: "1D",
    trigger: "cross",
    from: "either",
    marginPct: 0.5,
    lastSide: "below",
    inBand: false,
    lastLevel: null,
    lastEvaluatedAt: "2026-09-11T13:55:00.000Z",
    lastFiredBucket: null,
    lastEvent: null,
    lastApproachedFrom: null,
    ...overrides,
  };
}

const at100 = () => 100;

/** A close-only point (low = high = close) at an ISO instant. */
function pt(iso: string, close: number, low = close, high = close): PathPoint {
  return { at: new Date(iso), low, high, close };
}

// 10:00 Eastern on Friday 2026-09-11, and the following Monday.
const FRI = "2026-09-11T14:0";
const MON = "2026-09-14T14:0";
const NOW = new Date("2026-09-11T14:10:00Z");

describe("evaluateMaAlert: seeding", () => {
  it("records the side on the first evaluation and never fires from it", () => {
    const alert = makeMa({ lastSide: null, lastEvaluatedAt: null });
    const r = evaluateMaAlert(alert, [pt(`${FRI}5:00Z`, 105)], at100, NOW);
    expect(r.event).toBeNull();
    expect(alert.lastSide).toBe("above");
    expect(alert.lastLevel).toBe(100);
    expect(alert.lastEvaluatedAt).toBe(NOW.toISOString());
  });

  it("does nothing while there isn't enough history for a level", () => {
    const alert = makeMa({ lastSide: null, lastEvaluatedAt: null });
    const r = evaluateMaAlert(alert, [pt(`${FRI}5:00Z`, 105)], () => null, NOW);
    expect(r.event).toBeNull();
    expect(alert.lastSide).toBeNull();
    expect(alert.lastLevel).toBeNull();
  });
});

describe("evaluateMaAlert: crosses", () => {
  it("catches a cross that reversed before the poll", () => {
    // The whole point of replaying the path: snapshot-to-snapshot this is below -> below.
    const alert = makeMa({ from: "below" });
    const r = evaluateMaAlert(alert, [pt(`${FRI}1:00Z`, 99), pt(`${FRI}2:00Z`, 101), pt(`${FRI}5:00Z`, 99.5)], at100, NOW);
    expect(r).toMatchObject({ event: "cross_up", price: 101, level: 100, approachedFrom: "below" });
    expect(r.at!.toISOString()).toBe("2026-09-11T14:02:00.000Z");
    expect(alert.lastSide).toBe("below");
  });

  it("treats a wick through the average as not a cross", () => {
    const alert = makeMa();
    const r = evaluateMaAlert(alert, [pt(`${FRI}2:00Z`, 99, 98, 102)], at100, NOW);
    expect(r.event).toBeNull();
  });

  it("respects the direction filter but still tracks the side", () => {
    const alert = makeMa({ lastSide: "above", from: "below" });
    const r = evaluateMaAlert(alert, [pt(`${FRI}2:00Z`, 98)], at100, NOW);
    expect(r.event).toBeNull();
    expect(alert.lastSide).toBe("below");
  });

  it("fires at most once per MA bar, then again in the next bar", () => {
    const alert = makeMa();
    expect(evaluateMaAlert(alert, [pt(`${FRI}2:00Z`, 101)], at100, NOW).event).toBe("cross_up");
    // Same trading day on a daily average: the chop back and forth is suppressed.
    expect(evaluateMaAlert(alert, [pt(`${FRI}3:00Z`, 99), pt(`${FRI}4:00Z`, 101)], at100, NOW).event).toBeNull();
    expect(evaluateMaAlert(alert, [pt(`${MON}1:00Z`, 99)], at100, new Date("2026-09-14T14:10:00Z")).event).toBe("cross_down");
  });

  it("does not stall on a point exactly at the average", () => {
    const alert = makeMa();
    const r = evaluateMaAlert(alert, [pt(`${FRI}1:00Z`, 100), pt(`${FRI}2:00Z`, 100.5)], at100, NOW);
    expect(r.event).toBe("cross_up");
  });
});

describe("evaluateMaAlert: touches", () => {
  it("fires when a bar's range comes within the margin, and records the side it came from", () => {
    // Band is 100 +/- 0.5.
    const alert = makeMa({ trigger: "touch", lastSide: "above" });
    const r = evaluateMaAlert(alert, [pt(`${FRI}2:00Z`, 101, 100.4, 101.2)], at100, NOW);
    expect(r).toMatchObject({ event: "touch", approachedFrom: "above" });
    expect(alert.inBand).toBe(true);
  });

  it("does not fire outside the margin", () => {
    const alert = makeMa({ trigger: "touch", lastSide: "above" });
    expect(evaluateMaAlert(alert, [pt(`${FRI}2:00Z`, 101, 100.6, 101.2)], at100, NOW).event).toBeNull();
  });

  it("re-arms only after leaving the band by twice the margin", () => {
    const alert = makeMa({ trigger: "touch", lastSide: "above", timeframe: "1m" });
    expect(evaluateMaAlert(alert, [pt(`${FRI}2:00Z`, 100.3)], at100, NOW).event).toBe("touch");
    // Hovering just outside the band (100.7 < 101) doesn't re-arm.
    expect(evaluateMaAlert(alert, [pt(`${FRI}3:00Z`, 100.7), pt(`${FRI}4:00Z`, 100.2)], at100, NOW).event).toBeNull();
    // Clearly away (101.5 > 101), then back in: fires again.
    expect(evaluateMaAlert(alert, [pt(`${FRI}5:00Z`, 101.5), pt(`${FRI}6:00Z`, 100.1)], at100, NOW).event).toBe("touch");
  });

  it("respects --from", () => {
    const alert = makeMa({ trigger: "touch", lastSide: "above", from: "below" });
    expect(evaluateMaAlert(alert, [pt(`${FRI}2:00Z`, 100.3)], at100, NOW).event).toBeNull();
  });
});

describe("describeMaAlert", () => {
  it("reads as a condition", () => {
    expect(describeMaAlert(makeMa({ maType: "sma", period: 200, timeframe: "1W", from: "below" }))).toBe(
      "cross up through 200-week SMA"
    );
    expect(describeMaAlert(makeMa({ maType: "ema", period: 9, timeframe: "5m", trigger: "touch", marginPct: 0.25, from: "above" }))).toBe(
      "touch 9-bar EMA on 5-minute bars within 0.25% from above"
    );
  });
});

describe("checkAlerts with moving-average alerts", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  function market(price: number, minuteBars: PriceBar[], dailyBars: PriceBar[]): MarketData {
    return {
      getQuotes: async (symbols) => new Map<string, Quote>(symbols.map((s) => [s, { lastPrice: price, totalVolume: 0 }])),
      getIntradayBars: async () => minuteBars,
      getDailyBars: async () => dailyBars,
    };
  }

  function barAt(msAgo: number, close: number): PriceBar {
    return { date: new Date(Date.now() - msAgo), open: close, high: close, low: close, close, volume: 1 };
  }

  it("fires on a cross between polls and queues a revisit carrying the average", async () => {
    // Completed daily closes of 100 put the 3-day SMA at 100.
    const dailies = [2, 3, 4, 5, 6].map((d) => barAt(d * 86_400_000, 100));
    const minutes = [barAt(4 * 60_000, 99), barAt(3 * 60_000, 101)];
    const alert = makeMa({
      period: 3,
      lastEvaluatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });

    const { triggered, revisits, warnings } = await checkAlerts([alert], market(99.5, minutes, dailies), []);
    expect(warnings).toEqual([]);
    expect(triggered).toHaveLength(1);
    expect(revisits[0]).toMatchObject({
      kind: "ma",
      levelAtTrigger: 100,
      triggerPrice: 101,
      direction: "up",
      ma: { maType: "sma", period: 3, timeframe: "1D", event: "cross_up", approachedFrom: "below" },
    });
    expect(alert).toMatchObject({ triggerCount: 1, lastSide: "below", lastEvent: "cross_up" });
  });

  it("warns instead of guessing when history is too short", async () => {
    const alert = makeMa({ period: 200, lastSide: null, lastEvaluatedAt: null });
    const { triggered, warnings } = await checkAlerts([alert], market(100, [], [barAt(2 * 86_400_000, 100)]), []);
    expect(triggered).toEqual([]);
    expect(warnings[0]).toMatch(/not enough history for the 200-day SMA/);
  });

  it("adds without cancelling a price alert on the same symbol", async () => {
    dir = mkdtempSync(join(tmpdir(), "ma-"));
    const path = join(dir, "alerts.json");
    const m = market(100, [], []);
    await addAlert(path, { kind: "static", symbol: "TEST", level: 110 }, m);
    const { added } = await addAlert(
      path,
      { kind: "ma", symbol: "TEST", maType: "ema", period: 9, timeframe: "5m", trigger: "touch", from: "either", marginPct: 0.25 },
      m
    );
    expect(added).toMatchObject({ kind: "ma", lastSide: null, lastEvaluatedAt: null });
    expect(loadAlerts(path).map((a) => a.status)).toEqual(["live", "live"]);
  });
});

describe("bridging moving-average revisits to breakout analysis", () => {
  function entry(event: "cross_up" | "touch"): RevisitEntry {
    return {
      id: `r-${event}`,
      alertId: "m1",
      symbol: "TEST",
      kind: "ma",
      triggeredAt: "2026-09-11T14:02:00.000Z",
      triggerPrice: 101,
      levelAtTrigger: 100,
      session: "regular",
      watchingSince: null,
      watchingSinceApprox: false,
      priceAtWatchStart: null,
      status: "open",
      appliedFrom: null,
      appliedTo: null,
      suggestedLevel: null,
      suggestedAt: null,
      suggestionBasis: null,
      resolvedAt: null,
      priority: null,
      signals: null,
      ma: { maType: "sma", period: 200, timeframe: "1D", event, approachedFrom: "below" },
    };
  }

  it("judges a cross against the average's value, and skips touches", () => {
    const bridged = revisitsToBreakoutAlerts([entry("cross_up"), entry("touch")]);
    expect(bridged).toHaveLength(1);
    expect(bridged[0]).toMatchObject({ alertId: "r-cross_up", level: 100 });
  });
});
