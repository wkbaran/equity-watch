import { randomUUID } from "node:crypto";
import type { PriceBar } from "../models.js";
import type { Quote } from "../providers/schwab.js";
import {
  effectiveTrigger,
  type Alert,
  type AlertSide,
  type PriceAlert,
  type VolumeCondition,
  type VolumePeriodUnit,
} from "./models.js";
import type { Session } from "../marketHours.js";
import type { Notifier } from "./notify.js";
import { newRevisitEntry, type RevisitEntry } from "./revisit.js";
import { requiredVolume } from "./volumeBaseline.js";
import { loadAlerts, saveAlerts } from "./store.js";

export interface MarketData {
  getQuotes(symbols: string[]): Promise<Map<string, Quote>>;
  /** Minute bars for the last `daysBack` trading sessions. */
  getIntradayBars(symbol: string, daysBack: number): Promise<PriceBar[]>;
  getDailyBars(symbol: string, start: Date, end: Date): Promise<PriceBar[]>;
}

function chartUrl(symbol: string): string {
  return `https://www.tradingview.com/chart/?symbol=${symbol}`;
}

const PERIOD_UNIT_MS: Record<VolumePeriodUnit, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

function periodMs(condition: VolumeCondition): number {
  return condition.periodValue! * PERIOD_UNIT_MS[condition.periodUnit!];
}

/**
 * Resolves how many shares a condition currently demands. An absolute
 * threshold answers immediately; a ratio needs the symbol's typical volume for
 * this window, which the caller supplies (and caches - recomputing per poll
 * would mean a bar fetch per volume alert every check).
 */
export type BaselineResolver = (symbol: string, condition: VolumeCondition) => Promise<number | null>;

async function volumeSatisfied(
  condition: VolumeCondition,
  symbol: string,
  todaySoFar: number,
  market: MarketData,
  resolveBaseline: BaselineResolver
): Promise<boolean> {
  const needsBaseline = condition.threshold === undefined;
  const baseline = needsBaseline ? await resolveBaseline(symbol, condition) : null;
  const required = requiredVolume(condition, baseline);
  if (required === null) {
    // No usable threshold - a ratio with no baseline to scale. Treat as
    // unsatisfied rather than letting any volume qualify.
    return false;
  }

  if (condition.mode === "today") {
    return todaySoFar >= required;
  }

  const windowMs = periodMs(condition);
  const windowStart = Date.now() - windowMs;

  if (condition.periodUnit === "d") {
    const bars = await market.getDailyBars(symbol, new Date(windowStart), new Date());
    return bars.reduce((sum, b) => sum + b.volume, 0) >= required;
  }

  // Sub-day periods: Schwab's REST history floors out at 1-minute bars, so
  // fetch enough trailing days to cover the window and filter client-side.
  const daysBack = Math.min(10, Math.max(2, Math.ceil(windowMs / PERIOD_UNIT_MS.d) + 1));
  const bars = await market.getIntradayBars(symbol, daysBack);
  return bars.filter((b) => b.date.getTime() >= windowStart).reduce((sum, b) => sum + b.volume, 0) >= required;
}

/**
 * How long to suppress re-firing after a volume condition is satisfied.
 * A volume threshold, once crossed, stays crossed - without this the alert
 * would fire on every poll for the rest of the window. Price crossings need
 * no equivalent: they are already self-limiting via lastKnownSide (static)
 * and extremePrice (trailing).
 */
function muteUntilFor(condition: VolumeCondition, now: Date): string {
  if (condition.mode === "today") {
    const tomorrow = new Date(now);
    tomorrow.setUTCHours(0, 0, 0, 0);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return tomorrow.toISOString();
  }
  return new Date(now.getTime() + periodMs(condition)).toISOString();
}

export async function checkAlerts(
  alerts: Alert[],
  market: MarketData,
  notifiers: Notifier[],
  session: Session | null = null,
  /** Symbols to leave alone entirely - see TuningConfig.ignoreSymbols. */
  ignored: Set<string> = new Set(),
  /** Supplies typical volume for ratio-based conditions. */
  resolveBaseline: BaselineResolver = async () => null
): Promise<{ checked: number; triggered: Alert[]; revisits: RevisitEntry[] }> {
  const live = alerts.filter((a) => a.status === "live" && !ignored.has(a.symbol.toUpperCase()));
  const symbols = [...new Set(live.map((a) => a.symbol))];
  const quotes = await market.getQuotes(symbols);

  const triggered: Alert[] = [];
  const revisits: RevisitEntry[] = [];
  const nowDate = new Date();
  const now = nowDate.toISOString();

  for (const alert of live) {
    if (alert.mutedUntil !== null && alert.mutedUntil > now) {
      continue;
    }
    const quote = quotes.get(alert.symbol);
    if (quote === undefined) {
      continue;
    }
    const currentPrice = quote.lastPrice;

    let priceConditionMet: boolean;
    if (alert.kind === "volume") {
      priceConditionMet = true;
    } else if (alert.kind === "static") {
      const currentSide: AlertSide = currentPrice > alert.level ? "above" : "below";
      priceConditionMet = currentSide !== alert.lastKnownSide;
      // lastKnownSide is deliberately NOT advanced here when there's no
      // crossing - see the volume-gating comment below for why.
    } else if (alert.side === "below") {
      if (currentPrice < alert.extremePrice) {
        alert.extremePrice = currentPrice;
        alert.extremeAt = now;
        priceConditionMet = false;
      } else {
        priceConditionMet = currentPrice >= effectiveTrigger(alert);
      }
    } else {
      if (currentPrice > alert.extremePrice) {
        alert.extremePrice = currentPrice;
        alert.extremeAt = now;
        priceConditionMet = false;
      } else {
        priceConditionMet = currentPrice <= effectiveTrigger(alert);
      }
    }

    if (!priceConditionMet) {
      continue;
    }

    const condition = alert.kind === "volume" ? alert.volume : alert.volumeCondition;
    const volumeOk = condition
      ? await volumeSatisfied(condition, alert.symbol, quote.totalVolume, market, resolveBaseline)
      : true;

    if (!volumeOk) {
      // Price condition met but volume hasn't caught up yet. For static
      // alerts specifically, deliberately leave lastKnownSide stale so this
      // stays "pending" across checks until volume qualifies OR price fully
      // reverts (at which point currentSide naturally matches the stale
      // lastKnownSide again on some later check, quietly resolving it).
      continue;
    }

    // Snapshot and queue the revisit entry from the pre-re-arm state, so both
    // record what the alert looked like when it fired rather than what it
    // looks like after being set up to watch again.
    const snapshot = { ...alert, triggerSnapshot: null } as Alert;
    revisits.push(newRevisitEntry(snapshot, currentPrice, now, session));

    alert.triggerSnapshot = snapshot;
    alert.triggerCount += 1;
    alert.lastTriggeredAt = now;
    alert.lastTriggerPrice = currentPrice;

    // The alert does not disarm. Set it up to watch again from here:
    // a static alert goes quiet until price genuinely re-crosses its level,
    // and a trailing alert starts trailing afresh from the current price.
    if (alert.kind === "static") {
      alert.lastKnownSide = currentPrice > alert.level ? "above" : "below";
    } else if (alert.kind === "trailing") {
      alert.extremePrice = currentPrice;
      alert.extremeAt = now;
    }
    alert.mutedUntil = condition ? muteUntilFor(condition, nowDate) : null;

    triggered.push(alert);
    for (const notifier of notifiers) {
      await notifier.notify({ alert, currentPrice, chartUrl: chartUrl(alert.symbol) });
    }
  }

  return { checked: live.length, triggered, revisits };
}

/** Backdates an imported alert to when it was really first watched. */
export interface WatchOrigin {
  since: string;
  approximate: boolean;
  priceAtStart: number | null;
}

export type AddAlertInput =
  | { kind: "static"; symbol: string; level: number; volume?: VolumeCondition; watching?: WatchOrigin }
  | {
      kind: "trailing";
      symbol: string;
      near: number;
      trailType: "percent" | "amount";
      trailValue: number;
      volume?: VolumeCondition;
      watching?: WatchOrigin;
    }
  | { kind: "volume"; symbol: string; volume: VolumeCondition; watching?: WatchOrigin };

export interface AddAlertResult {
  added: Alert | null;
  replaced: Alert | null;
  rejectedReason: string | null;
}

export async function addAlert(path: string, input: AddAlertInput, market: MarketData): Promise<AddAlertResult> {
  const quotes = await market.getQuotes([input.symbol]);
  const quote = quotes.get(input.symbol);
  if (quote === undefined) {
    return { added: null, replaced: null, rejectedReason: `No quote available for ${input.symbol}.` };
  }
  const livePrice = quote.lastPrice;

  const now = new Date().toISOString();
  const baseFields = {
    id: randomUUID().slice(0, 8),
    symbol: input.symbol,
    status: "live" as const,
    createdAt: now,
    livePriceAtCreation: livePrice,
    watchingSince: input.watching?.since ?? now,
    watchingSinceApprox: input.watching?.approximate ?? false,
    priceAtWatchStart: input.watching?.priceAtStart ?? livePrice,
    triggerCount: 0,
    lastTriggeredAt: null,
    lastTriggerPrice: null,
    mutedUntil: null,
    triggerSnapshot: null,
  };

  // Volume-only alerts have no price anchor/side, so they sit outside the
  // above/below uniqueness rule entirely - always just added.
  if (input.kind === "volume") {
    const candidate: Alert = { ...baseFields, kind: "volume", volume: input.volume };
    const alerts = loadAlerts(path);
    alerts.push(candidate);
    saveAlerts(path, alerts);
    return { added: candidate, replaced: null, rejectedReason: null };
  }

  const anchor = input.kind === "static" ? input.level : input.near;
  if (anchor === livePrice) {
    return {
      added: null,
      replaced: null,
      rejectedReason: `Reference price ${anchor} equals the live price (${livePrice}); pick a distinct one.`,
    };
  }
  const side: AlertSide = anchor < livePrice ? "below" : "above";
  const base = { ...baseFields, side };

  const candidate: PriceAlert =
    input.kind === "static"
      ? {
          ...base,
          kind: "static",
          level: input.level,
          lastKnownSide: livePrice > input.level ? "above" : "below",
          ...(input.volume ? { volumeCondition: input.volume } : {}),
        }
      : {
          ...base,
          kind: "trailing",
          near: input.near,
          trailType: input.trailType,
          trailValue: input.trailValue,
          extremePrice: input.near,
          extremeAt: now,
          ...(input.volume ? { volumeCondition: input.volume } : {}),
        };

  const candidateDistance = Math.abs(livePrice - effectiveTrigger(candidate));

  const alerts = loadAlerts(path);
  const existing = alerts.find(
    (a): a is PriceAlert => a.kind !== "volume" && a.status === "live" && a.symbol === input.symbol && a.side === side
  );

  if (existing) {
    const existingDistance = Math.abs(livePrice - effectiveTrigger(existing));
    if (candidateDistance > existingDistance) {
      return {
        added: null,
        replaced: null,
        rejectedReason:
          `Existing ${existing.kind} alert ${existing.id} (trigger ${effectiveTrigger(existing)}) is ` +
          `already closer to the live price than this one would be (trigger ${effectiveTrigger(candidate)}).`,
      };
    }
    existing.status = "cancelled";
  }

  alerts.push(candidate);
  saveAlerts(path, alerts);
  return { added: candidate, replaced: existing ?? null, rejectedReason: null };
}
