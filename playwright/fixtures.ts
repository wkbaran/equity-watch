/**
 * Fixture alerts, holdings and fires for the Playwright suite: one alert of
 * each kind the page treats differently when editing, a couple of positions,
 * and enough triggers to render a queue, a story and a `held` tag. Shared by
 * the local server and the specs, so it must stay free of side effects.
 */

import type { MaAlert, StaticAlert, TrailingAlert } from "../src/alerts/models.js";
import { scoreRevisit, type RevisitEntry } from "../src/alerts/revisit.js";
import type { HoldingsStore } from "../src/holdings/models.js";

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

/** Published only inside vault.json, sealed with OPS_TOKEN. */
export const HOLDINGS: HoldingsStore = {
  lots: [
    { id: "lot00001", symbol: "AA", count: 10, basisPerShare: 40, purchaseDate: "2026-09-01", createdAt: "2026-09-01T15:00:00.000Z", account: "roth" },
    { id: "lot00002", symbol: "AA", count: 5, basisPerShare: 44, purchaseDate: "2026-09-08", createdAt: "2026-09-08T15:00:00.000Z", account: "margin" },
    { id: "lot00003", symbol: "TSLA", count: 2, basisPerShare: 260, purchaseDate: "2026-08-20", createdAt: "2026-08-20T15:00:00.000Z" },
  ],
  stops: [{ id: "stop0001", symbol: "AA", count: null, stopPrice: 38, createdAt: "2026-09-02T15:00:00.000Z" }],
  alertState: [],
};

/**
 * Fires, for the revisit queue, the recent-trigger list and the stories.
 *
 * Timestamps are relative to when this module loads rather than fixed dates,
 * so every entry stays inside buildDashboard's 7-day recent-triggers window
 * however long this suite lives. The clock time is pinned, so what a run
 * renders is otherwise deterministic. Days are counted back from now, and the
 * hour is set afterwards, which can only ever move an entry further into the
 * past - never past `now`.
 */
const daysAgo = (days: number, hour = 14): string => {
  const d = new Date(Date.now() - days * 86_400_000);
  d.setUTCHours(hour, 30, 0, 0);
  return d.toISOString();
};

/**
 * Two fires on AA, which HOLDINGS holds: enough for a story (narrative.ts
 * wants two) and for a `held` tag, with the newer one open so it also reaches
 * the queue. One on MSFT, which isn't held and so gets neither a tag nor a
 * story. Every alertId names a real fixture alert, so the trigger drawer's
 * "Alert" link resolves. All of it is invented - no real position or level.
 */
export const FIXTURE_REVISITS: RevisitEntry[] = [
  {
    id: "rv0000a1",
    alertId: STATIC.id,
    symbol: "AA",
    kind: "static",
    triggeredAt: daysAgo(5),
    triggerPrice: 44.1,
    levelAtTrigger: 43,
    condition: "price crosses above 43",
    direction: "up",
    session: "regular",
    watchingSince: daysAgo(90),
    watchingSinceApprox: false,
    priceAtWatchStart: 38,
    status: "applied",
    appliedFrom: 43,
    appliedTo: 55,
    suggestedLevel: 55,
    suggestedAt: daysAgo(5),
    suggestionBasis: "the trigger price plus its recent range",
    resolvedAt: daysAgo(4),
    ...scoreRevisit({ verdict: "CONFIRMED_BREAKOUT", pctMovePastLevel: 2.6, daysOpen: 5, heldPosition: true, volumeRatio: 1.8, volumeTrendRatio: 1.2, direction: "up" }),
  },
  {
    id: "rv0000a2",
    alertId: STATIC.id,
    symbol: "AA",
    kind: "static",
    triggeredAt: daysAgo(1),
    triggerPrice: 55.6,
    levelAtTrigger: 55,
    condition: "price crosses above 55",
    direction: "up",
    session: "regular",
    watchingSince: daysAgo(90),
    watchingSinceApprox: false,
    priceAtWatchStart: 38,
    status: "open",
    appliedFrom: null,
    appliedTo: null,
    suggestedLevel: 61,
    suggestedAt: daysAgo(1),
    suggestionBasis: "the trigger price plus its recent range",
    resolvedAt: null,
    ...scoreRevisit({ verdict: "WATCH", pctMovePastLevel: 1.1, daysOpen: 1, heldPosition: true, volumeRatio: 1.4, volumeTrendRatio: 1.1, direction: "up" }),
  },
  {
    id: "rv0000m1",
    alertId: STATIC_WITH_VOLUME.id,
    symbol: "MSFT",
    kind: "static",
    triggeredAt: daysAgo(2),
    triggerPrice: 396.4,
    levelAtTrigger: 400,
    condition: "price crosses below 400 with volume ≥ 1.5x normal today",
    direction: "down",
    session: "regular",
    watchingSince: daysAgo(60),
    watchingSinceApprox: false,
    priceAtWatchStart: 410,
    status: "open",
    appliedFrom: null,
    appliedTo: null,
    suggestedLevel: null,
    suggestedAt: null,
    suggestionBasis: null,
    resolvedAt: null,
    ...scoreRevisit({ verdict: "NO_CLOSE_CONFIRM", pctMovePastLevel: -0.9, daysOpen: 2, heldPosition: false, volumeRatio: 1.1, volumeTrendRatio: null, direction: "down" }),
  },
];
