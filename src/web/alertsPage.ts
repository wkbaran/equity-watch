/**
 * Rows for the browser dashboard's Alerts view, published as alerts.json.
 *
 * Kept out of dashboard.json on purpose: that file is polled every minute
 * for new triggers, and the full book is ~500 rows that only the Alerts view
 * needs. It's also browser-only, not part of the Dashboard document the
 * terminal and Kindle renderers share.
 */

import { describeAlertCondition } from "../alerts/describe.js";
import { effectiveTrigger, type Alert, type AlertDirection, type AlertSide, type VolumeCondition } from "../alerts/models.js";
import type { Quote } from "../providers/schwab.js";
import { round } from "../round.js";
import { tradingViewUrl } from "../tradingview.js";

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
  /** Which crossings of a static alert's level fire it. Null for other kinds. */
  direction: AlertDirection | null;
  hasVolumeCondition: boolean;
  /**
   * The volume condition itself: a volume alert's, or a price alert's AND
   * condition. The edit form prefills from it; the condition text alone can't
   * be parsed back reliably.
   */
  volume: VolumeCondition | null;
  triggerCount: number;
  lastTriggeredAt: string | null;
  lastTriggerPrice: number | null;
  createdAt: string;
  watchingSince: string;
  watchingSinceApprox: boolean;
  price: number | null;
  /** Price relative to the level (or moving level), in percent. Positive means price is above it. */
  vsLevelPct: number | null;
  /**
   * Whether the symbol is a position. The same flag TriggerRow carries, and
   * publishable for the same reason: that a name is held says nothing about
   * size or value (see siteDocument). Without it the page could only tell
   * from the decrypted vault, so the public Alerts view would be the one
   * place a held name didn't say so.
   */
  heldPosition: boolean;
  chartUrl: string;
}

/** Live alerts that are actually checked (ignored symbols excluded), by symbol. */
export function buildAlertRows(
  alerts: Alert[],
  quotes: Map<string, Quote>,
  ignored: Set<string>,
  exchanges: Map<string, string> = new Map(),
  /** Held symbols, upper-cased, as buildDashboard derives them from the lots. */
  held: Set<string> = new Set()
): AlertRow[] {
  return alerts
    .filter((a) => a.status === "live" && !ignored.has(a.symbol.toUpperCase()))
    .map((a): AlertRow => {
      const price = quotes.get(a.symbol)?.lastPrice ?? null;
      const level = a.kind === "static" ? a.level : null;
      const movingLevel = a.kind === "trailing" ? round(effectiveTrigger(a)) : a.kind === "ma" ? a.lastLevel : null;
      const reference = level ?? movingLevel;
      return {
        id: a.id,
        symbol: a.symbol,
        kind: a.kind,
        condition: describeAlertCondition(a),
        level,
        movingLevel,
        side: a.kind === "static" || a.kind === "trailing" ? a.side : null,
        direction: a.kind === "static" ? a.direction : null,
        hasVolumeCondition: a.kind === "volume" || ((a.kind === "static" || a.kind === "trailing") && a.volumeCondition !== undefined),
        volume: a.kind === "volume" ? a.volume : a.kind === "static" || a.kind === "trailing" ? (a.volumeCondition ?? null) : null,
        triggerCount: a.triggerCount,
        lastTriggeredAt: a.lastTriggeredAt,
        lastTriggerPrice: a.lastTriggerPrice,
        createdAt: a.createdAt,
        watchingSince: a.watchingSince,
        watchingSinceApprox: a.watchingSinceApprox,
        price,
        vsLevelPct: price === null || reference === null || reference === 0 ? null : round(((price - reference) / reference) * 100),
        heldPosition: held.has(a.symbol.toUpperCase()),
        chartUrl: tradingViewUrl(a.symbol, exchanges.get(a.symbol)),
      };
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.id.localeCompare(b.id));
}
