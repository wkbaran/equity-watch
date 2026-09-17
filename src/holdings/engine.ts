import { randomUUID } from "node:crypto";
import type { MarketData } from "../alerts/engine.js";
import { computeBasis, type HoldingAlertState, type HoldingsStore, type Lot, type Stop } from "./models.js";
import { loadHoldingsStore, saveHoldingsStore } from "./store.js";
import type { HoldingsNotifier } from "./notify.js";
import { localDateString } from "../timezone.js";

const ABOVE_BASIS_THRESHOLD_PCT = 10;
const STAGNANT_MIN_DAYS = 30;
const STAGNANT_MAX_PROFIT_PCT = 2;
const APPRECIATION_BAND_PCT = 3;

export interface HoldingsTriggerEvent {
  type: "above_basis" | "stagnant" | "raise_stop";
  symbol: string;
  price: number;
  pctAboveBasis: number;
  daysSincePurchase?: number;
  band?: number;
  stops: Stop[];
}

function stopsForSymbol(store: HoldingsStore, symbol: string): Stop[] {
  return store.stops.filter((s) => s.symbol === symbol);
}

export async function checkHoldings(
  store: HoldingsStore,
  market: Pick<MarketData, "getQuotes">,
  notifiers: HoldingsNotifier[],
  now: Date = new Date(),
  /** Symbols to leave alone entirely - see TuningConfig.ignoreSymbols. */
  ignored: Set<string> = new Set()
): Promise<{ checked: number; triggered: HoldingsTriggerEvent[]; ignored: number }> {
  const allSymbols = [...new Set(store.lots.map((l) => l.symbol))];
  const symbols = allSymbols.filter((s) => !ignored.has(s.toUpperCase()));
  const quotes = await market.getQuotes(symbols);
  const triggered: HoldingsTriggerEvent[] = [];

  for (const symbol of symbols) {
    const quote = quotes.get(symbol);
    const info = computeBasis(store.lots, symbol);
    if (quote === undefined || info === null) {
      continue;
    }
    const price = quote.lastPrice;
    const pctAboveBasis = ((price - info.blendedBasis) / info.blendedBasis) * 100;
    const daysSincePurchase = (now.getTime() - new Date(info.lastPurchaseDate).getTime()) / 86_400_000;

    const isAboveThreshold = pctAboveBasis >= ABOVE_BASIS_THRESHOLD_PCT;
    const isStagnant = daysSincePurchase >= STAGNANT_MIN_DAYS && pctAboveBasis < STAGNANT_MAX_PROFIT_PCT;
    const appreciationBand = pctAboveBasis > 0 ? Math.floor(pctAboveBasis / APPRECIATION_BAND_PCT) : 0;

    let state = store.alertState.find((s) => s.symbol === symbol);
    if (!state) {
      state = { symbol, initialized: false, aboveBasisArmed: false, stagnantArmed: false, lastNotifiedAppreciationBand: 0 };
      store.alertState.push(state);
    }

    if (!state.initialized) {
      state.aboveBasisArmed = isAboveThreshold;
      state.stagnantArmed = isStagnant;
      state.lastNotifiedAppreciationBand = appreciationBand;
      state.initialized = true;
      continue;
    }

    const stops = stopsForSymbol(store, symbol);

    if (isAboveThreshold && !state.aboveBasisArmed) {
      triggered.push({ type: "above_basis", symbol, price, pctAboveBasis, stops });
    }
    state.aboveBasisArmed = isAboveThreshold;

    if (isStagnant && !state.stagnantArmed) {
      triggered.push({ type: "stagnant", symbol, price, pctAboveBasis, daysSincePurchase, stops });
    }
    state.stagnantArmed = isStagnant;

    if (appreciationBand > state.lastNotifiedAppreciationBand) {
      triggered.push({ type: "raise_stop", symbol, price, pctAboveBasis, band: appreciationBand, stops });
      state.lastNotifiedAppreciationBand = appreciationBand;
    }
  }

  for (const event of triggered) {
    for (const notifier of notifiers) {
      await notifier.notify(event);
    }
  }

  return { checked: symbols.length, triggered, ignored: allSymbols.length - symbols.length };
}

export function addLot(
  path: string,
  input: { symbol: string; count: number; basisPerShare: number; purchaseDate?: string; account?: string }
): Lot {
  const store = loadHoldingsStore(path);
  const lot: Lot = {
    id: randomUUID().slice(0, 8),
    symbol: input.symbol,
    count: input.count,
    basisPerShare: input.basisPerShare,
    // Local calendar date, the "today" a person means when omitting it.
    purchaseDate: input.purchaseDate ?? localDateString(),
    createdAt: new Date().toISOString(),
    ...(input.account !== undefined ? { account: input.account } : {}),
  };
  store.lots.push(lot);
  saveHoldingsStore(path, store);
  return lot;
}

export interface LotEdit {
  count?: number;
  basisPerShare?: number;
  purchaseDate?: string;
  /** null removes the account label. */
  account?: string | null;
}

/** Changes a lot in place. Null when no lot has that id. */
export function editLot(path: string, id: string, edit: LotEdit): Lot | null {
  const store = loadHoldingsStore(path);
  const lot = store.lots.find((l) => l.id === id);
  if (lot === undefined) {
    return null;
  }
  if (edit.count !== undefined) lot.count = edit.count;
  if (edit.basisPerShare !== undefined) lot.basisPerShare = edit.basisPerShare;
  if (edit.purchaseDate !== undefined) lot.purchaseDate = edit.purchaseDate;
  if (edit.account === null) delete lot.account;
  else if (edit.account !== undefined) lot.account = edit.account;
  saveHoldingsStore(path, store);
  return lot;
}

/**
 * Drops a symbol's stops and alert state along with its last lot. A stop on
 * nothing held is meaningless, and a later re-purchase should seed a fresh
 * alert baseline (checkHoldings seeds without firing) rather than inherit the
 * old position's armed/notified state.
 */
function closePosition(store: HoldingsStore, symbol: string): Stop[] {
  const stops = store.stops.filter((s) => s.symbol === symbol);
  store.stops = store.stops.filter((s) => s.symbol !== symbol);
  store.alertState = store.alertState.filter((s) => s.symbol !== symbol);
  return stops;
}

/** Removes one lot. `closedPosition` when it was the symbol's last, which also removes its stops. */
export function removeLot(path: string, id: string): { lot: Lot; closedPosition: boolean } | null {
  const store = loadHoldingsStore(path);
  const lot = store.lots.find((l) => l.id === id);
  if (lot === undefined) {
    return null;
  }
  store.lots = store.lots.filter((l) => l.id !== id);
  const closedPosition = !store.lots.some((l) => l.symbol === lot.symbol);
  if (closedPosition) {
    closePosition(store, lot.symbol);
  }
  saveHoldingsStore(path, store);
  return { lot, closedPosition };
}

/** Removes every lot of a symbol, and its stops and alert state. */
export function removePosition(path: string, symbol: string): { lots: Lot[]; stops: Stop[] } {
  const store = loadHoldingsStore(path);
  const lots = store.lots.filter((l) => l.symbol === symbol);
  store.lots = store.lots.filter((l) => l.symbol !== symbol);
  const stops = lots.length > 0 ? closePosition(store, symbol) : [];
  saveHoldingsStore(path, store);
  return { lots, stops };
}

export function addStop(path: string, input: { symbol: string; stopPrice: number; count?: number | null }): Stop {
  const store = loadHoldingsStore(path);
  const stop: Stop = {
    id: randomUUID().slice(0, 8),
    symbol: input.symbol,
    count: input.count ?? null,
    stopPrice: input.stopPrice,
    createdAt: new Date().toISOString(),
  };
  store.stops.push(stop);
  saveHoldingsStore(path, store);
  return stop;
}

/** Drops every existing stop on the symbol and adds one new one, in a single save. */
export function replaceStop(path: string, input: { symbol: string; stopPrice: number; count?: number | null }): Stop {
  const store = loadHoldingsStore(path);
  store.stops = store.stops.filter((s) => s.symbol !== input.symbol);
  const stop: Stop = {
    id: randomUUID().slice(0, 8),
    symbol: input.symbol,
    count: input.count ?? null,
    stopPrice: input.stopPrice,
    createdAt: new Date().toISOString(),
  };
  store.stops.push(stop);
  saveHoldingsStore(path, store);
  return stop;
}
