import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAlert, type MarketData } from "../src/alerts/engine.js";
import type { Alert, StaticAlert, VolumeCondition } from "../src/alerts/models.js";
import { loadAlerts, saveAlerts } from "../src/alerts/store.js";
import { addLot } from "../src/holdings/engine.js";
import type { HoldingsStore, PendingPurchase } from "../src/holdings/models.js";
import {
  applyPendingPurchases,
  purchaseClosure,
  purchaseLevel,
  purchaseTarget,
  recordPurchase,
} from "../src/holdings/purchaseAlert.js";
import { loadHoldingsStore, saveHoldingsStore } from "../src/holdings/store.js";
import { applyOp, parseOp } from "../src/ops/apply.js";
import type { Quote } from "../src/providers/schwab.js";

const market = (prices: Record<string, number>): MarketData => ({
  getQuotes: (symbols: string[]) => {
    const out = new Map<string, Quote>();
    for (const s of symbols) if (prices[s] !== undefined) out.set(s, { lastPrice: prices[s], totalVolume: 0 });
    return Promise.resolve(out);
  },
  getIntradayBars: () => Promise.resolve([]),
  getDailyBars: () => Promise.resolve([]),
});

const failing: MarketData = {
  getQuotes: () => Promise.reject(new Error("Schwab is down")),
  getIntradayBars: () => Promise.reject(new Error("no bars")),
  getDailyBars: () => Promise.reject(new Error("no bars")),
};

const VOLUME: VolumeCondition = { threshold: 2_500_000, mode: "today" };

function purchase(symbol: string, price: number, purchaseDate = "2026-11-03", recordedAt = "2026-11-03T15:00:00.000Z"): PendingPurchase {
  return { symbol, price, purchaseDate, recordedAt, source: "manual" };
}

function lot(symbol: string, basisPerShare: number) {
  return { id: `lot${symbol}`, symbol, count: 10, basisPerShare, purchaseDate: "2026-11-03", createdAt: "2026-11-03T15:00:00.000Z" };
}

describe("purchaseLevel", () => {
  it("is 10% above the lot's price, rounded to the cent", () => {
    expect(purchaseLevel(100)).toBe(110);
    expect(purchaseLevel(12.97)).toBe(14.27);
  });
});

describe("recordPurchase", () => {
  const empty = (): HoldingsStore => ({ lots: [], stops: [], alertState: [] });

  it("keeps one purchase per symbol, the newest", () => {
    const store = empty();
    recordPurchase(store, purchase("aapl", 150, "2026-11-01"));
    recordPurchase(store, purchase("AAPL", 160, "2026-11-03"));
    recordPurchase(store, purchase("MSFT", 400));
    expect(store.pendingPurchases?.map((p) => [p.symbol, p.price])).toEqual([
      ["AAPL", 160],
      ["MSFT", 400],
    ]);
  });

  it("ignores a backdated lot entered after a newer one", () => {
    const store = empty();
    recordPurchase(store, purchase("AAPL", 160, "2026-11-03"));
    recordPurchase(store, purchase("AAPL", 150, "2026-10-15", "2026-11-04T15:00:00.000Z"));
    expect(store.pendingPurchases?.[0].price).toBe(160);
  });
});

describe("purchaseTarget", () => {
  const base = {
    status: "live" as const,
    createdAt: "2026-09-01T00:00:00.000Z",
    livePriceAtCreation: 100,
    watchingSince: "2026-09-01T00:00:00.000Z",
    watchingSinceApprox: false,
    priceAtWatchStart: null,
    triggerCount: 0,
    lastTriggeredAt: null,
    lastTriggerPrice: null,
    mutedUntil: null,
    triggerSnapshot: null,
  };
  const fixed = (id: string, level: number, direction: StaticAlert["direction"] = "up"): StaticAlert => ({
    ...base,
    id,
    symbol: "AAPL",
    kind: "static",
    side: level > 100 ? "above" : "below",
    direction,
    level,
    lastKnownSide: "below",
  });

  it("prefers an upward alert, nearest the new level", () => {
    const alerts: Alert[] = [fixed("down1", 105, "down"), fixed("up1", 90), fixed("up2", 130)];
    expect(purchaseTarget(alerts, "AAPL", 120)?.id).toBe("up2");
  });

  it("moves a down-watching alert only when it is the only static one", () => {
    expect(purchaseTarget([fixed("down1", 80, "down")], "AAPL", 120)?.id).toBe("down1");
  });

  it("ignores cancelled alerts and other symbols", () => {
    const cancelled = { ...fixed("gone", 120), status: "cancelled" as const };
    expect(purchaseTarget([cancelled, { ...fixed("msft", 120), symbol: "MSFT" }], "AAPL", 120)).toBeNull();
  });
});

describe("applyPendingPurchases", () => {
  let dir: string;
  let holdingsFile: string;
  let alertsFile: string;

  const pending = (...purchases: PendingPurchase[]) => {
    const store = loadHoldingsStore(holdingsFile);
    for (const p of purchases) recordPurchase(store, p);
    saveHoldingsStore(holdingsFile, store);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "purchase-"));
    holdingsFile = join(dir, "holdings.json");
    alertsFile = join(dir, "alerts.json");
    saveHoldingsStore(holdingsFile, { lots: [lot("AAPL", 100), lot("BIL", 91)], stops: [], alertState: [] });
    saveAlerts(alertsFile, []);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("moves the price alert in place to 10% above the lot, watching up, and drops its volume condition", async () => {
    const m = market({ AAPL: 101 });
    const { added } = await addAlert(alertsFile, { kind: "static", symbol: "AAPL", level: 95, direction: "down", volume: VOLUME }, m);
    pending(purchase("AAPL", 100));

    const [outcome] = await applyPendingPurchases(holdingsFile, alertsFile, m, new Set());

    expect(outcome).toMatchObject({ symbol: "AAPL", status: "applied", result: { action: "moved", level: 110 } });
    const alerts = loadAlerts(alertsFile);
    expect(alerts).toHaveLength(1);
    const moved = alerts[0] as StaticAlert;
    expect(moved).toMatchObject({ id: added!.id, status: "live", level: 110, direction: "up", side: "above", lastKnownSide: "below" });
    expect(moved.volumeCondition).toBeUndefined();
    expect(loadHoldingsStore(holdingsFile).pendingPurchases).toBeUndefined();
  });

  it("closes the symbol's open entries as an edit or add from the page would, and a rejection closes nothing", async () => {
    const m = market({ AAPL: 101 });
    const { added } = await addAlert(alertsFile, { kind: "static", symbol: "AAPL", level: 95, direction: "down" }, m);
    pending(purchase("AAPL", 100));
    const [moved] = await applyPendingPurchases(holdingsFile, alertsFile, m, new Set());
    expect(moved.status === "applied" && purchaseClosure(moved.result)).toEqual({
      change: "alert.edit",
      alertId: added!.id,
      condition: expect.any(String) as string,
      moved: { from: 95, to: 110 },
    });

    saveAlerts(alertsFile, []);
    pending(purchase("AAPL", 100, "2026-11-05"));
    const [created] = await applyPendingPurchases(holdingsFile, alertsFile, m, new Set());
    expect(created.status === "applied" && purchaseClosure(created.result)).toMatchObject({ change: "alert.add", alertId: loadAlerts(alertsFile)[0].id });

    expect(purchaseClosure({ action: "rejected", level: 110, reason: "no" })).toBeNull();
  });

  it("adds a price alert beside alerts of other kinds and leaves them alone", async () => {
    const m = market({ AAPL: 101 });
    await addAlert(alertsFile, { kind: "volume", symbol: "AAPL", volume: VOLUME }, m);
    await addAlert(alertsFile, { kind: "trailing", symbol: "AAPL", direction: "up", trailType: "percent", trailValue: 5 }, m);
    await addAlert(
      alertsFile,
      { kind: "ma", symbol: "AAPL", maType: "sma", period: 50, timeframe: "1D", trigger: "cross", from: "below", marginPct: 0.5, volume: VOLUME },
      m
    );
    const before = loadAlerts(alertsFile);
    pending(purchase("AAPL", 100));

    const [outcome] = await applyPendingPurchases(holdingsFile, alertsFile, m, new Set());

    expect(outcome).toMatchObject({ status: "applied", result: { action: "created", level: 110 } });
    const after = loadAlerts(alertsFile);
    expect(after.slice(0, 3)).toEqual(before);
    expect(after[3]).toMatchObject({ kind: "static", symbol: "AAPL", level: 110, direction: "up", status: "live" });
  });

  it("adds one when the symbol has no alert at all", async () => {
    pending(purchase("AAPL", 100));
    await applyPendingPurchases(holdingsFile, alertsFile, market({ AAPL: 98 }), new Set());
    expect(loadAlerts(alertsFile)).toMatchObject([{ kind: "static", symbol: "AAPL", level: 110 }]);
  });

  it("drops a purchase on the ignore list or no longer held, without a quote", async () => {
    pending(purchase("BIL", 91), purchase("GONE", 10));
    const outcomes = await applyPendingPurchases(holdingsFile, alertsFile, failing, new Set(["BIL"]));
    expect(outcomes.map((o) => [o.symbol, o.status])).toEqual([
      ["BIL", "dropped"],
      ["GONE", "dropped"],
    ]);
    expect(loadAlerts(alertsFile)).toEqual([]);
    expect(loadHoldingsStore(holdingsFile).pendingPurchases).toBeUndefined();
  });

  it("keeps a purchase for the next run when quotes fail or are missing", async () => {
    pending(purchase("AAPL", 100));
    expect((await applyPendingPurchases(holdingsFile, alertsFile, failing, new Set()))[0]).toMatchObject({ status: "kept" });
    expect((await applyPendingPurchases(holdingsFile, alertsFile, market({}), new Set()))[0]).toMatchObject({ status: "kept" });
    expect(loadHoldingsStore(holdingsFile).pendingPurchases).toHaveLength(1);
    expect(loadAlerts(alertsFile)).toEqual([]);
  });

  it("settles a purchase the engine refuses, rather than retrying it every run", async () => {
    pending(purchase("AAPL", 100));
    // 10% above the lot is exactly the live price: an alert there has no side.
    const [outcome] = await applyPendingPurchases(holdingsFile, alertsFile, market({ AAPL: 110 }), new Set());
    expect(outcome).toMatchObject({ status: "applied", result: { action: "rejected", level: 110 } });
    expect(loadHoldingsStore(holdingsFile).pendingPurchases).toBeUndefined();
  });

  it("keeps a purchase recorded while it ran", async () => {
    const m: MarketData = {
      ...market({ AAPL: 101 }),
      getQuotes: async (symbols) => {
        // A lot added by another process mid-run.
        const store = loadHoldingsStore(holdingsFile);
        if (!store.pendingPurchases?.some((p) => p.symbol === "MSFT")) {
          store.lots.push(lot("MSFT", 400));
          recordPurchase(store, purchase("MSFT", 400));
          saveHoldingsStore(holdingsFile, store);
        }
        return market({ AAPL: 101 }).getQuotes(symbols);
      },
    };
    pending(purchase("AAPL", 100));
    await applyPendingPurchases(holdingsFile, alertsFile, m, new Set());
    expect(loadHoldingsStore(holdingsFile).pendingPurchases?.map((p) => p.symbol)).toEqual(["MSFT"]);
  });
});

describe("new lots record a purchase", () => {
  let dir: string;
  let holdingsFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "purchase-lot-"));
    holdingsFile = join(dir, "holdings.json");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("from addLot (the CLI's add-lot)", () => {
    const added = addLot(holdingsFile, { symbol: "NVDA", count: 4, basisPerShare: 120.5, purchaseDate: "2026-11-02" });
    expect(loadHoldingsStore(holdingsFile).pendingPurchases).toEqual([
      { symbol: "NVDA", price: 120.5, purchaseDate: "2026-11-02", recordedAt: added.createdAt, source: "manual" },
    ]);
  });

  it("from the dashboard's lot.add op, which needs no quote to do it", async () => {
    const parsed = parseOp({ id: "op-lot-add-0001", type: "lot.add", params: { symbol: "NVDA", count: 4, basisPerShare: 120.5 } });
    if (!parsed.ok) throw new Error(parsed.error);
    const { result } = await applyOp(parsed.op, {
      alertsFile: join(dir, "alerts.json"),
      holdingsFile,
      revisitsFile: join(dir, "revisits.json"),
      opLogFile: join(dir, "ops.log.jsonl"),
      market: failing,
    });
    expect(result.ok).toBe(true);
    expect(result.message).not.toMatch(/\d/);
    expect(loadHoldingsStore(holdingsFile).pendingPurchases?.[0]).toMatchObject({ symbol: "NVDA", price: 120.5 });
  });
});
