/**
 * Per-run and per-ticker overrides for the breakout-verdict thresholds in
 * analysis.ts. Precedence, highest first:
 *   1. CLI flags (e.g. --volume-ratio-threshold) - applied by the caller,
 *      not here; they override everything for the whole run.
 *   2. Config file per-symbol `overrides`.
 *   3. Beta-scaled `recentHighTolerance` (if enabled and no override).
 *   4. Config file `default`.
 *   5. DEFAULT_ANALYSIS_PARAMS.
 */

import { existsSync, readFileSync } from "node:fs";
import { AnalysisParams, DEFAULT_ANALYSIS_PARAMS } from "./analysis.js";

export interface TuningConfig {
  default?: Partial<AnalysisParams>;
  /** Scale recentHighTolerance by the symbol's beta unless overridden. Default true. */
  scaleToleranceByBeta?: boolean;
  overrides?: Record<string, Partial<AnalysisParams>>;
}

/** Returns null if the file doesn't exist - distinct from an empty/default config. */
export function loadTuningConfig(path: string): TuningConfig | null {
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf-8")) as TuningConfig;
}

/** Whether resolveParamsForSymbol would need a beta fetch for this symbol - lets the caller skip the API call otherwise. */
export function needsBeta(symbol: string, config: TuningConfig, hasConfigFile: boolean): boolean {
  if (!hasConfigFile || config.scaleToleranceByBeta === false) {
    return false;
  }
  return config.overrides?.[symbol]?.recentHighTolerance === undefined;
}

export function resolveParams(symbol: string, config: TuningConfig, beta: number | null): AnalysisParams {
  const base: AnalysisParams = { ...DEFAULT_ANALYSIS_PARAMS, ...config.default };
  const scaleByBeta = config.scaleToleranceByBeta !== false;
  const scaled: AnalysisParams =
    scaleByBeta && beta !== null ? { ...base, recentHighTolerance: base.recentHighTolerance * beta } : base;
  const override = config.overrides?.[symbol] ?? {};
  return { ...scaled, ...override };
}

export async function resolveParamsForSymbol(
  symbol: string,
  config: TuningConfig,
  hasConfigFile: boolean,
  getBeta: (symbol: string) => Promise<number | null>
): Promise<AnalysisParams> {
  const beta = needsBeta(symbol, config, hasConfigFile) ? await getBeta(symbol) : null;
  return resolveParams(symbol, config, beta);
}
