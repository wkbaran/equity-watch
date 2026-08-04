import { describe, expect, it } from "vitest";
import { triggeredAlertsToBreakoutAlerts } from "../src/alerts/bridge.js";
import type { StaticAlert, TrailingAlert, VolumeAlert } from "../src/alerts/models.js";

function baseFields(overrides: Partial<StaticAlert> = {}) {
  return {
    id: "a1",
    symbol: "AAPL",
    status: "armed" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    livePriceAtCreation: 100,
    triggeredAt: null,
    triggerPrice: null,
    triggerSnapshot: null,
    ...overrides,
  };
}

describe("triggeredAlertsToBreakoutAlerts", () => {
  it("skips alerts that haven't triggered", () => {
    const armed: StaticAlert = { ...baseFields(), side: "below", kind: "static", level: 90, lastKnownSide: "above" };
    expect(triggeredAlertsToBreakoutAlerts([armed])).toHaveLength(0);
  });

  it("skips volume-only alerts even if triggered", () => {
    const triggered: VolumeAlert = {
      ...baseFields({ status: "triggered", triggeredAt: "2026-01-02T00:00:00.000Z", triggerPrice: 100 }),
      kind: "volume",
      volume: { threshold: 1_000_000, mode: "today" },
    };
    expect(triggeredAlertsToBreakoutAlerts([triggered])).toHaveLength(0);
  });

  it("converts a triggered static alert using its fixed level", () => {
    const triggered: StaticAlert = {
      ...baseFields({ status: "triggered", triggeredAt: "2026-01-02T00:00:00.000Z", triggerPrice: 91.2 }),
      side: "below",
      kind: "static",
      level: 90,
      lastKnownSide: "below",
    };
    const result = triggeredAlertsToBreakoutAlerts([triggered]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      alertId: "a1",
      symbol: "AAPL",
      alertType: "price_cross",
      level: 90, // the fixed target, not the observed trigger price
      time: new Date("2026-01-02T00:00:00.000Z"),
    });
  });

  it("converts a triggered trailing alert using the observed trigger price as the level", () => {
    const triggered: TrailingAlert = {
      ...baseFields({ status: "triggered", triggeredAt: "2026-01-02T00:00:00.000Z", triggerPrice: 103.5 }),
      side: "below",
      kind: "trailing",
      near: 100,
      trailType: "percent",
      trailValue: 3,
      extremePrice: 100,
      extremeAt: "2026-01-01T00:00:00.000Z",
    };
    const result = triggeredAlertsToBreakoutAlerts([triggered]);
    expect(result).toHaveLength(1);
    expect(result[0].level).toBe(103.5);
  });

  it("skips cancelled alerts", () => {
    const cancelled: StaticAlert = {
      ...baseFields({ status: "cancelled" }),
      side: "below",
      kind: "static",
      level: 90,
      lastKnownSide: "above",
    };
    expect(triggeredAlertsToBreakoutAlerts([cancelled])).toHaveLength(0);
  });
});
