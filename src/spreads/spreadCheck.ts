/**
 * Checks spread stops against live prices, with the static alert's own engine.
 *
 * Each live stop is lent to `checkAlerts` as a throwaway static alert, so a
 * spread stop is judged exactly as a static level is: minute-bar closes since
 * the last check, the regular-session quote rule, extended-hours bars only.
 * Only the watermark and the side it ends on are copied back. The engine's
 * revisit entries are discarded: spread fires are recorded on the stop, and
 * never enter the revisit queue.
 */

import { checkAlerts, type MarketData } from "../alerts/engine.js";
import type { StaticAlert } from "../alerts/models.js";
import type { Session } from "../marketHours.js";
import { fireAtLevel, newFire, type SpreadFire, type SpreadStop, type SpreadStopsStore } from "./spreadStops.js";

function asStatic(s: SpreadStop): StaticAlert {
  return {
    id: s.key,
    symbol: s.symbol,
    status: "live",
    createdAt: s.createdAt,
    livePriceAtCreation: s.level,
    watchingSince: s.createdAt,
    watchingSinceApprox: false,
    priceAtWatchStart: null,
    triggerCount: 0,
    lastTriggeredAt: null,
    lastTriggerPrice: null,
    mutedUntil: null,
    triggerSnapshot: null,
    kind: "static",
    side: s.lastKnownSide,
    direction: s.direction,
    level: s.level,
    lastKnownSide: s.lastKnownSide,
    ...(s.lastEvaluatedAt !== undefined ? { lastEvaluatedAt: s.lastEvaluatedAt } : {}),
  };
}

export interface SpreadCheckResult {
  checked: number;
  fired: { stop: SpreadStop; fire: SpreadFire }[];
  warnings: string[];
}

/**
 * Judges every live stop, updating the store in place. A stop fires at most
 * once per level: a level that already fired only moves its watermark.
 */
export async function checkSpreadStops(
  store: SpreadStopsStore,
  market: MarketData,
  session: Session | null,
  now: Date = new Date()
): Promise<SpreadCheckResult> {
  const live = store.stops.filter((s) => s.status === "live");
  if (live.length === 0) return { checked: 0, fired: [], warnings: [] };
  const shells = live.map(asStatic);
  // No ignored symbols (a spread is a position, not a watchlist name) and no
  // existing revisits, so nothing folds onto the main book's fires.
  const result = await checkAlerts(shells, market, [], session, new Set(), async () => null, async () => [], { now, existingRevisits: [] });
  const fired: SpreadCheckResult["fired"] = [];
  live.forEach((stop, i) => {
    const shell = shells[i];
    stop.lastKnownSide = shell.lastKnownSide;
    if (shell.lastEvaluatedAt !== undefined) stop.lastEvaluatedAt = shell.lastEvaluatedAt;
    if (fireAtLevel(stop) !== null) return;
    // The first fire of this check; later crossings in the same check are the same event.
    const entry = result.revisits.find((r) => r.alertId === stop.key);
    if (entry === undefined) return;
    const fire = newFire(entry.triggerPrice, stop.level, entry.triggeredAt, entry.session);
    stop.fires.push(fire);
    fired.push({ stop, fire });
  });
  return { checked: live.length, fired, warnings: result.warnings };
}
