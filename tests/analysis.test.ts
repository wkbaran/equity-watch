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

function makeAlert(level: number | null, dayOffset: number, alertType: AlertType = "price_cross"): Alert {
  return {
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

function makeBars(closes: number[], volumes: number[], highs?: number[]): PriceBar[] {
  const effectiveHighs = highs ?? closes.map((c) => c * 1.005);
  return closes.map((close, i) => ({
    date: new Date(START.getTime() + i * DAY_MS),
    open: close,
    high: Math.max(effectiveHighs[i], close),
    low: close * 0.99,
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

  it("flags a level well below the recent high as weak resistance", () => {
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
});
