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

export interface HoldingsStore {
  lots: Lot[];
  stops: Stop[];
  alertState: HoldingAlertState[];
  /** Absent in stores written before 2026-09-25, which recorded no removals. */
  removedLots?: RemovedLot[];
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

/** One beat of a position's history: a lot bought, or a lot removed. */
export interface HoldingEvent {
  type: "lot.add" | "lot.remove";
  at: string;
  symbol: string;
  lotId: string;
}

/** Every lot bought and removed, oldest first, from current lots plus the removal record. */
export function holdingHistory(store: HoldingsStore): HoldingEvent[] {
  const events: HoldingEvent[] = store.lots.map((l) => ({ type: "lot.add", at: lotStoryTime(l), symbol: l.symbol, lotId: l.id }));
  for (const r of store.removedLots ?? []) {
    events.push({ type: "lot.add", at: lotStoryTime(r), symbol: r.symbol, lotId: r.lotId });
    events.push({ type: "lot.remove", at: r.removedAt, symbol: r.symbol, lotId: r.lotId });
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
