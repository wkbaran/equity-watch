import { describe, expect, it } from "vitest";
import type { HoldingsStore, Lot } from "../src/holdings/models.js";
import {
  adoptionLots,
  applySyncPlan,
  cashStatusOf,
  fillsOf,
  parseAccountMap,
  parseLowCash,
  sharesToCover,
  unbookedFills,
  planWebullSync,
  renderSyncPlan,
  replayFills,
  syncChanges,
  type WebullAccountSnapshot,
} from "../src/holdings/webullSync.js";
import type { WebullOrder, WebullPosition } from "../src/providers/webull.js";

function order(o: Partial<WebullOrder> & Pick<WebullOrder, "orderId" | "symbol" | "side">): WebullOrder {
  return {
    clientOrderId: null,
    instrumentType: "EQUITY",
    status: "FILLED",
    orderType: "LIMIT",
    timeInForce: "DAY",
    totalQuantity: o.filledQuantity ?? 0,
    filledQuantity: 0,
    filledPrice: null,
    limitPrice: null,
    stopPrice: null,
    placedAt: null,
    filledAt: null,
    ...o,
  };
}

function buy(orderId: string, symbol: string, qty: number, price: number, at: string): WebullOrder {
  return order({ orderId, symbol, side: "BUY", filledQuantity: qty, filledPrice: price, filledAt: at });
}

function sell(orderId: string, symbol: string, qty: number, price: number, at: string, orderType = "LIMIT"): WebullOrder {
  return order({ orderId, symbol, side: "SELL", filledQuantity: qty, filledPrice: price, filledAt: at, orderType });
}

function position(symbol: string, quantity: number, costPrice: number, lastPrice = costPrice, instrumentType = "EQUITY"): WebullPosition {
  return { symbol, instrumentType, quantity, costPrice, lastPrice };
}

function lot(symbol: string, count: number, basisPerShare: number, account?: string): Lot {
  return { id: `${symbol}-${count}`, symbol, count, basisPerShare, purchaseDate: "2026-01-02", createdAt: "2026-01-02T15:00:00.000Z", ...(account ? { account } : {}) };
}

function snapshot(label: string, positions: WebullPosition[], orders: WebullOrder[] = [], cash = 1000): WebullAccountSnapshot {
  return {
    label,
    accountId: `ID-${label}`,
    accountType: label === "roth" ? "CASH" : "MARGIN",
    balance: { cash, settledCash: cash, unsettledCash: 0, buyingPower: null, marketValue: 0, netLiquidation: 0 },
    positions,
    orders,
    historyFrom: "2018-05-21T00:00:00.000Z",
  };
}

const OPTIONS = { cashEquivalents: new Set(["BIL"]), today: "2026-10-25" };

describe("fillsOf", () => {
  it("keeps filled equity buys and sells, oldest first, dated in New York", () => {
    const fills = fillsOf([
      sell("S1", "AAA", 2, 12, "2026-10-21T14:00:00.000Z", "STOP_LOSS"),
      // 01:30 UTC on the 21st is still the 20th in New York.
      buy("B1", "AAA", 5, 10, "2026-10-21T01:30:00.000Z"),
      order({ orderId: "X", symbol: "AAA", side: "BUY", status: "CANCELLED" }),
      order({ orderId: "OPT", symbol: "AAA250101C", side: "BUY", instrumentType: "OPTION", filledQuantity: 1, filledPrice: 2, filledAt: "2026-10-21T15:00:00.000Z" }),
    ]);
    expect(fills.map((f) => f.orderId)).toEqual(["B1", "S1"]);
    expect(fills[0].date).toBe("2026-10-20");
    expect(fills[1].stop).toBe(true);
  });

  it("marks a partly filled order as still working", () => {
    const [f] = fillsOf([order({ orderId: "P", symbol: "AAA", side: "BUY", status: "PARTIAL_FILLED", filledQuantity: 3, filledPrice: 5, filledAt: "2026-10-21T15:00:00.000Z" })]);
    expect(f).toMatchObject({ quantity: 3, working: true });
  });
});

describe("replayFills", () => {
  it("takes sales from the oldest lot first", () => {
    const lots = replayFills(
      fillsOf([
        buy("B1", "AAA", 5, 10, "2026-01-05T15:00:00.000Z"),
        buy("B2", "AAA", 5, 12, "2026-02-05T15:00:00.000Z"),
        sell("S1", "AAA", 7, 15, "2026-03-05T15:00:00.000Z"),
      ])
    );
    expect(lots).toEqual([{ count: 3, basisPerShare: 12, purchaseDate: "2026-02-05", orderId: "B2" }]);
  });

  it("is null when a sale takes more than the window bought", () => {
    expect(replayFills(fillsOf([sell("S1", "AAA", 1, 15, "2026-03-05T15:00:00.000Z")]))).toBeNull();
  });
});

describe("adoptionLots", () => {
  it("builds lots from fills that explain the whole position", () => {
    const fills = fillsOf([buy("B1", "AAA", 4, 10, "2026-01-05T15:00:00.000Z"), buy("B2", "AAA", 6, 11, "2026-02-05T15:00:00.000Z")]);
    const { lots, fallback } = adoptionLots(position("AAA", 10, 10.6), fills, "2018-05-21T00:00:00.000Z", "2026-10-25");
    expect(fallback).toBeNull();
    expect(lots.map((l) => [l.count, l.purchaseDate])).toEqual([
      [4, "2026-01-05"],
      [6, "2026-02-05"],
    ]);
  });

  it("falls back to one lot at the average cost when they don't", () => {
    const fills = fillsOf([buy("B1", "AAA", 4, 10, "2026-01-05T15:00:00.000Z")]);
    const { lots, fallback } = adoptionLots(position("AAA", 10, 10.6), fills, "2026-01-01T00:00:00.000Z", "2026-10-25");
    expect(lots).toEqual([{ count: 10, basisPerShare: 10.6, purchaseDate: "2026-10-25", orderId: null }]);
    expect(fallback).toContain("explain 4 of 10 shares");
  });
});

describe("syncChanges", () => {
  it("turns fills that account for the change into buys and sales", () => {
    const fills = fillsOf([buy("B1", "AAA", 3, 11, "2026-10-21T15:00:00.000Z"), sell("S1", "AAA", 5, 13, "2026-10-22T15:00:00.000Z", "STOP_LOSS")]);
    const { changes, flags } = syncChanges({ count: 10, basis: 10 }, 8, fills);
    expect(flags).toEqual([]);
    expect(changes).toEqual([
      { type: "buy", lot: { count: 3, basisPerShare: 11, purchaseDate: "2026-10-21", orderId: "B1" } },
      { type: "sell", count: 5, price: 13, soldOn: "2026-10-22", orderId: "S1", stopHit: true },
    ]);
  });

  it("flags a change no fill explains, and applies nothing", () => {
    const { changes, flags } = syncChanges({ count: 10, basis: 10 }, 20, []);
    expect(changes).toEqual([]);
    expect(flags[0]).toContain("corporate action");
  });

  it("flags fills that don't add up to Webull's count", () => {
    const { changes, flags } = syncChanges({ count: 10, basis: 10 }, 12, fillsOf([buy("B1", "AAA", 3, 11, "2026-10-21T15:00:00.000Z")]));
    expect(changes).toEqual([]);
    expect(flags[0]).toContain("make 13, but Webull holds 12");
  });
});

describe("planWebullSync", () => {
  it("sorts each position into unmatched, link or not-at-Webull", () => {
    const store: HoldingsStore = {
      lots: [lot("AAA", 10, 50, "margin"), lot("BBB", 5, 20, "margin"), lot("OLD", 3, 7, "margin"), lot("ELSE", 1, 1, "schwab")],
      stops: [],
      alertState: [],
    };
    const plan = planWebullSync(
      store,
      [snapshot("margin", [position("AAA", 10, 50.01), position("BBB", 6, 20), position("NEW", 2, 30), position("AAA 260116C", 1, 3, 3, "OPTION")])],
      OPTIONS
    );
    const kinds = Object.fromEntries(plan.accounts[0].holdings.map((h) => [h.symbol, h.kind]));
    expect(kinds).toEqual({ AAA: "link", BBB: "link", NEW: "unmatched", OLD: "notAtWebull" });
    const bbb = plan.accounts[0].holdings.find((h) => h.symbol === "BBB");
    expect(bbb?.kind === "link" && bbb.differences).toEqual(["shares: record 5, Webull 6"]);
    // A basis within 0.1% agrees.
    const aaa = plan.accounts[0].holdings.find((h) => h.symbol === "AAA");
    expect(aaa?.kind === "link" && aaa.differences).toEqual([]);
    expect(plan.accounts[0].skipped.map((s) => s.symbol)).toEqual(["AAA 260116C"]);
  });

  it("syncs a webull holding from the fills after it was linked only", () => {
    const store: HoldingsStore = {
      lots: [lot("AAA", 10, 50, "roth")],
      stops: [],
      alertState: [],
      holdings: [{ account: "roth", symbol: "AAA", source: "webull", linkedAt: "2026-10-01T00:00:00.000Z" }],
    };
    const orders = [buy("OLD", "AAA", 10, 50, "2026-09-01T15:00:00.000Z"), buy("B2", "AAA", 2, 55, "2026-10-21T15:00:00.000Z")];
    const plan = planWebullSync(store, [snapshot("roth", [position("AAA", 12, 50.83)], orders)], OPTIONS);
    const h = plan.accounts[0].holdings[0];
    expect(h.kind).toBe("sync");
    expect(h.kind === "sync" && h.changes.map((c) => c.type === "buy" && c.lot.orderId)).toEqual(["B2"]);
  });

  it("plans a full exit for a webull holding Webull no longer holds", () => {
    const store: HoldingsStore = {
      lots: [lot("AAA", 10, 50, "roth")],
      stops: [],
      alertState: [],
      holdings: [{ account: "roth", symbol: "AAA", source: "webull", linkedAt: "2026-10-01T00:00:00.000Z" }],
    };
    const plan = planWebullSync(store, [snapshot("roth", [], [sell("S1", "AAA", 10, 45, "2026-10-21T15:00:00.000Z", "STOP_LOSS")])], OPTIONS);
    const h = plan.accounts[0].holdings[0];
    expect(h).toMatchObject({ kind: "notAtWebull", source: "webull", flags: [] });
    expect(h.kind === "notAtWebull" && h.changes).toEqual([{ type: "sell", count: 10, price: 45, soldOn: "2026-10-21", orderId: "S1", stopHit: true }]);
  });

  it("adds cash equivalents to cash, and lists lots with no account label", () => {
    const store: HoldingsStore = { lots: [lot("AAA", 1, 1)], stops: [], alertState: [] };
    const plan = planWebullSync(store, [snapshot("margin", [position("BIL", 100, 91.5, 91.6), position("AAA", 1, 1)], [], -500)], OPTIONS);
    expect(plan.accounts[0].cash).toMatchObject({ cash: -500, cashEquivalents: 9160, total: 8660 });
    expect(plan.unlabelled).toEqual([{ symbol: "AAA", count: 1 }]);
  });

  it("renders without throwing and names each section", () => {
    const store: HoldingsStore = { lots: [lot("AAA", 10, 50, "margin")], stops: [], alertState: [] };
    const lines = renderSyncPlan(planWebullSync(store, [snapshot("margin", [position("AAA", 10, 50), position("NEW", 2, 30)])], OPTIONS), ["BIL"]);
    const text = lines.join("\n");
    expect(text).toContain("margin (Webull margin account)");
    expect(text).toContain("cash + BIL $1,000.00");
    expect(text).toContain("Unmatched");
    expect(text).toContain("AAA    agrees");
  });
});

describe("parseAccountMap", () => {
  it("reads label=id pairs", () => {
    expect(parseAccountMap(" margin=ABC , roth=DEF ")).toEqual([
      { label: "margin", accountId: "ABC" },
      { label: "roth", accountId: "DEF" },
    ]);
    expect(parseAccountMap(undefined)).toEqual([]);
  });

  it("rejects a malformed or repeated entry", () => {
    expect(() => parseAccountMap("margin")).toThrow(/label=value, e.g. margin=ABC123/);
    expect(() => parseAccountMap("margin=A,margin=B")).toThrow(/twice/);
  });
});

describe("unbookedFills", () => {
  const fills = fillsOf([
    buy("B0", "AAA", 5, 10, "2026-09-01T15:00:00.000Z"),
    buy("B1", "AAA", 4, 11, "2026-10-21T15:00:00.000Z"),
    order({ orderId: "P", symbol: "AAA", side: "BUY", status: "PARTIAL_FILLED", filledQuantity: 6, filledPrice: 12, filledAt: "2026-10-22T15:00:00.000Z" }),
  ]);

  it("skips fills before the link and books each order once", () => {
    const left = unbookedFills(fills, { linkedAt: "2026-10-01T00:00:00.000Z", booked: { B1: 4, P: 2 } });
    // B0 predates the link; B1 is fully booked; P has 4 new shares.
    expect(left.map((f) => [f.orderId, f.quantity])).toEqual([["P", 4]]);
  });

  it("still books an order that history shows late, dated before the last run", () => {
    const left = unbookedFills(fills, { linkedAt: "2026-08-01T00:00:00.000Z", booked: {} });
    expect(left.map((f) => f.orderId)).toEqual(["B0", "B1", "P"]);
  });
});

describe("cash status", () => {
  const cash = (c: number, equivalents: number, price: number | null = 91.5) => ({
    cash: c,
    settledCash: null,
    unsettledCash: null,
    cashEquivalents: equivalents,
    cashEquivalentPrice: price,
    total: c + equivalents,
  });

  it("ranks on margin over using margin over low", () => {
    expect(cashStatusOf(cash(-500, 100), 1000)).toBe("onMargin");
    expect(cashStatusOf(cash(-500, 9000), 1000)).toBe("usingMargin");
    expect(cashStatusOf(cash(200, 500), 1000)).toBe("low");
    expect(cashStatusOf(cash(200, 5000), 1000)).toBe("ok");
    expect(cashStatusOf(cash(200, 500), null)).toBe("ok");
    expect(cashStatusOf(null, 1000)).toBe("ok");
  });

  it("rounds the shares to cover up to whole shares", () => {
    expect(sharesToCover(cash(-500, 9000))).toBe(6);
    expect(sharesToCover(cash(100, 9000))).toBeNull();
    expect(sharesToCover(cash(-500, 0, null))).toBeNull();
  });

  it("parses WEBULL_LOW_CASH", () => {
    expect([...parseLowCash("margin=5000, roth=$2000")]).toEqual([
      ["margin", 5000],
      ["roth", 2000],
    ]);
    expect(() => parseLowCash("margin=lots")).toThrow(/dollars/);
  });
});

describe("applySyncPlan", () => {
  const NOW = new Date("2026-10-25T16:00:00.000Z");

  function webullStore(): HoldingsStore {
    return {
      lots: [lot("AAA", 10, 50, "roth")],
      stops: [{ id: "s1", symbol: "AAA", count: null, stopPrice: 40, createdAt: "2026-10-01T00:00:00.000Z" }],
      alertState: [],
      holdings: [{ account: "roth", symbol: "AAA", source: "webull", linkedAt: "2026-10-01T00:00:00.000Z" }],
    };
  }

  it("writes buys and sales, books their orders, and a rerun changes nothing", () => {
    const store = webullStore();
    const orders = [buy("B2", "AAA", 4, 55, "2026-10-21T15:00:00.000Z"), sell("S1", "AAA", 6, 60, "2026-10-22T15:00:00.000Z")];
    const snaps = [snapshot("roth", [position("AAA", 8, 52)], orders)];
    const first = applySyncPlan(store, planWebullSync(store, snaps, OPTIONS), NOW);

    expect(first.applied.map((a) => a.change.type)).toEqual(["buy", "sell"]);
    expect(store.lots.reduce((n, l) => n + l.count, 0)).toBe(8);
    expect(store.lots.find((l) => l.orderId === "B2")).toMatchObject({ account: "roth", purchaseDate: "2026-10-21" });
    expect(store.sales?.[0]).toMatchObject({ orderId: "S1", count: 6, price: 60 });
    expect(store.holdings?.[0].booked).toEqual({ B2: 4, S1: 6 });
    expect(store.webull?.readAt).toBe(NOW.toISOString());

    const second = applySyncPlan(store, planWebullSync(store, snaps, OPTIONS), NOW);
    expect(second.applied).toEqual([]);
    expect(store.lots.reduce((n, l) => n + l.count, 0)).toBe(8);
  });

  it("marks a sale by a stop and keeps the stops it hit", () => {
    const store = webullStore();
    const snaps = [snapshot("roth", [], [sell("S1", "AAA", 10, 39.9, "2026-10-22T15:00:00.000Z", "STOP_LOSS")])];
    applySyncPlan(store, planWebullSync(store, snaps, OPTIONS), NOW);
    expect(store.lots).toEqual([]);
    expect(store.stops).toEqual([]);
    expect(store.sales?.[0].stopHit?.stops.map((s) => s.stopPrice)).toEqual([40]);
  });

  it("leaves unmatched and manual holdings alone, but records them in the state", () => {
    const store: HoldingsStore = { lots: [lot("MAN", 3, 7, "roth")], stops: [], alertState: [] };
    const snaps = [snapshot("roth", [position("MAN", 3, 7), position("NEW", 2, 30)])];
    const result = applySyncPlan(store, planWebullSync(store, snaps, OPTIONS), NOW);
    expect(result.applied).toEqual([]);
    expect(store.lots).toHaveLength(1);
    expect(store.webull?.accounts[0].unmatched.map((u) => u.symbol)).toEqual(["NEW"]);
    expect(store.webull?.accounts[0].links).toEqual([{ symbol: "MAN", count: 3, basis: 7, webullCount: 3, differences: [], booked: {} }]);
  });

  it("reports a cash status only when it changes to a warning", () => {
    const store: HoldingsStore = { lots: [], stops: [], alertState: [] };
    const options = { ...OPTIONS, lowCash: new Map([["margin", 5000]]) };
    const low = [snapshot("margin", [position("BIL", 10, 91.5)], [], 100)];
    expect(applySyncPlan(store, planWebullSync(store, low, options), NOW).cashChanges.map((c) => c.to)).toEqual(["low"]);
    expect(applySyncPlan(store, planWebullSync(store, low, options), NOW).cashChanges).toEqual([]);
    const borrowing = [snapshot("margin", [position("BIL", 100, 91.5)], [], -300)];
    expect(applySyncPlan(store, planWebullSync(store, borrowing, options), NOW).cashChanges.map((c) => [c.from, c.to])).toEqual([["low", "usingMargin"]]);
  });
});

describe("order cache", () => {
  it("re-reads a few days back and lets a later read of an order win", async () => {
    const { mergeOrders, nextReadStart } = await import("../src/holdings/webullOrders.js");
    expect(nextReadStart(null)).toBe("2018-05-21T00:00:00.000Z");
    const first = mergeOrders(null, [order({ orderId: "P", symbol: "AAA", side: "BUY", status: "PARTIAL_FILLED", filledQuantity: 2, filledPrice: 5 })], "2018-05-21T00:00:00.000Z", "2026-10-24T00:00:00.000Z");
    expect(nextReadStart(first)).toBe("2026-10-21T00:00:00.000Z");
    const second = mergeOrders(first, [order({ orderId: "P", symbol: "AAA", side: "BUY", status: "FILLED", filledQuantity: 5, filledPrice: 5 })], "2026-10-21T00:00:00.000Z", "2026-10-25T00:00:00.000Z");
    expect(second.orders).toHaveLength(1);
    expect(second.orders[0]).toMatchObject({ status: "FILLED", filledQuantity: 5 });
    expect(second.readFrom).toBe("2018-05-21T00:00:00.000Z");
  });
});
