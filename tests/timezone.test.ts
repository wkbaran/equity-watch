import { describe, expect, it } from "vitest";
import { closeOnOrAfter, parseLastTriggered } from "../src/alerts/seed.js";
import { intradayBaseline } from "../src/alerts/volumeBaseline.js";
import type { PriceBar } from "../src/models.js";
import { localDateString, marketMinuteOfDay, nextMarketMidnight, zonedTimeToUtc } from "../src/timezone.js";

const iso = (d: Date) => d.toISOString();

describe("zonedTimeToUtc", () => {
  it("converts Mountain wall time in both halves of the year", () => {
    expect(iso(zonedTimeToUtc(2026, 9, 11, 7, 30, 0, "America/Denver"))).toBe("2026-09-11T13:30:00.000Z"); // MDT
    expect(iso(zonedTimeToUtc(2026, 1, 15, 7, 30, 0, "America/Denver"))).toBe("2026-01-15T14:30:00.000Z"); // MST
  });

  it("converts Eastern wall time across the November DST change", () => {
    expect(iso(zonedTimeToUtc(2026, 10, 30, 9, 30, 0, "America/New_York"))).toBe("2026-10-30T13:30:00.000Z");
    expect(iso(zonedTimeToUtc(2026, 11, 2, 9, 30, 0, "America/New_York"))).toBe("2026-11-02T14:30:00.000Z");
  });

  it("resolves a repeated fall-back hour to its first occurrence", () => {
    // 01:30 happens twice on 2026-11-01 in New York: first in EDT, then EST.
    expect(iso(zonedTimeToUtc(2026, 11, 1, 1, 30, 0, "America/New_York"))).toBe("2026-11-01T05:30:00.000Z");
  });

  it("resolves a skipped spring-forward time to an hour later", () => {
    // 02:30 doesn't exist on 2026-03-08 in New York; 03:30 EDT is 07:30Z.
    expect(iso(zonedTimeToUtc(2026, 3, 8, 2, 30, 0, "America/New_York"))).toBe("2026-03-08T07:30:00.000Z");
  });
});

describe("market clock", () => {
  it("reads the session open as 9:30 Eastern whatever the DST state", () => {
    expect(marketMinuteOfDay(new Date("2026-09-11T13:30:00Z"))).toBe(570);
    expect(marketMinuteOfDay(new Date("2026-01-15T14:30:00Z"))).toBe(570);
  });

  it("puts the next trading-calendar midnight in Eastern time, not UTC", () => {
    // 18:30 Eastern in January, during after-hours. UTC midnight would be only 30 minutes away.
    expect(iso(nextMarketMidnight(new Date("2026-01-14T23:30:00Z")))).toBe("2026-01-15T05:00:00.000Z");
    // 19:30 Eastern in September: already the next UTC day, still the same Eastern day.
    expect(iso(nextMarketMidnight(new Date("2026-09-11T23:30:00Z")))).toBe("2026-09-12T04:00:00.000Z");
    // Exactly at Eastern midnight, the next one is a day later.
    expect(iso(nextMarketMidnight(new Date("2026-09-12T04:00:00Z")))).toBe("2026-09-13T04:00:00.000Z");
  });

  it("formats the machine's own calendar date", () => {
    // Built in local time, so this holds in any machine zone.
    expect(localDateString(new Date(2026, 8, 11, 23, 30))).toBe("2026-09-11");
  });
});

describe("TradingView export times are Mountain time", () => {
  it("parses the alert list's Last Triggered in America/Denver, DST included", () => {
    // 07:30 Mountain is the 09:30 Eastern open.
    expect(parseLastTriggered("Mon 27 Jul '26 07:30:12")).toBe("2026-07-27T13:30:12.000Z");
    expect(parseLastTriggered("Thu 15 Jan '26 07:30:00")).toBe("2026-01-15T14:30:00.000Z");
  });
});

describe("closeOnOrAfter", () => {
  // Daily bars are stamped at the start of the trading day, midnight Eastern.
  const bars = [
    { date: new Date("2026-09-10T04:00:00Z"), close: 10 },
    { date: new Date("2026-09-11T04:00:00Z"), close: 11 },
  ];

  it("uses the close of the trading day an intraday time falls on, not the next day's", () => {
    expect(closeOnOrAfter(bars, "2026-09-10T13:30:00Z")).toBe(10);
  });

  it("moves to the next session only when the day itself has no bar", () => {
    expect(closeOnOrAfter(bars, "2026-09-09T20:00:00Z")).toBe(10);
    expect(closeOnOrAfter(bars, "2026-09-12T13:30:00Z")).toBeNull();
  });
});

describe("intradayBaseline across a DST change", () => {
  function bar(isoTime: string, volume: number): PriceBar {
    return { date: new Date(isoTime), open: 1, high: 1, low: 1, close: 1, volume };
  }

  it("matches the same Eastern clock time on both sides of the change", () => {
    const bars = [
      bar("2026-10-30T14:00:00Z", 300), // Friday 10:00 EDT
      bar("2026-11-02T15:00:00Z", 100), // Monday 10:00 EST
    ];
    // Tuesday 10:30 EST, one-hour window: both sessions' 10:00 bars belong in it.
    expect(intradayBaseline(bars, 3_600_000, new Date("2026-11-03T15:30:00Z"))).toBe(200);
  });
});
