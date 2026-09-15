/**
 * Applies a change queued from the browser dashboard: add or edit an alert.
 *
 * The page can't write alerts.json, which lives on the machine running
 * `alert check`. It queues an op instead (see cloudformation.yaml, OpsQueue),
 * and `ops pull` applies it here through the same `addAlert`/`editAlert` and
 * the same validation (src/ops/validate.ts) the CLI uses.
 *
 * Idempotency comes from the op log, not from SQS. FIFO deduplication only
 * lasts five minutes, and an add is not idempotent: redelivering one after a
 * crash would add a second alert. So every result is appended to the log, and
 * an op id already there returns its logged result without applying again.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { describeAlertCondition } from "../alerts/describe.js";
import { addAlert, editAlert, type MarketData } from "../alerts/engine.js";
import { loadAlerts } from "../alerts/store.js";
import { addFieldsFromJson, editFieldsFromJson, parseAddInput, parseAlertEdit, type RawAddFields, type RawEditFields } from "./validate.js";

export const DEFAULT_OP_LOG = "ops.log.jsonl";

export interface AddOp {
  id: string;
  type: "alert.add";
  createdAt: string;
  params: RawAddFields;
}

export interface EditOp {
  id: string;
  type: "alert.edit";
  createdAt: string;
  target: { alertId: string };
  params: RawEditFields;
  /**
   * The condition text the page showed (alerts.json `condition`). If the alert
   * no longer reads the same, the edit is rejected rather than applied to an
   * alert that isn't the one that was on screen.
   */
  expect: { condition: string };
}

export type Op = AddOp | EditOp;

export interface OpResult {
  id: string;
  type: string;
  symbol: string | null;
  alertId: string | null;
  ok: boolean;
  message: string;
  appliedAt: string;
}

const OP_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** Shape-checks an op from the queue (or a file). */
export function parseOp(body: unknown): { ok: true; op: Op } | { ok: false; error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "An op must be a JSON object." };
  }
  const o = body as Record<string, unknown>;
  if (typeof o.id !== "string" || !OP_ID_RE.test(o.id)) {
    return { ok: false, error: "An op needs an id of 8-64 letters, digits, or dashes." };
  }
  const createdAt = typeof o.createdAt === "string" ? o.createdAt : new Date().toISOString();
  if (o.type === "alert.add") {
    const fields = addFieldsFromJson(o.params);
    return fields.ok ? { ok: true, op: { id: o.id, type: "alert.add", createdAt, params: fields.value } } : { ok: false, error: fields.error };
  }
  if (o.type === "alert.edit") {
    const target = o.target as Record<string, unknown> | undefined;
    const expect = o.expect as Record<string, unknown> | undefined;
    if (typeof target?.alertId !== "string" || target.alertId === "") {
      return { ok: false, error: "An edit needs target.alertId." };
    }
    if (typeof expect?.condition !== "string") {
      return { ok: false, error: "An edit needs expect.condition." };
    }
    const fields = editFieldsFromJson(o.params);
    return fields.ok
      ? {
          ok: true,
          op: { id: o.id, type: "alert.edit", createdAt, target: { alertId: target.alertId }, params: fields.value, expect: { condition: expect.condition } },
        }
      : { ok: false, error: fields.error };
  }
  return { ok: false, error: `Unknown op type "${String(o.type)}".` };
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
  const outcome = op.type === "alert.add" ? await applyAdd(op, ctx) : await applyEdit(op, ctx);
  const result: OpResult = { id: op.id, type: op.type, ...outcome, appliedAt: (ctx.now?.() ?? new Date()).toISOString() };
  appendOpResult(ctx.opLogFile, result);
  return { result, duplicate: false };
}

type Outcome = Omit<OpResult, "id" | "type" | "appliedAt">;

async function applyAdd(op: AddOp, ctx: ApplyContext): Promise<Outcome> {
  const symbol = typeof op.params.symbol === "string" ? op.params.symbol.trim().toUpperCase() || null : null;
  const parsed = parseAddInput(op.params);
  if (!parsed.ok) {
    return { symbol, alertId: null, ok: false, message: parsed.error };
  }
  const result = await addAlert(ctx.alertsFile, parsed.value, ctx.market);
  if (result.rejectedReason !== null || result.added === null) {
    return { symbol: parsed.value.symbol, alertId: null, ok: false, message: `Not added: ${result.rejectedReason ?? "unknown reason"}` };
  }
  const a = result.added;
  const replaced = result.replaced ? ` Replaced alert ${result.replaced.id} (${describeAlertCondition(result.replaced)}).` : "";
  return { symbol: a.symbol, alertId: a.id, ok: true, message: `Added ${a.kind} alert ${a.id}: ${describeAlertCondition(a)}.${replaced}` };
}

async function applyEdit(op: EditOp, ctx: ApplyContext): Promise<Outcome> {
  const alertId = op.target.alertId;
  // By id only. findAlert would also accept a ticker, and an edit aimed at one
  // alert must never land on another alert that happens to share its symbol.
  const alert = loadAlerts(ctx.alertsFile).find((a) => a.id === alertId);
  if (alert === undefined) {
    return { symbol: null, alertId, ok: false, message: `No alert with id ${alertId}. It may have been removed.` };
  }
  const now = describeAlertCondition(alert);
  if (now !== op.expect.condition) {
    return { symbol: alert.symbol, alertId, ok: false, message: `Not edited: the alert changed since the page loaded. It is now "${now}".` };
  }
  const parsed = parseAlertEdit(op.params);
  if (!parsed.ok) {
    return { symbol: alert.symbol, alertId, ok: false, message: parsed.error };
  }
  const result = await editAlert(ctx.alertsFile, alertId, parsed.value, ctx.market);
  if (result.rejectedReason !== null || result.edited === null || result.before === null) {
    return { symbol: alert.symbol, alertId, ok: false, message: `Not edited: ${result.rejectedReason ?? "unknown reason"}` };
  }
  const replaced = result.replaced
    ? ` Cancelled alert ${result.replaced.id} (${describeAlertCondition(result.replaced)}): the new level is closer to price on the same side.`
    : "";
  return {
    symbol: alert.symbol,
    alertId,
    ok: true,
    message: `Edited ${alert.kind} alert ${alertId}: was "${describeAlertCondition(result.before)}", now "${describeAlertCondition(result.edited)}".${replaced}`,
  };
}
