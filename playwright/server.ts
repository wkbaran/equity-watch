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
 *   GET  /__reset   forget ops and un-release, between tests
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
import { FIXTURE_ALERTS, HOLDINGS, OPS_TOKEN, PRICES } from "./fixtures.js";

const PORT = Number(process.env.PW_PORT ?? 4178);
const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));
const TYPES: Record<string, string> = { html: "text/html", js: "text/javascript" };

type QueuedOp = { id: string; type: string; params: Record<string, unknown>; target?: Record<string, string> };
let ops: QueuedOp[] = [];
let released = false;

function resultFor(op: QueuedOp): OpResult {
  const appliedAt = new Date().toISOString();
  if (op.type === "alert.add") {
    return { id: op.id, type: op.type, symbol: String(op.params.symbol), alertId: "added001", ok: true, message: `Added static alert added001: price crosses ${op.params.level}.`, appliedAt };
  }
  if (op.type === "alert.edit") {
    return { id: op.id, type: op.type, symbol: null, alertId: op.target?.alertId ?? null, ok: false, message: "Not edited: the alert changed since the page loaded.", appliedAt };
  }
  // Holdings results carry no sizes or prices, like the real ones.
  const symbol = String(op.params.symbol ?? op.target?.symbol ?? "AA");
  return { id: op.id, type: op.type, symbol, alertId: null, ok: true, message: `Applied to ${symbol}.`, appliedAt };
}

function documents() {
  const quotes = new Map<string, Quote>(Object.entries(PRICES).map(([symbol, lastPrice]) => [symbol, { lastPrice, totalVolume: 0 }]));
  const dashboard = buildDashboard({ alerts: FIXTURE_ALERTS, revisits: [], holdings: HOLDINGS, quotes, now: new Date() });
  return {
    "dashboard.json": siteDocument(dashboard, { holdings: false, ops: true, vault: true }, released ? ops.map(resultFor) : []),
    "alerts.json": { generatedAt: dashboard.generatedAt, alerts: buildAlertRows(FIXTURE_ALERTS, quotes, new Set()) },
    "vault.json": sealVault(vaultContents(dashboard.holdings, HOLDINGS), OPS_TOKEN),
  };
}

createServer(async (req, res) => {
  const send = (status: number, body: unknown, type = "application/json") => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(/^\//, "") || "index.html";

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
    return send(200, { released });
  }
  if (path === "__ops") return send(200, ops);
  if (path === "__reset") {
    ops = [];
    released = false;
    return send(200, { reset: true });
  }
  if (path === "dashboard.json" || path === "alerts.json" || path === "vault.json") return send(200, documents()[path]);
  if (SITE_ASSETS.includes(path)) {
    return send(200, await readFile(join(WEB_DIR, path)), TYPES[path.split(".").pop() ?? ""] ?? "application/octet-stream");
  }
  send(404, { error: "not found" });
}).listen(PORT, () => console.log(`playwright site on http://localhost:${PORT}`));
