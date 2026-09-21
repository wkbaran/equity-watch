import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAlerts, type MarketData } from "../src/alerts/engine.js";
import type { Alert, StaticAlert } from "../src/alerts/models.js";
import type { Notifier } from "../src/alerts/notify.js";
import { writeAlertTriggerReport } from "../src/alerts/report.js";
import { applyOp, parseOp, type Op } from "../src/ops/apply.js";
import { exchangesFromProfiles } from "../src/tradingview.js";
import { readFileSync } from "node:fs";

/**
 * A bare `chart/?symbol=PPL` opens Pakistan Petroleum, not PPL Corp. The
 * prefix comes from the cached FMP profile, and until 2026-09-21 the notifier
 * and both CSV writers had no way to reach it.
 */
function staticAlert(symbol: string, overrides: Partial<StaticAlert> = {}): StaticAlert {
  return {
    id: `a-${symbol}`,
    symbol,
    status: "live",
    createdAt: "2026-09-01T00:00:00.000Z",
    livePriceAtCreation: 100,
    triggerCount: 0,
    lastTriggeredAt: null,
    lastTriggerPrice: null,
    mutedUntil: null,
    watchingSince: "2026-09-01T00:00:00.000Z",
    watchingSinceApprox: false,
    priceAtWatchStart: null,
    triggerSnapshot: null,
    kind: "static",
    side: "below",
    direction: "up",
    level: 100,
    lastKnownSide: "below",
    ...overrides,
  };
}

function fakeMarket(prices: Record<string, number>): MarketData {
  return {
    getQuotes: async (symbols) =>
      new Map(symbols.filter((s) => s in prices).map((s) => [s, { lastPrice: prices[s], totalVolume: 0 }])),
    getIntradayBars: async () => [],
    getDailyBars: async () => [],
  };
}

describe("chart links carry the exchange", () => {
  const EXCHANGES = new Map([["PPL", "NYSE"]]);

  it("on a notification, and falls back to the bare symbol for an unknown one", async () => {
    const seen: string[] = [];
    const notifier: Notifier = { notify: async ({ chartUrl }) => void seen.push(chartUrl) };
    await checkAlerts([staticAlert("PPL"), staticAlert("WAT")], fakeMarket({ PPL: 110, WAT: 110 }), [notifier], null, new Set(), async () => null, async () => [], {
      exchanges: EXCHANGES,
    });
    expect(seen).toContain("https://www.tradingview.com/chart/?symbol=NYSE%3APPL");
    // No cached profile, so the link is what it always was.
    expect(seen).toContain("https://www.tradingview.com/chart/?symbol=WAT");
  });

  it("on the alert trigger CSV", () => {
    const dir = mkdtempSync(join(tmpdir(), "equity-watch-chart-"));
    const out = join(dir, "triggers.csv");
    writeAlertTriggerReport([staticAlert("PPL") as Alert, staticAlert("WAT") as Alert], out, EXCHANGES);
    const csv = readFileSync(out, "utf-8");
    expect(csv).toContain("https://www.tradingview.com/chart/?symbol=NYSE%3APPL");
    expect(csv).toContain("https://www.tradingview.com/chart/?symbol=WAT");
    rmSync(dir, { recursive: true, force: true });
  });

  it("builds the map from cached profiles, skipping ones FMP had no exchange for", () => {
    const map = exchangesFromProfiles([
      { symbol: "PPL", companyName: "PPL Corp", sector: null, industry: null, description: null, exchange: "NYSE" },
      { symbol: "WAT", companyName: "Waters Corp", sector: null, industry: null, description: null, exchange: null },
    ]);
    expect(map.get("PPL")).toBe("NYSE");
    expect(map.has("WAT")).toBe(false);
  });
});

describe("a drain fills in a new symbol's profile", () => {
  let dir: string;
  let alertsFile: string;
  let opLogFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "equity-watch-fill-"));
    alertsFile = join(dir, "alerts.json");
    opLogFile = join(dir, "ops.log.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const addOp = (symbol: string, id = "op-add-0001"): Op => {
    const r = parseOp({ id, type: "alert.add", createdAt: "2026-09-15T15:00:00.000Z", params: { symbol, level: 120 } });
    if (!r.ok) throw new Error(r.error);
    return r.op;
  };

  it("asks for the symbol the op landed on", async () => {
    const asked: string[] = [];
    const out = await applyOp(addOp("PPL"), {
      alertsFile,
      opLogFile,
      market: fakeMarket({ PPL: 100 }),
      ensureProfile: async (symbol) => void asked.push(symbol),
    });
    expect(out.result.ok).toBe(true);
    expect(asked).toEqual(["PPL"]);
  });

  it("asks for nothing when the op was rejected", async () => {
    const asked: string[] = [];
    // No quote, so addAlert refuses and there is no new symbol in the store.
    const out = await applyOp(addOp("NOPE"), {
      alertsFile,
      opLogFile,
      market: fakeMarket({}),
      ensureProfile: async (symbol) => void asked.push(symbol),
    });
    expect(out.result.ok).toBe(false);
    expect(asked).toEqual([]);
  });

  it("survives a lookup that throws, because the op is already applied and logged", async () => {
    // The drain must not stop over a chart link. If this threw, pullOps would
    // release the message and applyOp would only ever see it again as a
    // duplicate - the op applied, but reported as though it hadn't.
    const out = await applyOp(addOp("PPL"), {
      alertsFile,
      opLogFile,
      market: fakeMarket({ PPL: 100 }),
      ensureProfile: async () => {
        throw new Error("FMP is down");
      },
    });
    expect(out.result.ok).toBe(true);
    expect(JSON.parse(readFileSync(opLogFile, "utf-8").trim())).toMatchObject({ id: "op-add-0001", ok: true });
    expect(loadAlertSymbols(alertsFile)).toEqual(["PPL"]);
  });
});

function loadAlertSymbols(file: string): string[] {
  return (JSON.parse(readFileSync(file, "utf-8")) as Alert[]).map((a) => a.symbol);
}
