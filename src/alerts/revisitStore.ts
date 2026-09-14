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
import type { RevisitEntry, RevisitStatus } from "./revisit.js";
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

export function appendRevisits(path: string, entries: RevisitEntry[]): void {
  if (entries.length === 0) {
    return;
  }
  saveRevisits(path, [...loadRevisits(path), ...entries]);
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

export function resolveRevisit(path: string, id: string, status: "applied" | "dismissed"): RevisitEntry | null {
  const entries = loadRevisits(path);
  const entry = entries.find((e) => e.id === id);
  if (entry === undefined) {
    return null;
  }
  entry.status = status;
  entry.resolvedAt = new Date().toISOString();
  saveRevisits(path, entries);
  return entry;
}
