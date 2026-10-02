import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MarketData } from "../src/alerts/engine.js";
import { addAlert, checkAlerts, editAlert } from "../src/alerts/engine.js";
import { effectiveTrigger, type Alert, type MaAlert, type StaticAlert, type TrailingAlert, type VolumeAlert } from "../src/alerts/models.js";
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

/** A one-minute bar at an exact instant, for tests that pin the clock. */
function minuteBar(iso: string, close: number, volume: number): PriceBar {
  return { date: new Date(iso), open: close, high: close, low: close, close, volume };
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
        async check(price: number, nowIso: string, volume = 0, intradayBars: PriceBar[] = []) {
          const result = await checkAlerts(
            [alert],
            fakeMarket({ prices: { TEST: price }, volumes: { TEST: volume }, intradayBars: { TEST: intradayBars } }),
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
      // Crossed the day before; all of Friday's volume came after it.
      const alert = makeStatic({
        direction: "up",
        level: 100,
        lastKnownSide: "above",
        volumeCondition: { threshold: 1_000_000, mode: "today" },
        primed: { at: "2026-09-10T15:00:00.000Z", price: 101, direction: "up" },
      });
      const p = poller(alert);
      expect((await p.check(101, FRI, 2_000_000)).triggered).toHaveLength(1);
      expect(alert.mutedUntil).not.toBeNull();

      // Inside the window, muted, and with no volume: both crossings still fold.
      expect((await p.check(99, "2026-09-11T15:00:00.000Z", 0)).followUps).toHaveLength(1);
      expect((await p.check(101, "2026-09-11T16:00:00.000Z", 0)).followUps).toHaveLength(1);
      expect(alert.lastKnownSide).toBe("above");

      // Outside the window (and the mute), a watched crossing primes the alert
      // and waits on volume traded after it.
      await p.check(99, "2026-09-16T14:00:00.000Z", 0);
      const pending = await p.check(101, "2026-09-16T15:00:00.000Z", 200_000);
      expect(pending.triggered).toHaveLength(0);
      expect(alert.primed).toEqual({ at: "2026-09-16T15:00:00.000Z", price: 101, direction: "up" });
      expect(alert.lastKnownSide).toBe("above");

      // Today's 1.5M includes the morning, before the crossing. Only the 400K since counts.
      const after = [minuteBar("2026-09-16T15:30:00.000Z", 101.5, 400_000)];
      expect((await p.check(101.5, "2026-09-16T16:00:00.000Z", 1_500_000, after)).triggered).toHaveLength(0);

      after.push(minuteBar("2026-09-16T16:30:00.000Z", 101.5, 700_000));
      const confirmed = await p.check(101.5, "2026-09-16T17:00:00.000Z", 2_500_000, after);
      expect(confirmed.triggered).toHaveLength(1);
      expect(p.store).toHaveLength(2);
      // Fired when the volume arrived; the crossing is kept beside it.
      expect(p.store[1]).toMatchObject({
        triggeredAt: "2026-09-16T17:00:00.000Z",
        triggerPrice: 101.5,
        direction: "up",
        priceMet: { at: "2026-09-16T15:00:00.000Z", price: 101 },
        volume: { observed: 1_100_000, required: 1_000_000, since: "2026-09-16T15:00:00.000Z" },
      });
      expect(alert.primed).toBeNull();
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

  describe("price, then volume", () => {
    // 11:00 Eastern on Wednesday 2026-09-16, then later that day, then Thursday.
    const CROSS = "2026-09-16T15:00:00.000Z";
    const LATER = "2026-09-16T16:00:00.000Z";
    const NEXT_DAY = "2026-09-17T15:00:00.000Z";
    const checkAt = (alert: Alert, nowIso: string, price: number, volume: number, intradayBars: PriceBar[] = [], baseline: number | null = null) =>
      checkAlerts(
        [alert],
        fakeMarket({ prices: { TEST: price }, volumes: { TEST: volume }, intradayBars: { TEST: intradayBars } }),
        [],
        "regular",
        undefined,
        async () => baseline,
        undefined,
        { now: new Date(nowIso) }
      );
    const withVolume = (overrides: Partial<StaticAlert> = {}) =>
      makeStatic({ level: 100, direction: "down", lastKnownSide: "above", volumeCondition: { threshold: 1_000_000, mode: "today" }, ...overrides });

    it("primes on the crossing and ignores volume traded before it", async () => {
      const alert = withVolume();
      // Five million today, all of it before the crossing this check found.
      const { triggered } = await checkAt(alert, CROSS, 95, 5_000_000);
      expect(triggered).toHaveLength(0);
      expect(alert.primed).toEqual({ at: CROSS, price: 95, direction: "down" });
      expect(alert.lastKnownSide).toBe("below");
    });

    it("fires once volume after the crossing qualifies, while price is still across", async () => {
      const alert = withVolume();
      await checkAt(alert, CROSS, 95, 200_000);
      const { triggered, revisits } = await checkAt(alert, LATER, 94, 1_500_000, [minuteBar("2026-09-16T15:30:00.000Z", 94, 1_200_000)]);
      expect(triggered).toHaveLength(1);
      expect(revisits[0]).toMatchObject({ triggeredAt: LATER, triggerPrice: 94, priceMet: { at: CROSS, price: 95 } });
      expect(alert.primed).toBeNull();
    });

    it("fires as of the crossing when the volume came in the same check", async () => {
      const alert = withVolume({ lastEvaluatedAt: "2026-09-16T14:50:00.000Z" });
      const bars = [minuteBar("2026-09-16T14:55:00.000Z", 95, 10_000), minuteBar("2026-09-16T14:57:00.000Z", 95, 1_100_000)];
      const { revisits } = await checkAt(alert, CROSS, 95, 3_000_000, bars);
      expect(revisits).toHaveLength(1);
      expect(revisits[0].triggeredAt).toBe("2026-09-16T14:55:00.000Z");
      expect(revisits[0]).not.toHaveProperty("priceMet");
    });

    it("counts a whole later day, since all of it came after the crossing", async () => {
      const alert = withVolume();
      await checkAt(alert, CROSS, 95, 200_000);
      const { triggered, revisits } = await checkAt(alert, NEXT_DAY, 96, 1_200_000);
      expect(triggered).toHaveLength(1);
      expect(revisits[0].volume).not.toHaveProperty("since");
    });

    it("forgets the crossing if price reverts before volume catches up", async () => {
      const alert = withVolume();
      await checkAt(alert, CROSS, 95, 200_000);
      const { triggered } = await checkAt(alert, LATER, 105, 300_000);
      expect(triggered).toHaveLength(0);
      expect(alert.primed).toBeNull();
      // Ample volume without a fresh crossing is nothing.
      expect((await checkAt(alert, NEXT_DAY, 106, 5_000_000)).triggered).toHaveLength(0);
    });

    it("holds a ratio after the crossing to normal volume for the same stretch of the day", async () => {
      const alert = withVolume({ volumeCondition: { ratio: 2, mode: "today" } });
      await checkAt(alert, CROSS, 95, 0);
      // 11:00-12:00 Eastern normally trades 100K; a full day's normal would be far more.
      const history = ["2026-09-11", "2026-09-14", "2026-09-15"].map((d) => minuteBar(`${d}T15:30:00.000Z`, 120, 100_000));
      const short = await checkAt(alert, LATER, 94, 0, [...history, minuteBar("2026-09-16T15:30:00.000Z", 94, 150_000)], 5_000_000);
      expect(short.triggered).toHaveLength(0);
      const enough = await checkAt(alert, LATER, 94, 0, [...history, minuteBar("2026-09-16T15:30:00.000Z", 94, 250_000)], 5_000_000);
      expect(enough.triggered).toHaveLength(1);
      expect(enough.revisits[0].volume).toMatchObject({ observed: 250_000, required: 200_000, basis: "ratio" });
    });

    it("primes a trailing alert, and drops it when price falls back out of reach", async () => {
      const alert = makeTrailing({
        side: "below",
        extremePrice: 97,
        trailType: "percent",
        trailValue: 3,
        volumeCondition: { threshold: 1_000_000, mode: "today" },
      });
      expect((await checkAt(alert, CROSS, 100, 3_000_000)).triggered).toHaveLength(0);
      expect(alert.primed).toMatchObject({ at: CROSS, price: 100, direction: "up" });

      const { triggered } = await checkAt(alert, LATER, 100.5, 3_500_000, [minuteBar("2026-09-16T15:30:00.000Z", 100.5, 1_000_000)]);
      expect(triggered).toHaveLength(1);
      expect(alert.extremePrice).toBe(100.5); // trails afresh from where price is

      const again = makeTrailing({ side: "below", extremePrice: 97, trailType: "percent", trailValue: 3, volumeCondition: { threshold: 1_000_000, mode: "today" } });
      await checkAt(again, CROSS, 100, 0);
      await checkAt(again, LATER, 98, 0, [minuteBar("2026-09-16T15:30:00.000Z", 98, 5_000_000)]);
      expect(again.primed).toBeNull();
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

  it("starts a trailing alert from the live price, watching the low for direction up", async () => {
    const result = await addAlert(
      path,
      { kind: "trailing", symbol: "TEST", direction: "up", trailType: "percent", trailValue: 5 },
      fakeMarket({ prices: { TEST: 100 } })
    );
    expect(result.rejectedReason).toBeNull();
    const added = result.added as TrailingAlert;
    expect(added.side).toBe("below");
    expect(added.extremePrice).toBe(100);
    expect(effectiveTrigger(added)).toBe(105);
  });

  it("watches the high for a trailing alert with direction down", async () => {
    const result = await addAlert(
      path,
      { kind: "trailing", symbol: "TEST", direction: "down", trailType: "amount", trailValue: 2 },
      fakeMarket({ prices: { TEST: 100 } })
    );
    const added = result.added as TrailingAlert;
    expect(added.side).toBe("above");
    expect(effectiveTrigger(added)).toBe(98);
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
      { kind: "trailing", symbol: "TEST", direction: "up", trailType: "amount", trailValue: 1 },
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
      { kind: "trailing", symbol: "TEST", direction: "up", trailType: "amount", trailValue: 1 },
      market
    );

    const farther = await addAlert(path, { kind: "static", symbol: "TEST", level: 80 }, market);
    expect(farther.added).toBeNull();
    expect(farther.rejectedReason).toMatch(/already closer/);

    const stored = loadAlerts(path);
    const untouched = stored.find((a) => a.id === close.added!.id)!;
    expect(untouched.status).toBe("live");
  });

  it("replaces a nearer alert anyway when the caller asks to (a typed add, not a bulk seed)", async () => {
    const market = fakeMarket({ prices: { TEST: 100 } });
    const close = await addAlert(path, { kind: "static", symbol: "TEST", level: 95 }, market);

    const farther = await addAlert(path, { kind: "static", symbol: "TEST", level: 80 }, market, { onConflict: "replace" });
    expect(farther.rejectedReason).toBeNull();
    expect(farther.replaced?.id).toBe(close.added!.id);

    const stored = loadAlerts(path);
    expect(stored.find((a) => a.id === close.added!.id)!.status).toBe("cancelled");
    expect(stored.find((a) => a.id === farther.added!.id)!.status).toBe("live");
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
    const maId = await addMa("cross");
    const trail = await editAlert(path, maId, { trail: { type: "percent", value: 3 } }, offline);
    expect(trail.rejectedReason).toMatch(/ma alert has no trail/);
    const volumeId = loadAlerts(path)[1].id;
    const cleared = await editAlert(path, volumeId, { volume: null }, offline);
    expect(cleared.rejectedReason).toMatch(/can't lose its volume condition/);
  });

  it("turns a static alert trailing from the live price, keeping id, history and volume", async () => {
    saveAlerts(path, [makeStatic({ level: 100, side: "below", triggerCount: 2, volumeCondition: { ratio: 2, mode: "today" } })]);
    const result = await editAlert(path, "s1", { trail: { type: "percent", value: 5 }, direction: "up" }, fakeMarket({ prices: { TEST: 70 } }));
    expect(result.rejectedReason).toBeNull();
    const [stored] = loadAlerts(path) as TrailingAlert[];
    expect(stored).toMatchObject({
      id: "s1",
      kind: "trailing",
      side: "below",
      trailType: "percent",
      trailValue: 5,
      extremePrice: 70,
      near: 70,
      triggerCount: 2,
      volumeCondition: { ratio: 2, mode: "today" },
    });
    expect(stored).not.toHaveProperty("level");
    expect(stored).not.toHaveProperty("lastKnownSide");
    expect(effectiveTrigger(stored)).toBe(73.5);
  });

  it("needs up or down to make an alert trailing", async () => {
    saveAlerts(path, [makeStatic()]);
    const market = fakeMarket({ prices: { TEST: 70 } });
    const none = await editAlert(path, "s1", { trail: { type: "percent", value: 5 } }, market);
    expect(none.rejectedReason).toMatch(/Give the direction/);
    const either = await editAlert(path, "s1", { trail: { type: "percent", value: 5 }, direction: "either" }, market);
    expect(either.rejectedReason).toMatch(/Give the direction/);
    expect(loadAlerts(path)[0].kind).toBe("static");
  });

  it("turns a volume alert trailing, with its volume as the AND condition", async () => {
    saveAlerts(path, [makeVolume({ volume: { threshold: 1_000_000, mode: "today" } })]);
    await editAlert(path, "v1", { trail: { type: "amount", value: 2 }, direction: "down" }, fakeMarket({ prices: { TEST: 50 } }));
    const [stored] = loadAlerts(path) as TrailingAlert[];
    expect(stored).toMatchObject({ kind: "trailing", side: "above", trailType: "amount", volumeCondition: { threshold: 1_000_000, mode: "today" } });
    expect(stored).not.toHaveProperty("volume");
  });

  it("turns a trailing alert back into a level", async () => {
    saveAlerts(path, [makeTrailing({ volumeCondition: { ratio: 2, mode: "today" } })]);
    const result = await editAlert(path, "t1", { level: 120, direction: "up" }, fakeMarket({ prices: { TEST: 110 } }));
    expect(result.rejectedReason).toBeNull();
    const [stored] = loadAlerts(path) as StaticAlert[];
    expect(stored).toMatchObject({ kind: "static", level: 120, side: "above", direction: "up", lastKnownSide: "below", volumeCondition: { ratio: 2, mode: "today" } });
    expect(stored).not.toHaveProperty("extremePrice");
  });

  it("turns a trailing alert with volume into a volume alert, without a quote", async () => {
    const added = await addAlert(
      path,
      { kind: "trailing", symbol: "TEST", direction: "up", trailType: "percent", trailValue: 3, volume: { ratio: 2, mode: "today" } },
      fakeMarket({ prices: { TEST: 100 } })
    );
    const result = await editAlert(path, added.added!.id, { level: null, volume: { threshold: 2_000_000, mode: "today" } }, offline);
    expect(result.rejectedReason).toBeNull();
    const [stored] = loadAlerts(path);
    expect(stored).toMatchObject({ id: added.added!.id, kind: "volume", volume: { threshold: 2_000_000, mode: "today" } });
    for (const gone of ["side", "near", "trailType", "trailValue", "extremePrice", "volumeCondition", "lastEvaluatedAt"]) expect(stored).not.toHaveProperty(gone);
  });

  it("won't drop a trailing alert's price condition with nothing left to watch, or with a trail", async () => {
    const added = await addAlert(path, { kind: "trailing", symbol: "TEST", direction: "up", trailType: "percent", trailValue: 3 }, fakeMarket({ prices: { TEST: 100 } }));
    const id = added.added!.id;
    expect((await editAlert(path, id, { level: null }, offline)).rejectedReason).toMatch(/would watch nothing/);
    const both = await editAlert(path, id, { level: null, trail: { type: "percent", value: 4 }, volume: { ratio: 2, mode: "today" } }, offline);
    expect(both.rejectedReason).toMatch(/not both/);
    expect(loadAlerts(path)[0].kind).toBe("trailing");
  });

  it("restarts a trailing alert from the live price when its direction flips", async () => {
    saveAlerts(path, [makeTrailing({ side: "below", extremePrice: 90 })]);
    await editAlert(path, "t1", { direction: "down" }, fakeMarket({ prices: { TEST: 100 } }));
    const [stored] = loadAlerts(path) as TrailingAlert[];
    expect(stored).toMatchObject({ side: "above", extremePrice: 100, near: 100 });
    // The same direction again changes nothing, and needs no quote.
    const same = await editAlert(path, "t1", { direction: "down" }, offline);
    expect(same.rejectedReason).toBeNull();
    expect((loadAlerts(path)[0] as TrailingAlert).extremePrice).toBe(100);
  });

  it("won't make an alert trailing over a nearer one on that side", async () => {
    saveAlerts(path, [makeStatic({ id: "s1", level: 120, side: "above" }), makeStatic({ id: "s2", level: 99, side: "below", lastKnownSide: "above" })]);
    // Trailing up watches from below, where s2 sits 1 away; a 5% trail sits 5 away.
    const result = await editAlert(path, "s1", { trail: { type: "percent", value: 5 }, direction: "up" }, fakeMarket({ prices: { TEST: 100 } }));
    expect(result.rejectedReason).toMatch(/s2 .* already closer/);
    expect(loadAlerts(path).map((a) => a.kind)).toEqual(["static", "static"]);
  });

  // Price and volume are one form on the page, so an edit can move an alert
  // between static and volume-only, keeping its id and history.
  it("gives a volume alert a level, making it static with its volume as the AND condition", async () => {
    saveAlerts(path, [makeVolume({ volume: { ratio: 2, mode: "today" }, triggerCount: 3, mutedUntil: "2099-01-01T00:00:00.000Z" })]);
    const result = await editAlert(path, "v1", { level: 120, direction: "either" }, fakeMarket({ prices: { TEST: 110 } }));
    expect(result.rejectedReason).toBeNull();
    expect(result.before?.kind).toBe("volume");
    expect(loadAlerts(path)).toEqual([
      expect.objectContaining({
        id: "v1",
        kind: "static",
        level: 120,
        side: "above",
        lastKnownSide: "below",
        direction: "either",
        volumeCondition: { ratio: 2, mode: "today" },
        triggerCount: 3,
        mutedUntil: null,
      }),
    ]);
    expect(loadAlerts(path)[0]).not.toHaveProperty("volume");
  });

  it("can swap a volume alert's volume for a plain price level in one edit", async () => {
    saveAlerts(path, [makeVolume()]);
    await editAlert(path, "v1", { level: 90, volume: null }, fakeMarket({ prices: { TEST: 110 } }));
    const [stored] = loadAlerts(path) as StaticAlert[];
    expect(stored).toMatchObject({ kind: "static", level: 90, side: "below", direction: "up" });
    expect(stored.volumeCondition).toBeUndefined();
  });

  it("drops a static alert's level, leaving its volume condition as a volume alert", async () => {
    saveAlerts(path, [makeStatic({ volumeCondition: { threshold: 1_000_000, mode: "today" }, triggerCount: 2 })]);
    const result = await editAlert(path, "s1", { level: null, volume: { ratio: 3, mode: "today" } }, offline);
    expect(result.rejectedReason).toBeNull();
    expect(loadAlerts(path)).toEqual([expect.objectContaining({ id: "s1", kind: "volume", volume: { ratio: 3, mode: "today" }, triggerCount: 2 })]);
    expect(loadAlerts(path)[0]).not.toHaveProperty("level");
  });

  it.each([
    ["a static alert with no volume losing its level", () => makeStatic(), { level: null }, /would watch nothing/],
    ["a static alert losing both", () => makeStatic({ volumeCondition: { ratio: 2, mode: "today" } }), { level: null, volume: null }, /would watch nothing/],
    ["a direction on a dropped level", () => makeStatic({ volumeCondition: { ratio: 2, mode: "today" } }), { level: null, direction: "down" as const }, /direction needs a level/],
    ["a volume alert given only a direction", () => makeVolume(), { direction: "down" as const }, /no direction. Give it a level/],
    ["a volume alert losing a level it doesn't have", () => makeVolume(), { level: null }, /no price level to remove/],
  ])("rejects %s and saves nothing", async (_name, make, edit, reason) => {
    const alert = make();
    saveAlerts(path, [alert]);
    const before = loadAlerts(path);
    const result = await editAlert(path, alert.id, edit, offline);
    expect(result.rejectedReason).toMatch(reason);
    expect(loadAlerts(path)).toEqual(before);
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

  it("turns a static alert into a moving-average cross, keeping id and history, without a quote", async () => {
    saveAlerts(path, [makeStatic({ level: 100, triggerCount: 2, volumeCondition: { ratio: 2, mode: "today" } })]);
    const result = await editAlert(path, "s1", { ma: { maType: "sma", period: 200, timeframe: "1D" }, direction: "up" }, offline);
    expect(result.rejectedReason).toBeNull();
    const [stored] = loadAlerts(path) as MaAlert[];
    expect(stored).toMatchObject({
      id: "s1",
      kind: "ma",
      maType: "sma",
      period: 200,
      timeframe: "1D",
      trigger: "cross",
      from: "below",
      triggerCount: 2,
      lastSide: null,
      lastEvaluatedAt: null,
    });
    for (const gone of ["level", "side", "direction", "lastKnownSide"]) expect(stored).not.toHaveProperty(gone);
    // A cross keeps the volume condition: it waits for volume after the cross.
    expect(stored.volumeCondition).toEqual({ ratio: 2, mode: "today" });
    expect(result.before?.kind).toBe("static");
  });

  it("gives a moving-average cross a volume condition, but refuses one on a touch", async () => {
    const cross = await addMa("cross");
    expect((await editAlert(path, cross, { volume: { threshold: 2_000_000, mode: "today" } }, offline)).rejectedReason).toBeNull();
    expect(loadAlerts(path).find((a) => a.id === cross)).toMatchObject({ volumeCondition: { threshold: 2_000_000, mode: "today" } });
    const touch = await addMa("touch");
    expect((await editAlert(path, touch, { volume: { threshold: 2_000_000, mode: "today" } }, offline)).rejectedReason).toMatch(/touch can't have a volume condition/);
  });

  it("keeps a waiting crossing through a volume change, and drops it on any other edit", async () => {
    const primed = { at: "2026-09-16T15:00:00.000Z", price: 101, direction: "up" as const };
    saveAlerts(path, [makeStatic({ level: 100, volumeCondition: { ratio: 2, mode: "today" }, primed })]);
    await editAlert(path, "s1", { volume: { ratio: 3, mode: "today" } }, offline);
    expect((loadAlerts(path)[0] as StaticAlert).primed).toEqual(primed);
    await editAlert(path, "s1", { direction: "either" }, offline);
    expect(loadAlerts(path)[0]).not.toHaveProperty("primed");
  });

  it("turns trailing and volume alerts into moving-average touches", async () => {
    saveAlerts(path, [makeVolume()]);
    const id = loadAlerts(path)[0].id;
    const touched = await editAlert(path, id, { ma: { maType: "ema", period: 20, timeframe: "15m" }, marginPct: 0.5, from: "above" }, offline);
    expect(touched.rejectedReason).toBeNull();
    expect(loadAlerts(path)[0]).toMatchObject({ kind: "ma", trigger: "touch", marginPct: 0.5, from: "above" });
    expect(loadAlerts(path)[0]).not.toHaveProperty("volume");

    const trail = await addAlert(path, { kind: "trailing", symbol: "TEST", direction: "up", trailType: "percent", trailValue: 3 }, fakeMarket({ prices: { TEST: 100 } }));
    const fromTrail = await editAlert(path, trail.added!.id, { ma: { maType: "sma", period: 50, timeframe: "1D" }, marginPct: 0.25 }, offline);
    expect(fromTrail.edited).toMatchObject({ kind: "ma", trigger: "touch", from: "either" });
    expect(fromTrail.edited).not.toHaveProperty("extremePrice");
  });

  it.each([
    ["no direction for a cross", { direction: undefined }, /watches up or down/],
    ["either for a cross", { direction: "either" as const }, /watches up or down/],
    ["a direction on a touch", { direction: "up" as const, marginPct: 0.25 }, /touch alert has no direction/],
    ["a level as well", { direction: "up" as const, level: 50 }, /not both/],
    ["a volume condition on a touch", { marginPct: 0.25, volume: { ratio: 2, mode: "today" as const } }, /touch can't have a volume condition/],
  ])("won't make a moving average with %s", async (_name, extra, reason) => {
    saveAlerts(path, [makeStatic()]);
    const before = loadAlerts(path);
    const result = await editAlert(path, "s1", { ma: { maType: "sma", period: 50, timeframe: "1D" }, ...extra }, offline);
    expect(result.rejectedReason).toMatch(reason);
    expect(loadAlerts(path)).toEqual(before);
  });

  it("still rejects touch fields on a static alert that isn't becoming a moving average", async () => {
    saveAlerts(path, [makeStatic()]);
    expect((await editAlert(path, "s1", { from: "above" }, offline)).rejectedReason).toMatch(/static alert has no approach side/);
  });

  it("switches a moving-average cross to a touch, dropping its volume and restarting it", async () => {
    const cross = await addMa("cross");
    await editAlert(path, cross, { volume: { threshold: 2_000_000, mode: "today" } }, offline);
    const alerts = loadAlerts(path) as MaAlert[];
    Object.assign(alerts[0], { lastSide: "above", lastEvaluatedAt: "2026-09-14T15:00:00.000Z", lastFiredBucket: "2026-09-12" });
    saveAlerts(path, alerts);

    const result = await editAlert(path, cross, { marginPct: 0.5, from: "above" }, offline);
    expect(result.rejectedReason).toBeNull();
    const [stored] = loadAlerts(path) as MaAlert[];
    expect(stored).toMatchObject({ trigger: "touch", from: "above", marginPct: 0.5, lastSide: null, lastEvaluatedAt: null, lastFiredBucket: null });
    expect(stored).not.toHaveProperty("volumeCondition");
  });

  it("switches a moving-average touch to a cross with a direction", async () => {
    const touch = await addMa("touch");
    const result = await editAlert(path, touch, { direction: "down" }, offline);
    expect(result.rejectedReason).toBeNull();
    expect(loadAlerts(path)[0]).toMatchObject({ trigger: "cross", from: "above", lastSide: null });
  });

  it("keeps a moving average's own trigger when an edit only tunes it", async () => {
    const touch = await addMa("touch");
    expect((await editAlert(path, touch, { marginPct: 0.5, from: "above" }, offline)).rejectedReason).toBeNull();
    expect(loadAlerts(path)[0]).toMatchObject({ trigger: "touch", lastSide: null });
  });

  it.each([
    ["a direction and a touch margin", "touch" as const, { direction: "up" as const, marginPct: 0.5 }, /not both/],
    ["a direction and an approach side on a cross", "cross" as const, { direction: "up" as const, from: "above" as const }, /not both/],
    ["either as a cross's direction", "cross" as const, { direction: "either" as const }, /not either/],
    ["a touch with a volume condition", "cross" as const, { marginPct: 0.5, volume: { ratio: 2, mode: "today" as const } }, /touch can't have a volume condition/],
  ])("refuses %s", async (_name, trigger, edit, reason) => {
    const id = await addMa(trigger);
    const before = loadAlerts(path);
    expect((await editAlert(path, id, edit, offline)).rejectedReason).toMatch(reason);
    expect(loadAlerts(path)).toEqual(before);
  });
});
