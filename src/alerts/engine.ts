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
import type { Notifier } from "./notify.js";
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

async function volumeSatisfied(
  condition: VolumeCondition,
  symbol: string,
  todaySoFar: number,
  market: MarketData
): Promise<boolean> {
  if (condition.mode === "today") {
    return todaySoFar >= condition.threshold;
  }

  const windowMs = periodMs(condition);
  const windowStart = Date.now() - windowMs;

  if (condition.periodUnit === "d") {
    const bars = await market.getDailyBars(symbol, new Date(windowStart), new Date());
    return bars.reduce((sum, b) => sum + b.volume, 0) >= condition.threshold;
  }

  // Sub-day periods: Schwab's REST history floors out at 1-minute bars, so
  // fetch enough trailing days to cover the window and filter client-side.
  const daysBack = Math.min(10, Math.max(2, Math.ceil(windowMs / PERIOD_UNIT_MS.d) + 1));
  const bars = await market.getIntradayBars(symbol, daysBack);
  return bars.filter((b) => b.date.getTime() >= windowStart).reduce((sum, b) => sum + b.volume, 0) >= condition.threshold;
}

export async function checkAlerts(
  alerts: Alert[],
  market: MarketData,
  notifiers: Notifier[]
): Promise<{ checked: number; triggered: Alert[] }> {
  const armed = alerts.filter((a) => a.status === "armed");
  const symbols = [...new Set(armed.map((a) => a.symbol))];
  const quotes = await market.getQuotes(symbols);

  const triggered: Alert[] = [];
  const now = new Date().toISOString();

  for (const alert of armed) {
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
    const volumeOk = condition ? await volumeSatisfied(condition, alert.symbol, quote.totalVolume, market) : true;

    if (!volumeOk) {
      // Price condition met but volume hasn't caught up yet. For static
      // alerts specifically, deliberately leave lastKnownSide stale so this
      // stays "pending" across checks until volume qualifies OR price fully
      // reverts (at which point currentSide naturally matches the stale
      // lastKnownSide again on some later check, quietly resolving it).
      continue;
    }

    alert.triggerSnapshot = { ...alert, triggerSnapshot: null } as Alert;
    alert.status = "triggered";
    alert.triggeredAt = now;
    alert.triggerPrice = currentPrice;
    triggered.push(alert);
    for (const notifier of notifiers) {
      await notifier.notify({ alert, currentPrice, chartUrl: chartUrl(alert.symbol) });
    }
  }

  return { checked: armed.length, triggered };
}

export type AddAlertInput =
  | { kind: "static"; symbol: string; level: number; volume?: VolumeCondition }
  | {
      kind: "trailing";
      symbol: string;
      near: number;
      trailType: "percent" | "amount";
      trailValue: number;
      volume?: VolumeCondition;
    }
  | { kind: "volume"; symbol: string; volume: VolumeCondition };

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
    status: "armed" as const,
    createdAt: now,
    livePriceAtCreation: livePrice,
    triggeredAt: null,
    triggerPrice: null,
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
    (a): a is PriceAlert => a.kind !== "volume" && a.status === "armed" && a.symbol === input.symbol && a.side === side
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
