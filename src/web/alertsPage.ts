/**
 * Rows for the browser dashboard's Alerts view, published as alerts.json.
 *
 * Kept out of dashboard.json on purpose: that file is polled every minute
 * for new triggers, and the full book is ~500 rows that only the Alerts view
 * needs. It's also browser-only, not part of the Dashboard document the
 * terminal and Kindle renderers share.
 */

import { describeAlertCondition } from "../alerts/describe.js";
import { effectiveTrigger, type Alert, type AlertSide } from "../alerts/models.js";
import type { Quote } from "../providers/schwab.js";

export interface AlertRow {
  id: string;
  symbol: string;
  kind: Alert["kind"];
  condition: string;
  /** A static alert's fixed level. */
  level: number | null;
  /**
   * A level that moves on its own: a trailing alert's current trigger, or a
   * moving-average alert's average as of its last check. A separate field from
   * `level` so the publish fingerprint can ignore it; it changes every check.
   */
  movingLevel: number | null;
  side: AlertSide | null;
  hasVolumeCondition: boolean;
  triggerCount: number;
  lastTriggeredAt: string | null;
  lastTriggerPrice: number | null;
  createdAt: string;
  watchingSince: string;
  watchingSinceApprox: boolean;
  price: number | null;
  /** Price relative to the level (or moving level), in percent. Positive means price is above it. */
  vsLevelPct: number | null;
  chartUrl: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Live alerts that are actually checked (ignored symbols excluded), by symbol. */
export function buildAlertRows(alerts: Alert[], quotes: Map<string, Quote>, ignored: Set<string>): AlertRow[] {
  return alerts
    .filter((a) => a.status === "live" && !ignored.has(a.symbol.toUpperCase()))
    .map((a): AlertRow => {
      const price = quotes.get(a.symbol)?.lastPrice ?? null;
      const level = a.kind === "static" ? a.level : null;
      const movingLevel = a.kind === "trailing" ? round2(effectiveTrigger(a)) : a.kind === "ma" ? a.lastLevel : null;
      const reference = level ?? movingLevel;
      return {
        id: a.id,
        symbol: a.symbol,
        kind: a.kind,
        condition: describeAlertCondition(a),
        level,
        movingLevel,
        side: a.kind === "static" || a.kind === "trailing" ? a.side : null,
        hasVolumeCondition: a.kind === "volume" || ((a.kind === "static" || a.kind === "trailing") && a.volumeCondition !== undefined),
        triggerCount: a.triggerCount,
        lastTriggeredAt: a.lastTriggeredAt,
        lastTriggerPrice: a.lastTriggerPrice,
        createdAt: a.createdAt,
        watchingSince: a.watchingSince,
        watchingSinceApprox: a.watchingSinceApprox,
        price,
        vsLevelPct: price === null || reference === null || reference === 0 ? null : round2(((price - reference) / reference) * 100),
        chartUrl: `https://www.tradingview.com/chart/?symbol=${a.symbol}`,
      };
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.id.localeCompare(b.id));
}
