import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MarketData } from "../src/alerts/engine.js";
import type { StaticAlert } from "../src/alerts/models.js";
import { loadAlerts, saveAlerts } from "../src/alerts/store.js";
import { applyOp, loadOpLog, parseOp, recentOpResults, type Op, type OpResult } from "../src/ops/apply.js";
import { pullOps, type OpsQueue, type QueueMessage } from "../src/ops/pull.js";
import { addFieldsFromJson, parseAddInput, parseAlertEdit } from "../src/ops/validate.js";
import type { Quote } from "../src/providers/schwab.js";

function fakeMarket(prices: Record<string, number>): MarketData & { quoteCalls: number } {
  const market = {
    quoteCalls: 0,
    getQuotes: async (symbols: string[]) => {
      market.quoteCalls++;
      const out = new Map<string, Quote>();
      for (const s of symbols) {
        if (prices[s] !== undefined) out.set(s, { lastPrice: prices[s], totalVolume: 0 });
      }
      return out;
    },
    getIntradayBars: async () => [],
    getDailyBars: async () => [],
  };
  return market;
}

function makeStatic(overrides: Partial<StaticAlert> = {}): StaticAlert {
  return {
    id: "s1abcdef",
    symbol: "TEST",
    side: "below",
    status: "live",
    createdAt: "2026-01-01T00:00:00.000Z",
    livePriceAtCreation: 105,
    triggerCount: 0,
    lastTriggeredAt: null,
    lastTriggerPrice: null,
    mutedUntil: null,
    watchingSince: "2026-01-01T00:00:00.000Z",
    watchingSinceApprox: false,
    priceAtWatchStart: null,
    triggerSnapshot: null,
    kind: "static",
    direction: "up",
    level: 100,
    lastKnownSide: "above",
    ...overrides,
  };
}

describe("parseAddInput", () => {
  it("builds a static alert with the default direction", () => {
    const r = parseAddInput({ symbol: " gmed ", level: "80.5" });
    expect(r).toEqual({ ok: true, value: { kind: "static", symbol: "GMED", level: 80.5, direction: "up", volume: undefined } });
  });

  it("accepts numbers from JSON as well as flag strings", () => {
    const r = parseAddInput({ symbol: "GMED", level: 80.5, direction: "down", volumeRatio: 1.5, volumePeriod: "30m" });
    expect(r.ok && r.value).toEqual({
      kind: "static",
      symbol: "GMED",
      level: 80.5,
      direction: "down",
      volume: { ratio: 1.5, mode: "period", periodValue: 30, periodUnit: "m" },
    });
  });

  it.each([
    [{ level: 10 }, "Specify the symbol"],
    [{ symbol: "A B", level: 10 }, 'Invalid symbol "A B"'],
    [{ symbol: "X", level: "abc" }, 'Invalid --level "abc"'],
    [{ symbol: "X", level: 0 }, 'Invalid --level "0"'],
    [{ symbol: "X", level: 10, near: 10 }, "at most one of --level"],
    [{ symbol: "X", near: 10, direction: "up" }, "--direction applies to --level"],
    [{ symbol: "X" }, "Specify --level, --near"],
    [{ symbol: "X", level: 10, direction: "sideways" }, 'Invalid --direction "sideways"'],
    [{ symbol: "X", level: 10, trailPercent: 3 }, "only apply to trailing alerts"],
    [{ symbol: "X", near: 10 }, "exactly one of --trail-percent or --trail-amount"],
    [{ symbol: "X", trailPercent: 3, volumeRatio: 2 }, "require --near"],
    [{ symbol: "X", level: 10, volumeAtLeast: 5, volumeRatio: 2 }, "not both"],
    [{ symbol: "X", level: 10, volumeRatio: -1 }, 'Invalid --volume-ratio "-1"'],
    [{ symbol: "X", level: 10, volumePeriod: "30m" }, "--volume-period requires"],
    [{ symbol: "X", level: 10, volumeRatio: 2, volumePeriod: "30x" }, 'Invalid --volume-period "30x"'],
    [{ symbol: "X", ma: "sma200@1W", level: 10 }, "--ma can't be combined"],
    [{ symbol: "X", ma: "nonsense" }, ""],
    [{ symbol: "X", ma: "sma200@1W", touch: 50 }, 'Invalid --touch margin "50"'],
    [{ symbol: "X", ma: "sma200@1W", touch: true, direction: "up" }, "--direction applies to crosses"],
    [{ symbol: "X", ma: "sma200@1W", from: "above" }, "--from applies to touches"],
    [{ symbol: "X", ma: "sma200@1W", direction: "either" }, 'expected up or down'],
  ])("rejects %j", (raw, message) => {
    const r = parseAddInput(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });

  it("builds moving-average crosses and touches", () => {
    const cross = parseAddInput({ symbol: "X", ma: "sma200@1W", direction: "up" });
    expect(cross.ok && cross.value).toMatchObject({ kind: "ma", trigger: "cross", from: "below", marginPct: 0.25 });
    const touch = parseAddInput({ symbol: "X", ma: "ema9@5m", touch: "0.5", from: "above" });
    expect(touch.ok && touch.value).toMatchObject({ kind: "ma", trigger: "touch", from: "above", marginPct: 0.5 });
  });
});

describe("parseAlertEdit", () => {
  it("builds an edit from mixed fields", () => {
    const r = parseAlertEdit({ level: "93", direction: "either", clearVolume: true });
    expect(r).toEqual({ ok: true, value: { level: 93, direction: "either", volume: null } });
  });

  it("returns an empty edit rather than rejecting it", () => {
    expect(parseAlertEdit({})).toEqual({ ok: true, value: {} });
  });

  it.each([
    [{ level: -1 }, 'Invalid --level "-1"'],
    [{ trailPercent: 1, trailAmount: 1 }, "not both"],
    [{ clearVolume: true, volumeRatio: 2 }, "--clear-volume can't be combined"],
    [{ from: "sideways" }, 'Invalid --from "sideways"'],
  ])("rejects %j", (raw, message) => {
    const r = parseAlertEdit(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });
});

describe("addFieldsFromJson", () => {
  it("rejects unknown keys and non-scalar values, and drops empty ones", () => {
    expect(addFieldsFromJson({ symbol: "X", level: 1, evil: 1 })).toEqual({ ok: false, error: 'Unknown field "evil".' });
    expect(addFieldsFromJson({ symbol: { a: 1 } })).toMatchObject({ ok: false });
    expect(addFieldsFromJson([])).toMatchObject({ ok: false });
    expect(addFieldsFromJson({ symbol: "X", level: 5, volumeRatio: "", near: null })).toEqual({ ok: true, value: { symbol: "X", level: 5 } });
  });
});

describe("parseOp", () => {
  it("accepts a well-formed add and edit", () => {
    expect(parseOp({ id: "0b8c9f1e-1111", type: "alert.add", createdAt: "x", params: { symbol: "X", level: 1 } }).ok).toBe(true);
    expect(
      parseOp({ id: "0b8c9f1e-1111", type: "alert.edit", target: { alertId: "a" }, expect: { condition: "c" }, params: { level: 1 } }).ok
    ).toBe(true);
  });

  it.each([
    [null, "JSON object"],
    [{ type: "alert.add", params: {} }, "needs an id"],
    [{ id: "short", type: "alert.add", params: {} }, "needs an id"],
    [{ id: "0b8c9f1e-1111", type: "alert.remove", params: {} }, 'Unknown op type "alert.remove"'],
  ])("rejects %j", (body, message) => {
    const r = parseOp(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });
});

describe("applyOp", () => {
  let dir: string;
  let alertsFile: string;
  let opLogFile: string;
  const NOW = () => new Date("2026-09-15T15:00:00.000Z");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ops-"));
    alertsFile = join(dir, "alerts.json");
    opLogFile = join(dir, "ops.log.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const add = (params: Record<string, unknown>, id = "op-add-0001"): Op => {
    const r = parseOp({ id, type: "alert.add", createdAt: "2026-09-15T14:59:00.000Z", params });
    if (!r.ok) throw new Error(r.error);
    return r.op;
  };
  const edit = (alertId: string, condition: string, params: Record<string, unknown>, id = "op-edit-0001"): Op => {
    const r = parseOp({ id, type: "alert.edit", target: { alertId }, expect: { condition }, params });
    if (!r.ok) throw new Error(r.error);
    return r.op;
  };

  it("adds an alert and logs the result", async () => {
    const market = fakeMarket({ GMED: 75 });
    const { result, duplicate } = await applyOp(add({ symbol: "gmed", level: 80.5 }), { alertsFile, opLogFile, market, now: NOW });
    expect(duplicate).toBe(false);
    expect(result).toMatchObject({ id: "op-add-0001", type: "alert.add", symbol: "GMED", ok: true, appliedAt: "2026-09-15T15:00:00.000Z" });
    expect(result.message).toContain("price crosses above 80.5");
    const alerts = loadAlerts(alertsFile);
    expect(alerts).toHaveLength(1);
    expect(result.alertId).toBe(alerts[0].id);
    expect(loadOpLog(opLogFile)).toEqual([result]);
  });

  it("applies the same op id only once", async () => {
    const market = fakeMarket({ GMED: 75 });
    const op = add({ symbol: "GMED", level: 80.5 });
    const first = await applyOp(op, { alertsFile, opLogFile, market });
    const second = await applyOp(op, { alertsFile, opLogFile, market });
    expect(second).toEqual({ result: first.result, duplicate: true });
    expect(loadAlerts(alertsFile)).toHaveLength(1);
    expect(loadOpLog(opLogFile)).toHaveLength(1);
    expect(market.quoteCalls).toBe(1);
  });

  it("logs validation and engine rejections as results", async () => {
    const market = fakeMarket({ GMED: 80.5 });
    const invalid = await applyOp(add({ symbol: "GMED", level: "abc" }, "op-add-0002"), { alertsFile, opLogFile, market });
    expect(invalid.result).toMatchObject({ ok: false, symbol: "GMED" });
    expect(invalid.result.message).toContain('Invalid --level "abc"');
    const noQuote = await applyOp(add({ symbol: "NOPE", level: 10 }, "op-add-0003"), { alertsFile, opLogFile, market });
    expect(noQuote.result).toMatchObject({ ok: false, message: "Not added: No quote available for NOPE." });
    const atPrice = await applyOp(add({ symbol: "GMED", level: 80.5 }, "op-add-0004"), { alertsFile, opLogFile, market });
    expect(atPrice.result.ok).toBe(false);
    expect(loadAlerts(alertsFile)).toEqual([]);
    expect(loadOpLog(opLogFile)).toHaveLength(3);
  });

  it("edits an alert whose condition still matches the page", async () => {
    saveAlerts(alertsFile, [makeStatic()]);
    const market = fakeMarket({ TEST: 105 });
    const { result } = await applyOp(edit("s1abcdef", "price crosses above 100", { level: 110 }), { alertsFile, opLogFile, market });
    expect(result).toMatchObject({ ok: true, symbol: "TEST", alertId: "s1abcdef" });
    expect(result.message).toBe('Edited static alert s1abcdef: was "price crosses above 100", now "price crosses above 110".');
    expect((loadAlerts(alertsFile)[0] as StaticAlert).level).toBe(110);
  });

  it("rejects an edit when the alert changed since the page loaded", async () => {
    saveAlerts(alertsFile, [makeStatic({ level: 95 })]);
    const { result } = await applyOp(edit("s1abcdef", "price crosses above 100", { level: 110 }), { alertsFile, opLogFile, market: fakeMarket({ TEST: 105 }) });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('It is now "price crosses above 95"');
    expect((loadAlerts(alertsFile)[0] as StaticAlert).level).toBe(95);
  });

  it("targets edits by id, never by symbol", async () => {
    saveAlerts(alertsFile, [makeStatic()]);
    const { result } = await applyOp(edit("TEST", "price crosses above 100", { level: 110 }), { alertsFile, opLogFile, market: fakeMarket({ TEST: 105 }) });
    expect(result).toMatchObject({ ok: false, message: "No alert with id TEST. It may have been removed." });
  });

  // Parsing checks only the envelope, so these become results the page can
  // show, not messages dropped as malformed that leave it waiting.
  it("logs a missing target, expect, or unknown field as a rejection", async () => {
    saveAlerts(alertsFile, [makeStatic()]);
    const market = fakeMarket({ TEST: 105 });
    const apply = async (body: Record<string, unknown>) => {
      const parsed = parseOp({ type: "alert.edit", ...body });
      if (!parsed.ok) throw new Error(parsed.error);
      return (await applyOp(parsed.op, { alertsFile, opLogFile, market })).result;
    };
    expect(await apply({ id: "op-bad-0001", expect: { condition: "c" }, params: { level: 1 } })).toMatchObject({ ok: false, message: "An edit needs target.alertId." });
    expect(await apply({ id: "op-bad-0002", target: { alertId: "s1abcdef" }, params: { level: 1 } })).toMatchObject({ ok: false, message: "An edit needs expect.condition." });
    expect(await apply({ id: "op-bad-0003", target: { alertId: "s1abcdef" }, expect: { condition: "price crosses above 100" }, params: { evil: 1 } })).toMatchObject({
      ok: false,
      message: 'Unknown field "evil".',
    });
    expect(loadOpLog(opLogFile)).toHaveLength(3);
  });

  it("rejects an edit the alert's kind doesn't support", async () => {
    saveAlerts(alertsFile, [makeStatic()]);
    const { result } = await applyOp(edit("s1abcdef", "price crosses above 100", { trailPercent: 3 }), { alertsFile, opLogFile, market: fakeMarket({}) });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("has no trail to edit");
  });

  it("lets an exception propagate without logging, so the op is retried", async () => {
    const market = fakeMarket({});
    market.getQuotes = async () => {
      throw new Error("Schwab down");
    };
    await expect(applyOp(add({ symbol: "GMED", level: 80.5 }), { alertsFile, opLogFile, market })).rejects.toThrow("Schwab down");
    expect(existsSync(opLogFile)).toBe(false);
  });
});

describe("recentOpResults", () => {
  it("returns the newest first, capped", () => {
    const log = [1, 2, 3].map((n) => ({ id: `op-${n}` }) as OpResult);
    expect(recentOpResults(log, 2).map((r) => r.id)).toEqual(["op-3", "op-2"]);
  });
});

describe("pullOps", () => {
  let dir: string;
  let alertsFile: string;
  let opLogFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ops-pull-"));
    alertsFile = join(dir, "alerts.json");
    opLogFile = join(dir, "ops.log.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function fakeQueue(bodies: string[]): OpsQueue & { removed: string[]; waits: number[] } {
    const pending: QueueMessage[] = bodies.map((body, i) => ({ body, receiptHandle: `r${i}` }));
    const queue = {
      removed: [] as string[],
      waits: [] as number[],
      async receive(max: number, waitSeconds: number) {
        queue.waits.push(waitSeconds);
        return pending.filter((m) => !queue.removed.includes(m.receiptHandle)).slice(0, Math.min(max, 2));
      },
      async remove(handle: string) {
        queue.removed.push(handle);
      },
    };
    return queue;
  }

  const addBody = (id: string, symbol: string) => JSON.stringify({ id, type: "alert.add", params: { symbol, level: 80.5 } });
  const log = () => {};

  it("applies, logs, then deletes each message, across batches", async () => {
    const queue = fakeQueue([addBody("op-pull-001", "AAA"), "not json", addBody("op-pull-002", "NOPE"), addBody("op-pull-001", "AAA")]);
    const summary = await pullOps(queue, { alertsFile, opLogFile, market: fakeMarket({ AAA: 75 }) }, { max: 10, waitSeconds: 20, log });
    expect(summary).toEqual({ applied: 1, rejected: 1, duplicates: 1, malformed: 1, error: null });
    expect(queue.removed).toEqual(["r0", "r1", "r2", "r3"]);
    expect(queue.waits[0]).toBe(20);
    expect(queue.waits.slice(1).every((w) => w === 0)).toBe(true);
    expect(loadAlerts(alertsFile)).toHaveLength(1);
  });

  it("stops at the first exception and leaves that message and the rest queued", async () => {
    const queue = fakeQueue([addBody("op-pull-003", "AAA"), addBody("op-pull-004", "BBB")]);
    const market = fakeMarket({});
    market.getQuotes = async () => {
      throw new Error("token expired");
    };
    const summary = await pullOps(queue, { alertsFile, opLogFile, market }, { max: 10, waitSeconds: 0, log });
    expect(summary.error).toBe("op-pull-003: token expired");
    expect(queue.removed).toEqual([]);
    expect(existsSync(opLogFile) ? readFileSync(opLogFile, "utf-8") : "").toBe("");
  });

  it("respects --max", async () => {
    const queue = fakeQueue([addBody("op-pull-005", "AAA"), addBody("op-pull-006", "AAA"), addBody("op-pull-007", "AAA")]);
    await pullOps(queue, { alertsFile, opLogFile, market: fakeMarket({ AAA: 75 }) }, { max: 1, waitSeconds: 0, log });
    expect(queue.removed).toEqual(["r0"]);
  });
});
