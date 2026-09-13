import type { Alert } from "./models.js";
import { describeMaAlert } from "./maEngine.js";

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
    const nth = alert.triggerCount > 1 ? ` (trigger #${alert.triggerCount})` : "";
    if (alert.kind === "ma") {
      console.log(
        `  ! ${alert.symbol} ma alert triggered (${alert.lastEvent}: ${describeMaAlert(alert)})${nth}: ` +
          `price ${currentPrice} vs average ${alert.lastLevel} — still live, queued for revisit — ${chartUrl}`
      );
      return;
    }
    const side = alert.kind === "volume" ? "volume" : alert.side;
    const level = alert.kind === "static" ? alert.level : alert.kind === "trailing" ? alert.near : null;
    const against = level === null ? "" : ` vs level ${level}`;
    console.log(
      `  ! ${alert.symbol} ${alert.kind} alert triggered (${side})${nth}: ` +
        `price ${currentPrice}${against} — still live, queued for revisit — ${chartUrl}`
    );
  }
}
