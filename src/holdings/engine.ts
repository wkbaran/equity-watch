import { randomUUID } from "node:crypto";
import type { MarketData } from "../alerts/engine.js";
import { computeBasis, type HoldingAlertState, type HoldingsStore, type Lot, type Stop } from "./models.js";
import { loadHoldingsStore, saveHoldingsStore } from "./store.js";
import type { HoldingsNotifier } from "./notify.js";

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
  now: Date = new Date()
): Promise<{ checked: number; triggered: HoldingsTriggerEvent[] }> {
  const symbols = [...new Set(store.lots.map((l) => l.symbol))];
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

  return { checked: symbols.length, triggered };
}

export function addLot(
  path: string,
  input: { symbol: string; count: number; basisPerShare: number; purchaseDate?: string }
): Lot {
  const store = loadHoldingsStore(path);
  const lot: Lot = {
    id: randomUUID().slice(0, 8),
    symbol: input.symbol,
    count: input.count,
    basisPerShare: input.basisPerShare,
    purchaseDate: input.purchaseDate ?? new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString(),
  };
  store.lots.push(lot);
  saveHoldingsStore(path, store);
  return lot;
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
