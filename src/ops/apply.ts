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
import { applyRelevelPatch, type RelevelPatch } from "../alerts/relevel.js";
import type { RevisitEntry } from "../alerts/revisit.js";
import { applyRevisitLevel, closeRevisitsForEdit, loadRevisits, resolveRevisit, saveRevisits } from "../alerts/revisitStore.js";
import { loadAlerts, saveAlerts } from "../alerts/store.js";
import type { Alert } from "../alerts/models.js";
import { applyHoldingsOp, applyCoverOp } from "./holdings.js";
import {
  addFieldsFromJson,
  editFieldsFromJson,
  parseAddInput,
  parseAlertEdit,
  parseRevisitApply,
  stringField,
} from "./validate.js";

export const DEFAULT_OP_LOG = "ops.log.jsonl";
export const DEFAULT_HOLDINGS_FILE = "holdings.json";
export const DEFAULT_REVISITS_FILE = "revisits.json";

export const OP_TYPES = ["alert.add", "alert.edit", "alert.remove", "revisit.relevel", "revisit.apply", "revisit.dismiss", "lot.add", "lot.edit", "lot.remove", "position.remove", "stop.add", "stop.edit", "stop.remove", "holdings.cover"] as const;
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
  /**
   * Re-levels and re-scores one open queue entry: fetch its symbol's daily
   * bars, then `relevelEntry`. A callback for the same reason `ensureProfile`
   * is one — this module stays free of provider knowledge and tests need no
   * network.
   *
   * **But absent means reject, not skip.** `ensureProfile` swallows everything
   * because a chart link is cosmetic and its op has already landed. This *is*
   * the op: someone asked for a suggestion and has to get an answer, so with no
   * market data configured `applyRelevel` returns a rejection saying so. Don't
   * copy the swallow from the call below this one.
   */
  relevel?: (entry: RevisitEntry) => Promise<RelevelPatch>;
  /**
   * Symbols the config says to leave alone (TuningConfig.ignoreSymbols), so a
   * queued `holdings.cover` refuses the same names the batch pass skips. A set
   * rather than a config path: this module reads stores, not settings.
   */
  ignored?: Set<string>;
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
  const outcome = await applyByType(op, ctx);
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

/**
 * The one place an op type picks its handler. A chain of ternaries stopped
 * being readable at ten types, and this has to stay exhaustive: a type in
 * OP_TYPES with no case here is accepted by `parseOp` and the Lambda and then
 * falls through to a rejection nobody expects.
 */
async function applyByType(op: Op, ctx: ApplyContext): Promise<Outcome> {
  switch (op.type) {
    case "alert.add":
      return applyAdd(op, ctx);
    case "alert.edit":
      return applyEdit(op, ctx);
    case "alert.remove":
      return applyRemove(op, ctx);
    case "revisit.relevel":
      return applyRelevel(op, ctx);
    case "revisit.apply":
      return applyApply(op, ctx);
    case "revisit.dismiss":
      return applyDismiss(op, ctx);
    case "holdings.cover":
      return applyCover(op, ctx);
    default:
      return applyHoldingsOp(op, ctx.holdingsFile ?? DEFAULT_HOLDINGS_FILE);
  }
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
  const { alert } = guard;
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
 * Re-levels and re-scores one open queue entry, as `alert revisit relevel`
 * does for the whole queue. Proposes only: the entry's `suggestedLevel` and
 * `priority` change and nothing else does, which is why this takes no
 * `expect`. A stale page costs nothing here — re-scoring an entry decides
 * nothing, and the answer is whatever the bars say now.
 */
async function applyRelevel(op: Op, ctx: ApplyContext): Promise<Outcome> {
  const revisitId = stringField(op.target, "revisitId");
  if (revisitId === null || revisitId === "") {
    return reject(null, null, "A re-level needs target.revisitId.");
  }
  const revisitsFile = ctx.revisitsFile ?? DEFAULT_REVISITS_FILE;
  const entries = loadRevisits(revisitsFile);
  const entry = entries.find((e) => e.id === revisitId);
  if (entry === undefined) {
    return reject(null, null, `No revisit entry with id ${revisitId}.`);
  }
  if (entry.status !== "open") {
    return reject(entry.symbol, entry.alertId, `Revisit ${revisitId} is already ${entry.status}.`);
  }
  // A follow-up is a later crossing folded onto the fire it follows; that fire
  // carries the level, so it is the one with something to propose.
  if (entry.followUpOf !== undefined) {
    return reject(
      entry.symbol,
      entry.alertId,
      `Revisit ${revisitId} is a later crossing of revisit ${entry.followUpOf}; re-level that one instead.`
    );
  }
  // Absent callback is a rejection, not a skip: see ApplyContext.relevel.
  if (ctx.relevel === undefined) {
    return reject(entry.symbol, entry.alertId, "Re-levelling needs daily bars, and no market data is configured.");
  }

  const patch = await ctx.relevel(entry);
  applyRelevelPatch(entry, patch);
  saveRevisits(revisitsFile, entries);
  const proposal =
    patch.suggestedLevel === null
      ? `no new level (${patch.suggestionBasis})`
      : `suggest ${patch.suggestedLevel} (${patch.suggestionBasis})`;
  return {
    symbol: entry.symbol,
    alertId: entry.alertId,
    ok: true,
    message: `Re-levelled revisit ${revisitId} (${entry.symbol}): ${proposal}. Priority ${patch.priority}.`,
  };
}

/**
 * Moves the alert onto the entry's suggested level and closes the entry, as
 * `alert revisit apply` does.
 *
 * Guarded on **both** `expect.condition` and `expect.suggestedLevel`. The
 * condition alone is the guard every other alert-changing op uses, and it is
 * not enough here: it catches the alert moving but not the *suggestion*
 * moving, so a `revisit.relevel` landing between the page rendering and the
 * click would apply a number nobody saw. `params.level` overrides the
 * suggestion, for editing it before taking it — the guard still covers what
 * was on screen either way.
 */
function applyApply(op: Op, ctx: ApplyContext): Outcome {
  const revisitId = stringField(op.target, "revisitId");
  if (revisitId === null || revisitId === "") {
    return reject(null, null, "An apply needs target.revisitId.");
  }
  const revisitsFile = ctx.revisitsFile ?? DEFAULT_REVISITS_FILE;
  const entry = loadRevisits(revisitsFile).find((e) => e.id === revisitId);
  if (entry === undefined) {
    return reject(null, null, `No revisit entry with id ${revisitId}.`);
  }
  const alertId = stringField(op.target, "alertId");
  if (alertId !== null && alertId !== "" && entry.alertId !== alertId) {
    return reject(entry.symbol, alertId, `Revisit ${revisitId} belongs to alert ${entry.alertId}, not ${alertId}.`);
  }

  const expected = op.expect;
  if (expected === null || typeof expected !== "object") {
    return reject(entry.symbol, entry.alertId, "An apply needs expect.condition and expect.suggestedLevel.");
  }
  const expectedLevel = (expected as Record<string, unknown>).suggestedLevel;
  if (expectedLevel !== entry.suggestedLevel) {
    return reject(
      entry.symbol,
      entry.alertId,
      `Not applied: the suggestion changed since the page loaded. It is now ${entry.suggestedLevel ?? "none"}.`
    );
  }
  const expectedCondition = stringField(expected, "condition");
  if (expectedCondition === null) {
    return reject(entry.symbol, entry.alertId, "An apply needs expect.condition.");
  }
  const alert = loadAlerts(ctx.alertsFile).find((a) => a.id === entry.alertId);
  if (alert === undefined) {
    return reject(entry.symbol, entry.alertId, `No alert with id ${entry.alertId}. It may have been removed.`);
  }
  const condition = describeAlertCondition(alert);
  if (condition !== expectedCondition) {
    return reject(entry.symbol, entry.alertId, `Not applied: the alert changed since the page loaded. It is now "${condition}".`);
  }

  const parsed = parseRevisitApply(op.params);
  if (!parsed.ok) {
    return reject(entry.symbol, entry.alertId, parsed.error);
  }
  const result = applyRevisitLevel(ctx.alertsFile, revisitsFile, revisitId, parsed.value.level);
  if (!result.ok) {
    return reject(entry.symbol, entry.alertId, `Not applied: ${result.reason}`);
  }
  const { from, to } = result.value;
  return {
    symbol: entry.symbol,
    alertId: entry.alertId,
    ok: true,
    message: `${entry.symbol}: alert ${entry.alertId} re-levelled ${from} → ${to}. Revisit ${revisitId} marked applied.`,
  };
}

/**
 * Gives one held position with no live alert a starting level, the atomic unit
 * of `holdings cover`.
 *
 * Self-guarding, and takes no `expect`: the rule *is* "this symbol has no live
 * alert", so re-checking the rule is a better conflict guard than anything the
 * page could assert about what it saw.
 *
 * Its message names the level, as an alert op's does rather than a holdings
 * op's — the alert it creates is published in the public alert book anyway, so
 * withholding the number here would hide nothing. What it never names is the
 * basis or the share count.
 */
function applyCover(op: Op, ctx: ApplyContext): Promise<Outcome> {
  return applyCoverOp(op, ctx.holdingsFile ?? DEFAULT_HOLDINGS_FILE, ctx.alertsFile, ctx.market, ctx.ignored ?? new Set());
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
