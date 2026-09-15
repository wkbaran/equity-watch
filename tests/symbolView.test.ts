import { describe, expect, it } from "vitest";
import type { Alert, StaticAlert, TrailingAlert } from "../src/alerts/models.js";
import type { RevisitEntry } from "../src/alerts/revisit.js";
import { renderSymbolAlerts } from "../src/alerts/symbolView.js";

const base = {
  status: "live" as const,
  createdAt: "2026-07-01T14:00:00.000Z",
  livePriceAtCreation: 240,
  watchingSince: "2026-07-01T14:00:00.000Z",
  watchingSinceApprox: false,
  priceAtWatchStart: 240,
  triggerCount: 0,
  lastTriggeredAt: null,
  lastTriggerPrice: null,
  mutedUntil: null,
  triggerSnapshot: null,
};

function staticAlert(overrides: Partial<StaticAlert> = {}): StaticAlert {
  return {
    ...base,
    id: "s1",
    symbol: "TSLA",
    kind: "static",
    side: "above",
    direction: "up",
    level: 250,
    lastKnownSide: "below",
    ...overrides,
  };
}

function trailingAlert(overrides: Partial<TrailingAlert> = {}): TrailingAlert {
  return {
    ...base,
    id: "t1",
    symbol: "TSLA",
    kind: "trailing",
    side: "above",
    near: 245,
    trailType: "percent",
    trailValue: 3,
    extremePrice: 250,
    extremeAt: "2026-09-14T15:00:00.000Z",
    ...overrides,
  };
}

const NOW = new Date("2026-09-14T18:00:00.000Z");

describe("renderSymbolAlerts", () => {
  it("says none when the symbol has no live alerts, and counts cancelled ones", () => {
    expect(renderSymbolAlerts("TSLA", [], [], NOW)).toBe("TSLA: none");
    const alerts: Alert[] = [staticAlert({ status: "cancelled" }), staticAlert({ id: "o1", symbol: "AAPL" })];
    expect(renderSymbolAlerts("TSLA", alerts, [], NOW)).toBe("TSLA: none (1 cancelled)");
  });

  it("shows each live alert's condition, history, and moving trigger", () => {
    const alerts: Alert[] = [
      staticAlert({
        triggerCount: 3,
        lastTriggeredAt: "2026-09-12T14:31:00.000Z",
        lastTriggerPrice: 251.2,
        volumeCondition: { ratio: 1.5, mode: "today" },
      }),
      trailingAlert({ watchingSinceApprox: true }),
    ];
    const out = renderSymbolAlerts("TSLA", alerts, [], NOW);
    expect(out).toMatch(/^TSLA: 2 live alerts\n/);
    expect(out).toContain("s1  static   price crosses above 250 AND volume >= 1.5x normal today");
    expect(out).toMatch(/fired 3 times, last 2026-09-12 \d\d:31 at 251\.2/);
    expect(out).toContain("t1  trailing trailing 3% off the high (started near 245) (trigger 242.5 at last check)");
    expect(out).toContain("never fired");
    expect(out).toContain("(approx.) at 240");
  });

  it("matches case-insensitively and ignores an exchange prefix", () => {
    expect(renderSymbolAlerts("nasdaq:tsla", [staticAlert()], [], NOW)).toMatch(/^TSLA: 1 live alert\n/);
  });

  it("counts open revisits on the symbol, skipping migrated follow-ups", () => {
    const revisits = [
      { id: "r1", alertId: "s1", symbol: "TSLA", status: "open" },
      { id: "r2", alertId: "s1", symbol: "TSLA", status: "open", followUpOf: "r1" },
      { id: "r3", alertId: "s1", symbol: "TSLA", status: "dismissed" },
      { id: "r4", alertId: "o1", symbol: "AAPL", status: "open" },
    ] as RevisitEntry[];
    expect(renderSymbolAlerts("TSLA", [], revisits, NOW)).toBe(
      "TSLA: none\n1 open revisit on TSLA: 'alert revisit list' to review."
    );
  });
});
