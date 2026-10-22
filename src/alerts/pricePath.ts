/**
 * Static and trailing alerts are judged over the minute bars since they were
 * last checked, not just the quote at the moment of the check. A level
 * crossed and crossed back between two checks, or a low that recovered before
 * the next one, used to be invisible.
 *
 * Only each bar's close is read, never its high or low (the user's call,
 * 2026-10-02, to keep the queue quiet). A wick through a level and back inside
 * one minute is not a cross, as for a moving-average cross, and a trailing low
 * is the lowest close, so one stray print can't set a low that never traded
 * for a minute. Closes also come in order, which a bar's high and low do not,
 * so every rule here is the old snapshot rule applied once a minute instead of
 * once a check.
 *
 * Outside the regular session the quote is never judged at all (2026-10-22).
 * Schwab's pre-market `lastPrice` can sit far from anything that traded: on
 * 2026-10-22, 14 of 16 pre-market fires (ROCK at 43.13, opening at 38.34) had
 * no extended-hours minute bar near the level, most none at all. There the
 * quote only decides whether to fetch extended-hours bars (`quoteReaches`),
 * and only their closes can cross a level.
 */

import type { PriceBar } from "../models.js";
import type { Quote } from "../providers/schwab.js";
import { marketDate } from "../marketHours.js";
import type { Session } from "../marketHours.js";
import { MARKET_TIME_ZONE, marketMinuteOfDay, wallClock, zonedTimeToUtc } from "../timezone.js";
import { effectiveTrigger, type AlertSide, type StaticAlert, type TrailingAlert } from "./models.js";

export const MINUTE_MS = 60_000;

export interface PricePoint {
  at: Date;
  price: number;
  /** A completed minute bar's close, as opposed to the live quote. */
  fromBar: boolean;
}

export function barPoint(bar: PriceBar): PricePoint {
  return { at: bar.date, price: bar.close, fromBar: true };
}

export function quotePoint(price: number, at: Date): PricePoint {
  return { at, price, fromBar: false };
}

const OPEN_MINUTE = 9 * 60 + 30;
const CLOSE_MINUTE = 16 * 60;

/**
 * The session a minute bar traded in, by the exchange clock. Half days aren't
 * known, so a bar after a 13:00 close reads as regular.
 */
export function barSession(at: Date): Session {
  const minute = marketMinuteOfDay(at);
  return minute < OPEN_MINUTE ? "pre" : minute >= CLOSE_MINUTE ? "post" : "regular";
}

/**
 * The side of `level` a point is on, if it differs from `side`. "Above" means
 * strictly above, as it always has: a price on the level is below.
 */
export function crossingOf(side: AlertSide, level: number, p: PricePoint): AlertSide | null {
  const now: AlertSide = p.price > level ? "above" : "below";
  return now === side ? null : now;
}

/**
 * One point of a trailing alert. `side: "below"` follows the low and fires on
 * a rise off it; "above" follows the high and fires on a fall. A new extreme
 * never fires on the same point. After a fire the caller restarts the extreme
 * at the fire's price.
 */
export function trailStep(alert: TrailingAlert, extreme: number, p: PricePoint): { fire: boolean; extreme: number } {
  const up = alert.side === "below";
  if (up ? p.price < extreme : p.price > extreme) {
    return { fire: false, extreme: p.price };
  }
  const trigger = effectiveTrigger({ ...alert, extremePrice: extreme });
  return { fire: up ? p.price >= trigger : p.price <= trigger, extreme };
}

/**
 * Whether today's high and low (from the quote) speak for every price since
 * `since`. True when `since` is on today's trading date, or after the close
 * of a day with no weekday between it and today. Holidays make it answer
 * false, which only costs a bar fetch.
 */
export function dayRangeCovers(since: Date, now: Date): boolean {
  const sinceDate = marketDate(since);
  const today = marketDate(now);
  if (sinceDate === today) return true;
  if (marketMinuteOfDay(since) < 16 * 60) return false;
  const day = new Date(`${sinceDate}T12:00:00Z`);
  for (day.setUTCDate(day.getUTCDate() + 1); day.toISOString().slice(0, 10) < today; day.setUTCDate(day.getUTCDate() + 1)) {
    const weekday = day.getUTCDay();
    if (weekday !== 0 && weekday !== 6) return false;
  }
  return true;
}

/**
 * Whether anything in today's range could matter to this alert. False lets
 * the check skip fetching bars for the symbol; most levels on most days are
 * nowhere near the price.
 */
export function rangeReaches(alert: StaticAlert | TrailingAlert, dayLow: number, dayHigh: number): boolean {
  if (alert.kind === "static") {
    return dayLow <= alert.level && alert.level <= dayHigh;
  }
  const trigger = effectiveTrigger(alert);
  return alert.side === "below"
    ? dayLow < alert.extremePrice || dayHigh >= trigger
    : dayHigh > alert.extremePrice || dayLow <= trigger;
}

/**
 * Whether the live quote, taken at its word, would move this alert: a static
 * alert's price on the other side of its level, or a trailing alert's past its
 * extreme or its trigger. Outside the regular session that is only a reason to
 * look at the minute bars, never a crossing in itself.
 */
export function quoteReaches(alert: StaticAlert | TrailingAlert, price: number): boolean {
  if (alert.kind === "static") {
    return crossingOf(alert.lastKnownSide, alert.level, quotePoint(price, new Date(0))) !== null;
  }
  return rangeReaches(alert, price, price);
}

/** The quote's day range, when it gave a usable one. */
export function dayRangeOf(quote: Quote): { low: number; high: number } | null {
  const { dayLow, dayHigh } = quote;
  if (dayLow === undefined || dayHigh === undefined || !(dayLow > 0) || !(dayHigh >= dayLow)) return null;
  return { low: dayLow, high: dayHigh };
}

/**
 * The points to judge an alert over, and the instant it has then been judged
 * through. Completed bars since `lastEvaluatedAt` when there are any; the
 * live quote otherwise (extended hours, a symbol whose range reached nothing,
 * a failed fetch, an alert's first check).
 *
 * Never both. The quote falls inside a bar that is still forming, so judging
 * the quote now and that bar next time would see the same move twice. When
 * the quote is used, the watermark becomes now, which leaves out the rest of
 * the bar it fell in: at most a minute unseen, never a minute seen twice.
 *
 * With `quoteUsable` false (outside the regular session) there is no quote
 * fallback: no bars means nothing to judge. The watermark then stops a minute
 * short of the current one, so a bar still forming, or completed but not yet
 * served, is read at the next check rather than skipped.
 */
export function pricePath(
  alert: StaticAlert | TrailingAlert,
  bars: PriceBar[] | null,
  quote: Quote,
  now: Date,
  quoteUsable = true
): { points: PricePoint[]; through: Date } {
  if (alert.lastEvaluatedAt !== undefined && bars !== null) {
    const since = new Date(alert.lastEvaluatedAt).getTime();
    const complete = bars.filter((b) => b.date.getTime() >= since && b.date.getTime() + MINUTE_MS <= now.getTime());
    if (complete.length > 0) {
      const last = complete[complete.length - 1];
      return { points: complete.map(barPoint), through: new Date(last.date.getTime() + MINUTE_MS) };
    }
    if (!quoteUsable) {
      const settled = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS - MINUTE_MS;
      return { points: [], through: new Date(Math.max(since, settled)) };
    }
  }
  if (!quoteUsable) {
    return { points: [], through: now };
  }
  return { points: [quotePoint(quote.lastPrice, now)], through: now };
}

/** The most recent weekday 16:00 Eastern at or before `now`. Holidays aren't known. */
export function lastCloseBefore(now: Date): Date {
  const w = wallClock(now, MARKET_TIME_ZONE);
  const day = new Date(Date.UTC(w.year, w.month - 1, w.day));
  if (marketMinuteOfDay(now) < CLOSE_MINUTE) day.setUTCDate(day.getUTCDate() - 1);
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() - 1);
  return zonedTimeToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 16, 0, 0, MARKET_TIME_ZONE);
}

/**
 * Whether a regular-session minute bar can have completed since `since`. The
 * bars are regular-session only, and the check runs around the clock, so
 * without this every overnight check would ask for bars for every symbol whose
 * quote gives no day range (Schwab reports 0 for both overnight on some).
 *
 * During the regular session, yes. Outside it, only when the watermark is
 * older than the last close: the first check after a close picks up the last
 * bars, and the rest of the night asks for nothing. A holiday's checks look
 * like that too, so a holiday costs one round of fetches, not one per check.
 */
export function barsMayExist(since: Date, now: Date, session: Session | null): boolean {
  if (session === "regular") return true;
  if (since < lastCloseBefore(now)) return true;
  if (session !== null) return false;
  // No session known: go by the clock.
  const weekday = new Date(`${marketDate(now)}T12:00:00Z`).getUTCDay();
  const minute = marketMinuteOfDay(now);
  return weekday !== 0 && weekday !== 6 && minute >= OPEN_MINUTE && minute < CLOSE_MINUTE;
}
