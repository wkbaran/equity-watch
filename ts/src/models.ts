export type AlertType =
  | "price_cross"
  | "trendline_cross"
  | "volume_cross"
  | "ma_strategy"
  | "other";

export interface Alert {
  alertId: string;
  exchange: string;
  symbol: string;
  timeframe: string | null;
  description: string;
  time: Date;
  alertType: AlertType;
  level: number | null;
  rawTicker: string;
}

export function fullSymbol(alert: Alert): string {
  return alert.exchange ? `${alert.exchange}:${alert.symbol}` : alert.symbol;
}

export interface PriceBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BreakoutVerdict {
  alert: Alert;
  closeOnAlertDay: number | null;
  pctAboveLevel: number | null;
  volumeOnAlertDay: number | null;
  avgVolumeBaseline: number | null;
  volumeRatio: number | null;
  volumeTrendRatio: number | null;
  nearRecentHigh: boolean | null;
  heldAboveLevel: boolean | null;
  daysHeld: number;
  verdict: string;
  notes: string;
}
