/**
 * On-disk storage for the revisit queue. Same shape and reasoning as
 * src/alerts/store.ts - small, always read as a whole, so one flat JSON file
 * (`revisits.json`, gitignored alongside alerts.json/holdings.json).
 *
 * Kept in its own file rather than inside alerts.json because the two have
 * opposite lifetimes: the alert list is a bounded working set that gets
 * edited in place, while the queue is an append-only event log that
 * accumulates one entry per trigger forever.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DEFAULT_ALERT_DIRECTION } from "./models.js";
import { describeAlertCondition } from "./describe.js";
import type { Alert } from "./models.js";
import type { RevisitClosure, RevisitEntry, RevisitStatus } from "./revisit.js";
import { foldLegacyRevisits, type FoldResult } from "./reversion.js";
import { loadAlerts, saveAlerts } from "./store.js";

export function loadRevisits(path: string): RevisitEntry[] {
  if (!existsSync(path)) {
    return [];
  }
  return JSON.parse(readFileSync(path, "utf-8")) as RevisitEntry[];
}

export function saveRevisits(path: string, entries: RevisitEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(entries, null, 2));
}

export function listRevisits(path: string, opts: { status?: RevisitStatus | "all" } = {}): RevisitEntry[] {
  const status = opts.status ?? "open";
  const all = loadRevisits(path);
  return status === "all" ? all : all.filter((e) => e.status === status);
}

/** Highest priority first; unscored entries sort last. */
export function sortByPriority(entries: RevisitEntry[]): RevisitEntry[] {
  return [...entries].sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1));
}

export interface DirectionMigrationResult {
  /** Where the untouched copies went, one per store that existed. */
  backups: string[];
  staticAlerts: number;
  /** Static alerts whose stored direction was anything other than "up", including missing. */
  directionsChanged: number;
  fold: FoldResult;
}

/**
 * Copies `path` into `.cache/backups/` beside it before a migration rewrites
 * it. Under `.cache/` because that is gitignored: these are copies of real
 * alert and queue data, which must stay out of git just like the originals.
 */
function backupStore(path: string, stamp: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  const dir = join(dirname(path), ".cache", "backups");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${basename(path)}.${stamp}.bak`);
  copyFileSync(path, target);
  return target;
}

/**
 * `alert migrate-directions`: moves both stores onto directional alerts.
 *
 * Every static alert becomes "up", overwriting whatever it had - the user's
 * explicit instruction, since every existing alert was set up as an upside
 * level. The queue is then folded (foldLegacyRevisits) against those
 * directions. Both files are backed up first, and a second run changes
 * nothing but the backups.
 */
export function migrateDirectionStores(
  alertsPath: string,
  revisitsPath: string,
  windowFor: (symbol: string) => number,
  now: Date = new Date()
): DirectionMigrationResult {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const backups = [backupStore(alertsPath, stamp), backupStore(revisitsPath, stamp)].filter((p): p is string => p !== null);

  // Counted off the raw file: loadAlerts already defaults a missing direction
  // to "up", which would hide those from the count.
  const raw = existsSync(alertsPath) ? (JSON.parse(readFileSync(alertsPath, "utf-8")) as Record<string, unknown>[]) : [];
  const rawStatic = raw.filter((a) => a.kind === "static");
  const directionsChanged = rawStatic.filter((a) => a.direction !== "up").length;

  const alerts = loadAlerts(alertsPath);
  for (const alert of alerts) {
    if (alert.kind === "static") {
      alert.direction = "up";
    }
  }
  if (existsSync(alertsPath)) {
    saveAlerts(alertsPath, alerts);
  }

  const directions = new Map(alerts.flatMap((a) => (a.kind === "static" ? [[a.id, a.direction] as const] : [])));
  const entries = loadRevisits(revisitsPath);
  const fold = foldLegacyRevisits(entries, (id) => directions.get(id) ?? DEFAULT_ALERT_DIRECTION, windowFor, now);
  if (existsSync(revisitsPath)) {
    saveRevisits(revisitsPath, entries);
  }

  return { backups, staticAlerts: rawStatic.length, directionsChanged, fold };
}

/**
 * Closes one entry. `moved` records what an apply actually did to the level,
 * so the ticker story can say what you changed and not just that you changed
 * something; it is the same pair `alert revisit apply` writes.
 */
export function resolveRevisit(
  path: string,
  id: string,
  status: "applied" | "dismissed",
  moved?: { from: number | null; to: number | null }
): RevisitEntry | null {
  const entries = loadRevisits(path);
  const entry = entries.find((e) => e.id === id);
  if (entry === undefined) {
    return null;
  }
  entry.status = status;
  entry.resolvedAt = new Date().toISOString();
  if (moved !== undefined) {
    entry.appliedFrom = moved.from;
    entry.appliedTo = moved.to;
  }
  saveRevisits(path, entries);
  return entry;
}

/**
 * Moves an alert onto a queue entry's suggested level and closes the entry.
 *
 * The body of `alert revisit apply`, lifted out of the CLI so the dashboard's
 * queued `revisit.apply` op runs exactly this and not a second copy of it. The
 * CLI used to inline it with `process.exit(1)` on each refusal, which a worker
 * cannot use; every refusal is a returned reason now, and the CLI prints it.
 *
 * `level` overrides the entry's own suggestion - the page lets you edit the
 * number before taking it. Without one the suggestion must exist: an entry
 * that has never been re-levelled has nothing to apply.
 */
export interface ApplyRevisitResult {
  entry: RevisitEntry;
  alertId: string;
  from: number;
  to: number;
  /** The symbol's other open entries, closed along with this one (closeRevisitsForSymbol). */
  alsoClosed: string[];
}

export function applyRevisitLevel(
  alertsPath: string,
  revisitsPath: string,
  id: string,
  level?: number
): { ok: true; value: ApplyRevisitResult } | { ok: false; reason: string } {
  const entries = loadRevisits(revisitsPath);
  const entry = entries.find((e) => e.id === id);
  if (entry === undefined) {
    return { ok: false, reason: `No revisit entry with id ${id}.` };
  }
  if (entry.status !== "open") {
    return { ok: false, reason: `Revisit ${id} is already ${entry.status}.` };
  }
  // A follow-up is a later crossing of the same level, not a fire of its own.
  // Its anchor carries the level and the suggestion.
  if (entry.followUpOf !== undefined) {
    return {
      ok: false,
      reason: `Revisit ${id} (${entry.symbol}) is a later crossing of revisit ${entry.followUpOf}; apply that one instead.`,
    };
  }

  const target = level ?? entry.suggestedLevel;
  if (target === null) {
    return {
      ok: false,
      reason:
        `Revisit ${id} (${entry.symbol}) has no suggested level yet — run 'alert revisit relevel' first, ` +
        `or set the level yourself with 'alert add --symbol ${entry.symbol} --level <price>'.`,
    };
  }

  const alerts = loadAlerts(alertsPath);
  const alert = alerts.find((a) => a.id === entry.alertId);
  if (alert === undefined || alert.kind !== "static") {
    return {
      ok: false,
      reason:
        `Revisit ${id} points at ${alert === undefined ? "an alert that no longer exists" : `a ${alert.kind} alert`}; ` +
        `only static alerts carry a level that can be re-pointed.`,
    };
  }

  // Only the level moves. `direction` is left as it is: re-levelling says
  // where to watch, not which crossing matters.
  const previous = alert.level;
  alert.level = target;
  // Re-seed the crossing baseline against the new level so the alert doesn't
  // immediately fire (or immediately go quiet) purely because the level moved.
  alert.lastKnownSide = entry.triggerPrice > alert.level ? "above" : "below";
  // Bars from before the move must not be replayed against the new level.
  alert.lastEvaluatedAt = new Date().toISOString();
  alert.mutedUntil = null;
  saveAlerts(alertsPath, alerts);
  // Moving the alert is a decision about the symbol, so this entry closes with
  // the rest of its open fires, the alert's own ones recording the move so the
  // ticker story can say what you did, not just that you did something.
  const closed = closeRevisitsForSymbol(revisitsPath, entry.symbol, {
    change: "revisit.apply",
    alertId: alert.id,
    condition: describeAlertCondition(alert),
    moved: { from: previous, to: alert.level },
  });
  const alsoClosed = closed.filter((c) => c !== id);
  return { ok: true, value: { entry, alertId: alert.id, from: previous, to: alert.level, alsoClosed } };
}

/**
 * Closes every open entry for a symbol after someone acted on it: an alert on
 * it added, edited, removed or re-levelled, or a lot or stop on it added,
 * changed or removed, from the CLI or the page. Any of those is the decision
 * the symbol's open fires were waiting on, so the queue shouldn't keep asking
 * (the user's rule, 2026-09-18 for an alert's own entries, widened to the
 * whole symbol and to holdings on 2026-10-05).
 *
 * Marked "applied", never "dismissed": a dismissed entry's story says "you
 * left the level where it was", which a removed alert or a new lot makes
 * false. Every entry gets `closedBy`, which is what the story tells. Only the
 * moved alert's own entries get `appliedFrom`/`appliedTo`, which say what
 * happened to *that* fire's level. Returns the ids closed, oldest first.
 */
export function closeRevisitsForSymbol(path: string, symbol: string, cause: RevisitClosure, now: Date = new Date()): string[] {
  if (!existsSync(path)) {
    return [];
  }
  const target = symbol.toUpperCase();
  const entries = loadRevisits(path);
  const closed: string[] = [];
  for (const entry of entries) {
    if (entry.symbol.toUpperCase() !== target || entry.status !== "open") continue;
    const moved = cause.moved !== undefined && entry.alertId === cause.alertId ? cause.moved : null;
    entry.status = "applied";
    entry.resolvedAt = now.toISOString();
    entry.appliedFrom = moved?.from ?? null;
    entry.appliedTo = moved?.to ?? null;
    entry.closedBy = cause;
    closed.push(entry.id);
  }
  if (closed.length > 0) {
    saveRevisits(path, entries);
  }
  return closed;
}

/** `closeRevisitsForSymbol`'s cause for an alert edit: the move, when it moved a static level. */
export function editClosure(before: Alert, after: Alert): RevisitClosure {
  const from = before.kind === "static" ? before.level : null;
  const to = after.kind === "static" ? after.level : null;
  const moved = from !== null && to !== null && from !== to ? { from, to } : undefined;
  return { change: "alert.edit", alertId: after.id, condition: describeAlertCondition(after), ...(moved ? { moved } : {}) };
}
