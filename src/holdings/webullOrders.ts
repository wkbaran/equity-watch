/**
 * A local copy of each Webull account's order history, so a scheduled sync
 * reads only the last few days instead of everything since 2018.
 *
 * Kept per account in `.cache/webull/orders-<label>.json` (gitignored with the
 * rest of .cache/). Orders are merged by id, so a later read of an order (more
 * of it filled, or it was cancelled) replaces the earlier one. Each read goes
 * back `OVERLAP_DAYS` past the last one, because Webull says its history can lag
 * behind real time: an order that turns up late is still picked up. The sync
 * books by order id, so seeing an order twice never books it twice.
 *
 * Webull picks a read's orders by when they were placed, not when they last
 * changed, so a read also reaches back to the oldest order the cache still
 * holds as working. Without that a GTC stop placed a week ago and filled today
 * stayed "submitted" in the cache, and the sync flagged the vanished position
 * as unexplained instead of recording the sale (VYX and eight more, 2026-10-27).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WEBULL_HISTORY_START, WORKING_STATUSES, type WebullOrder } from "../providers/webull.js";

export const DEFAULT_ORDER_CACHE_DIR = join(".cache", "webull");

const OVERLAP_DAYS = 3;

export interface OrderCache {
  /** End of the last read, ISO. */
  readThrough: string;
  /** Start of the earliest read, ISO: fills before it were never seen. */
  readFrom: string;
  orders: WebullOrder[];
}

export function orderCachePath(dir: string, label: string): string {
  return join(dir, `orders-${label.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

export function loadOrderCache(path: string): OrderCache | null {
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf-8")) as OrderCache;
}

/** Every trade, with sizes and prices: as private as holdings.json, so user-readable only. */
export function saveOrderCache(path: string, cache: OrderCache): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Where the next read starts: the overlap before the last one ended, or earlier
 * when an order placed before that is still working, or the beginning of
 * history (or `from`) when there is no cache or a full read was asked for.
 */
export function nextReadStart(cache: OrderCache | null, from: string = WEBULL_HISTORY_START): string {
  if (cache === null) {
    return from;
  }
  let back = new Date(Date.parse(cache.readThrough) - OVERLAP_DAYS * 86_400_000).toISOString();
  for (const o of cache.orders) {
    if (WORKING_STATUSES.has(o.status) && o.placedAt !== null && o.placedAt < back) {
      back = o.placedAt;
    }
  }
  return back < from ? from : back;
}

/** The cache after a read of `[start, end]`: fresh orders replace cached ones with the same id. */
export function mergeOrders(cache: OrderCache | null, fresh: WebullOrder[], start: string, end: string): OrderCache {
  const byId = new Map<string, WebullOrder>();
  for (const o of cache?.orders ?? []) {
    byId.set(o.orderId, o);
  }
  for (const o of fresh) {
    byId.set(o.orderId, o);
  }
  const readFrom = cache === null || start < cache.readFrom ? start : cache.readFrom;
  return { readThrough: end, readFrom, orders: [...byId.values()] };
}
