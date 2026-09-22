/**
 * Holdings ops queued from the unlocked dashboard: lots, whole positions, and stops.
 *
 * Every message here ends up in the public dashboard.json (opResults). Being
 * held is fine to publish; size and value are not (CLAUDE.md). So messages
 * name the symbol and never a share count, basis, or price. The page shows
 * the details from its own record of what it sent.
 */

import { describeAlertCondition } from "../alerts/describe.js";
import { addAlert, type MarketData } from "../alerts/engine.js";
import { loadAlerts } from "../alerts/store.js";
import { coverCandidates, coverLevel } from "../holdings/cover.js";
import { addLot, addStop, editLot, removeLot, removePosition, replaceStop } from "../holdings/engine.js";
import { computeBasis, type Lot } from "../holdings/models.js";
import { loadHoldingsStore, removeStop } from "../holdings/store.js";
import type { Op, Outcome } from "./apply.js";
import { parseLotEdit, parseLotInput, parseStopEdit, parseStopInput, stringField } from "./validate.js";

const ok = (symbol: string, message: string): Outcome => ({ symbol, alertId: null, ok: true, message });
const reject = (symbol: string | null, message: string): Outcome => ({ symbol, alertId: null, ok: false, message });

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

/** The lot still looks the way the page showed it. */
function lotMatches(lot: Lot, expect: unknown): boolean {
  return (
    field(expect, "count") === lot.count &&
    field(expect, "basisPerShare") === lot.basisPerShare &&
    field(expect, "purchaseDate") === lot.purchaseDate &&
    (field(expect, "account") ?? null) === (lot.account ?? null)
  );
}

export function applyHoldingsOp(op: Op, holdingsFile: string): Outcome {
  switch (op.type) {
    case "lot.add": {
      const parsed = parseLotInput(op.params);
      if (!parsed.ok) {
        return reject(stringField(op.params, "symbol")?.trim().toUpperCase() || null, parsed.error);
      }
      const { stopPrice, stopCount, ...lotInput } = parsed.value;
      const lot = addLot(holdingsFile, lotInput);
      if (stopPrice !== undefined) {
        // Whatever stop(s) the symbol already had (e.g. from a prior lot on this
        // position) no longer describe where to get out now that the position's
        // size or basis has changed, so this one replaces them rather than adding
        // alongside.
        replaceStop(holdingsFile, { symbol: lot.symbol, stopPrice, count: stopCount ?? null });
        return ok(lot.symbol, `Added a lot of ${lot.symbol} and set its stop.`);
      }
      return ok(lot.symbol, `Added a lot of ${lot.symbol}.`);
    }

    case "lot.edit":
    case "lot.remove": {
      const lotId = stringField(op.target, "lotId");
      if (!lotId) {
        return reject(null, `A lot ${op.type === "lot.edit" ? "edit" : "removal"} needs target.lotId.`);
      }
      const lot = loadHoldingsStore(holdingsFile).lots.find((l) => l.id === lotId);
      if (lot === undefined) {
        return reject(null, "That lot no longer exists. It may have been removed.");
      }
      if (!lotMatches(lot, op.expect)) {
        return reject(lot.symbol, `Not changed: that ${lot.symbol} lot changed since the page loaded.`);
      }
      if (op.type === "lot.remove") {
        const removed = removeLot(holdingsFile, lotId)!;
        return ok(
          lot.symbol,
          `Removed a lot of ${lot.symbol}.${removed.closedPosition ? " It was the last one, so the position and its stops are gone." : ""}`
        );
      }
      const parsed = parseLotEdit(op.params);
      if (!parsed.ok) {
        return reject(lot.symbol, parsed.error);
      }
      editLot(holdingsFile, lotId, parsed.value);
      return ok(lot.symbol, `Edited a lot of ${lot.symbol}.`);
    }

    case "position.remove": {
      const symbol = stringField(op.target, "symbol")?.trim().toUpperCase();
      if (!symbol) {
        return reject(null, "A position removal needs target.symbol.");
      }
      const lotIds = loadHoldingsStore(holdingsFile)
        .lots.filter((l) => l.symbol === symbol)
        .map((l) => l.id)
        .sort();
      if (lotIds.length === 0) {
        return reject(symbol, `No ${symbol} position to remove.`);
      }
      // The page lists the lot ids it showed. A lot added or removed since
      // means this isn't the position that was on screen.
      const expected = field(op.expect, "lotIds");
      const same =
        Array.isArray(expected) && expected.every((id) => typeof id === "string") && [...expected].sort().join(",") === lotIds.join(",");
      if (!same) {
        return reject(symbol, `Not removed: the ${symbol} position changed since the page loaded.`);
      }
      removePosition(holdingsFile, symbol);
      return ok(symbol, `Removed the ${symbol} position and its stops.`);
    }

    case "stop.add": {
      const parsed = parseStopInput(op.params);
      if (!parsed.ok) {
        return reject(stringField(op.params, "symbol")?.trim().toUpperCase() || null, parsed.error);
      }
      const { symbol } = parsed.value;
      if (!loadHoldingsStore(holdingsFile).lots.some((l) => l.symbol === symbol)) {
        return reject(symbol, `Not added: there is no ${symbol} position to put a stop on.`);
      }
      addStop(holdingsFile, parsed.value);
      return ok(symbol, `Added a stop for ${symbol}.`);
    }

    case "stop.edit":
    case "stop.remove": {
      const verb = op.type === "stop.edit" ? "edit" : "removal";
      const stopId = stringField(op.target, "stopId");
      if (!stopId) {
        return reject(null, `A stop ${verb} needs target.stopId.`);
      }
      const stop = loadHoldingsStore(holdingsFile).stops.find((s) => s.id === stopId);
      if (stop === undefined) {
        return reject(null, "That stop no longer exists. It may have been removed.");
      }
      if (field(op.expect, "stopPrice") !== stop.stopPrice) {
        return reject(stop.symbol, `Not changed: that ${stop.symbol} stop changed since the page loaded.`);
      }
      if (op.type === "stop.remove") {
        removeStop(holdingsFile, stopId);
        return ok(stop.symbol, `Removed a stop for ${stop.symbol}.`);
      }
      const parsed = parseStopEdit(op.params);
      if (!parsed.ok) {
        return reject(stop.symbol, parsed.error);
      }
      // Remove-then-add rather than mutate in place, so the edit goes through
      // the same `addStop` validation a new stop does and lands with a fresh
      // id — a stop is a record of a decision, and this is a new decision.
      removeStop(holdingsFile, stopId);
      addStop(holdingsFile, {
        symbol: stop.symbol,
        stopPrice: parsed.value.stopPrice,
        count: parsed.value.count === undefined ? stop.count : parsed.value.count,
      });
      return ok(stop.symbol, `Moved the stop for ${stop.symbol}.`);
    }

    default:
      return reject(null, `${op.type} is not a holdings op.`);
  }
}

/**
 * `holdings.cover`: gives one held position with no live alert a starting
 * level, the atomic unit of the `holdings cover` batch pass.
 *
 * Lives here with the other holdings ops but writes to `alerts.json`, which is
 * why it takes both files. It reuses `coverCandidates` so "who qualifies" is
 * decided in exactly one place: re-checking that rule *is* the conflict guard,
 * and there is nothing an `expect` could assert that it doesn't already cover.
 *
 * Unlike every other message in this file, this one names a number. The level
 * it creates goes straight into the public alert book, so withholding it from
 * the result would hide nothing — and the caller needs to see what it got. The
 * basis and the share count are still never named. Note that on an *underwater*
 * position the level is basis + 10%, so the published alert implies the basis;
 * that is true of the scheduled `holdings cover` too and is documented in
 * docs/ARCHITECTURE.md.
 */
export async function applyCoverOp(
  op: Op,
  holdingsFile: string,
  alertsFile: string,
  market: MarketData,
  ignored: Set<string> = new Set()
): Promise<Outcome> {
  const symbol = stringField(op.target, "symbol")?.trim().toUpperCase();
  if (!symbol) {
    return reject(null, "A cover needs target.symbol.");
  }
  const store = loadHoldingsStore(holdingsFile);
  const alerts = loadAlerts(alertsFile);
  if (!store.lots.some((l) => l.symbol.toUpperCase() === symbol)) {
    return reject(symbol, `No ${symbol} position to cover.`);
  }
  if (ignored.has(symbol)) {
    return reject(symbol, `${symbol} is on the ignore list, so it is deliberately not alerted.`);
  }
  if (!coverCandidates(store, alerts, ignored).includes(symbol)) {
    const live = alerts.find((a) => a.status === "live" && a.symbol.toUpperCase() === symbol);
    return reject(symbol, `${symbol} already has a live alert (${live ? describeAlertCondition(live) : "unknown"}).`);
  }

  const info = computeBasis(store.lots, symbol);
  if (info === null) {
    return reject(symbol, `No basis on record for ${symbol}.`);
  }
  const quotes = await market.getQuotes([symbol]);
  const quote = quotes.get(symbol);
  if (quote === undefined) {
    return reject(symbol, `No quote available for ${symbol}.`);
  }
  const { level } = coverLevel(info.blendedBasis, quote.lastPrice);

  // The default "keep-closest", not "replace": nothing here is a level anyone
  // typed, and a candidate has no live alert to conflict with anyway.
  const result = await addAlert(alertsFile, { kind: "static", symbol, level }, market);
  if (result.rejectedReason !== null || result.added === null) {
    return reject(symbol, `Not covered: ${result.rejectedReason ?? "unknown reason"}`);
  }
  return {
    symbol,
    alertId: result.added.id,
    ok: true,
    message: `Covered ${symbol} with alert ${result.added.id}: ${describeAlertCondition(result.added)}.`,
  };
}
