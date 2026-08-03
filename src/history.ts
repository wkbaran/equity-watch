/**
 * A cumulative, per-ticker on-disk record of every alert seen and its
 * breakout verdict, so results survive across `analyze` runs instead of
 * disappearing when the next report overwrites the last one.
 *
 * One JSON file per symbol, upserted by (alert ID, alert time): TradingView
 * reuses one "Alert ID" for every trigger of the same alert definition, so
 * the same ID can appear many times with different timestamps/levels in a
 * single CSV export — those are distinct historical events and must not be
 * collapsed into one. Re-running `analyze` over an overlapping CSV export
 * (expected, since TradingView's export is a manual step run periodically)
 * still refreshes an *identical* (id, time) entry in place rather than
 * duplicating it, since a later run may have more trading days of price
 * history available (e.g. "held for 2/2d" becoming "3/3d").
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BreakoutVerdict } from "./models.js";

export interface HistoryEntry {
  alertId: string;
  alertTime: string;
  verdict: string;
  level: number | null;
  closeOnAlertDay: number | null;
  pctAboveLevel: number | null;
  volumeRatio: number | null;
  volumeTrendRatio: number | null;
  nearRecentHigh: boolean | null;
  heldAboveLevel: boolean | null;
  daysHeld: number;
  notes: string;
  firstSeenAt: string;
  lastUpdatedAt: string;
}

function historyFile(historyDir: string, symbol: string): string {
  return join(historyDir, `${symbol.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

function entryKey(alertId: string, alertTime: string): string {
  return `${alertId}|${alertTime}`;
}

function readEntries(file: string): HistoryEntry[] {
  if (!existsSync(file)) {
    return [];
  }
  return JSON.parse(readFileSync(file, "utf-8")) as HistoryEntry[];
}

/** Updates on-disk history and returns the number of distinct tickers touched. */
export function updateHistory(verdicts: BreakoutVerdict[], historyDir: string): number {
  mkdirSync(historyDir, { recursive: true });

  const bySymbol = new Map<string, BreakoutVerdict[]>();
  for (const v of verdicts) {
    const list = bySymbol.get(v.alert.symbol) ?? [];
    list.push(v);
    bySymbol.set(v.alert.symbol, list);
  }

  const now = new Date().toISOString();
  for (const [symbol, symbolVerdicts] of bySymbol) {
    const file = historyFile(historyDir, symbol);
    const byKey = new Map(readEntries(file).map((e) => [entryKey(e.alertId, e.alertTime), e]));

    for (const v of symbolVerdicts) {
      const alertTime = v.alert.time.toISOString();
      const key = entryKey(v.alert.alertId, alertTime);
      const prior = byKey.get(key);
      byKey.set(key, {
        alertId: v.alert.alertId,
        alertTime,
        verdict: v.verdict,
        level: v.alert.level,
        closeOnAlertDay: v.closeOnAlertDay,
        pctAboveLevel: v.pctAboveLevel,
        volumeRatio: v.volumeRatio,
        volumeTrendRatio: v.volumeTrendRatio,
        nearRecentHigh: v.nearRecentHigh,
        heldAboveLevel: v.heldAboveLevel,
        daysHeld: v.daysHeld,
        notes: v.notes,
        firstSeenAt: prior?.firstSeenAt ?? now,
        lastUpdatedAt: now,
      });
    }

    const merged = [...byKey.values()].sort((a, b) => a.alertTime.localeCompare(b.alertTime));
    writeFileSync(file, JSON.stringify(merged, null, 2));
  }

  return bySymbol.size;
}
