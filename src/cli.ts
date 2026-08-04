#!/usr/bin/env node
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { stringify } from "csv-stringify/sync";
import { analyzeAlert, AnalysisParams } from "./analysis.js";
import { triggeredAlertsToBreakoutAlerts } from "./alerts/bridge.js";
import { addAlert, checkAlerts, type AddAlertInput, type MarketData } from "./alerts/engine.js";
import { effectiveTrigger, type VolumeCondition, type VolumePeriodUnit } from "./alerts/models.js";
import { ConsoleNotifier } from "./alerts/notify.js";
import { writeAlertTriggerReport } from "./alerts/report.js";
import { listAlerts, loadAlerts, removeAlert, saveAlerts } from "./alerts/store.js";
import { updateHistory } from "./history.js";
import type { Alert, BreakoutVerdict } from "./models.js";
import { parseAlerts } from "./parse.js";
import { CachingProvider } from "./providers/cache.js";
import { DEFAULT_MAX_REQUESTS_PER_MINUTE, SchwabAuth, SchwabProvider, type Quote } from "./providers/schwab.js";
import type { PriceDataProvider } from "./providers/types.js";
import { loadTuningConfig, resolveParamsForSymbol, type TuningConfig } from "./tuning.js";

const VERDICT_ORDER: Record<string, number> = {
  CONFIRMED_BREAKOUT: 0,
  WATCH: 1,
  WATCH_WEAK: 2,
  NO_CLOSE_CONFIRM: 3,
  NO: 4,
  INSUFFICIENT_DATA: 5,
  SKIPPED: 6,
  PROVIDER_ERROR: 7,
};

const OUTPUT_FIELDS = [
  "verdict",
  "symbol",
  "exchange",
  "alert_time",
  "level",
  "close_on_alert_day",
  "pct_above_level",
  "volume_on_alert_day",
  "avg_volume_baseline",
  "volume_ratio",
  "volume_trend_ratio",
  "near_recent_high",
  "held_above_level",
  "days_held",
  "notes",
  "alert_id",
];

function tradingToCalendarDays(tradingDays: number): number {
  return Math.trunc(tradingDays * 1.6) + 10;
}

function calendarRangeForSymbol(alerts: Alert[], params: AnalysisParams): { start: Date; end: Date } {
  const alertDates = alerts.map((a) => a.time.getTime());
  const lookbackDays = Math.max(params.baselineDays, params.recentHighLookbackDays);
  const dayMs = 24 * 60 * 60 * 1000;
  const start = new Date(Math.min(...alertDates) - tradingToCalendarDays(lookbackDays) * dayMs);
  let end = new Date(Math.max(...alertDates) + tradingToCalendarDays(params.holdDays) * dayMs);
  const today = new Date();
  if (end > today) {
    end = today;
  }
  return { start, end };
}

function providerErrorVerdict(alert: Alert, err: unknown): BreakoutVerdict {
  return {
    alert,
    closeOnAlertDay: null,
    pctAboveLevel: null,
    volumeOnAlertDay: null,
    avgVolumeBaseline: null,
    volumeRatio: null,
    volumeTrendRatio: null,
    nearRecentHigh: null,
    heldAboveLevel: null,
    daysHeld: 0,
    verdict: "PROVIDER_ERROR",
    notes: String(err instanceof Error ? err.message : err),
  };
}

function fmt(value: number | null): string {
  return value === null ? "" : value.toFixed(4);
}

interface CommonOpts {
  appKey?: string;
  appSecret?: string;
  tokenPath: string;
}

function resolveMaxRequestsPerMinute(): number {
  const raw = process.env.SCHWAB_MAX_REQUESTS_PER_MINUTE;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_REQUESTS_PER_MINUTE;
}

function buildSchwabProvider(opts: CommonOpts & { noCache?: boolean; cacheDir: string }): PriceDataProvider {
  const appKey = opts.appKey ?? process.env.SCHWAB_APP_KEY;
  const appSecret = opts.appSecret ?? process.env.SCHWAB_APP_SECRET;
  if (!appKey || !appSecret) {
    console.error(
      "Missing Schwab credentials. Set SCHWAB_APP_KEY / SCHWAB_APP_SECRET in a .env file (or env vars) " +
        "or pass --app-key/--app-secret. See SETUP.md."
    );
    process.exit(1);
  }
  const auth = new SchwabAuth(appKey, appSecret, opts.tokenPath);
  const provider = new SchwabProvider(auth, resolveMaxRequestsPerMinute());
  if (opts.noCache) {
    return provider;
  }
  return new CachingProvider(provider, opts.cacheDir);
}

const BETA_CACHE_DIR = join(".cache", "beta");

function buildBetaFetcher(opts: CommonOpts & { noCache?: boolean }): (symbol: string) => Promise<number | null> {
  const appKey = opts.appKey ?? process.env.SCHWAB_APP_KEY;
  const appSecret = opts.appSecret ?? process.env.SCHWAB_APP_SECRET;
  if (!appKey || !appSecret) {
    console.error(
      "Missing Schwab credentials. Set SCHWAB_APP_KEY / SCHWAB_APP_SECRET in a .env file (or env vars) " +
        "or pass --app-key/--app-secret. See SETUP.md."
    );
    process.exit(1);
  }
  const auth = new SchwabAuth(appKey, appSecret, opts.tokenPath);
  const provider = new SchwabProvider(auth, resolveMaxRequestsPerMinute());

  return async (symbol: string) => {
    if (opts.noCache) {
      return provider.getBeta(symbol);
    }
    const file = join(BETA_CACHE_DIR, `${symbol.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
    if (existsSync(file)) {
      return (JSON.parse(readFileSync(file, "utf-8")) as { beta: number | null }).beta;
    }
    const beta = await provider.getBeta(symbol);
    mkdirSync(BETA_CACHE_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify({ beta }));
    return beta;
  };
}

function buildMarketData(opts: CommonOpts): MarketData {
  const appKey = opts.appKey ?? process.env.SCHWAB_APP_KEY;
  const appSecret = opts.appSecret ?? process.env.SCHWAB_APP_SECRET;
  if (!appKey || !appSecret) {
    console.error(
      "Missing Schwab credentials. Set SCHWAB_APP_KEY / SCHWAB_APP_SECRET in a .env file (or env vars) " +
        "or pass --app-key/--app-secret. See SETUP.md."
    );
    process.exit(1);
  }
  const auth = new SchwabAuth(appKey, appSecret, opts.tokenPath);
  const provider = new SchwabProvider(auth, resolveMaxRequestsPerMinute());
  return {
    getQuotes: (symbols) => provider.getQuotes(symbols),
    getIntradayBars: (symbol, daysBack) => provider.getIntradayBars(symbol, daysBack),
    getDailyBars: (symbol, start, end) => provider.getDailyBars(symbol, start, end),
  };
}

/** Parses "30m" / "2h" / "1d" / "45s" into a VolumeCondition's period fields. */
function parseVolumePeriod(raw: string): { periodValue: number; periodUnit: VolumePeriodUnit } {
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(raw.trim());
  if (!match) {
    console.error(`Invalid --volume-period "${raw}" — expected a number followed by s, m, h, or d (e.g. "30m").`);
    process.exit(1);
  }
  return { periodValue: parseFloat(match[1]), periodUnit: match[2] as VolumePeriodUnit };
}

async function cmdSchwabLogin(opts: CommonOpts): Promise<void> {
  const appKey = opts.appKey ?? process.env.SCHWAB_APP_KEY;
  const appSecret = opts.appSecret ?? process.env.SCHWAB_APP_SECRET;
  if (!appKey || !appSecret) {
    console.error("Missing Schwab credentials. Set SCHWAB_APP_KEY / SCHWAB_APP_SECRET in a .env file (or env vars) or pass --app-key/--app-secret.");
    process.exit(1);
  }
  const auth = new SchwabAuth(appKey, appSecret, opts.tokenPath);
  await auth.authorizeInteractive();
  console.log(`Saved Schwab tokens to ${opts.tokenPath}`);
}

interface AnalyzeOpts extends CommonOpts {
  csv?: string;
  fromAlerts?: string | true;
  out?: string;
  symbol?: string[];
  noCache?: boolean;
  cacheDir: string;
  historyDir: string;
  config: string;
  baselineDays?: number;
  volumeRatioThreshold?: number;
  volumeTrendDays?: number;
  recentHighLookbackDays?: number;
  recentHighTolerance?: number;
  holdDays?: number;
}

/** CLI flags, if explicitly passed, override everything else for the whole run. */
function applyCliOverrides(params: AnalysisParams, opts: AnalyzeOpts): AnalysisParams {
  return {
    ...params,
    baselineDays: opts.baselineDays ?? params.baselineDays,
    volumeRatioThreshold: opts.volumeRatioThreshold ?? params.volumeRatioThreshold,
    volumeTrendDays: opts.volumeTrendDays ?? params.volumeTrendDays,
    recentHighLookbackDays: opts.recentHighLookbackDays ?? params.recentHighLookbackDays,
    recentHighTolerance: opts.recentHighTolerance ?? params.recentHighTolerance,
    holdDays: opts.holdDays ?? params.holdDays,
  };
}

export async function runAnalyze(
  opts: AnalyzeOpts,
  provider: PriceDataProvider,
  getBeta: (symbol: string) => Promise<number | null>
): Promise<BreakoutVerdict[]> {
  let alerts = opts.fromAlerts
    ? triggeredAlertsToBreakoutAlerts(loadAlerts(opts.fromAlerts === true ? "alerts.json" : opts.fromAlerts))
    : parseAlerts(opts.csv!);
  if (opts.symbol && opts.symbol.length > 0) {
    const wanted = new Set(opts.symbol.map((s) => s.toUpperCase()));
    alerts = alerts.filter((a) => wanted.has(a.symbol.toUpperCase()));
  }
  if (alerts.length === 0) {
    throw new Error("No alerts matched (check --csv/--from-alerts path and --symbol filters).");
  }

  const rawConfig = loadTuningConfig(opts.config);
  const config: TuningConfig = rawConfig ?? {};
  const hasConfigFile = rawConfig !== null;

  const bySymbol = new Map<string, Alert[]>();
  for (const alert of alerts) {
    const list = bySymbol.get(alert.symbol) ?? [];
    list.push(alert);
    bySymbol.set(alert.symbol, list);
  }

  const verdicts: BreakoutVerdict[] = [];
  for (const symbol of [...bySymbol.keys()].sort()) {
    const symbolAlerts = bySymbol.get(symbol)!;
    const priceCrossAlerts = symbolAlerts.filter((a) => a.level !== null);
    const nonPriceAlerts = symbolAlerts.filter((a) => a.level === null);
    const params = applyCliOverrides(await resolveParamsForSymbol(symbol, config, hasConfigFile, getBeta), opts);

    for (const alert of nonPriceAlerts) {
      verdicts.push(analyzeAlert(alert, [], params));
    }

    if (priceCrossAlerts.length === 0) {
      continue;
    }

    const { start, end } = calendarRangeForSymbol(priceCrossAlerts, params);
    let bars;
    try {
      bars = await provider.getDailyBars(symbol, start, end);
    } catch (err) {
      console.error(`  ! ${symbol}: failed to fetch price history (${err})`);
      for (const alert of priceCrossAlerts) {
        verdicts.push(providerErrorVerdict(alert, err));
      }
      continue;
    }

    for (const alert of priceCrossAlerts) {
      verdicts.push(analyzeAlert(alert, bars, params));
    }
  }

  verdicts.sort((a, b) => {
    const orderDiff = (VERDICT_ORDER[a.verdict] ?? 99) - (VERDICT_ORDER[b.verdict] ?? 99);
    if (orderDiff !== 0) return orderDiff;
    const volumeDiff = (b.volumeRatio ?? 0) - (a.volumeRatio ?? 0);
    if (volumeDiff !== 0) return volumeDiff;
    return a.alert.time.getTime() - b.alert.time.getTime();
  });

  return verdicts;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function timestampSuffix(now: Date): string {
  return (
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}` +
    `_${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`
  );
}

function defaultReportPath(now: Date): string {
  return join("reports", `breakout_report_${timestampSuffix(now)}.csv`);
}

function defaultAlertTriggerReportPath(now: Date): string {
  return join("reports", `alert_triggers_${timestampSuffix(now)}.csv`);
}

function writeReport(verdicts: BreakoutVerdict[], outPath: string): void {
  const rows = verdicts.map((v) => ({
    verdict: v.verdict,
    symbol: v.alert.symbol,
    exchange: v.alert.exchange,
    alert_time: v.alert.time.toISOString(),
    level: v.alert.level,
    close_on_alert_day: v.closeOnAlertDay,
    pct_above_level: fmt(v.pctAboveLevel),
    volume_on_alert_day: v.volumeOnAlertDay,
    avg_volume_baseline: fmt(v.avgVolumeBaseline),
    volume_ratio: fmt(v.volumeRatio),
    volume_trend_ratio: fmt(v.volumeTrendRatio),
    near_recent_high: v.nearRecentHigh,
    held_above_level: v.heldAboveLevel,
    days_held: v.daysHeld,
    notes: v.notes,
    alert_id: v.alert.alertId,
  }));
  const csvText = stringify(rows, { header: true, columns: OUTPUT_FIELDS });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, csvText);
}

function printSummary(verdicts: BreakoutVerdict[], outPath: string): void {
  const counts = new Map<string, number>();
  for (const v of verdicts) {
    counts.set(v.verdict, (counts.get(v.verdict) ?? 0) + 1);
  }
  console.log(`Wrote ${verdicts.length} rows to ${outPath}`);
  for (const verdictName of [...counts.keys()].sort((a, b) => (VERDICT_ORDER[a] ?? 99) - (VERDICT_ORDER[b] ?? 99))) {
    console.log(`  ${verdictName}: ${counts.get(verdictName)}`);
  }

  const top = verdicts.filter((v) => v.verdict === "CONFIRMED_BREAKOUT").slice(0, 10);
  if (top.length > 0) {
    console.log("\nTop confirmed breakouts:");
    for (const v of top) {
      console.log(
        `  ${v.alert.symbol.padEnd(6)} ${v.alert.time.toISOString().slice(0, 10)}  level=${v.alert.level}  ${v.notes}`
      );
    }
  }
}

async function cmdAnalyze(opts: AnalyzeOpts): Promise<void> {
  if (!opts.csv && !opts.fromAlerts) {
    console.error("Specify --csv <path> (TradingView export) or --from-alerts [path] (this engine's alerts.json).");
    process.exit(1);
  }
  if (opts.csv && opts.fromAlerts) {
    console.error("Specify only one of --csv or --from-alerts.");
    process.exit(1);
  }
  const provider = buildSchwabProvider(opts);
  const getBeta = buildBetaFetcher(opts);
  const verdicts = await runAnalyze(opts, provider, getBeta);
  const outPath = opts.out ?? defaultReportPath(new Date());
  writeReport(verdicts, outPath);
  printSummary(verdicts, outPath);
  const touched = updateHistory(verdicts, opts.historyDir);
  console.log(`Updated history for ${touched} ticker(s) in ${opts.historyDir}`);
}

interface AlertCommonOpts extends CommonOpts {
  alertsFile: string;
}

interface AlertAddOpts extends AlertCommonOpts {
  symbol: string;
  level?: string;
  near?: string;
  trailPercent?: string;
  trailAmount?: string;
  volumeAtLeast?: string;
  volumePeriod?: string;
}

function formatVolumeCondition(v: VolumeCondition): string {
  return v.mode === "today" ? `volume >= ${v.threshold} today` : `volume >= ${v.threshold} in last ${v.periodValue}${v.periodUnit}`;
}

/** Builds the optional VolumeCondition shared by static/trailing/volume alert creation. Exits on bad input. */
function parseVolumeFlags(opts: { volumeAtLeast?: string; volumePeriod?: string }): VolumeCondition | undefined {
  if (opts.volumeAtLeast === undefined) {
    if (opts.volumePeriod !== undefined) {
      console.error("--volume-period requires --volume-at-least.");
      process.exit(1);
    }
    return undefined;
  }
  const threshold = parseFloat(opts.volumeAtLeast);
  if (opts.volumePeriod === undefined) {
    return { threshold, mode: "today" };
  }
  const { periodValue, periodUnit } = parseVolumePeriod(opts.volumePeriod);
  return { threshold, mode: "period", periodValue, periodUnit };
}

interface AlertListOpts extends AlertCommonOpts {
  all?: boolean;
}

interface AlertImportOpts extends AlertCommonOpts {
  csv: string;
  symbol?: string[];
  asTrailing?: boolean;
  trailPercent?: string;
  trailAmount?: string;
}

async function cmdAlertAdd(opts: AlertAddOpts): Promise<void> {
  const hasLevel = opts.level !== undefined;
  const hasNear = opts.near !== undefined;
  if (hasLevel && hasNear) {
    console.error("Specify at most one of --level (static alert) or --near (trailing alert).");
    process.exit(1);
  }
  if (!hasLevel && !hasNear && opts.volumeAtLeast === undefined) {
    console.error("Specify --level, --near, or --volume-at-least (a standalone volume alert).");
    process.exit(1);
  }

  const volume = parseVolumeFlags(opts);

  let input: AddAlertInput;
  if (hasLevel) {
    if (opts.trailPercent !== undefined || opts.trailAmount !== undefined) {
      console.error("--trail-percent/--trail-amount only apply to trailing alerts (--near).");
      process.exit(1);
    }
    input = { kind: "static", symbol: opts.symbol, level: parseFloat(opts.level!), volume };
  } else if (hasNear) {
    const hasPercent = opts.trailPercent !== undefined;
    const hasAmount = opts.trailAmount !== undefined;
    if (hasPercent === hasAmount) {
      console.error("Specify exactly one of --trail-percent or --trail-amount for a trailing alert.");
      process.exit(1);
    }
    input = {
      kind: "trailing",
      symbol: opts.symbol,
      near: parseFloat(opts.near!),
      trailType: hasPercent ? "percent" : "amount",
      trailValue: parseFloat((hasPercent ? opts.trailPercent : opts.trailAmount)!),
      volume,
    };
  } else {
    if (opts.trailPercent !== undefined || opts.trailAmount !== undefined) {
      console.error("--trail-percent/--trail-amount require --near.");
      process.exit(1);
    }
    input = { kind: "volume", symbol: opts.symbol, volume: volume! };
  }

  const market = buildMarketData(opts);
  const result = await addAlert(opts.alertsFile, input, market);

  if (result.rejectedReason) {
    console.log(`Not added: ${result.rejectedReason}`);
    return;
  }
  const a = result.added!;
  if (a.kind === "volume") {
    console.log(`Added volume alert ${a.id} (${a.symbol}, ${formatVolumeCondition(a.volume)}).`);
    return;
  }
  const trigger = effectiveTrigger(a);
  const andVolume = a.volumeCondition ? ` AND ${formatVolumeCondition(a.volumeCondition)}` : "";
  if (result.replaced) {
    console.log(
      `Replaced ${result.replaced.kind} alert ${result.replaced.id} — added ${a.kind} alert ${a.id} ` +
        `(${a.symbol}, ${a.side}, trigger ${trigger}${andVolume}).`
    );
  } else {
    console.log(`Added ${a.kind} alert ${a.id} (${a.symbol}, ${a.side}, trigger ${trigger}${andVolume}).`);
  }
}

async function cmdAlertImport(opts: AlertImportOpts): Promise<void> {
  const hasPercent = opts.trailPercent !== undefined;
  const hasAmount = opts.trailAmount !== undefined;
  if (opts.asTrailing) {
    if (hasPercent === hasAmount) {
      console.error("Specify exactly one of --trail-percent or --trail-amount with --as-trailing.");
      process.exit(1);
    }
  } else if (hasPercent || hasAmount) {
    console.error("--trail-percent/--trail-amount only apply with --as-trailing.");
    process.exit(1);
  }

  let tvAlerts = parseAlerts(opts.csv);
  if (opts.symbol && opts.symbol.length > 0) {
    const wanted = new Set(opts.symbol.map((s) => s.toUpperCase()));
    tvAlerts = tvAlerts.filter((a) => wanted.has(a.symbol.toUpperCase()));
  }
  const priceCrossAlerts = tvAlerts.filter((a) => a.level !== null);

  const seen = new Set<string>();
  const candidates: { symbol: string; level: number }[] = [];
  for (const a of priceCrossAlerts) {
    const key = `${a.symbol}|${a.level}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ symbol: a.symbol, level: a.level! });
  }

  if (candidates.length === 0) {
    console.log("No numeric price-level alerts found to import (only `Crossing <level>` alerts qualify).");
    return;
  }

  // Fetch every symbol's quote once up front rather than once per candidate
  // (addAlert() normally does its own live fetch per call).
  const symbols = [...new Set(candidates.map((c) => c.symbol))];
  const rawMarket = buildMarketData(opts);
  const quotes = await rawMarket.getQuotes(symbols);
  const cachedMarket: MarketData = {
    ...rawMarket,
    getQuotes: async (syms) => {
      const result = new Map<string, Quote>();
      for (const s of syms) {
        const q = quotes.get(s);
        if (q !== undefined) result.set(s, q);
      }
      return result;
    },
  };

  let added = 0;
  let replaced = 0;
  let rejected = 0;
  let skipped = 0;
  for (const { symbol, level } of candidates) {
    const input: AddAlertInput = opts.asTrailing
      ? {
          kind: "trailing",
          symbol,
          near: level,
          trailType: hasPercent ? "percent" : "amount",
          trailValue: parseFloat((hasPercent ? opts.trailPercent : opts.trailAmount)!),
        }
      : { kind: "static", symbol, level };

    const result = await addAlert(opts.alertsFile, input, cachedMarket);
    if (result.rejectedReason) {
      if (result.rejectedReason.startsWith("No quote")) {
        skipped++;
      } else {
        rejected++;
      }
      continue;
    }
    added++;
    if (result.replaced) {
      replaced++;
    }
  }

  console.log(
    `Imported ${added} alert(s) from ${candidates.length} candidate(s) ` +
      `(${replaced} replaced an existing alert, ${rejected} rejected as farther, ${skipped} skipped — no quote).`
  );
}

function cmdAlertList(opts: AlertListOpts): void {
  const alerts = listAlerts(opts.alertsFile, { all: opts.all });
  if (alerts.length === 0) {
    console.log("No alerts.");
    return;
  }
  for (const a of alerts) {
    if (a.kind === "volume") {
      console.log(`${a.id}  volume   ${a.symbol.padEnd(6)}        status=${a.status} ${formatVolumeCondition(a.volume)}`);
      continue;
    }
    const anchor = a.kind === "static" ? a.level : a.near;
    const trail = a.kind === "trailing" ? `${a.trailValue}${a.trailType === "percent" ? "%" : "$"}` : "-";
    const andVolume = a.volumeCondition ? ` AND ${formatVolumeCondition(a.volumeCondition)}` : "";
    console.log(
      `${a.id}  ${a.kind.padEnd(8)} ${a.symbol.padEnd(6)} ${a.side.padEnd(5)} ` +
        `anchor=${anchor} trail=${trail} status=${a.status} trigger=${effectiveTrigger(a)}${andVolume}`
    );
  }
}

function cmdAlertRemove(id: string, opts: AlertCommonOpts): void {
  const removed = removeAlert(opts.alertsFile, id);
  console.log(removed ? `Removed alert ${id}.` : `No alert with id ${id}.`);
}

async function cmdAlertCheck(opts: AlertCommonOpts): Promise<void> {
  const alerts = loadAlerts(opts.alertsFile);
  const market = buildMarketData(opts);
  const { checked, triggered } = await checkAlerts(alerts, market, [new ConsoleNotifier()]);
  saveAlerts(opts.alertsFile, alerts);
  console.log(`Checked ${checked} alert(s), ${triggered.length} triggered.`);
  if (triggered.length > 0) {
    const outPath = defaultAlertTriggerReportPath(new Date());
    writeAlertTriggerReport(triggered, outPath);
    console.log(`Wrote ${triggered.length} triggered alert(s) to ${outPath}`);
  }
}

function buildProgram(): Command {
  const program = new Command("tv-alerts");

  const withCommon = (cmd: Command): Command =>
    cmd
      .option("--app-key <key>", "Schwab App Key (or SCHWAB_APP_KEY in env/.env)")
      .option("--app-secret <secret>", "Schwab App Secret (or SCHWAB_APP_SECRET in env/.env)")
      .option("--token-path <path>", "Where to cache Schwab OAuth tokens", join(homedir(), ".tv_alerts", "schwab_tokens.json"));

  withCommon(program.command("schwab-login"))
    .description("One-time interactive Schwab OAuth login")
    .action((opts: CommonOpts) => cmdSchwabLogin(opts));

  withCommon(program.command("analyze"))
    .description("Confirm breakouts for either a TradingView alerts CSV export or this engine's own triggered alerts")
    .option("--csv <path>", "Path to a TradingView alerts CSV export")
    .option(
      "--from-alerts [path]",
      "Analyze every triggered alert on record in this engine's alerts.json instead of a CSV (default path: alerts.json)"
    )
    .option("--out <path>", "Output CSV path (default: reports/breakout_report_<timestamp>.csv)")
    .option("--symbol <symbol>", "Only analyze this symbol (repeatable)", (val, prev: string[]) => [...prev, val], [] as string[])
    .option("--no-cache", "Disable the on-disk bar cache")
    .option("--cache-dir <path>", "Directory for the on-disk bar cache", ".cache/bars")
    .option("--history-dir <path>", "Directory for per-ticker historical alert/verdict JSON files", "history")
    .option(
      "--config <path>",
      "Per-ticker tuning config (default/overrides/beta-scaling); missing file just uses built-in defaults",
      "analysis.config.json"
    )
    .option("--baseline-days <n>", "Overrides analysis.config.json and beta-scaling for this run", (v) => parseInt(v, 10))
    .option("--volume-ratio-threshold <n>", "Overrides analysis.config.json and beta-scaling for this run", (v) => parseFloat(v))
    .option("--volume-trend-days <n>", "Overrides analysis.config.json and beta-scaling for this run", (v) => parseInt(v, 10))
    .option("--recent-high-lookback-days <n>", "Overrides analysis.config.json and beta-scaling for this run", (v) => parseInt(v, 10))
    .option("--recent-high-tolerance <n>", "Overrides analysis.config.json and beta-scaling for this run", (v) => parseFloat(v))
    .option("--hold-days <n>", "Overrides analysis.config.json and beta-scaling for this run", (v) => parseInt(v, 10))
    .action((opts: AnalyzeOpts) => cmdAnalyze(opts));

  const alertCmd = program.command("alert").description("Manage static/trailing price alerts");
  const withAlertCommon = (cmd: Command): Command =>
    withCommon(cmd).option("--alerts-file <path>", "Path to the alerts JSON store", "alerts.json");

  withAlertCommon(alertCmd.command("add"))
    .description(
      "Add a static (--level), trailing (--near), or standalone volume (--volume-at-least alone) alert; " +
        "side is inferred vs. the live price"
    )
    .requiredOption("--symbol <symbol>", "Ticker symbol")
    .option("--level <price>", "Static alert: fire once when price crosses this level")
    .option("--near <price>", "Trailing alert: reference price used to seed the watermark and infer side")
    .option("--trail-percent <n>", "Trailing alert: trail distance as a percent")
    .option("--trail-amount <n>", "Trailing alert: trail distance as a dollar amount")
    .option(
      "--volume-at-least <n>",
      "Volume threshold; standalone if --level/--near are omitted, otherwise ANDed onto that alert"
    )
    .option(
      "--volume-period <Nunit>",
      "Look at volume over a trailing window instead of the default 'so far today' (e.g. 30m, 2h, 1d, 45s)"
    )
    .action((opts: AlertAddOpts) => cmdAlertAdd(opts));

  withAlertCommon(alertCmd.command("import"))
    .description("Bootstrap alerts from a TradingView triggered-alerts CSV export (one-time migration helper)")
    .requiredOption("--csv <path>", "Path to the TradingView alerts CSV export")
    .option("--symbol <symbol>", "Only import this symbol (repeatable)", (val, prev: string[]) => [...prev, val], [] as string[])
    .option("--as-trailing", "Import as trailing alerts instead of static level alerts")
    .option("--trail-percent <n>", "Trail distance as a percent (only with --as-trailing)")
    .option("--trail-amount <n>", "Trail distance as a dollar amount (only with --as-trailing)")
    .action((opts: AlertImportOpts) => cmdAlertImport(opts));

  withAlertCommon(alertCmd.command("list"))
    .description("List alerts (armed only by default)")
    .option("--all", "Include triggered/cancelled alerts")
    .action((opts: AlertListOpts) => cmdAlertList(opts));

  withAlertCommon(alertCmd.command("remove <id>"))
    .description("Remove an alert by id")
    .action((id: string, opts: AlertCommonOpts) => cmdAlertRemove(id, opts));

  withAlertCommon(alertCmd.command("check"))
    .description("Check all armed alerts against live Schwab quotes (run this from cron every ~15 min)")
    .action((opts: AlertCommonOpts) => cmdAlertCheck(opts));

  return program;
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  buildProgram().parseAsync(process.argv);
}
