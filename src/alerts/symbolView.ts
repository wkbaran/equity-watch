/**
 * Everything watched on one ticker, for `equity-watch TSLA`.
 *
 * Reads the stores and nothing else: no quote, so it answers instantly and
 * works without a Schwab login. Moving levels (a trailing trigger, an average)
 * are therefore as of the last check, and say so.
 */

import { localDateString, localDateTimeString } from "../timezone.js";
import { describeAlertCondition } from "./describe.js";
import { round } from "../round.js";
import { effectiveTrigger, type Alert } from "./models.js";
import type { RevisitEntry } from "./revisit.js";

/** "nasdaq:tsla" -> "TSLA". The stores keep bare symbols. */
export function normalizeSymbolQuery(raw: string): string {
  return raw.trim().split(":").pop()!.toUpperCase();
}

export function liveAlertsFor(query: string, alerts: Alert[]): Alert[] {
  const symbol = normalizeSymbolQuery(query);
  return alerts.filter((a) => a.status === "live" && a.symbol.toUpperCase() === symbol);
}



function movingLevel(a: Alert): string {
  if (a.kind === "trailing") {
    return ` (trigger ${round(effectiveTrigger(a))} at last check)`;
  }
  if (a.kind === "ma") {
    return a.lastLevel === null ? " (not evaluated yet)" : ` (average ${round(a.lastLevel)} at last check)`;
  }
  return "";
}

function history(a: Alert, now: Date): string {
  const parts: string[] = [];
  if (a.triggerCount === 0) {
    parts.push("never fired");
  } else {
    const last =
      a.lastTriggeredAt === null
        ? ""
        : `, last ${localDateTimeString(new Date(a.lastTriggeredAt))}` +
          (a.lastTriggerPrice === null ? "" : ` at ${a.lastTriggerPrice}`);
    parts.push(`fired ${a.triggerCount} time${a.triggerCount === 1 ? "" : "s"}${last}`);
  }
  if (a.mutedUntil !== null && new Date(a.mutedUntil) > now) {
    parts.push(`muted until ${localDateTimeString(new Date(a.mutedUntil))}`);
  }
  const start = a.priceAtWatchStart === null ? "" : ` at ${a.priceAtWatchStart}`;
  parts.push(`watching since ${localDateString(new Date(a.watchingSince))}${a.watchingSinceApprox ? " (approx.)" : ""}${start}`);
  return parts.join(" · ");
}

export function renderSymbolAlerts(query: string, alerts: Alert[], revisits: RevisitEntry[], now: Date = new Date()): string {
  const symbol = normalizeSymbolQuery(query);
  const live = liveAlertsFor(symbol, alerts);
  const cancelled = alerts.filter((a) => a.status === "cancelled" && a.symbol.toUpperCase() === symbol).length;
  const open = revisits.filter((e) => e.status === "open" && e.followUpOf === undefined && e.symbol.toUpperCase() === symbol).length;

  const lines: string[] = [];
  if (live.length === 0) {
    lines.push(`${symbol}: none${cancelled > 0 ? ` (${cancelled} cancelled)` : ""}`);
  } else {
    lines.push(`${symbol}: ${live.length} live alert${live.length === 1 ? "" : "s"}`);
    for (const a of live) {
      lines.push(`  ${a.id}  ${a.kind.padEnd(8)} ${describeAlertCondition(a)}${movingLevel(a)}`);
      lines.push(`  ${" ".repeat(a.id.length)}  ${" ".repeat(8)} ${history(a, now)}`);
    }
  }
  if (open > 0) {
    lines.push(`${open} open revisit${open === 1 ? "" : "s"} on ${symbol}: 'alert revisit list' to review.`);
  }
  return lines.join("\n");
}
