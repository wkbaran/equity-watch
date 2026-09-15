/**
 * Holdings ops queued from the unlocked dashboard: lots, whole positions, and stops.
 *
 * Every message here ends up in the public dashboard.json (opResults). Being
 * held is fine to publish; size and value are not (CLAUDE.md). So messages
 * name the symbol and never a share count, basis, or price. The page shows
 * the details from its own record of what it sent.
 */

import { addLot, addStop, editLot, removeLot, removePosition } from "../holdings/engine.js";
import type { Lot } from "../holdings/models.js";
import { loadHoldingsStore, removeStop } from "../holdings/store.js";
import type { Op, Outcome } from "./apply.js";
import { parseLotEdit, parseLotInput, parseStopInput, stringField } from "./validate.js";

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
      const lot = addLot(holdingsFile, parsed.value);
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

    case "stop.remove": {
      const stopId = stringField(op.target, "stopId");
      if (!stopId) {
        return reject(null, "A stop removal needs target.stopId.");
      }
      const stop = loadHoldingsStore(holdingsFile).stops.find((s) => s.id === stopId);
      if (stop === undefined) {
        return reject(null, "That stop no longer exists. It may have been removed.");
      }
      if (field(op.expect, "stopPrice") !== stop.stopPrice) {
        return reject(stop.symbol, `Not removed: that ${stop.symbol} stop changed since the page loaded.`);
      }
      removeStop(holdingsFile, stopId);
      return ok(stop.symbol, `Removed a stop for ${stop.symbol}.`);
    }

    default:
      return reject(null, `${op.type} is not a holdings op.`);
  }
}
