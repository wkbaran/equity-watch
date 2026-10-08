import { localDateString } from "../timezone.js";

export interface Lot {
  id: string;
  symbol: string;
  count: number;
  basisPerShare: number;
  purchaseDate: string;
  createdAt: string;
  /**
   * Which brokerage account holds this lot. Optional and purely descriptive -
   * computeBasis deliberately blends across accounts, because "am I up 10% on
   * BIL" is a question about the position, not about where it is custodied.
   */
  account?: string;
  /** Company name from an import, for display. */
  name?: string;
}

export interface Stop {
  id: string;
  symbol: string;
  /** Shares covered; null means "whatever is currently held," resolved dynamically at read time. */
  count: number | null;
  stopPrice: number;
  createdAt: string;
}

export interface HoldingAlertState {
  symbol: string;
  /** Seeds a baseline on the first check for this symbol without firing anything. */
  initialized: boolean;
  aboveBasisArmed: boolean;
  stagnantArmed: boolean;
  /** Ratchets up only - a pullback into a previously-reached band doesn't re-fire. */
  lastNotifiedAppreciationBand: number;
}


/**
 * A lot that has left the store, kept so a ticker's story can still say when
 * it was bought and when you got out. Lots are deleted outright, so without
 * this a closed position leaves no trace to set against the alert history.
 * Current lots need no record: their own purchase date tells the add.
 *
 * No count or basis: stories are published, and size and value never are
 * (CLAUDE.md).
 */
export interface RemovedLot {
  lotId: string;
  symbol: string;
  purchaseDate: string;
  createdAt: string;
  removedAt: string;
}

/**
 * Shares sold at a price, recorded when a removal from the page names one
 * (since 2026-10-07). Before that, and still for a removal that names no
 * price, lots simply leave the store and nothing says whether they were sold.
 *
 * Lives only in holdings.json, which never leaves the machine: it carries size
 * and value. A story is told from it without either (holdingLines).
 */
export interface Sale {
  id: string;
  symbol: string;
  count: number;
  price: number;
  /** The trade's calendar date, as entered; today when it wasn't. */
  soldOn: string;
  /** When it was recorded, which places a same-day sale among that day's fires. */
  recordedAt: string;
  /** What each lot gave up, in the order taken: the basis a realized result is measured against. */
  lots: SaleLot[];
}

export interface SaleLot {
  lotId: string;
  count: number;
  basisPerShare: number;
  purchaseDate: string;
  /** The lot had nothing left and was removed (and recorded in removedLots). */
  emptied: boolean;
}

export interface HoldingsStore {
  lots: Lot[];
  stops: Stop[];
  alertState: HoldingAlertState[];
  /** Absent in stores written before 2026-09-25, which recorded no removals. */
  removedLots?: RemovedLot[];
  /** Absent in stores written before 2026-10-07, which recorded no sales. */
  sales?: Sale[];
}

export function emptyHoldingsStore(): HoldingsStore {
  return { lots: [], stops: [], alertState: [] };
}

/**
 * Symbols with at least one lot, upper-cased.
 *
 * Derived in one place because three callers must agree on it: buildDashboard
 * sets TriggerRow/RevisitRow.heldPosition from it, buildAlertRows sets
 * AlertRow.heldPosition, and `revisit relevel` weights held names. The `held`
 * tag has to read the same on every view, and nothing else ties them together.
 */
export function heldSymbolsOf(holdings: HoldingsStore): Set<string> {
  return new Set(holdings.lots.map((l) => l.symbol.toUpperCase()));
}

/**
 * Where a lot's purchase sits in time. On the day it was entered the entry
 * time is the best guess at the order against that day's triggers; a
 * backdated lot has only a date, placed at 12:00 UTC so it reads as that date
 * in Eastern time and sorts ahead of the day's session.
 */
export function lotStoryTime(lot: Pick<Lot, "purchaseDate" | "createdAt">): string {
  return localDateString(new Date(lot.createdAt)) === lot.purchaseDate ? lot.createdAt : `${lot.purchaseDate}T12:00:00.000Z`;
}

/** Where a sale sits in time, placed the way lotStoryTime places a purchase. */
export function saleStoryTime(sale: Pick<Sale, "soldOn" | "recordedAt">): string {
  return localDateString(new Date(sale.recordedAt)) === sale.soldOn ? sale.recordedAt : `${sale.soldOn}T12:00:00.000Z`;
}

/** One beat of a position's history: a lot bought, or shares of a lot removed. */
export interface HoldingEvent {
  type: "lot.add" | "lot.remove";
  at: string;
  symbol: string;
  lotId: string;
  /** Some of the lot's shares left and the rest are still held. */
  partial?: boolean;
  /** Set when the shares were sold at a recorded price, not just removed. */
  sale?: SaleSummary;
}

/**
 * What a story says about a sale: how many shares, at what price, and what they
 * had cost. Carries size and value, so a story holding one may only travel in
 * the vault (stories already do: siteDocument empties them).
 */
export interface SaleSummary {
  id: string;
  count: number;
  price: number;
  /** What the shares sold had cost, from the lots they came out of. */
  cost: number;
}

export function saleSummary(sale: Sale): SaleSummary {
  return { id: sale.id, count: sale.count, price: sale.price, cost: sale.lots.reduce((sum, l) => sum + l.count * l.basisPerShare, 0) };
}

/** Every lot bought and removed, oldest first, from current lots plus the removal and sale records. */
export function holdingHistory(store: HoldingsStore): HoldingEvent[] {
  const events: HoldingEvent[] = store.lots.map((l) => ({ type: "lot.add", at: lotStoryTime(l), symbol: l.symbol, lotId: l.id }));
  // An emptied lot's removal is told from removedLots; this says which sale it was.
  const soldLots = new Map<string, SaleSummary>();
  for (const sale of store.sales ?? []) {
    const summary = saleSummary(sale);
    for (const part of sale.lots) {
      if (part.emptied) {
        soldLots.set(part.lotId, summary);
      } else {
        events.push({ type: "lot.remove", at: saleStoryTime(sale), symbol: sale.symbol, lotId: part.lotId, partial: true, sale: summary });
      }
    }
  }
  for (const r of store.removedLots ?? []) {
    events.push({ type: "lot.add", at: lotStoryTime(r), symbol: r.symbol, lotId: r.lotId });
    events.push({ type: "lot.remove", at: r.removedAt, symbol: r.symbol, lotId: r.lotId, ...(soldLots.has(r.lotId) ? { sale: soldLots.get(r.lotId) } : {}) });
  }
  // An add sorts ahead of a removal at the same instant.
  const rank = (e: HoldingEvent) => (e.type === "lot.add" ? 0 : 1);
  return events.sort((a, b) => a.at.localeCompare(b.at) || rank(a) - rank(b));
}

export interface BasisInfo {
  totalCount: number;
  blendedBasis: number;
  lastPurchaseDate: string;
}

export function computeBasis(lots: Lot[], symbol: string): BasisInfo | null {
  const symbolLots = lots.filter((l) => l.symbol === symbol);
  if (symbolLots.length === 0) {
    return null;
  }
  const totalCount = symbolLots.reduce((sum, l) => sum + l.count, 0);
  const totalCost = symbolLots.reduce((sum, l) => sum + l.count * l.basisPerShare, 0);
  const lastPurchaseDate = symbolLots.map((l) => l.purchaseDate).sort().at(-1)!;
  return { totalCount, blendedBasis: totalCost / totalCount, lastPurchaseDate };
}
