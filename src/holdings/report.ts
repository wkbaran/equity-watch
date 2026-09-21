/**
 * A scannable, timestamped record of what `holdings check` triggered -
 * same pattern as src/alerts/report.ts, third distinct prefix in the same
 * reports/ directory. Only written when there's something to show.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringify } from "csv-stringify/sync";
import type { HoldingsTriggerEvent } from "./engine.js";
import { tradingViewUrl } from "../tradingview.js";
import { writeCsv } from "../csv.js";

const OUTPUT_FIELDS = [
  "type",
  "symbol",
  "price",
  "pct_above_basis",
  "days_since_purchase",
  "band",
  "stop_prices",
  "chart_url",
];

export function writeHoldingsAlertReport(triggered: HoldingsTriggerEvent[], outPath: string): void {
  const rows = triggered.map((e) => ({
    type: e.type,
    symbol: e.symbol,
    price: e.price,
    pct_above_basis: e.pctAboveBasis.toFixed(2),
    days_since_purchase: e.daysSincePurchase !== undefined ? e.daysSincePurchase.toFixed(1) : "",
    band: e.band ?? "",
    stop_prices: e.stops.map((s) => `${s.stopPrice}(${s.count ?? "all"})`).join(";"),
    chart_url: tradingViewUrl(e.symbol, null),
  }));
  writeCsv(outPath, rows, OUTPUT_FIELDS);
}
