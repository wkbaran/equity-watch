import type { HoldingsTriggerEvent } from "./engine.js";

export interface HoldingsNotifier {
  notify(event: HoldingsTriggerEvent): Promise<void>;
}

function stopSummary(event: HoldingsTriggerEvent): string {
  if (event.stops.length === 0) {
    return "no stop set";
  }
  return event.stops.map((s) => `$${s.stopPrice} on ${s.count ?? "all"} shares`).join(", ");
}

export class ConsoleHoldingsNotifier implements HoldingsNotifier {
  async notify(event: HoldingsTriggerEvent): Promise<void> {
    const pct = event.pctAboveBasis.toFixed(1);
    switch (event.type) {
      case "above_basis":
        console.log(`  ! ${event.symbol} is ${pct}% above basis ($${event.price}) - consider adding more.`);
        break;
      case "stagnant":
        console.log(
          `  ! ${event.symbol}: ${event.daysSincePurchase?.toFixed(0)} days since last purchase, only ` +
            `${pct}% above basis - stagnant.`
        );
        break;
      case "raise_stop":
        console.log(
          `  ! ${event.symbol} up ${pct}% above basis - consider raising your stop (currently ${stopSummary(event)}).`
        );
        break;
    }
  }
}
