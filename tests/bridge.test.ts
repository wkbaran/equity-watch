import { describe, expect, it } from "vitest";
import { revisitsToBreakoutAlerts } from "../src/alerts/bridge.js";
import type { RevisitEntry } from "../src/alerts/revisit.js";

function entry(overrides: Partial<RevisitEntry> = {}): RevisitEntry {
  return {
    id: "r1",
    alertId: "a1",
    symbol: "AAPL",
    kind: "static",
    triggeredAt: "2026-01-02T00:00:00.000Z",
    triggerPrice: 91.2,
    levelAtTrigger: 90,
    session: null,
    watchingSince: null,
    watchingSinceApprox: false,
    priceAtWatchStart: null,
    appliedFrom: null,
    appliedTo: null,
    status: "open",
    suggestedLevel: null,
    suggestedAt: null,
    suggestionBasis: null,
    resolvedAt: null,
    priority: null,
    signals: null,
    ...overrides,
  };
}

describe("revisitsToBreakoutAlerts", () => {
  it("skips volume-only entries (no price level to confirm against)", () => {
    expect(revisitsToBreakoutAlerts([entry({ kind: "volume", levelAtTrigger: null })])).toHaveLength(0);
  });

  it("converts a static entry using the level it fired at", () => {
    const result = revisitsToBreakoutAlerts([entry()]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      symbol: "AAPL",
      alertType: "price_cross",
      level: 90, // the fixed target, not the observed trigger price
      time: new Date("2026-01-02T00:00:00.000Z"),
    });
  });

  it("keys on the entry id, not the alert id, so repeat triggers stay distinct in history/", () => {
    // One alert now fires many times over its life. Keying on alertId would
    // collapse every trigger onto a single history record.
    const result = revisitsToBreakoutAlerts([
      entry({ id: "r1", alertId: "a1", triggeredAt: "2026-01-02T00:00:00.000Z" }),
      entry({ id: "r2", alertId: "a1", triggeredAt: "2026-02-02T00:00:00.000Z" }),
    ]);
    expect(result.map((r) => r.alertId)).toEqual(["r1", "r2"]);
  });

  it("converts a trailing entry using the observed trigger price as the level", () => {
    const result = revisitsToBreakoutAlerts([entry({ kind: "trailing", levelAtTrigger: 100, triggerPrice: 103.5 })]);
    expect(result).toHaveLength(1);
    expect(result[0].level).toBe(103.5);
  });

  it("includes resolved entries when handed them - filtering by status is the caller's job", () => {
    expect(revisitsToBreakoutAlerts([entry({ status: "applied" })])).toHaveLength(1);
  });
});
