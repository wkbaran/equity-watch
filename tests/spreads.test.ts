import { describe, expect, it } from "vitest";
import type { MarketData } from "../src/alerts/engine.js";
import { buildDashboard, renderDashboard } from "../src/dashboard.js";
import { emptyHoldingsStore } from "../src/holdings/models.js";
import type { PriceBar } from "../src/models.js";
import type { Quote } from "../src/providers/schwab.js";
import { checkSpreadStops } from "../src/spreads/spreadCheck.js";
import {
  CANCELLED_KEEP_DAYS,
  emptyStore,
  fireAtLevel,
  parseSpreadFile,
  syncSpreadStops,
  type SpreadAlertsFile,
  type SpreadStopsStore,
} from "../src/spreads/spreadStops.js";
import { dashboardFingerprint, siteDocument } from "../src/web/site.js";

const NOW = new Date("2026-10-26T15:00:00.000Z"); // a Monday, 11:00 Eastern
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const CRM = {
  key: "CRM Nov 20th 260/270 Bear Call Spread|2026-11-20|260/270#1",
  symbol: "CRM",
  role: "stop",
  direction: "up",
  level: 252.06,
  spread: {
    name: "CRM Nov 20th 260/270 Bear Call Spread", kind: "call", expiration: "2026-11-20",
    short: { strike: 260, type: "C" }, long: { strike: 270, type: "C" },
    contracts: 1, credit: 1.18, stopDebit: 3.39, debitNow: 2.98, shortDeltaAtLevel: 0.43,
  },
};
const NVDA = {
  key: "NVDA Nov 27th 195/200 Bull Put Spread|2026-11-27|195/200#1",
  symbol: "NVDA",
  role: "stop",
  direction: "down",
  level: 203.21,
  spread: {
    name: "NVDA Nov 27th 195/200 Bull Put Spread", kind: "put", expiration: "2026-11-27",
    short: { strike: 200, type: "P" }, long: { strike: 195, type: "P" },
    contracts: 1, credit: 1.0, stopDebit: 1.86, debitNow: 1.35, shortDeltaAtLevel: 0.42,
  },
};

const fileText = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema: "spread-book/alerts@1",
    generatedAt: "2026-10-26T13:45:00.000Z",
    spotsAsOf: "2026-10-26T14:10:00.000Z",
    source: "live-active-by-symbol-2026-10-26_07-45.csv",
    complete: true,
    alerts: [CRM, NVDA],
    unpriced: [],
    ...over,
  });

function parsed(over: Record<string, unknown> = {}): SpreadAlertsFile {
  const r = parseSpreadFile(fileText(over));
  if (!r.ok) throw new Error(r.reason);
  return r.file;
}

const synced = (over: Record<string, unknown> = {}, store: SpreadStopsStore = emptyStore(), at = NOW) => syncSpreadStops(store, parsed(over), at);

describe("parseSpreadFile", () => {
  it("reads spread-book's file", () => {
    const f = parsed();
    expect(f.alerts.map((a) => [a.symbol, a.direction, a.level])).toEqual([["CRM", "up", 252.06], ["NVDA", "down", 203.21]]);
    expect(f.alerts[0].spread.stopDebit).toBe(3.39);
  });

  it("refuses anything that could read as every spread closing", () => {
    expect(parseSpreadFile(fileText({ complete: false }))).toMatchObject({ ok: false, reason: expect.stringContaining("incomplete") });
    expect(parseSpreadFile(fileText({ schema: "spread-book/alerts@2" }))).toMatchObject({ ok: false });
    expect(parseSpreadFile("{ half a fi")).toMatchObject({ ok: false });
    // One entry it can't read refuses the file: skipping it would cancel that spread's stop.
    expect(parseSpreadFile(fileText({ alerts: [CRM, { ...NVDA, direction: "sideways" }] }))).toMatchObject({ ok: false, reason: "alert 1 is not one this version understands" });
  });

  it("keeps nothing it doesn't need: no contract count, no credit", () => {
    const stored = JSON.stringify(synced().store);
    expect(stored).not.toContain("contracts");
    expect(stored).not.toContain("credit");
  });
});

describe("syncSpreadStops", () => {
  it("adds a stop per spread, starting on the safe side of its level", () => {
    const r = synced();
    expect(r.added).toHaveLength(2);
    const [crm, nvda] = r.store.stops;
    expect([crm.lastKnownSide, nvda.lastKnownSide]).toEqual(["below", "above"]);
    expect(r.store.syncedFrom).toBe("2026-10-26T13:45:00.000Z");
  });

  it("moves a level in place and re-arms it, keeping its fires", () => {
    const first = synced().store;
    first.stops[1].lastKnownSide = "below";
    first.stops[1].fires.push({ id: "f1", at: NOW.toISOString(), price: 203, level: 203.21, session: "regular" });
    const r = synced({ generatedAt: "2026-10-26T19:25:00.000Z", alerts: [CRM, { ...NVDA, level: 204.1 }] }, first);
    expect(r.relevelled.map((x) => [x.stop.symbol, x.from, x.stop.level])).toEqual([["NVDA", 203.21, 204.1]]);
    const nvda = r.store.stops.find((s) => s.symbol === "NVDA")!;
    expect(nvda.lastKnownSide).toBe("above");
    expect(nvda.fires).toHaveLength(1);
    expect(fireAtLevel(nvda)).toBeNull();
  });

  it("cancels a stop whose spread is gone, but keeps one spread-book couldn't price today", () => {
    const first = synced().store;
    const r = synced({ alerts: [], unpriced: [NVDA.key] }, first);
    expect(r.cancelled.map((s) => s.symbol)).toEqual(["CRM"]);
    expect(r.kept.map((s) => s.symbol)).toEqual(["NVDA"]);
    expect(r.store.stops.find((s) => s.symbol === "NVDA")!.status).toBe("live");
  });

  it("drops cancelled stops after a while", () => {
    const first = synced({ alerts: [], unpriced: [] }, synced().store).store;
    expect(first.stops.every((s) => s.status === "cancelled")).toBe(true);
    const r = synced({ alerts: [] }, first, new Date(NOW.getTime() + (CANCELLED_KEEP_DAYS + 1) * 86_400_000));
    expect(r.store.stops).toEqual([]);
  });

  it("brings back a cancelled key as live", () => {
    const cancelled = synced({ alerts: [] }, synced().store).store;
    const r = synced({}, cancelled);
    expect(r.store.stops.every((s) => s.status === "live")).toBe(true);
  });
});

// ---- checking -----------------------------------------------------------------

function bar(at: Date, close: number): PriceBar {
  return { date: at, open: close, high: close, low: close, close, volume: 1000 };
}

function market(prices: Record<string, number>, bars: Record<string, PriceBar[]> = {}): MarketData {
  return {
    getQuotes: async (symbols) => new Map(symbols.map((s) => [s, { lastPrice: prices[s], totalVolume: 0 } as Quote])),
    getIntradayBars: async (symbol) => bars[symbol] ?? [],
    getDailyBars: async () => [],
  };
}

describe("checkSpreadStops", () => {
  it("fires a put spread's stop when the stock falls through it, and a call spread's when it rises", async () => {
    const store = synced().store;
    const r = await checkSpreadStops(store, market({ CRM: 253, NVDA: 202.5 }), "regular", NOW);
    expect(r.fired.map((f) => [f.stop.symbol, f.fire.price, f.fire.level])).toEqual([["CRM", 253, 252.06], ["NVDA", 202.5, 203.21]]);
    expect(store.stops.every((s) => s.fires.length === 1)).toBe(true);
  });

  it("stays quiet on the safe side", async () => {
    const store = synced().store;
    const r = await checkSpreadStops(store, market({ CRM: 249, NVDA: 211 }), "regular", NOW);
    expect(r.fired).toEqual([]);
    expect(store.stops.every((s) => s.lastEvaluatedAt === NOW.toISOString())).toBe(true);
  });

  it("fires once per level, however often price crosses back and forth", async () => {
    const store = synced({ alerts: [NVDA] }).store;
    await checkSpreadStops(store, market({ NVDA: 202 }), "regular", NOW);
    // Back above and down through it again, in minute bars before the next check.
    const chop = [bar(later(2), 204), bar(later(5), 202.8), bar(later(8), 204.5), bar(later(11), 201)];
    const r = await checkSpreadStops(store, market({ NVDA: 201 }, { NVDA: chop }), "regular", later(15));
    expect(r.fired).toEqual([]);
    expect(store.stops[0].fires).toHaveLength(1);
  });

  it("judges a new level afresh: a spread still past its stop is reported again after a re-level", async () => {
    const first = synced({ alerts: [NVDA] }).store;
    await checkSpreadStops(first, market({ NVDA: 202 }), "regular", NOW);
    const moved = synced({ generatedAt: "2026-10-26T19:25:00.000Z", alerts: [{ ...NVDA, level: 203.9 }] }, first).store;
    const r = await checkSpreadStops(moved, market({ NVDA: 202 }), "regular", later(20));
    expect(r.fired.map((f) => f.fire.level)).toEqual([203.9]);
    expect(moved.stops[0].fires).toHaveLength(2);
  });

  it("does nothing without live stops", async () => {
    const r = await checkSpreadStops(emptyStore(), market({}), "regular", NOW);
    expect(r).toEqual({ checked: 0, fired: [], warnings: [] });
  });
});

// ---- the dashboard --------------------------------------------------------------

const dashboard = (store: SpreadStopsStore | undefined, quotes: Record<string, number> = {}) =>
  buildDashboard({
    alerts: [],
    revisits: [],
    holdings: emptyHoldingsStore(),
    quotes: new Map(Object.entries(quotes).map(([s, p]) => [s, { lastPrice: p, totalVolume: 0 } as Quote])),
    now: later(30),
    spreadStops: store,
  });

describe("the spread-stops section", () => {
  it("lists live stops with the distance to the level, and recent fires with a headline", async () => {
    const store = synced().store;
    await checkSpreadStops(store, market({ CRM: 249, NVDA: 202 }), "regular", NOW);
    const d = dashboard(store, { CRM: 249, NVDA: 202 });
    expect(d.spreadStops!.rows.map((r) => [r.label, r.distancePct, r.fired !== null])).toEqual([
      ["NVDA 195/200 put", -0.6, true],
      ["CRM 260/270 call", 1.2, false],
    ]);
    expect(d.spreadStops!.fires).toHaveLength(1);
    expect(d.spreadStops!.fires[0].headline).toBe("NVDA 195/200 put: stock 202 crossed below its stop level 203.21 (spread about $1.86). Check the spread's price.");
    expect(renderDashboard(d)).toContain("SPREAD STOPS (2");
  });

  it("is null without stops, and fingerprints the same with and without quotes", () => {
    expect(dashboard(undefined).spreadStops).toBeNull();
    expect(dashboard(emptyStore()).spreadStops).toBeNull();
    const store = synced().store;
    const off = { holdings: false };
    expect(dashboardFingerprint(siteDocument(dashboard(store), off))).toBe(dashboardFingerprint(siteDocument(dashboard(store, { CRM: 251, NVDA: 207 }), off)));
    // Sorted the other way by distance, still the same document order.
    expect(dashboardFingerprint(siteDocument(dashboard(store, { CRM: 200, NVDA: 300 }), off))).toBe(dashboardFingerprint(siteDocument(dashboard(store), off)));
  });

  it("publishes no contract count or credit", () => {
    const json = JSON.stringify(siteDocument(dashboard(synced().store), { holdings: false }));
    expect(json).not.toMatch(/contracts|credit/);
  });
});
