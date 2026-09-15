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
import { liveAlertsFor, normalizeSymbolQuery } from "./symbolView.js";

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

export type FoundAlert = { alert: Alert; error: null } | { alert: null; error: string };

/**
 * An alert named by id, or by ticker when that ticker has exactly one live
 * alert. An id match always wins, so a ticker can never shadow an id.
 */
export function findAlert(alerts: Alert[], ref: string): FoundAlert {
  const byId = alerts.find((a) => a.id === ref);
  if (byId !== undefined) {
    return { alert: byId, error: null };
  }
  const symbol = normalizeSymbolQuery(ref);
  const live = liveAlertsFor(symbol, alerts);
  if (live.length === 1) {
    return { alert: live[0], error: null };
  }
  if (live.length === 0) {
    return { alert: null, error: `No alert with id ${ref}, and no live alert on ${symbol}.` };
  }
  return {
    alert: null,
    error: `${symbol} has ${live.length} live alerts (${live.map((a) => a.id).join(", ")}); give the id.`,
  };
}

/** Removes the alert `ref` names (see findAlert). */
export function removeAlert(path: string, ref: string): FoundAlert {
  const alerts = loadAlerts(path);
  const found = findAlert(alerts, ref);
  if (found.alert !== null) {
    saveAlerts(
      path,
      alerts.filter((a) => a !== found.alert)
    );
  }
  return found;
}

/** Live alerts by default; `all` also includes cancelled ones. */
export function listAlerts(path: string, opts: { all?: boolean } = {}): Alert[] {
  const alerts = loadAlerts(path);
  return opts.all ? alerts : alerts.filter((a) => a.status === "live");
}
