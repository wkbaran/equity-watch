/**
 * Applies one order op: the only code that sends orders to Webull
 * (docs/WEBULL_SYNC_PLAN.md, phases 4-6). Run by `orders watch`, never by
 * `ops pull`.
 *
 * Every op passes the same gate first, in this order, and is refused at the
 * first that fails:
 *   1. WEBULL_ORDERS=on (the kill switch);
 *   2. a valid, unused authenticator code (params.code);
 *   3. an account WEBULL_ACCOUNTS maps and ORDERS_ACCOUNTS allows;
 *   4. under ORDERS_MAX_PER_DAY orders sent today.
 * Then each type reads the account fresh from Webull (positions, cash, open
 * orders: never the last sync's copy, which can be 15 minutes old) and checks
 * its own rules before anything is sent.
 *
 * Messages are published (opResults), so they name the symbol and nothing
 * else: no account, count or price. `detail` says exactly what was sent and
 * travels only in the sealed orders.json and the local orders log.
 */

import { createHash } from "node:crypto";
import { holdingKey, type HoldingsStore } from "../holdings/models.js";
import { loadHoldingsStore } from "../holdings/store.js";
import type { Op, Outcome } from "../ops/apply.js";
import { stringField } from "../ops/validate.js";
import {
  WORKING_STATUSES,
  WebullError,
  type NewOrder,
  type OrderChange,
  type OrderPlaced,
  type OrderPreview,
  type WebullBalance,
  type WebullOrder,
  type WebullPosition,
} from "../providers/webull.js";
import { MARKET_TIME_ZONE, wallClock } from "../timezone.js";
import { loadOrdersState, saveOrdersState, type OrdersConfig } from "./config.js";
import { verifyTotp } from "./totp.js";

export { ORDER_OP_TYPES, isOrderOp, type OrderOpType } from "../ops/orderTypes.js";

/** The Webull calls an order needs; WebullClient has them, tests fake them. */
export interface OrderClient {
  positions(accountId: string): Promise<WebullPosition[]>;
  balance(accountId: string): Promise<WebullBalance>;
  openOrders(accountId: string): Promise<WebullOrder[]>;
  orderDetail(accountId: string, clientOrderId: string): Promise<WebullOrder[]>;
  previewOrder(accountId: string, order: NewOrder): Promise<OrderPreview>;
  placeOrders(accountId: string, orders: NewOrder[], clientComboOrderId?: string): Promise<OrderPlaced>;
  replaceOrder(accountId: string, change: OrderChange): Promise<OrderPlaced>;
  cancelOrder(accountId: string, clientOrderId: string): Promise<OrderPlaced>;
}

export interface OrderContext {
  client: OrderClient;
  /** Lot label -> Webull account id (WEBULL_ACCOUNTS). */
  accountIds: Map<string, string>;
  holdingsFile: string;
  config: OrdersConfig;
  stateFile: string;
  /** cashEquivalents from the config; the first held one funds buys and covers margin. */
  cashEquivalents: string[];
  /** A last price for a symbol Webull doesn't hold here (Schwab); null when there is none. */
  quote(symbol: string): Promise<number | null>;
  /** The current bid and ask (Schwab), which BIL is bought and sold at; null when either is missing. */
  bidAsk(symbol: string): Promise<{ bid: number; ask: number } | null>;
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export interface OrderOutcome extends Outcome {
  /** Private: what was sent and what came back. Never published unsealed. */
  detail: string;
}

/** A buy or sell limit this far from the last price is refused as a likely typo. */
export const FAT_FINGER = 0.2;
/** How long a Roth buy waits for the BIL sale funding it to fill. */
export const FUNDING_WAIT_MS = 3 * 60 * 1000;
const FUNDING_POLL_MS = 5000;

const ok = (symbol: string | null, message: string, detail: string): OrderOutcome => ({ symbol, alertId: null, ok: true, message, detail });
const no = (symbol: string | null, message: string, detail = ""): OrderOutcome => ({ symbol, alertId: null, ok: false, message, detail: detail || message });

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function numField(value: unknown, key: string): number | null {
  const v = field(value, key);
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** A price as Webull takes it: cents at $1 and over, four places under. */
export function px(n: number): string {
  return n >= 1 ? n.toFixed(2) : n.toFixed(4);
}

/** Rounds to the tick the price will be sent at, so guards judge the price Webull gets. */
function tick(n: number): number {
  return Number(px(n));
}

/**
 * A client order id from the op id and the order's role in it: 32 characters,
 * Webull's maximum, and the same every time the op is applied. Webull refuses a
 * repeated client id, and each send first looks the id up, so a redelivered
 * op (a crash after Webull accepted it) can't place a second order.
 */
export function clientOrderId(opId: string, role: string): string {
  return `ew${createHash("sha256").update(`${opId}:${role}`).digest("hex").slice(0, 30)}`;
}

/** Regular session, Monday to Friday 09:30-16:00 New York. Holidays aren't known here; Webull refuses those. */
export function inRegularSession(now: Date): boolean {
  const w = wallClock(now, MARKET_TIME_ZONE);
  const day = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
  const minute = w.hour * 60 + w.minute;
  return day >= 1 && day <= 5 && minute >= 9 * 60 + 30 && minute < 16 * 60;
}

function newOrder(
  id: string,
  symbol: string,
  side: "BUY" | "SELL",
  type: NewOrder["order_type"],
  quantity: number,
  prices: { limit?: number; stop?: number },
  tif: "DAY" | "GTC",
  session: "CORE" | "ALL",
  combo: NewOrder["combo_type"] = "NORMAL"
): NewOrder {
  return {
    client_order_id: id,
    combo_type: combo,
    symbol,
    instrument_type: "EQUITY",
    market: "US",
    side,
    order_type: type,
    quantity: String(quantity),
    time_in_force: tif,
    support_trading_session: session,
    entrust_type: "QTY",
    ...(prices.limit !== undefined ? { limit_price: px(prices.limit) } : {}),
    ...(prices.stop !== undefined ? { stop_price: px(prices.stop) } : {}),
  };
}

function describe(o: NewOrder): string {
  const price = [o.stop_price !== undefined ? `stop ${o.stop_price}` : "", o.limit_price !== undefined ? `limit ${o.limit_price}` : ""].filter(Boolean).join(" ");
  return `${o.side.toLowerCase()} ${o.quantity} ${o.symbol} ${o.order_type.toLowerCase()}${price ? ` ${price}` : ""} ${o.time_in_force} ${o.support_trading_session} (${o.client_order_id})`;
}

/** What one account looks like right now. */
interface Account {
  label: string;
  id: string;
  type: string;
  positions: WebullPosition[];
  balance: WebullBalance;
  open: WebullOrder[];
}

async function readAccount(ctx: OrderContext, label: string, id: string, store: HoldingsStore): Promise<Account> {
  const [positions, balance, open] = [await ctx.client.positions(id), await ctx.client.balance(id), await ctx.client.openOrders(id)];
  const type = store.webull?.accounts.find((a) => a.label === label)?.accountType ?? "";
  return { label, id, type, positions, balance, open: open.filter((o) => WORKING_STATUSES.has(o.status)) };
}

function held(account: Account, symbol: string): WebullPosition | undefined {
  return account.positions.find((p) => p.symbol === symbol && (p.instrumentType === "EQUITY" || p.instrumentType === "STOCK"));
}

/** Shares of `symbol` already promised to working sell orders, leaving out `except` (the order being changed). */
function promised(account: Account, symbol: string, except?: string): number {
  return account.open
    .filter((o) => o.symbol === symbol && o.side === "SELL" && o.clientOrderId !== except)
    .reduce((n, o) => n + Math.max(0, o.totalQuantity - o.filledQuantity), 0);
}

/** Whole shares that may still be sold: a stop or sell can't be for a fraction (Webull), or for shares another sell has. */
function sellable(account: Account, symbol: string, except?: string): number {
  const p = held(account, symbol);
  return p === undefined ? 0 : Math.max(0, Math.floor(p.quantity + 1e-9) - Math.ceil(promised(account, symbol, except) - 1e-9));
}

function wholeShares(n: number | null): n is number {
  return n !== null && Number.isInteger(n) && n >= 1;
}

/** The first cash equivalent held in the account, which funds buys and covers margin. */
function parking(ctx: OrderContext, account: Account): WebullPosition | undefined {
  for (const symbol of ctx.cashEquivalents) {
    const p = held(account, symbol);
    if (p !== undefined && p.quantity >= 1) {
      return p;
    }
  }
  return undefined;
}

/**
 * The price a cash equivalent trades at here: bought at the ask, sold at the
 * bid (the user's rule, 2026-10-26), so it fills without paying past the
 * spread. Null with no quote, or one too far from the last price to trust.
 */
async function bilPrice(ctx: OrderContext, symbol: string, side: "BUY" | "SELL", last: number | null): Promise<number | null> {
  const quote = await ctx.bidAsk(symbol);
  const price = quote === null ? null : side === "BUY" ? quote.ask : quote.bid;
  if (price === null || !(price > 0)) return null;
  if (last !== null && last > 0 && Math.abs(price - last) > last * FAT_FINGER) return null;
  return tick(price);
}

export async function applyOrderOp(op: Op, ctx: OrderContext): Promise<OrderOutcome> {
  const symbol = stringField(op.target, "symbol")?.trim().toUpperCase() || null;
  if (!ctx.config.enabled) {
    return no(symbol, "Not sent: orders are switched off (WEBULL_ORDERS).");
  }
  if (ctx.config.totpSecret === null) {
    return no(symbol, "Not sent: no authenticator is set up for orders (ORDERS_TOTP_SECRET).");
  }

  const state = loadOrdersState(ctx.stateFile);
  const used = new Set(state.usedTotpSteps);
  const code = field(op.params, "code");
  const verified = verifyTotp(ctx.config.totpSecret, typeof code === "string" ? code.trim() : "", ctx.now(), used);
  if (!verified.ok) {
    return no(symbol, `Not sent: ${verified.reason}`);
  }
  // Spent before anything is sent, so the code can't be replayed even if this op fails later.
  state.usedTotpSteps = [...used, verified.step].sort((a, b) => b - a).slice(0, 20);
  saveOrdersState(ctx.stateFile, state);

  const label = stringField(op.target, "account")?.trim() ?? "";
  const accountId = ctx.accountIds.get(label);
  if (accountId === undefined || (ctx.config.accounts !== null && !ctx.config.accounts.has(label))) {
    return no(symbol, "Not sent: that account isn't one orders may be placed in.");
  }
  const today = wallClock(ctx.now(), MARKET_TIME_ZONE);
  const day = `${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`;
  const sentToday = state.day === day ? state.sentToday : 0;
  const counts = op.type !== "stop.cancel" && op.type !== "order.cancel";
  if (counts && sentToday >= ctx.config.maxPerDay) {
    return no(symbol, "Not sent: today's order limit (ORDERS_MAX_PER_DAY) is reached.");
  }

  const store = loadHoldingsStore(ctx.holdingsFile);
  let outcome: OrderOutcome;
  try {
    const account = await readAccount(ctx, label, accountId, store);
    outcome = await byType(op, ctx, account, store, symbol);
  } catch (err) {
    if (err instanceof WebullError && err.status !== 0 && err.status !== 429 && err.status < 500) {
      // Webull refused the order itself (buying power, a halted symbol, a bad
      // price): a result, not a reason to retry.
      return no(symbol, "Not sent: Webull refused it.", err.message);
    }
    throw err;
  }
  if (outcome.ok && counts) {
    const after = loadOrdersState(ctx.stateFile);
    saveOrdersState(ctx.stateFile, { ...after, day, sentToday: (after.day === day ? after.sentToday : 0) + 1 });
  }
  return outcome;
}

async function byType(op: Op, ctx: OrderContext, account: Account, store: HoldingsStore, symbol: string | null): Promise<OrderOutcome> {
  switch (op.type) {
    case "stop.place":
      return placeStop(op, ctx, account, store, symbol);
    case "stop.replace":
    case "order.replace":
      return replace(op, ctx, account, symbol);
    case "stop.cancel":
    case "order.cancel":
      return cancel(op, ctx, account, symbol);
    case "cash.cover":
      return cover(op, ctx, account);
    case "cash.park":
      return park(op, ctx, account);
    case "order.sell":
      return sell(op, ctx, account, symbol);
    case "order.buy":
      return buy(op, ctx, account, symbol);
    default:
      return no(symbol, `${op.type} is not an order op.`);
  }
}

/**
 * Places `orders` unless a crash already did: the first client id is looked up
 * before sending, and an order Webull already has is reported as placed.
 */
async function placeOnce(ctx: OrderContext, account: Account, orders: NewOrder[], combo?: string): Promise<{ placed: OrderPlaced; already: boolean }> {
  const existing = await ctx.client.orderDetail(account.id, orders[0].client_order_id).catch(() => []);
  if (existing.some((o) => o.orderId)) {
    return { placed: { orderId: existing[0].orderId, clientOrderId: orders[0].client_order_id, comboOrderId: null }, already: true };
  }
  return { placed: await ctx.client.placeOrders(account.id, orders, combo), already: false };
}

function sentText(orders: NewOrder[], placed: OrderPlaced, already: boolean): string {
  return `${already ? "already placed (redelivered op): " : "placed: "}${orders.map(describe).join(" + ")} -> order ${placed.orderId ?? "?"}`;
}

async function placeStop(op: Op, ctx: OrderContext, account: Account, store: HoldingsStore, symbol: string | null): Promise<OrderOutcome> {
  if (symbol === null) {
    return no(null, "A stop needs target.symbol.");
  }
  const record = (store.holdings ?? []).find((h) => holdingKey(h.account, h.symbol) === holdingKey(account.label, symbol));
  if (record?.source !== "webull") {
    return no(symbol, `Not placed: ${symbol} in that account isn't kept by the Webull sync. Link or adopt it first.`);
  }
  const position = held(account, symbol);
  if (position === undefined) {
    return no(symbol, `Not placed: Webull holds no ${symbol} in that account.`);
  }
  const quantity = numField(op.params, "quantity");
  const stopRaw = numField(op.params, "stopPrice");
  const limitRaw = numField(op.params, "limitPrice");
  if (!wholeShares(quantity)) {
    return no(symbol, "Not placed: a stop is for whole shares, 1 or more.");
  }
  const free = sellable(account, symbol);
  if (quantity > free) {
    return no(symbol, `Not placed: that is more ${symbol} shares than are held and not already in another sell order.`, `quantity ${quantity}, sellable ${free}`);
  }
  if (stopRaw === null || stopRaw <= 0) {
    return no(symbol, "Not placed: the stop needs a price above 0.");
  }
  const stop = tick(stopRaw);
  if (stop >= position.lastPrice) {
    return no(symbol, `Not placed: a sell stop must be under ${symbol}'s last price, or it would trigger at once.`, `stop ${stop}, last ${position.lastPrice}`);
  }
  if (limitRaw !== null && tick(limitRaw) > stop) {
    return no(symbol, "Not placed: a stop-limit's limit must be at or under its stop.");
  }
  const order = newOrder(
    clientOrderId(op.id, "stop"),
    symbol,
    "SELL",
    limitRaw !== null ? "STOP_LOSS_LIMIT" : "STOP_LOSS",
    quantity,
    { stop, ...(limitRaw !== null ? { limit: tick(limitRaw) } : {}) },
    "GTC",
    "CORE"
  );
  const { placed, already } = await placeOnce(ctx, account, [order]);
  return ok(symbol, `Placed a stop order for ${symbol}.`, sentText([order], placed, already));
}

async function replace(op: Op, ctx: OrderContext, account: Account, symbol: string | null): Promise<OrderOutcome> {
  const target = stringField(op.target, "clientOrderId")?.trim() ?? "";
  const order = account.open.find((o) => o.clientOrderId === target);
  const name = symbol ?? order?.symbol ?? null;
  if (order === undefined) {
    return no(name, "Not changed: that order isn't open any more (filled, cancelled, or placed without a client id).");
  }
  const stopOp = op.type === "stop.replace";
  const isStop = order.side === "SELL" && ["STOP_LOSS", "STOP_LOSS_LIMIT"].includes(order.orderType);
  if (stopOp !== isStop || order.orderType === "TRAILING_STOP_LOSS") {
    return no(order.symbol, stopOp ? "Not changed: that order isn't a sell stop." : "Not changed: use stop.replace for a stop order.");
  }
  // The guard: the order still looks the way the page showed it.
  const expectQty = numField(op.expect, "quantity");
  const expectPrice = numField(op.expect, stopOp ? "stopPrice" : "limitPrice");
  const remaining = order.totalQuantity - order.filledQuantity;
  const shown = stopOp ? order.stopPrice : order.limitPrice;
  if (expectQty === null || Math.abs(expectQty - remaining) > 1e-9 || expectPrice === null || shown === null || Math.abs(expectPrice - shown) > 1e-9) {
    return no(order.symbol, `Not changed: that ${order.symbol} order changed since the page loaded.`);
  }
  const quantity = numField(op.params, "quantity") ?? remaining;
  const newStop = numField(op.params, "stopPrice");
  const newLimit = numField(op.params, "limitPrice");
  if (!wholeShares(quantity)) {
    return no(order.symbol, "Not changed: orders here are for whole shares, 1 or more.");
  }
  if (order.side === "SELL" && quantity > sellable(account, order.symbol, order.clientOrderId ?? undefined)) {
    return no(order.symbol, `Not changed: that is more ${order.symbol} shares than are held and not in another sell order.`);
  }
  const position = held(account, order.symbol);
  const last = position?.lastPrice ?? (await ctx.quote(order.symbol));
  if (isStop && newStop !== null && last !== null && tick(newStop) >= last) {
    return no(order.symbol, `Not changed: a sell stop must stay under ${order.symbol}'s last price.`);
  }
  if (!isStop && newLimit !== null) {
    const bad = fatFinger(order.side === "BUY" ? "BUY" : "SELL", tick(newLimit), last);
    if (bad !== null) return no(order.symbol, bad);
  }
  const change: OrderChange = {
    client_order_id: target,
    quantity: String(quantity),
    ...(newStop !== null ? { stop_price: px(newStop) } : {}),
    ...(newLimit !== null ? { limit_price: px(newLimit) } : {}),
  };
  const placed = await ctx.client.replaceOrder(account.id, change);
  return ok(order.symbol, `Changed the ${order.symbol} order.`, `replaced ${target}: ${JSON.stringify(change)} -> order ${placed.orderId ?? order.orderId}`);
}

async function cancel(op: Op, ctx: OrderContext, account: Account, symbol: string | null): Promise<OrderOutcome> {
  const target = stringField(op.target, "clientOrderId")?.trim() ?? "";
  const order = account.open.find((o) => o.clientOrderId === target);
  if (order === undefined) {
    return no(symbol, "Not cancelled: that order isn't open any more.");
  }
  if (op.type === "stop.cancel") {
    const expectPrice = numField(op.expect, "stopPrice");
    if (expectPrice === null || order.stopPrice === null || Math.abs(expectPrice - order.stopPrice) > 1e-9) {
      return no(order.symbol, `Not cancelled: that ${order.symbol} stop changed since the page loaded.`);
    }
  }
  await ctx.client.cancelOrder(account.id, target);
  return ok(order.symbol, `Cancelled the ${order.symbol} order.`, `cancelled ${target} (order ${order.orderId}: ${order.side.toLowerCase()} ${order.totalQuantity - order.filledQuantity} ${order.orderType.toLowerCase()})`);
}

/** Null when the limit is sane; otherwise why not. With no last price, nothing to judge against. */
function fatFinger(side: "BUY" | "SELL", limit: number, last: number | null): string | null {
  if (!(limit > 0)) return "Not sent: the limit price must be above 0.";
  if (last === null || !(last > 0)) return null;
  if (side === "BUY" && limit > last * (1 + FAT_FINGER)) return `Not sent: a buy limit more than ${FAT_FINGER * 100}% over the last price looks like a typo.`;
  if (side === "SELL" && limit < last * (1 - FAT_FINGER)) return `Not sent: a sell limit more than ${FAT_FINGER * 100}% under the last price looks like a typo.`;
  return null;
}

/** "Sell BIL to cover": exactly enough whole BIL shares to bring a margin account's negative cash back to zero. */
async function cover(op: Op, ctx: OrderContext, account: Account): Promise<OrderOutcome> {
  if (account.type !== "MARGIN") {
    return no(null, "Not sent: only a margin account borrows, so only one needs covering.");
  }
  const cash = account.balance.cash;
  if (!(cash < 0)) {
    return no(null, "Not sent: cash isn't negative now, so there is nothing to cover.");
  }
  const bil = parking(ctx, account);
  if (bil === undefined) {
    return no(null, "Not sent: the account holds no cash equivalent to sell.");
  }
  if (account.open.some((o) => o.symbol === bil.symbol && o.side === "SELL")) {
    return no(bil.symbol, `Not sent: a ${bil.symbol} sell order is already working.`);
  }
  if (!inRegularSession(ctx.now())) {
    return no(bil.symbol, "Not sent: the regular session is closed. Try again during market hours.");
  }
  const bid = await bilPrice(ctx, bil.symbol, "SELL", bil.lastPrice);
  if (bid === null) {
    return no(bil.symbol, `Not sent: there is no usable ${bil.symbol} bid to sell at.`);
  }
  const quantity = Math.min(Math.ceil(-cash / bid), Math.floor(bil.quantity + 1e-9));
  const order = newOrder(clientOrderId(op.id, "cover"), bil.symbol, "SELL", "LIMIT", quantity, { limit: bid }, "DAY", "CORE");
  const { placed, already } = await placeOnce(ctx, account, [order]);
  const short = quantity * bid < -cash ? ` That is all of it, and still short ${(-cash - quantity * bid).toFixed(2)}.` : "";
  return ok(bil.symbol, `Selling ${bil.symbol} to cover the margin debit.`, `${sentText([order], placed, already)}; cash ${cash}.${short}`);
}

/**
 * "Move to BIL": as many whole shares of the cash equivalent as the cash buys
 * at the ask, less what working buy orders already have, and no more than
 * ORDERS_MAX_VALUE. Never borrows: whole shares at the ask fit inside the cash.
 */
async function park(op: Op, ctx: OrderContext, account: Account): Promise<OrderOutcome> {
  const symbol = parking(ctx, account)?.symbol ?? ctx.cashEquivalents[0];
  if (symbol === undefined) {
    return no(null, "Not sent: no cash equivalent is configured (cashEquivalents).");
  }
  if (account.open.some((o) => o.symbol === symbol && o.side === "BUY")) {
    return no(symbol, `Not sent: a ${symbol} buy order is already working.`);
  }
  if (!inRegularSession(ctx.now())) {
    return no(symbol, "Not sent: the regular session is closed. Try again during market hours.");
  }
  const ask = await bilPrice(ctx, symbol, "BUY", held(account, symbol)?.lastPrice ?? null);
  if (ask === null) {
    return no(symbol, `Not sent: there is no usable ${symbol} ask to buy at.`);
  }
  const committed = account.open
    .filter((o) => o.side === "BUY")
    .reduce((sum, o) => sum + Math.max(0, o.totalQuantity - o.filledQuantity) * (o.limitPrice ?? 0), 0);
  const spare = account.balance.cash - committed;
  const affordable = Math.floor(spare / ask + 1e-9);
  const allowed = Math.floor(ctx.config.maxValue / ask + 1e-9);
  const quantity = Math.min(affordable, allowed);
  if (quantity < 1) {
    return no(symbol, `Not sent: the spare cash doesn't buy a whole ${symbol} share.`, `cash ${account.balance.cash}, in buy orders ${committed.toFixed(2)}, ask ${ask}`);
  }
  const order = newOrder(clientOrderId(op.id, "park"), symbol, "BUY", "LIMIT", quantity, { limit: ask }, "DAY", "CORE");
  const { placed, already } = await placeOnce(ctx, account, [order]);
  const capped = allowed < affordable ? " (capped at the largest order allowed)" : "";
  return ok(symbol, `Buying ${symbol} with the spare cash${capped}.`, `${sentText([order], placed, already)}; cash ${account.balance.cash}, in buy orders ${committed.toFixed(2)}`);
}

async function sell(op: Op, ctx: OrderContext, account: Account, symbol: string | null): Promise<OrderOutcome> {
  if (symbol === null) {
    return no(null, "A sell needs target.symbol.");
  }
  const position = held(account, symbol);
  if (position === undefined) {
    return no(symbol, `Not sent: Webull holds no ${symbol} in that account.`);
  }
  const quantity = numField(op.params, "quantity");
  const limitRaw = numField(op.params, "limitPrice");
  if (!wholeShares(quantity)) {
    return no(symbol, "Not sent: orders here are for whole shares, 1 or more.");
  }
  if (quantity > sellable(account, symbol)) {
    return no(symbol, `Not sent: that is more ${symbol} shares than are held and not already in another sell order.`);
  }
  if (limitRaw === null) {
    return no(symbol, "Not sent: a sell needs a limit price (no market orders).");
  }
  const limit = tick(limitRaw);
  const bad = fatFinger("SELL", limit, position.lastPrice);
  if (bad !== null) return no(symbol, bad);
  const { tif, session } = timing(op.params);
  const order = newOrder(clientOrderId(op.id, "sell"), symbol, "SELL", "LIMIT", quantity, { limit }, tif, session);
  const { placed, already } = await placeOnce(ctx, account, [order]);
  return ok(symbol, `Placed a sell order for ${symbol}.`, sentText([order], placed, already));
}

function timing(params: unknown): { tif: "DAY" | "GTC"; session: "CORE" | "ALL" } {
  return { tif: field(params, "timeInForce") === "GTC" ? "GTC" : "DAY", session: field(params, "session") === "ALL" ? "ALL" : "CORE" };
}

/**
 * A limit buy, never on margin. Its cost (Webull's preview) must fit under
 * ORDERS_MAX_VALUE and inside cash + BIL. When cash alone is short, Fund from
 * BIL sells the difference first: alongside the buy in a margin account (both
 * settle T+1, so nothing is borrowed at settlement), and before it in a cash
 * account (the Roth), whose buy waits for the sale to fill or isn't placed.
 */
async function buy(op: Op, ctx: OrderContext, account: Account, symbol: string | null): Promise<OrderOutcome> {
  if (symbol === null) {
    return no(null, "A buy needs target.symbol.");
  }
  const quantity = numField(op.params, "quantity");
  const limitRaw = numField(op.params, "limitPrice");
  const stopRaw = numField(op.params, "stopPrice");
  if (!wholeShares(quantity)) {
    return no(symbol, "Not sent: orders here are for whole shares, 1 or more.");
  }
  if (limitRaw === null) {
    return no(symbol, "Not sent: a buy needs a limit price (no market orders).");
  }
  const limit = tick(limitRaw);
  const last = held(account, symbol)?.lastPrice ?? (await ctx.quote(symbol));
  if (last === null) {
    return no(symbol, `Not sent: there is no price for ${symbol} to check the limit against.`);
  }
  const bad = fatFinger("BUY", limit, last);
  if (bad !== null) return no(symbol, bad);
  if (stopRaw !== null && !(tick(stopRaw) < limit)) {
    return no(symbol, "Not sent: the attached stop must be under the buy's limit.");
  }
  const { tif, session } = timing(op.params);
  const main = newOrder(clientOrderId(op.id, "buy"), symbol, "BUY", "LIMIT", quantity, { limit }, tif, session, stopRaw !== null ? "MASTER" : "NORMAL");

  const preview = await ctx.client.previewOrder(account.id, { ...main, combo_type: "NORMAL" });
  const cost = Number.isFinite(preview.estimatedCost) && preview.estimatedCost > 0 ? preview.estimatedCost : quantity * limit;
  if (cost > ctx.config.maxValue) {
    return no(symbol, "Not sent: it costs more than the largest order allowed (ORDERS_MAX_VALUE).", `cost ${cost.toFixed(2)}, limit ${ctx.config.maxValue}`);
  }
  const cash = Math.max(0, account.balance.cash);
  const shortfall = cost - cash;
  const bil = parking(ctx, account);
  let funding = "";
  if (shortfall > 0) {
    const bilValue = bil === undefined ? 0 : Math.floor(bil.quantity + 1e-9) * bil.lastPrice;
    if (shortfall > bilValue) {
      return no(symbol, "Not sent: it costs more than the account's cash and BIL together, and orders here never borrow.", `cost ${cost.toFixed(2)}, cash ${cash}, BIL ${bilValue.toFixed(2)}`);
    }
    if (field(op.params, "fundFromBil") !== true) {
      return no(symbol, "Not sent: it costs more than the cash on hand. Tick Fund from BIL to sell the difference first.", `cost ${cost.toFixed(2)}, cash ${cash}`);
    }
    if (account.open.some((o) => o.symbol === bil!.symbol && o.side === "SELL")) {
      return no(symbol, `Not sent: a ${bil!.symbol} sell order is already working; let it finish first.`);
    }
    const bid = await bilPrice(ctx, bil!.symbol, "SELL", bil!.lastPrice);
    if (bid === null) {
      return no(symbol, `Not sent: there is no usable ${bil!.symbol} bid to sell at, so it can't be funded.`);
    }
    const bilShares = Math.min(Math.ceil(shortfall / bid), Math.floor(bil!.quantity + 1e-9));
    if (bilShares * bid < shortfall) {
      return no(symbol, "Not sent: it costs more than the account's cash and BIL together, and orders here never borrow.", `cost ${cost.toFixed(2)}, cash ${cash}, BIL at the bid ${(bilShares * bid).toFixed(2)}`);
    }
    const sale = newOrder(clientOrderId(op.id, "fund"), bil!.symbol, "SELL", "LIMIT", bilShares, { limit: bid }, "DAY", "CORE");
    const sold = await placeOnce(ctx, account, [sale]);
    funding = `${sentText([sale], sold.placed, sold.already)}; `;
    if (account.type !== "MARGIN") {
      const filled = await waitForFill(ctx, account, sale.client_order_id);
      if (!filled) {
        await ctx.client.cancelOrder(account.id, sale.client_order_id).catch(() => undefined);
        return no(symbol, `Not sent: the BIL sale funding it didn't fill in time, so it was cancelled and nothing was bought.`, `${funding}not filled in ${FUNDING_WAIT_MS / 1000}s; cancelled`);
      }
      funding += "filled; ";
    }
  }

  const orders = [main];
  let combo: string | undefined;
  if (stopRaw !== null) {
    orders.push(newOrder(clientOrderId(op.id, "stop"), symbol, "SELL", "STOP_LOSS", quantity, { stop: tick(stopRaw) }, "GTC", "CORE", "STOP_LOSS"));
    combo = clientOrderId(op.id, "combo");
  }
  const { placed, already } = await placeOnce(ctx, account, orders, combo);
  return ok(symbol, `Placed a buy order for ${symbol}${stopRaw !== null ? " with a stop" : ""}.`, `${funding}${sentText(orders, placed, already)}; est. cost ${cost.toFixed(2)}`);
}

async function waitForFill(ctx: OrderContext, account: Account, clientOrderIdValue: string): Promise<boolean> {
  const deadline = ctx.now().getTime() + FUNDING_WAIT_MS;
  while (ctx.now().getTime() < deadline) {
    await ctx.sleep(FUNDING_POLL_MS);
    const legs = await ctx.client.orderDetail(account.id, clientOrderIdValue).catch(() => []);
    const status = legs[0]?.status;
    if (status === "FILLED") return true;
    if (status === "CANCELLED" || status === "FAILED") return false;
  }
  return false;
}
