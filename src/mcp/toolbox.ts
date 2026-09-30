/**
 * The dashboard's agent tools, loaded from the page's own file.
 *
 * web/webmcp.js is a classic browser script with a DOM-free core (see its
 * header). Importing it in Node runs it, and it hands its exports to
 * `globalThis.equityWatchWebMcp`, the same way it hands them to `window` on the
 * page. Nothing is copied: the MCP server lists these TOOLS, checks and runs
 * calls with this callTool, and settles pending changes with this
 * settlePending, so a tool behaves the same whichever host an agent reached.
 *
 * Resolved as ../../web/ from this module, which is correct from both
 * src/mcp/ (tsx) and dist/mcp/ (built); tsc copies no .js from web/, the same
 * reason src/web/site.ts resolves its assets that way.
 */

import type { OpResult } from "../ops/apply.js";
import type { AlertRow } from "../web/alertsPage.js";
import type { SiteDocument } from "../web/site.js";
import type { VaultContents } from "../web/vault.js";

// A type alias rather than an interface: the SDK's CallToolResult has an index
// signature, which only an alias satisfies implicitly.
export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export type ToolGroup = "read" | "write" | "holdings";

export interface AgentTool {
  name: string;
  group: ToolGroup;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  /** Op types a write tool can queue; absent on reads. */
  ops?: string[];
}

/** What the page keeps per queued change, and so what the server keeps too. */
export interface PendingOp {
  id: string;
  type: string;
  symbol: string | null;
  alertId: string | null;
  revisitId: string | null;
  summary: string;
  queuedAt: string;
}

export type ConfirmAnswer = "approved" | "declined" | "expired" | "cancelled";

export interface ToolText {
  locked: { read: string; write: string; holdings: string };
  access: string;
  approved: string;
}

/**
 * The host contract web/webmcp.js is written against. app.js builds one for
 * the page (startAgentTools); src/mcp/siteApi.ts builds one for Node.
 */
export interface ToolApi {
  dashboard(): SiteDocument | null;
  loaded(): Promise<unknown>;
  alerts(): Promise<{ generatedAt?: string; alerts: AlertRow[] } | null>;
  vault(): VaultContents | null;
  canEdit(): boolean;
  canEditHoldings(): boolean;
  holdingsShared(): boolean;
  pending(): PendingOp[];
  scheduleText(): string | null;
  loginExpiredSince(): string | null;
  parseVolume(raw: string | number): number | null;
  formatVolume(n: number): string;
  submit(op: Record<string, unknown>, meta: { symbol: string | null; alertId: string | null; revisitId: string | null; summary: string }): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  confirm?(summary: string, signal?: AbortSignal): Promise<ConfirmAnswer | { answer: ConfirmAnswer; status?: string }>;
  text?: Partial<ToolText>;
}

export interface Toolbox {
  TOOLS: AgentTool[];
  callTool(tool: AgentTool, api: ToolApi, args: unknown, signal?: AbortSignal): Promise<ToolResult>;
  available(tool: AgentTool, api: ToolApi): boolean;
  descriptionFor(tool: AgentTool, api: ToolApi): string;
  annotationsFor(tool: AgentTool): Record<string, boolean>;
  settlePending(
    pending: PendingOp[],
    results: OpResult[] | null | undefined,
    processedThrough: string | null | undefined
  ): { done: Array<{ pending: PendingOp; result: OpResult }>; processed: PendingOp[]; waiting: PendingOp[] };
  checkArgs(schema: AgentTool["inputSchema"], args: unknown): { args?: Record<string, unknown>; error?: string };
}

let loading: Promise<Toolbox> | null = null;

export function loadToolbox(): Promise<Toolbox> {
  loading ??= import(new URL("../../web/webmcp.js", import.meta.url).href).then(() => {
    const box = (globalThis as unknown as { equityWatchWebMcp?: Toolbox }).equityWatchWebMcp;
    if (!box?.callTool) throw new Error("web/webmcp.js didn't load its tools");
    return box;
  });
  return loading;
}
