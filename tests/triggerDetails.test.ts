import { describe, expect, it } from "vitest";
import { describeAlertCondition } from "../src/alerts/describe.js";
import { checkAlerts, type MarketData } from "../src/alerts/engine.js";
import type { MaAlert, StaticAlert, TrailingAlert, VolumeAlert } from "../src/alerts/models.js";
import { buildDashboard } from "../src/dashboard.js";
import { emptyHoldingsStore } from "../src/holdings/models.js";
import type { Quote } from "../src/providers/schwab.js";
import { buildAlertRows } from "../src/web/alertsPage.js";
import { siteDocument, siteFingerprint } from "../src/web/site.js";

const base = {
  status: "live" as const,
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
};

function makeStatic(overrides: Partial<StaticAlert> = {}): StaticAlert {
  return { ...base, id: "s1", symbol: "TEST", kind: "static", side: "below", direction: "up", level: 100, lastKnownSide: "above", ...overrides };
}

function makeTrailing(overrides: Partial<TrailingAlert> = {}): TrailingAlert {
  return {
    ...base,
    id: "t1",
    symbol: "TRL",
    kind: "trailing",
    side: "below",
    near: 100,
    trailType: "percent",
    trailValue: 3,
    extremePrice: 90,
    extremeAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeVolume(overrides: Partial<VolumeAlert> = {}): VolumeAlert {
  return { ...base, id: "v1", symbol: "VOL", kind: "volume", volume: { threshold: 1_000_000, mode: "today" }, ...overrides };
}

function makeMa(overrides: Partial<MaAlert> = {}): MaAlert {
  return {
    ...base,
    id: "m1",
    symbol: "MAV",
    kind: "ma",
    maType: "sma",
    period: 200,
    timeframe: "1D",
    trigger: "cross",
    from: "either",
    marginPct: 0.25,
    lastSide: "above",
    inBand: false,
    lastLevel: 200,
    lastEvaluatedAt: "2026-09-11T14:00:00.000Z",
    lastFiredBucket: null,
    lastEvent: null,
    lastApproachedFrom: null,
    ...overrides,
  };
}

function market(prices: Record<string, { price: number; volume?: number }>): MarketData {
  return {
    getQuotes: async (symbols) => {
      const out = new Map<string, Quote>();
      for (const s of symbols) {
        if (prices[s]) out.set(s, { lastPrice: prices[s].price, totalVolume: prices[s].volume ?? 0 });
      }
      return out;
    },
    getIntradayBars: async () => [],
    getDailyBars: async () => [],
  };
}

const quotes = (map: Record<string, number>) => new Map(Object.entries(map).map(([s, lastPrice]) => [s, { lastPrice, totalVolume: 0 }]));

describe("describeAlertCondition", () => {
  it("describes each kind in words", () => {
    expect(describeAlertCondition(makeStatic({ level: 110 }))).toBe("price crosses above 110");
    expect(describeAlertCondition(makeStatic({ level: 110, direction: "down" }))).toBe("price crosses below 110");
    expect(describeAlertCondition(makeStatic({ level: 110, direction: "either" }))).toBe("price crosses 110");
    expect(describeAlertCondition(makeStatic({ level: 110, volumeCondition: { ratio: 1.5, mode: "period", periodValue: 30, periodUnit: "m" } }))).toBe(
      "price crosses above 110 AND volume >= 1.5x normal in last 30m"
    );
    expect(describeAlertCondition(makeTrailing())).toBe("trailing 3% off the low (started near 100)");
    expect(describeAlertCondition(makeTrailing({ side: "above", trailType: "amount", trailValue: 2 }))).toBe(
      "trailing $2 off the high (started near 100)"
    );
    expect(describeAlertCondition(makeVolume())).toBe("volume >= 1M shares today");
    expect(describeAlertCondition(makeMa())).toBe("cross 200-day SMA");
  });
});

describe("what a trigger records", () => {
  it("records a volume alert's condition and the volume it actually saw", async () => {
    const { revisits } = await checkAlerts([makeVolume()], market({ VOL: { price: 50, volume: 1_500_000 } }), []);
    expect(revisits).toHaveLength(1);
    expect(revisits[0]).toMatchObject({
      condition: "volume >= 1M shares today",
      volume: { observed: 1_500_000, required: 1_000_000, window: "today", basis: "threshold" },
    });
  });

  it("records the condition of a price alert, with no volume block when it had no volume condition", async () => {
    // Price falls from above 100 to 95, so the alert must watch downward crosses to fire.
    const { revisits } = await checkAlerts([makeStatic({ direction: "down" })], market({ TEST: { price: 95 } }), []);
    expect(revisits[0].condition).toBe("price crosses below 100");
    expect(revisits[0].volume).toBeUndefined();
  });

  it("records nothing when the volume condition isn't met", async () => {
    const { revisits } = await checkAlerts([makeVolume()], market({ VOL: { price: 50, volume: 900_000 } }), []);
    expect(revisits).toEqual([]);
  });
});

describe("buildAlertRows", () => {
  it("lists live, checked alerts by symbol with price against their level", () => {
    const alerts = [
      makeStatic({ id: "s1", symbol: "ZZZ", level: 100 }),
      makeMa({ id: "m1", symbol: "AAA", lastLevel: 200 }),
      makeTrailing({ id: "t1", symbol: "MMM" }),
      makeStatic({ id: "gone", symbol: "BBB", status: "cancelled" }),
      makeStatic({ id: "ign", symbol: "BIL" }),
    ];
    const rows = buildAlertRows(alerts, quotes({ ZZZ: 105, AAA: 190, MMM: 91 }), new Set(["BIL"]));

    expect(rows.map((r) => r.id)).toEqual(["m1", "t1", "s1"]);
    expect(rows[2]).toMatchObject({ condition: "price crosses above 100", direction: "up", level: 100, movingLevel: null, price: 105, vsLevelPct: 5 });
    expect(rows[0]).toMatchObject({ kind: "ma", direction: null, level: null, movingLevel: 200, vsLevelPct: -5 });
    // Trailing below: extreme 90, 3% bounce -> trigger 92.7.
    expect(rows[1]).toMatchObject({ level: null, movingLevel: 92.7 });
  });

  it("leaves price and distance null without a quote", () => {
    expect(buildAlertRows([makeStatic()], new Map(), new Set())[0]).toMatchObject({ price: null, vsLevelPct: null });
  });

  it("marks alerts on held symbols, so the public Alerts view can say so without the vault", () => {
    const alerts = [makeStatic({ id: "s1", symbol: "ZZZ" }), makeStatic({ id: "s2", symbol: "AAA" })];
    const rows = buildAlertRows(alerts, new Map(), new Set(), new Map(), new Set(["ZZZ"]));
    expect(rows.map((r) => [r.symbol, r.heldPosition])).toEqual([
      ["AAA", false],
      ["ZZZ", true],
    ]);
    // Held is a flag, never a size: nothing about the position rides along.
    expect(JSON.stringify(rows)).not.toMatch(/shares|basis|marketValue|stopPrice/);
  });
});

describe("siteFingerprint", () => {
  const NOW = new Date("2026-09-12T12:00:00.000Z");
  const fp = (alerts: Parameters<typeof buildAlertRows>[0], q: Map<string, Quote>) =>
    siteFingerprint(
      siteDocument(buildDashboard({ alerts, revisits: [], holdings: emptyHoldingsStore(), quotes: q, now: NOW }), { holdings: false }),
      buildAlertRows(alerts, q, new Set())
    );

  it("is the same with and without quotes, so the CLI can decide before fetching any", () => {
    const alerts = [makeStatic(), makeMa(), makeTrailing()];
    expect(fp(alerts, new Map())).toBe(fp(alerts, quotes({ TEST: 101, MAV: 250, TRL: 95 })));
  });

  it("ignores moving levels that shift every check, but not changes to the alert book", () => {
    const before = fp([makeStatic(), makeMa({ lastLevel: 200 })], new Map());
    expect(fp([makeStatic(), makeMa({ lastLevel: 201.5 })], new Map())).toBe(before);
    expect(fp([makeStatic(), makeMa(), makeVolume()], new Map())).not.toBe(before);
    expect(fp([makeStatic({ level: 105 }), makeMa()], new Map())).not.toBe(before);
    expect(fp([makeStatic({ triggerCount: 1, lastTriggeredAt: "2026-09-12T11:00:00.000Z" }), makeMa()], new Map())).not.toBe(before);
  });
});
