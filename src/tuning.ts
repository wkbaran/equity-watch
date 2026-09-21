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
  /**
   * Symbols to exclude from alerting entirely.
   *
   * For holdings that aren't really positions: cash-parking vehicles like a
   * short-duration T-Bill ETF, where capital sits between opportunities. They
   * still appear in the dashboard's holdings list (a third of the account
   * shouldn't vanish from the picture) but generate no alerts, never enter the
   * revisit queue, and are never flagged as a quiet watch — none of which
   * would mean anything for an instrument held deliberately flat.
   */
  ignoreSymbols?: string[];
  /** Browser dashboard (`dashboard --site/--publish`) options. */
  web?: WebConfig;
}

export interface WebConfig {
  /**
   * Publish the holdings table (share counts, basis, market value) to the site.
   * Default false: the site has no login unless infra/cloudformation.yaml is deployed
   * with EnableBasicAuth=true, and dashboard.json is readable by anyone with
   * the URL. Turn both on together. Headlines may still say a name is held
   * either way; that alone isn't treated as sensitive.
   */
  holdings?: boolean;
}

/** Case-insensitive set of symbols the config says to leave alone. */
export function ignoredSymbols(config: TuningConfig | null): Set<string> {
  return new Set((config?.ignoreSymbols ?? []).map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0));
}

export function isIgnored(symbol: string, ignored: Set<string>): boolean {
  return ignored.has(symbol.toUpperCase());
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
