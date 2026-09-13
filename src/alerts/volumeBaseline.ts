/**
 * "Typical volume" for a volume condition's window, so a threshold can be
 * expressed as a multiple of normal rather than an absolute share count.
 *
 * Absolute thresholds rot. A 55,000-share weekly threshold on MTD was 22x too
 * low by the time it was imported, and fired on 82 of 82 sessions - it had
 * stopped meaning anything and nothing said so. A ratio recomputed against a
 * trailing baseline can't drift out of range as a stock's liquidity changes.
 *
 * The baseline is computed differently per window, because the naive version
 * is wrong in a different way each time:
 *
 *   today  - average FULL-day volume over the last `sessions` trading days.
 *            Today's own figure is partial, so the ratio climbs through the
 *            session: "1.5x" means "today is already a 1.5x-volume day",
 *            which is a real signal but one that rarely trips before midday.
 *   N days - the average of rolling N-CALENDAR-day sums, not avgDaily * N.
 *            A 7-calendar-day window holds ~5 trading days, so multiplying
 *            would overstate the baseline by around 40%.
 *   N h/m  - matched by time of day. Intraday volume is U-shaped, so a flat
 *            average would make every market open look like a spike and every
 *            lunchtime look dead.
 */

import { marketDate } from "../marketHours.js";
import type { PriceBar } from "../models.js";
import { marketMinuteOfDay } from "../timezone.js";
import type { VolumeCondition } from "./models.js";

/** Trading days of history used for a daily baseline. Matches AnalysisParams.baselineDays. */
export const BASELINE_SESSIONS = 20;
/** Sessions of intraday history used for a sub-day baseline. */
export const INTRADAY_BASELINE_SESSIONS = 10;

const MS_PER_DAY = 86_400_000;

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Average full-day volume over the most recent `sessions` bars. */
export function dailyBaseline(bars: PriceBar[], sessions = BASELINE_SESSIONS): number {
  const recent = bars.slice(-sessions);
  return mean(recent.map((b) => b.volume));
}

/**
 * Average volume accumulated in a rolling window of `days` calendar days.
 *
 * Every bar anchors one window ending at that bar, and windows are only
 * counted once enough history precedes them - otherwise the first few
 * windows are short and drag the average down.
 */
export function rollingWindowBaseline(bars: PriceBar[], days: number): number {
  if (bars.length === 0) {
    return 0;
  }
  const sorted = [...bars].sort((a, b) => a.date.getTime() - b.date.getTime());
  const firstTime = sorted[0].date.getTime();
  const windowMs = days * MS_PER_DAY;
  const sums: number[] = [];

  for (const anchor of sorted) {
    const end = anchor.date.getTime();
    if (end - firstTime < windowMs) {
      continue; // not enough history behind this bar for a full window
    }
    const start = end - windowMs;
    sums.push(
      sorted.filter((b) => b.date.getTime() > start && b.date.getTime() <= end).reduce((s, b) => s + b.volume, 0)
    );
  }
  return mean(sums);
}

/**
 * Average volume in a window of `windowMs` ending at the same clock time as
 * `now`, across the sessions covered by `bars`.
 *
 * Grouping by trading date keeps each session's window separate, so the
 * result reflects "how much normally trades at this time of day" rather than
 * a flat hourly average that ignores the open/close humps.
 *
 * Clock time and date are both taken on the exchange's clock. In UTC the
 * session moves by an hour at every DST change, so a UTC time-of-day match
 * compares each session before the change against the wrong hour.
 */
export function intradayBaseline(bars: PriceBar[], windowMs: number, now: Date): number {
  if (bars.length === 0) {
    return 0;
  }
  const endMinutes = marketMinuteOfDay(now);
  const windowMinutes = windowMs / 60_000;

  const perSession = new Map<string, number>();
  for (const bar of bars) {
    const day = marketDate(bar.date);
    const minutes = marketMinuteOfDay(bar.date);
    if (minutes > endMinutes || minutes <= endMinutes - windowMinutes) {
      continue;
    }
    perSession.set(day, (perSession.get(day) ?? 0) + bar.volume);
  }

  // Drop today's own partial accumulation - it is the thing being measured.
  const today = marketDate(now);
  perSession.delete(today);

  return mean([...perSession.values()]);
}

export interface BaselineSource {
  getDailyBars(symbol: string, start: Date, end: Date): Promise<PriceBar[]>;
  getIntradayBars(symbol: string, daysBack: number): Promise<PriceBar[]>;
}

/** How much history a condition's baseline needs, in calendar days. */
export function historyDaysFor(condition: VolumeCondition): number {
  if (condition.mode === "today") {
    return Math.ceil(BASELINE_SESSIONS * 1.6) + 10;
  }
  if (condition.periodUnit === "d") {
    // Enough windows to average over, plus one window of lead-in.
    return (condition.periodValue ?? 1) * (BASELINE_SESSIONS + 1);
  }
  return INTRADAY_BASELINE_SESSIONS;
}

export async function computeBaseline(
  symbol: string,
  condition: VolumeCondition,
  source: BaselineSource,
  now: Date = new Date()
): Promise<number> {
  if (condition.mode === "today") {
    const start = new Date(now.getTime() - historyDaysFor(condition) * MS_PER_DAY);
    return dailyBaseline(await source.getDailyBars(symbol, start, now));
  }

  if (condition.periodUnit === "d") {
    const days = condition.periodValue ?? 1;
    const start = new Date(now.getTime() - historyDaysFor(condition) * MS_PER_DAY);
    return rollingWindowBaseline(await source.getDailyBars(symbol, start, now), days);
  }

  const unitMs = condition.periodUnit === "h" ? 3_600_000 : condition.periodUnit === "m" ? 60_000 : 1_000;
  const windowMs = (condition.periodValue ?? 1) * unitMs;
  return intradayBaseline(await source.getIntradayBars(symbol, INTRADAY_BASELINE_SESSIONS), windowMs, now);
}

/** Stable cache key for a symbol + window shape. */
export function baselineKey(symbol: string, condition: VolumeCondition): string {
  const window = condition.mode === "today" ? "today" : `${condition.periodValue}${condition.periodUnit}`;
  return `${symbol.replace(/[^A-Za-z0-9_-]/g, "_")}_${window}`;
}

/**
 * The share count a condition currently requires.
 *
 * An absolute `threshold` is returned as-is. A `ratio` is multiplied by the
 * baseline; a baseline of zero (no history, or a symbol that simply doesn't
 * trade) yields null rather than zero, so the caller treats it as "can't
 * evaluate" instead of "any volume qualifies".
 */
export function requiredVolume(condition: VolumeCondition, baseline: number | null): number | null {
  if (condition.threshold !== undefined) {
    return condition.threshold;
  }
  if (condition.ratio === undefined) {
    return null;
  }
  if (baseline === null || baseline <= 0) {
    return null;
  }
  return condition.ratio * baseline;
}
