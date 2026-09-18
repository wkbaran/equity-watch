/**
 * A local stand-in for the published site, for the Playwright suite.
 *
 * Serves the real page (web/) with dashboard.json and alerts.json built from
 * playwright/fixtures.ts by the same builders `dashboard --site` uses, so the
 * documents can't drift from the models. Also fakes the AWS side:
 *
 *   POST /api/ops   the ops Lambda: OPS_TOKEN gets 202 and the op is remembered,
 *                   anything else 401
 *   GET  /__release from now on dashboard.json carries opResults for the
 *                   remembered ops, as `ops pull` would publish them: adds
 *                   succeed, edits are rejected (so both toasts get exercised)
 *   GET  /__ops     the remembered op bodies, for assertions
 *   GET  /__cadence set the published drain watermark, interval and next-check
 *                   time, so specs can drive the countdown, the scheduler's own
 *                   next-run time, and the overdue warning
 *   GET  /__reset   forget ops, un-release, and restore the default cadence
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDashboard } from "../src/dashboard.js";
import type { OpResult } from "../src/ops/apply.js";
import type { Quote } from "../src/providers/schwab.js";
import { buildAlertRows } from "../src/web/alertsPage.js";
import { SITE_ASSETS, siteDocument } from "../src/web/site.js";
import { sealVault, vaultContents } from "../src/web/vault.js";
import { FIXTURE_ALERTS, FIXTURE_REVISITS, HOLDINGS, OPS_TOKEN, PRICES } from "./fixtures.js";

const PORT = Number(process.env.PW_PORT ?? 4178);
const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));
const TYPES: Record<string, string> = { html: "text/html", js: "text/javascript" };

type QueuedOp = { id: string; type: string; params: Record<string, unknown>; target?: Record<string, string> };
let ops: QueuedOp[] = [];
let released = false;
/** /__release?results=none: set the watermark but publish no results, as a drain past the result cap would. */
let suppressResults = false;
/**
 * The cadence the real publisher measures (src/ops/schedule.ts). The watermark
 * has to sit in the past: an op queued before it is one a drain already
 * covered, and the page retires it on sight.
 */
const DEFAULT_CADENCE = { minutesAgo: 6, interval: 15 as number | null, nextInMin: null as number | null, maxStale: null as number | null };
let cadence = { ...DEFAULT_CADENCE };

function resultFor(op: QueuedOp): OpResult {
  const appliedAt = new Date().toISOString();
  if (op.type === "alert.add") {
    return { id: op.id, type: op.type, symbol: String(op.params.symbol), alertId: "added001", ok: true, message: `Added static alert added001: price crosses ${op.params.level}.`, appliedAt };
  }
  if (op.type === "alert.edit") {
    return { id: op.id, type: op.type, symbol: null, alertId: op.target?.alertId ?? null, ok: false, message: "Not edited: the alert changed since the page loaded.", appliedAt };
  }
  if (op.type === "revisit.dismiss") {
    return { id: op.id, type: op.type, symbol: "AA", alertId: op.target?.alertId ?? null, ok: true, message: `Dismissed revisit ${op.target?.revisitId} (AA) from the queue.`, appliedAt };
  }
  // Holdings results carry no sizes or prices, like the real ones.
  const symbol = String(op.params.symbol ?? op.target?.symbol ?? "AA");
  return { id: op.id, type: op.type, symbol, alertId: null, ok: true, message: `Applied to ${symbol}.`, appliedAt };
}

function documents() {
  const quotes = new Map<string, Quote>(Object.entries(PRICES).map(([symbol, lastPrice]) => [symbol, { lastPrice, totalVolume: 0 }]));
  const dashboard = buildDashboard({ alerts: FIXTURE_ALERTS, revisits: FIXTURE_REVISITS, holdings: HOLDINGS, quotes, now: new Date() });
  const heldSymbols = new Set(HOLDINGS.lots.map((l) => l.symbol.toUpperCase()));
  return {
    "dashboard.json": siteDocument(dashboard, { holdings: false, ops: true, vault: true }, {
      results: released && !suppressResults ? ops.map(resultFor) : [],
      processedThrough: released ? new Date().toISOString() : new Date(Date.now() - cadence.minutesAgo * 60_000).toISOString(),
      intervalMinutes: cadence.interval,
      nextCheckAt: cadence.nextInMin === null ? null : new Date(Date.now() + cadence.nextInMin * 60_000).toISOString(),
      maxStaleMinutes: cadence.maxStale,
    }),
    "alerts.json": { generatedAt: dashboard.generatedAt, alerts: buildAlertRows(FIXTURE_ALERTS, quotes, new Set(), new Map(), heldSymbols) },
    "vault.json": sealVault(vaultContents(dashboard.holdings, HOLDINGS), OPS_TOKEN),
  };
}

createServer(async (req, res) => {
  const send = (status: number, body: unknown, type = "application/json") => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/^\//, "") || "index.html";

  if (path === "api/ops") {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.method !== "POST") return send(405, { error: "POST only" });
    if (req.headers.authorization !== `Bearer ${OPS_TOKEN}`) return send(401, { error: "Bad or missing token" });
    const op = JSON.parse(body) as QueuedOp;
    ops.push(op);
    return send(202, { id: op.id, queued: true });
  }
  if (path === "__release") {
    released = true;
    suppressResults = url.searchParams.get("results") === "none";
    return send(200, { released, suppressResults });
  }
  if (path === "__ops") return send(200, ops);
  if (path === "__cadence") {
    const interval = url.searchParams.get("interval");
    const next = url.searchParams.get("nextInMin");
    const maxStale = url.searchParams.get("maxStale");
    cadence = {
      minutesAgo: Number(url.searchParams.get("minutesAgo") ?? 0),
      interval: interval === "none" ? null : Number(interval ?? DEFAULT_CADENCE.interval),
      nextInMin: next === null ? null : Number(next),
      maxStale: maxStale === null ? null : Number(maxStale),
    };
    return send(200, cadence);
  }
  if (path === "__reset") {
    ops = [];
    released = false;
    suppressResults = false;
    cadence = { ...DEFAULT_CADENCE };
    return send(200, { reset: true });
  }
  if (path === "dashboard.json" || path === "alerts.json" || path === "vault.json") return send(200, documents()[path]);
  if (SITE_ASSETS.includes(path)) {
    return send(200, await readFile(join(WEB_DIR, path)), TYPES[path.split(".").pop() ?? ""] ?? "application/octet-stream");
  }
  send(404, { error: "not found" });
}).listen(PORT, () => console.log(`playwright site on http://localhost:${PORT}`));
