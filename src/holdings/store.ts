/** On-disk storage for holdings (lots + stops + per-symbol alert state), one flat JSON file. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { emptyHoldingsStore, type HoldingsStore } from "./models.js";

export function loadHoldingsStore(path: string): HoldingsStore {
  if (!existsSync(path)) {
    return emptyHoldingsStore();
  }
  return JSON.parse(readFileSync(path, "utf-8")) as HoldingsStore;
}

export function saveHoldingsStore(path: string, store: HoldingsStore): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2));
}

export function removeStop(path: string, id: string): boolean {
  const store = loadHoldingsStore(path);
  const next = store.stops.filter((s) => s.id !== id);
  if (next.length === store.stops.length) {
    return false;
  }
  store.stops = next;
  saveHoldingsStore(path, store);
  return true;
}
