/**
 * Evaluating moving-average alerts (MaAlert in ./models.ts).
 *
 * Each check replays the price path since the previous check - the 1-minute
 * bars in between, then the live quote - rather than comparing two snapshots.
 * Two things depend on that:
 *
 *   - A cross that reverses between polls still fires. Compared snapshot to
 *     snapshot, price below -> above -> below again looks like nothing.
 *   - An average on bars shorter than the poll interval means something. A
 *     9-bar SMA on 1-minute bars moves every minute; with a 2-minute poll,
 *     half its values would otherwise never be compared against price.
 *
 * Crosses are judged on closes (the live quote counts as a close), so a wick
 * through the average and back is a touch, not a cross. Touches use each
 * bar's full high-low range.
 *
 * Re-fire suppression:
 *   - at most one trigger per check, and per MA bar (`lastFiredBucket`), which
 *     is TradingView's "once per bar" - price chopping around a 1-minute
 *     average would otherwise fire every poll;
 *   - a touch must also leave the band by twice the margin before it re-arms
 *     (`inBand`), so hovering at the edge of the band isn't a stream of touches.
 */

import type { PriceBar } from "../models.js";
import type { Quote } from "../providers/schwab.js";
import {
  bucketKey,
  dailyLookbackDays,
  intradayMinutes,
  intradaySessionsNeeded,
  levelAt as buildLevelAt,
  maLabel,
  schwabIntradayPeriod,
} from "../indicators/movingAverage.js";
import type { AlertSide, MaAlert, MaEvent } from "./models.js";

/** Default touch band. Small enough to mean "at the average" on a daily chart. */
export const DEFAULT_TOUCH_MARGIN_PCT = 0.25;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export interface PathPoint {
  at: Date;
  low: number;
  high: number;
  close: number;
}

export interface MaEvaluation {
  event: MaEvent | null;
  price: number | null;
  /** The average's value when it fired, rounded to the cent. */
  level: number | null;
  at: Date | null;
  approachedFrom: AlertSide | null;
}

function sideOf(price: number, level: number): AlertSide | null {
  return price > level ? "above" : price < level ? "below" : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Walk `path` in time order, advancing the alert's state and reporting the
 * first qualifying event. Mutates `alert` (state fields only). The first
 * evaluation of a new alert only seeds its state and never fires, the same as
 * a holdings alert's first check, so adding an alert can't fire immediately.
 */
export function evaluateMaAlert(
  alert: MaAlert,
  pathInput: PathPoint[],
  levelAt: (at: Date) => number | null,
  now: Date
): MaEvaluation {
  const path = [...pathInput].sort((a, b) => a.at.getTime() - b.at.getTime());
  const result: MaEvaluation = { event: null, price: null, level: null, at: null, approachedFrom: null };

  for (const p of path) {
    const level = levelAt(p.at);
    if (level === null) {
      continue;
    }
    alert.lastLevel = round2(level);
    const band = (level * alert.marginPct) / 100;
    const closeSide = sideOf(p.close, level);
    const touching = p.low <= level + band && p.high >= level - band;

    if (alert.lastSide === null) {
      // Seeding. Exactly on the average has no side; wait for a point that does.
      alert.lastSide = closeSide;
      alert.inBand = touching;
      continue;
    }

    const before = alert.lastSide;
    let candidate: MaEvent | null = null;
    if (alert.trigger === "touch") {
      if (alert.inBand) {
        if (p.low > level + 2 * band || p.high < level - 2 * band) {
          alert.inBand = false;
        }
      } else if (touching) {
        alert.inBand = true;
        if (alert.from === "either" || alert.from === before) {
          candidate = "touch";
        }
      }
    } else if (closeSide !== null && closeSide !== before) {
      if (alert.from === "either" || alert.from === before) {
        candidate = closeSide === "above" ? "cross_up" : "cross_down";
      }
    }
    if (closeSide !== null) {
      alert.lastSide = closeSide;
    }

    if (candidate !== null && result.event === null) {
      const bucket = bucketKey(p.at, alert.timeframe);
      if (alert.lastFiredBucket !== bucket) {
        alert.lastFiredBucket = bucket;
        result.event = candidate;
        result.price = p.close;
        result.level = round2(level);
        result.at = p.at;
        result.approachedFrom = before;
      }
    }
  }

  alert.lastEvaluatedAt = now.toISOString();
  return result;
}

/** Daily bars covering `lookbackDays` back from now. Injected so the CLI can cache per market date. */
export type DailyHistoryResolver = (symbol: string, lookbackDays: number) => Promise<PriceBar[]>;

export interface MaMarket {
  getIntradayBars(symbol: string, daysBack: number): Promise<PriceBar[]>;
}

export interface MaCheckResult {
  alert: MaAlert;
  evaluation: MaEvaluation;
}

/**
 * Evaluate every live moving-average alert. Fetches at most one set of
 * 1-minute bars and one set of daily bars per symbol, however many averages
 * that symbol has. Symbols that fail to fetch are reported in `warnings` and
 * left untouched, so they're re-evaluated over the whole gap next time.
 */
export async function checkMaAlerts(
  alerts: MaAlert[],
  quotes: Map<string, Quote>,
  market: MaMarket,
  resolveDaily: DailyHistoryResolver,
  now: Date
): Promise<{ results: MaCheckResult[]; warnings: string[] }> {
  const bySymbol = new Map<string, MaAlert[]>();
  for (const alert of alerts) {
    bySymbol.set(alert.symbol, [...(bySymbol.get(alert.symbol) ?? []), alert]);
  }

  const results: MaCheckResult[] = [];
  const warnings: string[] = [];

  for (const [symbol, symbolAlerts] of bySymbol) {
    const quote = quotes.get(symbol);
    if (quote === undefined) {
      continue;
    }

    let minuteDays = 0;
    let dailyDays = 0;
    for (const alert of symbolAlerts) {
      if (intradayMinutes(alert.timeframe) !== null) {
        minuteDays = Math.max(minuteDays, intradaySessionsNeeded(alert));
      } else {
        dailyDays = Math.max(dailyDays, dailyLookbackDays(alert));
      }
      // Every seeded alert needs the minute path since it was last evaluated,
      // including 1D/1W ones: that's what catches a cross between polls.
      if (alert.lastEvaluatedAt !== null) {
        const gapDays = Math.ceil((now.getTime() - new Date(alert.lastEvaluatedAt).getTime()) / DAY_MS) + 1;
        minuteDays = Math.max(minuteDays, gapDays);
      }
    }

    let minuteBars: PriceBar[] = [];
    let dailyBars: PriceBar[] = [];
    try {
      if (minuteDays > 0) {
        minuteBars = await market.getIntradayBars(symbol, schwabIntradayPeriod(minuteDays));
      }
      if (dailyDays > 0) {
        dailyBars = await resolveDaily(symbol, dailyDays);
      }
    } catch (err) {
      warnings.push(`${symbol}: moving-average bars unavailable (${err})`);
      continue;
    }

    const live: PathPoint = { at: now, low: quote.lastPrice, high: quote.lastPrice, close: quote.lastPrice };

    for (const alert of symbolAlerts) {
      const source = intradayMinutes(alert.timeframe) !== null ? minuteBars : dailyBars;
      const levelAt = buildLevelAt(source, alert);
      if (levelAt(now) === null) {
        warnings.push(`${symbol}: not enough history for the ${maLabel(alert)} (alert ${alert.id})`);
      }

      let path: PathPoint[] = [live];
      if (alert.lastEvaluatedAt !== null) {
        const since = new Date(alert.lastEvaluatedAt).getTime();
        const between = minuteBars
          // Bars that ended after the last check. Re-reading one minute twice is
          // harmless: the side and band logic are idempotent for a repeated point.
          .filter((b) => b.date.getTime() + MINUTE_MS > since && b.date.getTime() <= now.getTime())
          .map((b) => ({ at: b.date, low: b.low, high: b.high, close: b.close }));
        path = [...between, live];
      }

      results.push({ alert, evaluation: evaluateMaAlert(alert, path, levelAt, now) });
    }
  }

  return { results, warnings };
}

/** "cross up through 200-week SMA", "touch 9-bar EMA on 5-minute bars within 0.25% from above". */
export function describeMaAlert(alert: MaAlert): string {
  const label = maLabel(alert);
  if (alert.trigger === "touch") {
    const from = alert.from === "either" ? "" : ` from ${alert.from}`;
    return `touch ${label} within ${alert.marginPct}%${from}`;
  }
  const direction = alert.from === "below" ? "cross up through" : alert.from === "above" ? "cross down through" : "cross";
  return `${direction} ${label}`;
}
