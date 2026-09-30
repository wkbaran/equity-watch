/**
 * `equity-watch mcp`: the dashboard's agent tools over MCP, for agents with no
 * browser (Claude Code over stdio, Open WebUI over Streamable HTTP).
 *
 * The tools are web/webmcp.js's, loaded through ./toolbox.ts: same names,
 * schemas, argument checks, duplicate guards and op construction as the page.
 * `tools/list` is their TOOLS filtered by `available`; `tools/call` is their
 * `callTool`. This file only adds what a page gets from the browser:
 *
 *   - a host `api` (./siteApi.ts: the published site and its ops queue), and
 *   - a way to ask the person before a change is queued. The page has its
 *     dialog; here it is MCP elicitation when the client supports it. A client
 *     that doesn't is trusted to have asked the person itself before the call
 *     (Claude Code does, per tool), and the result says which happened. With
 *     --require-approval such a client is offered no write tools at all.
 *
 * On stdio, stdout is the protocol: everything else goes to stderr.
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, isInitializeRequest, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { errorText } from "../errorText.js";
import { SiteApi } from "./siteApi.js";
import { loadToolbox, type ConfirmAnswer, type ToolApi, type Toolbox } from "./toolbox.js";

export interface McpOptions {
  siteUrl: string;
  token: string | null;
  readOnly: boolean;
  allowHoldings: boolean;
  /** Offer write tools only to clients that can ask the person (MCP elicitation). */
  requireApproval: boolean;
  pendingFile: string;
  /** Port for Streamable HTTP; null serves stdio. */
  http: number | null;
  host: string;
  /** Bearer the HTTP endpoint requires. Mandatory when bound beyond loopback. */
  httpToken: string | null;
}

/** As long as the page's dialog waits (CONFIRM_TIMEOUT_MS in web/webmcp.js). */
const APPROVAL_TIMEOUT_MS = 120_000;

const INSTRUCTIONS =
  "Tools for the person's equity-watch dashboard: price and volume alerts, a queue of alert fires waiting for a decision, and (only if the person allowed it) their holdings. " +
  "Changes are queued, not applied: each is approved by the person, then applied by the next scheduled check, which can be minutes or hours away. " +
  "After queueing, call get_pending_changes to learn whether it was applied or rejected; never tell the person a change has taken effect before that says so. " +
  "What is offered depends on how the person started this server: without an ops token or with --read-only there are no tools that change anything, and tools for their holdings (positions, share counts, basis, stops) exist only if they started it with --allow-holdings. " +
  "If they ask for something those tools would do and the tools aren't offered, tell them which of those to change rather than saying the data doesn't exist.";

const log = (line: string) => process.stderr.write(`${line}\n`);

/** Asks the person through the client, when the client can. */
function approval(server: Server, requireApproval: boolean): NonNullable<ToolApi["confirm"]> {
  return async (summary, signal) => {
    if (!server.getClientCapabilities()?.elicitation) {
      if (requireApproval) return "declined"; // not reached: such a client is offered no write tools
      return {
        answer: "approved",
        status:
          "Queued on the strength of the client's own approval of this tool call: the client can't show this server's confirmation. It has not taken effect yet.",
      };
    }
    try {
      const result = await server.elicitInput(
        {
          message: `An agent wants to queue a change on your equity-watch dashboard:\n\n${summary}\n\nIt is applied at the next scheduled check, and rejected then if the thing has changed since.`,
          requestedSchema: {
            type: "object",
            properties: { confirm: { type: "boolean", title: "Queue this change", default: false } },
            required: ["confirm"],
          },
        },
        { signal, timeout: APPROVAL_TIMEOUT_MS }
      );
      if (result.action === "accept") {
        return result.content?.confirm === true
          ? { answer: "approved", status: "The person approved this when asked, and it is now queued. It has not taken effect yet." }
          : "declined";
      }
      return result.action === "decline" ? "declined" : "cancelled";
    } catch (err) {
      if (err instanceof McpError && err.code === Number(ErrorCode.RequestTimeout)) return "expired";
      if (signal?.aborted) return "cancelled";
      log(`equity-watch mcp: asking for approval failed (${errorText(err)})`);
      return "cancelled" satisfies ConfirmAnswer;
    }
  };
}

/** One MCP server per session: approval has to ask *this* client. The site and pending list are shared. */
export function sessionServer(box: Toolbox, site: SiteApi, opts: McpOptions): Server {
  const server = new Server({ name: "equity-watch", version: "1.0.0" }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  const base = site.toolApi(approval(server, opts.requireApproval));
  const canAsk = () => !opts.requireApproval || Boolean(server.getClientCapabilities()?.elicitation);
  const noAsking =
    "This server queues changes only through a client that can ask the person to approve each one (MCP elicitation), and this client can't. Use a client that supports it, or have the person restart the server without --require-approval.";
  const api: ToolApi = {
    ...base,
    canEdit: () => canAsk() && base.canEdit(),
    canEditHoldings: () => canAsk() && base.canEditHoldings(),
    text: {
      ...base.text,
      locked: {
        read: "",
        get write() {
          return canAsk() ? (base.text?.locked?.write ?? "") : noAsking;
        },
        get holdings() {
          return canAsk() ? (base.text?.locked?.holdings ?? "") : noAsking;
        },
      },
    },
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await site.refresh();
    return {
      tools: box.TOOLS.filter((t) => box.available(t, api)).map((t) => ({
        name: t.name,
        description: box.descriptionFor(t, api),
        inputSchema: t.inputSchema,
        annotations: box.annotationsFor(t),
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    await site.refresh();
    const tool = box.TOOLS.find((t) => t.name === request.params.name);
    if (!tool) return { content: [{ type: "text", text: `There is no tool named ${request.params.name}.` }], isError: true };
    // callTool gates again, so a tool listed before a lock still refuses.
    return box.callTool(tool, api, request.params.arguments ?? {}, extra.signal);
  });

  return server;
}

/** Resolves once serving; `close` stops an HTTP server (stdio ends with its client). */
export async function runMcpServer(opts: McpOptions): Promise<{ close(): Promise<void> }> {
  const box = await loadToolbox();
  const site = new SiteApi(box, opts);
  // Before serving, so the first tools/list already reflects what the site allows.
  await site.refresh(true);
  if (opts.http === null) {
    await sessionServer(box, site, opts).connect(new StdioServerTransport());
    log(`equity-watch mcp: serving ${opts.siteUrl} on stdio`);
    return { close: async () => {} };
  }
  return serveHttp(box, site, opts, opts.http);
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Streamable HTTP with sessions. Stateful on purpose: elicitation is a
 * request from the server to the client, and a stateless transport has no
 * channel to send it on.
 *
 * A server on localhost is reachable from any page open in the person's
 * browser, so requests must carry a Host naming this server (defeating DNS
 * rebinding) and, if they carry an Origin at all, a local one. Open WebUI
 * connects from its backend and sends none.
 */
async function serveHttp(box: Toolbox, site: SiteApi, opts: McpOptions, port: number): Promise<{ close(): Promise<void> }> {
  const loopback = LOOPBACK.has(opts.host);
  if (!loopback && !opts.httpToken) {
    throw new Error(`Serving on ${opts.host} needs MCP_HTTP_TOKEN set: anyone who can reach the port could otherwise queue changes.`);
  }
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);

  const reject = (res: ServerResponse, status: number, message: string) => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
  };

  const httpServer = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`equity-watch mcp: ${errorText(err)}`);
      if (!res.headersSent) reject(res, 500, "Internal error");
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/mcp") return reject(res, 404, "Not found; the endpoint is /mcp");
    if (loopback && !allowedHosts.has(req.headers.host ?? "")) return reject(res, 403, "Unexpected Host header");
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return reject(res, 403, "Cross-origin requests are not accepted");
    if (opts.httpToken && req.headers.authorization !== `Bearer ${opts.httpToken}`) return reject(res, 401, "Missing or wrong bearer token");

    const body = req.method === "POST" ? await readJson(req) : undefined;
    const sessionId = req.headers["mcp-session-id"];
    let transport = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (!transport) {
      if (req.method !== "POST" || !isInitializeRequest(body)) return reject(res, 400, "No valid session; start with an initialize request");
      const fresh = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => void sessions.set(id, fresh),
      });
      fresh.onclose = () => {
        if (fresh.sessionId) sessions.delete(fresh.sessionId);
      };
      await sessionServer(box, site, opts).connect(fresh);
      transport = fresh;
    }
    await transport.handleRequest(req, res, body);
  }

  await new Promise<void>((resolve, reject2) => {
    httpServer.once("error", reject2);
    httpServer.listen(port, opts.host, () => resolve());
  });
  log(`equity-watch mcp: serving ${opts.siteUrl} at http://${opts.host.includes(":") ? `[${opts.host}]` : opts.host}:${port}/mcp`);
  return {
    close: async () => {
      await Promise.all([...sessions.values()].map((t) => t.close()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += String(chunk);
    if (raw.length > 1_000_000) throw new Error("request body too large");
  }
  try {
    return raw === "" ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}
