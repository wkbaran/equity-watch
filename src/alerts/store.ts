/**
 * On-disk storage for user-defined static/trailing alerts.
 *
 * Unlike src/history.ts (one JSON file per ticker, since that grows
 * unboundedly), the set of active alerts is small and always accessed as a
 * whole ("list everything", "find the one on this symbol+side"), so it's a
 * single flat JSON file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeAlert, type Alert } from "./models.js";

export function loadAlerts(path: string): Alert[] {
  if (!existsSync(path)) {
    return [];
  }
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>[];
  return raw.map(normalizeAlert);
}

export function saveAlerts(path: string, alerts: Alert[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(alerts, null, 2));
}

export function removeAlert(path: string, id: string): boolean {
  const alerts = loadAlerts(path);
  const next = alerts.filter((a) => a.id !== id);
  if (next.length === alerts.length) {
    return false;
  }
  saveAlerts(path, next);
  return true;
}

/** Live alerts by default; `all` also includes cancelled ones. */
export function listAlerts(path: string, opts: { all?: boolean } = {}): Alert[] {
  const alerts = loadAlerts(path);
  return opts.all ? alerts : alerts.filter((a) => a.status === "live");
}
