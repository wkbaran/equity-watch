import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { OPS_TOKEN } from "../playwright/fixtures.js";
import { OP_TYPES } from "../src/ops/apply.js";
import { runMcpServer, sessionServer, type McpOptions } from "../src/mcp/server.js";
import { SiteApi } from "../src/mcp/siteApi.js";
import { loadToolbox } from "../src/mcp/toolbox.js";

/**
 * The MCP server against the same fake site the browser suite uses
 * (playwright/server.ts: the fixture documents, a sealed fixture vault, and a
 * fake /api/ops that remembers what it was sent). Its own port, so a stale
 * browser-suite server can't answer.
 */

const PORT = 4181;
const SITE = `http://localhost:${PORT}`;
let site: ChildProcess;
let dir: string;

beforeAll(async () => {
  site = spawn("npx", ["tsx", "playwright/server.ts"], { env: { ...process.env, PW_PORT: String(PORT) }, stdio: "ignore" });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${SITE}/index.html`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("fixture site didn't start");
}, 30_000);

afterAll(() => {
  site?.kill();
});

beforeEach(async () => {
  await fetch(`${SITE}/__reset`);
  dir = mkdtempSync(join(tmpdir(), "ew-mcp-"));
  return () => rmSync(dir, { recursive: true, force: true });
});

const queued = async (): Promise<Array<Record<string, any>>> => (await fetch(`${SITE}/__ops`)).json() as Promise<Array<Record<string, any>>>;

function options(over: Partial<McpOptions> = {}): McpOptions {
  return {
    siteUrl: SITE,
    token: OPS_TOKEN,
    readOnly: false,
    allowHoldings: false,
    requireApproval: false,
    pendingFile: join(dir, "pending.json"),
    http: null,
    host: "127.0.0.1",
    httpToken: null,
    ...over,
  };
}

type Answer = ElicitResult | "none";

/** A client connected in-process. `answer` is what the person does when asked; "none" is a client that can't ask. */
async function connect(over: Partial<McpOptions> = {}, answer: Answer = "none", siteApi?: SiteApi) {
  const box = await loadToolbox();
  const opts = options(over);
  const api = siteApi ?? new SiteApi(box, { ...opts, log: () => {} });
  await api.refresh(true);
  const server = sessionServer(box, api, opts);
  const client = new Client({ name: "test", version: "1" }, { capabilities: answer === "none" ? {} : { elicitation: {} } });
  const asked: string[] = [];
  if (answer !== "none") {
    client.setRequestHandler(ElicitRequestSchema, (req) => {
      asked.push(String(req.params.message));
      return answer;
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const names = async () => (await client.listTools()).tools.map((t) => t.name).sort();
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
  };
  return { client, names, call, asked, api };
}

const READS = ["get_alert", "get_chart_url", "get_overview", "get_pending_changes", "list_alerts", "list_revisit_queue"];
const WRITES = ["add_alert", "apply_revisit", "dismiss_revisit", "edit_alert", "relevel_revisit", "remove_alert"];

describe("what the server offers", () => {
  it("offers reads only without a token, and says how to get more", async () => {
    const { names, client } = await connect({ token: null });
    expect(await names()).toEqual(READS);
    const overview = (await client.listTools()).tools.find((t) => t.name === "get_overview")!;
    // The access paragraph is the server's, not the page's: flags, not buttons.
    expect(overview.description).toMatch(/--allow-holdings/);
    expect(overview.description).not.toMatch(/Unlock editing/);
    expect(overview.annotations?.readOnlyHint).toBe(true);
  });

  it("adds the writes with a token, marking removals destructive", async () => {
    const { names, client } = await connect();
    expect(await names()).toEqual([...READS, ...WRITES].sort());
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === "remove_alert")?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "add_alert")?.annotations?.destructiveHint).toBe(false);
  });

  it("--read-only takes the writes away again, and says why", async () => {
    const { names, call } = await connect({ readOnly: true });
    expect(await names()).toEqual(READS);
    const r = await call("remove_alert", { alertId: "st000001" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/--read-only/);
  });

  it("holdings need --allow-holdings, and then come out of the vault", async () => {
    const without = await connect();
    expect(await without.names()).not.toContain("list_positions");
    const r = await without.call("get_position", { symbol: "AA" });
    expect(r.text).toMatch(/restart it with --allow-holdings/);

    const withHoldings = await connect({ allowHoldings: true });
    expect(await withHoldings.names()).toContain("list_positions");
    const aa = JSON.parse((await withHoldings.call("get_position", { symbol: "AA" })).text);
    expect(aa.lots.map((l: { id: string }) => l.id).sort()).toEqual(["lot00001", "lot00002"]);
  });

  it("a token that doesn't open the vault keeps holdings off, and says so", async () => {
    const { names, call } = await connect({ allowHoldings: true, token: "y".repeat(32) });
    expect(await names()).not.toContain("list_positions");
    expect((await call("list_positions")).text).toMatch(/doesn't open the holdings vault/);
  });
});

describe("reads", () => {
  it("answer from the published documents", async () => {
    const { call } = await connect({ token: null });
    const overview = JSON.parse((await call("get_overview")).text);
    expect(overview.summary.liveAlerts).toBeGreaterThan(0);
    const queue = JSON.parse((await call("list_revisit_queue")).text);
    expect(queue.find((r: { id: string }) => r.id === "rv0000a2")).toMatchObject({ symbol: "AA", suggestedLevel: 61 });
    const alerts = JSON.parse((await call("list_alerts", { symbol: "AA" })).text);
    expect(alerts.alerts[0].id).toBe("st000001");
  });

  it("log in to a site behind basic auth, and never send that login to /api/ops", async () => {
    const seen: Array<{ path: string; authorization: string | undefined }> = [];
    const logged: string[] = [];
    const fetchVia: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
      seen.push({ path: url.pathname, authorization });
      if (url.pathname !== "/api/ops" && authorization !== `Basic ${Buffer.from("me:pw").toString("base64")}`) {
        return new Response("", { status: 401 });
      }
      return fetch(`${SITE}${url.pathname}`, init);
    };
    const box = await loadToolbox();
    const refused = new SiteApi(box, { ...options(), fetch: fetchVia, log: (l) => logged.push(l) });
    await refused.refresh(true);
    expect(logged.join("\n")).toMatch(/asks for a login; set BASIC_AUTH_USER and BASIC_AUTH_PASSWORD/);

    const { call } = await connect({}, { action: "accept", content: { confirm: true } }, new SiteApi(box, { ...options(), basicAuth: "me:pw", fetch: fetchVia, log: () => {} }));
    expect(JSON.parse((await call("get_overview")).text).summary.liveAlerts).toBeGreaterThan(0);
    await call("dismiss_revisit", { revisitId: "rv0000a2" });
    expect(seen.find((s) => s.path === "/api/ops")?.authorization).toBe(`Bearer ${OPS_TOKEN}`);
  });

  it("get_chart_url links a dark chart, with the exchange the dashboard knows, one given, or none", async () => {
    const { call } = await connect({ token: null });
    expect(JSON.parse((await call("get_chart_url", { symbol: "msft" })).text)).toEqual({
      symbol: "MSFT",
      exchange: "NASDAQ",
      exchangeFrom: "dashboard",
      url: "https://www.tradingview.com/chart/?symbol=NASDAQ%3AMSFT&theme=dark",
    });
    expect(JSON.parse((await call("get_chart_url", { symbol: "AA", exchange: "nyse" })).text)).toMatchObject({
      exchangeFrom: "given",
      url: "https://www.tradingview.com/chart/?symbol=NYSE%3AAA&theme=dark",
    });
    expect(JSON.parse((await call("get_chart_url", { symbol: "AA" })).text)).toMatchObject({
      exchange: null,
      url: "https://www.tradingview.com/chart/?symbol=AA&theme=dark",
    });
    expect((await call("get_chart_url", { symbol: "not a ticker" })).text).toMatch(/doesn't look like a ticker/);
  });

  it("check arguments exactly as the page does", async () => {
    const { call } = await connect({ token: null });
    const r = await call("list_alerts", { limit: "abc" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Limit must be an integer/);
  });
});

describe("writes and approval", () => {
  const accept = (confirm: boolean): ElicitResult => ({ action: "accept", content: { confirm } });

  it("ask the person through elicitation, and queue what was approved", async () => {
    const { call, asked } = await connect({}, accept(true));
    const r = await call("add_alert", { symbol: "NVDA", level: 200 });
    expect(r.isError).toBe(false);
    expect(asked[0]).toMatch(/add NVDA alert: level 200/);
    expect(JSON.parse(r.text)).toMatchObject({ queued: true, applied: false, status: expect.stringMatching(/approved this when asked/) });
    const [op] = await queued();
    expect(op).toMatchObject({ type: "alert.add", params: { symbol: "NVDA", level: 200 } });
  });

  it("queue nothing when the person declines, or accepts with the box unticked", async () => {
    for (const answer of [{ action: "decline" } as ElicitResult, accept(false), { action: "cancel" } as ElicitResult]) {
      await fetch(`${SITE}/__reset`);
      const { call } = await connect({}, answer);
      const r = await call("remove_alert", { alertId: "st000001" });
      expect(r.isError, answer.action).toBe(true);
      expect(await queued()).toEqual([]);
    }
  });

  it("without elicitation, rely on the client's own approval and say so", async () => {
    const { call } = await connect({}, "none");
    const r = JSON.parse((await call("dismiss_revisit", { revisitId: "rv0000a2" })).text);
    expect(r.status).toMatch(/client's own approval/);
    expect((await queued())[0]).toMatchObject({ type: "revisit.dismiss", target: { revisitId: "rv0000a2" } });
  });

  it("with --require-approval, a client that can't ask gets no write tools", async () => {
    const { names, call } = await connect({ requireApproval: true }, "none");
    expect(await names()).toEqual(READS);
    expect((await call("add_alert", { symbol: "NVDA", level: 200 })).text).toMatch(/can't\b.*approve|elicitation/);
    const asking = await connect({ requireApproval: true }, accept(true));
    expect(await asking.names()).toEqual([...READS, ...WRITES].sort());
  });

  it("an edit carries the condition it read, as the page's does", async () => {
    const { call } = await connect({}, accept(true));
    await call("edit_alert", { alertId: "st000001", level: 60 });
    expect((await queued())[0]).toMatchObject({ type: "alert.edit", target: { alertId: "st000001" }, expect: { condition: "price crosses above 55" } });
  });

  it("the duplicate guard survives a restart, through the pending file", async () => {
    const first = await connect({}, accept(true));
    await first.call("add_alert", { symbol: "NVDA", level: 200 });
    // A new server process, as a stdio client starts per session: same pending file, fresh memory.
    const second = await connect({}, accept(true));
    const again = await second.call("add_alert", { symbol: "NVDA", level: 200 });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/already queued/);
    expect(second.asked).toEqual([]);
    expect(await queued()).toHaveLength(1);
  });

  it("a queued change settles when the published results say it applied", async () => {
    const { call, api } = await connect({}, accept(true));
    const { opId } = JSON.parse((await call("add_alert", { symbol: "NVDA", level: 200 })).text);
    expect(JSON.parse((await call("get_pending_changes")).text).waiting).toEqual([
      expect.objectContaining({ opId, type: "alert.add", symbol: "NVDA", alertId: null, revisitId: null }),
    ]);
    await fetch(`${SITE}/__release`);
    await api.refresh(true);
    const after = JSON.parse((await call("get_pending_changes")).text);
    expect(after.waiting).toEqual([]);
    expect(after.recentOutcomes.find((o: { opId: string }) => o.opId === opId)).toMatchObject({ ok: true });
  });

  it("a waiting edit names the alert it targets, from the pending file", async () => {
    const first = await connect({}, accept(true));
    const { opId } = JSON.parse((await first.call("edit_alert", { alertId: "st000001", level: 60 })).text);
    // A fresh server reads the target back from the file, not from memory.
    const second = await connect({}, accept(true));
    expect(JSON.parse((await second.call("get_pending_changes")).text).waiting).toEqual([
      expect.objectContaining({ opId, type: "alert.edit", symbol: "AA", alertId: "st000001", revisitId: null }),
    ]);
  });
});

describe("every write tool, through the server", () => {
  // One case per write tool: what an agent sends, and the op that must reach
  // /api/ops for it. Holdings cases run with --allow-holdings, so their guards
  // (lotExpect, the stop's price, the position's lot ids) come from the
  // fixture vault decrypted in Node rather than in the browser.
  const CASES: Array<{ tool: string; args: Record<string, unknown>; op: Record<string, unknown> }> = [
    { tool: "add_alert", args: { symbol: "NVDA", level: 200, direction: "up", volumeAtLeast: "2.5M" }, op: { type: "alert.add", params: { symbol: "NVDA", level: 200, direction: "up", volumeAtLeast: 2_500_000 } } },
    { tool: "edit_alert", args: { alertId: "st000001", level: 60 }, op: { type: "alert.edit", target: { alertId: "st000001" }, expect: { condition: "price crosses above 55" }, params: { level: 60 } } },
    { tool: "remove_alert", args: { alertId: "st000001" }, op: { type: "alert.remove", target: { alertId: "st000001" }, expect: { condition: "price crosses above 55" } } },
    { tool: "dismiss_revisit", args: { revisitId: "rv0000a2" }, op: { type: "revisit.dismiss", target: { revisitId: "rv0000a2", alertId: "st000001" } } },
    { tool: "relevel_revisit", args: { revisitId: "rv0000a2" }, op: { type: "revisit.relevel", target: { revisitId: "rv0000a2" } } },
    { tool: "apply_revisit", args: { revisitId: "rv0000a2" }, op: { type: "revisit.apply", target: { revisitId: "rv0000a2", alertId: "st000001" }, expect: { suggestedLevel: 61, condition: "price crosses above 55" } } },
    { tool: "add_lot", args: { symbol: "spy", count: 3, basisPerShare: 570, stopPrice: 540 }, op: { type: "lot.add", params: { symbol: "SPY", count: 3, basisPerShare: 570, stopPrice: 540 } } },
    { tool: "edit_lot", args: { lotId: "lot00001", count: 12, account: "" }, op: { type: "lot.edit", target: { lotId: "lot00001" }, expect: { count: 10, basisPerShare: 40, purchaseDate: "2026-09-01", account: "roth" }, params: { count: 12, account: "" } } },
    { tool: "remove_lot", args: { lotId: "lot00002" }, op: { type: "lot.remove", target: { lotId: "lot00002" }, expect: { count: 5, basisPerShare: 44, purchaseDate: "2026-09-08", account: "margin" } } },
    { tool: "remove_position", args: { symbol: "AA" }, op: { type: "position.remove", target: { symbol: "AA" }, expect: { lotIds: ["lot00001", "lot00002"] } } },
    { tool: "sell_shares", args: { symbol: "aa", count: 12, price: 50 }, op: { type: "position.remove", target: { symbol: "AA" }, expect: { lotIds: ["lot00001", "lot00002"], shares: 15 }, params: { count: 12, price: 50 } } },
    { tool: "add_stop", args: { symbol: "TSLA", stopPrice: 230 }, op: { type: "stop.add", params: { symbol: "TSLA", stopPrice: 230 } } },
    { tool: "edit_stop", args: { stopId: "stop0001", stopPrice: 36, count: 5 }, op: { type: "stop.edit", target: { stopId: "stop0001" }, expect: { stopPrice: 38 }, params: { stopPrice: 36, count: 5 } } },
    { tool: "remove_stop", args: { stopId: "stop0001" }, op: { type: "stop.remove", target: { stopId: "stop0001" }, expect: { stopPrice: 38 } } },
    { tool: "cover_position", args: { symbol: "TSLA" }, op: { type: "holdings.cover", target: { symbol: "TSLA" } } },
  ];

  it("sell_shares marks a stop-triggered sale, with the ATR given or the vault's", async () => {
    const { call } = await connect({ allowHoldings: true }, { action: "accept", content: { confirm: true } });
    const r = await call("sell_shares", { symbol: "aa", count: 12, price: 50, stopHit: true, atr: 1.5 });
    expect(r.isError, r.text).toBe(false);
    expect((await queued())[0]).toMatchObject({ type: "position.remove", params: { count: 12, price: 50, stopHit: true, atr: 1.5 } });
    const bare = await call("sell_shares", { symbol: "aa", atr: 1.5 });
    expect(bare.isError).toBe(true);
    expect(bare.text).toMatch(/only with stopHit/);
  });

  it("has a case for every write tool the server offers, and covers every op type", async () => {
    const box = await loadToolbox();
    const writes = box.TOOLS.filter((t) => t.ops !== undefined).map((t) => t.name).sort();
    expect(CASES.map((c) => c.tool).sort()).toEqual(writes);
    expect([...new Set(CASES.map((c) => c.op.type as string))].sort()).toEqual([...OP_TYPES].sort());
  });

  it.each(CASES)("$tool queues $op.type with the page's guards", async ({ tool, args, op }) => {
    const { call, names, asked } = await connect({ allowHoldings: true }, { action: "accept", content: { confirm: true } });
    expect(await names()).toContain(tool);
    const r = await call(tool, args);
    expect(r.isError, r.text).toBe(false);
    expect(asked).toHaveLength(1); // the person was asked, once
    const ops = await queued();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject(op);
    // The fake Lambda accepted it, so it is a real op type with an id, as the page sends.
    expect(ops[0].id).toBe(JSON.parse(r.text).opId);
  });
});

describe("transports", () => {
  it("stdio: the process's stdout carries nothing but the protocol", async () => {
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/cli.ts", "mcp", "--site-url", SITE, "--read-only", "--pending-file", join(dir, "p.json")],
      stderr: "pipe",
    });
    const errors: unknown[] = [];
    transport.onerror = (e) => errors.push(e);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(READS);
    const r = (await client.callTool({ name: "get_overview", arguments: {} })) as { content: Array<{ text: string }> };
    expect(JSON.parse(r.content[0].text).summary.liveAlerts).toBeGreaterThan(0);
    await client.close();
    // A stray console.log would have reached the client as an unparseable message.
    expect(errors).toEqual([]);
  }, 30_000);

  it("HTTP: sessions, elicitation over the stream, and requests from a web page refused", async () => {
    const running = await runMcpServer(options({ http: 4191 }));
    try {
      const client = new Client({ name: "test", version: "1" }, { capabilities: { elicitation: {} } });
      client.setRequestHandler(ElicitRequestSchema, () => ({ action: "accept", content: { confirm: true } }));
      await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4191/mcp")));
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("add_alert");
      await client.callTool({ name: "add_alert", arguments: { symbol: "NVDA", level: 200 } });
      expect(await queued()).toHaveLength(1);
      await client.close();

      const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } };
      const post = (headers: Record<string, string>) =>
        fetch("http://127.0.0.1:4191/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
          body: JSON.stringify(init),
        });
      // A page elsewhere in the person's browser, and a DNS-rebound hostname.
      expect((await post({ origin: "https://evil.example" })).status).toBe(403);
      // fetch won't send a Host of its choosing, so this one goes out through node:http.
      const rebound = await new Promise<number>((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port: 4191, path: "/mcp", method: "POST", headers: { host: "evil.example:4191", "content-type": "application/json", accept: "application/json, text/event-stream" } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          }
        );
        req.on("error", reject);
        req.end(JSON.stringify(init));
      });
      expect(rebound).toBe(403);
    } finally {
      await running.close();
    }
  }, 30_000);

  it("HTTP beyond loopback refuses to start without a bearer token", async () => {
    await expect(runMcpServer(options({ http: 4192, host: "0.0.0.0" }))).rejects.toThrow(/MCP_HTTP_TOKEN/);
  });
});
