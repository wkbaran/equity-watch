import { describe, expect, it } from "vitest";
import { analyzeAlert, AnalysisParams } from "../src/analysis.js";
import type { Alert, AlertType, PriceBar } from "../src/models.js";

const PARAMS: AnalysisParams = {
  baselineDays: 20,
  volumeRatioThreshold: 1.5,
  volumeTrendDays: 3,
  recentHighLookbackDays: 60,
  recentHighTolerance: 0.02,
  holdDays: 2,
  minBaselineBars: 10,
};

const START = new Date(Date.UTC(2026, 0, 1));
const DAY_MS = 24 * 60 * 60 * 1000;

function makeAlert(
  level: number | null,
  dayOffset: number,
  alertType: AlertType = "price_cross",
  direction?: "up" | "down"
): Alert {
  return {
    ...(direction ? { direction } : {}),
    alertId: "1",
    exchange: "BATS",
    symbol: "TEST",
    timeframe: null,
    description: `TEST Crossing ${level}`,
    time: new Date(START.getTime() + dayOffset * DAY_MS),
    alertType,
    level,
    rawTicker: "BATS:TEST",
  };
}

function makeBars(closes: number[], volumes: number[], highs?: number[], lows?: number[]): PriceBar[] {
  const effectiveHighs = highs ?? closes.map((c) => c * 1.005);
  const effectiveLows = lows ?? closes.map((c) => c * 0.99);
  return closes.map((close, i) => ({
    date: new Date(START.getTime() + i * DAY_MS),
    open: close,
    high: Math.max(effectiveHighs[i], close),
    low: Math.min(effectiveLows[i], close),
    close,
    volume: volumes[i],
  }));
}

describe("analyzeAlert", () => {
  it("confirms a breakout with growing volume that holds", () => {
    const quietCloses = Array.from({ length: 30 }, (_, i) => 95 + (i % 5) * 0.5);
    const quietVolumes = Array.from({ length: 30 }, (_, i) => 100_000 + (i % 3) * 5_000);
    const closes = [...quietCloses, 105, 106, 107];
    const volumes = [...quietVolumes, 320_000, 250_000, 200_000];
    const highs = [...Array(30).fill(99.5), 105, 106, 107];
    const bars = makeBars(closes, volumes, highs);

    const alert = makeAlert(100.0, 30);
    const result = analyzeAlert(alert, bars, PARAMS);

    expect(result.verdict).toBe("CONFIRMED_BREAKOUT");
    expect(result.nearRecentHigh).toBe(true);
    expect(result.heldAboveLevel).toBe(true);
    expect(result.volumeRatio!).toBeGreaterThan(PARAMS.volumeRatioThreshold);
  });

  it("does not confirm a breakout that fails to hold", () => {
    const closes = [...Array(30).fill(95), 105, 98, 97];
    const volumes = [...Array(30).fill(100_000), 320_000, 150_000, 140_000];
    const highs = [...Array(30).fill(99.5), 105, 99, 97];
    const bars = makeBars(closes, volumes, highs);

    const alert = makeAlert(100.0, 30);
    const result = analyzeAlert(alert, bars, PARAMS);

    expect(result.heldAboveLevel).toBe(false);
    expect(["WATCH", "WATCH_WEAK", "NO"]).toContain(result.verdict);
    expect(result.verdict).not.toBe("CONFIRMED_BREAKOUT");
  });

  it("does not confirm a breakout without volume confirmation", () => {
    const closes = [...Array(30).fill(95), 105, 106, 107];
    const volumes = [...Array(30).fill(100_000), 105_000, 100_000, 100_000];
    const highs = [...Array(30).fill(99.5), 105, 106, 107];
    const bars = makeBars(closes, volumes, highs);

    const alert = makeAlert(100.0, 30);
    const result = analyzeAlert(alert, bars, PARAMS);

    expect(result.volumeRatio!).toBeLessThan(PARAMS.volumeRatioThreshold);
    expect(result.verdict).not.toBe("CONFIRMED_BREAKOUT");
  });

  it("flags a level well below the recent high as not near it", () => {
    const closes = [...Array(30).fill(120), 105, 106, 107];
    const volumes = [...Array(30).fill(100_000), 320_000, 250_000, 200_000];
    const highs = [...Array(30).fill(122), 105, 106, 107];
    const bars = makeBars(closes, volumes, highs);

    const alert = makeAlert(100.0, 30);
    const result = analyzeAlert(alert, bars, PARAMS);

    expect(result.nearRecentHigh).toBe(false);
    expect(result.verdict).not.toBe("CONFIRMED_BREAKOUT");
  });

  it("flags no close confirmation when the close never exceeds the level", () => {
    const closes = [...Array(30).fill(95), 99, 98, 97];
    const volumes = Array(33).fill(100_000);
    const bars = makeBars(closes, volumes);

    const alert = makeAlert(100.0, 30);
    const result = analyzeAlert(alert, bars, PARAMS);

    expect(result.verdict).toBe("NO_CLOSE_CONFIRM");
  });

  it("flags insufficient history", () => {
    const closes = [95, 96, 105];
    const volumes = [100_000, 100_000, 300_000];
    const bars = makeBars(closes, volumes);

    const alert = makeAlert(100.0, 2);
    const result = analyzeAlert(alert, bars, PARAMS);

    expect(result.verdict).toBe("INSUFFICIENT_DATA");
  });

  it("skips non-price alert types", () => {
    const alert = makeAlert(null, 0, "trendline_cross");
    const result = analyzeAlert(alert, [], PARAMS);
    expect(result.verdict).toBe("SKIPPED");
  });

  it("leaves the hold as pending when not enough days have passed", () => {
    const closes = [...Array(30).fill(95), 105];
    const volumes = [...Array(30).fill(100_000), 320_000];
    const highs = [...Array(30).fill(99.5), 105];
    const bars = makeBars(closes, volumes, highs);

    const alert = makeAlert(100.0, 30);
    const result = analyzeAlert(alert, bars, PARAMS);

    expect(result.heldAboveLevel).toBeNull();
    expect(result.verdict).toBe("CONFIRMED_BREAKOUT");
  });

  it("treats an explicit up direction exactly like an absent one", () => {
    const closes = [...Array(30).fill(95), 105, 106, 107];
    const volumes = [...Array(30).fill(100_000), 320_000, 250_000, 200_000];
    const highs = [...Array(30).fill(99.5), 105, 106, 107];
    const bars = makeBars(closes, volumes, highs);
    const absent = analyzeAlert(makeAlert(100, 30), bars, PARAMS);
    const up = analyzeAlert(makeAlert(100, 30, "price_cross", "up"), bars, PARAMS);
    expect({ ...up, alert: null }).toEqual({ ...absent, alert: null });
  });
});

describe("analyzeAlert for a downward crossing", () => {
  // Mirrors of the upside cases: price sat above 100 near a recent low of
  // ~100.5, then closed below 100.
  const quietCloses = () => Array.from({ length: 30 }, (_, i) => 105 - (i % 5) * 0.5);
  const quietLows = () => Array(30).fill(100.5);

  it("confirms a close below the level on growing volume that holds below", () => {
    const closes = [...quietCloses(), 95, 94, 93];
    const volumes = [...Array.from({ length: 30 }, (_, i) => 100_000 + (i % 3) * 5_000), 320_000, 250_000, 200_000];
    const lows = [...quietLows(), 95, 94, 93];
    const result = analyzeAlert(makeAlert(100, 30, "price_cross", "down"), makeBars(closes, volumes, undefined, lows), PARAMS);

    expect(result.verdict).toBe("CONFIRMED_BREAKOUT");
    expect(result.nearRecentHigh).toBe(true); // near the recent LOW, for a downward crossing
    expect(result.heldAboveLevel).toBe(true); // held BELOW
    expect(result.daysHeld).toBe(2);
    expect(result.pctAboveLevel!).toBeCloseTo(-5, 5); // raw, not flipped
    expect(result.notes).toContain("close below level");
    expect(result.notes).toContain("near/below recent low");
    expect(result.notes).toContain("held below level for 2/2d");
  });

  it("is the regression: the same bars judged as an upward crossing never confirm", () => {
    const closes = [...quietCloses(), 95, 94, 93];
    const volumes = [...Array(30).fill(100_000), 320_000, 250_000, 200_000];
    const lows = [...quietLows(), 95, 94, 93];
    const bars = makeBars(closes, volumes, undefined, lows);
    expect(analyzeAlert(makeAlert(100, 30), bars, PARAMS).verdict).toBe("NO_CLOSE_CONFIRM");
    expect(analyzeAlert(makeAlert(100, 30, "price_cross", "down"), bars, PARAMS).verdict).toBe("CONFIRMED_BREAKOUT");
  });

  it("does not confirm a drop that climbs back above within the hold period", () => {
    const closes = [...Array(30).fill(105), 95, 102, 103];
    const volumes = [...Array(30).fill(100_000), 320_000, 150_000, 140_000];
    const lows = [...Array(30).fill(100.5), 95, 101, 103];
    const result = analyzeAlert(makeAlert(100, 30, "price_cross", "down"), makeBars(closes, volumes, undefined, lows), PARAMS);

    expect(result.heldAboveLevel).toBe(false);
    expect(result.daysHeld).toBe(0);
    expect(result.verdict).toBe("WATCH");
    expect(result.notes).toContain("closed back above");
  });

  it("does not confirm a drop without volume", () => {
    const closes = [...Array(30).fill(105), 95, 94, 93];
    const volumes = [...Array(30).fill(100_000), 105_000, 100_000, 100_000];
    const lows = [...Array(30).fill(100.5), 95, 94, 93];
    const result = analyzeAlert(makeAlert(100, 30, "price_cross", "down"), makeBars(closes, volumes, undefined, lows), PARAMS);

    expect(result.volumeRatio!).toBeLessThan(PARAMS.volumeRatioThreshold);
    expect(result.verdict).toBe("WATCH_WEAK");
  });

  it("flags a level well above the recent low as not near it", () => {
    const closes = [...Array(30).fill(85), 95, 94, 93];
    const volumes = [...Array(30).fill(100_000), 320_000, 250_000, 200_000];
    const lows = [...Array(30).fill(80), 95, 94, 93];
    // Level 100 with a recent low of 80: an arbitrary number, not an extreme.
    const result = analyzeAlert(makeAlert(100, 30, "price_cross", "down"), makeBars(closes, volumes, undefined, lows), PARAMS);

    expect(result.nearRecentHigh).toBe(false);
    expect(result.verdict).not.toBe("CONFIRMED_BREAKOUT");
    expect(result.notes).toContain("well above recent low");
  });

  it("flags no close confirmation when the close never gets below the level", () => {
    const closes = [...Array(30).fill(105), 101, 102, 103];
    const volumes = Array(33).fill(100_000);
    const result = analyzeAlert(makeAlert(100, 30, "price_cross", "down"), makeBars(closes, volumes), PARAMS);

    expect(result.verdict).toBe("NO_CLOSE_CONFIRM");
    expect(result.notes).toContain("close at/above level");
  });

  it("leaves the hold as pending when not enough days have passed", () => {
    const closes = [...quietCloses(), 95];
    const volumes = [...Array(30).fill(100_000), 320_000];
    const lows = [...quietLows(), 95];
    const result = analyzeAlert(makeAlert(100, 30, "price_cross", "down"), makeBars(closes, volumes, undefined, lows), PARAMS);

    expect(result.heldAboveLevel).toBeNull();
    expect(result.verdict).toBe("CONFIRMED_BREAKOUT");
  });
});
