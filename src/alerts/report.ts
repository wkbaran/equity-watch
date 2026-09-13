/**
 * A scannable, timestamped record of what `alert check` actually triggered
 * (distinct from `analyze`'s breakout reports, which live in the same
 * `reports/` directory under a different filename prefix). `alerts.json`
 * itself remains the source of truth for alert state; this is just a
 * human-readable log of trigger events, one file per check run - and only
 * written when there's something to show, since checks run every 5-15 min
 * and most find nothing.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringify } from "csv-stringify/sync";
import type { Alert } from "./models.js";
import { describeMaAlert } from "./maEngine.js";

const OUTPUT_FIELDS = [
  "id",
  "kind",
  "symbol",
  "side",
  "level",
  "moving_average",
  "near",
  "trail_type",
  "trail_value",
  "volume_mode",
  "volume_threshold",
  "volume_period",
  "trigger_price",
  "triggered_at",
  "chart_url",
];

function chartUrl(symbol: string): string {
  return `https://www.tradingview.com/chart/?symbol=${symbol}`;
}

function volumeFields(alert: Alert): { volume_mode: string; volume_threshold: number | string; volume_period: string } {
  const condition = alert.kind === "volume" ? alert.volume : alert.kind === "ma" ? undefined : alert.volumeCondition;
  if (!condition) {
    return { volume_mode: "", volume_threshold: "", volume_period: "" };
  }
  return {
    volume_mode: condition.mode,
    volume_threshold: condition.threshold ?? (condition.ratio !== undefined ? `${condition.ratio}x normal` : ""),
    volume_period: condition.mode === "period" ? `${condition.periodValue}${condition.periodUnit}` : "",
  };
}

export function writeAlertTriggerReport(triggered: Alert[], outPath: string): void {
  const rows = triggered.map((a) => ({
    id: a.id,
    kind: a.kind,
    symbol: a.symbol,
    side: a.kind === "volume" ? "" : a.kind === "ma" ? (a.lastEvent ?? "") : a.side,
    level: a.kind === "static" ? a.level : a.kind === "ma" ? (a.lastLevel ?? "") : "",
    moving_average: a.kind === "ma" ? describeMaAlert(a) : "",
    near: a.kind === "trailing" ? a.near : "",
    trail_type: a.kind === "trailing" ? a.trailType : "",
    trail_value: a.kind === "trailing" ? a.trailValue : "",
    ...volumeFields(a),
    trigger_price: a.lastTriggerPrice,
    triggered_at: a.lastTriggeredAt,
    chart_url: chartUrl(a.symbol),
  }));
  const csvText = stringify(rows, { header: true, columns: OUTPUT_FIELDS });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, csvText);
}
