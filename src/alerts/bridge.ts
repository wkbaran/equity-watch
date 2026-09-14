/**
 * Converts revisit-queue entries into the TradingView-CSV-shaped `Alert`
 * model that analyzeAlert()/runAnalyze() expect, so `analyze` can confirm
 * breakouts for things that fired here instead of (or in addition to) a
 * TradingView CSV export.
 *
 * The queue is the right source rather than the alert list: under the
 * no-disarm model an alert is permanently live and has no single "it fired"
 * moment to analyze, while each queue entry is exactly one trigger event
 * with the price and level it fired at.
 *
 * Volume-only entries are skipped - there's no price level to confirm a
 * breakout against. For trailing entries the observed triggerPrice is used
 * as the level, since a trailing alert has no fixed target the way a static
 * one does.
 *
 * Moving-average crosses bridge with the average's value at the cross as the
 * level: "did it close past the 200-day and hold" is the same question as for
 * a static level. Touches are skipped - price met the average without
 * crossing it, so there's no breakout to confirm.
 *
 * The crossing direction is carried across, so a downward fire is judged as
 * a close below the level that held below, not as a failed upside breakout.
 *
 * Legacy follow-up entries (`followUpOf` set) are skipped: their crossing is
 * already folded onto the fire they follow, and judging it again would add a
 * second history record for the same event.
 */

import type { Alert } from "../models.js";
import { entryDirection } from "./reversion.js";
import type { RevisitEntry } from "./revisit.js";

export function revisitsToBreakoutAlerts(entries: RevisitEntry[]): Alert[] {
  const result: Alert[] = [];
  for (const entry of entries) {
    if (entry.followUpOf !== undefined) {
      continue;
    }
    if (entry.kind === "volume" || (entry.kind === "ma" && entry.ma?.event === "touch")) {
      continue;
    }
    const level = entry.kind === "static" || entry.kind === "ma" ? entry.levelAtTrigger : entry.triggerPrice;
    if (level === null) {
      continue;
    }
    const direction = entryDirection(entry);
    result.push({
      // The queue entry id, not the alert id: one alert now produces many
      // trigger events over its life, and history/ upserts by this id, so
      // keying on the alert would collapse them all onto one record.
      alertId: entry.id,
      exchange: "",
      symbol: entry.symbol,
      timeframe: null,
      description: `${entry.kind} alert triggered at ${entry.triggerPrice}`,
      time: new Date(entry.triggeredAt),
      alertType: "price_cross",
      level,
      rawTicker: entry.symbol,
      ...(direction !== null ? { direction } : {}),
    });
  }
  return result;
}
