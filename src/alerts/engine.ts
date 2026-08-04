import { randomUUID } from "node:crypto";
import { effectiveTrigger, type Alert, type AlertSide } from "./models.js";
import type { Notifier } from "./notify.js";
import { loadAlerts, saveAlerts } from "./store.js";

function chartUrl(symbol: string): string {
  return `https://www.tradingview.com/chart/?symbol=${symbol}`;
}

export async function checkAlerts(
  alerts: Alert[],
  getQuotes: (symbols: string[]) => Promise<Map<string, number>>,
  notifiers: Notifier[]
): Promise<{ checked: number; triggered: Alert[] }> {
  const armed = alerts.filter((a) => a.status === "armed");
  const symbols = [...new Set(armed.map((a) => a.symbol))];
  const quotes = await getQuotes(symbols);

  const triggered: Alert[] = [];
  const now = new Date().toISOString();

  for (const alert of armed) {
    const currentPrice = quotes.get(alert.symbol);
    if (currentPrice === undefined) {
      continue;
    }

    let didTrigger = false;
    if (alert.kind === "static") {
      const currentSide: AlertSide = currentPrice > alert.level ? "above" : "below";
      if (currentSide !== alert.lastKnownSide) {
        didTrigger = true;
      } else {
        alert.lastKnownSide = currentSide;
      }
    } else if (alert.side === "below") {
      if (currentPrice < alert.extremePrice) {
        alert.extremePrice = currentPrice;
        alert.extremeAt = now;
      } else if (currentPrice >= effectiveTrigger(alert)) {
        didTrigger = true;
      }
    } else {
      if (currentPrice > alert.extremePrice) {
        alert.extremePrice = currentPrice;
        alert.extremeAt = now;
      } else if (currentPrice <= effectiveTrigger(alert)) {
        didTrigger = true;
      }
    }

    if (didTrigger) {
      alert.triggerSnapshot = { ...alert, triggerSnapshot: null } as Alert;
      alert.status = "triggered";
      alert.triggeredAt = now;
      alert.triggerPrice = currentPrice;
      triggered.push(alert);
      for (const notifier of notifiers) {
        await notifier.notify({ alert, currentPrice, chartUrl: chartUrl(alert.symbol) });
      }
    }
  }

  return { checked: armed.length, triggered };
}

export type AddAlertInput =
  | { kind: "static"; symbol: string; level: number }
  | { kind: "trailing"; symbol: string; near: number; trailType: "percent" | "amount"; trailValue: number };

export interface AddAlertResult {
  added: Alert | null;
  replaced: Alert | null;
  rejectedReason: string | null;
}

export async function addAlert(
  path: string,
  input: AddAlertInput,
  getQuotes: (symbols: string[]) => Promise<Map<string, number>>
): Promise<AddAlertResult> {
  const quotes = await getQuotes([input.symbol]);
  const livePrice = quotes.get(input.symbol);
  if (livePrice === undefined) {
    return { added: null, replaced: null, rejectedReason: `No quote available for ${input.symbol}.` };
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

  const now = new Date().toISOString();
  const base = {
    id: randomUUID().slice(0, 8),
    symbol: input.symbol,
    side,
    status: "armed" as const,
    createdAt: now,
    livePriceAtCreation: livePrice,
    triggeredAt: null,
    triggerPrice: null,
    triggerSnapshot: null,
  };

  const candidate: Alert =
    input.kind === "static"
      ? { ...base, kind: "static", level: input.level, lastKnownSide: side }
      : {
          ...base,
          kind: "trailing",
          near: input.near,
          trailType: input.trailType,
          trailValue: input.trailValue,
          extremePrice: input.near,
          extremeAt: now,
        };

  const candidateDistance = Math.abs(livePrice - effectiveTrigger(candidate));

  const alerts = loadAlerts(path);
  const existing = alerts.find((a) => a.status === "armed" && a.symbol === input.symbol && a.side === side);

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
