import { describe, expect, it } from "vitest";
import {
  computeBaseline,
  dailyBaseline,
  intradayBaseline,
  requiredVolume,
  rollingWindowBaseline,
  baselineKey,
  historyDaysFor,
} from "../src/alerts/volumeBaseline.js";
import type { PriceBar } from "../src/models.js";

const DAY = 86_400_000;

/** Daily bars, one per calendar day, most recent last. */
function dailyBars(volumes: number[], startIso = "2026-06-01T20:00:00Z"): PriceBar[] {
  const start = new Date(startIso).getTime();
  return volumes.map((volume, i) => ({
    date: new Date(start + i * DAY),
    open: 10,
    high: 10,
    low: 10,
    close: 10,
    volume,
  }));
}

/** Minute-ish bars across several sessions at given UTC times. */
function intradayBars(spec: { day: string; time: string; volume: number }[]): PriceBar[] {
  return spec.map((s) => ({
    date: new Date(`${s.day}T${s.time}:00Z`),
    open: 10,
    high: 10,
    low: 10,
    close: 10,
    volume: s.volume,
  }));
}

describe("dailyBaseline", () => {
  it("averages full-day volume over the recent window", () => {
    expect(dailyBaseline(dailyBars([100, 200, 300]), 20)).toBe(200);
  });

  it("only looks at the most recent sessions", () => {
    // An old spike outside the window must not inflate the baseline.
    expect(dailyBaseline(dailyBars([9999, 100, 100, 100]), 3)).toBe(100);
  });

  it("returns zero for no history rather than throwing", () => {
    expect(dailyBaseline([])).toBe(0);
  });
});

describe("rollingWindowBaseline", () => {
  it("measures the window's own total, not avgDaily times days", () => {
    // 10 consecutive days of 100. A 7-day window holds 7 bars here, so the
    // typical window total is 700 - and critically it is derived from real
    // windows, not multiplied up from a daily average.
    expect(rollingWindowBaseline(dailyBars(Array(10).fill(100)), 7)).toBe(700);
  });

  it("skips windows without enough history behind them", () => {
    // Without this the first few short windows drag the average down.
    const bars = dailyBars(Array(10).fill(100));
    expect(rollingWindowBaseline(bars, 7)).toBeGreaterThan(600);
  });

  it("reflects gaps, so a calendar window holding fewer trading days reads lower", () => {
    // Weekday-only bars: a 7-calendar-day window holds ~5 of them, so the
    // total is well under avgDaily * 7.
    const weekdays: PriceBar[] = [];
    let cursor = new Date("2026-06-01T20:00:00Z").getTime();
    for (let i = 0; i < 30; i++) {
      const d = new Date(cursor);
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
        weekdays.push({ date: d, open: 1, high: 1, low: 1, close: 1, volume: 100 });
      }
      cursor += DAY;
    }
    const baseline = rollingWindowBaseline(weekdays, 7);
    expect(baseline).toBeLessThan(700); // not avgDaily * 7
    expect(baseline).toBeGreaterThanOrEqual(400);
  });

  it("returns zero for no history", () => {
    expect(rollingWindowBaseline([], 7)).toBe(0);
  });
});

describe("intradayBaseline", () => {
  // Two sessions, heavy at the open and close, light midday - the real shape.
  const bars = intradayBars([
    { day: "2026-09-09", time: "14:00", volume: 900 },
    { day: "2026-09-09", time: "17:00", volume: 100 },
    { day: "2026-09-09", time: "19:30", volume: 800 },
    { day: "2026-09-10", time: "14:00", volume: 1100 },
    { day: "2026-09-10", time: "17:00", volume: 200 },
    { day: "2026-09-10", time: "19:30", volume: 1000 },
  ]);

  it("matches the time of day rather than averaging the whole session", () => {
    // A flat average would be ~683 for every hour of the day, making the open
    // look normal and the lunch hour look dead.
    const morning = intradayBaseline(bars, 3_600_000, new Date("2026-09-11T14:30:00Z"));
    const midday = intradayBaseline(bars, 3_600_000, new Date("2026-09-11T17:30:00Z"));
    expect(morning).toBe(1000); // (900 + 1100) / 2
    expect(midday).toBe(150); // (100 + 200) / 2
    expect(morning).toBeGreaterThan(midday * 5);
  });

  it("excludes today's own partial volume from its own baseline", () => {
    const withToday = intradayBars([
      ...bars.map((b) => ({ day: b.date.toISOString().slice(0, 10), time: b.date.toISOString().slice(11, 16), volume: b.volume })),
      { day: "2026-09-11", time: "14:00", volume: 999_999 },
    ]);
    expect(intradayBaseline(withToday, 3_600_000, new Date("2026-09-11T14:30:00Z"))).toBe(1000);
  });

  it("returns zero outside market hours, where there is nothing to compare against", () => {
    // Safe direction: requiredVolume turns a zero baseline into "cannot
    // evaluate" rather than "any volume qualifies".
    expect(intradayBaseline(bars, 3_600_000, new Date("2026-09-11T23:00:00Z"))).toBe(0);
  });

  it("returns zero for no history", () => {
    expect(intradayBaseline([], 3_600_000, new Date())).toBe(0);
  });
});

describe("requiredVolume", () => {
  it("passes an absolute threshold straight through, baseline irrelevant", () => {
    expect(requiredVolume({ threshold: 5000, mode: "today" }, null)).toBe(5000);
    expect(requiredVolume({ threshold: 5000, mode: "today" }, 999)).toBe(5000);
  });

  it("scales a ratio by the baseline", () => {
    expect(requiredVolume({ ratio: 1.5, mode: "today" }, 1000)).toBe(1500);
  });

  it("refuses to evaluate a ratio with no usable baseline", () => {
    // Returning 0 here would mean *any* volume satisfies the condition, which
    // would fire every alert on every check.
    expect(requiredVolume({ ratio: 1.5, mode: "today" }, null)).toBeNull();
    expect(requiredVolume({ ratio: 1.5, mode: "today" }, 0)).toBeNull();
    expect(requiredVolume({ ratio: 1.5, mode: "today" }, -5)).toBeNull();
  });

  it("returns null when neither is set", () => {
    expect(requiredVolume({ mode: "today" }, 1000)).toBeNull();
  });
});

describe("computeBaseline dispatch", () => {
  const source = {
    getDailyBars: async () => dailyBars([100, 200, 300]),
    getIntradayBars: async () =>
      intradayBars([
        { day: "2026-09-09", time: "14:00", volume: 400 },
        { day: "2026-09-10", time: "14:00", volume: 600 },
      ]),
  };

  it("uses full-day averages for a today-mode condition", async () => {
    expect(await computeBaseline("X", { ratio: 1.5, mode: "today" }, source)).toBe(200);
  });

  it("uses rolling sums for a day-unit window", async () => {
    const b = await computeBaseline("X", { ratio: 1.5, mode: "period", periodValue: 2, periodUnit: "d" }, source);
    expect(b).toBeGreaterThan(0);
  });

  it("uses time-matched intraday volume for a sub-day window", async () => {
    const b = await computeBaseline(
      "X",
      { ratio: 1.5, mode: "period", periodValue: 1, periodUnit: "h" },
      source,
      new Date("2026-09-11T14:30:00Z")
    );
    expect(b).toBe(500); // (400 + 600) / 2
  });
});

describe("cache keys and history sizing", () => {
  it("distinguishes windows on the same symbol", () => {
    expect(baselineKey("MTD", { ratio: 1.5, mode: "today" })).not.toBe(
      baselineKey("MTD", { ratio: 1.5, mode: "period", periodValue: 7, periodUnit: "d" })
    );
  });

  it("produces a filesystem-safe key", () => {
    expect(baselineKey("BRK.B", { ratio: 1, mode: "today" })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("asks for more history the longer the window", () => {
    const short = historyDaysFor({ ratio: 1, mode: "period", periodValue: 1, periodUnit: "d" });
    const long = historyDaysFor({ ratio: 1, mode: "period", periodValue: 7, periodUnit: "d" });
    expect(long).toBeGreaterThan(short);
  });
});
