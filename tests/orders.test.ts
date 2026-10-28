import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { HoldingsStore } from "../src/holdings/models.js";
import { saveHoldingsStore } from "../src/holdings/store.js";
import { parseOp, type Op } from "../src/ops/apply.js";
import { loadOrdersState, ordersConfig, type OrdersConfig } from "../src/orders/config.js";
import { applyOrderOp, clientOrderId, inExtendedHours, inRegularSession, settleFollowUps, type OrderClient, type OrderContext } from "../src/orders/execute.js";
import { base32Decode, base32Encode, stepOf, totpAt, verifyTotp } from "../src/orders/totp.js";
import { handleMessage, type WatchContext } from "../src/orders/watch.js";
import type { NewOrder, OrderChange, WebullBalance, WebullOrder, WebullPosition } from "../src/providers/webull.js";
import { openVault } from "../src/web/vault.js";

describe("TOTP", () => {
  // RFC 6238 appendix B: the SHA-1 secret is ASCII "12345678901234567890".
  const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

  it("matches RFC 6238's test vectors (last 6 of the 8 digits)", () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(totpAt(RFC_SECRET, stepOf(new Date(59_000)))).toBe("287082");
    expect(totpAt(RFC_SECRET, stepOf(new Date(1111111109_000)))).toBe("081804");
    expect(totpAt(RFC_SECRET, stepOf(new Date(2000000000_000)))).toBe("279037");
    expect(base32Decode(RFC_SECRET).toString()).toBe("12345678901234567890");
  });

  it("accepts a step either side, once", () => {
    const now = new Date(1_800_000_000_000);
    const step = stepOf(now);
    const used = new Set<number>();
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), now, used)).toEqual({ ok: true, step: step - 1 });
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 2), now, used).ok).toBe(false);
    used.add(step);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step), now, used)).toMatchObject({ ok: false, reason: expect.stringContaining("already used") });
    expect(verifyTotp(RFC_SECRET, "12345", now, used).ok).toBe(false);
  });
});

describe("ordersConfig", () => {
  it("is off unless WEBULL_ORDERS=on, with defaults for the limits", () => {
    expect(ordersConfig({})).toMatchObject({ enabled: false, totpSecret: null, maxValue: 2000, maxPerDay: 10, accounts: null });
    expect(ordersConfig({ WEBULL_ORDERS: "ON", ORDERS_MAX_VALUE: "$5,000", ORDERS_ACCOUNTS: "margin, roth" })).toMatchObject({ enabled: true, maxValue: 5000 });
    expect(() => ordersConfig({ ORDERS_MAX_PER_DAY: "lots" })).toThrow(/ORDERS_MAX_PER_DAY/);
  });
});

describe("inRegularSession", () => {
  it("knows New York's regular hours on weekdays", () => {
    expect(inRegularSession(new Date("2026-10-26T15:00:00.000Z"))).toBe(true); // Monday 11:00 ET
    expect(inRegularSession(new Date("2026-10-26T13:00:00.000Z"))).toBe(false); // 09:00 ET
    expect(inRegularSession(new Date("2026-10-25T15:00:00.000Z"))).toBe(false); // Sunday
  });
});

describe("inExtendedHours", () => {
  it("runs 04:00-20:00 New York on weekdays", () => {
    expect(inExtendedHours(new Date("2026-10-26T08:00:00.000Z"))).toBe(true); // Monday 04:00 ET
    expect(inExtendedHours(new Date("2026-10-26T23:59:00.000Z"))).toBe(true); // 19:59 ET
    expect(inExtendedHours(new Date("2026-10-27T00:00:00.000Z"))).toBe(false); // 20:00 ET
    expect(inExtendedHours(new Date("2026-10-26T07:59:00.000Z"))).toBe(false); // 03:59 ET
    expect(inExtendedHours(new Date("2026-10-25T15:00:00.000Z"))).toBe(false); // Sunday
  });
});

// --- the order rules, against a fake Webull --------------------------------

const SECRET = base32Encode(Buffer.from("equity-watch-test-secret!"));
/** Monday 2026-10-26 11:00 New York: inside the regular session. */
const NOW = new Date("2026-10-26T15:00:00.000Z");

function position(symbol: string, quantity: number, lastPrice: number): WebullPosition {
  return { symbol, instrumentType: "EQUITY", quantity, costPrice: lastPrice, lastPrice };
}

function working(clientId: string, symbol: string, side: "BUY" | "SELL", orderType: string, qty: number, prices: { stop?: number; limit?: number } = {}): WebullOrder {
  return {
    orderId: `W-${clientId}`,
    clientOrderId: clientId,
    symbol,
    instrumentType: "EQUITY",
    side,
    status: "SUBMITTED",
    orderType,
    timeInForce: "GTC",
    totalQuantity: qty,
    filledQuantity: 0,
    filledPrice: null,
    limitPrice: prices.limit ?? null,
    stopPrice: prices.stop ?? null,
    trailingType: null,
    trailingStep: null,
    comboType: "NORMAL",
    placedAt: "2026-10-20T15:00:00.000Z",
    filledAt: null,
  };
}

interface Fake extends OrderClient {
  placed: { orders: NewOrder[]; combo?: string }[];
  replaced: OrderChange[];
  cancelled: string[];
  /** Status orderDetail reports for a client id, in order of calls; absent: unknown order. */
  /** Shares orderDetail reports filled for a client id; absent: none. */
  filled: Map<string, number>;
  detail: Map<string, string[]>;
}

function fakeClient(state: { positions: WebullPosition[]; cash: number; open?: WebullOrder[]; previewCost?: number; refuse?: boolean }): Fake {
  const fake: Fake = {
    placed: [],
    replaced: [],
    cancelled: [],
    detail: new Map(),
    filled: new Map(),
    positions: () => Promise.resolve(state.positions),
    balance: () => Promise.resolve({ cash: state.cash, settledCash: state.cash, unsettledCash: 0, buyingPower: null, marketValue: 0, netLiquidation: 0 } satisfies WebullBalance),
    openOrders: () => Promise.resolve(state.open ?? []),
    orderDetail: (_a, id) => {
      const statuses = fake.detail.get(id);
      if (statuses === undefined || statuses.length === 0) return Promise.reject(new Error("not found"));
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
      if (status === "NONE") return Promise.reject(new Error("not found"));
      return Promise.resolve([{ ...working(id, "X", "SELL", "LIMIT", 1), status, filledQuantity: fake.filled.get(id) ?? 0 }]);
    },
    previewOrder: (_a, o) => Promise.resolve({ estimatedCost: state.previewCost ?? Number(o.quantity) * Number(o.limit_price), estimatedFee: 0 }),
    placeOrders: async (_a, orders, combo) => {
      if (state.refuse) {
        const { WebullError } = await import("../src/providers/webull.js");
        throw new WebullError("Webull POST /trading/orders/place failed (400): insufficient buying power", 400);
      }
      fake.placed.push({ orders, ...(combo !== undefined ? { combo } : {}) });
      return { orderId: `W-${orders[0].client_order_id}`, clientOrderId: orders[0].client_order_id, comboOrderId: null };
    },
    replaceOrder: (_a, change) => (fake.replaced.push(change), Promise.resolve({ orderId: "W-r", clientOrderId: change.client_order_id, comboOrderId: null })),
    cancelOrder: (_a, id) => (fake.cancelled.push(id), Promise.resolve({ orderId: "W-c", clientOrderId: id, comboOrderId: null })),
  };
  return fake;
}

let dir: string;
let holdingsFile: string;
let seq = 0;

function store(accountType: "MARGIN" | "CASH" = "MARGIN", label = "margin"): HoldingsStore {
  return {
    lots: [{ id: "l1", symbol: "AAA", count: 10, basisPerShare: 40, purchaseDate: "2026-09-01", createdAt: "2026-09-01T15:00:00.000Z", account: label }],
    stops: [],
    alertState: [],
    holdings: [{ account: label, symbol: "AAA", source: "webull", linkedAt: "2026-10-01T00:00:00.000Z" }],
    webull: { readAt: "2026-10-26T14:45:00.000Z", accounts: [{ label, accountType, cash: null, cashStatus: "ok", lowCash: null, unmatched: [], links: [], flags: [], skipped: [] }] },
  };
}

function context(client: Fake, over: Partial<OrdersConfig> = {}, label = "margin"): OrderContext {
  return {
    client,
    accountIds: new Map([[label, `ID-${label}`]]),
    holdingsFile,
    config: { enabled: true, totpSecret: SECRET, maxValue: 2000, maxPerDay: 10, accounts: null, ...over },
    stateFile: join(dir, "orders-state.json"),
    cashEquivalents: ["BIL"],
    quote: () => Promise.resolve(50),
    bidAsk: () => Promise.resolve({ bid: 91.49, ask: 91.51 }),
    now: () => NOW,
    sleep: () => Promise.resolve(),
  };
}

/** An op as the Lambda would queue it, with a valid code for NOW unless one is given. */
function op(type: string, target: Record<string, unknown>, params: Record<string, unknown> = {}, expect?: Record<string, unknown>, code = totpAt(SECRET, stepOf(NOW))): Op {
  const parsed = parseOp({ id: `order-op-${String(++seq).padStart(4, "0")}`, type, createdAt: NOW.toISOString(), target, params: { code, ...params }, ...(expect ? { expect } : {}) });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.op;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orders-"));
  holdingsFile = join(dir, "holdings.json");
  saveHoldingsStore(holdingsFile, store());
});

describe("the gate every order passes", () => {
  it("sends nothing while orders are switched off", async () => {
    const client = fakeClient({ positions: [position("AAA", 10, 50)], cash: 1000 });
    const r = await applyOrderOp(op("stop.place", { account: "margin", symbol: "AAA" }, { quantity: 5, stopPrice: 45 }), context(client, { enabled: false }));
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("switched off") });
    expect(client.placed).toEqual([]);
  });

  it("needs a valid code, and spends it", async () => {
    const client = fakeClient({ positions: [position("AAA", 10, 50)], cash: 1000 });
    const ctx = context(client);
    expect((await applyOrderOp(op("stop.place", { account: "margin", symbol: "AAA" }, { quantity: 5, stopPrice: 45 }, undefined, "000000"), ctx)).ok).toBe(false);
    const first = op("stop.place", { account: "margin", symbol: "AAA" }, { quantity: 5, stopPrice: 45 });
    expect((await applyOrderOp(first, ctx)).ok).toBe(true);
    // The same code again: refused, nothing more sent.
    const again = await applyOrderOp(op("stop.place", { account: "margin", symbol: "AAA" }, { quantity: 1, stopPrice: 44 }), ctx);
    expect(again).toMatchObject({ ok: false, message: expect.stringContaining("already used") });
    expect(client.placed).toHaveLength(1);
  });

  it("refuses an account orders aren't allowed in, and stops at the daily limit", async () => {
    const client = fakeClient({ positions: [position("AAA", 10, 50)], cash: 1000 });
    expect((await applyOrderOp(op("stop.place", { account: "roth", symbol: "AAA" }, { quantity: 5, stopPrice: 45 }), context(client))).ok).toBe(false);
    const limited = context(client, { maxPerDay: 1 });
    // A refused op still spent its code, so the next one needs a new one.
    expect((await applyOrderOp(op("stop.place", { account: "margin", symbol: "AAA" }, { quantity: 5, stopPrice: 45 }, undefined, totpAt(SECRET, stepOf(NOW) - 1)), limited)).ok).toBe(true);
    const next = op("stop.place", { account: "margin", symbol: "AAA" }, { quantity: 1, stopPrice: 44 }, undefined, totpAt(SECRET, stepOf(NOW) + 1));
    expect(await applyOrderOp(next, limited)).toMatchObject({ ok: false, message: expect.stringContaining("today's order limit") });
  });

  it("reports Webull refusing an order as a result, not a crash", async () => {
    const client = fakeClient({ positions: [position("AAA", 10, 50)], cash: 1000, refuse: true });
    const r = await applyOrderOp(op("stop.place", { account: "margin", symbol: "AAA" }, { quantity: 5, stopPrice: 45 }), context(client));
    expect(r).toMatchObject({ ok: false, message: "Not sent: Webull refused it.", detail: expect.stringContaining("insufficient buying power") });
  });
});

describe("stops", () => {
  it("places a whole-share GTC sell stop under the price", async () => {
    const client = fakeClient({ positions: [position("AAA", 10.4, 50)], cash: 1000 });
    const o = op("stop.place", { account: "margin", symbol: "AAA" }, { quantity: 10, stopPrice: 45.123 });
    const r = await applyOrderOp(o, context(client));
    expect(r.ok).toBe(true);
    expect(r.message).not.toMatch(/\d/);
    expect(client.placed[0].orders).toEqual([
      expect.objectContaining({ client_order_id: clientOrderId(o.id, "stop"), side: "SELL", order_type: "STOP_LOSS", quantity: "10", stop_price: "45.12", time_in_force: "GTC", support_trading_session: "CORE" }),
    ]);
  });

  it("refuses a fraction, shares another sell holds, a stop at or over the price, and a holding the sync doesn't keep", async () => {
    const open = [working("ewother", "AAA", "SELL", "LIMIT", 4, { limit: 60 })];
    const client = fakeClient({ positions: [position("AAA", 10, 50)], cash: 1000, open });
    const ctx = context(client);
    let n = stepOf(NOW) - 1;
    const code = () => totpAt(SECRET, n++);
    expect((await applyOrderOp(op("stop.place", { account: "margin", symbol: "AAA" }, { quantity: 2.5, stopPrice: 45 }, undefined, code()), ctx)).ok).toBe(false);
    expect((await applyOrderOp(op("stop.place", { account: "margin", symbol: "AAA" }, { quantity: 7, stopPrice: 45 }, undefined, code()), ctx)).ok).toBe(false);
    expect((await applyOrderOp(op("stop.place", { account: "margin", symbol: "AAA" }, { quantity: 6, stopPrice: 50 }, undefined, code()), ctx)).ok).toBe(false);
    expect(client.placed).toEqual([]);
    saveHoldingsStore(holdingsFile, { ...store(), holdings: [] });
    expect((await applyOrderOp(op("stop.place", { account: "margin", symbol: "AAA" }, { quantity: 1, stopPrice: 45 }, undefined, totpAt(SECRET, stepOf(NOW) - 1)), context(client))).ok).toBe(false);
  });

  it("moves a stop only if it still looks as shown, and cancels one", async () => {
    const open = [working("ewstop1", "AAA", "SELL", "STOP_LOSS", 10, { stop: 44 })];
    const client = fakeClient({ positions: [position("AAA", 10, 50)], cash: 1000, open });
    const ctx = context(client);
    const stale = await applyOrderOp(op("stop.replace", { account: "margin", symbol: "AAA", clientOrderId: "ewstop1" }, { stopPrice: 46 }, { stopPrice: 43, quantity: 10 }, totpAt(SECRET, stepOf(NOW) - 1)), ctx);
    expect(stale).toMatchObject({ ok: false, message: expect.stringContaining("changed since") });
    const moved = await applyOrderOp(op("stop.replace", { account: "margin", symbol: "AAA", clientOrderId: "ewstop1" }, { stopPrice: 46 }, { stopPrice: 44, quantity: 10 }), ctx);
    expect(moved.ok).toBe(true);
    expect(client.replaced).toEqual([{ client_order_id: "ewstop1", quantity: "10", stop_price: "46.00" }]);
    const cancelled = await applyOrderOp(op("stop.cancel", { account: "margin", symbol: "AAA", clientOrderId: "ewstop1" }, {}, { stopPrice: 44 }, totpAt(SECRET, stepOf(NOW) + 1)), ctx);
    expect(cancelled.ok).toBe(true);
    expect(client.cancelled).toEqual(["ewstop1"]);
  });

  it("doesn't place twice when a crash left the order already at Webull", async () => {
    const client = fakeClient({ positions: [position("AAA", 10, 50)], cash: 1000 });
    const o = op("stop.place", { account: "margin", symbol: "AAA" }, { quantity: 5, stopPrice: 45 });
    client.detail.set(clientOrderId(o.id, "stop"), ["SUBMITTED"]);
    const r = await applyOrderOp(o, context(client));
    expect(r).toMatchObject({ ok: true, detail: expect.stringContaining("already placed") });
    expect(client.placed).toEqual([]);
  });
});

describe("Sell BIL to cover", () => {
  it("sells just enough whole BIL shares to bring margin cash back to zero", async () => {
    const client = fakeClient({ positions: [position("BIL", 100, 91.5)], cash: -450 });
    const r = await applyOrderOp(op("cash.cover", { account: "margin" }), context(client));
    expect(r.ok).toBe(true);
    // 450 / 91.49 = 4.92, so 5 shares, at the bid.
    expect(client.placed[0].orders[0]).toMatchObject({ symbol: "BIL", side: "SELL", order_type: "LIMIT", quantity: "5", limit_price: "91.49", time_in_force: "DAY" });
  });

  it("refuses with no bid, or one far from the last price, rather than pricing it another way", async () => {
    const client = fakeClient({ positions: [position("BIL", 100, 91.5)], cash: -450 });
    const none = { ...context(client), bidAsk: () => Promise.resolve(null) };
    expect(await applyOrderOp(op("cash.cover", { account: "margin" }), none)).toMatchObject({ ok: false, message: expect.stringContaining("no usable BIL bid") });
    const wild = { ...context(client), bidAsk: () => Promise.resolve({ bid: 0.01, ask: 91.51 }) };
    expect(await applyOrderOp(op("cash.cover", { account: "margin" }, {}, undefined, totpAt(SECRET, stepOf(NOW) + 1)), wild)).toMatchObject({ ok: false });
    expect(client.placed).toEqual([]);
  });
});

describe("Move to BIL", () => {
  it("buys the whole shares the spare cash covers at the ask, less working buys", async () => {
    const client = fakeClient({ positions: [position("BIL", 4, 91.5)], cash: 1249.4, open: [working("ewbuy", "NEW", "BUY", "LIMIT", 2, { limit: 100 })] });
    const r = await applyOrderOp(op("cash.park", { account: "margin" }), context(client));
    expect(r).toMatchObject({ ok: true, symbol: "BIL" });
    // (1249.40 - 200) / 91.51 = 11.47, so 11 shares at the ask.
    expect(client.placed[0].orders[0]).toMatchObject({ symbol: "BIL", side: "BUY", order_type: "LIMIT", quantity: "11", limit_price: "91.51", time_in_force: "DAY", support_trading_session: "CORE" });
  });

  it("caps at ORDERS_MAX_VALUE, and buys BIL in an account that holds none", async () => {
    const client = fakeClient({ positions: [], cash: 10_000 });
    const r = await applyOrderOp(op("cash.park", { account: "margin" }), context(client));
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("capped") });
    // 2000 / 91.51 = 21.9.
    expect(client.placed[0].orders[0]).toMatchObject({ symbol: "BIL", quantity: "21" });
  });

  it("goes out in extended hours after the close, and refuses a wide spread there", async () => {
    const after = new Date("2026-10-26T22:13:00.000Z"); // 18:13 ET
    const client = fakeClient({ positions: [], cash: 1000 });
    const evening = { ...context(client), now: () => after };
    expect(await applyOrderOp(op("cash.park", { account: "margin" }, {}, undefined, totpAt(SECRET, stepOf(after))), evening)).toMatchObject({ ok: true });
    expect(client.placed[0].orders[0]).toMatchObject({ symbol: "BIL", side: "BUY", limit_price: "91.51", time_in_force: "DAY", support_trading_session: "ALL" });
    const thin = { ...context(fakeClient({ positions: [], cash: 1000 })), now: () => after, bidAsk: () => Promise.resolve({ bid: 91.2, ask: 91.6 }) };
    expect(await applyOrderOp(op("cash.park", { account: "margin" }, {}, undefined, totpAt(SECRET, stepOf(after) + 1)), thin)).toMatchObject({ ok: false, message: expect.stringContaining("no usable BIL ask") });
  });

  it("refuses under a share of spare cash, with a BIL buy working, or outside extended hours", async () => {
    expect(await applyOrderOp(op("cash.park", { account: "margin" }), context(fakeClient({ positions: [], cash: 50 })))).toMatchObject({ ok: false, message: expect.stringContaining("whole BIL share") });
    const busy = fakeClient({ positions: [], cash: 1000, open: [working("ewbil", "BIL", "BUY", "LIMIT", 1, { limit: 91.5 })] });
    expect(await applyOrderOp(op("cash.park", { account: "margin" }, {}, undefined, totpAt(SECRET, stepOf(NOW) + 1)), context(busy))).toMatchObject({ ok: false, message: expect.stringContaining("already working") });
    const late = new Date("2026-10-27T01:00:00.000Z"); // 21:00 ET
    const evening = { ...context(fakeClient({ positions: [], cash: 1000 })), now: () => late };
    expect(await applyOrderOp(op("cash.park", { account: "margin" }, {}, undefined, totpAt(SECRET, stepOf(late))), evening)).toMatchObject({ ok: false, message: expect.stringContaining("market is closed") });
  });

  it("refuses with nothing to cover, outside extended hours, or in a cash account", async () => {
    const client = fakeClient({ positions: [position("BIL", 100, 91.5)], cash: 100 });
    expect((await applyOrderOp(op("cash.cover", { account: "margin" }), context(client))).ok).toBe(false);
    const night = new Date("2026-10-27T01:00:00.000Z"); // 21:00 ET
    const evening = { ...context(fakeClient({ positions: [position("BIL", 100, 91.5)], cash: -450 })), now: () => night };
    expect((await applyOrderOp(op("cash.cover", { account: "margin" }, {}, undefined, totpAt(SECRET, stepOf(night))), evening)).ok).toBe(false);
    const after = new Date("2026-10-26T23:00:00.000Z"); // 19:00 ET
    const postMarket = fakeClient({ positions: [position("BIL", 100, 91.5)], cash: -450 });
    expect((await applyOrderOp(op("cash.cover", { account: "margin" }, {}, undefined, totpAt(SECRET, stepOf(after))), { ...context(postMarket), now: () => after })).ok).toBe(true);
    expect(postMarket.placed[0].orders[0]).toMatchObject({ side: "SELL", support_trading_session: "ALL" });
    saveHoldingsStore(holdingsFile, store("CASH", "roth"));
    const roth = context(fakeClient({ positions: [position("BIL", 100, 91.5)], cash: -1 }), {}, "roth");
    expect((await applyOrderOp(op("cash.cover", { account: "roth" }, {}, undefined, totpAt(SECRET, stepOf(NOW) + 1)), roth)).ok).toBe(false);
  });
});

describe("buying", () => {
  const buy = (params: Record<string, unknown>, code?: string, account = "margin") => op("order.buy", { account, symbol: "NEW" }, { quantity: 10, limitPrice: 50, ...params }, undefined, code);

  it("buys alone, and places the stop as its own order once the buy fills", async () => {
    const positions: WebullPosition[] = [];
    const client = fakeClient({ positions, cash: 1000 });
    const ctx = context(client);
    const o = buy({ stopPrice: 46 });
    const r = await applyOrderOp(o, ctx);
    expect(r).toMatchObject({ ok: true, message: "Placed a buy order for NEW; its stop goes on once it fills." });
    expect(client.placed).toHaveLength(1);
    expect(client.placed[0].orders).toMatchObject([{ side: "BUY", order_type: "LIMIT", combo_type: "NORMAL", quantity: "10", limit_price: "50.00" }]);
    expect(client.placed[0].combo).toBeUndefined();

    // Not filled yet: nothing to do, and it keeps waiting.
    const buyId = clientOrderId(o.id, "buy");
    client.detail.set(buyId, ["SUBMITTED"]);
    expect(await settleFollowUps(ctx)).toEqual([]);
    expect(loadOrdersState(ctx.stateFile).followUps).toHaveLength(1);

    positions.push(position("NEW", 10, 50));
    client.detail.set(buyId, ["FILLED"]);
    client.filled.set(buyId, 10);
    expect(await settleFollowUps(ctx)).toMatchObject([{ ok: true, symbol: "NEW", message: "Placed a stop order for NEW." }]);
    expect(client.placed[1].orders).toMatchObject([{ client_order_id: clientOrderId(o.id, "stop"), side: "SELL", order_type: "STOP_LOSS", quantity: "10", stop_price: "46.00", time_in_force: "GTC" }]);
    expect(loadOrdersState(ctx.stateFile).followUps).toEqual([]);
  });

  it("grows its stop as a buy fills in parts", async () => {
    const positions: WebullPosition[] = [];
    const open: WebullOrder[] = [];
    const client = fakeClient({ positions, cash: 1000, open });
    const ctx = context(client);
    const o = buy({ stopPrice: 46 });
    await applyOrderOp(o, ctx);
    const buyId = clientOrderId(o.id, "buy");
    positions.push(position("NEW", 4, 50));
    client.detail.set(buyId, ["PARTIAL_FILLED"]);
    client.filled.set(buyId, 4);
    await settleFollowUps(ctx);
    expect(client.placed[1].orders[0]).toMatchObject({ quantity: "4" });

    const stopId = clientOrderId(o.id, "stop");
    open.push(working(stopId, "NEW", "SELL", "STOP_LOSS", 4, { stop: 46 }));
    positions[0] = position("NEW", 10, 50);
    client.detail.set(buyId, ["FILLED"]);
    client.filled.set(buyId, 10);
    expect(await settleFollowUps(ctx)).toMatchObject([{ ok: true, message: "Grew the NEW stop with the buy's fills." }]);
    expect(client.replaced).toEqual([{ client_order_id: stopId, quantity: "10", stop_price: "46.00" }]);
    expect(loadOrdersState(ctx.stateFile).followUps).toEqual([]);
  });

  it("applied to the whole position, moves the one existing stop over every whole share once the buy fills", async () => {
    const positions = [position("NEW", 5.4, 48)];
    const old = working("ewold", "NEW", "SELL", "STOP_LOSS", 5, { stop: 44 });
    const client = fakeClient({ positions, cash: 1000, open: [old] });
    const ctx = context(client);
    const o = buy({ stopPrice: 46, stopWhole: true });
    expect(await applyOrderOp(o, ctx)).toMatchObject({ ok: true, message: "Placed a buy order for NEW; its NEW stop moves to cover the whole position once it fills." });
    expect(client.placed).toHaveLength(1);

    const buyId = clientOrderId(o.id, "buy");
    positions[0] = position("NEW", 15.4, 49);
    client.detail.set(buyId, ["FILLED"]);
    client.filled.set(buyId, 10);
    expect(await settleFollowUps(ctx)).toMatchObject([{ ok: true, message: "Moved the NEW stop to cover the whole position." }]);
    // 15.4 held: the stop covers the 15 whole shares, never the fraction.
    expect(client.replaced).toEqual([{ client_order_id: "ewold", quantity: "15", stop_price: "46.00" }]);
    expect(client.placed).toHaveLength(1);
  });

  it("refuses to apply the stop to the whole position without exactly one stop to move", async () => {
    const two = fakeClient({ positions: [position("NEW", 5, 48)], cash: 1000, open: [working("ewa", "NEW", "SELL", "STOP_LOSS", 2, { stop: 44 }), working("ewb", "NEW", "SELL", "STOP_LOSS", 3, { stop: 43 })] });
    expect(await applyOrderOp(buy({ stopPrice: 46, stopWhole: true }), context(two))).toMatchObject({ ok: false, message: expect.stringContaining("exactly one NEW stop") });
    expect(two.placed).toEqual([]);
  });

  it("sets no stop when the buy ends unfilled, or when the price is already under the stop", async () => {
    const positions: WebullPosition[] = [];
    const client = fakeClient({ positions, cash: 1000 });
    const ctx = context(client);
    const o = buy({ stopPrice: 46 });
    await applyOrderOp(o, ctx);
    client.detail.set(clientOrderId(o.id, "buy"), ["CANCELLED"]);
    expect(await settleFollowUps(ctx)).toMatchObject([{ ok: true, message: "The NEW buy ended without filling, so no stop was set." }]);
    expect(loadOrdersState(ctx.stateFile).followUps).toEqual([]);

    const o2 = buy({ stopPrice: 46 }, totpAt(SECRET, stepOf(NOW) + 1));
    await applyOrderOp(o2, ctx);
    positions.push(position("NEW", 10, 45.5));
    client.detail.set(clientOrderId(o2.id, "buy"), ["FILLED"]);
    client.filled.set(clientOrderId(o2.id, "buy"), 10);
    expect(await settleFollowUps(ctx)).toMatchObject([{ ok: false, message: expect.stringContaining("at or under the stop") }]);
    expect(client.placed).toHaveLength(2);
    expect(loadOrdersState(ctx.stateFile).followUps).toEqual([]);
  });

  it("never borrows: refuses past cash + BIL, and without Fund from BIL when cash is short", async () => {
    const client = fakeClient({ positions: [position("BIL", 3, 91.5)], cash: 100 });
    // 500 cost, 100 cash + 274.50 BIL.
    expect(await applyOrderOp(buy({ fundFromBil: true }), context(client))).toMatchObject({ ok: false, message: expect.stringContaining("never borrow") });
    const enough = fakeClient({ positions: [position("BIL", 10, 91.5)], cash: 100 });
    expect(await applyOrderOp(buy({}, totpAt(SECRET, stepOf(NOW) - 1)), context(enough))).toMatchObject({ ok: false, message: expect.stringContaining("Fund from BIL") });
    expect(enough.placed).toEqual([]);
  });

  it("refuses over ORDERS_MAX_VALUE and a limit far over the price", async () => {
    const client = fakeClient({ positions: [], cash: 100_000 });
    expect(await applyOrderOp(buy({ quantity: 100 }), context(client))).toMatchObject({ ok: false, message: expect.stringContaining("ORDERS_MAX_VALUE") });
    expect(await applyOrderOp(buy({ limitPrice: 70 }, totpAt(SECRET, stepOf(NOW) - 1)), context(client))).toMatchObject({ ok: false, message: expect.stringContaining("typo") });
  });

  it("in a margin account, sells the BIL shortfall alongside the buy", async () => {
    const client = fakeClient({ positions: [position("BIL", 10, 91.5)], cash: 100 });
    const r = await applyOrderOp(buy({ fundFromBil: true }), context(client));
    expect(r.ok).toBe(true);
    // 400 short: 5 BIL shares, then the buy, with no wait between.
    expect(client.placed.map((p) => [p.orders[0].symbol, p.orders[0].side, p.orders[0].quantity])).toEqual([
      ["BIL", "SELL", "5"],
      ["NEW", "BUY", "10"],
    ]);
  });

  it("in the Roth, buys only after the BIL sale fills, and cancels it if it doesn't", async () => {
    saveHoldingsStore(holdingsFile, store("CASH", "roth"));
    const filled = fakeClient({ positions: [position("BIL", 10, 91.5)], cash: 100 });
    const o = buy({ fundFromBil: true }, undefined, "roth");
    filled.detail.set(clientOrderId(o.id, "fund"), ["NONE", "SUBMITTED", "FILLED"]);
    const r = await applyOrderOp(o, context(filled, {}, "roth"));
    expect(r).toMatchObject({ ok: true, detail: expect.stringContaining("filled") });
    expect(filled.placed.map((p) => p.orders[0].symbol)).toEqual(["BIL", "NEW"]);

    const stuck = fakeClient({ positions: [position("BIL", 10, 91.5)], cash: 100 });
    let t = NOW.getTime();
    const ctx = { ...context(stuck, {}, "roth"), now: () => new Date((t += 10_000)) };
    const o2 = buy({ fundFromBil: true }, totpAt(SECRET, stepOf(NOW) + 1), "roth");
    stuck.detail.set(clientOrderId(o2.id, "fund"), ["NONE", "SUBMITTED"]);
    const r2 = await applyOrderOp(o2, ctx);
    expect(r2).toMatchObject({ ok: false, message: expect.stringContaining("didn't fill in time") });
    expect(stuck.placed.map((p) => p.orders[0].symbol)).toEqual(["BIL"]);
    expect(stuck.cancelled).toEqual([clientOrderId(o2.id, "fund")]);
  });
});

describe("the watcher", () => {
  function watchContext(client: Fake): WatchContext & { uploads: string[] } {
    const uploads: string[] = [];
    return {
      uploads,
      order: context(client),
      queue: { receive: () => Promise.resolve([]), remove: () => Promise.resolve(), release: () => Promise.resolve() },
      opLogFile: join(dir, "ops.log.jsonl"),
      ordersLogFile: join(dir, "orders.log.jsonl"),
      siteDir: join(dir, "site"),
      vaultToken: "t".repeat(64),
      upload: (key) => (uploads.push(key), Promise.resolve()),
      log: () => undefined,
    };
  }

  it("applies an order op once, and seals its result for the page", async () => {
    const client = fakeClient({ positions: [position("AAA", 10, 50)], cash: 1000 });
    const ctx = watchContext(client);
    const body = JSON.stringify(op("stop.place", { account: "margin", symbol: "AAA" }, { quantity: 5, stopPrice: 45 }));
    expect(await handleMessage(body, ctx)).toBe("applied");
    expect(await handleMessage(body, ctx)).toBe("duplicate");
    expect(client.placed).toHaveLength(1);
    expect(ctx.uploads).toEqual(["orders.json", "orders.json"].slice(0, 1));
    const status = openVault(JSON.parse(readFileSync(join(dir, "site", "orders.json"), "utf-8")), "t".repeat(64)) as unknown as { results: { ok: boolean; detail: string; account: string }[] };
    expect(status.results[0]).toMatchObject({ ok: true, account: "margin", detail: expect.stringContaining("sell 5 AAA stop_loss stop 45.00") });
    // The op log, which the public page's results come from, has no detail.
    expect(readFileSync(join(dir, "ops.log.jsonl"), "utf-8")).not.toContain("45.00");
  });

  it("refuses a stale op and anything that isn't an order", async () => {
    const client = fakeClient({ positions: [position("AAA", 10, 50)], cash: 1000 });
    const ctx = watchContext(client);
    const old = { ...op("stop.place", { account: "margin", symbol: "AAA" }, { quantity: 5, stopPrice: 45 }), createdAt: new Date(NOW.getTime() - 5 * 60_000).toISOString() };
    expect(await handleMessage(JSON.stringify(old), ctx)).toBe("rejected");
    const edit = op("lot.edit", { lotId: "l1" });
    expect(await handleMessage(JSON.stringify(edit), ctx)).toBe("rejected");
    expect(client.placed).toEqual([]);
  });

  describe("quote.read", () => {
    const sealed = () => openVault(JSON.parse(readFileSync(join(dir, "site", "orders.json"), "utf-8")), "t".repeat(64)) as unknown as { results: unknown[]; quotes: Record<string, unknown>[] };

    it("answers with a quote in the status document, needing no code and leaving the op log alone", async () => {
      const client = fakeClient({ positions: [], cash: 1000 });
      const ctx = { ...watchContext(client), snapshot: (s: string) => Promise.resolve(s === "AAA" ? { last: 12.34, bid: 12.33, ask: 12.35, tradeTime: NOW.getTime(), session: "regular" as const } : null) };
      expect(await handleMessage(JSON.stringify(op("quote.read", { symbol: "aaa" })), ctx)).toBe("applied");
      expect(sealed().quotes[0]).toMatchObject({ symbol: "AAA", ok: true, last: 12.34, bid: 12.33, ask: 12.35, session: "regular", tradeTime: NOW.toISOString() });
      expect(client.placed).toEqual([]);
      expect(existsSync(join(dir, "ops.log.jsonl"))).toBe(false);
      expect(existsSync(join(dir, "orders.log.jsonl"))).toBe(false);
      expect(await handleMessage(JSON.stringify(op("quote.read", { symbol: "ZZZ" })), ctx)).toBe("rejected");
      expect(sealed().quotes[0]).toMatchObject({ symbol: "ZZZ", ok: false, message: "Schwab has no quote for ZZZ." });
      expect(sealed().quotes).toHaveLength(2);
    });

    it("says when Schwab fails, and ignores a request the page has stopped waiting for", async () => {
      const client = fakeClient({ positions: [], cash: 1000 });
      const ctx = { ...watchContext(client), snapshot: () => Promise.reject(new Error("Schwab login expired")) };
      expect(await handleMessage(JSON.stringify(op("quote.read", { symbol: "AAA" })), ctx)).toBe("rejected");
      expect(sealed().quotes[0]).toMatchObject({ ok: false, message: expect.stringContaining("Couldn't read a quote") });
      const old = { ...op("quote.read", { symbol: "BBB" }), createdAt: new Date(NOW.getTime() - 5 * 60_000).toISOString() };
      expect(await handleMessage(JSON.stringify(old), ctx)).toBe("rejected");
      expect(sealed().quotes).toHaveLength(1);
    });

    it("keeps the quotes when an order result is published after them", async () => {
      const client = fakeClient({ positions: [position("AAA", 10, 50)], cash: 1000 });
      const ctx = { ...watchContext(client), snapshot: () => Promise.resolve({ last: 50, session: null }) };
      await handleMessage(JSON.stringify(op("quote.read", { symbol: "AAA" })), ctx);
      await handleMessage(JSON.stringify(op("stop.place", { account: "margin", symbol: "AAA" }, { quantity: 5, stopPrice: 45 })), ctx);
      expect(sealed().results).toHaveLength(1);
      expect(sealed().quotes).toHaveLength(1);
    });
  });
});
