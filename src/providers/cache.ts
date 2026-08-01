/**
 * A dumb on-disk cache in front of any `PriceDataProvider`.
 *
 * Re-running the analysis while you're tuning thresholds shouldn't mean
 * re-fetching bars for every symbol every time, so results are cached to a
 * JSON file per (symbol, start, end) request.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PriceBar } from "../models.js";
import type { PriceDataProvider } from "./types.js";

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export class CachingProvider implements PriceDataProvider {
  private cacheDir: string;

  constructor(private inner: PriceDataProvider, cacheDir: string) {
    this.cacheDir = cacheDir;
    mkdirSync(this.cacheDir, { recursive: true });
  }

  private cacheFile(symbol: string, start: Date, end: Date): string {
    const key = `${symbol}_${dateKey(start)}_${dateKey(end)}`;
    const digest = createHash("sha1").update(key).digest("hex").slice(0, 16);
    return join(this.cacheDir, `${symbol.replace(/\//g, "_")}_${digest}.json`);
  }

  async getDailyBars(symbol: string, start: Date, end: Date): Promise<PriceBar[]> {
    const cacheFile = this.cacheFile(symbol, start, end);
    if (existsSync(cacheFile)) {
      const raw = JSON.parse(readFileSync(cacheFile, "utf-8")) as (Omit<PriceBar, "date"> & { date: string })[];
      return raw.map((b) => ({ ...b, date: new Date(b.date) }));
    }

    const bars = await this.inner.getDailyBars(symbol, start, end);
    writeFileSync(
      cacheFile,
      JSON.stringify(
        bars.map((b) => ({ ...b, date: b.date.toISOString() })),
        null,
        2
      )
    );
    return bars;
  }
}
