/**
 * The agent's side of WebMCP, through Chrome's DevTools protocol.
 *
 * Chrome 152+ with `WebMCPTesting` on has a `WebMCP` CDP domain: `enable`, the
 * `toolsAdded`/`toolsRemoved` events, `invokeTool`, and `toolResponded` with
 * the result. That is the same registry and dispatch an in-browser agent goes
 * through, so a test that calls tools this way exercises the browser's half as
 * well as the page's. The stubbed suite (tests/webmcp.e2e.ts) can't.
 *
 * Shapes as observed on Chrome 152.0.7977.64 (2026-09-30), not from a spec:
 *   invokeTool({ frameId, toolName, input: object }) -> { invocationId }
 *   toolResponded { invocationId, status: "Completed" | "Error", output?, errorText? }
 * `input` must be an object; a JSON string is "Invalid parameters".
 */

import type { CDPSession, Page } from "@playwright/test";

/** Command-line features that turn WebMCP on in a Chrome that ships it. */
export const WEBMCP_CHROME_ARGS = ["--enable-features=WebMCPTesting,WebMCP,DevToolsWebMCPSupport"];

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnly?: boolean; untrustedContent?: boolean };
  frameId: string;
}

export interface ToolResponse {
  status: "Completed" | "Error" | string;
  /** The page's own return value: `{ content: [{ type: "text", text }], isError? }`. */
  output?: { content?: { type: string; text: string }[]; isError?: boolean };
  errorText?: string;
}

export class WebMcpAgent {
  readonly tools = new Map<string, AgentTool>();
  private readonly waiting = new Map<string, (r: ToolResponse) => void>();
  private readonly early = new Map<string, ToolResponse>();

  private constructor(private readonly cdp: CDPSession) {
    // Playwright's bundled protocol typings have a WebMCP domain from an older
    // Chrome: no toolResponded, and tool shapes that don't match 152's. The
    // shapes below are the observed ones, so listen untyped.
    const events = cdp as unknown as { on(event: string, listener: (payload: any) => void): void };
    events.on("WebMCP.toolsAdded", (e: { tools: AgentTool[] }) => {
      for (const t of e.tools) this.tools.set(t.name, t);
    });
    events.on("WebMCP.toolsRemoved", (e: { tools?: Array<{ name: string }>; names?: string[] }) => {
      for (const name of e.names ?? (e.tools ?? []).map((t) => t.name)) this.tools.delete(name);
    });
    events.on("WebMCP.toolResponded", (e: ToolResponse & { invocationId: string }) => {
      const waiter = this.waiting.get(e.invocationId);
      // A fast answer can land before start() has had its invocationId back to wait on it.
      if (waiter) waiter(e);
      else this.early.set(e.invocationId, e);
      this.waiting.delete(e.invocationId);
    });
  }

  /** Attach before navigating, so the first registrations are seen. */
  static async attach(page: Page): Promise<WebMcpAgent> {
    const cdp = await page.context().newCDPSession(page);
    const agent = new WebMcpAgent(cdp);
    await cdp.send("WebMCP.enable" as never);
    return agent;
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  /** Starts a call. Returns the invocation id and a promise of its response, so a caller can act (on a dialog, say) in between. */
  async start(toolName: string, input: Record<string, unknown> = {}): Promise<{ invocationId: string; response: Promise<ToolResponse> }> {
    const tool = this.tools.get(toolName);
    if (!tool) throw new Error(`No tool named ${toolName} is registered. Have: ${this.names().join(", ")}`);
    const { invocationId } = (await this.cdp.send("WebMCP.invokeTool" as never, { frameId: tool.frameId, toolName, input } as never)) as { invocationId: string };
    const early = this.early.get(invocationId);
    this.early.delete(invocationId);
    const response = early ? Promise.resolve(early) : new Promise<ToolResponse>((resolve) => this.waiting.set(invocationId, resolve));
    return { invocationId, response };
  }

  async call(toolName: string, input: Record<string, unknown> = {}): Promise<ToolResponse> {
    return (await this.start(toolName, input)).response;
  }

  async cancel(invocationId: string): Promise<void> {
    await this.cdp.send("WebMCP.cancelInvocation" as never, { invocationId } as never);
  }
}

/** The text a tool returned, and whether it said it failed. */
export function resultText(r: ToolResponse): { text: string; isError: boolean } {
  if (r.status !== "Completed") return { text: r.errorText ?? `status ${r.status}`, isError: true };
  return { text: (r.output?.content ?? []).map((c) => c.text).join("\n"), isError: r.output?.isError === true };
}

/** Whether the page has WebMCP: Chrome launches fine without the feature, and then simply has no `modelContext`. */
export async function hasWebMcp(page: Page): Promise<boolean> {
  return page.evaluate(() => typeof (document as unknown as { modelContext?: unknown }).modelContext === "object");
}
