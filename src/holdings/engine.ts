import { randomUUID } from "node:crypto";
import type { MarketData } from "../alerts/engine.js";
import { computeBasis, saleStoryTime, type HoldingsStore, type Lot, type Sale, type SaleLot, type Stop } from "./models.js";
import { loadHoldingsStore, saveHoldingsStore } from "./store.js";
import type { HoldingsNotifier } from "./notify.js";
import { localDateString } from "../timezone.js";

/**
 * Exported because web/app.js carries a hand-copy of the first three: the page
 * shows the same two conditions as state on a holdings row, and it computes
 * them in the browser rather than reading them off the document, because both
 * are basis-derived and nothing basis-derived may be published (CLAUDE.md).
 * `tests/holdings.test.ts` diffs the copy against these.
 *
 * APPRECIATION_BAND_PCT is not mirrored: that condition depends on
 * `lastNotifiedAppreciationBand` in the store, which never leaves the machine,
 * so it is an event the browser cannot derive.
 */
export const ABOVE_BASIS_THRESHOLD_PCT = 10;
export const STAGNANT_MIN_DAYS = 30;
export const STAGNANT_MAX_PROFIT_PCT = 2;
/**
 * How many ATRs under the price a stop should sit to clear the stock's
 * ordinary daily swing without giving back more than it needs to, and how
 * far either side of that counts as on target. Under the band a stop is
 * likely to be hit by noise ("stop tight"); over it, a reversal costs more
 * than it has to ("stop loose"). Mirrored in web/app.js, which flags both on
 * the holdings row.
 */
export const STOP_ATR_MULTIPLE = 2;
export const STOP_ATR_BAND = 0.1;
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
/** Keeps the removal for the ticker's story (RemovedLot says why, and what it may not carry). */
function recordRemoval(store: HoldingsStore, lots: Lot[], now: Date, removedAt: string = now.toISOString()): void {
  store.removedLots = [
    ...(store.removedLots ?? []),
    ...lots.map((l) => ({ lotId: l.id, symbol: l.symbol, purchaseDate: l.purchaseDate, createdAt: l.createdAt, removedAt })),
  ];
}

function closePosition(store: HoldingsStore, symbol: string): Stop[] {
  const stops = store.stops.filter((s) => s.symbol === symbol);
  store.stops = store.stops.filter((s) => s.symbol !== symbol);
  store.alertState = store.alertState.filter((s) => s.symbol !== symbol);
  return stops;
}

/** Removes one lot. `closedPosition` when it was the symbol's last, which also removes its stops. */
export function removeLot(path: string, id: string, now: Date = new Date()): { lot: Lot; closedPosition: boolean } | null {
  const store = loadHoldingsStore(path);
  const lot = store.lots.find((l) => l.id === id);
  if (lot === undefined) {
    return null;
  }
  store.lots = store.lots.filter((l) => l.id !== id);
  recordRemoval(store, [lot], now);
  const closedPosition = !store.lots.some((l) => l.symbol === lot.symbol);
  if (closedPosition) {
    closePosition(store, lot.symbol);
  }
  saveHoldingsStore(path, store);
  return { lot, closedPosition };
}

/** Removes every lot of a symbol, and its stops and alert state. */
export function removePosition(path: string, symbol: string, now: Date = new Date()): { lots: Lot[]; stops: Stop[] } {
  const store = loadHoldingsStore(path);
  const lots = store.lots.filter((l) => l.symbol === symbol);
  store.lots = store.lots.filter((l) => l.symbol !== symbol);
  recordRemoval(store, lots, now);
  const stops = lots.length > 0 ? closePosition(store, symbol) : [];
  saveHoldingsStore(path, store);
  return { lots, stops };
}

export interface SaleInput {
  symbol: string;
  count: number;
  price: number;
  /** Defaults to today's local date. */
  soldOn?: string;
  /** Take only from this lot. */
  lotId?: string;
  /** Take only from lots in this account, oldest first. Ignored with lotId. */
  account?: string;
  /** Marks the sale as stop-triggered; the symbol's stops are copied onto it before a closing sale deletes them. */
  stopHit?: { atr: number | null };
}

/**
 * Lots in the order a sale takes from them: oldest purchase first, which is
 * the brokers' default (FIFO), with the entry time and id as tie-breaks so the
 * order never depends on how the store happens to be sorted. Exported because
 * web/app.js previews the same order and `tests/holdings.test.ts` diffs it.
 */
export function saleOrder<T extends Pick<Lot, "id" | "purchaseDate"> & { createdAt?: string }>(lots: T[]): T[] {
  return [...lots].sort(
    (a, b) => a.purchaseDate.localeCompare(b.purchaseDate) || (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id)
  );
}

export type SaleResult = { ok: true; sale: Sale; closedPosition: boolean } | { ok: false; reason: "no-lots" | "too-many" };

/**
 * Sells `count` shares at `price`, taking whole lots oldest first and trimming
 * the last one it reaches, or only from one lot or one account. An emptied lot
 * is removed and recorded the way removeLot records one; selling the last
 * share closes the position and its stops, as removing the last lot does.
 */
export function sellShares(path: string, input: SaleInput, now: Date = new Date()): SaleResult {
  const store = loadHoldingsStore(path);
  const eligible = saleOrder(
    store.lots.filter(
      (l) =>
        l.symbol === input.symbol &&
        (input.lotId !== undefined ? l.id === input.lotId : input.account === undefined || (l.account ?? "") === input.account)
    )
  );
  if (eligible.length === 0) {
    return { ok: false, reason: "no-lots" };
  }
  const available = eligible.reduce((sum, l) => sum + l.count, 0);
  // A hair of slack for fractional shares typed back as they were shown.
  if (input.count > available + 1e-9) {
    return { ok: false, reason: "too-many" };
  }

  const sale: Sale = {
    id: randomUUID().slice(0, 8),
    symbol: input.symbol,
    count: input.count,
    price: input.price,
    soldOn: input.soldOn ?? localDateString(now),
    recordedAt: now.toISOString(),
    lots: [],
    ...(input.stopHit
      ? {
          stopHit: {
            atr: input.stopHit.atr,
            stops: stopsForSymbol(store, input.symbol).map((s) => ({ stopPrice: s.stopPrice, count: s.count, createdAt: s.createdAt })),
          },
        }
      : {}),
  };
  const emptied: Lot[] = [];
  let left = input.count;
  for (const lot of eligible) {
    if (left <= 1e-9) break;
    const take = Math.min(lot.count, left);
    left -= take;
    const remaining = roundShares(lot.count - take);
    const part: SaleLot = { lotId: lot.id, count: take, basisPerShare: lot.basisPerShare, purchaseDate: lot.purchaseDate, emptied: remaining <= 0 };
    sale.lots.push(part);
    if (part.emptied) emptied.push(lot);
    else lot.count = remaining;
  }

  const gone = new Set(emptied.map((l) => l.id));
  store.lots = store.lots.filter((l) => !gone.has(l.id));
  recordRemoval(store, emptied, now, saleStoryTime(sale));
  store.sales = [...(store.sales ?? []), sale];
  const closedPosition = !store.lots.some((l) => l.symbol === input.symbol);
  if (closedPosition) {
    closePosition(store, input.symbol);
  }
  saveHoldingsStore(path, store);
  return { ok: true, sale, closedPosition };
}

/** Share counts can be fractional; keep a subtraction's float noise out of the store. */
const roundShares = (n: number): number => Math.round(n * 1e6) / 1e6;

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
