/**
 * Reversions: a level that fired and then got crossed back.
 *
 * A static alert watches one direction (`StaticAlert.direction`, default up).
 * When it fires, every crossing of the same level over the next
 * `holdDays` trading days is folded onto that fire as a follow-up
 * (`RevisitEntry.followUps`) instead of becoming its own queue entry. The
 * first follow-up against the fire's direction is the reversal - "crossed
 * above 50, fell back below it the same day" is the useful signal. Outside
 * the window, a crossing against the watched direction records nothing.
 *
 * The window is counted in trading days on the exchange's calendar
 * (America/New_York): the fire's own day is day 0. Weekends are skipped;
 * exchange holidays are not known here, so a holiday stretches the window by
 * a calendar day rather than shrinking it.
 */

import { DEFAULT_ANALYSIS_PARAMS } from "../analysis.js";
import { MARKET_TIME_ZONE, wallClock } from "../timezone.js";
import { resolveParams, type TuningConfig } from "../tuning.js";
import type { AlertDirection, CrossDirection } from "./models.js";
import type { RevisitEntry, RevisitFollowUp } from "./revisit.js";

/** Trading days after a fire during which crossings fold onto it. Same as the analyzer's hold period. */
export const DEFAULT_REVERSION_WINDOW_DAYS = DEFAULT_ANALYSIS_PARAMS.holdDays;

/**
 * A symbol's reversion window: its tuned `holdDays`. The window and the
 * analyzer's hold check ask the same question ("did the move stick for N
 * days?"), so a per-ticker override moves both together. Beta only scales
 * `recentHighTolerance`, so no beta is needed here.
 */
export function reversionWindowFor(symbol: string, config: TuningConfig | null): number {
  return config === null ? DEFAULT_REVERSION_WINDOW_DAYS : resolveParams(symbol, config, null).holdDays;
}

/** Days since the epoch for the exchange calendar date of `date`. */
function marketDayNumber(date: Date): number {
  const w = wallClock(date, MARKET_TIME_ZONE);
  return Math.floor(Date.UTC(w.year, w.month - 1, w.day) / 86_400_000);
}

function isWeekday(dayNumber: number): boolean {
  const weekday = new Date(dayNumber * 86_400_000).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

/**
 * Weekdays on the exchange calendar after `from`'s date, up to and including
 * `to`'s. 0 on the same date; a Friday fire is 1 on Monday.
 */
export function tradingDaysAfter(from: Date, to: Date): number {
  const start = marketDayNumber(from);
  const end = marketDayNumber(to);
  let count = 0;
  for (let day = start + 1; day <= end; day++) {
    if (isWeekday(day)) count++;
  }
  return count;
}

export function withinReversionWindow(firedAt: string, at: Date, windowDays: number = DEFAULT_REVERSION_WINDOW_DAYS): boolean {
  return tradingDaysAfter(new Date(firedAt), at) <= windowDays;
}

export function watchesDirection(direction: AlertDirection, cross: CrossDirection): boolean {
  return direction === "either" || direction === cross;
}

/**
 * Which way price crossed when this entry fired. Read off the recorded
 * direction, or for older entries off the trigger price against the level.
 * Null for kinds with no crossing (volume, moving-average touches).
 */
/** "above" for an upward crossing, "below" for a downward one. */
export function sideOf(dir: CrossDirection): string {
  return dir === "up" ? "above" : "below";
}

/** The side a crossing came *from*. */
export function otherSide(dir: CrossDirection): string {
  return dir === "up" ? "below" : "above";
}

export function entryDirection(entry: RevisitEntry): CrossDirection | null {
  if (entry.direction !== undefined) return entry.direction;
  if (entry.kind === "volume") return null;
  if (entry.ma !== undefined) {
    return entry.ma.event === "cross_up" ? "up" : entry.ma.event === "cross_down" ? "down" : null;
  }
  if (entry.kind === "trailing") {
    // levelAtTrigger is the trailing alert's starting `near`, not the price it
    // fired against, so trigger-vs-level says nothing. The recorded condition
    // names the side ("off the low" fires on a bounce up); without it, don't guess.
    const condition = entry.condition ?? "";
    return condition.includes("off the low") ? "up" : condition.includes("off the high") ? "down" : null;
  }
  if (entry.levelAtTrigger === null) return null;
  return entry.triggerPrice >= entry.levelAtTrigger ? "up" : "down";
}

/** The first follow-up that crossed back against the fire, or null if none has. */
export function reversalOf(entry: RevisitEntry): RevisitFollowUp | null {
  const dir = entryDirection(entry);
  if (dir === null) return null;
  return entry.followUps?.find((f) => f.direction !== dir) ?? null;
}

/**
 * Whether price's last recorded crossing left it on the side the fire moved
 * it to: true with no follow-ups, false if the latest follow-up went back.
 */
export function endedOnFiredSide(entry: RevisitEntry): boolean {
  const followUps = entry.followUps ?? [];
  if (followUps.length === 0) return true;
  return followUps[followUps.length - 1].direction === entryDirection(entry);
}

/**
 * The most recent fire of static alert `alertId` at `level` - the entry a new
 * crossing would fold onto. Entries the migration folded (`followUpOf`) are
 * crossings, not fires, so they never qualify.
 *
 * The level must match: after `alert revisit apply` moves the alert, a
 * crossing of the new level is not a reversal of a fire at the old one.
 */
export function latestFireOf(entries: RevisitEntry[], alertId: string, level: number): RevisitEntry | null {
  let latest: RevisitEntry | null = null;
  for (const e of entries) {
    if (e.alertId !== alertId || e.kind !== "static" || e.followUpOf !== undefined || e.levelAtTrigger !== level) {
      continue;
    }
    if (latest === null || new Date(e.triggeredAt).getTime() > new Date(latest.triggeredAt).getTime()) {
      latest = e;
    }
  }
  return latest;
}

function addFollowUp(anchor: RevisitEntry, followUp: RevisitFollowUp): boolean {
  const existing = anchor.followUps ?? [];
  if (existing.some((f) => f.at === followUp.at)) {
    return false;
  }
  anchor.followUps = [...existing, followUp].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return true;
}

export interface FoldResult {
  /** Entries that gained a recorded `direction`. */
  directionsRecorded: number;
  /** Entries newly marked `followUpOf` an earlier fire. */
  folded: number;
  /** Open counter-direction entries outside any window, now dismissed. */
  dismissed: number;
  /** Distinct fires that gained at least one follow-up. */
  anchorsWithFollowUps: number;
}

/**
 * Rewrites a revisit queue written before directions existed, when every
 * crossing fired, into the shape `checkAlerts` now produces. Mutates
 * `entries` in place and is idempotent: a second pass changes nothing.
 *
 * Per alert, static entries oldest first:
 *   - A crossing in the alert's watched direction, outside any open window,
 *     is a fire (the anchor).
 *   - Any crossing inside the anchor's window, at the anchor's level, folds
 *     onto it: appended to `anchor.followUps` and marked `followUpOf`.
 *   - A counter-direction crossing outside every window would record nothing
 *     today, so an open one is dismissed.
 *
 * Entries with status "applied" record a decision already acted on. They are
 * never folded, dismissed, or given a direction. One can still be the anchor
 * later crossings fold onto, which adds to its `followUps` and nothing else.
 * Entries already carrying `followUpOf` are left out entirely, which is what
 * makes a second pass a no-op.
 */
export function foldLegacyRevisits(
  entries: RevisitEntry[],
  directionOf: (alertId: string) => AlertDirection,
  windowFor: (symbol: string) => number,
  now: Date = new Date()
): FoldResult {
  const result: FoldResult = { directionsRecorded: 0, folded: 0, dismissed: 0, anchorsWithFollowUps: 0 };
  const byAlert = new Map<string, RevisitEntry[]>();
  for (const e of entries) {
    if (e.kind !== "static" || e.followUpOf !== undefined) {
      continue;
    }
    byAlert.set(e.alertId, [...(byAlert.get(e.alertId) ?? []), e]);
  }

  const grown = new Set<RevisitEntry>();
  for (const [alertId, group] of byAlert) {
    group.sort((a, b) => new Date(a.triggeredAt).getTime() - new Date(b.triggeredAt).getTime());
    const watched = directionOf(alertId);
    let anchor: RevisitEntry | null = null;

    for (const e of group) {
      const dir = entryDirection(e);
      if (dir === null) {
        continue;
      }
      const applied = e.status === "applied";
      if (!applied && e.direction === undefined) {
        e.direction = dir;
        result.directionsRecorded++;
      }

      const insideWindow =
        anchor !== null &&
        anchor.levelAtTrigger === e.levelAtTrigger &&
        withinReversionWindow(anchor.triggeredAt, new Date(e.triggeredAt), windowFor(e.symbol));

      if (insideWindow) {
        if (applied) {
          continue;
        }
        if (addFollowUp(anchor!, { at: e.triggeredAt, price: e.triggerPrice, direction: dir, session: e.session })) {
          grown.add(anchor!);
        }
        e.followUpOf = anchor!.id;
        result.folded++;
        continue;
      }

      if (watchesDirection(watched, dir)) {
        anchor = e;
        continue;
      }
      if (e.status === "open") {
        e.status = "dismissed";
        e.resolvedAt = now.toISOString();
        result.dismissed++;
      }
    }
  }
  result.anchorsWithFollowUps = grown.size;
  return result;
}
