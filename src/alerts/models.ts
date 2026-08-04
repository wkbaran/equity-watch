export type AlertSide = "above" | "below";

export type VolumePeriodUnit = "s" | "m" | "h" | "d";

export interface VolumeCondition {
  threshold: number;
  mode: "today" | "period";
  /** Only set when mode === "period". */
  periodValue?: number;
  /** Only set when mode === "period". */
  periodUnit?: VolumePeriodUnit;
}

interface BaseAlert {
  id: string;
  symbol: string;
  status: "armed" | "triggered" | "cancelled";
  createdAt: string;
  livePriceAtCreation: number;
  triggeredAt: string | null;
  triggerPrice: number | null;
  /**
   * A full copy of every attribute as of the moment this alert triggered
   * (itself with a null triggerSnapshot, since it wasn't triggered yet at
   * that point). Kept independent of the live record so that a future
   * edit/rearm of this alert can't retroactively rewrite what it looked
   * like when it actually fired.
   */
  triggerSnapshot: Alert | null;
}

export interface StaticAlert extends BaseAlert {
  kind: "static";
  side: AlertSide;
  level: number;
  lastKnownSide: AlertSide;
  /** Optional AND condition: both the price crossing and this must hold. */
  volumeCondition?: VolumeCondition;
}

export interface TrailingAlert extends BaseAlert {
  kind: "trailing";
  side: AlertSide;
  near: number;
  trailType: "percent" | "amount";
  trailValue: number;
  extremePrice: number;
  extremeAt: string;
  /** Optional AND condition: both the trailing bounce and this must hold. */
  volumeCondition?: VolumeCondition;
}

/**
 * A standalone volume-only alert. No `side`/price anchor - volume alerts
 * are one-directional ("reaches" a threshold) and don't participate in the
 * price-based above/below uniqueness rule that static/trailing alerts do.
 */
export interface VolumeAlert extends BaseAlert {
  kind: "volume";
  volume: VolumeCondition;
}

export type Alert = StaticAlert | TrailingAlert | VolumeAlert;
export type PriceAlert = StaticAlert | TrailingAlert;

/** The live price at which this alert's price condition would currently trigger. */
export function effectiveTrigger(a: PriceAlert): number {
  if (a.kind === "static") {
    return a.level;
  }
  const dist = a.trailType === "amount" ? a.trailValue : (a.extremePrice * a.trailValue) / 100;
  return a.side === "below" ? a.extremePrice + dist : a.extremePrice - dist;
}
