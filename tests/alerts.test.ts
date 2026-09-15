import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MarketData } from "../src/alerts/engine.js";
import { addAlert, checkAlerts, editAlert } from "../src/alerts/engine.js";
import type { Alert, MaAlert, StaticAlert, TrailingAlert, VolumeAlert } from "../src/alerts/models.js";
import { endedOnFiredSide, reversalOf } from "../src/alerts/reversion.js";
import type { RevisitEntry } from "../src/alerts/revisit.js";
import { loadAlerts, removeAlert, saveAlerts } from "../src/alerts/store.js";
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
    status: "live",
    createdAt: "2026-01-01T00:00:00.000Z",
    livePriceAtCreation: 105,
    triggerCount: 0,
    lastTriggeredAt: null,
    lastTriggerPrice: null,
    mutedUntil: null,
    watchingSince: "2026-01-01T00:00:00.000Z",
    watchingSinceApprox: false,
    priceAtWatchStart: null,
    triggerSnapshot: null,
    kind: "static",
    direction: "either",
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
    expect(alert.status).toBe("live");
  });

  it("stays live after triggering and does not re-fire while price stays on the far side", async () => {
    const alert = makeStatic({ level: 100, lastKnownSide: "above" });
    const first = await checkAlerts([alert], fakeMarket({ prices: { TEST: 95 } }), []);
    expect(first.triggered).toHaveLength(1);
    expect(first.revisits).toHaveLength(1);
    expect(alert.status).toBe("live"); // alerts never disarm
    expect(alert.triggerCount).toBe(1);
    expect(alert.lastTriggerPrice).toBe(95);
    expect(alert.lastKnownSide).toBe("below"); // re-armed against the new side

    // Still watched (checked, not skipped), but a further move in the same
    // direction is not a new crossing, so it must stay quiet.
    const second = await checkAlerts([alert], fakeMarket({ prices: { TEST: 90 } }), []);
    expect(second.checked).toBe(1);
    expect(second.triggered).toHaveLength(0);
    expect(second.revisits).toHaveLength(0);
    expect(alert.triggerCount).toBe(1);
  });

  it("fires again on a genuine re-cross when given no revisit history to fold onto", async () => {
    const alert = makeStatic({ level: 100, lastKnownSide: "above" });
    await checkAlerts([alert], fakeMarket({ prices: { TEST: 95 } }), []);
    expect(alert.triggerCount).toBe(1);

    // Back above the level...
    const back = await checkAlerts([alert], fakeMarket({ prices: { TEST: 104 } }), []);
    expect(back.triggered).toHaveLength(1); // crossing up is itself a crossing
    expect(alert.triggerCount).toBe(2);

    // ...and down through it again.
    const again = await checkAlerts([alert], fakeMarket({ prices: { TEST: 96 } }), []);
    expect(again.triggered).toHaveLength(1);
    expect(again.revisits).toHaveLength(1);
    expect(alert.triggerCount).toBe(3);
  });

  it("queues a revisit entry carrying the level and price it fired at", async () => {
    const alert = makeStatic({ level: 100, lastKnownSide: "above" });
    const { revisits } = await checkAlerts([alert], fakeMarket({ prices: { TEST: 95 } }), []);
    expect(revisits[0]).toMatchObject({
      alertId: "s1",
      symbol: "TEST",
      kind: "static",
      levelAtTrigger: 100,
      triggerPrice: 95,
      status: "open",
      suggestedLevel: null, // only a relevel pass fills this in
      priority: null,
    });
  });

  it("does not immediately false-trigger a freshly created static alert (lastKnownSide regression)", async () => {
    // Reproduces the bug: lastKnownSide must reflect price-vs-level, not the
    // anchor-vs-price "side" field, or a brand new alert fires on its very
    // first check even though price never moved.
    const market = fakeMarket({ prices: { TEST: 200 } });
    const added = await addAlert(mkdtempSync(join(tmpdir(), "equity-watch-regress-")) + "/alerts.json", {
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
    expect(alert.status).toBe("live");
  });

  it("snapshots every attribute at trigger time, independent of later mutation", async () => {
    const alert = makeStatic({ level: 100, lastKnownSide: "above" });
    await checkAlerts([alert], fakeMarket({ prices: { TEST: 95 } }), []);

    expect(alert.triggerSnapshot).not.toBeNull();
    const snapshot = alert.triggerSnapshot!;
    expect(snapshot.triggerCount).toBe(0); // pre-trigger state
    expect(snapshot.lastTriggeredAt).toBeNull();
    expect(snapshot.lastTriggerPrice).toBeNull();
    expect(snapshot.triggerSnapshot).toBeNull();
    expect((snapshot as StaticAlert).level).toBe(100);
    // Captured before the re-arm, so it records the side price crossed *from*.
    expect((snapshot as StaticAlert).lastKnownSide).toBe("above");
    expect(alert.lastKnownSide).toBe("below");

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
    const { triggered, revisits } = await checkAlerts([alert], fakeMarket({ prices: { TEST: 100 } }), []); // 97 * 1.03 = 99.91
    expect(triggered).toHaveLength(1);
    expect(alert.status).toBe("live");
    expect(alert.lastTriggerPrice).toBe(100);
    expect(revisits[0].direction).toBe("up"); // a bounce off the low

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

    const { triggered: t3, revisits } = await checkAlerts([alert], fakeMarket({ prices: { TEST: 101 } }), []); // 103 - 2 = 101
    expect(t3).toHaveLength(1);
    expect(alert.status).toBe("live");
    expect(revisits[0].direction).toBe("down"); // a pullback off the high
  });

  describe("directions and reversion folding", () => {
    // 2026-09-11 is a Friday; 14:00Z is 10:00 Eastern.
    const FRI = "2026-09-11T14:00:00.000Z";

    /** One poll at a pinned time against a running copy of the revisit store. */
    function poller(alert: StaticAlert) {
      const store: RevisitEntry[] = [];
      return {
        store,
        async check(price: number, nowIso: string, volume = 0) {
          const result = await checkAlerts(
            [alert],
            fakeMarket({ prices: { TEST: price }, volumes: { TEST: volume } }),
            [],
            "regular",
            undefined,
            undefined,
            undefined,
            { existingRevisits: store, now: new Date(nowIso) }
          );
          store.push(...result.revisits);
          return result;
        },
      };
    }

    it("fires only on crossings in the alert's direction, default up", async () => {
      const alert = makeStatic({ direction: "up", level: 100, lastKnownSide: "above" });
      const p = poller(alert);

      const down = await p.check(95, FRI);
      expect(down.triggered).toHaveLength(0);
      expect(down.revisits).toHaveLength(0);
      expect(alert.lastKnownSide).toBe("below"); // measured from here for the next watched crossing

      const up = await p.check(105, "2026-09-11T15:00:00.000Z");
      expect(up.triggered).toHaveLength(1);
      expect(up.revisits[0]).toMatchObject({ direction: "up", triggerPrice: 105 });
    });

    it("fires a down alert on a downward crossing only", async () => {
      const alert = makeStatic({ direction: "down", level: 100, lastKnownSide: "below" });
      const p = poller(alert);
      expect((await p.check(105, FRI)).triggered).toHaveLength(0);
      const fired = await p.check(95, "2026-09-11T15:00:00.000Z");
      expect(fired.revisits[0]).toMatchObject({ direction: "down", condition: "price crosses below 100" });
    });

    it("folds every crossing inside the window onto the fire instead of queueing new entries", async () => {
      const alert = makeStatic({ direction: "up", level: 100, lastKnownSide: "below" });
      const p = poller(alert);
      const fire = (await p.check(101, FRI)).revisits[0];

      const back = await p.check(99, "2026-09-11T15:00:00.000Z");
      expect(back.triggered).toHaveLength(0);
      expect(back.revisits).toHaveLength(0);
      expect(back.updatedRevisits).toEqual([fire]);
      expect(back.followUps).toHaveLength(1);
      expect(back.followUps[0]).toMatchObject({ reversal: true, followUp: { price: 99, direction: "down", session: "regular" } });
      expect(alert.lastKnownSide).toBe("below");

      const again = await p.check(101, "2026-09-11T16:00:00.000Z");
      expect(again.triggered).toHaveLength(0); // an upward crossing, but inside the window
      expect(again.followUps[0].reversal).toBe(false);

      const monday = await p.check(99, "2026-09-14T14:00:00.000Z");
      expect(monday.followUps[0].reversal).toBe(false); // only the first counter-crossing is the reversal

      expect(p.store).toHaveLength(1);
      expect(fire.followUps).toHaveLength(3);
      expect(reversalOf(fire)?.price).toBe(99);
      expect(endedOnFiredSide(fire)).toBe(false);
      expect(alert.triggerCount).toBe(1);
    });

    it("closes the window after holdDays trading days, counting over the weekend", async () => {
      const alert = makeStatic({ direction: "up", level: 100, lastKnownSide: "below" });
      const p = poller(alert);
      const fire = (await p.check(101, FRI)).revisits[0];

      // Tuesday is trading day 2: still inside.
      expect((await p.check(99, "2026-09-15T15:00:00.000Z")).followUps).toHaveLength(1);

      // Wednesday is day 3: an upward crossing fires on its own.
      const wed = await p.check(101, "2026-09-16T15:00:00.000Z");
      expect(wed.triggered).toHaveLength(1);
      expect(wed.followUps).toHaveLength(0);
      expect(fire.followUps).toHaveLength(1);

      // And later chop folds onto the new fire, not the old one.
      const chop = await p.check(99, "2026-09-16T16:00:00.000Z");
      expect(chop.followUps[0].entry).toBe(wed.revisits[0]);
    });

    it("records nothing for a counter-crossing outside the window", async () => {
      const alert = makeStatic({ direction: "up", level: 100, lastKnownSide: "below" });
      const p = poller(alert);
      await p.check(101, FRI);

      const wed = await p.check(99, "2026-09-16T15:00:00.000Z");
      expect(wed.triggered).toHaveLength(0);
      expect(wed.followUps).toHaveLength(0);
      expect(wed.updatedRevisits).toHaveLength(0);
      expect(p.store[0].followUps).toBeUndefined();
      expect(alert.lastKnownSide).toBe("below");
    });

    it("records follow-ups without waiting on volume, and still gates the next real fire on it", async () => {
      const alert = makeStatic({
        direction: "up",
        level: 100,
        lastKnownSide: "below",
        volumeCondition: { threshold: 1_000_000, mode: "today" },
      });
      const p = poller(alert);
      expect((await p.check(101, FRI, 2_000_000)).triggered).toHaveLength(1);
      expect(alert.mutedUntil).not.toBeNull();

      // Inside the window, muted, and with no volume: both crossings still fold.
      expect((await p.check(99, "2026-09-11T15:00:00.000Z", 0)).followUps).toHaveLength(1);
      expect((await p.check(101, "2026-09-11T16:00:00.000Z", 0)).followUps).toHaveLength(1);
      expect(alert.lastKnownSide).toBe("above");

      // Outside the window (and the mute), a watched crossing waits on volume as before.
      await p.check(99, "2026-09-16T14:00:00.000Z", 0);
      const pending = await p.check(101, "2026-09-16T15:00:00.000Z", 200_000);
      expect(pending.triggered).toHaveLength(0);
      expect(alert.lastKnownSide).toBe("below"); // left stale: the crossing is pending
      const confirmed = await p.check(101.5, "2026-09-16T16:00:00.000Z", 1_500_000);
      expect(confirmed.triggered).toHaveLength(1);
      expect(p.store).toHaveLength(2);
    });

    it("lets a mute stop a fire but not a counter-crossing from moving lastKnownSide", async () => {
      const alert = makeStatic({ direction: "up", level: 100, lastKnownSide: "above", mutedUntil: "2026-09-30T00:00:00.000Z" });
      const p = poller(alert);

      await p.check(99, "2026-09-16T14:00:00.000Z");
      expect(alert.lastKnownSide).toBe("below");

      const muted = await p.check(101, "2026-09-16T15:00:00.000Z");
      expect(muted.triggered).toHaveLength(0);
      expect(alert.lastKnownSide).toBe("below"); // pending until the mute lapses

      const lapsed = await p.check(101, "2026-10-01T15:00:00.000Z");
      expect(lapsed.triggered).toHaveLength(1);
    });

    it("does not fold a crossing of a re-levelled alert onto a fire at its old level", async () => {
      const alert = makeStatic({ direction: "up", level: 100, lastKnownSide: "below" });
      const p = poller(alert);
      await p.check(101, FRI);

      alert.level = 110; // what `alert revisit apply` does
      alert.lastKnownSide = "below";
      const fired = await p.check(111, "2026-09-11T16:00:00.000Z");
      expect(fired.triggered).toHaveLength(1);
      expect(fired.followUps).toHaveLength(0);
    });
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
      expect(alert.status).toBe("live");
    });

    it("mutes itself for the rest of the day rather than re-firing every check", async () => {
      // A volume threshold, once crossed, stays crossed for the session. Price
      // crossings self-limit via lastKnownSide; volume has no such mechanism,
      // so without the mute this would fire on every poll until midnight.
      const alert = makeVolume({ volume: { threshold: 1_000_000, mode: "today" } });
      const market = fakeMarket({ prices: { TEST: 100 }, volumes: { TEST: 1_200_000 } });

      const first = await checkAlerts([alert], market, []);
      expect(first.triggered).toHaveLength(1);
      expect(alert.mutedUntil).not.toBeNull();
      expect(alert.status).toBe("live");

      const second = await checkAlerts([alert], market, []);
      expect(second.triggered).toHaveLength(0);
      expect(second.revisits).toHaveLength(0);
      expect(alert.triggerCount).toBe(1);

      // Once the mute lapses it is eligible again without any manual re-arming.
      alert.mutedUntil = "2020-01-01T00:00:00.000Z";
      const third = await checkAlerts([alert], market, []);
      expect(third.triggered).toHaveLength(1);
      expect(alert.triggerCount).toBe(2);
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
      expect(alert.status).toBe("live");
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
      expect(alert.status).toBe("live");

      const { triggered } = await checkAlerts([alert], fakeMarket({ prices: { TEST: 94 }, volumes: { TEST: 1_500_000 } }), []);
      expect(triggered).toHaveLength(1);
      expect(alert.status).toBe("live");
    });

    it("cancels a pending static crossing if price reverts before volume catches up", async () => {
      const alert = makeStatic({
        level: 100,
        lastKnownSide: "above",
        volumeCondition: { threshold: 1_000_000, mode: "today" },
      });
      await checkAlerts([alert], fakeMarket({ prices: { TEST: 95 }, volumes: { TEST: 200_000 } }), []);
      expect(alert.status).toBe("live");

      // Price reverts back above the level before volume ever qualified.
      const { triggered } = await checkAlerts([alert], fakeMarket({ prices: { TEST: 105 }, volumes: { TEST: 300_000 } }), []);
      expect(triggered).toHaveLength(0);
      expect(alert.status).toBe("live");

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
      expect(alert.status).toBe("live");

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
    dir = mkdtempSync(join(tmpdir(), "equity-watch-test-"));
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

  it("watches upward crossings unless told otherwise", async () => {
    const market = fakeMarket({ prices: { TEST: 100 } });
    const plain = await addAlert(path, { kind: "static", symbol: "TEST", level: 110 }, market);
    expect((plain.added as StaticAlert).direction).toBe("up");
    const down = await addAlert(path, { kind: "static", symbol: "TEST", level: 90, direction: "down" }, market);
    expect((down.added as StaticAlert).direction).toBe("down");
    expect(loadAlerts(path).map((a) => (a as StaticAlert).direction)).toEqual(["up", "down"]);
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
    expect(replacement.status).toBe("live");
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
    expect(untouched.status).toBe("live");
  });

  it("lets above and below alerts coexist on the same symbol", async () => {
    const market = fakeMarket({ prices: { TEST: 100 } });
    const below = await addAlert(path, { kind: "static", symbol: "TEST", level: 90 }, market);
    const above = await addAlert(path, { kind: "static", symbol: "TEST", level: 110 }, market);

    expect(below.rejectedReason).toBeNull();
    expect(above.rejectedReason).toBeNull();

    const stored: Alert[] = loadAlerts(path);
    expect(stored.filter((a) => a.status === "live")).toHaveLength(2);
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
    expect(stored.filter((a) => a.status === "live")).toHaveLength(2);
  });

  it("lets multiple volume-only alerts coexist on the same symbol regardless of threshold", async () => {
    const market = fakeMarket({ prices: { TEST: 100 } });
    const first = await addAlert(path, { kind: "volume", symbol: "TEST", volume: { threshold: 500_000, mode: "today" } }, market);
    const second = await addAlert(path, { kind: "volume", symbol: "TEST", volume: { threshold: 5_000_000, mode: "today" } }, market);
    expect(first.rejectedReason).toBeNull();
    expect(second.rejectedReason).toBeNull();

    const stored = loadAlerts(path);
    expect(stored.filter((a) => a.status === "live")).toHaveLength(2);
  });
});

describe("editAlert", () => {
  let dir: string;
  let path: string;
  /** Edits that don't move a level must not need a quote. */
  const offline: MarketData = {
    ...fakeMarket({}),
    getQuotes: async () => {
      throw new Error("no quotes offline");
    },
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "equity-watch-edit-"));
    path = join(dir, "alerts.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function addMa(trigger: "cross" | "touch"): Promise<string> {
    const result = await addAlert(
      path,
      { kind: "ma", symbol: "TEST", maType: "sma", period: 50, timeframe: "1D", trigger, from: "either", marginPct: 0.25 },
      fakeMarket({ prices: { TEST: 100 } })
    );
    return result.added!.id;
  }

  it("moves a static level in place, keeping its id, watch start, and trigger history", async () => {
    saveAlerts(path, [
      makeStatic({
        level: 100,
        side: "below",
        lastKnownSide: "above",
        direction: "up",
        triggerCount: 2,
        lastTriggeredAt: "2026-09-01T14:00:00.000Z",
        mutedUntil: "2099-01-01T00:00:00.000Z",
        volumeCondition: { threshold: 1_000_000, mode: "today" },
        watchingSince: "2026-07-01T00:00:00.000Z",
      }),
    ]);
    const result = await editAlert(path, "s1", { level: 120 }, fakeMarket({ prices: { TEST: 110 } }));
    expect(result.rejectedReason).toBeNull();
    expect((result.before as StaticAlert).level).toBe(100);

    const [stored] = loadAlerts(path) as StaticAlert[];
    expect(stored).toMatchObject({
      id: "s1",
      level: 120,
      side: "above",
      lastKnownSide: "below",
      direction: "up",
      triggerCount: 2,
      lastTriggeredAt: "2026-09-01T14:00:00.000Z",
      mutedUntil: null,
      watchingSince: "2026-07-01T00:00:00.000Z",
    });
  });

  it("changes direction and the volume condition without a quote", async () => {
    saveAlerts(path, [makeStatic()]);
    const result = await editAlert(path, "s1", { direction: "down", volume: { ratio: 2, mode: "today" } }, offline);
    expect(result.rejectedReason).toBeNull();
    expect(loadAlerts(path)[0]).toMatchObject({ level: 100, direction: "down", volumeCondition: { ratio: 2, mode: "today" } });
  });

  it("clears a volume condition along with its mute", async () => {
    saveAlerts(path, [
      makeStatic({ volumeCondition: { threshold: 1_000_000, mode: "today" }, mutedUntil: "2099-01-01T00:00:00.000Z" }),
    ]);
    await editAlert(path, "s1", { volume: null }, offline);
    const [stored] = loadAlerts(path) as StaticAlert[];
    expect(stored.volumeCondition).toBeUndefined();
    expect(stored.mutedUntil).toBeNull();
  });

  it("changes a trailing alert's trail but keeps its watermark", async () => {
    saveAlerts(path, [makeTrailing()]);
    const before = loadAlerts(path)[0] as TrailingAlert;
    await editAlert(path, before.id, { trail: { type: "amount", value: 2 } }, offline);
    const [stored] = loadAlerts(path) as TrailingAlert[];
    expect(stored).toMatchObject({ trailType: "amount", trailValue: 2, extremePrice: before.extremePrice });
  });

  it("rejects a level equal to the live price and saves nothing", async () => {
    saveAlerts(path, [makeStatic()]);
    const result = await editAlert(path, "s1", { level: 110, direction: "down" }, fakeMarket({ prices: { TEST: 110 } }));
    expect(result.rejectedReason).toMatch(/equals the live price/);
    expect(loadAlerts(path)[0]).toMatchObject({ level: 100, direction: "either" });
  });

  it("rejects fields the alert's kind doesn't have", async () => {
    saveAlerts(path, [makeStatic(), makeVolume()]);
    const trail = await editAlert(path, "s1", { trail: { type: "percent", value: 3 } }, offline);
    expect(trail.rejectedReason).toMatch(/static alert has no trail/);
    const volumeId = loadAlerts(path)[1].id;
    const cleared = await editAlert(path, volumeId, { volume: null }, offline);
    expect(cleared.rejectedReason).toMatch(/can't lose its volume condition/);
  });

  it("rejects unknown and cancelled alerts, and empty edits", async () => {
    saveAlerts(path, [makeStatic({ status: "cancelled" }), makeStatic({ id: "s2" })]);
    expect((await editAlert(path, "nope", { direction: "up" }, offline)).rejectedReason).toMatch(/No alert with id nope/);
    expect((await editAlert(path, "s1", { direction: "up" }, offline)).rejectedReason).toMatch(/is cancelled/);
    expect((await editAlert(path, "s2", {}, offline)).rejectedReason).toMatch(/Nothing to change/);
  });

  it("accepts a ticker in place of the id when it has a single live alert", async () => {
    // The cancelled alert on TEST doesn't make the ticker ambiguous.
    saveAlerts(path, [makeStatic({ id: "old", status: "cancelled" }), makeStatic({ id: "s1" }), makeStatic({ id: "o1", symbol: "OTHER" })]);
    const result = await editAlert(path, "test", { direction: "down" }, offline);
    expect(result.rejectedReason).toBeNull();
    expect(result.edited?.id).toBe("s1");
  });

  it("refuses a ticker with several live alerts, listing their ids", async () => {
    saveAlerts(path, [makeStatic({ id: "s1" }), makeVolume({ id: "v1", symbol: "TEST" })]);
    const result = await editAlert(path, "TEST", { direction: "down" }, offline);
    expect(result.rejectedReason).toBe("TEST has 2 live alerts (s1, v1); give the id.");
  });

  it("prefers an id match over a ticker", async () => {
    saveAlerts(path, [makeStatic({ id: "AAPL", symbol: "TEST" }), makeStatic({ id: "s2", symbol: "AAPL" })]);
    expect((await editAlert(path, "AAPL", { direction: "down" }, offline)).edited?.symbol).toBe("TEST");
  });

  it("removes by ticker only when the ticker names a single live alert", async () => {
    saveAlerts(path, [makeStatic({ id: "s1" }), makeStatic({ id: "o1", symbol: "OTHER" }), makeStatic({ id: "o2", symbol: "OTHER" })]);
    expect(removeAlert(path, "OTHER").error).toMatch(/2 live alerts/);
    expect(removeAlert(path, "TEST").alert?.id).toBe("s1");
    expect(loadAlerts(path).map((a) => a.id)).toEqual(["o1", "o2"]);
  });

  it("rejects a moved level farther from price than another alert on that side", async () => {
    saveAlerts(path, [
      makeStatic({ id: "near", level: 105, side: "above", lastKnownSide: "below" }),
      makeStatic({ id: "far", level: 90, side: "below", lastKnownSide: "above" }),
    ]);
    const result = await editAlert(path, "far", { level: 120 }, fakeMarket({ prices: { TEST: 100 } }));
    expect(result.rejectedReason).toMatch(/near .* already closer/);
    expect(loadAlerts(path).map((a) => [a.id, a.status, (a as StaticAlert).level])).toEqual([
      ["near", "live", 105],
      ["far", "live", 90],
    ]);
  });

  it("cancels the other alert on that side when the moved level is closer", async () => {
    saveAlerts(path, [
      makeStatic({ id: "near", level: 105, side: "above", lastKnownSide: "below" }),
      makeStatic({ id: "far", level: 90, side: "below", lastKnownSide: "above" }),
    ]);
    const result = await editAlert(path, "far", { level: 102 }, fakeMarket({ prices: { TEST: 100 } }));
    expect(result.replaced?.id).toBe("near");
    expect(loadAlerts(path).map((a) => [a.id, a.status])).toEqual([
      ["near", "cancelled"],
      ["far", "live"],
    ]);
  });

  it("restarts a moving average's evaluation when the average changes", async () => {
    const id = await addMa("cross");
    const alerts = loadAlerts(path) as MaAlert[];
    Object.assign(alerts[0], {
      lastSide: "above",
      inBand: true,
      lastLevel: 98,
      lastEvaluatedAt: "2026-09-14T15:00:00.000Z",
      lastFiredBucket: "2026-09-12",
    });
    saveAlerts(path, alerts);

    const result = await editAlert(path, id, { ma: { maType: "ema", period: 20, timeframe: "1D" }, direction: "up" }, offline);
    expect(result.rejectedReason).toBeNull();
    expect(loadAlerts(path)[0]).toMatchObject({
      maType: "ema",
      period: 20,
      from: "below",
      lastSide: null,
      inBand: false,
      lastLevel: null,
      lastEvaluatedAt: null,
      lastFiredBucket: null,
    });
  });

  it("keeps cross and touch settings apart on moving averages", async () => {
    const touch = await addMa("touch");
    expect((await editAlert(path, touch, { direction: "up" }, offline)).rejectedReason).toMatch(/touch alert has no direction/);
    expect((await editAlert(path, touch, { marginPct: 0.5, from: "above" }, offline)).rejectedReason).toBeNull();

    const cross = await addMa("cross");
    expect((await editAlert(path, cross, { from: "above" }, offline)).rejectedReason).toMatch(/cross alert has no touch margin/);
    expect((await editAlert(path, cross, { direction: "either" }, offline)).rejectedReason).toMatch(/not either/);
  });
});
