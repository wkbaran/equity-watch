import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MarketData } from "../src/alerts/engine.js";
import { buildDashboard } from "../src/dashboard.js";
import { editLot, removeLot, removePosition, replaceStop, sellShares } from "../src/holdings/engine.js";
import type { HoldingsStore } from "../src/holdings/models.js";
import { loadHoldingsStore, saveHoldingsStore } from "../src/holdings/store.js";
import { applyOp, parseOp, type OpResult } from "../src/ops/apply.js";
import type { StaticAlert } from "../src/alerts/models.js";
import { newRevisitEntry } from "../src/alerts/revisit.js";
import { loadRevisits, saveRevisits } from "../src/alerts/revisitStore.js";
import { parseLotEdit, parseLotInput, parseSaleParams, parseStopInput } from "../src/ops/validate.js";
import type { Quote } from "../src/providers/schwab.js";
import { NO_OPS, siteDocument, siteFingerprint, writeSite } from "../src/web/site.js";
import { VAULT_FILE, openVault, sealVault, vaultContents, type VaultDocument } from "../src/web/vault.js";

const TOKEN = "t".repeat(64);

function store(): HoldingsStore {
  return {
    lots: [
      { id: "lotaapl1", symbol: "AAPL", count: 10, basisPerShare: 150, purchaseDate: "2026-09-01", createdAt: "2026-09-01T15:00:00.000Z", account: "roth" },
      { id: "lotaapl2", symbol: "AAPL", count: 5, basisPerShare: 170, purchaseDate: "2026-09-08", createdAt: "2026-09-08T15:00:00.000Z" },
      { id: "lotmsft1", symbol: "MSFT", count: 3, basisPerShare: 410, purchaseDate: "2026-08-20", createdAt: "2026-08-20T15:00:00.000Z" },
    ],
    stops: [
      { id: "stopaapl", symbol: "AAPL", count: null, stopPrice: 140, createdAt: "2026-09-02T15:00:00.000Z" },
      { id: "stopmsft", symbol: "MSFT", count: 3, stopPrice: 380, createdAt: "2026-09-02T15:00:00.000Z" },
    ],
    alertState: [{ symbol: "MSFT", initialized: true, aboveBasisArmed: false, stagnantArmed: true, lastNotifiedAppreciationBand: 1 }],
  };
}

const noMarket: MarketData = {
  getQuotes: () => Promise.reject(new Error("holdings ops need no quotes")),
  getIntradayBars: () => Promise.reject(new Error("no bars")),
  getDailyBars: () => Promise.reject(new Error("no bars")),
};

let dir: string;
let holdingsFile: string;
let opLogFile: string;
let revisitsFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "holdings-ops-"));
  holdingsFile = join(dir, "holdings.json");
  opLogFile = join(dir, "ops.log.jsonl");
  revisitsFile = join(dir, "revisits.json");
  saveHoldingsStore(holdingsFile, store());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
async function apply(body: Record<string, unknown>): Promise<OpResult> {
  const parsed = parseOp({ id: `op-holdings-${String(++seq).padStart(4, "0")}`, ...body });
  if (!parsed.ok) throw new Error(parsed.error);
  return (await applyOp(parsed.op, { alertsFile: join(dir, "alerts.json"), holdingsFile, revisitsFile, opLogFile, market: noMarket })).result;
}

const aaplAlert: StaticAlert = {
  id: "aapl0001",
  symbol: "AAPL",
  side: "below",
  status: "live",
  createdAt: "2026-01-01T00:00:00.000Z",
  livePriceAtCreation: 150,
  triggerCount: 0,
  lastTriggeredAt: null,
  lastTriggerPrice: null,
  mutedUntil: null,
  watchingSince: "2026-01-01T00:00:00.000Z",
  watchingSinceApprox: false,
  priceAtWatchStart: null,
  triggerSnapshot: null,
  kind: "static",
  level: 155,
  direction: "up",
  lastKnownSide: "below",
};

const AAPL1_AS_SHOWN = { count: 10, basisPerShare: 150, purchaseDate: "2026-09-01", account: "roth" };

describe("holdings validation", () => {
  it("builds a lot, uppercasing the symbol and dropping an empty account", () => {
    expect(parseLotInput({ symbol: " aapl ", count: "2.5", basisPerShare: 101.25, purchaseDate: "2026-09-10", account: "" })).toEqual({
      ok: true,
      value: { symbol: "AAPL", count: 2.5, basisPerShare: 101.25, purchaseDate: "2026-09-10" },
    });
  });

  it.each([
    [{ count: 1, basisPerShare: 1 }, "Specify the symbol."],
    [{ symbol: "A B", count: 1, basisPerShare: 1 }, "Invalid symbol."],
    [{ symbol: "X", count: -123456, basisPerShare: 1 }, "Shares must be a positive number."],
    [{ symbol: "X", count: 1, basisPerShare: "987654x" }, "Basis per share must be a positive number."],
    [{ symbol: "X", count: 1, basisPerShare: 1, purchaseDate: "09/10/2026" }, "Purchase date must be YYYY-MM-DD."],
    [{ symbol: "X", count: 1, basisPerShare: 1, purchaseDate: "2026-02-30" }, "Purchase date must be a real date."],
    [{ symbol: "X", count: 1, basisPerShare: 1, account: "a".repeat(41) }, "Account must be text of at most 40 characters."],
    [{ symbol: "X", count: 1, basisPerShare: 1, shares: 5 }, 'Unknown field "shares".'],
  ])("rejects %j without echoing a value", (params, message) => {
    expect(parseLotInput(params)).toEqual({ ok: false, error: message });
  });

  it("treats an empty account in an edit as clearing it, and an empty edit as nothing to change", () => {
    expect(parseLotEdit({ account: "" })).toEqual({ ok: true, value: { account: null } });
    expect(parseLotEdit({})).toEqual({ ok: false, error: "Nothing to change." });
  });

  it("builds a stop, with count null meaning all shares", () => {
    expect(parseStopInput({ symbol: "aapl", stopPrice: "140" })).toEqual({ ok: true, value: { symbol: "AAPL", stopPrice: 140, count: null } });
    expect(parseStopInput({ symbol: "AAPL", stopPrice: 0 })).toEqual({ ok: false, error: "Stop price must be a positive number." });
  });

  it("accepts an optional stop on a lot, and rejects shares covered without a price", () => {
    expect(parseLotInput({ symbol: "X", count: 1, basisPerShare: 1, stopPrice: "140", stopCount: "5" })).toEqual({
      ok: true,
      value: { symbol: "X", count: 1, basisPerShare: 1, stopPrice: 140, stopCount: 5 },
    });
    expect(parseLotInput({ symbol: "X", count: 1, basisPerShare: 1, stopCount: 5 })).toEqual({ ok: false, error: "A stop needs a price." });
  });
});

describe("holdings engine", () => {
  it("edits a lot in place, and clears an account with null", () => {
    expect(editLot(holdingsFile, "lotaapl1", { count: 12, account: null })).toMatchObject({ id: "lotaapl1", count: 12, basisPerShare: 150 });
    expect(loadHoldingsStore(holdingsFile).lots[0]).not.toHaveProperty("account");
    expect(editLot(holdingsFile, "nope", { count: 1 })).toBeNull();
  });

  it("removing a lot that isn't the last leaves the position's stops", () => {
    expect(removeLot(holdingsFile, "lotaapl2")).toMatchObject({ closedPosition: false });
    expect(loadHoldingsStore(holdingsFile).stops.map((s) => s.id)).toEqual(["stopaapl", "stopmsft"]);
  });

  it("removing the last lot closes the position: stops and alert state go too", () => {
    expect(removeLot(holdingsFile, "lotmsft1")).toMatchObject({ closedPosition: true });
    const s = loadHoldingsStore(holdingsFile);
    expect(s.stops.map((x) => x.id)).toEqual(["stopaapl"]);
    expect(s.alertState).toEqual([]);
  });

  it("replaceStop drops every existing stop on the symbol before adding the new one", () => {
    const added = replaceStop(holdingsFile, { symbol: "AAPL", stopPrice: 155, count: 3 });
    const stops = loadHoldingsStore(holdingsFile).stops;
    expect(stops.filter((s) => s.symbol === "AAPL")).toEqual([added]);
    expect(stops.filter((s) => s.symbol === "MSFT")).toHaveLength(1); // untouched
  });

  it("removes a whole position", () => {
    const removed = removePosition(holdingsFile, "AAPL");
    expect(removed.lots.map((l) => l.id)).toEqual(["lotaapl1", "lotaapl2"]);
    expect(removed.stops.map((x) => x.id)).toEqual(["stopaapl"]);
    expect(loadHoldingsStore(holdingsFile).lots.map((l) => l.id)).toEqual(["lotmsft1"]);
  });

  // The story needs removals, and stories are published: no size, no basis.
  it("records removed lots for the story, without count or basis", () => {
    removeLot(holdingsFile, "lotmsft1", new Date("2026-09-20T15:00:00.000Z"));
    removePosition(holdingsFile, "AAPL", new Date("2026-09-21T15:00:00.000Z"));
    expect(loadHoldingsStore(holdingsFile).removedLots).toEqual([
      { lotId: "lotmsft1", symbol: "MSFT", purchaseDate: "2026-08-20", createdAt: "2026-08-20T15:00:00.000Z", removedAt: "2026-09-20T15:00:00.000Z" },
      { lotId: "lotaapl1", symbol: "AAPL", purchaseDate: "2026-09-01", createdAt: "2026-09-01T15:00:00.000Z", removedAt: "2026-09-21T15:00:00.000Z" },
      { lotId: "lotaapl2", symbol: "AAPL", purchaseDate: "2026-09-08", createdAt: "2026-09-08T15:00:00.000Z", removedAt: "2026-09-21T15:00:00.000Z" },
    ]);
  });
});

describe("selling shares", () => {
  const NOW = new Date("2026-10-07T18:00:00.000Z");

  it("takes the oldest lot first and trims the next, keeping its id and basis", () => {
    const r = sellShares(holdingsFile, { symbol: "AAPL", count: 12, price: 180, soldOn: "2026-10-07" }, NOW);
    expect(r).toMatchObject({ ok: true, closedPosition: false });
    const s = loadHoldingsStore(holdingsFile);
    expect(s.lots.filter((l) => l.symbol === "AAPL")).toMatchObject([{ id: "lotaapl2", count: 3, basisPerShare: 170 }]);
    expect(s.sales).toEqual([
      {
        id: expect.any(String),
        symbol: "AAPL",
        count: 12,
        price: 180,
        soldOn: "2026-10-07",
        recordedAt: NOW.toISOString(),
        lots: [
          { lotId: "lotaapl1", count: 10, basisPerShare: 150, purchaseDate: "2026-09-01", emptied: true },
          { lotId: "lotaapl2", count: 2, basisPerShare: 170, purchaseDate: "2026-09-08", emptied: false },
        ],
      },
    ]);
    // Only the emptied lot is a removal; the stop stays with the shares left.
    expect(s.removedLots?.map((r) => r.lotId)).toEqual(["lotaapl1"]);
    expect(s.stops.map((x) => x.id)).toEqual(["stopaapl", "stopmsft"]);
  });

  it("dates a backdated sale's removals at the sale, not when it was entered", () => {
    sellShares(holdingsFile, { symbol: "MSFT", count: 3, price: 420, soldOn: "2026-10-01" }, NOW);
    expect(loadHoldingsStore(holdingsFile).removedLots?.[0].removedAt).toBe("2026-10-01T12:00:00.000Z");
  });

  it("sells from one lot, or one account, only", () => {
    sellShares(holdingsFile, { symbol: "AAPL", count: 2, price: 180, lotId: "lotaapl2" }, NOW);
    expect(loadHoldingsStore(holdingsFile).lots.map((l) => [l.id, l.count])).toEqual([["lotaapl1", 10], ["lotaapl2", 3], ["lotmsft1", 3]]);
    // "" is the lots with no account label.
    expect(sellShares(holdingsFile, { symbol: "AAPL", count: 4, price: 180, account: "" }, NOW)).toMatchObject({ ok: false, reason: "too-many" });
    expect(sellShares(holdingsFile, { symbol: "AAPL", count: 1, price: 180, account: "ira" }, NOW)).toMatchObject({ ok: false, reason: "no-lots" });
    sellShares(holdingsFile, { symbol: "AAPL", count: 3, price: 180, account: "" }, NOW);
    expect(loadHoldingsStore(holdingsFile).lots.map((l) => l.id)).toEqual(["lotaapl1", "lotmsft1"]);
  });

  it("selling the last share closes the position like removing the last lot", () => {
    expect(sellShares(holdingsFile, { symbol: "MSFT", count: 3, price: 420 }, NOW)).toMatchObject({ ok: true, closedPosition: true });
    const s = loadHoldingsStore(holdingsFile);
    expect(s.stops.map((x) => x.id)).toEqual(["stopaapl"]);
    expect(s.alertState).toEqual([]);
  });

  it("refuses more shares than are there, and changes nothing", () => {
    expect(sellShares(holdingsFile, { symbol: "AAPL", count: 16, price: 180 }, NOW)).toEqual({ ok: false, reason: "too-many" });
    expect(loadHoldingsStore(holdingsFile)).toEqual(store());
  });

  it.each([
    [{}, { ok: true, value: {} }],
    [{ price: "52.1" }, { ok: true, value: { price: 52.1 } }],
    [{ count: 3, price: 52, soldOn: "2026-10-01", account: " roth " }, { ok: true, value: { count: 3, price: 52, soldOn: "2026-10-01", account: "roth" } }],
    [{ count: 3 }, { ok: false, error: "A sale needs a price." }],
    [{ price: 0 }, { ok: false, error: "Price must be a positive number." }],
    [{ price: 5, soldOn: "2026-02-30" }, { ok: false, error: "Sale date must be a real date." }],
  ])("parses position sale params %j", (params, expected) => {
    expect(parseSaleParams(params, "position")).toEqual(expected);
  });

  it("takes no account on a lot", () => {
    expect(parseSaleParams({ price: 5, account: "roth" }, "lot")).toEqual({ ok: false, error: 'Unknown field "account".' });
  });
});

describe("holdings ops", () => {
  it("lot.remove with a price sells it, all or part", async () => {
    expect(await apply({ type: "lot.remove", target: { lotId: "lotaapl1" }, expect: AAPL1_AS_SHOWN, params: { count: 4, price: 180 } })).toMatchObject({
      ok: true,
      message: "Sold part of a lot of AAPL.",
    });
    expect(loadHoldingsStore(holdingsFile).lots[0]).toMatchObject({ id: "lotaapl1", count: 6 });
    expect(await apply({ type: "lot.remove", target: { lotId: "lotmsft1" }, expect: { count: 3, basisPerShare: 410, purchaseDate: "2026-08-20" }, params: { price: 420 } })).toMatchObject({
      ok: true,
      message: "Sold the last of MSFT, so the position and its stops are gone.",
    });
    expect(loadHoldingsStore(holdingsFile).sales?.map((x) => [x.symbol, x.count, x.price])).toEqual([["AAPL", 4, 180], ["MSFT", 3, 420]]);
  });

  it("position.remove with a price sells part of it oldest first, guarded on the sizes shown", async () => {
    const lotIds = ["lotaapl1", "lotaapl2"];
    expect(await apply({ type: "position.remove", target: { symbol: "AAPL" }, expect: { lotIds, shares: 14 }, params: { count: 12, price: 180 } })).toMatchObject({
      ok: false,
      message: "Not removed: the AAPL position changed since the page loaded.",
    });
    expect(await apply({ type: "position.remove", target: { symbol: "AAPL" }, expect: { lotIds, shares: 15 }, params: { count: 16, price: 180 } })).toMatchObject({
      ok: false,
      message: "Not sold: that is more AAPL shares than the position holds.",
    });
    expect(await apply({ type: "position.remove", target: { symbol: "AAPL" }, expect: { lotIds, shares: 15 }, params: { count: 12, price: 180 } })).toMatchObject({
      ok: true,
      message: "Sold part of the AAPL position.",
    });
    expect(loadHoldingsStore(holdingsFile).lots.filter((l) => l.symbol === "AAPL")).toMatchObject([{ id: "lotaapl2", count: 3 }]);
  });

  it("position.remove with a price and an account sells only that account's lots", async () => {
    const r = await apply({ type: "position.remove", target: { symbol: "AAPL" }, expect: { lotIds: ["lotaapl1", "lotaapl2"] }, params: { price: 180, account: "roth" } });
    expect(r).toMatchObject({ ok: true, message: "Sold part of the AAPL position." });
    expect(loadHoldingsStore(holdingsFile).lots.filter((l) => l.symbol === "AAPL").map((l) => l.id)).toEqual(["lotaapl2"]);
  });

  it("a removal without a price still records no sale", async () => {
    await apply({ type: "position.remove", target: { symbol: "MSFT" }, expect: { lotIds: ["lotmsft1"] }, params: {} });
    expect(loadHoldingsStore(holdingsFile).sales).toBeUndefined();
  });

  it("adds a lot", async () => {
    const r = await apply({ type: "lot.add", params: { symbol: "nvda", count: 4, basisPerShare: 120.5, purchaseDate: "2026-09-12", account: "margin" } });
    expect(r).toMatchObject({ ok: true, symbol: "NVDA", alertId: null, message: "Added a lot of NVDA." });
    expect(loadHoldingsStore(holdingsFile).lots.at(-1)).toMatchObject({ symbol: "NVDA", count: 4, basisPerShare: 120.5, purchaseDate: "2026-09-12", account: "margin" });
  });

  it("a lot added with a stop for a new position just adds the stop", async () => {
    const r = await apply({ type: "lot.add", params: { symbol: "nvda", count: 4, basisPerShare: 120.5, stopPrice: 100 } });
    expect(r).toMatchObject({ ok: true, symbol: "NVDA", message: "Added a lot of NVDA and set its stop." });
    expect(loadHoldingsStore(holdingsFile).stops.filter((s) => s.symbol === "NVDA")).toMatchObject([{ stopPrice: 100, count: null }]);
  });

  it("a lot added with a stop on an existing position replaces its stop instead of adding alongside", async () => {
    const r = await apply({ type: "lot.add", params: { symbol: "aapl", count: 2, basisPerShare: 200, stopPrice: 160, stopCount: 12 } });
    expect(r).toMatchObject({ ok: true, message: "Added a lot of AAPL and set its stop." });
    const aaplStops = loadHoldingsStore(holdingsFile).stops.filter((s) => s.symbol === "AAPL");
    expect(aaplStops).toMatchObject([{ stopPrice: 160, count: 12 }]);
    // The MSFT stop is untouched.
    expect(loadHoldingsStore(holdingsFile).stops.some((s) => s.symbol === "MSFT")).toBe(true);
  });

  it("edits a lot that still looks the way the page showed it", async () => {
    const r = await apply({ type: "lot.edit", target: { lotId: "lotaapl1" }, expect: AAPL1_AS_SHOWN, params: { count: 12, account: "" } });
    expect(r).toMatchObject({ ok: true, message: "Edited a lot of AAPL." });
    expect(loadHoldingsStore(holdingsFile).lots[0]).toMatchObject({ count: 12 });
    expect(loadHoldingsStore(holdingsFile).lots[0]).not.toHaveProperty("account");
  });

  it("rejects a lot edit or removal against a changed lot", async () => {
    const stale = { ...AAPL1_AS_SHOWN, count: 9 };
    expect(await apply({ type: "lot.edit", target: { lotId: "lotaapl1" }, expect: stale, params: { count: 12 } })).toMatchObject({
      ok: false,
      message: "Not changed: that AAPL lot changed since the page loaded.",
    });
    expect(await apply({ type: "lot.remove", target: { lotId: "lotaapl1" }, expect: { ...AAPL1_AS_SHOWN, account: null } })).toMatchObject({ ok: false });
    expect(await apply({ type: "lot.remove", target: { lotId: "gone0000" }, expect: AAPL1_AS_SHOWN })).toMatchObject({
      ok: false,
      message: "That lot no longer exists. It may have been removed.",
    });
    expect(loadHoldingsStore(holdingsFile)).toEqual(store());
  });

  it("says when removing a lot closed the position", async () => {
    const r = await apply({
      type: "lot.remove",
      target: { lotId: "lotmsft1" },
      expect: { count: 3, basisPerShare: 410, purchaseDate: "2026-08-20", account: null },
    });
    expect(r).toMatchObject({ ok: true, message: "Removed a lot of MSFT. It was the last one, so the position and its stops are gone." });
  });

  it("removes a position only when its lots are the ones the page showed", async () => {
    expect(await apply({ type: "position.remove", target: { symbol: "AAPL" }, expect: { lotIds: ["lotaapl1"] } })).toMatchObject({
      ok: false,
      message: "Not removed: the AAPL position changed since the page loaded.",
    });
    expect(await apply({ type: "position.remove", target: { symbol: "aapl" }, expect: { lotIds: ["lotaapl2", "lotaapl1"] } })).toMatchObject({
      ok: true,
      message: "Removed the AAPL position and its stops.",
    });
    expect(await apply({ type: "position.remove", target: { symbol: "TSLA" }, expect: { lotIds: [] } })).toMatchObject({ ok: false, message: "No TSLA position to remove." });
  });

  it("adds a stop only to a held symbol, and removes one only at the price shown", async () => {
    expect(await apply({ type: "stop.add", params: { symbol: "TSLA", stopPrice: 200 } })).toMatchObject({
      ok: false,
      message: "Not added: there is no TSLA position to put a stop on.",
    });
    expect(await apply({ type: "stop.add", params: { symbol: "AAPL", stopPrice: 145, count: 5 } })).toMatchObject({ ok: true, message: "Added a stop for AAPL." });
    expect(loadHoldingsStore(holdingsFile).stops.at(-1)).toMatchObject({ symbol: "AAPL", stopPrice: 145, count: 5 });
    expect(await apply({ type: "stop.remove", target: { stopId: "stopaapl" }, expect: { stopPrice: 141 } })).toMatchObject({ ok: false });
    expect(await apply({ type: "stop.remove", target: { stopId: "stopaapl" }, expect: { stopPrice: 140 } })).toMatchObject({ ok: true, message: "Removed a stop for AAPL." });
  });

  // Moving a stop used to be a remove and an add: two ops, either of which
  // could land alone. It is one guarded op now, on the same expect.stopPrice
  // the removal uses.
  it("moves a stop only when it still reads as the page showed it", async () => {
    expect(await apply({ type: "stop.edit", target: { stopId: "stopaapl" }, expect: { stopPrice: 141 }, params: { stopPrice: 150 } })).toMatchObject({
      ok: false,
      message: "Not changed: that AAPL stop changed since the page loaded.",
    });
    expect(await apply({ type: "stop.edit", target: { stopId: "stopaapl" }, expect: { stopPrice: 140 }, params: { stopPrice: 150 } })).toMatchObject({
      ok: true,
      message: "Moved the stop for AAPL.",
    });
    const stops = loadHoldingsStore(holdingsFile).stops.filter((s) => s.symbol === "AAPL");
    expect(stops).toHaveLength(1);
    // A fresh id, and the cover it had is kept when the edit doesn't mention it.
    expect(stops[0]).toMatchObject({ stopPrice: 150, count: null });
    expect(stops[0].id).not.toBe("stopaapl");
  });

  it("changes a stop's cover only when the edit says so", async () => {
    await apply({ type: "stop.edit", target: { stopId: "stopaapl" }, expect: { stopPrice: 140 }, params: { stopPrice: 150, count: 3 } });
    expect(loadHoldingsStore(holdingsFile).stops.filter((s) => s.symbol === "AAPL")[0]).toMatchObject({ stopPrice: 150, count: 3 });
  });

  it("rejects a missing target", async () => {
    expect(await apply({ type: "lot.edit", params: { count: 1 } })).toMatchObject({ ok: false, message: "A lot edit needs target.lotId." });
    expect(await apply({ type: "stop.remove" })).toMatchObject({ ok: false, message: "A stop removal needs target.stopId." });
    expect(await apply({ type: "stop.edit", params: { stopPrice: 1 } })).toMatchObject({ ok: false, message: "A stop edit needs target.stopId." });
  });

  // A change to a lot, a position or a stop is a decision about the symbol,
  // so its open fires leave the revisit queue; other symbols' stay.
  it.each([
    ["lot.add", { type: "lot.add", params: { symbol: "AAPL", count: 4, basisPerShare: 120.5 } }],
    ["lot.edit", { type: "lot.edit", target: { lotId: "lotaapl1" }, expect: AAPL1_AS_SHOWN, params: { count: 11 } }],
    ["lot.remove", { type: "lot.remove", target: { lotId: "lotaapl1" }, expect: AAPL1_AS_SHOWN }],
    ["stop.add", { type: "stop.add", params: { symbol: "AAPL", stopPrice: 130 } }],
    ["stop.edit", { type: "stop.edit", target: { stopId: "stopaapl" }, expect: { stopPrice: 140 }, params: { stopPrice: 150 } }],
    ["stop.remove", { type: "stop.remove", target: { stopId: "stopaapl" }, expect: { stopPrice: 140 } }],
  ])("%s closes the symbol's open revisits", async (type, body) => {
    const base = newRevisitEntry(aaplAlert, 160, "2026-09-14T15:00:00.000Z", "regular");
    saveRevisits(revisitsFile, [
      { ...base, id: "rv000001" },
      { ...base, id: "rv000002", status: "dismissed" },
      { ...base, id: "rv000003", symbol: "MSFT" },
    ]);
    const r = await apply(body);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("Its open revisits were closed.");
    expect(loadRevisits(revisitsFile).map((e) => e.status)).toEqual(["applied", "dismissed", "open"]);
    expect(loadRevisits(revisitsFile)[0]).toMatchObject({ appliedFrom: null, appliedTo: null, closedBy: { change: type } });
  });

  it("position.remove closes the symbol's open revisits, and a refused op closes none", async () => {
    const base = newRevisitEntry({ ...aaplAlert, symbol: "MSFT" }, 400, "2026-09-14T15:00:00.000Z", "regular");
    saveRevisits(revisitsFile, [{ ...base, id: "rv000001" }]);
    const refused = await apply({ type: "stop.remove", target: { stopId: "stopmsft" }, expect: { stopPrice: 999 } });
    expect(refused.ok).toBe(false);
    expect(loadRevisits(revisitsFile)[0].status).toBe("open");
    const r = await apply({ type: "position.remove", target: { symbol: "MSFT" }, expect: { lotIds: ["lotmsft1"] } });
    expect(r.ok).toBe(true);
    expect(loadRevisits(revisitsFile)[0].status).toBe("applied");
  });

  // opResults are published in the public dashboard.json.
  it("never puts a share count, basis, or price in a result message", async () => {
    const results = [
      await apply({ type: "lot.add", params: { symbol: "NVDA", count: 4, basisPerShare: 120.5 } }),
      await apply({ type: "lot.add", params: { symbol: "NVDA", count: -4, basisPerShare: 120.5 } }),
      await apply({ type: "lot.edit", target: { lotId: "lotaapl1" }, expect: AAPL1_AS_SHOWN, params: { basisPerShare: "abc" } }),
      await apply({ type: "lot.edit", target: { lotId: "lotaapl1" }, expect: AAPL1_AS_SHOWN, params: { count: 11 } }),
      await apply({ type: "stop.add", params: { symbol: "MSFT", stopPrice: 390 } }),
      await apply({ type: "stop.remove", target: { stopId: "stopmsft" }, expect: { stopPrice: 999 } }),
      await apply({ type: "stop.edit", target: { stopId: "stopmsft" }, expect: { stopPrice: 999 }, params: { stopPrice: 400 } }),
      await apply({ type: "stop.edit", target: { stopId: "stopaapl" }, expect: { stopPrice: 140 }, params: { stopPrice: 150 } }),
      await apply({ type: "lot.remove", target: { lotId: "lotaapl1" }, expect: AAPL1_AS_SHOWN, params: { count: 4, price: 180.25 } }),
      await apply({ type: "lot.remove", target: { lotId: "lotaapl1" }, expect: { ...AAPL1_AS_SHOWN, count: 6 }, params: { count: 7, price: 180.25 } }),
      await apply({ type: "lot.remove", target: { lotId: "lotaapl1" }, expect: { ...AAPL1_AS_SHOWN, count: 6 }, params: { count: 2 } }),
      await apply({ type: "position.remove", target: { symbol: "AAPL" }, expect: { lotIds: ["lotaapl1", "lotaapl2"] }, params: { count: 99, price: 180.25 } }),
      await apply({ type: "position.remove", target: { symbol: "AAPL" }, expect: { lotIds: ["lotaapl1", "lotaapl2"] }, params: { count: 3, price: 180.25 } }),
      await apply({ type: "position.remove", target: { symbol: "MSFT" }, expect: { lotIds: ["lotmsft1"] } }),
    ];
    for (const r of results) {
      expect(r.message).not.toMatch(/\d/);
    }
  });
});

describe("vault", () => {
  const contents = vaultContents({ holdings: [], stories: [] }, store());

  it("round-trips, and a wrong token can't open it", () => {
    const doc = sealVault(contents, TOKEN);
    expect(openVault(doc, TOKEN)).toEqual(contents);
    expect(() => openVault(doc, "u".repeat(64))).toThrow();
  });

  it("keeps sizes and prices out of the published document's plaintext", () => {
    const text = JSON.stringify(sealVault(contents, TOKEN));
    expect(text).not.toMatch(/AAPL|basisPerShare|stopPrice|roth/);
  });

  it("uses a fresh IV per seal", () => {
    expect(sealVault(contents, TOKEN).iv).not.toBe(sealVault(contents, TOKEN).iv);
  });

  it("opens with WebCrypto exactly as web/app.js does", async () => {
    const appJs = readFileSync(new URL("../web/app.js", import.meta.url), "utf-8");
    const context = /const VAULT_KEY_CONTEXT = "([^"]*)";/.exec(appJs)?.[1];
    expect(context).toBe("equity-watch/holdings-vault/v1 ");
    const doc = sealVault(contents, TOKEN);
    const raw = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(context + TOKEN));
    const key = await webcrypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    const plain = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(doc.iv, "base64") }, key, Buffer.from(doc.data, "base64"));
    expect(JSON.parse(new TextDecoder().decode(plain))).toEqual(contents);
  });

  describe("publishing", () => {
    const NOW = new Date("2026-09-15T16:00:00.000Z");
    const quotes = new Map<string, Quote>([
      ["AAPL", { lastPrice: 180, totalVolume: 0 }],
      ["MSFT", { lastPrice: 420, totalVolume: 0 }],
    ]);
    const build = (s: HoldingsStore, q: Map<string, Quote>) => buildDashboard({ alerts: [], revisits: [], holdings: s, quotes: q, now: NOW });
    const fingerprint = (s: HoldingsStore, q: Map<string, Quote>) => {
      const d = build(s, q);
      return siteFingerprint(siteDocument(d, { holdings: false, ops: true, vault: true }), [], vaultContents(d, s));
    };

    // --skip-unchanged fingerprints a quote-less build and compares it to the published one.
    it("fingerprints the same with and without quotes", () => {
      expect(fingerprint(store(), new Map())).toBe(fingerprint(store(), quotes));
    });

    it("moves the fingerprint when a lot or stop changes", () => {
      const edited = store();
      edited.lots[0].count = 11;
      expect(fingerprint(edited, quotes)).not.toBe(fingerprint(store(), quotes));
      const stopped = store();
      stopped.stops.pop();
      expect(fingerprint(stopped, quotes)).not.toBe(fingerprint(store(), quotes));
    });

    const revisits = [0, 1].map((i) => ({
        id: `r${i}`, alertId: "a1", symbol: "AAPL", kind: "static" as const, triggeredAt: `2026-09-1${i}T14:00:00.000Z`,
        triggerPrice: 181, levelAtTrigger: 180, session: "regular" as const, watchingSince: null, watchingSinceApprox: false,
        priceAtWatchStart: null, status: "open" as const, suggestedLevel: null, suggestedAt: null, suggestionBasis: null,
        resolvedAt: null, appliedFrom: null, appliedTo: null, priority: null, signals: null,
      }));

    // Stories tell your buys and sales: only the vault may carry them, holdings on or off.
    it("publishes stories in the vault and never in dashboard.json", () => {
      const d = buildDashboard({ alerts: [], revisits, holdings: store(), quotes, now: NOW });
      expect(d.stories.map((s) => s.symbol)).toContain("AAPL");
      for (const holdings of [false, true]) {
        expect(siteDocument(d, { holdings, vault: true }).stories).toEqual([]);
      }
      const site = join(dir, "site");
      writeSite(site, d, { holdings: true, vault: true }, [], NO_OPS, sealVault(vaultContents(d, store()), TOKEN));
      expect(readFileSync(join(site, "dashboard.json"), "utf-8")).not.toContain("you bought");
      const opened = openVault(JSON.parse(readFileSync(join(site, VAULT_FILE), "utf-8")) as VaultDocument, TOKEN);
      expect(opened.stories.find((s) => s.symbol === "AAPL")?.lines.map((l) => l.text)).toContain("Sep 1: you bought AAPL.");
    });

    // Every drawer reads its symbol's story out of the vault, so a cap left most drawers without one.
    it("tells every symbol's story, not the top five", () => {
      const symbols = ["A1", "B2", "C3", "D4", "E5", "F6", "G7"];
      const many = symbols.flatMap((symbol, i) => revisits.map((r) => ({ ...r, id: `${r.id}-${i}`, symbol })));
      const d = buildDashboard({ alerts: [], revisits: many, holdings: store(), quotes, now: NOW });
      expect(d.stories.map((st) => st.symbol).sort()).toEqual(symbols);
    });

    // A sale's line carries shares and price, so it is the strictest case of the rule above.
    it("tells a sale's size and price in the vault's story, and nowhere in dashboard.json", () => {
      sellShares(holdingsFile, { symbol: "AAPL", count: 12, price: 181.5, soldOn: "2026-09-12" }, new Date("2026-09-12T18:00:00.000Z"));
      const sold = loadHoldingsStore(holdingsFile);
      const d = buildDashboard({ alerts: [], revisits, holdings: sold, quotes, now: NOW });
      const site = join(dir, "site");
      writeSite(site, d, { holdings: true, vault: true }, [], NO_OPS, sealVault(vaultContents(d, sold), TOKEN));
      const published = readFileSync(join(site, "dashboard.json"), "utf-8");
      expect(published).not.toContain("you sold");
      expect(published).not.toContain("181.5");
      const opened = openVault(JSON.parse(readFileSync(join(site, VAULT_FILE), "utf-8")) as VaultDocument, TOKEN);
      // 10 at 150 and 2 at 170 cost 1,840; 12 at 181.50 is 2,178.
      expect(opened.stories.find((s) => s.symbol === "AAPL")?.lines.map((l) => l.text)).toContain(
        "Sep 12: you sold part of your AAPL position: 12 shares at 181.50, up 18.4% on what they cost."
      );
    });

    it("moves the fingerprint when a story changes, through the vault", () => {
      const removed = store();
      removed.removedLots = [{ lotId: "gone", symbol: "AAPL", purchaseDate: "2026-07-01", createdAt: "2026-07-01T15:00:00.000Z", removedAt: "2026-07-02T15:00:00.000Z" }];
      const withStories = (s: HoldingsStore) => {
        const d = buildDashboard({ alerts: [], revisits, holdings: s, quotes, now: NOW });
        const doc = siteDocument(d, { holdings: false, ops: true, vault: true });
        return { doc, print: siteFingerprint(doc, [], vaultContents(d, s)) };
      };
      // The document is identical; only the vault's story differs.
      expect(withStories(removed).doc.stories).toEqual(withStories(store()).doc.stories);
      expect(withStories(removed).print).not.toBe(withStories(store()).print);
    });

    it("leaves a vault-less fingerprint as it was", () => {
      const d = build(store(), quotes);
      const doc = siteDocument(d, { holdings: false });
      expect(siteFingerprint(doc, [], null)).toBe(siteFingerprint(doc, []));
    });

    it("writes vault.json when given one and deletes a stale one otherwise", () => {
      const site = join(dir, "site");
      const d = build(store(), quotes);
      writeSite(site, d, { holdings: false, vault: true }, [], NO_OPS, sealVault(vaultContents(d, store()), TOKEN));
      expect(existsSync(join(site, VAULT_FILE))).toBe(true);
      expect(readFileSync(join(site, "dashboard.json"), "utf-8")).not.toMatch(/"shares"|"basis"|"marketValue"/);
      writeSite(site, d, { holdings: false }, []);
      expect(existsSync(join(site, VAULT_FILE))).toBe(false);
    });
  });
});
