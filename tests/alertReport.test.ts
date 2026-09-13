import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeAlertTriggerReport } from "../src/alerts/report.js";
import type { StaticAlert, TrailingAlert, VolumeAlert } from "../src/alerts/models.js";

function readRows(path: string): Record<string, string>[] {
  return parseCsv(readFileSync(path, "utf-8"), { columns: true });
}

describe("writeAlertTriggerReport", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tv-alerts-report-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes one row per triggered alert with kind-appropriate fields", () => {
    const staticAlert: StaticAlert = {
      id: "s1",
      symbol: "AAPL",
      side: "below",
      status: "live",
      triggerCount: 1,
      mutedUntil: null,
      watchingSince: "2026-01-01T00:00:00.000Z",
      watchingSinceApprox: false,
      priceAtWatchStart: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      livePriceAtCreation: 200,
      lastTriggeredAt: "2026-01-02T00:00:00.000Z",
      lastTriggerPrice: 150,
      triggerSnapshot: null,
      kind: "static",
      level: 150,
      lastKnownSide: "above",
    };
    const trailingAlert: TrailingAlert = {
      id: "t1",
      symbol: "MSFT",
      side: "above",
      status: "live",
      triggerCount: 1,
      mutedUntil: null,
      watchingSince: "2026-01-01T00:00:00.000Z",
      watchingSinceApprox: false,
      priceAtWatchStart: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      livePriceAtCreation: 300,
      lastTriggeredAt: "2026-01-02T00:00:01.000Z",
      lastTriggerPrice: 298,
      triggerSnapshot: null,
      kind: "trailing",
      near: 300,
      trailType: "amount",
      trailValue: 2,
      extremePrice: 300,
      extremeAt: "2026-01-01T00:00:00.000Z",
    };
    const volumeAlert: VolumeAlert = {
      id: "v1",
      symbol: "TSLA",
      status: "live",
      triggerCount: 1,
      mutedUntil: null,
      watchingSince: "2026-01-01T00:00:00.000Z",
      watchingSinceApprox: false,
      priceAtWatchStart: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      livePriceAtCreation: 400,
      lastTriggeredAt: "2026-01-02T00:00:02.000Z",
      lastTriggerPrice: 401,
      triggerSnapshot: null,
      kind: "volume",
      volume: { threshold: 100, mode: "period", periodValue: 30, periodUnit: "m" },
    };

    const outPath = join(dir, "alert_triggers.csv");
    writeAlertTriggerReport([staticAlert, trailingAlert, volumeAlert], outPath);
    const rows = readRows(outPath);

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ id: "s1", kind: "static", symbol: "AAPL", level: "150", trigger_price: "150" });
    expect(rows[1]).toMatchObject({ id: "t1", kind: "trailing", symbol: "MSFT", near: "300", trail_type: "amount" });
    expect(rows[2]).toMatchObject({
      id: "v1",
      kind: "volume",
      symbol: "TSLA",
      volume_mode: "period",
      volume_threshold: "100",
      volume_period: "30m",
    });
    for (const row of rows) {
      expect(row.chart_url).toContain("tradingview.com/chart");
    }
  });
});
