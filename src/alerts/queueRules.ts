/**
 * What the revisit queue holds and in what order (the user's rules, 2026-10-23).
 *
 * Three kinds of row, all stored as revisit entries so dismissing, closing on a
 * change to the symbol, the drawer and the publish fingerprint work the same
 * for each:
 *
 * - **Fires.** New ones go to the top. One that ran `accelerationPct` past its
 *   level within `accelerationDays` of firing is marked `accelerated` and goes
 *   above them.
 * - **Reminders.** A dismissal waits `snoozeDays` trading days (the dismiss
 *   chooses, `dismissDays` by default). After that, if price has kept going in
 *   the alert's direction past where it was when dismissed, the entry reopens:
 *   relevel it, remove it, or dismiss it again to start the wait over.
 * - **Drifts.** An alert with no fire for `driftDays` whose price sits
 *   `driftPct` on the wrong side of its level: relevel it the other way or
 *   replace it, say with a trailing alert.
 *
 * Everything here is judged on a regular-session price only (the quote is a
 * hint outside it), and run by `alert check`. Priority is computed when the
 * document is built, from recorded facts and the trading-day clock, never from
 * a live price, so it publishes when something happened or a day turned over
 * and not on every check.
 */

import type { Alert, CrossDirection, StaticAlert } from "./models.js";
import { describeAlertCondition } from "./describe.js";
import { newRevisitEntry, type RevisitEntry } from "./revisit.js";
import { entryDirection, tradingDaysAfter, watchesDirection } from "./reversion.js";
import { round } from "../round.js";

export interface QueueSettings {
  /** Percent past the level that marks a fire as accelerating. */
  accelerationPct: number;
  /** Trading days after a fire that count as "fast", and that a fire stays new. */
  accelerationDays: number;
  /** Trading days a dismissal waits by default before it may come back. */
  dismissDays: number;
  /** Calendar days with no fire (or change) before an alert can drift. */
  driftDays: number;
  /** Percent on the wrong side of the level that counts as drifted. */
  driftPct: number;
}

export const DEFAULT_QUEUE_SETTINGS: QueueSettings = {
  accelerationPct: 2,
  accelerationDays: 2,
  dismissDays: 7,
  driftDays: 21,
  driftPct: 6,
};

export function queueSettings(config: { revisitQueue?: Partial<QueueSettings> } | null): QueueSettings {
  return { ...DEFAULT_QUEUE_SETTINGS, ...(config?.revisitQueue ?? {}) };
}

export const isFire = (e: RevisitEntry): boolean => e.reason === undefined;

/** Percent price sits past `level` in `dir`: positive past it, negative short of it. */
function pctPast(price: number, level: number, dir: CrossDirection): number {
  return ((dir === "up" ? price - level : level - price) / level) * 100;
}

const watchedDirection = (a: StaticAlert): CrossDirection | null => (a.direction === "either" ? null : a.direction);

/** A fire of this alert later than `after`. Drift entries are not fires. */
function firedSince(entries: RevisitEntry[], alertId: string, after: string): boolean {
  return entries.some((e) => isFire(e) && e.followUpOf === undefined && e.alertId === alertId && e.triggeredAt > after);
}

/**
 * When something last happened to this alert: created, fired, or one of its
 * entries closed because someone acted on the symbol. A drift is measured from it.
 */
function lastActivity(alert: Alert, entries: RevisitEntry[]): string {
  let latest = alert.createdAt;
  if (alert.lastTriggeredAt !== null && alert.lastTriggeredAt > latest) latest = alert.lastTriggeredAt;
  for (const e of entries) {
    if (e.alertId !== alert.id) continue;
    if (isFire(e) && e.triggeredAt > latest) latest = e.triggeredAt;
    if (e.status === "applied" && e.resolvedAt !== null && e.resolvedAt > latest) latest = e.resolvedAt;
  }
  return latest;
}

export interface QueueRulesResult {
  /** New drift entries. Append these to the store. */
  created: RevisitEntry[];
  /** Stored entries changed in place: marked, reopened, closed, or given a dismissal price. */
  changed: RevisitEntry[];
  /** One terminal line per thing that happened, for the check's output. */
  lines: string[];
}

/**
 * Applies the three rules to the stored queue, in place. `prices` holds
 * regular-session prices only: pass an empty map outside the session and
 * nothing is judged.
 */
export function applyQueueRules(
  entries: RevisitEntry[],
  alerts: Alert[],
  prices: Map<string, number>,
  now: Date,
  settings: QueueSettings = DEFAULT_QUEUE_SETTINGS,
  ignored: Set<string> = new Set()
): QueueRulesResult {
  const created: RevisitEntry[] = [];
  const changed = new Set<RevisitEntry>();
  const lines: string[] = [];
  if (prices.size === 0) return { created, changed: [], lines };

  const nowIso = now.toISOString();
  const alertsById = new Map(alerts.map((a) => [a.id, a]));
  const priceOf = (symbol: string) => prices.get(symbol);

  for (const e of entries) {
    if (e.followUpOf !== undefined || ignored.has(e.symbol.toUpperCase())) continue;
    const price = priceOf(e.symbol);
    if (price === undefined) continue;
    const alert = alertsById.get(e.alertId);
    const live = alert !== undefined && alert.status === "live" && alert.kind === "static" ? alert : null;

    // A fire closes the alert's open drift: it isn't drifting any more.
    if (!isFire(e) && e.status === "open" && firedSince(entries, e.alertId, e.triggeredAt)) {
      e.status = "dismissed";
      e.resolvedAt = nowIso;
      e.snoozeDays = null;
      changed.add(e);
      lines.push(`  ${e.symbol}: closed its drift entry ${e.id}, the alert fired since.`);
      continue;
    }

    // (a) A fast run past the level, while the fire is still new.
    if (isFire(e) && e.status === "open" && e.accelerated === undefined && e.kind === "static" && e.levelAtTrigger !== null) {
      const dir = entryDirection(e);
      if (dir !== null && tradingDaysAfter(new Date(e.triggeredAt), now) <= settings.accelerationDays) {
        const pct = pctPast(price, e.levelAtTrigger, dir);
        if (pct >= settings.accelerationPct) {
          e.accelerated = { at: nowIso, price, pct: round(pct, 1) };
          changed.add(e);
          lines.push(`  ${e.symbol}: ${round(pct, 1)}% past ${e.levelAtTrigger} since firing; marked accelerating (revisit ${e.id}).`);
        }
      }
    }

    // (b) Dismissed: note where it was, then bring it back if it kept going.
    // A dismissal is a wait, never an end (the user's rule). Only `null`, set
    // when someone acted on the symbol or a fire closed a drift, settles it.
    if (e.status === "dismissed" && e.snoozeDays !== null) {
      const wait = e.snoozeDays ?? settings.dismissDays;
      // Only a fresh dismissal can still learn where it was dismissed; an old
      // one is measured from the fire's own price instead (keptGoing).
      if (e.dismissedPrice === undefined && e.snoozeDays !== undefined) {
        e.dismissedPrice = price;
        changed.add(e);
      }
      if (e.resolvedAt === null || tradingDaysAfter(new Date(e.resolvedAt), now) < wait) continue;
      // Only while the alert is the one that was dismissed, still watches the
      // way this fired, and nothing newer has fired.
      if (live === null || live.level !== e.levelAtTrigger || firedSince(entries, e.alertId, e.triggeredAt)) continue;
      const fired = entryDirection(e);
      if (isFire(e) && (fired === null || !watchesDirection(live.direction, fired))) continue;
      const reopen = isFire(e) ? keptGoing(e, price) : stillDrifted(live, price, settings);
      if (reopen) {
        e.reminder = { at: nowIso, price, dismissedAt: e.resolvedAt, dismissedPrice: e.dismissedPrice ?? null };
        e.status = "open";
        e.resolvedAt = null;
        delete e.snoozeDays;
        delete e.dismissedPrice;
        changed.add(e);
        lines.push(`  ${e.symbol}: back in the queue after its dismissal (revisit ${e.id}).`);
      }
    }
  }

  // (c) Alerts gone quiet because price went the other way.
  for (const alert of alerts) {
    if (alert.status !== "live" || alert.kind !== "static" || ignored.has(alert.symbol.toUpperCase())) continue;
    const dir = watchedDirection(alert);
    const price = priceOf(alert.symbol);
    if (dir === null || price === undefined) continue;
    const pct = -pctPast(price, alert.level, dir);
    if (pct < settings.driftPct) continue;
    const quietSince = lastActivity(alert, entries);
    if (now.getTime() - new Date(quietSince).getTime() < settings.driftDays * 86_400_000) continue;
    // One drift per quiet stretch: an open or dismissed one raised since the
    // last activity already speaks for it. A fire or a change to the symbol
    // starts a new stretch, and so does the clock.
    const already = entries.some(
      (e) => !isFire(e) && e.alertId === alert.id && e.levelAtTrigger === alert.level && e.triggeredAt >= quietSince
    );
    if (already) continue;
    const entry: RevisitEntry = {
      ...newRevisitEntry(alert, price, nowIso, "regular", { direction: dir }),
      reason: "drift",
      drift: { pct: round(pct, 1), quietSince },
      condition: describeAlertCondition(alert),
    };
    created.push(entry);
    lines.push(`  ${alert.symbol}: ${round(pct, 1)}% the wrong side of ${alert.level}, quiet since ${quietSince.slice(0, 10)}; queued as drifted.`);
  }

  return { created, changed: [...changed], lines };
}

/** Past the level in the fire's direction, and further than where it was dismissed. */
function keptGoing(e: RevisitEntry, price: number): boolean {
  const dir = entryDirection(e);
  if (dir === null || e.levelAtTrigger === null) return false;
  const from = e.dismissedPrice ?? e.triggerPrice;
  return pctPast(price, e.levelAtTrigger, dir) > 0 && pctPast(price, from, dir) > 0;
}

function stillDrifted(alert: StaticAlert, price: number, settings: QueueSettings): boolean {
  const dir = watchedDirection(alert);
  return dir !== null && -pctPast(price, alert.level, dir) >= settings.driftPct;
}

/**
 * Dismisses an entry with a wait: `days` trading days, or the default. A
 * dismissal is never for good; dismissing again starts the wait over.
 * Mutates and returns the entry.
 */
export function dismissWithSnooze(e: RevisitEntry, days: number | undefined, settings: QueueSettings, now: Date = new Date()): RevisitEntry {
  e.status = "dismissed";
  e.resolvedAt = now.toISOString();
  e.snoozeDays = days ?? settings.dismissDays;
  delete e.dismissedPrice;
  return e;
}

/** What a dismissal's wait means, as a sentence for a CLI line or an op result. */
export function snoozeText(days: number | null | undefined): string {
  if (typeof days !== "number") return "";
  return `It comes back after ${days} trading day${days === 1 ? "" : "s"} if price keeps going past where it was dismissed.`;
}

// ---- ordering ----------------------------------------------------------------

/** Points per reason. Highest first; held adds to any of them. */
const POINTS = { accelerated: 30, fresh: 60, reminder: 50, drift: 30, stale: 10, held: 10 } as const;

export interface QueueRank {
  priority: number;
  /** Why it sits where it does, as one sentence of reasons. Recorded facts only, never a live price. */
  why: string;
  /** Which kind of row it is, for the page's tag. */
  reason: "accelerating" | "new" | "reminder" | "drift" | "waiting";
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

export function queueRank(e: RevisitEntry, held: boolean, now: Date, settings: QueueSettings = DEFAULT_QUEUE_SETTINGS): QueueRank {
  const reasons: string[] = [];
  let priority: number;
  let reason: QueueRank["reason"];
  if (!isFire(e)) {
    priority = POINTS.drift;
    reason = "drift";
    const quiet = e.drift ? `no fire since ${shortDate(e.drift.quietSince)}` : "no recent fire";
    reasons.push(`Drifted: ${quiet}, and ${e.drift?.pct ?? settings.driftPct}% the wrong side of its level when noticed`);
  } else if (e.reminder !== undefined) {
    priority = POINTS.reminder;
    reason = "reminder";
    reasons.push(`Dismissed ${shortDate(e.reminder.dismissedAt)} and kept going in the alert's direction`);
  } else if (tradingDaysAfter(new Date(e.triggeredAt), now) <= settings.accelerationDays) {
    priority = POINTS.fresh;
    reason = "new";
    reasons.push("New fire");
  } else {
    priority = POINTS.stale;
    reason = "waiting";
    reasons.push(`Fired ${shortDate(e.triggeredAt)}`);
  }
  if (isFire(e) && e.accelerated !== undefined) {
    priority += POINTS.accelerated;
    if (reason === "new" || reason === "waiting") reason = "accelerating";
    reasons.push(`ran ${e.accelerated.pct}% past the level within ${settings.accelerationDays} trading days`);
  }
  if (held) {
    priority += POINTS.held;
    reasons.push("held position");
  }
  return { priority, why: `${reasons.join("; ")}.`, reason };
}

/** Highest priority first, then newest. */
export function compareRanked(a: { rank: QueueRank; entry: RevisitEntry }, b: { rank: QueueRank; entry: RevisitEntry }): number {
  return b.rank.priority - a.rank.priority || b.entry.triggeredAt.localeCompare(a.entry.triggeredAt);
}
