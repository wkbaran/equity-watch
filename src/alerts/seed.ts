/**
 * One-time transform of two specific TradingView exports into a seed plan for
 * this engine's own alert store.
 *
 * Deliberately NOT a general importer. These are the two schemas that were
 * exported on 2026-09-12 and they are hard-coded here; the project's CLAUDE.md
 * documents the three mutually incompatible TradingView CSV shapes. If a
 * future export looks different, transform it rather than generalising this.
 *
 *   tradingview-alerts.csv     Symbol, Description, Status, Last Triggered
 *   tradingview-alert-log.csv  Symbol, Alert Date, Alert Time, Description
 *
 * Collapse rules:
 *   - Two alerts of the same type on one ticker collapse to one.
 *   - A price alert and a volume alert on one ticker combine into a single
 *     price-AND-volume alert (the engine supports this natively).
 *   - A volume alert with no price alert on the ticker stays standalone.
 *
 * Levels are NOT finalised here - this only records the best level TradingView
 * knew about. Whether that level is still valid, or price has pushed past it
 * and needs a fresh resistance, is decided against real bars by relevel.ts.
 */

import { readFileSync } from "node:fs";
import { parse as parseCsv } from "csv-parse/sync";
import { classifyDescription } from "../parse.js";
import type { VolumeCondition } from "./models.js";

export interface SeedCandidate {
  symbol: string;
  /** Best level TradingView knew about, before any re-levelling against bars. */
  level: number;
  /** Stated outright by "Crossing Up/Down"; null means infer from live price. */
  side: "above" | "below" | null;
  volume: VolumeCondition | null;
  /** How many CSV rows collapsed into this one candidate. */
  collapsedFrom: number;
  /** Every level seen for this ticker, for the dry-run report. */
  levelsSeen: number[];
  lastFiredAt: string | null;
  /**
   * Earliest evidence this ticker was being watched. TradingView's exports
   * carry no creation date, so this is the oldest trigger on record - a lower
   * bound, never the real start, hence `watchingSinceApprox` downstream.
   */
  firstSeenAt: string | null;
  /** True when every configured alert for this ticker had already fired - the ones that most need recreating. */
  allFired: boolean;
}

export interface SeedSkip {
  symbol: string;
  description: string;
  reason: string;
}

export interface SeedPlan {
  candidates: SeedCandidate[];
  skipped: SeedSkip[];
  /** Rows read from each input, for reconciling against the plan. */
  rowsRead: { list: number; log: number };
}

interface RawRow {
  symbol: string;
  description: string;
  lastFiredAt: string | null;
  fired: boolean;
}

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

// "Mon 27 Jul '26 07:30:12" - the alert-list export's own format, which is
// neither ISO nor the split date/time the log export uses.
const LAST_TRIGGERED_RE = /^\w{3}\s+(\d{1,2})\s+(\w{3})\s+'(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/;

export function parseLastTriggered(raw: string): string | null {
  const match = LAST_TRIGGERED_RE.exec(raw.trim());
  if (!match) {
    return null;
  }
  const [, day, month, year, hh, mm, ss] = match;
  const monthIndex = MONTHS[month];
  if (monthIndex === undefined) {
    return null;
  }
  return new Date(Date.UTC(2000 + Number(year), monthIndex, Number(day), Number(hh), Number(mm), Number(ss))).toISOString();
}

/** Strips the ", 1D" chart-timeframe suffix TradingView appends to the Symbol column. */
export function baseSymbol(raw: string): string {
  return raw.split(",")[0].trim().toUpperCase();
}

function timeframeOf(raw: string): string | null {
  const parts = raw.split(",");
  return parts.length > 1 ? parts[1].trim() : null;
}

/**
 * Maps a TradingView volume alert's chart timeframe onto a VolumeCondition.
 * A 1D volume alert means "this much volume today"; an intraday one means
 * "this much within a rolling window of that length".
 */
export function volumeConditionFor(threshold: number, timeframe: string | null): VolumeCondition {
  if (timeframe === null || /^1d$/i.test(timeframe)) {
    return { threshold, mode: "today" };
  }
  const match = /^(\d+)\s*([mhdwMHDW])$/.exec(timeframe);
  if (!match) {
    return { threshold, mode: "today" };
  }
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "w") {
    return { threshold, mode: "period", periodValue: value * 7, periodUnit: "d" };
  }
  return { threshold, mode: "period", periodValue: value, periodUnit: unit as "m" | "h" | "d" };
}

function readListRows(path: string): RawRow[] {
  const records = parseCsv(readFileSync(path, "utf-8"), { columns: true, bom: true, skip_empty_lines: true }) as Record<
    string,
    string
  >[];
  return records.map((r) => ({
    symbol: (r["Symbol"] ?? "").trim(),
    description: (r["Description"] ?? "").trim(),
    lastFiredAt: parseLastTriggered(r["Last Triggered"] ?? ""),
    // "Stopped — Triggered" means TradingView disarmed it after firing: these
    // are exactly the alerts that no longer exist and must be recreated.
    fired: (r["Status"] ?? "").includes("Triggered"),
  }));
}

function readLogRows(path: string): RawRow[] {
  const records = parseCsv(readFileSync(path, "utf-8"), { columns: true, bom: true, skip_empty_lines: true }) as Record<
    string,
    string
  >[];
  return records.map((r) => {
    const date = (r["Alert Date"] ?? "").trim();
    const time = (r["Alert Time"] ?? "").trim();
    const parsed = date ? new Date(`${date}T${time.padStart(8, "0")}Z`) : null;
    return {
      symbol: (r["Symbol"] ?? "").trim(),
      description: (r["Description"] ?? "").trim(),
      lastFiredAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
      // Every row in the log is, by definition, an alert that fired.
      fired: true,
    };
  });
}

interface Accumulator {
  symbol: string;
  levels: number[];
  sides: ("above" | "below")[];
  volumes: { threshold: number; timeframe: string | null }[];
  rows: number;
  lastFiredAt: string | null;
  firstSeenAt: string | null;
  firedFlags: boolean[];
}

export function buildSeedPlan(listPath: string, logPath: string | null): SeedPlan {
  const listRows = readListRows(listPath);
  const logRows = logPath === null ? [] : readLogRows(logPath);

  const acc = new Map<string, Accumulator>();
  const skipped: SeedSkip[] = [];

  for (const row of [...listRows, ...logRows]) {
    if (!row.symbol || !row.description) {
      continue;
    }
    const symbol = baseSymbol(row.symbol);
    const timeframe = timeframeOf(row.symbol);
    const c = classifyDescription(row.description);

    if (c.alertType !== "price_cross" && c.alertType !== "volume_cross") {
      skipped.push({
        symbol,
        description: row.description,
        reason:
          c.alertType === "trendline_cross" || c.alertType === "pattern"
            ? `${c.alertType} alert — depends on a drawing on the chart, no numeric level to watch`
            : c.alertType === "ma_strategy"
              ? "moving-average strategy alert — not a price level this engine can watch"
              : "unrecognised alert description",
      });
      continue;
    }

    const entry = acc.get(symbol) ?? {
      symbol,
      levels: [],
      sides: [],
      volumes: [],
      rows: 0,
      lastFiredAt: null,
      firstSeenAt: null,
      firedFlags: [],
    };
    entry.rows += 1;
    entry.firedFlags.push(row.fired);
    if (row.lastFiredAt !== null && (entry.lastFiredAt === null || row.lastFiredAt > entry.lastFiredAt)) {
      entry.lastFiredAt = row.lastFiredAt;
    }
    if (row.lastFiredAt !== null && (entry.firstSeenAt === null || row.lastFiredAt < entry.firstSeenAt)) {
      entry.firstSeenAt = row.lastFiredAt;
    }

    if (c.alertType === "volume_cross" && c.level !== null) {
      entry.volumes.push({ threshold: c.level, timeframe });
    } else if (c.alertType === "price_cross" && c.level !== null) {
      entry.levels.push(c.level);
      if (c.direction !== null) {
        entry.sides.push(c.direction === "up" ? "above" : "below");
      }
      if (c.andVolume !== null) {
        entry.volumes.push({ threshold: c.andVolume, timeframe });
      }
    }
    acc.set(symbol, entry);
  }

  const candidates: SeedCandidate[] = [];
  for (const entry of acc.values()) {
    // A stated direction wins over inference. Mixed directions on one ticker
    // can't collapse into a single alert, so fall back to inferring.
    const distinctSides = [...new Set(entry.sides)];
    const side = distinctSides.length === 1 ? distinctSides[0] : null;

    if (entry.levels.length === 0) {
      // Volume alerts with no price alert on the ticker stay standalone.
      for (const v of entry.volumes) {
        candidates.push({
          symbol: entry.symbol,
          level: 0,
          side: null,
          volume: volumeConditionFor(v.threshold, v.timeframe),
          collapsedFrom: entry.rows,
          levelsSeen: [],
          lastFiredAt: entry.lastFiredAt,
          firstSeenAt: entry.firstSeenAt,
          allFired: entry.firedFlags.every(Boolean),
        });
      }
      continue;
    }

    // Collapse same-type levels to the outermost one: the highest for an
    // upside breakout (the most conservative target still ahead of price),
    // the lowest for a downside alert.
    const sorted = [...entry.levels].sort((a, b) => a - b);
    const level = side === "below" ? sorted[0] : sorted[sorted.length - 1];

    // Several volume alerts on one ticker collapse to the loosest threshold,
    // so combining them can't make the price alert harder to fire than the
    // price alert alone was.
    const volume =
      entry.volumes.length === 0
        ? null
        : volumeConditionFor(
            Math.min(...entry.volumes.map((v) => v.threshold)),
            entry.volumes[0].timeframe
          );

    candidates.push({
      symbol: entry.symbol,
      level,
      side,
      volume,
      collapsedFrom: entry.rows,
      levelsSeen: sorted,
      lastFiredAt: entry.lastFiredAt,
      firstSeenAt: entry.firstSeenAt,
      allFired: entry.firedFlags.every(Boolean),
    });
  }

  candidates.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { candidates, skipped, rowsRead: { list: listRows.length, log: logRows.length } };
}

/**
 * Guards against the ticker collisions in these exports (PPL configured at
 * both 37.14 and 231.55, ENS at 19.78 and 200.91 - a US listing and a foreign
 * one sharing a symbol). A level wildly out of line with the real price is one
 * of those, not a target worth seeding.
 */
export function isImplausibleLevel(level: number, lastClose: number): boolean {
  if (lastClose <= 0 || level <= 0) {
    return false;
  }
  const ratio = level / lastClose;
  return ratio > 3 || ratio < 1 / 3;
}

export interface ResolvedLevel {
  level: number | null;
  /** Levels dropped as belonging to a different instrument on the same ticker. */
  discarded: number[];
}

/**
 * Re-picks a candidate's level once the real price is known.
 *
 * "Highest level wins" is the right collapse rule within one instrument, but
 * on a colliding ticker it reliably picks the wrong listing - PPL's foreign
 * levels (231-243) outrank the US listing's 37.14. So drop the implausible
 * levels first and collapse over what's left, rather than discarding the
 * ticker wholesale over a level that was never the one that mattered.
 */
export function resolveLevel(candidate: SeedCandidate, lastClose: number): ResolvedLevel {
  if (candidate.levelsSeen.length === 0) {
    return { level: null, discarded: [] };
  }
  const plausible = candidate.levelsSeen.filter((l) => !isImplausibleLevel(l, lastClose));
  const discarded = candidate.levelsSeen.filter((l) => isImplausibleLevel(l, lastClose));
  if (plausible.length === 0) {
    return { level: null, discarded };
  }
  const level = candidate.side === "below" ? plausible[0] : plausible[plausible.length - 1];
  return { level, discarded };
}

/**
 * The close on (or the first session after) a past date, from bars already
 * fetched for re-levelling. Returns null when the date predates the fetched
 * window, in which case the narrative states the date without claiming a
 * percentage it can't support.
 */
export function closeOnOrAfter(bars: { date: Date; close: number }[], iso: string): number | null {
  const target = new Date(iso).getTime();
  let best: { date: Date; close: number } | null = null;
  for (const bar of bars) {
    if (bar.date.getTime() >= target && (best === null || bar.date.getTime() < best.date.getTime())) {
      best = bar;
    }
  }
  return best?.close ?? null;
}
