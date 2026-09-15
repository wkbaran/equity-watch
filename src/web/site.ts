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
export const SITE_ASSETS = ["index.html", "app.js", "sw.js"];

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
 * opResults are browser-only, like alerts.json: the page matches the ops it
 * has pending against them. Not volatile: a new result is news and should
 * publish.
 */
export type SiteDocument = Dashboard & { site: SiteOptions; opResults: OpResult[] };

/**
 * The document as published. With holdings off, the holdings rows (share
 * counts, basis, market value) are removed from the JSON itself, since the site
 * may be public. That a name is held is deliberately still allowed through:
 * "Holding MKS crossed below 110" headlines, story ordering, and "held position" in
 * priority breakdowns say nothing about size or value.
 */
export function siteDocument(dashboard: Dashboard, options: SiteOptions, opResults: OpResult[] = []): SiteDocument {
  return { ...dashboard, holdings: options.holdings ? dashboard.holdings : [], site: options, opResults };
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
  opResults: OpResult[] = [],
  vault: VaultDocument | null = null
): void {
  mkdirSync(dir, { recursive: true });
  for (const name of SITE_ASSETS) {
    copyFileSync(join(assetDir(), name), join(dir, name));
  }
  writeFileSync(join(dir, "dashboard.json"), JSON.stringify(siteDocument(dashboard, options, opResults)));
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
]);

function stableHash(value: unknown): string {
  const stable = JSON.stringify(value, (key, v) => (VOLATILE_KEYS.has(key) ? undefined : v));
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

/** Publish when something happened, or when prices on the page have gone stale. */
export function shouldPublish(
  state: PublishState | null,
  fingerprint: string,
  now: Date,
  maxStaleMinutes: number
): { publish: boolean; reason: string } {
  if (state === null) {
    return { publish: true, reason: "first publish" };
  }
  if (state.fingerprint !== fingerprint) {
    return { publish: true, reason: "dashboard changed" };
  }
  const ageMin = (now.getTime() - new Date(state.publishedAt).getTime()) / 60_000;
  if (ageMin >= maxStaleMinutes) {
    return { publish: true, reason: `prices ${Math.round(ageMin)} min old` };
  }
  return { publish: false, reason: `unchanged, last published ${Math.round(ageMin)} min ago` };
}
