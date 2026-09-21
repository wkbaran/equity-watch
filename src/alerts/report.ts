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
import { tradingViewUrl } from "../tradingview.js";
import { writeCsv } from "../csv.js";

const OUTPUT_FIELDS = [
  "id",
  "kind",
  "symbol",
  "side",
  "direction",
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

/**
 * `exchanges` supplies each symbol's TradingView prefix (exchangesFromProfiles).
 * Optional: a symbol with no cached profile gets the bare link it always got.
 */
export function writeAlertTriggerReport(triggered: Alert[], outPath: string, exchanges: Map<string, string> = new Map()): void {
  const rows = triggered.map((a) => ({
    id: a.id,
    kind: a.kind,
    symbol: a.symbol,
    side: a.kind === "volume" ? "" : a.kind === "ma" ? (a.lastEvent ?? "") : a.side,
    // Which crossings a static alert watches. `side` is only where price sat when it was created.
    direction: a.kind === "static" ? a.direction : "",
    level: a.kind === "static" ? a.level : a.kind === "ma" ? (a.lastLevel ?? "") : "",
    moving_average: a.kind === "ma" ? describeMaAlert(a) : "",
    near: a.kind === "trailing" ? a.near : "",
    trail_type: a.kind === "trailing" ? a.trailType : "",
    trail_value: a.kind === "trailing" ? a.trailValue : "",
    ...volumeFields(a),
    trigger_price: a.lastTriggerPrice,
    triggered_at: a.lastTriggeredAt,
    chart_url: tradingViewUrl(a.symbol, exchanges.get(a.symbol) ?? null),
  }));
  writeCsv(outPath, rows, OUTPUT_FIELDS);
}
