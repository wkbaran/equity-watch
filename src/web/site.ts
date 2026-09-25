/**
 * The browser dashboard: a static site that renders the same Dashboard
 * document the terminal view does.
 *
 * The page itself (web/) is fixed - it never changes between runs. Each run
 * only rewrites dashboard.json, which the page polls. That split is what lets
 * an open tab notice new triggers without a reload, and it keeps the
 * Dashboard document the one shared contract for every renderer (terminal,
 * this page, and eventually the Kindle display).
 */

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Dashboard } from "../dashboard.js";
import type { OpResult } from "../ops/apply.js";
import type { AlertRow } from "./alertsPage.js";
import { VAULT_FILE, type VaultContents, type VaultDocument } from "./vault.js";

/** Static assets copied verbatim into the site directory. */
export const SITE_ASSETS = ["index.html", "app.js", "palette.js", "sw.js"];

/**
 * Two levels up from both src/web/site.ts (tsx) and dist/web/site.js (built),
 * so the same resolution works whichever way the CLI is run.
 */
function assetDir(): string {
  return fileURLToPath(new URL("../../web/", import.meta.url));
}

/**
 * Which optional sections the published site shows. Recorded in the document
 * so the page can tell "holdings disabled" apart from "holds nothing".
 */
export interface SiteOptions {
  holdings: boolean;
  /** Whether the page offers editing (the ops queue is configured). Absent means no. */
  ops?: boolean;
  /** Whether vault.json (holdings encrypted under the ops token) is published. Absent means no. */
  vault?: boolean;
}

/**
 * What the page needs to reason about changes it has queued but not yet seen
 * applied. Gathered by the CLI from the op log and `.cache/ops_pull.json`,
 * since none of it comes out of the Dashboard document itself.
 */
export interface OpsPublishState {
  /**
   * Browser-only, like alerts.json: the page matches its pending ops against
   * these. Not volatile — a new result is news and should publish.
   */
  results: OpResult[];
  /**
   * When the last clean drain of the ops queue began. Everything queued before
   * it has been applied, so the page can retire a pending row whose result has
   * already fallen off the end of `results`.
   */
  processedThrough: string | null;
  /**
   * Observed minutes between drains (src/ops/schedule.ts), or null when too
   * few have been recorded to say. The page turns it into "applies in ~9 min",
   * and into a warning once that passes with no drain.
   */
  intervalMinutes: number | null;
  /**
   * When the scheduler says the next check runs (`--next-check`), or null when
   * nothing told us. This is read from Task Scheduler rather than inferred, so
   * it already accounts for the repetition *and* the daily window: at 18:10,
   * with the window over, it is tomorrow's 01:55 and not 18:25.
   *
   * The page prefers it while it is still in the future and falls back to the
   * measured cadence otherwise. That fallback matters: a quiet run publishes
   * nothing (--skip-unchanged), so this can go stale by up to
   * --max-stale-minutes while the task is running perfectly well, and treating
   * a past value as "the check didn't run" would cry wolf.
   */
  nextCheckAt: string | null;
  /**
   * How old an unchanged document may get before a run republishes it
   * (--max-stale-minutes), or null when every run publishes. The page adds it
   * to its overdue threshold: without it, a healthy quiet stretch reads as
   * "no check since" for the whole time the publisher is choosing to skip.
   */
  maxStaleMinutes: number | null;
  /**
   * When the Schwab login expired, or null while it is healthy.
   *
   * Schwab refresh tokens last 7 days and only a browser login renews one, so
   * this happens about weekly and the machine cannot fix itself. Until it is
   * fixed, `alert check` evaluates nothing and queued adds and level edits stay
   * queued (both need a live quote to place a level against price), so the page
   * must say so outright: the symptom otherwise is a document that quietly
   * stops changing, which looks exactly like a quiet market.
   *
   * Deliberately NOT in VOLATILE_KEYS - the whole point is that it publishes.
   * It is safe there because it holds the *first* failure's timestamp, so it
   * changes twice per expiry (on and off) rather than every run.
   */
  authExpiredSince: string | null;
}

export const NO_OPS: OpsPublishState = { results: [], processedThrough: null, intervalMinutes: null, nextCheckAt: null, maxStaleMinutes: null, authExpiredSince: null };

export type SiteDocument = Dashboard & {
  site: SiteOptions;
  opResults: OpResult[];
  opsProcessedThrough: string | null;
  opsIntervalMinutes: number | null;
  opsNextCheckAt: string | null;
  opsMaxStaleMinutes: number | null;
  opsAuthExpiredSince: string | null;
};

/**
 * The document as published. With holdings off, the holdings rows (share
 * counts, basis, market value) are removed from the JSON itself, since the site
 * may be public. That a name is held is deliberately still allowed through:
 * "Holding MKS crossed below 110" headlines and "held position" in priority
 * breakdowns say nothing about size or value.
 *
 * Stories are removed always, whatever `holdings` says: they tell when you
 * bought and sold, and travel only in the vault (vaultContents).
 */
export function siteDocument(dashboard: Dashboard, options: SiteOptions, ops: OpsPublishState = NO_OPS): SiteDocument {
  return {
    ...dashboard,
    holdings: options.holdings ? dashboard.holdings : [],
    stories: [],
    site: options,
    opResults: ops.results,
    opsProcessedThrough: ops.processedThrough,
    opsIntervalMinutes: ops.intervalMinutes,
    opsNextCheckAt: ops.nextCheckAt,
    opsMaxStaleMinutes: ops.maxStaleMinutes,
    opsAuthExpiredSince: ops.authExpiredSince,
  };
}

/**
 * dashboard.json is what the page polls; alerts.json is the full alert book,
 * fetched only by the Alerts view (see src/web/alertsPage.ts).
 */
export function writeSite(
  dir: string,
  dashboard: Dashboard,
  options: SiteOptions,
  alerts: AlertRow[],
  ops: OpsPublishState = NO_OPS,
  vault: VaultDocument | null = null
): void {
  mkdirSync(dir, { recursive: true });
  for (const name of SITE_ASSETS) {
    copyFileSync(join(assetDir(), name), join(dir, name));
  }
  writeFileSync(join(dir, "dashboard.json"), JSON.stringify(siteDocument(dashboard, options, ops)));
  writeFileSync(join(dir, "alerts.json"), JSON.stringify({ generatedAt: dashboard.generatedAt, alerts }));
  if (vault !== null) {
    writeFileSync(join(dir, VAULT_FILE), JSON.stringify(vault));
  } else {
    // Deleting the local copy is what makes the publisher delete the remote one.
    rmSync(join(dir, VAULT_FILE), { force: true });
  }
}

/**
 * Fields that move with the live quote or the clock rather than with anything
 * that happened. Publishing on every change to these would mean publishing on
 * every run, which is exactly what --skip-unchanged exists to avoid.
 *
 * quietWatches/quietTotal are here because a quiet-watch note is defined by
 * how little price has moved, so it flickers with the quote.
 */
const VOLATILE_KEYS = new Set([
  "generatedAt",
  "price",
  "pctFromBasis",
  "marketValue",
  "sinceWatching",
  // A queue row's "price is +2% since it fired": the same kind of thing as
  // sinceWatching. Its sibling `updates` is deliberately NOT here — those
  // sentences record edits and crossings, and must publish.
  "sinceTrigger",
  "distancePct",
  "quotesUnavailable",
  "approaching",
  "approachingTotal",
  "quietWatches",
  "quietTotal",
  // Alert rows (alertsPage.ts): trailing triggers and moving averages shift
  // on nearly every check, and distance moves with price.
  "movingLevel",
  "vsLevelPct",
  // Advance/drift with the clock rather than with anything that happened: the
  // watermark moves on every clean drain, and the cadence is a rounded median
  // of those gaps. Both ride along with publishes that have a reason.
  "opsProcessedThrough",
  "opsIntervalMinutes",
  // Advances by one repetition on every run, so it would publish every run.
  "opsNextCheckAt",
]);

function stableHash(value: unknown): string {
  const stable = JSON.stringify(value, (key: string, v: unknown) => (VOLATILE_KEYS.has(key) ? undefined : v));
  return createHash("sha256").update(stable).digest("hex");
}

/**
 * A hash of what happened, ignoring what merely moved. Must come out the same
 * whether or not quotes were fetched: the CLI fingerprints a quote-less build
 * first so a quiet run spends no API calls at all.
 */
export function dashboardFingerprint(d: Dashboard): string {
  return stableHash(d);
}

/**
 * Everything the site publishes: the dashboard document, the alert book, and
 * the vault's plaintext. Same rules. The vault's ciphertext changes with every
 * seal (a fresh IV), so hashing it would publish on every run.
 */
export function siteFingerprint(doc: SiteDocument, alerts: AlertRow[], vault: VaultContents | null = null): string {
  return stableHash(vault === null ? { doc, alerts } : { doc, alerts, vault });
}

export interface PublishState {
  fingerprint: string;
  publishedAt: string;
}

/**
 * Scheduled runs start on a fixed grid but publish a few seconds in, and not
 * always the same few. Compared exactly, a document published 11:25:07 is
 * 29.97 minutes old at the 11:55:05 check, so a 30-minute limit waits a whole
 * extra interval (2026-09-18: the page said "no check since" meanwhile).
 */
const STALE_SLACK_MINUTES = 1;

/**
 * Publish when something happened, when prices on the page have gone stale, or
 * when the next run is further off than the page may go without news. That
 * last is the end of the task's daily window: a quiet final run would
 * otherwise leave the page expecting a check every 15 minutes all night.
 */
export function shouldPublish(
  state: PublishState | null,
  fingerprint: string,
  now: Date,
  maxStaleMinutes: number,
  nextCheckAt: string | null = null
): { publish: boolean; reason: string } {
  if (state === null) {
    return { publish: true, reason: "first publish" };
  }
  if (state.fingerprint !== fingerprint) {
    return { publish: true, reason: "dashboard changed" };
  }
  const ageMin = (now.getTime() - new Date(state.publishedAt).getTime()) / 60_000;
  if (ageMin >= maxStaleMinutes - STALE_SLACK_MINUTES) {
    return { publish: true, reason: `prices ${Math.round(ageMin)} min old` };
  }
  if (nextCheckAt !== null) {
    const gapMin = (new Date(nextCheckAt).getTime() - now.getTime()) / 60_000;
    if (gapMin > maxStaleMinutes) {
      return { publish: true, reason: `next check not for ${Math.round(gapMin)} min` };
    }
  }
  return { publish: false, reason: `unchanged, last published ${Math.round(ageMin)} min ago` };
}
