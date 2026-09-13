import type { Alert } from "./models.js";

export interface TriggerEvent {
  alert: Alert;
  currentPrice: number;
  chartUrl: string;
}

export interface Notifier {
  notify(event: TriggerEvent): Promise<void>;
}

export class ConsoleNotifier implements Notifier {
  async notify(event: TriggerEvent): Promise<void> {
    const { alert, currentPrice, chartUrl } = event;
    const side = alert.kind === "volume" ? "volume" : alert.side;
    const level = alert.kind === "static" ? alert.level : alert.kind === "trailing" ? alert.near : null;
    const against = level === null ? "" : ` vs level ${level}`;
    const nth = alert.triggerCount > 1 ? ` (trigger #${alert.triggerCount})` : "";
    console.log(
      `  ! ${alert.symbol} ${alert.kind} alert triggered (${side})${nth}: ` +
        `price ${currentPrice}${against} — still live, queued for revisit — ${chartUrl}`
    );
  }
}
