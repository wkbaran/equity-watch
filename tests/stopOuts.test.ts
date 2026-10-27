import { describe, expect, it } from "vitest";
import type { Alert, StaticAlert } from "../src/alerts/models.js";
import { applyQueueRules, queueRank } from "../src/alerts/queueRules.js";
import { newRevisitEntry } from "../src/alerts/revisit.js";
import { stopOutEntries } from "../src/alerts/stopOuts.js";
import type { Sale } from "../src/holdings/models.js";
import { triggerAction, triggerHeadline } from "../src/narrative.js";

const NOW = new Date("2026-10-27T16:00:00.000Z");

function alert(overrides: Partial<StaticAlert> = {}): StaticAlert {
  return {
    id: "a1",
    symbol: "VYX",
    status: "live",
    createdAt: "2026-10-16T15:00:00.000Z",
    livePriceAtCreation: 7.7,
    triggerCount: 0,
    lastTriggeredAt: null,
    lastTriggerPrice: null,
    mutedUntil: null,
    watchingSince: "2026-10-16T15:00:00.000Z",
    watchingSinceApprox: false,
    priceAtWatchStart: 7.7,
    triggerSnapshot: null,
    kind: "static",
    side: "below",
    direction: "up",
    level: 8.5,
    lastKnownSide: "below",
    ...overrides,
  };
}

function sale(overrides: Partial<Sale> = {}): Sale {
  return {
    id: "s1",
    symbol: "VYX",
    count: 50,
    price: 7.79,
    soldOn: "2026-10-27",
    recordedAt: "2026-10-27T15:15:02.064Z",
    lots: [{ lotId: "l1", count: 50, basisPerShare: 7.69, purchaseDate: "2026-10-15", emptied: true }],
    stopHit: { atr: null, stops: [{ stopPrice: 7.75, count: 50, createdAt: "2026-10-20T20:22:01.582Z" }] },
    ...overrides,
  };
}

describe("stopOutEntries", () => {
  it("queues a stop sale against the symbol's live alert, once", () => {
    const [entry] = stopOutEntries([], [alert()], [sale()]);
    expect(entry).toMatchObject({ alertId: "a1", symbol: "VYX", reason: "stopped", stopped: { saleId: "s1" }, status: "open", levelAtTrigger: 8.5 });
    expect(entry.triggeredAt).toBe("2026-10-27T15:15:02.064Z");
    expect(entry).not.toHaveProperty("direction");
    expect(stopOutEntries([entry], [alert()], [sale()])).toEqual([]);
  });

  it("skips a sale no stop made, and a symbol with no live alert", () => {
    expect(stopOutEntries([], [alert()], [sale({ stopHit: undefined })])).toEqual([]);
    expect(stopOutEntries([], [alert({ status: "cancelled" })], [sale()])).toEqual([]);
    expect(stopOutEntries([], [alert({ symbol: "ABC" })], [sale()])).toEqual([]);
  });

  it("hangs off a static alert when the symbol has several", () => {
    const trailing = { ...alert({ id: "t1" }), kind: "trailing", trail: { mode: "pct", amount: 5 }, near: 7, extremePrice: 7, direction: "up" } as unknown as Alert;
    expect(stopOutEntries([], [trailing, alert({ id: "s9" })], [sale()])[0].alertId).toBe("s9");
  });
});

describe("a stop-out in the queue", () => {
  const entry = () => stopOutEntries([], [alert()], [sale()])[0];

  it("ranks above a new fire, and says so without a price", () => {
    const fire = newRevisitEntry(alert(), 8.6, "2026-10-27T15:00:00.000Z", "regular");
    expect(queueRank(entry(), false, NOW).priority).toBeGreaterThan(queueRank(fire, false, NOW).priority);
    expect(queueRank(entry(), false, NOW)).toMatchObject({ reason: "stopped", why: "Stopped out Oct 27; its alerts were set while it was held." });
    expect(triggerHeadline(entry(), { heldSymbols: new Set() })).toBe("Stopped out of VYX");
    expect(triggerHeadline(entry(), { heldSymbols: new Set(["VYX"]) })).toBe("A stop sold part of VYX");
    expect(triggerAction(entry(), 8.5)).toBe("Update or remove its alerts, or dismiss this if they still stand.");
  });

  it("is left alone by the queue rules: a later fire doesn't close it, and its dismissal stands", () => {
    const open = entry();
    const fire = newRevisitEntry(alert(), 8.6, "2026-10-28T15:00:00.000Z", "regular");
    applyQueueRules([open, fire], [alert()], new Map([["VYX", 9.5]]), new Date("2026-11-20T16:00:00.000Z"));
    expect(open.status).toBe("open");
    const dismissed = { ...entry(), status: "dismissed" as const, resolvedAt: "2026-10-27T17:00:00.000Z" };
    applyQueueRules([dismissed], [alert()], new Map([["VYX", 9.5]]), new Date("2026-11-20T16:00:00.000Z"));
    expect(dismissed.status).toBe("dismissed");
  });

  it("doesn't stop a drift being raised on the same alert", () => {
    const quiet = alert({ createdAt: "2026-08-01T15:00:00.000Z" });
    const result = applyQueueRules([entry()], [quiet], new Map([["VYX", 7]]), NOW);
    expect(result.created.map((e) => e.reason)).toEqual(["drift"]);
  });
});
