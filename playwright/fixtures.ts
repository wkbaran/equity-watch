/**
 * Fixture alerts for the Playwright suite: one of each kind the page treats
 * differently when editing. Shared by the local server and the specs, so it
 * must stay free of side effects.
 */

import type { MaAlert, StaticAlert, TrailingAlert } from "../src/alerts/models.js";

/** The fake ops endpoint accepts exactly this bearer token. */
export const OPS_TOKEN = "x".repeat(32);

function base(id: string, symbol: string, price: number) {
  return {
    id,
    symbol,
    status: "live" as const,
    createdAt: "2026-08-10T13:30:00.000Z",
    livePriceAtCreation: price,
    watchingSince: "2026-08-10T13:30:00.000Z",
    watchingSinceApprox: false,
    priceAtWatchStart: price,
    triggerCount: 0,
    lastTriggeredAt: null,
    lastTriggerPrice: null,
    mutedUntil: null,
    triggerSnapshot: null,
  };
}

export const PRICES: Record<string, number> = { AA: 46.34, MSFT: 420, TSLA: 242, SPY: 575 };

export const STATIC: StaticAlert = {
  ...base("st000001", "AA", PRICES.AA),
  kind: "static",
  side: "above",
  direction: "up",
  level: 55,
  lastKnownSide: "below",
};

export const STATIC_WITH_VOLUME: StaticAlert = {
  ...base("st000002", "MSFT", PRICES.MSFT),
  kind: "static",
  side: "below",
  direction: "either",
  level: 400,
  lastKnownSide: "above",
  volumeCondition: { ratio: 1.5, mode: "today" },
};

export const TRAILING: TrailingAlert = {
  ...base("tr000001", "TSLA", PRICES.TSLA),
  kind: "trailing",
  side: "below",
  near: 250,
  trailType: "percent",
  trailValue: 3,
  extremePrice: 240,
  extremeAt: "2026-09-14T15:00:00.000Z",
};

export const MOVING_AVERAGE: MaAlert = {
  ...base("ma000001", "SPY", PRICES.SPY),
  kind: "ma",
  maType: "sma",
  period: 200,
  timeframe: "1D",
  trigger: "cross",
  from: "below",
  marginPct: 0.25,
  lastSide: "above",
  inBand: false,
  lastLevel: 560,
  lastEvaluatedAt: null,
  lastFiredBucket: null,
  lastEvent: null,
  lastApproachedFrom: null,
};

export const FIXTURE_ALERTS = [STATIC, STATIC_WITH_VOLUME, TRAILING, MOVING_AVERAGE];
