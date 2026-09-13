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

export interface HoldingsStore {
  lots: Lot[];
  stops: Stop[];
  alertState: HoldingAlertState[];
}

export function emptyHoldingsStore(): HoldingsStore {
  return { lots: [], stops: [], alertState: [] };
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
