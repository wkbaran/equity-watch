#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { stringify } from "csv-stringify/sync";
import { analyzeAlert, AnalysisParams } from "./analysis.js";
import { revisitsToBreakoutAlerts } from "./alerts/bridge.js";
import { suggestLevel } from "./alerts/relevel.js";
import { buildSeedPlan, closeOnOrAfter, resolveLevel } from "./alerts/seed.js";
import {
  addAlert,
  checkAlerts,
  type AddAlertInput,
  type BaselineResolver,
  type MarketData,
  type WatchOrigin,
} from "./alerts/engine.js";
import { baselineKey, computeBaseline } from "./alerts/volumeBaseline.js";
import { effectiveTrigger, type MaAlert, type MaApproach, type VolumeCondition, type VolumePeriodUnit } from "./alerts/models.js";
import { DEFAULT_TOUCH_MARGIN_PCT, describeMaAlert, type DailyHistoryResolver } from "./alerts/maEngine.js";
import { describeVolumeCondition } from "./alerts/describe.js";
import { parseMaSpec, type MaSpec } from "./indicators/movingAverage.js";
import { ConsoleNotifier } from "./alerts/notify.js";
import { writeAlertTriggerReport } from "./alerts/report.js";
import {
  DEFAULT_REVISIT_WEIGHTS,
  daysBetween,
  explainPriority,
  scoreRevisit,
  type RevisitEntry,
} from "./alerts/revisit.js";
import {
  appendRevisits,
  listRevisits,
  loadRevisits,
  resolveRevisit,
  saveRevisits,
  sortByPriority,
} from "./alerts/revisitStore.js";
import { listAlerts, loadAlerts, removeAlert, saveAlerts } from "./alerts/store.js";
import { addLot, addStop, checkHoldings } from "./holdings/engine.js";
import { coverLevel } from "./holdings/cover.js";
import { computeBasis } from "./holdings/models.js";
import { ConsoleHoldingsNotifier } from "./holdings/notify.js";
import { writeHoldingsAlertReport } from "./holdings/report.js";
import {
  mergeImportPlans,
  parseWebullHoldings,
  type HoldingsImportPlan,
} from "./holdings/import.js";
import { loadHoldingsStore, removeStop, saveHoldingsStore } from "./holdings/store.js";
import { buildDashboard, renderDashboard } from "./dashboard.js";
import { publishSite } from "./web/publish.js";
import { buildAlertRows } from "./web/alertsPage.js";
import { shouldPublish, siteDocument, siteFingerprint, writeSite, type PublishState } from "./web/site.js";
import {
  EXTENDED_SESSIONS,
  REGULAR_SESSIONS,
  describeSession,
  isPollable,
  marketDate,
  msUntilNextSession,
  reviveMarketHours,
  sessionAt,
  type MarketHours,
  type Session,
} from "./marketHours.js";
import { updateHistory } from "./history.js";
import type { Alert, BreakoutVerdict, PriceBar } from "./models.js";
import { parseAlerts } from "./parse.js";
import { CachingProvider } from "./providers/cache.js";
import { FMP_FREE_DAILY_LIMIT, FmpProvider } from "./providers/fmp.js";
import { DEFAULT_MAX_REQUESTS_PER_MINUTE, SchwabAuth, SchwabProvider, type Quote } from "./providers/schwab.js";
import type { PriceDataProvider } from "./providers/types.js";
import { DailyBudget } from "./profiles/budget.js";
import { loadCachedProfile, listCachedProfiles, saveCachedProfile } from "./profiles/store.js";
import { gatherKnownSymbols } from "./profiles/universe.js";
import { ignoredSymbols, isIgnored, loadTuningConfig, resolveParamsForSymbol, type TuningConfig } from "./tuning.js";

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

const VOLUME_BASELINE_CACHE_DIR = join(".cache", "volume-baseline");

/**
 * Typical-volume lookups, cached per symbol+window and keyed to the market
 * date. Checks run every few minutes; recomputing would mean a bar fetch per
 * volume alert per poll, while the answer only meaningfully changes once a
 * day. A cached zero is not stored - it usually means a failed fetch rather
 * than a symbol that genuinely doesn't trade.
 */
function buildBaselineResolver(market: MarketData, now: Date = new Date()): BaselineResolver {
  const today = marketDate(now);
  const memo = new Map<string, number | null>();

  return async (symbol, condition) => {
    const key = baselineKey(symbol, condition);
    if (memo.has(key)) {
      return memo.get(key)!;
    }
    const file = join(VOLUME_BASELINE_CACHE_DIR, `${key}.json`);
    if (existsSync(file)) {
      const cached = JSON.parse(readFileSync(file, "utf-8")) as { baseline: number; date: string };
      if (cached.date === today && cached.baseline > 0) {
        memo.set(key, cached.baseline);
        return cached.baseline;
      }
    }
    try {
      const baseline = await computeBaseline(symbol, condition, market, now);
      if (baseline > 0) {
        mkdirSync(VOLUME_BASELINE_CACHE_DIR, { recursive: true });
        writeFileSync(file, JSON.stringify({ baseline, date: today, computedAt: now.toISOString() }));
      }
      memo.set(key, baseline > 0 ? baseline : null);
      return memo.get(key)!;
    } catch (err) {
      console.error(`  ! ${symbol}: volume baseline unavailable (${err})`);
      memo.set(key, null);
      return null;
    }
  };
}

const MA_DAILY_CACHE_DIR = join(".cache", "ma-daily");

/**
 * Daily history for 1D/1W moving averages, cached per symbol+lookback and
 * keyed to the market date. The averages only use completed bars, so what
 * they need changes once a day; refetching up to 15 years of dailies every
 * poll would be pure waste.
 */
function buildDailyHistoryResolver(market: MarketData, now: Date = new Date()): DailyHistoryResolver {
  const today = marketDate(now);
  return async (symbol, lookbackDays) => {
    const file = join(MA_DAILY_CACHE_DIR, `${symbol.replace(/[^A-Za-z0-9_-]/g, "_")}_${lookbackDays}.json`);
    if (existsSync(file)) {
      const cached = JSON.parse(readFileSync(file, "utf-8")) as {
        date: string;
        bars: (Omit<PriceBar, "date"> & { date: string })[];
      };
      if (cached.date === today) {
        return cached.bars.map((b) => ({ ...b, date: new Date(b.date) }));
      }
    }
    const bars = await market.getDailyBars(symbol, new Date(now.getTime() - lookbackDays * 86_400_000), now);
    if (bars.length > 0) {
      mkdirSync(MA_DAILY_CACHE_DIR, { recursive: true });
      writeFileSync(file, JSON.stringify({ date: today, bars: bars.map((b) => ({ ...b, date: b.date.toISOString() })) }));
    }
    return bars;
  };
}

const HOURS_CACHE_DIR = join(".cache", "hours");

/**
 * Market hours for a past or present date never change once published, so
 * they cache to disk permanently. This keeps a 15-minute poller from spending
 * a request per check just to ask whether the market is open.
 */
async function getMarketHoursCached(opts: CommonOpts, date: string): Promise<MarketHours> {
  const file = join(HOURS_CACHE_DIR, `${date}.json`);
  if (existsSync(file)) {
    const revived = reviveMarketHours(JSON.parse(readFileSync(file, "utf-8")));
    if (revived !== null) {
      return revived;
    }
  }
  const appKey = opts.appKey ?? process.env.SCHWAB_APP_KEY;
  const appSecret = opts.appSecret ?? process.env.SCHWAB_APP_SECRET;
  if (!appKey || !appSecret) {
    throw new Error("Missing Schwab credentials.");
  }
  const auth = new SchwabAuth(appKey, appSecret, opts.tokenPath);
  const provider = new SchwabProvider(auth, resolveMaxRequestsPerMinute());
  const hours = await provider.getMarketHours(date);
  mkdirSync(HOURS_CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(hours));
  return hours;
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
  let alerts: Alert[] = opts.fromAlerts
    ? revisitsToBreakoutAlerts(listRevisits(opts.fromAlerts === true ? "revisits.json" : opts.fromAlerts, { status: "all" }))
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

function defaultHoldingsAlertReportPath(now: Date): string {
  return join("reports", `holdings_alerts_${timestampSuffix(now)}.csv`);
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
    console.error("Specify --csv <path> (TradingView export) or --from-alerts [path] (this engine's revisits.json).");
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
  revisitsFile: string;
}

interface AlertAddOpts extends AlertCommonOpts {
  symbol: string;
  level?: string;
  near?: string;
  trailPercent?: string;
  trailAmount?: string;
  volumeAtLeast?: string;
  volumeRatio?: string;
  volumePeriod?: string;
  ma?: string;
  touch?: string | boolean;
  direction?: string;
  from?: string;
}

function formatVolumeCondition(v: VolumeCondition): string {
  return describeVolumeCondition(v);
}

/** Builds the optional VolumeCondition shared by static/trailing/volume alert creation. Exits on bad input. */
function parseVolumeFlags(opts: {
  volumeAtLeast?: string;
  volumeRatio?: string;
  volumePeriod?: string;
}): VolumeCondition | undefined {
  if (opts.volumeAtLeast !== undefined && opts.volumeRatio !== undefined) {
    console.error("Specify --volume-at-least (absolute shares) or --volume-ratio (multiple of normal), not both.");
    process.exit(1);
  }
  if (opts.volumeRatio !== undefined) {
    const ratio = parseFloat(opts.volumeRatio);
    if (!Number.isFinite(ratio) || ratio <= 0) {
      console.error(`Invalid --volume-ratio "${opts.volumeRatio}" — expected a positive multiple, e.g. 1.5.`);
      process.exit(1);
    }
    const period = opts.volumePeriod === undefined ? undefined : parseVolumePeriod(opts.volumePeriod);
    return period === undefined ? { ratio, mode: "today" } : { ratio, mode: "period", ...period };
  }
  if (opts.volumeAtLeast === undefined) {
    if (opts.volumePeriod !== undefined) {
      console.error("--volume-period requires --volume-at-least or --volume-ratio.");
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

async function cmdAlertAddMa(opts: AlertAddOpts): Promise<void> {
  const conflicting = [opts.level, opts.near, opts.trailPercent, opts.trailAmount, opts.volumeAtLeast, opts.volumeRatio, opts.volumePeriod];
  if (conflicting.some((v) => v !== undefined)) {
    console.error("--ma can't be combined with --level, --near, --trail-*, or --volume-* (no volume condition on moving averages yet).");
    process.exit(1);
  }

  let spec: MaSpec;
  try {
    spec = parseMaSpec(opts.ma!);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const isTouch = opts.touch !== undefined;
  let marginPct = DEFAULT_TOUCH_MARGIN_PCT;
  if (typeof opts.touch === "string") {
    marginPct = parseFloat(opts.touch);
    if (!Number.isFinite(marginPct) || marginPct <= 0 || marginPct > 10) {
      console.error(`Invalid --touch margin "${opts.touch}" — expected a percent between 0 and 10, e.g. 0.25.`);
      process.exit(1);
    }
  }

  let from: MaApproach = "either";
  if (opts.direction !== undefined) {
    if (isTouch) {
      console.error("--direction applies to crosses. For a touch, use --from above|below.");
      process.exit(1);
    }
    if (opts.direction !== "up" && opts.direction !== "down") {
      console.error(`Invalid --direction "${opts.direction}" — expected up or down.`);
      process.exit(1);
    }
    from = opts.direction === "up" ? "below" : "above";
  }
  if (opts.from !== undefined) {
    if (!isTouch) {
      console.error("--from applies to touches (--touch). For a cross, use --direction up|down.");
      process.exit(1);
    }
    if (opts.from !== "above" && opts.from !== "below") {
      console.error(`Invalid --from "${opts.from}" — expected above or below.`);
      process.exit(1);
    }
    from = opts.from;
  }

  const market = buildMarketData(opts);
  const result = await addAlert(
    opts.alertsFile,
    { kind: "ma", symbol: opts.symbol, ...spec, trigger: isTouch ? "touch" : "cross", from, marginPct },
    market
  );
  if (result.rejectedReason) {
    console.log(`Not added: ${result.rejectedReason}`);
    return;
  }
  const a = result.added as MaAlert;
  console.log(
    `Added ma alert ${a.id} (${a.symbol}, ${describeMaAlert(a)}). ` +
      `The next check records where price sits; it can fire from the check after that.`
  );
}

async function cmdAlertAdd(opts: AlertAddOpts): Promise<void> {
  if (opts.ma !== undefined) {
    return cmdAlertAddMa(opts);
  }
  const hasLevel = opts.level !== undefined;
  const hasNear = opts.near !== undefined;
  if (hasLevel && hasNear) {
    console.error("Specify at most one of --level (static alert) or --near (trailing alert).");
    process.exit(1);
  }
  // Parse the volume flags first: they decide whether a bare `alert add` is a
  // standalone volume alert, and they own their own validation messages.
  const volume = parseVolumeFlags(opts);
  if (!hasLevel && !hasNear && volume === undefined) {
    console.error("Specify --level, --near, or --volume-at-least/--volume-ratio (a standalone volume alert).");
    process.exit(1);
  }

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
  if (a.kind === "ma") {
    console.log(`Added ma alert ${a.id} (${a.symbol}, ${describeMaAlert(a)}).`);
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

interface AlertSeedOpts extends AlertCommonOpts {
  list: string;
  log?: string;
  cacheDir: string;
  noCache?: boolean;
  config: string;
  dryRun?: boolean;
  symbol?: string[];
}

/**
 * Backdates a seeded alert to when the ticker was really first watched.
 *
 * TradingView's exports carry no creation date, so the oldest trigger on
 * record is the best available lower bound - marked approximate so the
 * narrative says "at least since July" rather than asserting a start date it
 * doesn't have. The price at that date comes out of the bars already fetched
 * for re-levelling; when the date predates that window the price is left null
 * and the narrative simply omits the percentage.
 */
function watchOriginFor(
  candidate: { firstSeenAt: string | null },
  bars: { date: Date; close: number }[]
): { watching?: WatchOrigin } {
  if (candidate.firstSeenAt === null) {
    return {};
  }
  return {
    watching: {
      since: candidate.firstSeenAt,
      approximate: true,
      priceAtStart: closeOnOrAfter(bars, candidate.firstSeenAt),
    },
  };
}

/**
 * One-time migration of the TradingView exports into this engine's store.
 *
 * Every candidate's level is re-derived against real bars: a level price has
 * already run past is replaced with the current resistance, while a level
 * still ahead of price is kept as-is (it is a perfectly good target and
 * re-deriving would throw it away).
 */
async function cmdAlertSeed(opts: AlertSeedOpts): Promise<void> {
  const plan = buildSeedPlan(opts.list, opts.log ?? null);
  let candidates = plan.candidates;
  if (opts.symbol && opts.symbol.length > 0) {
    const wanted = new Set(opts.symbol.map((s) => s.toUpperCase()));
    candidates = candidates.filter((c) => wanted.has(c.symbol));
  }

  console.log(
    `Read ${plan.rowsRead.list} configured alert(s) and ${plan.rowsRead.log} log event(s) ` +
      `→ ${candidates.length} candidate(s), ${plan.skipped.length} skipped.`
  );

  const provider = buildSchwabProvider(opts);
  const getBeta = buildBetaFetcher(opts);
  const rawConfig = loadTuningConfig(opts.config);
  const config: TuningConfig = rawConfig ?? {};
  const hasConfigFile = rawConfig !== null;
  const ignored = ignoredSymbols(rawConfig);

  // addAlert fetches a quote per call to infer the alert's side. Seeding
  // hundreds of symbols one at a time would be hundreds of separate requests;
  // Schwab takes them all in one, so prefetch and serve addAlert from that.
  const rawMarket = buildMarketData(opts);
  const seedSymbols = [...new Set(candidates.map((c) => c.symbol))];
  const prefetched = opts.dryRun ? new Map<string, Quote>() : await rawMarket.getQuotes(seedSymbols);
  const market: MarketData = {
    ...rawMarket,
    getQuotes: async (syms) => {
      const result = new Map<string, Quote>();
      for (const sym of syms) {
        const quote = prefetched.get(sym);
        if (quote !== undefined) result.set(sym, quote);
      }
      return result;
    },
  };

  let created = 0;
  let relevelled = 0;
  let kept = 0;
  let dropped = 0;
  let failed = 0;

  let skippedIgnored = 0;
  for (const candidate of candidates) {
    if (isIgnored(candidate.symbol, ignored)) {
      skippedIgnored++;
      continue;
    }
    const params = await resolveParamsForSymbol(candidate.symbol, config, hasConfigFile, getBeta);

    // Volume-only candidate: nothing to re-level, no bars needed.
    if (candidate.levelsSeen.length === 0 && candidate.volume !== null) {
      if (opts.dryRun) {
        console.log(`  ${candidate.symbol.padEnd(6)} volume-only  ${JSON.stringify(candidate.volume)}`);
      } else {
        await addAlert(
          opts.alertsFile,
          {
            kind: "volume",
            symbol: candidate.symbol,
            volume: candidate.volume,
            ...watchOriginFor(candidate, []),
          },
          market
        );
      }
      created++;
      continue;
    }

    const end = new Date();
    const start = new Date(end.getTime() - (params.recentHighLookbackDays + params.baselineDays + 30) * 86_400_000);
    let bars;
    try {
      bars = await provider.getDailyBars(candidate.symbol, start, end);
    } catch (err) {
      console.error(`  ! ${candidate.symbol}: failed to fetch price history (${err})`);
      failed++;
      continue;
    }
    if (bars.length === 0) {
      console.error(`  ! ${candidate.symbol}: no bars returned`);
      failed++;
      continue;
    }

    const lastClose = bars[bars.length - 1].close;
    const { level: baseLevel, discarded } = resolveLevel(candidate, lastClose);
    if (discarded.length > 0) {
      console.log(
        `  ~ ${candidate.symbol}: dropped level(s) ${discarded.join(", ")} as a different instrument ` +
          `on the same ticker (price is ${lastClose}).`
      );
    }
    if (baseLevel === null) {
      // Every price level belonged to another instrument. If the ticker also
      // carried a volume alert, that part is still perfectly good on its own -
      // don't throw it away along with the bad levels.
      if (candidate.volume !== null) {
        console.log(
          `  - ${candidate.symbol}: no plausible price level against a price of ${lastClose}; ` +
            `seeding the volume alert alone.`
        );
        if (!opts.dryRun) {
          await addAlert(opts.alertsFile, { kind: "volume", symbol: candidate.symbol, volume: candidate.volume }, market);
        }
        created++;
      } else {
        console.log(`  - ${candidate.symbol}: no plausible level against a price of ${lastClose}; skipped.`);
      }
      dropped++;
      continue;
    }

    // suggestLevel is resistance-oriented: it proposes the level price would
    // have to break *up* through. Applying it to a stated downside alert would
    // invert the alert's meaning - CHEF's "Crossing Down 91.00" would become a
    // breakout target at the 60d high. A support level that price has since
    // risen above is still exactly the level you want to be warned about, so
    // downside candidates keep theirs.
    const suggestion = candidate.side === "below" ? null : suggestLevel(bars, baseLevel, params);
    const level = suggestion?.suggestedLevel ?? baseLevel;
    if (suggestion?.suggestedLevel != null) {
      relevelled++;
    } else {
      kept++;
    }

    if (opts.dryRun) {
      const note =
        suggestion === null
          ? `${level}  (unchanged — downside alert, level kept as support)`
          : suggestion.suggestedLevel !== null
            ? `${baseLevel} → ${level}  (${suggestion.basis})`
            : `${level}  (unchanged — ${suggestion.basis})`;
      const vol = candidate.volume ? ` AND ${formatVolumeCondition(candidate.volume)}` : "";
      console.log(`  ${candidate.symbol.padEnd(6)} ${note}${vol}`);
      created++;
      continue;
    }

    const result = await addAlert(
      opts.alertsFile,
      {
        kind: "static",
        symbol: candidate.symbol,
        level,
        ...(candidate.volume ? { volume: candidate.volume } : {}),
        ...watchOriginFor(candidate, bars),
      },
      market
    );
    if (result.rejectedReason) {
      console.error(`  ! ${candidate.symbol}: ${result.rejectedReason}`);
      failed++;
      continue;
    }
    created++;
  }

  console.log(
    `\n${opts.dryRun ? "Would create" : "Created"} ${created} alert(s): ` +
      `${relevelled} re-levelled to current resistance, ${kept} kept at their TradingView level` +
      (dropped > 0 ? `, ${dropped} dropped (implausible level)` : "") +
      (failed > 0 ? `, ${failed} failed` : "") +
      (skippedIgnored > 0 ? `, ${skippedIgnored} on the ignore list` : "") +
      "."
  );
  if (plan.skipped.length > 0) {
    const byReason = new Map<string, number>();
    for (const s of plan.skipped) {
      byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    }
    console.log("\nNot seeded:");
    for (const [reason, count] of byReason) {
      console.log(`  ${String(count).padStart(3)}  ${reason}`);
    }
  }
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
    if (a.kind === "ma") {
      const side = a.lastSide ?? "-";
      console.log(
        `${a.id}  ma       ${a.symbol.padEnd(6)} ${side.padEnd(5)} ${describeMaAlert(a)} ` +
          `status=${a.status} average=${a.lastLevel ?? "-"}`
      );
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

interface AlertCheckOpts extends AlertCommonOpts {
  regularOnly?: boolean;
  ignoreHours?: boolean;
  cacheDir: string;
  config: string;
}

async function cmdAlertCheck(opts: AlertCheckOpts): Promise<void> {
  const now = new Date();
  const allowed = opts.regularOnly ? REGULAR_SESSIONS : EXTENDED_SESSIONS;

  // Establish the session before spending any quote requests: outside market
  // hours the quotes are stale and a "trigger" would just be yesterday's close
  // re-crossing a level.
  let session: Session | null = null;
  if (!opts.ignoreHours) {
    try {
      const hours = await getMarketHoursCached(opts, marketDate(now));
      session = sessionAt(hours, now);
      if (!isPollable(session, allowed)) {
        const waitMs = msUntilNextSession(hours, now, allowed);
        const next =
          waitMs === null
            ? "no further session today"
            : `next session opens in ${Math.round(waitMs / 60_000)} min`;
        console.log(`Skipped: ${describeSession(session)} (${next}). No quotes fetched.`);
        return;
      }
    } catch (err) {
      // A hours lookup failure shouldn't take the poller down; fall through
      // and check anyway, but say so rather than silently claiming a session.
      console.error(`  ! market-hours lookup failed (${err}); checking anyway.`);
    }
  }

  const alerts = loadAlerts(opts.alertsFile);
  const ignored = ignoredSymbols(loadTuningConfig(opts.config));
  const market = buildMarketData(opts);
  const { checked, triggered, revisits, warnings } = await checkAlerts(
    alerts,
    market,
    [new ConsoleNotifier()],
    session,
    ignored,
    buildBaselineResolver(market),
    buildDailyHistoryResolver(market)
  );
  for (const warning of warnings) {
    console.error(`  ! ${warning}`);
  }
  saveAlerts(opts.alertsFile, alerts);
  appendRevisits(opts.revisitsFile, revisits);
  console.log(
    `Checked ${checked} alert(s), ${triggered.length} triggered. ` +
      `All ${checked} remain live; ${revisits.length} entry(ies) queued for revisit.`
  );
  if (triggered.length > 0) {
    const outPath = defaultAlertTriggerReportPath(new Date());
    writeAlertTriggerReport(triggered, outPath);
    console.log(`Wrote ${triggered.length} triggered alert(s) to ${outPath}`);
    console.log(`Queue is now ${listRevisits(opts.revisitsFile).length} open — 'alert revisit list' to review.`);
  }
}

interface RevisitListOpts extends AlertCommonOpts {
  status: string;
  limit?: number;
}

function cmdRevisitList(opts: RevisitListOpts): void {
  const status = opts.status === "all" ? "all" : (opts.status as "open" | "applied" | "dismissed");
  const entries = sortByPriority(listRevisits(opts.revisitsFile, { status }));
  if (entries.length === 0) {
    console.log(`No ${opts.status} revisit entries.`);
    return;
  }
  const shown = opts.limit ? entries.slice(0, opts.limit) : entries;
  console.log(`${entries.length} ${opts.status} entry(ies)${shown.length < entries.length ? `, showing ${shown.length}` : ""}:\n`);
  for (const e of shown) {
    const pri = e.priority === null ? "  -  " : e.priority.toFixed(1).padStart(5);
    const level = e.levelAtTrigger === null ? "-" : String(e.levelAtTrigger);
    console.log(`${pri}  ${e.id}  ${e.symbol.padEnd(6)} ${e.kind.padEnd(8)} fired ${level} @ ${e.triggerPrice} on ${e.triggeredAt.slice(0, 10)}`);
    if (e.suggestedLevel !== null) {
      console.log(`         suggested new level: ${e.suggestedLevel}${e.suggestionBasis ? ` (${e.suggestionBasis})` : ""}`);
    }
    if (e.signals !== null) {
      console.log(`         ${explainPriority(e.signals)}`);
    }
  }
  console.log(`\nApply a suggestion with 'alert revisit apply <id>', or drop it with 'alert revisit dismiss <id>'.`);
}

interface RevisitRelevelOpts extends AlertCommonOpts {
  cacheDir: string;
  noCache?: boolean;
  config: string;
  holdingsFile: string;
  symbol?: string[];
}

/**
 * Fills in each open entry's suggested level and priority score. Separate
 * from `alert check` on purpose: checks run every few minutes off live
 * quotes and must stay cheap, while this needs daily bars per symbol and
 * only has anything new to say once a day.
 */
async function cmdRevisitRelevel(opts: RevisitRelevelOpts): Promise<void> {
  let entries = listRevisits(opts.revisitsFile, { status: "open" });
  if (opts.symbol && opts.symbol.length > 0) {
    const wanted = new Set(opts.symbol.map((s) => s.toUpperCase()));
    entries = entries.filter((e) => wanted.has(e.symbol.toUpperCase()));
  }
  if (entries.length === 0) {
    console.log("No open revisit entries to re-level.");
    return;
  }

  const provider = buildSchwabProvider(opts);
  const getBeta = buildBetaFetcher(opts);
  const rawConfig = loadTuningConfig(opts.config);
  const config: TuningConfig = rawConfig ?? {};
  const hasConfigFile = rawConfig !== null;

  const heldSymbols = new Set(loadHoldingsStore(opts.holdingsFile).lots.map((l) => l.symbol.toUpperCase()));
  const now = new Date();

  const bySymbol = new Map<string, RevisitEntry[]>();
  for (const e of entries) {
    bySymbol.set(e.symbol, [...(bySymbol.get(e.symbol) ?? []), e]);
  }

  const all = loadRevisits(opts.revisitsFile);
  let scored = 0;
  let suggested = 0;
  let failed = 0;

  for (const symbol of [...bySymbol.keys()].sort()) {
    const symbolEntries = bySymbol.get(symbol)!;
    const params = await resolveParamsForSymbol(symbol, config, hasConfigFile, getBeta);

    // Volume-only entries carry no level and bridge to nothing, so there is no
    // date range to fetch against - asking anyway yields Math.min() of an
    // empty array (Infinity) and an invalid Date. They are still scored below
    // on staleness and position; they just get no bars and no suggestion.
    const breakoutAlerts = revisitsToBreakoutAlerts(symbolEntries);
    let bars: PriceBar[] = [];
    if (breakoutAlerts.length > 0) {
      const { start, end } = calendarRangeForSymbol(breakoutAlerts, params);
      try {
        bars = await provider.getDailyBars(symbol, start, end);
      } catch (err) {
        console.error(`  ! ${symbol}: failed to fetch price history (${err})`);
        failed += symbolEntries.length;
        continue;
      }
    }

    for (const entry of symbolEntries) {
      const target = all.find((e) => e.id === entry.id)!;
      const levelled = suggestLevel(bars, entry.levelAtTrigger, params);
      // A moving-average alert's level is the average itself. There's nothing
      // to re-level it to, but the move past it still counts toward priority.
      const suggestion =
        entry.kind === "ma"
          ? { ...levelled, suggestedLevel: null, basis: "moving-average alert: its level moves with the average" }
          : levelled;

      // Reuse the full breakout pipeline for the verdict and volume signals
      // rather than recomputing a second, subtly different version here.
      const bridged = revisitsToBreakoutAlerts([entry])[0];
      const verdict = bridged !== undefined && bars.length > 0 ? analyzeAlert(bridged, bars, params) : null;

      const { priority, signals } = scoreRevisit(
        {
          verdict: verdict?.verdict ?? null,
          pctMovePastLevel: suggestion.pctMovePastLevel,
          daysOpen: daysBetween(entry.triggeredAt, now),
          heldPosition: heldSymbols.has(symbol.toUpperCase()),
          volumeRatio: verdict?.volumeRatio ?? null,
          volumeTrendRatio: verdict?.volumeTrendRatio ?? null,
        },
        DEFAULT_REVISIT_WEIGHTS
      );

      target.suggestedLevel = suggestion.suggestedLevel;
      target.suggestionBasis = suggestion.basis;
      target.suggestedAt = now.toISOString();
      target.priority = priority;
      target.signals = signals;
      scored++;
      if (suggestion.suggestedLevel !== null) {
        suggested++;
      }
    }
  }

  saveRevisits(opts.revisitsFile, all);
  console.log(
    `Scored ${scored} open entry(ies); ${suggested} carry a new suggested level` +
      (failed > 0 ? `, ${failed} failed to fetch` : "") + "."
  );
  console.log("'alert revisit list' to review, highest priority first.");
}

function cmdRevisitResolve(id: string, action: "applied" | "dismissed", opts: AlertCommonOpts): void {
  const entries = loadRevisits(opts.revisitsFile);
  const entry = entries.find((e) => e.id === id);
  if (entry === undefined) {
    console.error(`No revisit entry with id ${id}.`);
    process.exit(1);
  }
  if (action === "dismissed") {
    resolveRevisit(opts.revisitsFile, id, "dismissed");
    console.log(`Dismissed revisit ${id} (${entry.symbol}). The alert itself is untouched and still live.`);
    return;
  }

  if (entry.suggestedLevel === null) {
    console.error(
      `Revisit ${id} (${entry.symbol}) has no suggested level yet — run 'alert relevel' first, ` +
        `or set the level yourself with 'alert add --symbol ${entry.symbol} --level <price>'.`
    );
    process.exit(1);
  }

  const alerts = loadAlerts(opts.alertsFile);
  const alert = alerts.find((a) => a.id === entry.alertId);
  if (alert === undefined || alert.kind !== "static") {
    console.error(
      `Revisit ${id} points at ${alert === undefined ? "an alert that no longer exists" : `a ${alert.kind} alert`}; ` +
        `only static alerts carry a level that can be re-pointed.`
    );
    process.exit(1);
  }

  const previous = alert.level;
  alert.level = entry.suggestedLevel;
  // Record the move on the entry itself so the ticker story can say what you
  // did, not just that you did something.
  entry.appliedFrom = previous;
  entry.appliedTo = alert.level;
  saveRevisits(opts.revisitsFile, entries);
  // Re-seed the crossing baseline against the new level so the alert doesn't
  // immediately fire (or immediately go quiet) purely because the level moved.
  alert.lastKnownSide = entry.triggerPrice > alert.level ? "above" : "below";
  alert.mutedUntil = null;
  saveAlerts(opts.alertsFile, alerts);
  resolveRevisit(opts.revisitsFile, id, "applied");
  console.log(`${entry.symbol}: alert ${alert.id} re-levelled ${previous} → ${alert.level}. Revisit ${id} marked applied.`);
}

interface HoldingsCommonOpts extends CommonOpts {
  holdingsFile: string;
}

interface HoldingsAddLotOpts extends HoldingsCommonOpts {
  symbol: string;
  count: string;
  basis: string;
  date?: string;
}

interface HoldingsListOpts extends HoldingsCommonOpts {
  symbol?: string;
}

interface HoldingsStopAddOpts extends HoldingsCommonOpts {
  symbol: string;
  price: string;
  count?: string;
}

function cmdHoldingsAddLot(opts: HoldingsAddLotOpts): void {
  const lot = addLot(opts.holdingsFile, {
    symbol: opts.symbol,
    count: parseFloat(opts.count),
    basisPerShare: parseFloat(opts.basis),
    purchaseDate: opts.date,
  });
  console.log(`Added lot ${lot.id}: ${lot.count} ${lot.symbol} @ ${lot.basisPerShare} on ${lot.purchaseDate}.`);
}

function cmdHoldingsList(opts: HoldingsListOpts): void {
  const store = loadHoldingsStore(opts.holdingsFile);
  const symbols = [...new Set(store.lots.map((l) => l.symbol))]
    .filter((s) => !opts.symbol || s.toUpperCase() === opts.symbol.toUpperCase())
    .sort();
  if (symbols.length === 0) {
    console.log("No holdings.");
    return;
  }
  for (const symbol of symbols) {
    const info = computeBasis(store.lots, symbol)!;
    const stops = store.stops.filter((s) => s.symbol === symbol);
    const stopSummary =
      stops.length === 0 ? "no stops" : stops.map((s) => `$${s.stopPrice}(${s.count ?? info.totalCount})`).join(", ");
    console.log(
      `${symbol.padEnd(6)} count=${info.totalCount} basis=${info.blendedBasis.toFixed(2)} ` +
        `last_purchase=${info.lastPurchaseDate} stops=[${stopSummary}]`
    );
  }
}

function cmdHoldingsStopAdd(opts: HoldingsStopAddOpts): void {
  const stop = addStop(opts.holdingsFile, {
    symbol: opts.symbol,
    stopPrice: parseFloat(opts.price),
    count: opts.count !== undefined ? parseFloat(opts.count) : null,
  });
  console.log(`Added stop ${stop.id}: ${stop.symbol} @ ${stop.stopPrice} (${stop.count ?? "all"} shares).`);
}

function cmdHoldingsStopList(opts: HoldingsListOpts): void {
  const store = loadHoldingsStore(opts.holdingsFile);
  const stops = store.stops.filter((s) => !opts.symbol || s.symbol.toUpperCase() === opts.symbol.toUpperCase());
  if (stops.length === 0) {
    console.log("No stops.");
    return;
  }
  for (const s of stops) {
    console.log(`${s.id}  ${s.symbol.padEnd(6)} stop=${s.stopPrice} count=${s.count ?? "all"}`);
  }
}

function cmdHoldingsStopRemove(id: string, opts: HoldingsCommonOpts): void {
  const removed = removeStop(opts.holdingsFile, id);
  console.log(removed ? `Removed stop ${id}.` : `No stop with id ${id}.`);
}

async function cmdHoldingsCheck(opts: HoldingsCommonOpts & { config: string }): Promise<void> {
  const store = loadHoldingsStore(opts.holdingsFile);
  const market = buildMarketData(opts);
  const ignored = ignoredSymbols(loadTuningConfig(opts.config));
  const { checked, triggered, ignored: skipped } = await checkHoldings(
    store,
    market,
    [new ConsoleHoldingsNotifier()],
    new Date(),
    ignored
  );
  saveHoldingsStore(opts.holdingsFile, store);
  console.log(
    `Checked ${checked} holding(s), ${triggered.length} triggered` +
      (skipped > 0 ? ` (${skipped} on the ignore list)` : "") +
      "."
  );
  if (triggered.length > 0) {
    const outPath = defaultHoldingsAlertReportPath(new Date());
    writeHoldingsAlertReport(triggered, outPath);
    console.log(`Wrote ${triggered.length} holdings alert(s) to ${outPath}`);
  }
}

interface ProfileCommonOpts {
  fmpApiKey?: string;
  cacheDir: string;
}

function buildFmpProvider(opts: ProfileCommonOpts): FmpProvider {
  const apiKey = opts.fmpApiKey ?? process.env.FMP_API_KEY;
  if (!apiKey) {
    console.error("Missing FMP API key. Set FMP_API_KEY in a .env file (or env var) or pass --fmp-api-key.");
    process.exit(1);
  }
  return new FmpProvider(apiKey);
}

interface ProfileFetchOpts extends ProfileCommonOpts {
  symbol?: string[];
  csv?: string[];
  allKnown?: boolean;
  refresh?: boolean;
  historyDir: string;
  holdingsFile: string;
  alertsFile: string;
}

async function cmdProfileFetch(opts: ProfileFetchOpts): Promise<void> {
  const symbols = new Set<string>((opts.symbol ?? []).map((s) => s.toUpperCase()));
  for (const csvPath of opts.csv ?? []) {
    for (const alert of parseAlerts(csvPath)) {
      symbols.add(alert.symbol);
    }
  }
  if (opts.allKnown) {
    for (const s of gatherKnownSymbols({ historyDir: opts.historyDir, holdingsFile: opts.holdingsFile, alertsFile: opts.alertsFile })) {
      symbols.add(s);
    }
  }
  if (symbols.size === 0) {
    console.error("Specify --symbol, --csv, and/or --all-known.");
    process.exit(1);
  }

  const provider = buildFmpProvider(opts);
  const budget = new DailyBudget(join(opts.cacheDir, "_budget.json"), FMP_FREE_DAILY_LIMIT);

  let fetched = 0;
  let skipped = 0;
  let budgetExhausted = 0;
  let failed = 0;
  for (const symbol of [...symbols].sort()) {
    if (!opts.refresh && loadCachedProfile(opts.cacheDir, symbol) !== null) {
      skipped++;
      continue;
    }
    if (!budget.consume()) {
      budgetExhausted++;
      continue;
    }
    try {
      const profile = await provider.getProfile(symbol);
      if (profile) {
        saveCachedProfile(opts.cacheDir, profile);
        fetched++;
        console.log(`  ${symbol}: ${profile.sector ?? "?"} / ${profile.industry ?? "?"}`);
      } else {
        failed++;
        console.log(`  ! ${symbol}: no profile data returned`);
      }
    } catch (err) {
      failed++;
      console.error(`  ! ${symbol}: ${err}`);
    }
  }

  console.log(
    `Fetched ${fetched}, skipped ${skipped} (already cached), ${failed} failed` +
      (budgetExhausted > 0 ? `, ${budgetExhausted} skipped (today's FMP budget exhausted - rerun tomorrow)` : "") +
      "."
  );
}

interface ProfileListOpts extends ProfileCommonOpts {
  sector?: string;
}

function cmdProfileList(opts: ProfileListOpts): void {
  let profiles = listCachedProfiles(opts.cacheDir);
  if (opts.sector) {
    profiles = profiles.filter((p) => (p.sector ?? "").toLowerCase() === opts.sector!.toLowerCase());
  }
  if (profiles.length === 0) {
    console.log("No cached profiles.");
    return;
  }
  profiles.sort((a, b) => (a.sector ?? "").localeCompare(b.sector ?? "") || a.symbol.localeCompare(b.symbol));
  for (const p of profiles) {
    console.log(`${(p.sector ?? "-").padEnd(24)} ${(p.industry ?? "-").padEnd(28)} ${p.symbol}`);
  }
}

interface ProfileShowOpts extends ProfileCommonOpts {
  symbol: string;
}

function cmdProfileShow(opts: ProfileShowOpts): void {
  const profile = loadCachedProfile(opts.cacheDir, opts.symbol.toUpperCase());
  if (!profile) {
    console.log(`No cached profile for ${opts.symbol}.`);
    return;
  }
  console.log(`${profile.symbol} - ${profile.companyName ?? "?"}`);
  console.log(`Sector:   ${profile.sector ?? "-"}`);
  console.log(`Industry: ${profile.industry ?? "-"}`);
  console.log(`\n${profile.description ?? "(no description)"}`);
}

interface HoldingsCoverOpts extends CommonOpts {
  holdingsFile: string;
  alertsFile: string;
  config: string;
  dryRun?: boolean;
}

/**
 * Creates a starting alert for every held position that has none, at 10%
 * above basis or just clear of the current price, whichever is higher.
 */
async function cmdHoldingsCover(opts: HoldingsCoverOpts): Promise<void> {
  const store = loadHoldingsStore(opts.holdingsFile);
  // No beta lookup needed: the level is a flat 10% off whichever reference is
  // higher, so nothing here is volatility-scaled.
  const ignored = ignoredSymbols(loadTuningConfig(opts.config));

  const covered = new Set(
    loadAlerts(opts.alertsFile)
      .filter((a) => a.status === "live")
      .map((a) => a.symbol.toUpperCase())
  );

  const held = [...new Set(store.lots.map((l) => l.symbol))].sort();
  const candidates = held.filter((s) => !covered.has(s.toUpperCase()) && !isIgnored(s, ignored));
  const skippedIgnored = held.filter((s) => isIgnored(s, ignored));

  if (candidates.length === 0) {
    console.log(
      `All ${held.length} held symbol(s) already have a live alert` +
        (skippedIgnored.length > 0 ? ` or are on the ignore list (${skippedIgnored.join(", ")})` : "") +
        "."
    );
    return;
  }

  const market = buildMarketData(opts);
  const quotes = await market.getQuotes(candidates);

  let created = 0;
  let failed = 0;
  for (const symbol of candidates) {
    const info = computeBasis(store.lots, symbol);
    const quote = quotes.get(symbol);
    if (info === null || quote === undefined) {
      console.error(`  ! ${symbol}: no ${info === null ? "basis" : "quote"} available`);
      failed++;
      continue;
    }
    const { level, pctFromBasis } = coverLevel(info.blendedBasis, quote.lastPrice);

    console.log(
      `  ${symbol.padEnd(6)} basis ${info.blendedBasis.toFixed(2)} · price ${quote.lastPrice} ` +
        `(${pctFromBasis >= 0 ? "+" : ""}${pctFromBasis.toFixed(1)}% vs basis) → alert ${level}`
    );

    if (opts.dryRun) {
      created++;
      continue;
    }
    const result = await addAlert(opts.alertsFile, { kind: "static", symbol, level }, market);
    if (result.rejectedReason) {
      console.error(`  ! ${symbol}: ${result.rejectedReason}`);
      failed++;
      continue;
    }
    created++;
  }

  console.log(
    `\n${opts.dryRun ? "Would create" : "Created"} ${created} alert(s) for uncovered position(s)` +
      (failed > 0 ? `, ${failed} failed` : "") +
      (skippedIgnored.length > 0 ? `. Ignored: ${skippedIgnored.join(", ")}` : ".")
  );
}

interface HoldingsImportOpts extends CommonOpts {
  holdingsFile: string;
  csv: string[];
  purchaseDate?: string;
  replace?: boolean;
  dryRun?: boolean;
}

function cmdHoldingsImport(opts: HoldingsImportOpts): void {
  const plans: HoldingsImportPlan[] = [];
  for (const spec of opts.csv) {
    const eq = spec.indexOf("=");
    if (eq < 1) {
      console.error(`Bad --csv "${spec}" — expected account=path, e.g. roth=webull_roth.csv`);
      process.exit(1);
    }
    plans.push(parseWebullHoldings(spec.slice(eq + 1), spec.slice(0, eq)));
  }
  const plan = mergeImportPlans(plans);

  // The export has no purchase date, and the stagnant alert keys off it.
  const purchaseDate = opts.purchaseDate ?? new Date().toISOString().slice(0, 10);
  const store = loadHoldingsStore(opts.holdingsFile);
  if (opts.replace) {
    store.lots = [];
    store.alertState = [];
  }

  console.log(`Read ${plan.rowsRead} row(s) → ${plan.lots.length} lot(s), ${plan.skipped.length} skipped.\n`);

  let value = 0;
  for (const lot of plan.lots) {
    value += lot.marketValue;
    if (opts.dryRun) {
      console.log(
        `  ${lot.symbol.padEnd(6)} ${lot.account.padEnd(7)} ${String(lot.count).padStart(4)} @ ${lot.basisPerShare}` +
          `  (${lot.openPnlPct >= 0 ? "+" : ""}${lot.openPnlPct}%)`
      );
      continue;
    }
    store.lots.push({
      id: randomUUID().slice(0, 8),
      symbol: lot.symbol,
      count: lot.count,
      basisPerShare: lot.basisPerShare,
      purchaseDate,
      createdAt: new Date().toISOString(),
      account: lot.account,
      name: lot.name,
    });
  }

  if (!opts.dryRun) {
    saveHoldingsStore(opts.holdingsFile, store);
  }

  if (plan.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const w of plan.warnings) {
      console.log(`  ~ ${w.symbol} (${w.account}): ${w.message}`);
    }
  }
  if (plan.skipped.length > 0) {
    console.log("\nNot imported:");
    for (const s of plan.skipped) {
      console.log(`  - ${s.symbol} (${s.account}): ${s.reason}`);
    }
  }

  console.log(
    `\n${opts.dryRun ? "Would import" : "Imported"} ${plan.lots.length} lot(s), $${value.toFixed(2)} market value` +
      `${opts.dryRun ? "" : ` → ${opts.holdingsFile}`}.`
  );
  if (opts.purchaseDate === undefined) {
    console.log(
      `Purchase date defaulted to ${purchaseDate} — the export carries none, so the "stagnant" ` +
        `alert (30d + under 2% profit) stays silent until then. Pass --purchase-date to backdate.`
    );
  }
}

interface DashboardOpts extends AlertCommonOpts {
  holdingsFile: string;
  config: string;
  out?: string;
  limit?: number;
  withinPct?: number;
  windowDays?: number;
  approaching?: boolean;
  quiet?: boolean;
  site?: string;
  publish?: boolean;
  skipUnchanged?: boolean;
  maxStaleMinutes: number;
}

function defaultDashboardPath(now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "-");
  return join("reports", `dashboard_${stamp}.json`);
}

const PUBLISH_STATE_PATH = join(".cache", "web_publish.json");

function loadPublishState(): PublishState | null {
  return existsSync(PUBLISH_STATE_PATH) ? (JSON.parse(readFileSync(PUBLISH_STATE_PATH, "utf-8")) as PublishState) : null;
}

async function cmdDashboard(opts: DashboardOpts): Promise<void> {
  const alerts = loadAlerts(opts.alertsFile);
  const revisits = loadRevisits(opts.revisitsFile);
  const holdings = loadHoldingsStore(opts.holdingsFile);
  const config = loadTuningConfig(opts.config);
  const ignored = ignoredSymbols(config);
  const siteDir = opts.site ?? (opts.publish ? "site" : undefined);
  const siteOptions = { holdings: config?.web?.holdings === true };

  const build = (quotes: Map<string, Quote>) =>
    buildDashboard({
      alerts,
      revisits,
      holdings,
      quotes,
      now: new Date(),
      limit: opts.limit,
      approachingWithinPct: opts.withinPct,
      windowDays: opts.windowDays,
      ignoredSymbols: ignored,
      includeApproaching: opts.approaching,
    });

  // The fingerprint ignores price-derived fields, so it can be taken from a
  // quote-less build: a run with nothing new exits here without spending a
  // single quote request, which is what makes a tight cron interval affordable.
  if (opts.publish && opts.skipUnchanged) {
    const decision = shouldPublish(loadPublishState(), siteFingerprint(siteDocument(build(new Map()), siteOptions), buildAlertRows(alerts, new Map(), ignored)), new Date(), opts.maxStaleMinutes);
    if (!decision.publish) {
      console.log(`Skipped publish: ${decision.reason}.`);
      return;
    }
    console.log(`Publishing: ${decision.reason}.`);
  }

  // One quote request covers every live alert plus every position.
  const symbols = [
    ...new Set([...alerts.filter((a) => a.status === "live").map((a) => a.symbol), ...holdings.lots.map((l) => l.symbol)]),
  ];
  let quotes = new Map<string, Quote>();
  if (symbols.length > 0) {
    try {
      quotes = await buildMarketData(opts).getQuotes(symbols);
    } catch (err) {
      console.error(`  ! quote fetch failed (${err}); rendering without live prices.`);
    }
  }

  const dashboard = build(quotes);

  // A site run can happen every couple of minutes; a timestamped report per
  // run would bury reports/. Only write one there when asked to.
  if (siteDir === undefined || opts.out !== undefined) {
    const outPath = opts.out ?? defaultDashboardPath(new Date());
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(dashboard, null, 2));
    console.log(`Wrote ${outPath}`);
  }

  if (!opts.quiet) {
    console.log(renderDashboard(dashboard));
    console.log("");
  }

  // Fingerprint what is actually published, so holdings changes don't trigger
  // a publish while the holdings section is off.
  const siteDashboard = siteDocument(dashboard, siteOptions);
  const alertRows = buildAlertRows(alerts, quotes, ignored);
  if (siteDir !== undefined) {
    writeSite(siteDir, dashboard, siteOptions, alertRows);
    console.log(`Wrote site to ${siteDir}/${siteOptions.holdings ? "" : " (holdings excluded; set web.holdings in the config to include)"}`);
  }

  if (opts.publish && siteDir !== undefined) {
    const plan = await publishSite({ localDir: siteDir });
    console.log(`Published: ${plan.upload.length} uploaded, ${plan.remove.length} deleted, ${plan.unchanged} unchanged.`);
    mkdirSync(dirname(PUBLISH_STATE_PATH), { recursive: true });
    const state: PublishState = { fingerprint: siteFingerprint(siteDashboard, alertRows), publishedAt: siteDashboard.generatedAt };
    writeFileSync(PUBLISH_STATE_PATH, JSON.stringify(state, null, 2));
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
    .description("Confirm breakouts for either a TradingView alerts CSV export or this engine's own revisit queue")
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
    withCommon(cmd)
      .option("--alerts-file <path>", "Path to the alerts JSON store", "alerts.json")
      .option("--revisits-file <path>", "Path to the revisit-queue JSON store", "revisits.json");

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
      "Absolute volume threshold; standalone if --level/--near are omitted, otherwise ANDed onto that alert"
    )
    .option(
      "--volume-ratio <multiple>",
      "Volume threshold as a multiple of typical volume for the window (e.g. 1.5) — cannot go stale the way an absolute count does"
    )
    .option(
      "--volume-period <Nunit>",
      "Look at volume over a trailing window instead of the default 'so far today' (e.g. 30m, 2h, 1d, 45s)"
    )
    .option(
      "--ma <spec>",
      "Moving-average alert: sma|ema, period, @timeframe (1m 2m 5m 15m 1D 1W), e.g. sma200@1W or ema9@5m. Fires when price crosses it"
    )
    .option(
      "--touch [marginPct]",
      `With --ma: fire when price comes within this percent of the average instead (default ${DEFAULT_TOUCH_MARGIN_PCT})`
    )
    .option("--direction <up|down>", "With --ma (cross): only fire on crosses in this direction")
    .option("--from <above|below>", "With --ma --touch: only fire when price approaches from this side")
    .action((opts: AlertAddOpts) => cmdAlertAdd(opts));

  withAlertCommon(program.command("dashboard"))
    .description("One periodic JSON document: the revisit queue, what's close to firing, and holdings")
    .option("--out <path>", "Output JSON path (default: reports/dashboard_<timestamp>.json)")
    .option("--holdings-file <path>", "Path to the holdings JSON store", "holdings.json")
    .option("--limit <n>", "Max rows in the revisit queue", (v) => parseInt(v, 10))
    .option("--approaching", "Include the list of alerts closest to firing (off by default)")
    .option("--within-pct <n>", "With --approaching: only list alerts within this percent of firing", (v) => parseFloat(v))
    .option("--window-days <n>", "How many days back the trigger count covers", (v) => parseInt(v, 10))
    .option("--quiet", "Write the file without printing the rendered view")
    .option("--config <path>", "Per-ticker tuning config (supplies ignoreSymbols)", "analysis.config.json")
    .option("--site <dir>", "Also write the static browser dashboard to this directory (skips the reports/ JSON unless --out is given)")
    .option("--publish", "Sync the site to S3 (S3_BUCKET/AWS_* in .env); implies --site site")
    .option("--skip-unchanged", "With --publish: do nothing, not even fetch quotes, unless something happened or prices are stale")
    .option("--max-stale-minutes <n>", "With --skip-unchanged: republish anyway once prices are this old", (v) => parseInt(v, 10), 30)
    .action((opts: DashboardOpts) => cmdDashboard(opts));

  withAlertCommon(alertCmd.command("seed"))
    .description("One-time migration of the TradingView CSV exports into this engine's alert store")
    .requiredOption("--list <path>", "TradingView alert-list export (Symbol, Description, Status, Last Triggered)")
    .option("--log <path>", "TradingView alert-log export (Symbol, Alert Date, Alert Time, Description)")
    .option("--dry-run", "Print the plan without writing any alerts")
    .option("--symbol <symbol>", "Only seed this symbol (repeatable)", (val, prev: string[]) => [...prev, val], [] as string[])
    .option("--no-cache", "Disable the on-disk bar cache")
    .option("--cache-dir <path>", "Directory for the on-disk bar cache", ".cache/bars")
    .option("--config <path>", "Per-ticker tuning config", "analysis.config.json")
    .action((opts: AlertSeedOpts) => cmdAlertSeed(opts));

  withAlertCommon(alertCmd.command("list"))
    .description("List alerts (live only by default; alerts never disarm)")
    .option("--all", "Include triggered/cancelled alerts")
    .action((opts: AlertListOpts) => cmdAlertList(opts));

  withAlertCommon(alertCmd.command("remove <id>"))
    .description("Remove an alert by id")
    .action((id: string, opts: AlertCommonOpts) => cmdAlertRemove(id, opts));

  const revisitCmd = alertCmd
    .command("revisit")
    .description("The queue of triggered alerts to revisit (alerts themselves never disarm)");

  withAlertCommon(revisitCmd.command("list"))
    .description("List revisit entries, highest priority first")
    .option("--status <status>", "open | applied | dismissed | all", "open")
    .option("--limit <n>", "Show only the top N", (v) => parseInt(v, 10))
    .action((opts: RevisitListOpts) => cmdRevisitList(opts));

  withAlertCommon(revisitCmd.command("relevel"))
    .description("Fetch bars for open entries, propose new levels, and score the queue")
    .option("--symbol <symbol>", "Only re-level this symbol (repeatable)", (val, prev: string[]) => [...prev, val], [] as string[])
    .option("--no-cache", "Disable the on-disk bar cache")
    .option("--cache-dir <path>", "Directory for the on-disk bar cache", ".cache/bars")
    .option("--holdings-file <path>", "Path to the holdings JSON store", "holdings.json")
    .option("--config <path>", "Per-ticker tuning config", "analysis.config.json")
    .action((opts: RevisitRelevelOpts) => cmdRevisitRelevel(opts));

  withAlertCommon(revisitCmd.command("apply <id>"))
    .description("Move the alert to the entry's suggested level and close the entry")
    .action((id: string, opts: AlertCommonOpts) => cmdRevisitResolve(id, "applied", opts));

  withAlertCommon(revisitCmd.command("dismiss <id>"))
    .description("Close the entry without touching the alert")
    .action((id: string, opts: AlertCommonOpts) => cmdRevisitResolve(id, "dismissed", opts));

  withAlertCommon(alertCmd.command("check"))
    .description("Check all live alerts against live Schwab quotes (run this from cron every ~15 min)")
    .option("--regular-only", "Only poll during the regular session (default also polls pre/post market)")
    .option("--config <path>", "Per-ticker tuning config (supplies ignoreSymbols)", "analysis.config.json")
    .option("--ignore-hours", "Poll regardless of market hours")
    .option("--cache-dir <path>", "Directory for the on-disk bar cache", ".cache/bars")
    .action((opts: AlertCheckOpts) => cmdAlertCheck(opts));

  const holdingsCmd = program.command("holdings").description("Track holdings (lots, stops) and basis-relative alerts");

  const withHoldingsCommon = (cmd: Command): Command =>
    withCommon(cmd).option("--holdings-file <path>", "Path to the holdings JSON store", "holdings.json");

  withHoldingsCommon(holdingsCmd.command("cover"))
    .description("Create a starting alert for each held position that has none (10% above basis, or just above price)")
    .option("--alerts-file <path>", "Path to the alerts JSON store", "alerts.json")
    .option("--config <path>", "Per-ticker tuning config (supplies ignoreSymbols)", "analysis.config.json")
    .option("--dry-run", "Print the plan without writing anything")
    .action((opts: HoldingsCoverOpts) => cmdHoldingsCover(opts));

  withHoldingsCommon(holdingsCmd.command("import"))
    .description("One-time import of Webull holdings CSV exports into lots")
    .requiredOption(
      "--csv <account=path>",
      "Account label and file, e.g. roth=webull_roth.csv (repeatable)",
      (val, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option("--purchase-date <YYYY-MM-DD>", "Purchase date for every imported lot (the export carries none)")
    .option("--replace", "Clear existing lots first instead of adding to them")
    .option("--dry-run", "Print the plan without writing anything")
    .action((opts: HoldingsImportOpts) => cmdHoldingsImport(opts));

  withHoldingsCommon(holdingsCmd.command("add-lot"))
    .description("Record a purchase lot")
    .requiredOption("--symbol <symbol>", "Ticker symbol")
    .requiredOption("--count <n>", "Shares purchased")
    .requiredOption("--basis <price>", "Price paid per share")
    .option("--date <yyyy-mm-dd>", "Purchase date (default: today)")
    .action((opts: HoldingsAddLotOpts) => cmdHoldingsAddLot(opts));

  withHoldingsCommon(holdingsCmd.command("list"))
    .description("List holdings with blended basis, last purchase date, and stops")
    .option("--symbol <symbol>", "Only show this symbol")
    .action((opts: HoldingsListOpts) => cmdHoldingsList(opts));

  const stopCmd = holdingsCmd.command("stop").description("Manage stops (record-keeping only, not live-monitored yet)");

  withHoldingsCommon(stopCmd.command("add"))
    .description("Record a stop")
    .requiredOption("--symbol <symbol>", "Ticker symbol")
    .requiredOption("--price <price>", "Stop price")
    .option("--count <n>", "Shares covered (default: all currently held, tracked dynamically)")
    .action((opts: HoldingsStopAddOpts) => cmdHoldingsStopAdd(opts));

  withHoldingsCommon(stopCmd.command("list"))
    .description("List stops")
    .option("--symbol <symbol>", "Only show this symbol")
    .action((opts: HoldingsListOpts) => cmdHoldingsStopList(opts));

  withHoldingsCommon(stopCmd.command("remove <id>"))
    .description("Remove a stop by id")
    .action((id: string, opts: HoldingsCommonOpts) => cmdHoldingsStopRemove(id, opts));

  withHoldingsCommon(holdingsCmd.command("check"))
    .description("Check holdings for the 10%-above-basis, month-stagnant, and 3%-appreciation alerts")
    .option("--config <path>", "Per-ticker tuning config (supplies ignoreSymbols)", "analysis.config.json")
    .action((opts: HoldingsCommonOpts & { config: string }) => cmdHoldingsCheck(opts));

  const profileCmd = program
    .command("profile")
    .description("Cache ticker sector/industry/description data (Financial Modeling Prep)");
  const withProfileCommon = (cmd: Command): Command =>
    cmd
      .option("--fmp-api-key <key>", "Financial Modeling Prep API key (or FMP_API_KEY in env/.env)")
      .option("--cache-dir <path>", "Directory for the profile cache", ".cache/profiles");

  withProfileCommon(profileCmd.command("fetch"))
    .description("Populate the profile cache (250 requests/day free-tier budget, tracked across runs)")
    .option("--symbol <symbol>", "Fetch this symbol (repeatable)", (val, prev: string[]) => [...prev, val], [] as string[])
    .option("--csv <path>", "Also include symbols from this TradingView CSV export (repeatable)", (val, prev: string[]) => [...prev, val], [] as string[])
    .option("--all-known", "Also include every symbol seen in history/, holdings.json, and alerts.json")
    .option("--refresh", "Re-fetch symbols that are already cached")
    .option("--history-dir <path>", "Directory of per-ticker history JSON files", "history")
    .option("--holdings-file <path>", "Path to the holdings JSON store", "holdings.json")
    .option("--alerts-file <path>", "Path to the alerts JSON store", "alerts.json")
    .action((opts: ProfileFetchOpts) => cmdProfileFetch(opts));

  withProfileCommon(profileCmd.command("list"))
    .description("List cached profiles, sorted by sector")
    .option("--sector <sector>", "Only show this sector")
    .action((opts: ProfileListOpts) => cmdProfileList(opts));

  withProfileCommon(profileCmd.command("show"))
    .description("Show one cached profile in full, including its description")
    .requiredOption("--symbol <symbol>", "Ticker symbol")
    .action((opts: ProfileShowOpts) => cmdProfileShow(opts));

  return program;
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  buildProgram().parseAsync(process.argv);
}
