import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MarketData } from "../src/alerts/engine.js";
import type { Alert, StaticAlert } from "../src/alerts/models.js";
import { loadAlerts, saveAlerts } from "../src/alerts/store.js";
import { COVER_ABOVE_PRICE, coverCandidates, coverLevel, coveredSymbols } from "../src/holdings/cover.js";
import type { HoldingsStore } from "../src/holdings/models.js";
import { saveHoldingsStore } from "../src/holdings/store.js";
import { parseOp, type Op } from "../src/ops/apply.js";
import { applyCoverOp } from "../src/ops/holdings.js";
import type { Quote } from "../src/providers/schwab.js";
import { ignoredSymbols, isIgnored } from "../src/tuning.js";

describe("coverLevel", () => {
  it("is 10% above price when the position is up", () => {
    expect(coverLevel(100, 108).level).toBe(118.8);
    expect(coverLevel(12.97, 17.3).level).toBe(19.03);
  });

  it("is 10% above basis when price is below it", () => {
    // The higher of the two references, so an underwater position is asked to
    // clear its cost before it says anything.
    expect(coverLevel(100, 95).level).toBe(110);
    expect(coverLevel(22.24, 21.12).level).toBe(24.46);
  });

  it("asks a deep loser for a full recovery, which can be far away", () => {
    // Down 69%: basis+10% is more than triple the price. Accepted deliberately;
    // it only applies to a position with no alert, i.e. normally a fresh buy.
    const r = coverLevel(4.45, 1.38);
    expect(r.level).toBe(4.9);
    expect(r.pctFromBasis).toBeCloseTo(-69, 0);
  });

  it("takes whichever reference is higher", () => {
    expect(coverLevel(50, 100).level).toBe(110);
    expect(coverLevel(1000, 100).level).toBe(1100);
  });

  it("never places a level at or below the live price", () => {
    // An alert at exactly the live price has no side to fire on and addAlert
    // rejects it outright.
    for (const [basis, price] of [[100, 110], [100, 200], [50, 55], [10, 10], [0.5, 0.5], [4.45, 1.38]]) {
      expect(coverLevel(basis, price).level).toBeGreaterThan(price);
    }
  });

  it("reports distance from basis without letting it move the level", () => {
    expect(coverLevel(10, 20).pctFromBasis).toBeCloseTo(100, 5);
    expect(coverLevel(20, 10).pctFromBasis).toBeCloseTo(-50, 5);
    expect(coverLevel(0, 10).pctFromBasis).toBe(0); // no basis to compare against
  });

  it("uses one flat percentage, with no volatility scaling", () => {
    expect(coverLevel(8.4, 11).level).toBe(12.1);
    expect(COVER_ABOVE_PRICE).toBe(0.1);
  });

  it("stays above the live price on a fresh buy, where price and basis are equal", () => {
    expect(coverLevel(50, 50).level).toBe(55);
  });
});

function lot(symbol: string, count: number, basisPerShare: number) {
  return { id: `lot${symbol}`, symbol, count, basisPerShare, purchaseDate: "2026-08-01", createdAt: "2026-08-01T00:00:00.000Z" };
}

function liveAlert(symbol: string, level: number, status: Alert["status"] = "live"): StaticAlert {
  return {
    id: `st${symbol}`,
    symbol,
    side: "below",
    status,
    createdAt: "2026-09-01T00:00:00.000Z",
    livePriceAtCreation: level - 5,
    triggerCount: 0,
    lastTriggeredAt: null,
    lastTriggerPrice: null,
    mutedUntil: null,
    watchingSince: "2026-09-01T00:00:00.000Z",
    watchingSinceApprox: false,
    priceAtWatchStart: null,
    triggerSnapshot: null,
    kind: "static",
    direction: "up",
    level,
    lastKnownSide: "below",
  };
}

describe("coverCandidates", () => {
  const store = { lots: [lot("AAPL", 10, 140), lot("MKS", 5, 40), lot("BIL", 100, 91)], stops: [], alertState: [] } as HoldingsStore;

  it("is every held symbol with no live alert, sorted", () => {
    expect(coverCandidates(store, [liveAlert("AAPL", 160)], new Set())).toEqual(["BIL", "MKS"]);
  });

  it("counts a cancelled alert as no cover", () => {
    expect(coverCandidates(store, [liveAlert("AAPL", 160, "cancelled")], new Set())).toEqual(["AAPL", "BIL", "MKS"]);
    expect(coveredSymbols([liveAlert("AAPL", 160, "cancelled")]).size).toBe(0);
  });

  it("skips the ignore list, which is cash parking rather than a position", () => {
    expect(coverCandidates(store, [], new Set(["BIL"]))).toEqual(["AAPL", "MKS"]);
  });

  it("matches symbols case-insensitively against both sets", () => {
    const mixed = { ...store, lots: [lot("aapl", 10, 140)] };
    expect(coverCandidates(mixed, [liveAlert("AAPL", 160)], new Set())).toEqual([]);
    expect(coverCandidates(mixed, [], new Set(["AAPL"]))).toEqual([]);
  });

  it("is empty when nothing is held", () => {
    expect(coverCandidates({ lots: [], stops: [], alertState: [] }, [], new Set())).toEqual([]);
  });
});

describe("holdings.cover op", () => {
  let dir: string;
  let holdingsFile: string;
  let alertsFile: string;

  const market = (prices: Record<string, number>): MarketData => ({
    getQuotes: (symbols: string[]) => {
      const out = new Map<string, Quote>();
      for (const s of symbols) if (prices[s] !== undefined) out.set(s, { lastPrice: prices[s], totalVolume: 0 });
      return Promise.resolve(out);
    },
    getIntradayBars: () => Promise.resolve([]),
    getDailyBars: () => Promise.resolve([]),
  });

  const op = (symbol: string): Op => {
    const r = parseOp({ id: "op-cover-0001", type: "holdings.cover", target: { symbol }, params: {} });
    if (!r.ok) throw new Error(r.error);
    return r.op;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cover-"));
    holdingsFile = join(dir, "holdings.json");
    alertsFile = join(dir, "alerts.json");
    saveHoldingsStore(holdingsFile, { lots: [lot("MKS", 5, 40), lot("BIL", 100, 91)], stops: [], alertState: [] });
    saveAlerts(alertsFile, []);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates one starting alert 10% above the higher of price and basis", async () => {
    const r = await applyCoverOp(op("MKS"), holdingsFile, alertsFile, market({ MKS: 50 }));
    expect(r).toMatchObject({ ok: true, symbol: "MKS" });
    expect(r.message).toBe(`Covered MKS with alert ${r.alertId}: price crosses above 55.`);
    expect(loadAlerts(alertsFile)).toHaveLength(1);
    expect(loadAlerts(alertsFile)[0]).toMatchObject({ symbol: "MKS", kind: "static", level: 55, status: "live" });
  });

  it("anchors to basis when the position is under water", async () => {
    await applyCoverOp(op("MKS"), holdingsFile, alertsFile, market({ MKS: 30 }));
    expect(loadAlerts(alertsFile)[0]).toMatchObject({ level: 44 });
  });

  // "Has no live alert" is the whole rule, so re-checking it is the conflict
  // guard: there is no expect the page could send that says more.
  it("refuses a symbol that already has a live alert, naming what it has", async () => {
    saveAlerts(alertsFile, [liveAlert("MKS", 60)]);
    const r = await applyCoverOp(op("MKS"), holdingsFile, alertsFile, market({ MKS: 50 }));
    expect(r).toMatchObject({ ok: false, symbol: "MKS" });
    expect(r.message).toBe("MKS already has a live alert (price crosses above 60).");
    expect(loadAlerts(alertsFile)).toHaveLength(1);
  });

  it.each([
    ["ZZZZ", {}, new Set<string>(), "No ZZZZ position to cover."],
    ["BIL", { BIL: 91 }, new Set(["BIL"]), "BIL is on the ignore list, so it is deliberately not alerted."],
    ["MKS", {}, new Set<string>(), "No quote available for MKS."],
  ])("rejects covering %s", async (symbol, prices, ignored, message) => {
    const r = await applyCoverOp(op(symbol), holdingsFile, alertsFile, market(prices), ignored);
    expect(r).toMatchObject({ ok: false, message });
    expect(loadAlerts(alertsFile)).toEqual([]);
  });

  it("rejects a missing target", async () => {
    const r = await applyCoverOp({ ...op("MKS"), target: {} }, holdingsFile, alertsFile, market({ MKS: 50 }));
    expect(r).toMatchObject({ ok: false, message: "A cover needs target.symbol." });
  });

  // Unlike every other holdings message this one names a number, because the
  // alert it creates is published in the public alert book anyway. What it
  // must never name is the basis or the share count.
  it("names the level but never the basis or the share count", async () => {
    const r = await applyCoverOp(op("MKS"), holdingsFile, alertsFile, market({ MKS: 30 }));
    expect(r.message).toContain("44");
    expect(r.message).not.toContain("40"); // basis
    expect(r.message).not.toMatch(/\b5\b/); // share count
  });
});

describe("ignoreSymbols config", () => {
  it("matches case-insensitively and ignores blank entries", () => {
    const set = ignoredSymbols({ ignoreSymbols: ["BIL", " sgov ", ""] });
    expect(isIgnored("bil", set)).toBe(true);
    expect(isIgnored("SGOV", set)).toBe(true);
    expect(isIgnored("AAPL", set)).toBe(false);
    expect(set.size).toBe(2);
  });

  it("is empty when the config is absent or says nothing", () => {
    expect(ignoredSymbols(null).size).toBe(0);
    expect(ignoredSymbols({}).size).toBe(0);
  });
});
