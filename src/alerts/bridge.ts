/**
 * Converts triggered alerts from this engine's own alerts.json into the
 * TradingView-CSV-shaped `Alert` model that analyzeAlert()/runAnalyze()
 * expect, so `analyze` can confirm breakouts for tickers that triggered
 * here instead of (or in addition to) a TradingView CSV export.
 *
 * Volume-only alerts are skipped - there's no price level to confirm a
 * breakout against. For trailing alerts, the observed triggerPrice is used
 * as the "level" (there's no fixed target the way a static alert has one -
 * the trigger price itself is the meaningful reference point).
 */

import type { Alert as EngineAlert } from "./models.js";
import type { Alert } from "../models.js";

export function triggeredAlertsToBreakoutAlerts(engineAlerts: EngineAlert[]): Alert[] {
  const result: Alert[] = [];
  for (const a of engineAlerts) {
    if (a.status !== "triggered" || a.triggeredAt === null || a.kind === "volume") {
      continue;
    }
    const level = a.kind === "static" ? a.level : a.triggerPrice;
    if (level === null) {
      continue;
    }
    result.push({
      alertId: a.id,
      exchange: "",
      symbol: a.symbol,
      timeframe: null,
      description: `${a.kind} alert triggered`,
      time: new Date(a.triggeredAt),
      alertType: "price_cross",
      level,
      rawTicker: a.symbol,
    });
  }
  return result;
}
