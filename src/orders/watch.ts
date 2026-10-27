/**
 * `orders watch`: the always-on service that sends orders
 * (docs/WEBULL_SYNC_PLAN.md, the order path).
 *
 * It long-polls its own SQS queue, which the ops Lambda fills with order ops
 * only, so an order lands within seconds instead of at the next 15-minute
 * check. Ordinary edits stay on `ops pull`; the reason it has no watcher
 * (src/ops/pull.ts) doesn't apply to orders, which are time-sensitive.
 *
 * Each op is applied once: its result goes in the same op log `ops pull`
 * keeps, and an id already there is a duplicate. An op older than STALE_MS is
 * refused, never sent late. After each op the sealed status document
 * (orders.json) is rewritten and uploaded, which is how the page learns the
 * result before the next full publish.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { appendOpResult, loadOpLog, parseOp, type OpResult } from "../ops/apply.js";
import type { OpsQueue } from "../ops/pull.js";
import { sealJson, type VaultDocument } from "../web/vault.js";
import { applyOrderOp, isOrderOp, settleFollowUps, type OrderContext, type OrderOutcome } from "./execute.js";

/** An order op older than this when it arrives is refused: never act late on a decision made at another price. */
export const STALE_MS = 2 * 60 * 1000;
export const ORDERS_STATUS_FILE = "orders.json";
export const DEFAULT_ORDERS_LOG = "orders.log.jsonl";
/** How many results the status document keeps. */
const STATUS_KEEP = 25;

/** One order op's result as the page sees it, inside the sealed status document. */
export interface OrderStatus {
  id: string;
  type: string;
  symbol: string | null;
  account: string | null;
  ok: boolean;
  message: string;
  detail: string;
  at: string;
}

export interface WatchContext {
  order: OrderContext;
  queue: OpsQueue;
  opLogFile: string;
  ordersLogFile: string;
  /** The site directory the publisher syncs; orders.json lives there so a full publish keeps it. */
  siteDir: string;
  /** Seals the status document; the ops token, as for vault.json. Null: no status document. */
  vaultToken: string | null;
  upload(key: string, body: string): Promise<void>;
  log(line: string): void;
  heartbeatFile?: string;
}

function recentStatuses(path: string): OrderStatus[] {
  if (!existsSync(path)) {
    return [];
  }
  const out: OrderStatus[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as OrderStatus);
    } catch {
      /* torn line */
    }
  }
  return out.slice(-STATUS_KEEP).reverse();
}

/** Writes and uploads orders.json: the newest results, sealed like vault.json, since they carry sizes and prices. */
export async function publishStatus(ctx: WatchContext): Promise<void> {
  if (ctx.vaultToken === null) {
    return;
  }
  const doc = sealStatus(recentStatuses(ctx.ordersLogFile), ctx.vaultToken);
  const path = join(ctx.siteDir, ORDERS_STATUS_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const body = JSON.stringify(doc);
  writeFileSync(path, body);
  await ctx.upload(ORDERS_STATUS_FILE, body);
}

/** Same sealing as the vault (key from the ops token, AES-256-GCM), so the page opens it with the key it already has. */
export function sealStatus(results: OrderStatus[], token: string): VaultDocument {
  return sealJson({ results }, token);
}

/** Applies one queued message. Returns what happened, for the log. Throws (leaving it queued) only on a Webull or disk failure. */
export async function handleMessage(body: string, ctx: WatchContext): Promise<"applied" | "rejected" | "duplicate" | "malformed"> {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return "malformed";
  }
  const parsed = parseOp(raw);
  if (!parsed.ok) {
    return "malformed";
  }
  const op = parsed.op;
  if (loadOpLog(ctx.opLogFile).some((r) => r.id === op.id)) {
    return "duplicate";
  }
  const now = ctx.order.now();
  let outcome: OrderOutcome;
  if (!isOrderOp(op.type)) {
    outcome = { symbol: null, alertId: null, ok: false, message: `${op.type} isn't an order op; it belongs on the ops queue.`, detail: "" };
  } else if (now.getTime() - Date.parse(op.createdAt) > STALE_MS) {
    outcome = { symbol: null, alertId: null, ok: false, message: "Not sent: it arrived too late to act on. Place it again.", detail: `queued ${op.createdAt}, seen ${now.toISOString()}` };
  } else {
    outcome = await applyOrderOp(op, ctx.order);
  }
  const at = ctx.order.now().toISOString();
  const { detail, ...publicPart } = outcome;
  const result: OpResult = { id: op.id, type: op.type, ...publicPart, appliedAt: at };
  appendOpResult(ctx.opLogFile, result);
  const account = op.target !== null && typeof op.target === "object" ? (op.target as Record<string, unknown>).account : undefined;
  const status: OrderStatus = {
    id: op.id,
    type: op.type,
    symbol: outcome.symbol,
    account: typeof account === "string" ? account : null,
    ok: outcome.ok,
    message: outcome.message,
    detail,
    at,
  };
  mkdirSync(dirname(ctx.ordersLogFile), { recursive: true });
  appendFileSync(ctx.ordersLogFile, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  ctx.log(`${at} ${op.type} ${outcome.symbol ?? ""}: ${outcome.ok ? "ok" : "refused"}: ${outcome.message} ${detail}`);
  await publishStatus(ctx).catch((err: unknown) => ctx.log(`status upload failed: ${String(err)}`));
  return outcome.ok ? "applied" : "rejected";
}

/** How often pending stop follow-ups read their buys: Webull rate-limits, and a stop a minute late is fine. */
export const FOLLOW_UP_POLL_MS = 30_000;

/** Sets any stops whose buys have filled, and logs each like an order (id `<op id>:stop`). */
export async function runFollowUps(ctx: WatchContext): Promise<number> {
  const outcomes = await settleFollowUps(ctx.order);
  for (const o of outcomes) {
    const at = ctx.order.now().toISOString();
    const status: OrderStatus = { id: `${o.id}:stop`, type: "stop.followup", symbol: o.symbol, account: o.account, ok: o.ok, message: o.message, detail: o.detail, at };
    mkdirSync(dirname(ctx.ordersLogFile), { recursive: true });
    appendFileSync(ctx.ordersLogFile, `${JSON.stringify(status)}\n`, { mode: 0o600 });
    ctx.log(`${at} stop follow-up ${o.symbol ?? ""}: ${o.ok ? "ok" : "refused"}: ${o.message} ${o.detail}`);
  }
  if (outcomes.length > 0) {
    await publishStatus(ctx).catch((err: unknown) => ctx.log(`status upload failed: ${String(err)}`));
  }
  return outcomes.length;
}

/** The loop. Never returns unless `shouldStop` says so (tests); a failure waits and polls again. */
export async function watchOrders(ctx: WatchContext, shouldStop: () => boolean = () => false): Promise<void> {
  let followUpsAt = 0;
  while (!shouldStop()) {
    if (ctx.heartbeatFile !== undefined) {
      writeFileSync(ctx.heartbeatFile, new Date().toISOString());
    }
    if (ctx.order.now().getTime() - followUpsAt >= FOLLOW_UP_POLL_MS) {
      followUpsAt = ctx.order.now().getTime();
      await runFollowUps(ctx).catch((err: unknown) => ctx.log(`stop follow-ups failed: ${String(err)}`));
    }
    let messages;
    try {
      messages = await ctx.queue.receive(1, 20);
    } catch (err) {
      ctx.log(`receive failed: ${String(err)}`);
      await ctx.order.sleep(10_000);
      continue;
    }
    for (const m of messages) {
      try {
        await handleMessage(m.body, ctx);
        await ctx.queue.remove(m.receiptHandle);
      } catch (err) {
        // Left queued: it is redelivered after the visibility timeout, and the
        // op log and client order ids make a second try safe.
        ctx.log(`order op failed, left queued: ${String(err)}`);
        await ctx.order.sleep(10_000);
      }
    }
  }
}

export function s3Uploader(bucket: string, region: string, prefix = ""): (key: string, body: string) => Promise<void> {
  const client = new S3Client({ region });
  return async (key, body) => {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: prefix ? `${prefix}/${key}` : key,
        Body: body,
        ContentType: "application/json",
        // As the publisher sends everything: CloudFront revalidates, so the page's next poll sees it.
        CacheControl: "no-cache",
      })
    );
  };
}
