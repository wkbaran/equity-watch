#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { stringify } from "csv-stringify/sync";
import { analyzeAlert, AnalysisParams, DEFAULT_ANALYSIS_PARAMS } from "./analysis.js";
import type { Alert, BreakoutVerdict } from "./models.js";
import { parseAlerts } from "./parse.js";
import { CachingProvider } from "./providers/cache.js";
import { SchwabAuth, SchwabProvider } from "./providers/schwab.js";
import type { PriceDataProvider } from "./providers/types.js";

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

function buildSchwabProvider(opts: CommonOpts & { noCache?: boolean; cacheDir: string }): PriceDataProvider {
  const appKey = opts.appKey ?? process.env.SCHWAB_APP_KEY;
  const appSecret = opts.appSecret ?? process.env.SCHWAB_APP_SECRET;
  if (!appKey || !appSecret) {
    console.error(
      "Missing Schwab credentials. Set SCHWAB_APP_KEY / SCHWAB_APP_SECRET env vars " +
        "or pass --app-key/--app-secret. See SETUP.md."
    );
    process.exit(1);
  }
  const auth = new SchwabAuth(appKey, appSecret, opts.tokenPath);
  const provider = new SchwabProvider(auth);
  if (opts.noCache) {
    return provider;
  }
  return new CachingProvider(provider, opts.cacheDir);
}

async function cmdSchwabLogin(opts: CommonOpts): Promise<void> {
  const appKey = opts.appKey ?? process.env.SCHWAB_APP_KEY;
  const appSecret = opts.appSecret ?? process.env.SCHWAB_APP_SECRET;
  if (!appKey || !appSecret) {
    console.error("Missing Schwab credentials. Set SCHWAB_APP_KEY / SCHWAB_APP_SECRET env vars or pass --app-key/--app-secret.");
    process.exit(1);
  }
  const auth = new SchwabAuth(appKey, appSecret, opts.tokenPath);
  await auth.authorizeInteractive();
  console.log(`Saved Schwab tokens to ${opts.tokenPath}`);
}

interface AnalyzeOpts extends CommonOpts {
  csv: string;
  out: string;
  symbol?: string[];
  noCache?: boolean;
  cacheDir: string;
  baselineDays: number;
  volumeRatioThreshold: number;
  volumeTrendDays: number;
  recentHighLookbackDays: number;
  recentHighTolerance: number;
  holdDays: number;
}

export async function runAnalyze(opts: AnalyzeOpts, provider: PriceDataProvider): Promise<BreakoutVerdict[]> {
  let alerts = parseAlerts(opts.csv);
  if (opts.symbol && opts.symbol.length > 0) {
    const wanted = new Set(opts.symbol.map((s) => s.toUpperCase()));
    alerts = alerts.filter((a) => wanted.has(a.symbol.toUpperCase()));
  }
  if (alerts.length === 0) {
    throw new Error("No alerts matched (check --csv path / --symbol filters).");
  }

  const params: AnalysisParams = {
    baselineDays: opts.baselineDays,
    volumeRatioThreshold: opts.volumeRatioThreshold,
    volumeTrendDays: opts.volumeTrendDays,
    recentHighLookbackDays: opts.recentHighLookbackDays,
    recentHighTolerance: opts.recentHighTolerance,
    holdDays: opts.holdDays,
    minBaselineBars: DEFAULT_ANALYSIS_PARAMS.minBaselineBars,
  };

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
  const provider = buildSchwabProvider(opts);
  const verdicts = await runAnalyze(opts, provider);
  writeReport(verdicts, opts.out);
  printSummary(verdicts, opts.out);
}

function buildProgram(): Command {
  const program = new Command("tv-alerts");

  const withCommon = (cmd: Command): Command =>
    cmd
      .option("--app-key <key>", "Schwab App Key (or SCHWAB_APP_KEY env var)")
      .option("--app-secret <secret>", "Schwab App Secret (or SCHWAB_APP_SECRET env var)")
      .option("--token-path <path>", "Where to cache Schwab OAuth tokens", join(homedir(), ".tv_alerts", "schwab_tokens.json"));

  withCommon(program.command("schwab-login"))
    .description("One-time interactive Schwab OAuth login")
    .action((opts: CommonOpts) => cmdSchwabLogin(opts));

  withCommon(program.command("analyze"))
    .description("Analyze an alert CSV for confirmed breakouts")
    .requiredOption("--csv <path>", "Path to the TradingView alerts CSV export")
    .option("--out <path>", "Output CSV path", "breakout_report.csv")
    .option("--symbol <symbol>", "Only analyze this symbol (repeatable)", (val, prev: string[]) => [...prev, val], [] as string[])
    .option("--no-cache", "Disable the on-disk bar cache")
    .option("--cache-dir <path>", "Directory for the on-disk bar cache", ".cache/bars")
    .option("--baseline-days <n>", "", (v) => parseInt(v, 10), 20)
    .option("--volume-ratio-threshold <n>", "", (v) => parseFloat(v), 1.5)
    .option("--volume-trend-days <n>", "", (v) => parseInt(v, 10), 3)
    .option("--recent-high-lookback-days <n>", "", (v) => parseInt(v, 10), 60)
    .option("--recent-high-tolerance <n>", "", (v) => parseFloat(v), 0.02)
    .option("--hold-days <n>", "", (v) => parseInt(v, 10), 2)
    .action((opts: AnalyzeOpts) => cmdAnalyze(opts));

  return program;
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  buildProgram().parseAsync(process.argv);
}
