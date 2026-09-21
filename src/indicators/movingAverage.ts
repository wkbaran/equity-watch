/**
 * Simple and exponential moving averages over 1/2/5/15-minute, daily, and
 * weekly bars, for moving-average alerts (src/alerts/maEngine.ts).
 *
 * Source bars come from two fetches only: Schwab's 1-minute bars (aggregated
 * up to 2/5/15-minute) and its daily bars (aggregated up to weekly). No
 * timeframe costs a request of its own.
 *
 * An average is only ever taken over *completed* bars. The level in force at
 * any instant is the average of bars that closed before that instant's bar
 * began, so a daily or weekly MA holds still through the day and an intraday
 * one steps once per bar. Including the forming bar would make the level
 * chase the very price it's being compared to.
 *
 * Fewer bars than the period means no level (null), never an average of what
 * happens to be there. A 200-week SMA over a two-year-old listing is a
 * different number with the same name.
 */

import type { PriceBar } from "../models.js";
import { marketDate } from "../marketHours.js";
import { marketMinuteOfDay } from "../timezone.js";

export type MaType = "sma" | "ema";
export type MaTimeframe = "1m" | "2m" | "5m" | "15m" | "1D" | "1W";
export const MA_TIMEFRAMES: MaTimeframe[] = ["1m", "2m", "5m", "15m", "1D", "1W"];

/**
 * Bounded by the data, not taste: Schwab's minute history reaches back 10
 * trading days, which holds 260 fifteen-minute bars, and the daily fetch is
 * sized per alert. 200 covers every period asked for so far (9, 20, 200).
 */
export const MAX_MA_PERIOD = 200;

export interface MaSpec {
  maType: MaType;
  period: number;
  timeframe: MaTimeframe;
}

const INTRADAY_MINUTES: Partial<Record<MaTimeframe, number>> = { "1m": 1, "2m": 2, "5m": 5, "15m": 15 };

/** Bar length in minutes for an intraday timeframe; null for 1D/1W. */
export function intradayMinutes(timeframe: MaTimeframe): number | null {
  return INTRADAY_MINUTES[timeframe] ?? null;
}

function validatePeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`Moving-average period must be a positive integer, got ${period}`);
  }
}

/** Rolling mean aligned to the input: result[i] ends at values[i], null until `period` values exist. */
export function sma(values: number[], period: number): (number | null)[] {
  validatePeriod(period);
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) {
      sum -= values[i - period];
    }
    if (i >= period - 1) {
      out[i] = sum / period;
    }
  }
  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `period`
 * values and smoothed with 2 / (period + 1) after that - the common charting
 * convention. An EMA remembers its seed, so it only matches a chart that has
 * more history once it has run for several periods; the fetch windows below
 * give EMAs four periods of warm-up for that reason.
 */
export function ema(values: number[], period: number): (number | null)[] {
  validatePeriod(period);
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) {
    return out;
  }
  let prev = 0;
  for (let i = 0; i < period; i++) {
    prev += values[i];
  }
  prev /= period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function movingAverage(maType: MaType, values: number[], period: number): (number | null)[] {
  return maType === "sma" ? sma(values, period) : ema(values, period);
}

/**
 * Which bar of `timeframe` an instant falls in, as a string that sorts in
 * time order. Bucketed by the exchange's clock, not UTC: a daily candle
 * stamped at Eastern midnight must not slide into the neighbouring day, and
 * intraday bars align to the session (9:30, 9:35, ... since 570 minutes is a
 * multiple of 2, 5, and 15).
 */
export function bucketKey(date: Date, timeframe: MaTimeframe): string {
  const day = marketDate(date);
  const minutes = intradayMinutes(timeframe);
  if (minutes !== null) {
    const start = Math.floor(marketMinuteOfDay(date) / minutes) * minutes;
    return `${day}T${String(start).padStart(4, "0")}`;
  }
  if (timeframe === "1D") {
    return day;
  }
  const monday = new Date(`${day}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

/**
 * Group source bars (1-minute for intraday timeframes, daily for 1D/1W) into
 * `timeframe` bars: first open, max high, min low, last close, summed volume.
 * Input order doesn't matter and input bars aren't mutated.
 */
export function aggregateBars(barsInput: PriceBar[], timeframe: MaTimeframe): { key: string; bar: PriceBar }[] {
  const bars = [...barsInput].sort((a, b) => a.date.getTime() - b.date.getTime());
  const out: { key: string; bar: PriceBar }[] = [];
  for (const bar of bars) {
    const key = bucketKey(bar.date, timeframe);
    const last = out[out.length - 1];
    if (last === undefined || last.key !== key) {
      out.push({ key, bar: { ...bar } });
      continue;
    }
    last.bar.high = Math.max(last.bar.high, bar.high);
    last.bar.low = Math.min(last.bar.low, bar.low);
    last.bar.close = bar.close;
    last.bar.volume += bar.volume;
  }
  return out;
}

/**
 * Returns a lookup for the moving-average level in force at a given instant:
 * the average over `timeframe` bars that completed before that instant's bar.
 */
export function levelAt(sourceBars: PriceBar[], spec: MaSpec): (at: Date) => number | null {
  const buckets = aggregateBars(sourceBars, spec.timeframe);
  const series = movingAverage(
    spec.maType,
    buckets.map((b) => b.bar.close),
    spec.period
  );
  const keys = buckets.map((b) => b.key);

  return (at: Date) => {
    const key = bucketKey(at, spec.timeframe);
    // Last bucket strictly before `at`'s bucket.
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[mid] < key) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo === 0 ? null : series[lo - 1];
  };
}

/** Bars of history an average needs: the period, or four periods for an EMA's warm-up. */
function barsWanted(spec: MaSpec): number {
  return spec.maType === "ema" ? spec.period * 4 : spec.period;
}

/** Calendar days of daily bars to fetch for a 1D/1W average. */
export function dailyLookbackDays(spec: MaSpec): number {
  const bars = barsWanted(spec);
  return spec.timeframe === "1W" ? bars * 7 + 21 : Math.ceil((bars * 7) / 5) + 21;
}

/** Trading sessions of 1-minute bars an intraday average needs (390 regular-session minutes each). */
export function intradaySessionsNeeded(spec: MaSpec): number {
  const minutes = intradayMinutes(spec.timeframe);
  if (minutes === null) {
    return 0;
  }
  return Math.ceil((barsWanted(spec) * minutes) / 390) + 1;
}

/** The most trailing days of 1-minute bars Schwab's price history will serve. */
export const MAX_INTRADAY_HISTORY_DAYS = 10;

/**
 * Schwab's price history takes `period` for periodType=day only as 1-5 or 10.
 * Round a day count up to one it accepts; beyond 10 there's no more minute
 * history to ask for.
 */
export function schwabIntradayPeriod(days: number): number {
  return [1, 2, 3, 4, 5, MAX_INTRADAY_HISTORY_DAYS].find((p) => p >= days) ?? MAX_INTRADAY_HISTORY_DAYS;
}

const SPEC_RE = /^(sma|ema)(\d+)@(1m|2m|5m|15m|1d|1w)$/i;

/** Parses "sma200@1W" / "ema9@5m". Throws with a usage message on anything else. */
export function parseMaSpec(raw: string): MaSpec {
  const match = SPEC_RE.exec(raw.trim());
  if (match === null) {
    throw new Error(
      `Invalid moving average "${raw}". Expected sma|ema, a period, @, and a timeframe ` +
        `(${MA_TIMEFRAMES.join(" ")}), e.g. sma200@1W or ema9@5m.`
    );
  }
  const period = Number(match[2]);
  if (period < 1 || period > MAX_MA_PERIOD) {
    throw new Error(`Moving-average period must be between 1 and ${MAX_MA_PERIOD}, got ${period}.`);
  }
  const tf = match[3].toLowerCase();
  const timeframe = (tf === "1d" ? "1D" : tf === "1w" ? "1W" : tf) as MaTimeframe;
  return { maType: match[1].toLowerCase() as MaType, period, timeframe };
}

/** "200-week SMA", "9-day EMA", "9-bar EMA on 5-minute bars". */
export function maLabel(spec: MaSpec): string {
  const type = spec.maType.toUpperCase();
  if (spec.timeframe === "1D") {
    return `${spec.period}-day ${type}`;
  }
  if (spec.timeframe === "1W") {
    return `${spec.period}-week ${type}`;
  }
  return `${spec.period}-bar ${type} on ${intradayMinutes(spec.timeframe)}-minute bars`;
}
