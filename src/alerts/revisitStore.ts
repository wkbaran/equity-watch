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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RevisitEntry, RevisitStatus } from "./revisit.js";

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
