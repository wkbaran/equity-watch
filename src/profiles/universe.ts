/**
 * Gathers "every symbol tracked so far" from the other subsystems' own
 * storage, for `profile fetch --all-known`. Deliberately doesn't scan a
 * fixed directory like alerts_in/ for CSVs - that's never been an enforced
 * convention in the code, just where the user happens to keep exports - so
 * CSVs are opted into explicitly via --csv instead.
 */

import { existsSync, readdirSync } from "node:fs";
import { loadAlerts } from "../alerts/store.js";
import { loadHoldingsStore } from "../holdings/store.js";
import { parseAlerts } from "../parse.js";

export interface UniverseSources {
  historyDir?: string;
  holdingsFile?: string;
  alertsFile?: string;
  csvPaths?: string[];
}

export function gatherKnownSymbols(sources: UniverseSources): Set<string> {
  const symbols = new Set<string>();

  if (sources.historyDir && existsSync(sources.historyDir)) {
    for (const file of readdirSync(sources.historyDir)) {
      if (file.endsWith(".json")) {
        symbols.add(file.replace(/\.json$/, ""));
      }
    }
  }

  if (sources.holdingsFile && existsSync(sources.holdingsFile)) {
    for (const lot of loadHoldingsStore(sources.holdingsFile).lots) {
      symbols.add(lot.symbol);
    }
  }

  if (sources.alertsFile && existsSync(sources.alertsFile)) {
    for (const alert of loadAlerts(sources.alertsFile)) {
      symbols.add(alert.symbol);
    }
  }

  for (const csvPath of sources.csvPaths ?? []) {
    for (const alert of parseAlerts(csvPath)) {
      symbols.add(alert.symbol);
    }
  }

  return symbols;
}
