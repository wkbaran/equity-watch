import type { CrossDirection } from "./alerts/models.js";

export type AlertType =
  | "price_cross"
  | "trendline_cross"
  | "volume_cross"
  | "ma_strategy"
  | "pattern"
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
  /**
   * Which way price crossed `level`. Absent means "up": TradingView's CSV
   * exports carry no direction, and their analysis has always judged upward
   * crossings. Set by the revisit bridge for alerts fired here.
   */
  direction?: CrossDirection;
}

export interface PriceBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Field names predate direction-aware analysis and are kept because they are
 * persisted (history/ JSON, report CSV columns). For a downward crossing
 * (`alert.direction === "down"`), `nearRecentHigh` means the level is near
 * the recent LOW and `heldAboveLevel` means closes held BELOW it: both are
 * relative to the crossing direction. `pctAboveLevel` stays raw, so it is
 * negative when a downward crossing closed below its level.
 */
export interface BreakoutVerdict {
  alert: Alert;
  closeOnAlertDay: number | null;
  /** Raw (close - level) / level in percent, whatever the direction. */
  pctAboveLevel: number | null;
  volumeOnAlertDay: number | null;
  avgVolumeBaseline: number | null;
  volumeRatio: number | null;
  volumeTrendRatio: number | null;
  /** Level near the recent high (up) or recent low (down). */
  nearRecentHigh: boolean | null;
  /** Closes stayed past the level in the crossing direction for holdDays. */
  heldAboveLevel: boolean | null;
  daysHeld: number;
  verdict: string;
  notes: string;
}
