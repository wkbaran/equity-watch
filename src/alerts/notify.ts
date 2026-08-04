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
    console.log(
      `  ! ${alert.symbol} ${alert.kind} alert triggered (${alert.side}): ` +
        `price ${currentPrice} vs trigger ${alert.triggerPrice} — ${chartUrl}`
    );
  }
}
