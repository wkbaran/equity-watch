export type AlertSide = "above" | "below";

interface BaseAlert {
  id: string;
  symbol: string;
  side: AlertSide;
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
  level: number;
  lastKnownSide: AlertSide;
}

export interface TrailingAlert extends BaseAlert {
  kind: "trailing";
  near: number;
  trailType: "percent" | "amount";
  trailValue: number;
  extremePrice: number;
  extremeAt: string;
}

export type Alert = StaticAlert | TrailingAlert;

/** The live price at which this alert would currently trigger. */
export function effectiveTrigger(a: Alert): number {
  if (a.kind === "static") {
    return a.level;
  }
  const dist = a.trailType === "amount" ? a.trailValue : (a.extremePrice * a.trailValue) / 100;
  return a.side === "below" ? a.extremePrice + dist : a.extremePrice - dist;
}
