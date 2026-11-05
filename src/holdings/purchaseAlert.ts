/**
 * A new lot moves the symbol's price alert to 10% above what the lot cost
 * (the user's rule, 2026-11-04).
 *
 * - A live static alert on the symbol is edited in place, keeping its id and
 *   history: level to price × 1.1, watching upward, and any volume condition
 *   dropped.
 * - With no static alert (none at all, or only trailing, volume or
 *   moving-average ones), a new static alert is added at that level and the
 *   others are left alone.
 *
 * Every way a lot arrives records a `PendingPurchase` rather than touching
 * alerts.json there and then: the dashboard's `lot.add` op, `holdings add-lot`,
 * and a buy the Webull sync books. `holdings cover` applies them, ahead of its
 * own sweep, and it runs after `ops pull` and `holdings sync` in every check.
 *
 * Why not inline in the op: moving a level needs a live quote, and the op has
 * already written the lot by then. A quote that throws (or `schwabAuth`'s
 * process.exit with no credentials) would stop the drain before the result is
 * logged, and the retry would add the lot a second time. `holdings sync` runs
 * even with the Schwab login expired, too, and once a buy is booked the sync
 * never sees it again. Recording it means a purchase waits out an expired login
 * instead of being lost.
 *
 * The published alert book shows the level, so on a fresh buy the level implies
 * the purchase price (÷ 1.1). Same disclosure as `holdings cover` on an
 * underwater position, but now on every buy (docs/ARCHITECTURE.md).
 */

import { describeAlertCondition } from "../alerts/describe.js";
import { addAlert, editAlert, type MarketData } from "../alerts/engine.js";
import type { Alert, StaticAlert } from "../alerts/models.js";
import type { RevisitClosure } from "../alerts/revisit.js";
import { editClosure } from "../alerts/revisitStore.js";
import { loadAlerts } from "../alerts/store.js";
import { errorText } from "../errorText.js";
import { round } from "../round.js";
import type { HoldingsStore, PendingPurchase } from "./models.js";
import { loadHoldingsStore, saveHoldingsStore } from "./store.js";

/** Fraction above the lot's price for the alert a purchase sets. */
export const PURCHASE_ABOVE_PRICE = 0.1;

/** Rounded before anything compares it with a live price (CLAUDE.md, `holdings cover`). */
export function purchaseLevel(price: number): number {
  return round(price * (1 + PURCHASE_ABOVE_PRICE));
}

function newer(a: PendingPurchase, b: PendingPurchase): boolean {
  return a.purchaseDate !== b.purchaseDate ? a.purchaseDate > b.purchaseDate : a.recordedAt >= b.recordedAt;
}

/**
 * Records a purchase for `holdings cover` to apply. One per symbol: a later
 * purchase replaces an earlier one still waiting, since only the newest lot's
 * price decides the level. An older one (a backdated lot entered after a newer
 * one) changes nothing.
 */
export function recordPurchase(store: HoldingsStore, purchase: PendingPurchase): void {
  const symbol = purchase.symbol.toUpperCase();
  const pending = store.pendingPurchases ?? [];
  const current = pending.find((p) => p.symbol.toUpperCase() === symbol);
  if (current !== undefined && !newer(purchase, current)) {
    return;
  }
  store.pendingPurchases = [...pending.filter((p) => p.symbol.toUpperCase() !== symbol), { ...purchase, symbol }];
}

/**
 * The static alert a purchase moves, or null to add one. One watching up (or
 * either way) is preferred, since the new level is a target overhead; among
 * several, the one nearest the new level. A down-watching alert is moved only
 * when it is the symbol's only static alert. The others stay as they are.
 */
export function purchaseTarget(alerts: Alert[], symbol: string, level: number): StaticAlert | null {
  const statics = alerts.filter(
    (a): a is StaticAlert => a.kind === "static" && a.status === "live" && a.symbol.toUpperCase() === symbol.toUpperCase()
  );
  if (statics.length === 0) {
    return null;
  }
  const upward = statics.filter((a) => a.direction !== "down");
  const pool = upward.length > 0 ? upward : statics;
  return pool.reduce((best, a) => (Math.abs(a.level - level) < Math.abs(best.level - level) ? a : best));
}

export type PurchaseAlertResult =
  | { action: "moved"; level: number; before: StaticAlert; alert: Alert; replaced: Alert | null }
  | { action: "created"; level: number; alert: Alert; replaced: Alert | null }
  | { action: "rejected"; level: number; reason: string };

/**
 * Moves or adds the symbol's price alert for a purchase at `price`. A refusal
 * from the engine (the level is the live price, a nearer alert holds that side)
 * is returned, not thrown; a failed quote fetch throws, so the caller can keep
 * the purchase for the next run.
 *
 * Under the default "keep-closest" conflict policy, like every automatic
 * change: nothing here is a level anyone typed.
 */
export async function applyPurchaseAlert(
  alertsFile: string,
  symbol: string,
  price: number,
  market: MarketData
): Promise<PurchaseAlertResult> {
  const level = purchaseLevel(price);
  const target = purchaseTarget(loadAlerts(alertsFile), symbol, level);
  if (target !== null) {
    const result = await editAlert(
      alertsFile,
      target.id,
      { level, direction: "up", ...(target.volumeCondition !== undefined ? { volume: null } : {}) },
      market
    );
    if (result.rejectedReason !== null || result.edited === null) {
      return { action: "rejected", level, reason: result.rejectedReason ?? "unknown reason" };
    }
    return { action: "moved", level, before: result.before as StaticAlert, alert: result.edited, replaced: result.replaced };
  }
  const result = await addAlert(alertsFile, { kind: "static", symbol, level, direction: "up" }, market);
  if (result.rejectedReason !== null || result.added === null) {
    return { action: "rejected", level, reason: result.rejectedReason ?? "unknown reason" };
  }
  return { action: "created", level, alert: result.added, replaced: result.replaced };
}

/**
 * What closes the symbol's open revisit entries when a purchase moves or adds
 * its alert: the same closure an edit or add from the page would stamp
 * (closeRevisitsForSymbol), so the story tells the move. A rejection changed
 * nothing and closes nothing.
 */
export function purchaseClosure(result: PurchaseAlertResult): RevisitClosure | null {
  switch (result.action) {
    case "moved":
      return editClosure(result.before, result.alert);
    case "created":
      return { change: "alert.add", alertId: result.alert.id, condition: describeAlertCondition(result.alert) };
    case "rejected":
      return null;
  }
}

/** One line for the run log. Terminal only: it names the level. */
export function describePurchaseAlert(symbol: string, result: PurchaseAlertResult): string {
  switch (result.action) {
    case "moved": {
      const dropped = result.before.volumeCondition !== undefined ? ", volume condition dropped" : "";
      return `${symbol}: moved alert ${result.alert.id} from ${describeAlertCondition(result.before)} to ${describeAlertCondition(result.alert)}${dropped}.`;
    }
    case "created":
      return `${symbol}: added alert ${result.alert.id}: ${describeAlertCondition(result.alert)}.`;
    case "rejected":
      return `${symbol}: alert not set to ${result.level}: ${result.reason}`;
  }
}

export type PendingOutcome =
  | { symbol: string; status: "applied"; result: PurchaseAlertResult }
  /** Dropped without touching alerts: ignored, or no longer held. */
  | { symbol: string; status: "dropped"; reason: string }
  /** Left waiting for the next run: no quote, or the fetch failed. */
  | { symbol: string; status: "kept"; reason: string };

/**
 * Applies every recorded purchase, oldest first, and clears each one that is
 * settled. A rejection settles it (retrying a level that equals the price, or
 * one a nearer alert holds, would fail the same way every run); a missing quote
 * or a failed fetch leaves it for the next run.
 */
export async function applyPendingPurchases(
  holdingsFile: string,
  alertsFile: string,
  market: MarketData,
  ignored: Set<string>
): Promise<PendingOutcome[]> {
  const store = loadHoldingsStore(holdingsFile);
  const pending = [...(store.pendingPurchases ?? [])].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  if (pending.length === 0) {
    return [];
  }
  const outcomes: PendingOutcome[] = [];
  const held = new Set(store.lots.map((l) => l.symbol.toUpperCase()));
  const live = pending.filter((p) => !ignored.has(p.symbol) && held.has(p.symbol));
  let quotes: Map<string, unknown> = new Map();
  let fetchError: string | null = null;
  if (live.length > 0) {
    try {
      quotes = await market.getQuotes(live.map((p) => p.symbol));
    } catch (err) {
      fetchError = errorText(err);
    }
  }
  for (const p of pending) {
    if (ignored.has(p.symbol)) {
      outcomes.push({ symbol: p.symbol, status: "dropped", reason: "on the ignore list" });
      continue;
    }
    if (!held.has(p.symbol)) {
      outcomes.push({ symbol: p.symbol, status: "dropped", reason: "no longer held" });
      continue;
    }
    if (fetchError !== null) {
      outcomes.push({ symbol: p.symbol, status: "kept", reason: `quotes failed: ${fetchError}` });
      continue;
    }
    if (!quotes.has(p.symbol)) {
      outcomes.push({ symbol: p.symbol, status: "kept", reason: "no quote available" });
      continue;
    }
    try {
      const result = await applyPurchaseAlert(alertsFile, p.symbol, p.price, market);
      outcomes.push({ symbol: p.symbol, status: "applied", result });
    } catch (err) {
      outcomes.push({ symbol: p.symbol, status: "kept", reason: errorText(err) });
    }
  }
  // Reloaded so nothing else in the store is written back stale; only the queue changes here.
  const fresh = loadHoldingsStore(holdingsFile);
  const settled = new Set(outcomes.filter((o) => o.status !== "kept").map((o) => o.symbol));
  const remaining = (fresh.pendingPurchases ?? []).filter((p) => !settled.has(p.symbol.toUpperCase()));
  if (remaining.length === 0) {
    delete fresh.pendingPurchases;
  } else {
    fresh.pendingPurchases = remaining;
  }
  saveHoldingsStore(holdingsFile, fresh);
  return outcomes;
}

/** One line per outcome for the run log. */
export function describePendingOutcome(o: PendingOutcome): string {
  switch (o.status) {
    case "applied":
      return describePurchaseAlert(o.symbol, o.result);
    case "dropped":
      return `${o.symbol}: purchase alert skipped, ${o.reason}.`;
    case "kept":
      return `${o.symbol}: purchase alert waits for the next run (${o.reason}).`;
  }
}
