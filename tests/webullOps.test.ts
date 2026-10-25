import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MarketData } from "../src/alerts/engine.js";
import type { HoldingsStore, WebullAccountState } from "../src/holdings/models.js";
import { loadHoldingsStore, saveHoldingsStore } from "../src/holdings/store.js";
import { applyOp, parseOp, type OpResult } from "../src/ops/apply.js";

const READ_AT = "2026-10-25T14:00:00.000Z";

function account(over: Partial<WebullAccountState> = {}): WebullAccountState {
  return {
    label: "roth",
    accountType: "CASH",
    cash: null,
    cashStatus: "ok",
    lowCash: null,
    unmatched: [
      {
        symbol: "NEW",
        count: 10,
        basis: 21,
        lastPrice: 22,
        adopt: [
          { count: 4, basisPerShare: 20, purchaseDate: "2026-03-02", orderId: "ORDER-0001" },
          { count: 6, basisPerShare: 21.67, purchaseDate: "2026-04-02", orderId: "ORDER-0002" },
        ],
        fallback: null,
        ignored: false,
        booked: { "ORDER-0001": 4, "ORDER-0002": 6 },
      },
    ],
    links: [
      { symbol: "MAN", count: 3, basis: 7, webullCount: 3, differences: [], booked: { "ORDER-0003": 3 } },
      { symbol: "OFF", count: 2, basis: 9, webullCount: 5, differences: ["shares: record 2, Webull 5"], booked: {} },
    ],
    flags: [],
    skipped: [],
    ...over,
  };
}

function store(): HoldingsStore {
  return {
    lots: [
      { id: "man1", symbol: "MAN", count: 3, basisPerShare: 7, purchaseDate: "2026-01-02", createdAt: "2026-01-02T15:00:00.000Z", account: "roth" },
      { id: "off1", symbol: "OFF", count: 2, basisPerShare: 9, purchaseDate: "2026-01-02", createdAt: "2026-01-02T15:00:00.000Z", account: "roth" },
      { id: "kept1", symbol: "KEPT", count: 5, basisPerShare: 30, purchaseDate: "2026-01-02", createdAt: "2026-01-02T15:00:00.000Z", account: "roth" },
      { id: "kept2", symbol: "KEPT", count: 1, basisPerShare: 31, purchaseDate: "2026-01-03", createdAt: "2026-01-03T15:00:00.000Z", account: "schwab" },
    ],
    stops: [],
    alertState: [],
    holdings: [{ account: "roth", symbol: "KEPT", source: "webull", linkedAt: READ_AT, booked: {} }],
    webull: { readAt: READ_AT, accounts: [account()] },
  };
}

const noMarket: MarketData = {
  getQuotes: () => Promise.reject(new Error("no quotes")),
  getIntradayBars: () => Promise.reject(new Error("no bars")),
  getDailyBars: () => Promise.reject(new Error("no bars")),
};

let dir: string;
let holdingsFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webull-ops-"));
  holdingsFile = join(dir, "holdings.json");
  saveHoldingsStore(holdingsFile, store());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
async function apply(body: Record<string, unknown>): Promise<OpResult> {
  const parsed = parseOp({ id: `op-webull-${String(++seq).padStart(4, "0")}`, ...body });
  if (!parsed.ok) throw new Error(parsed.error);
  const { result } = await applyOp(parsed.op, {
    alertsFile: join(dir, "alerts.json"),
    holdingsFile,
    revisitsFile: join(dir, "revisits.json"),
    opLogFile: join(dir, "ops.log.jsonl"),
    market: noMarket,
    now: () => new Date("2026-10-25T15:00:00.000Z"),
  });
  return result;
}

describe("holding.adopt", () => {
  it("writes the proposed lots and makes it a webull holding", async () => {
    const r = await apply({ type: "holding.adopt", target: { account: "roth", symbol: "NEW" }, expect: { count: 10 } });
    expect(r.ok).toBe(true);
    // Public message: no share counts or prices.
    expect(r.message).not.toMatch(/\d/);
    const s = loadHoldingsStore(holdingsFile);
    expect(s.lots.filter((l) => l.symbol === "NEW").map((l) => [l.count, l.orderId, l.account])).toEqual([
      [4, "ORDER-0001", "roth"],
      [6, "ORDER-0002", "roth"],
    ]);
    expect(s.holdings?.find((h) => h.symbol === "NEW")).toEqual({
      account: "roth",
      symbol: "NEW",
      source: "webull",
      linkedAt: READ_AT,
      booked: { "ORDER-0001": 4, "ORDER-0002": 6 },
    });
    expect(s.webull?.accounts[0].unmatched).toEqual([]);
  });

  it("refuses when Webull's count changed since the page loaded", async () => {
    const r = await apply({ type: "holding.adopt", target: { account: "roth", symbol: "NEW" }, expect: { count: 9 } });
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("changed since the page loaded") });
    expect(loadHoldingsStore(holdingsFile).lots.some((l) => l.symbol === "NEW")).toBe(false);
  });

  it("refuses a symbol the sync didn't offer", async () => {
    const r = await apply({ type: "holding.adopt", target: { account: "roth", symbol: "ZZZ" }, expect: { count: 1 } });
    expect(r.ok).toBe(false);
  });
});

describe("holding.link", () => {
  it("links a holding whose shares agree, keeping its lots", async () => {
    const r = await apply({ type: "holding.link", target: { account: "roth", symbol: "MAN" }, expect: { count: 3 } });
    expect(r.ok).toBe(true);
    const s = loadHoldingsStore(holdingsFile);
    expect(s.lots.filter((l) => l.symbol === "MAN").map((l) => l.id)).toEqual(["man1"]);
    expect(s.holdings?.find((h) => h.symbol === "MAN")).toMatchObject({ source: "webull", booked: { "ORDER-0003": 3 } });
  });

  it("refuses when the shares differ", async () => {
    const r = await apply({ type: "holding.link", target: { account: "roth", symbol: "OFF" }, expect: { count: 5 } });
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("don't match") });
  });
});

describe("holding.unlink and holding.ignore", () => {
  it("unlinks a webull holding back to manual", async () => {
    expect((await apply({ type: "holding.unlink", target: { account: "roth", symbol: "KEPT" } })).ok).toBe(true);
    expect(loadHoldingsStore(holdingsFile).holdings?.some((h) => h.symbol === "KEPT")).toBe(false);
  });

  it("ignores an unmatched position, and offers it again", async () => {
    await apply({ type: "holding.ignore", target: { account: "roth", symbol: "NEW" }, params: { ignore: true } });
    let s = loadHoldingsStore(holdingsFile);
    expect(s.holdings?.find((h) => h.symbol === "NEW")).toEqual({ account: "roth", symbol: "NEW", source: "manual", ignored: true });
    expect(s.webull?.accounts[0].unmatched[0].ignored).toBe(true);

    await apply({ type: "holding.ignore", target: { account: "roth", symbol: "NEW" }, params: { ignore: false } });
    s = loadHoldingsStore(holdingsFile);
    expect(s.holdings?.some((h) => h.symbol === "NEW")).toBe(false);
    expect(s.webull?.accounts[0].unmatched[0].ignored).toBe(false);
  });

  it("needs an account as well as a symbol", async () => {
    expect((await apply({ type: "holding.unlink", target: { symbol: "KEPT" } })).ok).toBe(false);
  });
});

describe("the lock on webull holdings", () => {
  const lotExpect = { count: 5, basisPerShare: 30, purchaseDate: "2026-01-02", account: "roth" };

  it("refuses hand edits and removals of its lots", async () => {
    const edit = await apply({ type: "lot.edit", target: { lotId: "kept1" }, expect: lotExpect, params: { count: 6 } });
    const remove = await apply({ type: "lot.remove", target: { lotId: "kept1" }, expect: lotExpect, params: {} });
    expect(edit).toMatchObject({ ok: false, message: expect.stringContaining("kept by the Webull sync") });
    expect(remove.ok).toBe(false);
    expect(loadHoldingsStore(holdingsFile).lots.find((l) => l.id === "kept1")?.count).toBe(5);
  });

  it("refuses a lot added to it, but not to another account", async () => {
    const kept = await apply({ type: "lot.add", params: { symbol: "KEPT", count: 1, basisPerShare: 30, account: "roth" } });
    const elsewhere = await apply({ type: "lot.add", params: { symbol: "KEPT", count: 1, basisPerShare: 30, account: "schwab" } });
    expect(kept.ok).toBe(false);
    expect(elsewhere.ok).toBe(true);
  });

  it("refuses moving a lot into it", async () => {
    const r = await apply({
      type: "lot.edit",
      target: { lotId: "kept2" },
      expect: { count: 1, basisPerShare: 31, purchaseDate: "2026-01-03", account: "schwab" },
      params: { account: "roth" },
    });
    expect(r.ok).toBe(false);
  });

  it("refuses a position sale that would take from it, but allows one from another account", async () => {
    const all = await apply({ type: "position.remove", target: { symbol: "KEPT" }, expect: { lotIds: ["kept1", "kept2"] }, params: {} });
    expect(all.ok).toBe(false);
    const other = await apply({
      type: "position.remove",
      target: { symbol: "KEPT" },
      expect: { lotIds: ["kept1", "kept2"] },
      params: { price: 32, account: "schwab" },
    });
    expect(other.ok).toBe(true);
    expect(loadHoldingsStore(holdingsFile).lots.map((l) => l.id)).toContain("kept1");
  });
});
