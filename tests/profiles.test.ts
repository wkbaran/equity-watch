import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveAlerts } from "../src/alerts/store.js";
import type { StaticAlert } from "../src/alerts/models.js";
import { saveHoldingsStore } from "../src/holdings/store.js";
import { emptyHoldingsStore, type Lot } from "../src/holdings/models.js";
import { DailyBudget } from "../src/profiles/budget.js";
import { loadCachedProfile, listCachedProfiles, saveCachedProfile } from "../src/profiles/store.js";
import { gatherKnownSymbols } from "../src/profiles/universe.js";
import type { CompanyProfile } from "../src/providers/fmp.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tv-alerts-profiles-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("DailyBudget", () => {
  it("allows consumption up to the limit, then refuses", () => {
    const budget = new DailyBudget(join(dir, "_budget.json"), 3);
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(budget.consume(now)).toBe(true);
    expect(budget.consume(now)).toBe(true);
    expect(budget.consume(now)).toBe(true);
    expect(budget.consume(now)).toBe(false);
    expect(budget.remaining(now)).toBe(0);
  });

  it("persists count across separate instances pointed at the same file", () => {
    const path = join(dir, "_budget.json");
    const now = new Date("2026-01-01T00:00:00.000Z");
    new DailyBudget(path, 5).consume(now);
    new DailyBudget(path, 5).consume(now);
    expect(new DailyBudget(path, 5).remaining(now)).toBe(3);
  });

  it("resets when the calendar date rolls over", () => {
    const budget = new DailyBudget(join(dir, "_budget.json"), 1);
    const day1 = new Date("2026-01-01T23:00:00.000Z");
    const day2 = new Date("2026-01-02T01:00:00.000Z");
    expect(budget.consume(day1)).toBe(true);
    expect(budget.consume(day1)).toBe(false);
    expect(budget.consume(day2)).toBe(true);
  });
});

describe("profile cache store", () => {
  it("round-trips a saved profile", () => {
    const profile: CompanyProfile = {
      symbol: "AAPL",
      companyName: "Apple Inc.",
      sector: "Technology",
      industry: "Consumer Electronics",
      description: "Makes phones.",
    };
    saveCachedProfile(dir, profile);
    expect(loadCachedProfile(dir, "AAPL")).toEqual(profile);
  });

  it("returns null for an uncached symbol", () => {
    expect(loadCachedProfile(dir, "MSFT")).toBeNull();
  });

  it("lists cached profiles but excludes the budget file", () => {
    saveCachedProfile(dir, { symbol: "AAPL", companyName: null, sector: "Technology", industry: null, description: null });
    saveCachedProfile(dir, { symbol: "MSFT", companyName: null, sector: "Technology", industry: null, description: null });
    new DailyBudget(join(dir, "_budget.json"), 250).consume(new Date());

    const profiles = listCachedProfiles(dir);
    expect(profiles.map((p) => p.symbol).sort()).toEqual(["AAPL", "MSFT"]);
  });
});

describe("gatherKnownSymbols", () => {
  function makeLot(symbol: string): Lot {
    return {
      id: "l1",
      symbol,
      count: 10,
      basisPerShare: 100,
      purchaseDate: "2026-01-01",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
  }

  it("unions and dedupes symbols across history/, holdings.json, alerts.json, and a CSV", () => {
    const historyDir = join(dir, "history");
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(join(historyDir, "AAPL.json"), "[]");
    writeFileSync(join(historyDir, "MSFT.json"), "[]");

    const holdingsFile = join(dir, "holdings.json");
    saveHoldingsStore(holdingsFile, { ...emptyHoldingsStore(), lots: [makeLot("TSLA"), makeLot("AAPL")] });

    const alertsFile = join(dir, "alerts.json");
    const alert: StaticAlert = {
      id: "a1",
      symbol: "NVDA",
      side: "below",
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
      kind: "static",
      level: 90,
      lastKnownSide: "above",
    };
    saveAlerts(alertsFile, [alert]);

    const csvPath = join(process.cwd(), "tests", "fixtures", "sample_alerts.csv");

    const symbols = gatherKnownSymbols({ historyDir, holdingsFile, alertsFile, csvPaths: [csvPath] });
    expect(symbols).toEqual(new Set(["AAPL", "MSFT", "TSLA", "NVDA", "GOOG", "ACHC", "ABNB", "SUI", "CDRE", "MKL"]));
  });

  it("returns an empty set when nothing exists yet", () => {
    const symbols = gatherKnownSymbols({
      historyDir: join(dir, "no-history"),
      holdingsFile: join(dir, "no-holdings.json"),
      alertsFile: join(dir, "no-alerts.json"),
    });
    expect(symbols.size).toBe(0);
  });
});
