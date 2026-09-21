/**
 * Applies a change queued from the browser dashboard: add, edit, or remove an alert,
 * dismiss a revisit-queue entry, or add, edit, or remove a holdings lot,
 * position, or stop.
 *
 * The page can't write alerts.json or holdings.json, which live on the machine
 * running `alert check`. It queues an op instead (see infra/cloudformation.yaml,
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
import { closeRevisitsForEdit, loadRevisits, resolveRevisit } from "../alerts/revisitStore.js";
import { loadAlerts, saveAlerts } from "../alerts/store.js";
import type { Alert } from "../alerts/models.js";
import { applyHoldingsOp } from "./holdings.js";
import { addFieldsFromJson, editFieldsFromJson, parseAddInput, parseAlertEdit, stringField } from "./validate.js";

export const DEFAULT_OP_LOG = "ops.log.jsonl";
export const DEFAULT_HOLDINGS_FILE = "holdings.json";
export const DEFAULT_REVISITS_FILE = "revisits.json";

export const OP_TYPES = ["alert.add", "alert.edit", "alert.remove", "revisit.dismiss", "lot.add", "lot.edit", "lot.remove", "position.remove", "stop.add", "stop.remove"] as const;
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
  /** Default revisits.json. Read by a dismiss, and by an edit sent from a trigger's details panel. */
  revisitsFile?: string;
  opLogFile: string;
  market: MarketData;
  now?: () => Date;
  /**
   * Called with the symbol of every op that lands, so a symbol arriving here
   * for the first time gets its company profile cached without anyone
   * remembering to run `profile fetch`.
   *
   * The profile is what supplies the TradingView exchange prefix, and a symbol
   * added from the dashboard is exactly the case that had none: the chart link
   * would open whatever TradingView ranks first for the bare ticker until the
   * next manual fetch. A drain is also the right moment - it is the one place
   * a new symbol enters the stores.
   *
   * A callback rather than an FMP client so this module keeps no provider
   * knowledge and tests need no network. It must never throw: see the call.
   */
  ensureProfile?: (symbol: string) => Promise<void>;
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
        : op.type === "alert.remove"
          ? applyRemove(op, ctx)
          : op.type === "revisit.dismiss"
            ? applyDismiss(op, ctx)
            : applyHoldingsOp(op, ctx.holdingsFile ?? DEFAULT_HOLDINGS_FILE);
  const result: OpResult = { id: op.id, type: op.type, ...outcome, appliedAt: (ctx.now?.() ?? new Date()).toISOString() };
  appendOpResult(ctx.opLogFile, result);
  // After the result is logged, and swallowing everything. A chart link is
  // cosmetic; the op has already been applied and recorded, and letting a
  // profile lookup throw here would stop the drain and leave a message that
  // `applyOp` would only ever see again as a duplicate.
  if (result.ok && result.symbol !== null && ctx.ensureProfile !== undefined) {
    try {
      await ctx.ensureProfile(result.symbol);
    } catch {
      /* the symbol just keeps the bare chart link until the next profile fetch */
    }
  }
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

/**
 * The guard every op that changes an existing alert has to pass, in one place
 * because it is load-bearing and a second copy is a second thing to forget.
 *
 * Two rules it enforces. **By id only** - `findAlert` would also accept a
 * ticker, and an op aimed at one alert must never land on another that happens
 * to share its symbol. And **`expect.condition` must still match** what the
 * page was showing, so an op queued against a level that has since moved is one
 * clean rejection rather than a change applied to something else.
 *
 * Returns the loaded array as well as the alert: `applyRemove` writes the
 * filtered array straight back, and re-reading the file for it would be a
 * second read of something that must not change in between.
 */
function guardedAlert(
  op: Op,
  ctx: ApplyContext,
  verb: "edit" | "remove"
): { alerts: Alert[]; alert: Alert; condition: string } | Outcome {
  const article = verb === "edit" ? "An edit" : "A remove";
  const alertId = stringField(op.target, "alertId");
  if (alertId === null || alertId === "") {
    return reject(null, null, `${article} needs target.alertId.`);
  }
  const expected = stringField(op.expect, "condition");
  if (expected === null) {
    return reject(null, alertId, `${article} needs expect.condition.`);
  }
  const alerts = loadAlerts(ctx.alertsFile);
  const alert = alerts.find((a) => a.id === alertId);
  if (alert === undefined) {
    return reject(null, alertId, `No alert with id ${alertId}. It may ${verb === "remove" ? "already " : ""}have been removed.`);
  }
  const condition = describeAlertCondition(alert);
  if (condition !== expected) {
    const past = verb === "edit" ? "edited" : "removed";
    return reject(alert.symbol, alertId, `Not ${past}: the alert changed since the page loaded. It is now "${condition}".`);
  }
  return { alerts, alert, condition };
}

/** Narrows guardedAlert's union: an Outcome carries `ok`, the success shape doesn't. */
function guardFailed(result: ReturnType<typeof guardedAlert>): result is Outcome {
  return "ok" in result;
}

async function applyEdit(op: Op, ctx: ApplyContext): Promise<Outcome> {
  const guard = guardedAlert(op, ctx, "edit");
  if (guardFailed(guard)) {
    return guard;
  }
  const { alert, condition: now } = guard;
  const alertId = alert.id;
  // Any edit closes the alert's open queue entries (closeRevisitsForEdit). One
  // sent from a trigger's details panel also names its entry, which is checked
  // before the edit so a stale panel is one rejection and no half-done change,
  // rather than an alert moved on the strength of a fire already dealt with.
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
  const closedIds = closeRevisitsForEdit(revisitsFile, alertId, levelMove(result.before, result.edited), ctx.now?.() ?? new Date());
  const closed = closedIds.length === 0 ? "" : ` Revisit ${closedIds.join(", ")} marked applied.`;
  return {
    symbol: alert.symbol,
    alertId,
    ok: true,
    message: `Edited ${alert.kind} alert ${alertId}: was "${describeAlertCondition(result.before)}", now "${describeAlertCondition(result.edited)}".${replaced}${closed}`,
  };
}

/**
 * Deletes an alert, as `alert remove` does. Guarded like an edit: by id only,
 * never through findAlert's ticker lookup, and only while the alert still
 * reads as the page showed it, so a stale panel can't delete an alert that has
 * since been re-levelled into something else.
 */
function applyRemove(op: Op, ctx: ApplyContext): Outcome {
  const guard = guardedAlert(op, ctx, "remove");
  if (guardFailed(guard)) {
    return guard;
  }
  const { alerts, alert, condition: now } = guard;
  const alertId = alert.id;
  saveAlerts(ctx.alertsFile, alerts.filter((a) => a.id !== alertId));
  return { symbol: alert.symbol, alertId, ok: true, message: `Removed ${alert.kind} alert ${alertId} (${alert.symbol}: ${now}).` };
}

/**
 * Closes one revisit-queue entry without touching its alert, as
 * `alert revisit dismiss` does. The alert keeps its level and keeps watching,
 * and its next fire is a new entry. `target.alertId`, when sent, must match: a
 * queue row names both, and a mismatch means the page is looking at something
 * other than what is on disk.
 */
function applyDismiss(op: Op, ctx: ApplyContext): Outcome {
  const revisitId = stringField(op.target, "revisitId");
  if (revisitId === null || revisitId === "") {
    return reject(null, null, "A dismiss needs target.revisitId.");
  }
  const alertId = stringField(op.target, "alertId");
  const revisitsFile = ctx.revisitsFile ?? DEFAULT_REVISITS_FILE;
  const entry = loadRevisits(revisitsFile).find((e) => e.id === revisitId);
  if (entry === undefined) {
    return reject(null, alertId, `No revisit entry with id ${revisitId}.`);
  }
  if (alertId !== null && alertId !== "" && entry.alertId !== alertId) {
    return reject(entry.symbol, alertId, `Revisit ${revisitId} belongs to alert ${entry.alertId}, not ${alertId}.`);
  }
  if (entry.status !== "open") {
    return reject(entry.symbol, entry.alertId, `Revisit ${revisitId} is already ${entry.status}.`);
  }
  resolveRevisit(revisitsFile, revisitId, "dismissed");
  return {
    symbol: entry.symbol,
    alertId: entry.alertId,
    ok: true,
    message: `Dismissed revisit ${revisitId} (${entry.symbol}) from the queue. Alert ${entry.alertId} is unchanged and still watching.`,
  };
}

/**
 * The level pair an edit records on the entries it closes, the same pair
 * `alert revisit apply` writes, so the page and ticker story can say what
 * moved. Both null when the level didn't (a direction change, a trailing or
 * moving-average alert).
 */
export function levelMove(before: Alert, after: Alert): { from: number | null; to: number | null } {
  const from = before.kind === "static" ? before.level : null;
  const to = after.kind === "static" ? after.level : null;
  return from === to ? { from: null, to: null } : { from, to };
}
