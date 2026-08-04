import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MarketData } from "../src/alerts/engine.js";
import { addAlert, checkAlerts } from "../src/alerts/engine.js";
import type { Alert, StaticAlert, TrailingAlert, VolumeAlert } from "../src/alerts/models.js";
import { loadAlerts } from "../src/alerts/store.js";
import type { PriceBar } from "../src/models.js";
import type { Quote } from "../src/providers/schwab.js";

function fakeMarket(opts: {
  prices?: Record<string, number>;
  volumes?: Record<string, number>;
  intradayBars?: Record<string, PriceBar[]>;
  dailyBars?: Record<string, PriceBar[]>;
}): MarketData {
  return {
    getQuotes: async (symbols: string[]) => {
      const result = new Map<string, Quote>();
      for (const s of symbols) {
        const lastPrice = opts.prices?.[s];
        if (lastPrice === undefined) continue;
        result.set(s, { lastPrice, totalVolume: opts.volumes?.[s] ?? 0 });
      }
      return result;
    },
    getIntradayBars: async (symbol: string) => opts.intradayBars?.[symbol] ?? [],
    getDailyBars: async (symbol: string) => opts.dailyBars?.[symbol] ?? [],
  };
}

function bar(minutesAgo: number, volume: number): PriceBar {
  return {
    date: new Date(Date.now() - minutesAgo * 60_000),
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume,
  };
}

function makeStatic(overrides: Partial<StaticAlert> = {}): StaticAlert {
  return {
    id: "s1",
    symbol: "TEST",
    side: "below",
    status: "armed",
    createdAt: "2026-01-01T00:00:00.000Z",
    livePriceAtCreation: 105,
    triggeredAt: null,
    triggerPrice: null,
    triggerSnapshot: null,
    kind: "static",
    level: 100,
    lastKnownSide: "above",
    ...overrides,
  };
}

function makeTrailing(overrides: Partial<TrailingAlert> = {}): TrailingAlert {
  return {
    id: "t1",
    symbol: "TEST",
    side: "below",
    status: "armed",
    createdAt: "2026-01-01T00:00:00.000Z",
    livePriceAtCreation: 100,
    triggeredAt: null,
    triggerPrice: null,
    triggerSnapshot: null,
    kind: "trailing",
    near: 100,
    trailType: "percent",
    trailValue: 3,
    extremePrice: 100,
    extremeAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeVolume(overrides: Partial<VolumeAlert> = {}): VolumeAlert {
  return {
    id: "v1",
    symbol: "TEST",
    status: "armed",
    createdAt: "2026-01-01T00:00:00.000Z",
    livePriceAtCreation: 100,
    triggeredAt: null,
    triggerPrice: null,
    triggerSnapshot: null,
    kind: "volume",
    volume: { threshold: 1_000_000, mode: "today" },
    ...overrides,
  };
}

describe("checkAlerts", () => {
  it("does not trigger a static alert while price stays on the same side", async () => {
    const alert = makeStatic({ level: 100, lastKnownSide: "above" });
    const { triggered } = await checkAlerts([alert], fakeMarket({ prices: { TEST: 105 } }), []);
    expect(triggered).toHaveLength(0);
    expect(alert.status).toBe("armed");
  });

  it("triggers a static alert exactly once when price crosses the level", async () => {
    const alert = makeStatic({ level: 100, lastKnownSide: "above" });
    const first = await checkAlerts([alert], fakeMarket({ prices: { TEST: 95 } }), []);
    expect(first.triggered).toHaveLength(1);
    expect(alert.status).toBe("triggered");
    expect(alert.triggerPrice).toBe(95);

    // Already triggered (no longer armed), so a second check must not re-fire.
    const second = await checkAlerts([alert], fakeMarket({ prices: { TEST: 90 } }), []);
    expect(second.checked).toBe(0);
    expect(second.triggered).toHaveLength(0);
  });

  it("does not immediately false-trigger a freshly created static alert (lastKnownSide regression)", async () => {
    // Reproduces the bug: lastKnownSide must reflect price-vs-level, not the
    // anchor-vs-price "side" field, or a brand new alert fires on its very
    // first check even though price never moved.
    const market = fakeMarket({ prices: { TEST: 200 } });
    const added = await addAlert(mkdtempSync(join(tmpdir(), "tv-alerts-regress-")) + "/alerts.json", {
      kind: "static",
      symbol: "TEST",
      level: 150, // below the live price of 200
    }, market);
    expect(added.added).not.toBeNull();
    const alert = added.added as StaticAlert;
    expect(alert.lastKnownSide).toBe("above"); // price (200) is above the level (150)

    // Price hasn't moved at all - must not trigger.
    const { triggered } = await checkAlerts([alert], market, []);
    expect(triggered).toHaveLength(0);
    expect(alert.status).toBe("armed");
  });

  it("snapshots every attribute at trigger time, independent of later mutation", async () => {
    const alert = makeStatic({ level: 100, lastKnownSide: "above" });
    await checkAlerts([alert], fakeMarket({ prices: { TEST: 95 } }), []);

    expect(alert.triggerSnapshot).not.toBeNull();
    const snapshot = alert.triggerSnapshot!;
    expect(snapshot.status).toBe("armed"); // pre-trigger state, not "triggered"
    expect(snapshot.triggeredAt).toBeNull();
    expect(snapshot.triggerPrice).toBeNull();
    expect(snapshot.triggerSnapshot).toBeNull();
    expect((snapshot as StaticAlert).level).toBe(100);

    // A later in-place edit of the live record must not retroactively change the snapshot.
    (alert as StaticAlert).level = 50;
    expect((snapshot as StaticAlert).level).toBe(100);
  });

  it("trails a running low (side=below) and doesn't trigger on a small bounce", async () => {
    const alert = makeTrailing({ side: "below", extremePrice: 100, trailType: "percent", trailValue: 3 });
    const { triggered } = await checkAlerts([alert], fakeMarket({ prices: { TEST: 97 } }), []);
    expect(triggered).toHaveLength(0);
    expect(alert.extremePrice).toBe(97); // new low

    const { triggered: t2 } = await checkAlerts([alert], fakeMarket({ prices: { TEST: 98.5 } }), []);
    expect(t2).toHaveLength(0); // bounce of ~1.5%, below the 3% trail
    expect(alert.extremePrice).toBe(97);
  });

  it("triggers a below trailing alert once the bounce meets the trail threshold", async () => {
    const alert = makeTrailing({ side: "below", extremePrice: 97, trailType: "percent", trailValue: 3 });
    const { triggered } = await checkAlerts([alert], fakeMarket({ prices: { TEST: 100 } }), []); // 97 * 1.03 = 99.91
    expect(triggered).toHaveLength(1);
    expect(alert.status).toBe("triggered");
    expect(alert.triggerPrice).toBe(100);

    // The snapshot preserves the watermark reached before the bounce, even
    // if a future rearm/edit changes extremePrice on the live record.
    const snapshot = alert.triggerSnapshot as TrailingAlert;
    expect(snapshot.extremePrice).toBe(97);
    alert.extremePrice = 42;
    expect(snapshot.extremePrice).toBe(97);
  });

  it("trails a running high (side=above) and triggers on a pullback meeting a dollar trail", async () => {
    const alert = makeTrailing({ side: "above", extremePrice: 100, trailType: "amount", trailValue: 2 });
    const { triggered: t1 } = await checkAlerts([alert], fakeMarket({ prices: { TEST: 103 } }), []);
    expect(t1).toHaveLength(0);
    expect(alert.extremePrice).toBe(103); // new high

    const { triggered: t2 } = await checkAlerts([alert], fakeMarket({ prices: { TEST: 101.5 } }), []);
    expect(t2).toHaveLength(0); // pullback of 1.5, short of the $2 trail

    const { triggered: t3 } = await checkAlerts([alert], fakeMarket({ prices: { TEST: 101 } }), []); // 103 - 2 = 101
    expect(t3).toHaveLength(1);
    expect(alert.status).toBe("triggered");
  });

  describe("volume-only alerts", () => {
    it("does not trigger while today's volume is below the threshold", async () => {
      const alert = makeVolume({ volume: { threshold: 1_000_000, mode: "today" } });
      const { triggered } = await checkAlerts([alert], fakeMarket({ prices: { TEST: 100 }, volumes: { TEST: 500_000 } }), []);
      expect(triggered).toHaveLength(0);
    });

    it("triggers once today's cumulative volume reaches the threshold", async () => {
      const alert = makeVolume({ volume: { threshold: 1_000_000, mode: "today" } });
      const { triggered } = await checkAlerts(
        [alert],
        fakeMarket({ prices: { TEST: 100 }, volumes: { TEST: 1_200_000 } }),
        []
      );
      expect(triggered).toHaveLength(1);
      expect(alert.status).toBe("triggered");
    });

    it("sums minute bars within the trailing period window and ignores older ones", async () => {
      const alert = makeVolume({ volume: { threshold: 100_000, mode: "period", periodValue: 10, periodUnit: "m" } });
      const market = fakeMarket({
        prices: { TEST: 100 },
        intradayBars: {
          TEST: [bar(3, 40_000), bar(7, 40_000), bar(25, 500_000)], // last two only within 10m window? bar(25) excluded
        },
      });
      const { triggered } = await checkAlerts([alert], market, []);
      // 40_000 + 40_000 = 80_000, below the 100_000 threshold - old bar(25) correctly excluded
      expect(triggered).toHaveLength(0);
    });

    it("triggers once the summed period volume reaches the threshold", async () => {
      const alert = makeVolume({ volume: { threshold: 100_000, mode: "period", periodValue: 10, periodUnit: "m" } });
      const market = fakeMarket({
        prices: { TEST: 100 },
        intradayBars: { TEST: [bar(3, 60_000), bar(7, 60_000), bar(25, 999_999)] },
      });
      const { triggered } = await checkAlerts([alert], market, []);
      expect(triggered).toHaveLength(1);
    });

    it("sums daily bars for a day-unit period instead of intraday bars", async () => {
      const alert = makeVolume({ volume: { threshold: 5_000_000, mode: "period", periodValue: 2, periodUnit: "d" } });
      const market = fakeMarket({
        prices: { TEST: 100 },
        dailyBars: {
          TEST: [
            { date: new Date(), open: 1, high: 1, low: 1, close: 1, volume: 3_000_000 },
            { date: new Date(), open: 1, high: 1, low: 1, close: 1, volume: 2_500_000 },
          ],
        },
      });
      const { triggered } = await checkAlerts([alert], market, []);
      expect(triggered).toHaveLength(1);
    });
  });

  describe("AND-combined price + volume alerts", () => {
    it("does not trigger a static alert on crossing alone if volume hasn't caught up", async () => {
      const alert = makeStatic({
        level: 100,
        lastKnownSide: "above",
        volumeCondition: { threshold: 1_000_000, mode: "today" },
      });
      const { triggered } = await checkAlerts([alert], fakeMarket({ prices: { TEST: 95 }, volumes: { TEST: 200_000 } }), []);
      expect(triggered).toHaveLength(0);
      expect(alert.status).toBe("armed");
      // lastKnownSide must stay stale (not "below") so the crossing stays pending.
      expect(alert.lastKnownSide).toBe("above");
    });

    it("triggers a static+volume alert once volume catches up while price is still crossed", async () => {
      const alert = makeStatic({
        level: 100,
        lastKnownSide: "above",
        volumeCondition: { threshold: 1_000_000, mode: "today" },
      });
      await checkAlerts([alert], fakeMarket({ prices: { TEST: 95 }, volumes: { TEST: 200_000 } }), []);
      expect(alert.status).toBe("armed");

      const { triggered } = await checkAlerts([alert], fakeMarket({ prices: { TEST: 94 }, volumes: { TEST: 1_500_000 } }), []);
      expect(triggered).toHaveLength(1);
      expect(alert.status).toBe("triggered");
    });

    it("cancels a pending static crossing if price reverts before volume catches up", async () => {
      const alert = makeStatic({
        level: 100,
        lastKnownSide: "above",
        volumeCondition: { threshold: 1_000_000, mode: "today" },
      });
      await checkAlerts([alert], fakeMarket({ prices: { TEST: 95 }, volumes: { TEST: 200_000 } }), []);
      expect(alert.status).toBe("armed");

      // Price reverts back above the level before volume ever qualified.
      const { triggered } = await checkAlerts([alert], fakeMarket({ prices: { TEST: 105 }, volumes: { TEST: 300_000 } }), []);
      expect(triggered).toHaveLength(0);
      expect(alert.status).toBe("armed");

      // Now it needs a fresh crossing again even with ample volume.
      const { triggered: t2 } = await checkAlerts([alert], fakeMarket({ prices: { TEST: 106 }, volumes: { TEST: 5_000_000 } }), []);
      expect(t2).toHaveLength(0);
    });

    it("gates a trailing alert's trigger on the AND'd volume condition", async () => {
      const alert = makeTrailing({
        side: "below",
        extremePrice: 97,
        trailType: "percent",
        trailValue: 3,
        volumeCondition: { threshold: 1_000_000, mode: "today" },
      });
      const { triggered: t1 } = await checkAlerts(
        [alert],
        fakeMarket({ prices: { TEST: 100 }, volumes: { TEST: 100_000 } }), // price condition met, volume not
        []
      );
      expect(t1).toHaveLength(0);
      expect(alert.status).toBe("armed");

      const { triggered: t2 } = await checkAlerts(
        [alert],
        fakeMarket({ prices: { TEST: 100 }, volumes: { TEST: 2_000_000 } }),
        []
      );
      expect(t2).toHaveLength(1);
    });
  });
});

describe("addAlert", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tv-alerts-test-"));
    path = join(dir, "alerts.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("infers side=below when the anchor is under the live price", async () => {
    const result = await addAlert(
      path,
      { kind: "trailing", symbol: "TEST", near: 90, trailType: "percent", trailValue: 3 },
      fakeMarket({ prices: { TEST: 100 } })
    );
    expect(result.rejectedReason).toBeNull();
    expect(result.added?.kind).not.toBe("volume");
    expect((result.added as StaticAlert | TrailingAlert).side).toBe("below");
  });

  it("infers side=above when the anchor is over the live price", async () => {
    const result = await addAlert(path, { kind: "static", symbol: "TEST", level: 110 }, fakeMarket({ prices: { TEST: 100 } }));
    expect(result.rejectedReason).toBeNull();
    expect((result.added as StaticAlert).side).toBe("above");
  });

  it("seeds lastKnownSide from price-vs-level, not the anchor-vs-price side field", async () => {
    const result = await addAlert(path, { kind: "static", symbol: "TEST", level: 110 }, fakeMarket({ prices: { TEST: 100 } }));
    const added = result.added as StaticAlert;
    expect(added.side).toBe("above"); // anchor(110) is above live price(100)
    expect(added.lastKnownSide).toBe("below"); // price(100) is below the level(110)
  });

  it("rejects an anchor equal to the live price", async () => {
    const result = await addAlert(path, { kind: "static", symbol: "TEST", level: 100 }, fakeMarket({ prices: { TEST: 100 } }));
    expect(result.added).toBeNull();
    expect(result.rejectedReason).toMatch(/equals the live price/);
  });

  it("replaces an existing armed alert on the same side when the new one is closer, across kinds", async () => {
    const market = fakeMarket({ prices: { TEST: 100 } });
    const first = await addAlert(path, { kind: "static", symbol: "TEST", level: 80 }, market);
    expect((first.added as StaticAlert).side).toBe("below");

    const second = await addAlert(
      path,
      { kind: "trailing", symbol: "TEST", near: 95, trailType: "amount", trailValue: 1 },
      market
    );
    expect(second.rejectedReason).toBeNull();
    expect(second.replaced?.id).toBe(first.added!.id);

    const stored = loadAlerts(path);
    const original = stored.find((a) => a.id === first.added!.id)!;
    expect(original.status).toBe("cancelled");
    const replacement = stored.find((a) => a.id === second.added!.id)!;
    expect(replacement.status).toBe("armed");
  });

  it("rejects a new alert that is farther than an existing one on the same side", async () => {
    const market = fakeMarket({ prices: { TEST: 100 } });
    const close = await addAlert(
      path,
      { kind: "trailing", symbol: "TEST", near: 95, trailType: "amount", trailValue: 1 },
      market
    );

    const farther = await addAlert(path, { kind: "static", symbol: "TEST", level: 80 }, market);
    expect(farther.added).toBeNull();
    expect(farther.rejectedReason).toMatch(/already closer/);

    const stored = loadAlerts(path);
    const untouched = stored.find((a) => a.id === close.added!.id)!;
    expect(untouched.status).toBe("armed");
  });

  it("lets above and below alerts coexist on the same symbol", async () => {
    const market = fakeMarket({ prices: { TEST: 100 } });
    const below = await addAlert(path, { kind: "static", symbol: "TEST", level: 90 }, market);
    const above = await addAlert(path, { kind: "static", symbol: "TEST", level: 110 }, market);

    expect(below.rejectedReason).toBeNull();
    expect(above.rejectedReason).toBeNull();

    const stored: Alert[] = loadAlerts(path);
    expect(stored.filter((a) => a.status === "armed")).toHaveLength(2);
  });

  it("attaches a volume condition to a static alert (AND semantics)", async () => {
    const result = await addAlert(
      path,
      { kind: "static", symbol: "TEST", level: 110, volume: { threshold: 2_000_000, mode: "today" } },
      fakeMarket({ prices: { TEST: 100 } })
    );
    expect(result.rejectedReason).toBeNull();
    expect((result.added as StaticAlert).volumeCondition).toEqual({ threshold: 2_000_000, mode: "today" });
  });

  it("creates a standalone volume alert with no side/anchor and no dedup interaction", async () => {
    const market = fakeMarket({ prices: { TEST: 100 } });
    // A price alert already armed on this symbol...
    await addAlert(path, { kind: "static", symbol: "TEST", level: 90 }, market);
    // ...a volume-only alert must not be rejected/replaced by it, or vice versa.
    const result = await addAlert(path, { kind: "volume", symbol: "TEST", volume: { threshold: 500_000, mode: "today" } }, market);
    expect(result.rejectedReason).toBeNull();
    expect(result.replaced).toBeNull();
    expect(result.added?.kind).toBe("volume");

    const stored = loadAlerts(path);
    expect(stored.filter((a) => a.status === "armed")).toHaveLength(2);
  });

  it("lets multiple volume-only alerts coexist on the same symbol regardless of threshold", async () => {
    const market = fakeMarket({ prices: { TEST: 100 } });
    const first = await addAlert(path, { kind: "volume", symbol: "TEST", volume: { threshold: 500_000, mode: "today" } }, market);
    const second = await addAlert(path, { kind: "volume", symbol: "TEST", volume: { threshold: 5_000_000, mode: "today" } }, market);
    expect(first.rejectedReason).toBeNull();
    expect(second.rejectedReason).toBeNull();

    const stored = loadAlerts(path);
    expect(stored.filter((a) => a.status === "armed")).toHaveLength(2);
  });
});
