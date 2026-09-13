import type { MaTimeframe, MaType } from "../indicators/movingAverage.js";

export type AlertSide = "above" | "below";

export type VolumePeriodUnit = "s" | "m" | "h" | "d";

export interface VolumeCondition {
  /**
   * Absolute share count. Mutually exclusive with `ratio` - exactly one is
   * set. Absolute thresholds are what TradingView exports and what a user
   * types directly; they do not adapt as a stock's liquidity changes.
   */
  threshold?: number;
  /**
   * Multiple of typical volume for this window, recomputed against a trailing
   * baseline each check (src/alerts/volumeBaseline.ts). Cannot go stale the
   * way an absolute threshold can.
   */
  ratio?: number;
  mode: "today" | "period";
  /** Only set when mode === "period". */
  periodValue?: number;
  /** Only set when mode === "period". */
  periodUnit?: VolumePeriodUnit;
}

/**
 * Alerts do not disarm. A trigger is an event, not an end state - the alert
 * stays live and can fire again on a genuine re-cross, and every trigger
 * appends a entry to the revisit queue (src/alerts/revisit.ts) instead.
 * "cancelled" is therefore the only non-live state, and it only ever happens
 * because something explicitly cancelled it (`alert remove`, or a closer
 * alert superseding this one on the same symbol+side).
 */
export type AlertStatus = "live" | "cancelled";

interface BaseAlert {
  id: string;
  symbol: string;
  status: AlertStatus;
  createdAt: string;
  livePriceAtCreation: number;
  /**
   * When you started watching this name. Usually equal to createdAt, but a
   * seeded alert was being watched in TradingView long before this record
   * existed, so the import backdates it to the earliest evidence it has.
   */
  watchingSince: string;
  /** True when watchingSince was inferred from an import rather than observed here. */
  watchingSinceApprox: boolean;
  /**
   * Price when watching started, for "up X% since you started watching".
   * Null when it couldn't be recovered - a backdated alert whose start
   * predates the bars available at import time.
   */
  priceAtWatchStart: number | null;
  /** How many times this alert has fired over its life. */
  triggerCount: number;
  /** Most recent trigger; null until it has fired at least once. */
  lastTriggeredAt: string | null;
  lastTriggerPrice: number | null;
  /**
   * Suppress re-firing until this time. Only used where a condition would
   * otherwise stay true across consecutive checks and fire repeatedly -
   * i.e. volume conditions. Static/trailing price crossings are already
   * self-limiting (see lastKnownSide / extremePrice).
   */
  mutedUntil: string | null;
  /**
   * A full copy of every attribute as of the moment this alert last
   * triggered (itself with a null triggerSnapshot). Kept independent of the
   * live record so that a later edit/re-level of this alert can't
   * retroactively rewrite what it looked like when it fired.
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

export type MaTrigger = "cross" | "touch";
/** Which side price must be coming from for the alert to fire. */
export type MaApproach = AlertSide | "either";
export type MaEvent = "cross_up" | "cross_down" | "touch";

/**
 * Fires when price crosses, or comes within `marginPct` of, a moving average
 * (src/alerts/maEngine.ts). The level moves with the average, so unlike a
 * static alert there is nothing to re-level after it fires.
 *
 * Evaluated against the 1-minute price path since the last check, not just
 * the live quote, so a cross or touch that happened between polls still
 * fires, and an average on bars shorter than the poll interval still works.
 *
 * Not part of the price-alert above/below uniqueness rule: several averages
 * on one symbol are distinct things to watch.
 */
export interface MaAlert extends BaseAlert {
  kind: "ma";
  maType: MaType;
  period: number;
  timeframe: MaTimeframe;
  trigger: MaTrigger;
  /** For a cross, "below" means only upward crosses; for a touch, the side price approaches from. */
  from: MaApproach;
  /** Touch band as a percent of the average. Unused by crosses. */
  marginPct: number;
  /** Price's side of the average as of the last point evaluated. Null until seeded. */
  lastSide: AlertSide | null;
  /** Whether price is inside the touch band. It must leave by twice the margin to re-arm. */
  inBand: boolean;
  /** The average's value at the last point evaluated (or at the last trigger), for display. */
  lastLevel: number | null;
  lastEvaluatedAt: string | null;
  /** Bucket key of the MA bar it last fired in: at most one trigger per bar. */
  lastFiredBucket: string | null;
  lastEvent: MaEvent | null;
  lastApproachedFrom: AlertSide | null;
}

export type Alert = StaticAlert | TrailingAlert | VolumeAlert | MaAlert;
export type PriceAlert = StaticAlert | TrailingAlert;

/** The live price at which this alert's price condition would currently trigger. */
export function effectiveTrigger(a: PriceAlert): number {
  if (a.kind === "static") {
    return a.level;
  }
  const dist = a.trailType === "amount" ? a.trailValue : (a.extremePrice * a.trailValue) / 100;
  return a.side === "below" ? a.extremePrice + dist : a.extremePrice - dist;
}

/**
 * Older stores used `status: "armed" | "triggered" | "cancelled"`, where
 * "triggered" meant the alert had fired and stopped watching. Under the
 * no-disarm model both "armed" and "triggered" are simply live, so they
 * normalize forward rather than silently dropping out of every check.
 */
export function normalizeAlert(raw: Record<string, unknown>): Alert {
  const legacyStatus = raw.status as string | undefined;
  const status: AlertStatus = legacyStatus === "cancelled" ? "cancelled" : "live";
  const legacyTriggeredAt = (raw.triggeredAt ?? null) as string | null;
  const legacyTriggerPrice = (raw.triggerPrice ?? null) as number | null;

  const { triggeredAt: _t, triggerPrice: _p, ...rest } = raw;
  const createdAt = raw.createdAt as string | undefined;
  return {
    ...rest,
    status,
    watchingSince: (raw.watchingSince as string | undefined) ?? createdAt ?? new Date().toISOString(),
    watchingSinceApprox: (raw.watchingSinceApprox as boolean | undefined) ?? false,
    priceAtWatchStart:
      (raw.priceAtWatchStart as number | null | undefined) ?? (raw.livePriceAtCreation as number | undefined) ?? null,
    triggerCount: (raw.triggerCount as number | undefined) ?? (legacyTriggeredAt !== null ? 1 : 0),
    lastTriggeredAt: (raw.lastTriggeredAt as string | null | undefined) ?? legacyTriggeredAt,
    lastTriggerPrice: (raw.lastTriggerPrice as number | null | undefined) ?? legacyTriggerPrice,
    mutedUntil: (raw.mutedUntil as string | null | undefined) ?? null,
  } as Alert;
}
