/**
 * Applies a change queued from the browser dashboard: add or edit an alert, or
 * add, edit, or remove a holdings lot, position, or stop.
 *
 * The page can't write alerts.json or holdings.json, which live on the machine
 * running `alert check`. It queues an op instead (see cloudformation.yaml,
 * OpsQueue), and `ops pull` applies it here through the same engine functions
 * and validation (src/ops/validate.ts) the CLI uses.
 *
 * Idempotency comes from the op log, not from SQS. FIFO deduplication only
 * lasts five minutes, and an add is not idempotent: redelivering one after a
 * crash would add a second alert or lot. So every result is appended to the
 * log, and an op id already there returns its logged result without applying
 * again.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { describeAlertCondition } from "../alerts/describe.js";
import { addAlert, editAlert, type MarketData } from "../alerts/engine.js";
import { loadRevisits, resolveRevisit } from "../alerts/revisitStore.js";
import { loadAlerts } from "../alerts/store.js";
import { applyHoldingsOp } from "./holdings.js";
import { addFieldsFromJson, editFieldsFromJson, parseAddInput, parseAlertEdit, stringField } from "./validate.js";

export const DEFAULT_OP_LOG = "ops.log.jsonl";
export const DEFAULT_HOLDINGS_FILE = "holdings.json";
export const DEFAULT_REVISITS_FILE = "revisits.json";

export const OP_TYPES = ["alert.add", "alert.edit", "lot.add", "lot.edit", "lot.remove", "position.remove", "stop.add", "stop.remove"] as const;
export type OpType = (typeof OP_TYPES)[number];

/**
 * An op as queued. Parsing checks only the envelope (id and type). Params,
 * target, and expect are checked when the op is applied, so a bad one becomes
 * a logged rejection the page can show, rather than a message dropped as
 * malformed that leaves the page waiting forever.
 *
 * `expect` is the conflict guard: what the page showed when the change was
 * made. If the thing no longer looks like that, the op is rejected rather than
 * applied to something that isn't what was on screen.
 */
export interface Op {
  id: string;
  type: OpType;
  createdAt: string;
  params: unknown;
  target: unknown;
  expect: unknown;
}

export interface OpResult {
  id: string;
  type: string;
  symbol: string | null;
  alertId: string | null;
  ok: boolean;
  /** Published in dashboard.json. Holdings messages carry no share counts, basis, or prices. */
  message: string;
  appliedAt: string;
}

/** The part of a result an op handler decides. */
export type Outcome = Omit<OpResult, "id" | "type" | "appliedAt">;

const OP_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export function parseOp(body: unknown): { ok: true; op: Op } | { ok: false; error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "An op must be a JSON object." };
  }
  const o = body as Record<string, unknown>;
  if (typeof o.id !== "string" || !OP_ID_RE.test(o.id)) {
    return { ok: false, error: "An op needs an id of 8-64 letters, digits, or dashes." };
  }
  if (typeof o.type !== "string" || !(OP_TYPES as readonly string[]).includes(o.type)) {
    return { ok: false, error: `Unknown op type "${String(o.type)}".` };
  }
  return {
    ok: true,
    op: {
      id: o.id,
      type: o.type as OpType,
      createdAt: typeof o.createdAt === "string" ? o.createdAt : new Date().toISOString(),
      params: o.params ?? {},
      target: o.target,
      expect: o.expect,
    },
  };
}

/** Every logged result, oldest first. A torn last line (a crash mid-write) is skipped. */
export function loadOpLog(path: string): OpResult[] {
  if (!existsSync(path)) {
    return [];
  }
  const out: OpResult[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as OpResult);
    } catch {
      /* torn line */
    }
  }
  return out;
}

export function appendOpResult(path: string, result: OpResult): void {
  appendFileSync(path, `${JSON.stringify(result)}\n`);
}

/** The newest `limit` results, newest first: what the published page matches pending ops against. */
export function recentOpResults(log: OpResult[], limit = 50): OpResult[] {
  return log.slice(-limit).reverse();
}

export interface ApplyContext {
  alertsFile: string;
  /** Default holdings.json. */
  holdingsFile?: string;
  /** Default revisits.json. Only an edit sent from a trigger's details panel reads it. */
  revisitsFile?: string;
  opLogFile: string;
  market: MarketData;
  now?: () => Date;
}

export interface ApplyOutcome {
  result: OpResult;
  /** True when the id was already in the log, so nothing was applied this time. */
  duplicate: boolean;
}

/**
 * Applies one op and logs its result. A rejection (bad input, stale page, the
 * engine said no) is a result. An exception (Schwab down, disk error) is not:
 * it propagates, nothing is logged, and the caller leaves the message queued
 * for a retry.
 */
export async function applyOp(op: Op, ctx: ApplyContext): Promise<ApplyOutcome> {
  const prior = loadOpLog(ctx.opLogFile).find((r) => r.id === op.id);
  if (prior !== undefined) {
    return { result: prior, duplicate: true };
  }
  const outcome =
    op.type === "alert.add"
      ? await applyAdd(op, ctx)
      : op.type === "alert.edit"
        ? await applyEdit(op, ctx)
        : applyHoldingsOp(op, ctx.holdingsFile ?? DEFAULT_HOLDINGS_FILE);
  const result: OpResult = { id: op.id, type: op.type, ...outcome, appliedAt: (ctx.now?.() ?? new Date()).toISOString() };
  appendOpResult(ctx.opLogFile, result);
  return { result, duplicate: false };
}

const reject = (symbol: string | null, alertId: string | null, message: string): Outcome => ({ symbol, alertId, ok: false, message });

async function applyAdd(op: Op, ctx: ApplyContext): Promise<Outcome> {
  const symbol = stringField(op.params, "symbol")?.trim().toUpperCase() || null;
  const fields = addFieldsFromJson(op.params);
  if (!fields.ok) {
    return reject(symbol, null, fields.error);
  }
  const parsed = parseAddInput(fields.value);
  if (!parsed.ok) {
    return reject(symbol, null, parsed.error);
  }
  // Same as a typed `alert add`: the page's add states the level it wants, so
  // it replaces the alert already on that side even when that one is nearer.
  const result = await addAlert(ctx.alertsFile, parsed.value, ctx.market, { onConflict: "replace" });
  if (result.rejectedReason !== null || result.added === null) {
    return reject(parsed.value.symbol, null, `Not added: ${result.rejectedReason ?? "unknown reason"}`);
  }
  const a = result.added;
  const replaced = result.replaced ? ` Replaced alert ${result.replaced.id} (${describeAlertCondition(result.replaced)}).` : "";
  return { symbol: a.symbol, alertId: a.id, ok: true, message: `Added ${a.kind} alert ${a.id}: ${describeAlertCondition(a)}.${replaced}` };
}

async function applyEdit(op: Op, ctx: ApplyContext): Promise<Outcome> {
  const alertId = stringField(op.target, "alertId");
  if (alertId === null || alertId === "") {
    return reject(null, null, "An edit needs target.alertId.");
  }
  const expected = stringField(op.expect, "condition");
  if (expected === null) {
    return reject(null, alertId, "An edit needs expect.condition.");
  }
  // By id only. findAlert would also accept a ticker, and an edit aimed at one
  // alert must never land on another alert that happens to share its symbol.
  const alert = loadAlerts(ctx.alertsFile).find((a) => a.id === alertId);
  if (alert === undefined) {
    return reject(null, alertId, `No alert with id ${alertId}. It may have been removed.`);
  }
  const now = describeAlertCondition(alert);
  if (now !== expected) {
    return reject(alert.symbol, alertId, `Not edited: the alert changed since the page loaded. It is now "${now}".`);
  }
  // An edit sent from a trigger's details panel also closes that trigger's
  // queue entry: re-levelling from the panel *is* the decision the entry was
  // waiting on. Checked before the edit so a stale panel is one rejection and
  // no half-done change, rather than an alert moved with the entry still open.
  const revisitId = stringField(op.target, "revisitId");
  const revisitsFile = ctx.revisitsFile ?? DEFAULT_REVISITS_FILE;
  if (revisitId !== null && revisitId !== "") {
    const entry = loadRevisits(revisitsFile).find((e) => e.id === revisitId);
    if (entry === undefined) {
      return reject(alert.symbol, alertId, `No revisit entry with id ${revisitId}. It may already be closed.`);
    }
    if (entry.alertId !== alertId) {
      return reject(alert.symbol, alertId, `Revisit ${revisitId} belongs to alert ${entry.alertId}, not ${alertId}.`);
    }
    if (entry.status !== "open") {
      return reject(alert.symbol, alertId, `Revisit ${revisitId} is already ${entry.status}.`);
    }
  }
  const fields = editFieldsFromJson(op.params);
  if (!fields.ok) {
    return reject(alert.symbol, alertId, fields.error);
  }
  const parsed = parseAlertEdit(fields.value);
  if (!parsed.ok) {
    return reject(alert.symbol, alertId, parsed.error);
  }
  const result = await editAlert(ctx.alertsFile, alertId, parsed.value, ctx.market);
  if (result.rejectedReason !== null || result.edited === null || result.before === null) {
    return reject(alert.symbol, alertId, `Not edited: ${result.rejectedReason ?? "unknown reason"}`);
  }
  const replaced = result.replaced
    ? ` Cancelled alert ${result.replaced.id} (${describeAlertCondition(result.replaced)}): the new level is closer to price on the same side.`
    : "";
  let closed = "";
  if (revisitId !== null && revisitId !== "") {
    // Same pair `alert revisit apply` records, so the ticker story can say
    // what the level moved from and to. Both null for a non-level edit.
    const from = result.before.kind === "static" ? result.before.level : null;
    const to = result.edited.kind === "static" ? result.edited.level : null;
    resolveRevisit(revisitsFile, revisitId, "applied", { from: from === to ? null : from, to: from === to ? null : to });
    closed = ` Revisit ${revisitId} marked applied.`;
  }
  return {
    symbol: alert.symbol,
    alertId,
    ok: true,
    message: `Edited ${alert.kind} alert ${alertId}: was "${describeAlertCondition(result.before)}", now "${describeAlertCondition(result.edited)}".${replaced}${closed}`,
  };
}
