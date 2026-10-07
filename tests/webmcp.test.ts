import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { OP_TYPES } from "../src/ops/apply.js";
import {
  addFieldsFromJson,
  editFieldsFromJson,
  parseLotEdit,
  parseLotInput,
  parseSaleParams,
  parseStopEdit,
  parseStopInput,
  type Parsed,
} from "../src/ops/validate.js";

/**
 * web/webmcp.js is a browser script that exports through one global, so it is
 * evaluated here the way tests/volume.test.ts evaluates the block out of app.js.
 * Its tool schemas are written by hand, and the worker rejects an unknown field
 * outright ("a field the worker silently dropped would apply a different change
 * than the one asked for"), so a schema that names a field the validators don't
 * know would fail only after an agent had tried it. These tests are what ties
 * the two together.
 */

interface Tool {
  name: string;
  group: "read" | "write" | "holdings";
  description: string;
  ops?: string[];
  inputSchema: { type: string; properties: Record<string, { type?: unknown; enum?: string[] }>; required: string[]; additionalProperties: boolean };
  run(api: unknown, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ content: { text: string }[]; isError?: boolean }> | { content: { text: string }[]; isError?: boolean };
}
interface Exported {
  start(api: Api): { sync(): void; registered(): string[] };
  checkArgs(schema: Tool["inputSchema"], args: unknown): { args?: Record<string, unknown>; error?: string };
  supported(): boolean;
  TOOLS: Tool[];
}
interface Api {
  canEdit(): boolean;
  canEditHoldings(): boolean;
  holdingsShared(): boolean;
  [k: string]: unknown;
}

function load(): Exported {
  // Indirect eval: runs in global scope, where the script's `window`-or-`globalThis` root resolves.
  (0, eval)(readFileSync(new URL("../web/webmcp.js", import.meta.url), "utf-8"));
  return (globalThis as unknown as { equityWatchWebMcp: Exported }).equityWatchWebMcp;
}

const webmcp = load();
const tool = (name: string) => webmcp.TOOLS.find((t) => t.name === name)!;
const text = (r: { content: { text: string }[] }) => r.content[0].text;

const SAMPLE: Record<string, unknown> = {
  symbol: "GMED",
  level: 80,
  count: 10,
  basisPerShare: 5,
  purchaseDate: "2026-09-01",
  account: "IRA",
  stopPrice: 4,
  stopCount: 5,
  direction: "up",
  trailPercent: 3,
  trailAmount: 2,
  ma: "sma200@1D",
  touch: true,
  from: "below",
  volumeAtLeast: 1000,
  volumeRatio: 2,
  volumePeriod: "5d",
  clearLevel: true,
  clearVolume: true,
};

/** Fails the test if the validator names the field unknown; any other complaint about a lone field is fine. */
function acceptsKey(parse: (p: unknown) => Parsed<unknown>, key: string) {
  const result = parse({ [key]: SAMPLE[key] });
  const message = result.ok ? "" : result.error;
  expect(message, `${key}`).not.toMatch(/Unknown field/);
}

describe("tool schemas match the worker's validators", () => {
  const props = (name: string, drop: string[] = []) => Object.keys(tool(name).inputSchema.properties).filter((k) => !drop.includes(k));

  it("add_alert", () => props("add_alert").forEach((k) => acceptsKey(addFieldsFromJson, k)));
  it("edit_alert", () => props("edit_alert", ["alertId"]).forEach((k) => acceptsKey(editFieldsFromJson, k)));
  it("add_lot", () => props("add_lot").forEach((k) => acceptsKey(parseLotInput, k)));
  it("edit_lot", () => props("edit_lot", ["lotId"]).forEach((k) => acceptsKey(parseLotEdit, k)));
  it("add_stop", () => props("add_stop").forEach((k) => acceptsKey(parseStopInput, k)));
  it("sell_shares", () => props("sell_shares", ["symbol", "lotId"]).forEach((k) => acceptsKey((p) => parseSaleParams(p, "position"), k)));
  it("edit_stop", () => props("edit_stop", ["stopId"]).forEach((k) => acceptsKey(parseStopEdit, k)));

  it("every required property exists, and objects refuse extras", () => {
    for (const t of webmcp.TOOLS) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties, t.name).toBe(false);
      for (const key of t.inputSchema.required) expect(Object.keys(t.inputSchema.properties), `${t.name}.${key}`).toContain(key);
    }
  });

  it("the enums the add path accepts are the ones add_alert offers", () => {
    // The add path takes a touch's approach as above|below only, while an edit also takes "either".
    expect(tool("add_alert").inputSchema.properties.from.enum).toEqual(["above", "below"]);
    expect(addFieldsFromJson({ ma: "sma200@1D", touch: true, from: "above" }).ok).toBe(true);
    expect(tool("edit_alert").inputSchema.properties.from.enum).toContain("either");
  });
});

describe("tools cover the ops vocabulary", () => {
  it("names only real op types, and every op type has a tool", () => {
    const named = webmcp.TOOLS.flatMap((t) => t.ops ?? []);
    for (const op of named) expect(OP_TYPES as readonly string[], op).toContain(op);
    // A new op type the page can send should be offered to agents too, or consciously left out here.
    expect([...new Set(named)].sort()).toEqual([...OP_TYPES].sort());
  });

  it("names are unique, public reads queue nothing, and alert writes always name an op", () => {
    const names = webmcp.TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of webmcp.TOOLS.filter((x) => x.group === "read")) expect(t.ops, t.name).toBeUndefined();
    for (const t of webmcp.TOOLS.filter((x) => x.group === "write")) expect(t.ops?.length, t.name).toBeGreaterThan(0);
  });

  it("every holdings-group tool is a holdings op or a vault read", () => {
    for (const t of webmcp.TOOLS.filter((x) => x.group === "holdings")) {
      for (const op of t.ops ?? []) expect(/^(lot|stop|position|holdings)\./.test(op), t.name).toBe(true);
    }
    for (const t of webmcp.TOOLS.filter((x) => x.group === "write")) {
      for (const op of t.ops ?? []) expect(/^(alert|revisit)\./.test(op), t.name).toBe(true);
    }
  });
});

describe("registration follows the page's state", () => {
  afterEach(() => vi.unstubAllGlobals());

  function fakeHost(withUnregister = false) {
    const registered = new Map<string, { descriptor: any; signal: AbortSignal }>();
    const unregistered: string[] = [];
    const host: Record<string, unknown> = {
      registerTool(descriptor: { name: string }, options?: { signal: AbortSignal }) {
        if (registered.has(descriptor.name)) throw new Error("InvalidStateError");
        registered.set(descriptor.name, { descriptor, signal: options!.signal });
      },
    };
    if (withUnregister) {
      host.unregisterTool = (name: string) => {
        unregistered.push(name);
        registered.delete(name);
      };
    }
    // The current spec unregisters by aborting the signal.
    const live = () => [...registered.entries()].filter(([, v]) => !v.signal.aborted).map(([k]) => k).sort();
    return { host, registered, unregistered, live };
  }

  const state = { edit: false, vault: false, shared: false };
  const api = (): Api => ({
    canEdit: () => state.edit,
    canEditHoldings: () => state.edit && state.vault,
    holdingsShared: () => state.shared,
    dashboard: () => null,
    pending: () => [],
    scheduleText: () => null,
    loginExpiredSince: () => null,
  });
  const names = (group: string) => webmcp.TOOLS.filter((t) => t.group === group).map((t) => t.name).sort();

  it("offers reads when locked, writes when unlocked, holdings only when opened AND shared", () => {
    Object.assign(state, { edit: false, vault: false, shared: false });
    const { host, live } = fakeHost();
    vi.stubGlobal("document", { modelContext: host });
    const running = webmcp.start(api());
    expect(live()).toEqual(names("read"));

    state.edit = true;
    running.sync();
    expect(live()).toEqual([...names("read"), ...names("write")].sort());

    state.vault = true; // vault open, but the person hasn't said agents may see it
    running.sync();
    expect(live()).toEqual([...names("read"), ...names("write")].sort());

    state.shared = true;
    running.sync();
    expect(live()).toEqual(webmcp.TOOLS.map((t) => t.name).sort());

    state.shared = false; // switching it off withdraws them at once
    running.sync();
    expect(live()).toEqual([...names("read"), ...names("write")].sort());

    state.edit = false; // locking withdraws everything that needed the token
    running.sync();
    expect(live()).toEqual(names("read"));
  });

  it("falls back to navigator.modelContext and to unregisterTool", () => {
    Object.assign(state, { edit: true, vault: false, shared: false });
    const { host, unregistered, registered } = fakeHost(true);
    vi.stubGlobal("document", {});
    vi.stubGlobal("navigator", { modelContext: host });
    expect(webmcp.supported()).toBe(true);
    const running = webmcp.start(api());
    expect(registered.size).toBe(names("read").length + names("write").length);
    state.edit = false;
    running.sync();
    expect(unregistered.sort()).toEqual(names("write"));
  });

  it("does nothing, quietly, in a browser without WebMCP", () => {
    vi.stubGlobal("document", {});
    vi.stubGlobal("navigator", {});
    expect(webmcp.supported()).toBe(false);
    expect(webmcp.start(api()).registered()).toEqual([]);
  });

  it("is idempotent: syncing again registers nothing twice", () => {
    Object.assign(state, { edit: true, vault: false, shared: false });
    const { host } = fakeHost();
    const spy = vi.spyOn(host as { registerTool: () => void }, "registerTool");
    vi.stubGlobal("document", { modelContext: host });
    const running = webmcp.start(api());
    const first = spy.mock.calls.length;
    running.sync();
    running.sync();
    expect(spy.mock.calls.length).toBe(first);
  });

  it("a registered tool refuses to run once its permission is withdrawn", async () => {
    Object.assign(state, { edit: true, vault: true, shared: true });
    const { host, registered } = fakeHost();
    vi.stubGlobal("document", { modelContext: host });
    webmcp.start(api());
    const execute = registered.get("remove_lot")!.descriptor.execute as (a: unknown, o?: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
    state.shared = false; // the sync hasn't run yet; the tool must not trust that it has
    const result = await execute({ lotId: "x" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/aren't shared/);
  });
});

describe("tools check their input before asking anyone", () => {
  // Every case here returns before the confirm dialog, which needs a DOM.
  const api = {
    canEdit: () => true,
    dashboard: () => ({ revisitQueue: [] }),
    pending: () => [],
    alerts: async () => ({ alerts: [{ id: "a1", symbol: "GMED", condition: "price crosses above 80", kind: "static" }] }),
    parseVolume: (v: unknown) => (typeof v === "number" ? v : v === "2.5M" ? 2_500_000 : null),
    scheduleText: () => null,
  };

  it("asks for a shape, and refuses an empty edit", async () => {
    expect(text(await tool("add_alert").run(api, { symbol: "GMED" }))).toMatch(/Give a level/);
    expect(text(await tool("edit_alert").run(api, { alertId: "a1" }))).toMatch(/Nothing to change/);
  });

  it("names a volume it can't read, and says what to use for a ratio", async () => {
    const r = await tool("add_alert").run(api, { symbol: "GMED", volumeAtLeast: "lots" });
    expect(text(r)).toMatch(/share count.*volumeRatio/s);
  });

  it("won't edit or remove an alert that isn't in the book", async () => {
    expect(text(await tool("edit_alert").run(api, { alertId: "gone", level: 5 }))).toMatch(/No live alert/);
    expect(text(await tool("remove_alert").run(api, { alertId: "gone" }))).toMatch(/No live alert/);
  });

  it("won't act on a queue entry that isn't open, or apply one with no suggestion", async () => {
    expect(text(await tool("dismiss_revisit").run(api, { revisitId: "nope" }))).toMatch(/No open queue entry/);
    const withRow = { ...api, dashboard: () => ({ revisitQueue: [{ id: "r1", symbol: "GMED", alertId: "a1", suggestedLevel: null, alertCondition: "x" }] }) };
    expect(text(await tool("apply_revisit").run(withRow, { revisitId: "r1" }))).toMatch(/no suggested level/);
  });
});

describe("checkArgs: the browser doesn't enforce inputSchema, so the tools do", () => {
  const schema = (name: string) => tool(name).inputSchema;
  const check = (name: string, args: unknown) => webmcp.checkArgs(schema(name), args);

  it("refuses unknown fields instead of dropping them", () => {
    expect(check("add_alert", { symbol: "GMED", level: 80, stopLoss: 5 }).error).toMatch(/^Unknown field: stopLoss\. Accepted: symbol, /);
    expect(check("get_overview", { verbose: true }).error).toBe("Unknown field: verbose. This tool takes no arguments.");
  });

  it("names a missing required field rather than failing a lookup on it", () => {
    expect(check("remove_alert", {}).error).toBe("AlertId is required.");
    expect(check("add_lot", { symbol: "AA" }).error).toBe("Count, basisPerShare are required.");
  });

  it("checks types, enums and ranges, and says what it got", () => {
    expect(check("list_alerts", { limit: "abc" }).error).toBe('Limit must be an integer, not "abc".');
    expect(check("list_alerts", { limit: 2.5 }).error).toMatch(/must be an integer/);
    expect(check("list_alerts", { limit: 500 }).error).toBe("Limit must be between 1 and 200.");
    expect(check("add_alert", { symbol: "AA", level: 5, direction: "sideways" }).error).toBe('Direction must be one of up, down, either, not "sideways".');
    expect(check("add_alert", { symbol: 7, level: 5 }).error).toBe("Symbol must be a string, not 7.");
  });

  it("takes a number sent as a numeric string, which models often do", () => {
    expect(check("add_alert", { symbol: "AA", level: "80.5" }).args).toEqual({ symbol: "AA", level: 80.5 });
    expect(check("list_alerts", { limit: "20" }).args).toEqual({ limit: 20 });
    // Where a string is allowed, it stays one: "2.5M" is parsed later, by the page's own volume parser.
    expect(check("add_alert", { symbol: "AA", volumeAtLeast: "2500000" }).args).toEqual({ symbol: "AA", volumeAtLeast: "2500000" });
  });

  it("treats null as absent, and a missing args object as empty", () => {
    expect(check("list_alerts", { symbol: null }).args).toEqual({});
    expect(check("get_overview", undefined).args).toEqual({});
    expect(check("get_overview", "{}").error).toMatch(/JSON object/);
  });

  it("accepts every property of every tool with a value of its declared type", () => {
    const sample = (spec: { type?: unknown; enum?: string[] }) =>
      spec.enum ? spec.enum[0] : ([] as unknown[]).concat(spec.type)[0] === "string" ? "x" : ([] as unknown[]).concat(spec.type)[0] === "boolean" ? true : 1;
    for (const t of webmcp.TOOLS) {
      const args = Object.fromEntries(Object.entries(t.inputSchema.properties).map(([k, spec]) => [k, sample(spec)]));
      expect(webmcp.checkArgs(t.inputSchema, args).error, t.name).toBeUndefined();
    }
  });
});

describe("settlePending: one watermark rule for the page and the MCP server", () => {
  type Settle = (
    pending: Array<{ id: string; queuedAt: string }>,
    results: Array<{ id: string; ok: boolean; message: string }> | null,
    through: string | null
  ) => { done: Array<{ pending: { id: string }; result: { id: string } }>; processed: Array<{ id: string }>; waiting: Array<{ id: string }> };
  const settle = (webmcp as unknown as { settlePending: Settle }).settlePending;
  const pending = [
    { id: "a", queuedAt: "2026-09-30T10:00:00Z" },
    { id: "b", queuedAt: "2026-09-30T10:05:00Z" },
    { id: "c", queuedAt: "2026-09-30T10:20:00Z" },
  ];

  it("a published result settles its change, whenever it was queued", () => {
    const r = settle(pending, [{ id: "c", ok: false, message: "rejected" }], null);
    expect(r.done.map((d) => [d.pending.id, d.result.id])).toEqual([["c", "c"]]);
    expect(r.waiting.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("anything queued before the drain watermark was applied, even with its result aged out", () => {
    const r = settle(pending, [], "2026-09-30T10:10:00Z");
    expect(r.processed.map((p) => p.id)).toEqual(["a", "b"]);
    expect(r.waiting.map((p) => p.id)).toEqual(["c"]);
  });

  it("with neither, everything is still waiting", () => {
    expect(settle(pending, null, null).waiting).toHaveLength(3);
  });
});
