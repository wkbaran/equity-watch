import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MarketData } from "../src/alerts/engine.js";
import type { StaticAlert } from "../src/alerts/models.js";
import type { RelevelPatch } from "../src/alerts/relevel.js";
import { newRevisitEntry, scoreRevisit, type RevisitEntry } from "../src/alerts/revisit.js";
import { applyRevisitLevel, loadRevisits, saveRevisits } from "../src/alerts/revisitStore.js";
import { loadAlerts, saveAlerts } from "../src/alerts/store.js";
import { applyOp, loadOpLog, parseOp, recentOpResults, type Op, type OpResult } from "../src/ops/apply.js";
import { pullOps, type OpsQueue, type QueueMessage } from "../src/ops/pull.js";
import { addFieldsFromJson, editFieldsFromJson, parseAddInput, parseAlertEdit } from "../src/ops/validate.js";
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

  it("turns clearLevel into a null level, from the CLI or the page's JSON", () => {
    expect(parseAlertEdit({ clearLevel: true, volumeRatio: 2 })).toEqual({ ok: true, value: { level: null, volume: { ratio: 2, mode: "today" } } });
    const json = editFieldsFromJson({ clearLevel: true });
    expect(json.ok && parseAlertEdit(json.value)).toEqual({ ok: true, value: { level: null } });
  });

  it("returns an empty edit rather than rejecting it", () => {
    expect(parseAlertEdit({})).toEqual({ ok: true, value: {} });
  });

  it.each([
    [{ level: -1 }, 'Invalid --level "-1"'],
    [{ trailPercent: 1, trailAmount: 1 }, "not both"],
    [{ clearVolume: true, volumeRatio: 2 }, "--clear-volume can't be combined"],
    [{ clearLevel: true, level: 5 }, "--clear-level can't be combined with --level"],
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
    [{ id: "0b8c9f1e-1111", type: "alert.delete", params: {} }, 'Unknown op type "alert.delete"'],
  ])("rejects %j", (body, message) => {
    const r = parseOp(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });
});

describe("applyOp", () => {
  let dir: string;
  let alertsFile: string;
  let revisitsFile: string;
  let opLogFile: string;
  const NOW = () => new Date("2026-09-15T15:00:00.000Z");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ops-"));
    alertsFile = join(dir, "alerts.json");
    revisitsFile = join(dir, "revisits.json");
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
  /** An edit as the trigger details panel sends it: the alert, plus the queue entry it fired into. */
  const editFromRevisit = (revisitId: string, params: Record<string, unknown>, id = "op-edit-0002"): Op => {
    const r = parseOp({
      id,
      type: "alert.edit",
      target: { alertId: "s1abcdef", revisitId },
      expect: { condition: "price crosses above 100" },
      params,
    });
    if (!r.ok) throw new Error(r.error);
    return r.op;
  };
  const seedRevisit = (overrides: Partial<RevisitEntry> = {}): RevisitEntry => {
    const entry = { ...newRevisitEntry(makeStatic(), 101, "2026-09-14T15:00:00.000Z", "regular"), id: "rv000001", ...overrides };
    saveRevisits(revisitsFile, [entry]);
    return entry;
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

  it("replaces a nearer alert on the same side, as a typed add does", async () => {
    const market = fakeMarket({ GMED: 75 });
    const near = await applyOp(add({ symbol: "GMED", level: 78 }), { alertsFile, opLogFile, market, now: NOW });
    const far = await applyOp(add({ symbol: "GMED", level: 90 }, "op-add-0002"), { alertsFile, opLogFile, market, now: NOW });
    expect(far.result.ok).toBe(true);
    expect(far.result.message).toContain(`Replaced alert ${near.result.alertId}`);
    const live = loadAlerts(alertsFile).filter((a) => a.status === "live");
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(far.result.alertId);
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

  // Editing the alert from a trigger's details panel is the decision its queue
  // entry was waiting on, so the same op closes the entry.
  it("closes the revisit entry an edit names, recording what the level moved", async () => {
    saveAlerts(alertsFile, [makeStatic()]);
    seedRevisit();
    const ctx = { alertsFile, revisitsFile, opLogFile, market: fakeMarket({ TEST: 105 }) };
    const { result } = await applyOp(editFromRevisit("rv000001", { level: 110 }), ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Revisit rv000001 marked applied.");
    expect((loadAlerts(alertsFile)[0] as StaticAlert).level).toBe(110);
    expect(loadRevisits(revisitsFile)[0]).toMatchObject({ status: "applied", appliedFrom: 100, appliedTo: 110 });
    expect(loadRevisits(revisitsFile)[0].resolvedAt).not.toBeNull();
  });

  it("leaves appliedFrom/appliedTo null when the edit didn't move the level", async () => {
    saveAlerts(alertsFile, [makeStatic()]);
    seedRevisit();
    const ctx = { alertsFile, revisitsFile, opLogFile, market: fakeMarket({ TEST: 105 }) };
    const { result } = await applyOp(editFromRevisit("rv000001", { direction: "either" }), ctx);
    expect(result.ok).toBe(true);
    expect(loadRevisits(revisitsFile)[0]).toMatchObject({ status: "applied", appliedFrom: null, appliedTo: null });
  });

  // Submitting a change IS the decision, so an edit is never refused because
  // the fire behind the panel was already dealt with. An older page can still
  // send target.revisitId; it is ignored, never validated. Staleness is still
  // caught, by expect.condition, which is about the alert not the queue.
  it.each([
    ["names an entry that is gone", "rv-gone1", (): void => void seedRevisit()],
    ["names another alert's entry", "rv000001", (): void => void seedRevisit({ alertId: "other123" })],
    ["names an already-closed entry", "rv000001", (): void => void seedRevisit({ status: "dismissed" })],
  ])("applies an edit that %s", async (_label, revisitId, seed) => {
    saveAlerts(alertsFile, [makeStatic()]);
    seed();
    const ctx = { alertsFile, revisitsFile, opLogFile, market: fakeMarket({ TEST: 105 }) };
    const { result } = await applyOp(editFromRevisit(revisitId, { level: 110 }), ctx);
    expect(result.ok).toBe(true);
    expect((loadAlerts(alertsFile)[0] as StaticAlert).level).toBe(110);
  });

  // The case that prompted dropping the guard: edit twice before the next
  // check drains, from a panel whose entry the first edit already closed.
  it("applies a second edit after the first closed the entry behind the panel", async () => {
    saveAlerts(alertsFile, [makeStatic()]);
    seedRevisit();
    const ctx = { alertsFile, revisitsFile, opLogFile, market: fakeMarket({ TEST: 105 }) };
    const first = await applyOp(editFromRevisit("rv000001", { level: 110 }), ctx);
    expect(first.result.ok).toBe(true);
    expect(loadRevisits(revisitsFile)[0].status).toBe("applied");

    // Still naming the now-closed entry, with the condition as the panel shows
    // it after the first edit landed.
    const again = parseOp({
      id: "op-edit-0003",
      type: "alert.edit",
      target: { alertId: "s1abcdef", revisitId: "rv000001" },
      expect: { condition: "price crosses above 110" },
      params: { level: 115 },
    });
    if (!again.ok) throw new Error(again.error);
    const second = await applyOp(again.op, ctx);
    expect(second.result.ok).toBe(true);
    expect((loadAlerts(alertsFile)[0] as StaticAlert).level).toBe(115);
  });

  const remove = (alertId: string, condition: string | undefined, id = "op-remv-0001"): Op => {
    const r = parseOp({ id, type: "alert.remove", target: { alertId }, expect: condition === undefined ? undefined : { condition }, params: {} });
    if (!r.ok) throw new Error(r.error);
    return r.op;
  };

  it("removes an alert that still reads as the page showed it", async () => {
    saveAlerts(alertsFile, [makeStatic(), makeStatic({ id: "keep1234" })]);
    const { result } = await applyOp(remove("s1abcdef", "price crosses above 100"), { alertsFile, opLogFile, market: fakeMarket({}) });
    expect(result).toMatchObject({ ok: true, type: "alert.remove", symbol: "TEST", alertId: "s1abcdef" });
    expect(result.message).toBe("Removed static alert s1abcdef (TEST: price crosses above 100).");
    expect(loadAlerts(alertsFile).map((a) => a.id)).toEqual(["keep1234"]);
  });

  it.each([
    ["s1abcdef", undefined, "needs expect.condition"],
    ["gone0000", "price crosses above 100", "No alert with id gone0000"],
    ["s1abcdef", "price crosses above 95", 'the alert changed since the page loaded. It is now "price crosses above 100"'],
    // By id only: a ticker must never resolve to some alert on that symbol.
    ["TEST", "price crosses above 100", "No alert with id TEST"],
  ])("refuses to remove %s expecting %s", async (alertId, condition, message) => {
    saveAlerts(alertsFile, [makeStatic()]);
    const { result } = await applyOp(remove(alertId, condition), { alertsFile, opLogFile, market: fakeMarket({}) });
    expect(result.ok).toBe(false);
    expect(result.message).toContain(message);
    expect(loadAlerts(alertsFile)).toHaveLength(1);
  });

  const dismiss = (target: Record<string, unknown>, id = "op-dism-0001"): Op => {
    const r = parseOp({ id, type: "revisit.dismiss", target, params: {} });
    if (!r.ok) throw new Error(r.error);
    return r.op;
  };

  // The queue row's Dismiss: closes that one entry, and the alert stays as it was.
  it("dismisses a revisit entry without touching its alert", async () => {
    saveAlerts(alertsFile, [makeStatic()]);
    seedRevisit();
    const alertsBefore = loadAlerts(alertsFile);
    const ctx = { alertsFile, revisitsFile, opLogFile, market: fakeMarket({}) };
    const { result } = await applyOp(dismiss({ revisitId: "rv000001", alertId: "s1abcdef" }), ctx);
    expect(result).toMatchObject({ ok: true, type: "revisit.dismiss", symbol: "TEST", alertId: "s1abcdef" });
    expect(result.message).toBe("Dismissed revisit rv000001 (TEST) from the queue. Alert s1abcdef is unchanged and still watching.");
    expect(loadRevisits(revisitsFile)[0]).toMatchObject({ status: "dismissed", appliedFrom: null, appliedTo: null });
    expect(loadRevisits(revisitsFile)[0].resolvedAt).not.toBeNull();
    expect(loadAlerts(alertsFile)).toEqual(alertsBefore);
  });

  it.each([
    [{ alertId: "s1abcdef" }, (): void => void seedRevisit(), "needs target.revisitId"],
    [{ revisitId: "rv-gone1" }, (): void => void seedRevisit(), "No revisit entry with id rv-gone1"],
    [{ revisitId: "rv000001", alertId: "s1abcdef" }, (): void => void seedRevisit({ alertId: "other123" }), "belongs to alert other123"],
    [{ revisitId: "rv000001" }, (): void => void seedRevisit({ status: "applied" }), "is already applied"],
  ])("rejects dismissing %j", async (target, seed, message) => {
    seed();
    const before = loadRevisits(revisitsFile);
    const { result } = await applyOp(dismiss(target), { alertsFile, revisitsFile, opLogFile, market: fakeMarket({}) });
    expect(result.ok).toBe(false);
    expect(result.message).toContain(message);
    expect(loadRevisits(revisitsFile)).toEqual(before);
  });

  // The shared function under both `alert revisit apply` and revisit.apply.
  // The CLI prints these reasons and exits 1; the op logs them as rejections.
  describe("applyRevisitLevel", () => {
    it("refuses an entry that is already closed", () => {
      saveAlerts(alertsFile, [makeStatic()]);
      seedRevisit({ status: "applied", suggestedLevel: 118 });
      const r = applyRevisitLevel(alertsFile, revisitsFile, "rv000001");
      expect(r).toEqual({ ok: false, reason: "Revisit rv000001 is already applied." });
      expect(loadAlerts(alertsFile)[0]).toMatchObject({ level: 100 });
    });

    it("refuses a follow-up crossing and names the fire to use instead", () => {
      saveAlerts(alertsFile, [makeStatic()]);
      seedRevisit({ followUpOf: "rv000000", suggestedLevel: 118 });
      const r = applyRevisitLevel(alertsFile, revisitsFile, "rv000001");
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toContain("is a later crossing of revisit rv000000; apply that one instead");
    });

    it("names the command that would produce a suggestion when there is none", () => {
      saveAlerts(alertsFile, [makeStatic()]);
      seedRevisit();
      const r = applyRevisitLevel(alertsFile, revisitsFile, "rv000001");
      expect(!r.ok && r.reason).toContain("run 'alert revisit relevel' first");
    });

    it("refuses anything but a static alert, which is the only kind with a level to move", () => {
      saveAlerts(alertsFile, []);
      seedRevisit({ suggestedLevel: 118 });
      const r = applyRevisitLevel(alertsFile, revisitsFile, "rv000001");
      expect(!r.ok && r.reason).toContain("an alert that no longer exists");
    });

    it("re-seeds the baseline above the new level when the trigger was above it", () => {
      saveAlerts(alertsFile, [makeStatic()]);
      seedRevisit({ suggestedLevel: 95 });
      const r = applyRevisitLevel(alertsFile, revisitsFile, "rv000001");
      expect(r.ok).toBe(true);
      // Trigger was 101, the new level is 95, so price sits above it.
      expect(loadAlerts(alertsFile)[0]).toMatchObject({ level: 95, lastKnownSide: "above" });
    });
  });

  // ---- revisit.relevel ------------------------------------------------------

  const relevelOp = (target: Record<string, unknown>, id = "op-relv-0001"): Op => {
    const r = parseOp({ id, type: "revisit.relevel", target, params: {} });
    if (!r.ok) throw new Error(r.error);
    return r.op;
  };
  /** Stands in for the bars fetch + relevelEntry the CLI supplies. */
  const fakeRelevel = (patch: Partial<RelevelPatch> = {}) => {
    const calls: string[] = [];
    const fn = (entry: RevisitEntry): Promise<RelevelPatch> => {
      calls.push(entry.id);
      return Promise.resolve({
        suggestedLevel: 118,
        suggestionBasis: "60d high",
        suggestedAt: "2026-09-15T15:00:00.000Z",
        priority: 62.5,
        signals: scoreRevisit({ verdict: "CONFIRMED_BREAKOUT", pctMovePastLevel: 6, daysOpen: 1, heldPosition: false }).signals,
        ...patch,
      });
    };
    return Object.assign(fn, { calls });
  };

  it("re-levels one open entry and writes only the five fields a relevel owns", async () => {
    saveAlerts(alertsFile, [makeStatic()]);
    const before = seedRevisit();
    const relevel = fakeRelevel();
    const ctx = { alertsFile, revisitsFile, opLogFile, market: fakeMarket({}), relevel, now: NOW };
    const { result } = await applyOp(relevelOp({ revisitId: "rv000001" }), ctx);

    expect(result).toMatchObject({ ok: true, type: "revisit.relevel", symbol: "TEST", alertId: "s1abcdef" });
    expect(result.message).toBe("Re-levelled revisit rv000001 (TEST): suggest 118 (60d high). Priority 62.5.");
    expect(relevel.calls).toEqual(["rv000001"]);
    const after = loadRevisits(revisitsFile)[0];
    expect(after).toMatchObject({ suggestedLevel: 118, suggestionBasis: "60d high", priority: 62.5, status: "open" });
    // Proposing only: nothing that decides anything moved.
    expect(after.levelAtTrigger).toBe(before.levelAtTrigger);
    expect(after.appliedFrom).toBeNull();
    expect(loadAlerts(alertsFile)[0]).toMatchObject({ level: 100 });
  });

  it("reports a null suggestion with the reason rather than failing", async () => {
    seedRevisit();
    const relevel = fakeRelevel({ suggestedLevel: null, suggestionBasis: "moving-average alert: its level moves with the average" });
    const ctx = { alertsFile, revisitsFile, opLogFile, market: fakeMarket({}), relevel };
    const { result } = await applyOp(relevelOp({ revisitId: "rv000001" }), ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("no new level (moving-average alert: its level moves with the average)");
  });

  // The difference from ensureProfile: an absent callback is an answer of
  // "no", not a silent success. Someone asked for a suggestion.
  it("rejects a re-level when no market data is configured", async () => {
    seedRevisit();
    const { result } = await applyOp(relevelOp({ revisitId: "rv000001" }), {
      alertsFile,
      revisitsFile,
      opLogFile,
      market: fakeMarket({}),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Re-levelling needs daily bars, and no market data is configured.");
    expect(loadRevisits(revisitsFile)[0].suggestedLevel).toBeNull();
  });

  it.each([
    [{}, (): void => void seedRevisit(), "needs target.revisitId"],
    [{ revisitId: "rv-gone1" }, (): void => void seedRevisit(), "No revisit entry with id rv-gone1"],
    [{ revisitId: "rv000001" }, (): void => void seedRevisit({ status: "applied" }), "is already applied"],
    [{ revisitId: "rv000001" }, (): void => void seedRevisit({ followUpOf: "rv000000" }), "re-level that one instead"],
  ])("rejects re-levelling %j", async (target, seed, message) => {
    seed();
    const before = loadRevisits(revisitsFile);
    const relevel = fakeRelevel();
    const { result } = await applyOp(relevelOp(target), { alertsFile, revisitsFile, opLogFile, market: fakeMarket({}), relevel });
    expect(result.ok).toBe(false);
    expect(result.message).toContain(message);
    expect(relevel.calls).toEqual([]);
    expect(loadRevisits(revisitsFile)).toEqual(before);
  });

  // ---- revisit.apply --------------------------------------------------------

  const applyOpFor = (
    target: Record<string, unknown>,
    expectField: Record<string, unknown>,
    params: Record<string, unknown> = {},
    id = "op-aply-0001"
  ): Op => {
    const r = parseOp({ id, type: "revisit.apply", target, expect: expectField, params });
    if (!r.ok) throw new Error(r.error);
    return r.op;
  };
  const SUGGESTED = { suggestedLevel: 118, condition: "price crosses above 100" };

  it("applies the suggested level, re-seeds the crossing baseline, and closes the entry", async () => {
    saveAlerts(alertsFile, [makeStatic({ mutedUntil: "2026-09-16T00:00:00.000Z" })]);
    seedRevisit({ suggestedLevel: 118, suggestionBasis: "60d high" });
    const ctx = { alertsFile, revisitsFile, opLogFile, market: fakeMarket({}), now: NOW };
    const { result } = await applyOp(applyOpFor({ revisitId: "rv000001", alertId: "s1abcdef" }, SUGGESTED), ctx);

    expect(result).toMatchObject({ ok: true, type: "revisit.apply", symbol: "TEST", alertId: "s1abcdef" });
    expect(result.message).toBe("TEST: alert s1abcdef re-levelled 100 → 118. Revisit rv000001 marked applied.");
    // The trigger was at 101, under the new 118, so the alert is armed below it
    // rather than instantly re-firing because the level moved.
    expect(loadAlerts(alertsFile)[0]).toMatchObject({ level: 118, lastKnownSide: "below", mutedUntil: null });
    expect(loadRevisits(revisitsFile)[0]).toMatchObject({ status: "applied", appliedFrom: 100, appliedTo: 118 });
  });

  it("applies an edited level instead of the suggestion", async () => {
    saveAlerts(alertsFile, [makeStatic()]);
    seedRevisit({ suggestedLevel: 118 });
    const ctx = { alertsFile, revisitsFile, opLogFile, market: fakeMarket({}) };
    const { result } = await applyOp(applyOpFor({ revisitId: "rv000001" }, SUGGESTED, { level: 125 }), ctx);
    expect(result.ok).toBe(true);
    expect(loadAlerts(alertsFile)[0]).toMatchObject({ level: 125 });
    expect(loadRevisits(revisitsFile)[0]).toMatchObject({ appliedFrom: 100, appliedTo: 125 });
  });

  // The guard the other alert-changing ops don't need. expect.condition alone
  // catches the alert moving but not the suggestion moving, so a relevel
  // landing between render and click would apply a number nobody saw.
  it("rejects an apply when the suggestion changed since the page loaded", async () => {
    saveAlerts(alertsFile, [makeStatic()]);
    seedRevisit({ suggestedLevel: 118 });
    const ctx = { alertsFile, revisitsFile, opLogFile, market: fakeMarket({}) };
    const op = applyOpFor({ revisitId: "rv000001" }, { suggestedLevel: 110, condition: "price crosses above 100" });
    const { result } = await applyOp(op, ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Not applied: the suggestion changed since the page loaded. It is now 118.");
    expect(loadAlerts(alertsFile)[0]).toMatchObject({ level: 100 });
    expect(loadRevisits(revisitsFile)[0]).toMatchObject({ status: "open" });
  });

  it("rejects an apply when the alert changed since the page loaded", async () => {
    saveAlerts(alertsFile, [makeStatic({ level: 105 })]);
    seedRevisit({ suggestedLevel: 118 });
    const ctx = { alertsFile, revisitsFile, opLogFile, market: fakeMarket({}) };
    const { result } = await applyOp(applyOpFor({ revisitId: "rv000001" }, SUGGESTED), ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('It is now "price crosses above 105"');
    expect(loadRevisits(revisitsFile)[0]).toMatchObject({ status: "open" });
  });

  it.each([
    [{ revisitId: "rv000001", alertId: "other123" }, {}, "belongs to alert s1abcdef"],
    [{ revisitId: "rv000001" }, { suggestedLevel: null }, "has no suggested level yet"],
  ])("rejects applying %j", async (target, overrides, message) => {
    saveAlerts(alertsFile, [makeStatic()]);
    const seeded = seedRevisit({ suggestedLevel: 118, ...overrides });
    const ctx = { alertsFile, revisitsFile, opLogFile, market: fakeMarket({}) };
    const op = applyOpFor(target, { suggestedLevel: seeded.suggestedLevel, condition: "price crosses above 100" });
    const { result } = await applyOp(op, ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(message);
    expect(loadAlerts(alertsFile)[0]).toMatchObject({ level: 100 });
  });

  // An edit made anywhere is the decision the alert's open fires were waiting
  // on, so they all close, not just one named by a trigger panel.
  it("closes every open entry for the alert, even when the edit names none", async () => {
    saveAlerts(alertsFile, [makeStatic()]);
    const base = newRevisitEntry(makeStatic(), 101, "2026-09-14T15:00:00.000Z", "regular");
    saveRevisits(revisitsFile, [
      { ...base, id: "rv000001" },
      { ...base, id: "rv000002", triggeredAt: "2026-09-15T14:00:00.000Z" },
      { ...base, id: "rv000003", status: "dismissed" },
      { ...base, id: "rv000004", alertId: "other123" },
    ]);
    const ctx = { alertsFile, revisitsFile, opLogFile, market: fakeMarket({ TEST: 105 }), now: NOW };
    const { result } = await applyOp(edit("s1abcdef", "price crosses above 100", { level: 110 }), ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Revisit rv000001, rv000002 marked applied.");
    const byId = new Map(loadRevisits(revisitsFile).map((e) => [e.id, e]));
    for (const id of ["rv000001", "rv000002"]) {
      expect(byId.get(id)).toMatchObject({ status: "applied", appliedFrom: 100, appliedTo: 110, resolvedAt: "2026-09-15T15:00:00.000Z" });
    }
    expect(byId.get("rv000003")).toMatchObject({ status: "dismissed", appliedTo: null });
    expect(byId.get("rv000004")!.status).toBe("open");
  });

  it("says nothing about the queue when the alert has no open entries", async () => {
    saveAlerts(alertsFile, [makeStatic()]);
    const { result } = await applyOp(edit("s1abcdef", "price crosses above 100", { level: 110 }), { alertsFile, revisitsFile, opLogFile, market: fakeMarket({ TEST: 105 }) });
    expect(result.ok).toBe(true);
    expect(result.message).not.toContain("Revisit");
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

  function fakeQueue(bodies: string[]): OpsQueue & { removed: string[]; waits: number[]; released: string[]; receives: number } {
    const pending: QueueMessage[] = bodies.map((body, i) => ({ body, receiptHandle: `r${i}` }));
    const queue = {
      removed: [] as string[],
      released: [] as string[],
      waits: [] as number[],
      receives: 0,
      async receive(max: number, waitSeconds: number) {
        queue.receives++;
        queue.waits.push(waitSeconds);
        return pending.filter((m) => !queue.removed.includes(m.receiptHandle)).slice(0, Math.min(max, 2));
      },
      async remove(handle: string) {
        queue.removed.push(handle);
      },
      async release(handle: string) {
        queue.released.push(handle);
      },
    };
    return queue;
  }

  const addBody = (id: string, symbol: string) => JSON.stringify({ id, type: "alert.add", params: { symbol, level: 80.5 } });
  const log = () => {};

  it("applies, logs, then deletes each message, across batches", async () => {
    const queue = fakeQueue([addBody("op-pull-001", "AAA"), "not json", addBody("op-pull-002", "NOPE"), addBody("op-pull-001", "AAA")]);
    const summary = await pullOps(queue, { alertsFile, opLogFile, market: fakeMarket({ AAA: 75 }) }, { max: 10, waitSeconds: 20, log });
    expect(summary).toMatchObject({ applied: 1, rejected: 1, duplicates: 1, malformed: 1, error: null });
    expect(summary.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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
    // Queued is not enough: everything this run received has to go back now,
    // or it stays invisible for the visibility timeout and the next manual run
    // reports an empty queue (2026-09-19).
    expect(queue.released).toEqual(["r0", "r1"]);
  });

  it("carries on when a release fails, since the timeout returns the message anyway", async () => {
    const queue = fakeQueue([addBody("op-pull-rel", "AAA")]);
    queue.release = async () => {
      throw new Error("ReceiptHandleIsInvalid");
    };
    const market = fakeMarket({});
    market.getQuotes = async () => {
      throw new Error("token expired");
    };
    const summary = await pullOps(queue, { alertsFile, opLogFile, market }, { max: 10, waitSeconds: 0, log });
    // The error that stopped the drain is the one reported, not the release's.
    expect(summary.error).toBe("op-pull-rel: token expired");
  });

  describe("preflight", () => {
    it("does not touch the queue at all when it says no", async () => {
      const queue = fakeQueue([addBody("op-pull-pf1", "AAA")]);
      const summary = await pullOps(
        queue,
        { alertsFile, opLogFile, market: fakeMarket({ AAA: 75 }) },
        { max: 10, waitSeconds: 0, log, preflight: async () => "Token refresh failed (400)." }
      );
      // The whole point: receiving is itself irreversible for the length of the
      // visibility timeout, so a known-doomed drain must not receive.
      expect(queue.receives).toBe(0);
      expect(queue.removed).toEqual([]);
      expect(queue.released).toEqual([]);
      expect(summary.blocked).toBe("Token refresh failed (400).");
      expect(summary).toMatchObject({ applied: 0, rejected: 0, duplicates: 0, malformed: 0, error: null });
      expect(existsSync(opLogFile) ? readFileSync(opLogFile, "utf-8") : "").toBe("");
    });

    it("drains normally when it says yes", async () => {
      const queue = fakeQueue([addBody("op-pull-pf2", "AAA")]);
      const summary = await pullOps(
        queue,
        { alertsFile, opLogFile, market: fakeMarket({ AAA: 75 }) },
        { max: 10, waitSeconds: 0, log, preflight: async () => null }
      );
      expect(summary).toMatchObject({ applied: 1, blocked: null, error: null });
      expect(queue.removed).toEqual(["r0"]);
    });

    it("is optional, so every other caller is unaffected", async () => {
      const queue = fakeQueue([addBody("op-pull-pf3", "AAA")]);
      const summary = await pullOps(queue, { alertsFile, opLogFile, market: fakeMarket({ AAA: 75 }) }, { max: 10, waitSeconds: 0, log });
      expect(summary).toMatchObject({ applied: 1, blocked: null });
    });
  });

  // The default is no limit: a burst bigger than one batch must not need a second run.
  it("drains a queue larger than a receive batch in one call", async () => {
    const bodies = Array.from({ length: 25 }, (_, i) => addBody(`op-burst-${String(i).padStart(3, "0")}`, "AAA"));
    const queue = fakeQueue(bodies);
    const summary = await pullOps(
      queue,
      { alertsFile, opLogFile, market: fakeMarket({ AAA: 75 }) },
      { max: Number.POSITIVE_INFINITY, waitSeconds: 0, log }
    );
    // Each add supersedes the previous alert on the same symbol and side, so all 25 apply.
    expect(summary).toMatchObject({ applied: 25, duplicates: 0, rejected: 0, error: null });
    expect(queue.removed).toHaveLength(25);
  });

  it("respects --max when one is given", async () => {
    const queue = fakeQueue([addBody("op-pull-005", "AAA"), addBody("op-pull-006", "AAA"), addBody("op-pull-007", "AAA")]);
    await pullOps(queue, { alertsFile, opLogFile, market: fakeMarket({ AAA: 75 }) }, { max: 1, waitSeconds: 0, log });
    expect(queue.removed).toEqual(["r0"]);
  });
});
