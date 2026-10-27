/**
 * A stop sale puts the symbol in the revisit queue (the user's call,
 * 2026-10-27): its alerts were set while the position was held, and a
 * stop-out is the moment to look at them again. Nine stops filled one
 * morning and nothing on the page said so.
 *
 * The entry is raised against one live alert of the symbol, for the queue's
 * edit and dismiss buttons; acting on the symbol in any way closes it
 * (`closeRevisitsForSymbol`), like every other entry. A symbol with no live
 * alert gets none: there is nothing to update. It is not a fire, so the queue
 * rules leave it alone and a dismissal of it stands.
 */

import type { Alert } from "./models.js";
import { newRevisitEntry, type RevisitEntry } from "./revisit.js";
import { loadRevisits, saveRevisits } from "./revisitStore.js";
import type { Sale } from "../holdings/models.js";

/** The live alert a stop-out entry hangs off: a static one first, since that is what the queue's edit form handles best. */
function alertFor(alerts: Alert[], symbol: string): Alert | undefined {
  const live = alerts.filter((a) => a.status === "live" && a.symbol.toUpperCase() === symbol.toUpperCase());
  return live.find((a) => a.kind === "static") ?? live[0];
}

/**
 * New entries for the stop sales in `sales` not already queued, oldest first.
 * Pure: append the result to the store.
 */
export function stopOutEntries(entries: RevisitEntry[], alerts: Alert[], sales: Sale[]): RevisitEntry[] {
  const queued = new Set(entries.flatMap((e) => (e.stopped ? [e.stopped.saleId] : [])));
  const created: RevisitEntry[] = [];
  for (const sale of [...sales].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))) {
    if (sale.stopHit === undefined || queued.has(sale.id)) continue;
    const alert = alertFor(alerts, sale.symbol);
    if (alert === undefined) continue;
    const base = newRevisitEntry(alert, sale.price, sale.recordedAt, null);
    // A crossing's direction means nothing here, and would let the reversal
    // and follow-up code mistake this for a fire.
    delete base.direction;
    created.push({ ...base, reason: "stopped", stopped: { saleId: sale.id } });
    queued.add(sale.id);
  }
  return created;
}

/** Queues the stop sales in `sales` and saves. Returns what was added. */
export function queueStopOuts(revisitsFile: string, alerts: Alert[], sales: Sale[]): RevisitEntry[] {
  if (!sales.some((s) => s.stopHit !== undefined)) return [];
  const entries = loadRevisits(revisitsFile);
  const created = stopOutEntries(entries, alerts, sales);
  if (created.length > 0) {
    saveRevisits(revisitsFile, [...entries, ...created]);
  }
  return created;
}
