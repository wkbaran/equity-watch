import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAlert, checkAlerts } from "../src/alerts/engine.js";
import type { Alert, StaticAlert, TrailingAlert } from "../src/alerts/models.js";
import { loadAlerts } from "../src/alerts/store.js";

function fakeQuotes(prices: Record<string, number>) {
  return async (symbols: string[]) => new Map(symbols.map((s) => [s, prices[s]]).filter(([, p]) => p !== undefined));
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

describe("checkAlerts", () => {
  it("does not trigger a static alert while price stays on the same side", async () => {
    const alert = makeStatic({ level: 100, lastKnownSide: "above" });
    const { triggered } = await checkAlerts([alert], fakeQuotes({ TEST: 105 }), []);
    expect(triggered).toHaveLength(0);
    expect(alert.status).toBe("armed");
  });

  it("triggers a static alert exactly once when price crosses the level", async () => {
    const alert = makeStatic({ level: 100, lastKnownSide: "above" });
    const first = await checkAlerts([alert], fakeQuotes({ TEST: 95 }), []);
    expect(first.triggered).toHaveLength(1);
    expect(alert.status).toBe("triggered");
    expect(alert.triggerPrice).toBe(95);

    // Already triggered (no longer armed), so a second check must not re-fire.
    const second = await checkAlerts([alert], fakeQuotes({ TEST: 90 }), []);
    expect(second.checked).toBe(0);
    expect(second.triggered).toHaveLength(0);
  });

  it("snapshots every attribute at trigger time, independent of later mutation", async () => {
    const alert = makeStatic({ level: 100, lastKnownSide: "above" });
    await checkAlerts([alert], fakeQuotes({ TEST: 95 }), []);

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
    const { triggered } = await checkAlerts([alert], fakeQuotes({ TEST: 97 }), []);
    expect(triggered).toHaveLength(0);
    expect(alert.extremePrice).toBe(97); // new low

    const { triggered: t2 } = await checkAlerts([alert], fakeQuotes({ TEST: 98.5 }), []);
    expect(t2).toHaveLength(0); // bounce of ~1.5%, below the 3% trail
    expect(alert.extremePrice).toBe(97);
  });

  it("triggers a below trailing alert once the bounce meets the trail threshold", async () => {
    const alert = makeTrailing({ side: "below", extremePrice: 97, trailType: "percent", trailValue: 3 });
    const { triggered } = await checkAlerts([alert], fakeQuotes({ TEST: 100 }), []); // 97 * 1.03 = 99.91
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
    const { triggered: t1 } = await checkAlerts([alert], fakeQuotes({ TEST: 103 }), []);
    expect(t1).toHaveLength(0);
    expect(alert.extremePrice).toBe(103); // new high

    const { triggered: t2 } = await checkAlerts([alert], fakeQuotes({ TEST: 101.5 }), []);
    expect(t2).toHaveLength(0); // pullback of 1.5, short of the $2 trail

    const { triggered: t3 } = await checkAlerts([alert], fakeQuotes({ TEST: 101 }), []); // 103 - 2 = 101
    expect(t3).toHaveLength(1);
    expect(alert.status).toBe("triggered");
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
      fakeQuotes({ TEST: 100 })
    );
    expect(result.rejectedReason).toBeNull();
    expect(result.added?.side).toBe("below");
  });

  it("infers side=above when the anchor is over the live price", async () => {
    const result = await addAlert(
      path,
      { kind: "static", symbol: "TEST", level: 110 },
      fakeQuotes({ TEST: 100 })
    );
    expect(result.rejectedReason).toBeNull();
    expect(result.added?.side).toBe("above");
  });

  it("rejects an anchor equal to the live price", async () => {
    const result = await addAlert(
      path,
      { kind: "static", symbol: "TEST", level: 100 },
      fakeQuotes({ TEST: 100 })
    );
    expect(result.added).toBeNull();
    expect(result.rejectedReason).toMatch(/equals the live price/);
  });

  it("replaces an existing armed alert on the same side when the new one is closer, across kinds", async () => {
    const getQuotes = fakeQuotes({ TEST: 100 });
    const first = await addAlert(path, { kind: "static", symbol: "TEST", level: 80 }, getQuotes);
    expect(first.added?.side).toBe("below");

    const second = await addAlert(
      path,
      { kind: "trailing", symbol: "TEST", near: 95, trailType: "amount", trailValue: 1 },
      getQuotes
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
    const getQuotes = fakeQuotes({ TEST: 100 });
    const close = await addAlert(
      path,
      { kind: "trailing", symbol: "TEST", near: 95, trailType: "amount", trailValue: 1 },
      getQuotes
    );

    const farther = await addAlert(path, { kind: "static", symbol: "TEST", level: 80 }, getQuotes);
    expect(farther.added).toBeNull();
    expect(farther.rejectedReason).toMatch(/already closer/);

    const stored = loadAlerts(path);
    const untouched = stored.find((a) => a.id === close.added!.id)!;
    expect(untouched.status).toBe("armed");
  });

  it("lets above and below alerts coexist on the same symbol", async () => {
    const getQuotes = fakeQuotes({ TEST: 100 });
    const below = await addAlert(path, { kind: "static", symbol: "TEST", level: 90 }, getQuotes);
    const above = await addAlert(path, { kind: "static", symbol: "TEST", level: 110 }, getQuotes);

    expect(below.rejectedReason).toBeNull();
    expect(above.rejectedReason).toBeNull();

    const stored: Alert[] = loadAlerts(path);
    expect(stored.filter((a) => a.status === "armed")).toHaveLength(2);
  });
});
