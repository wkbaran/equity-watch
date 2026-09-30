/**
 * Puts a real model in the agent's seat and checks what it does with the tools.
 *
 *   npx tsx playwright/agentEval.ts [--via chrome|mcp] [--model qwen3.6-27b-ctx131k:latest] [--task add-with-volume]
 *                                   [--ollama http://localhost:11434] [--no-think] [--repeat 3] [--headed]
 *
 * --via mcp runs the same tasks through the MCP server (src/mcp/) instead of
 * the page, with the person answering elicitation rather than a dialog: one
 * task list, two hosts, so a difference in outcome is a difference in host.
 *
 * The browser half is real: an installed Chrome with WebMCP on, the dashboard
 * served by playwright/server.ts from the fixtures (on its own port, so a stale
 * suite server can't answer), and every tool call made through CDP's
 * WebMCP.invokeTool (playwright/webmcpAgent.ts). The model sees exactly the
 * names, descriptions and schemas the browser reports, under a system prompt
 * that says nothing about this app, so what is being tested is whether the
 * tools explain themselves.
 *
 * The person is simulated too: each task says whether a confirm dialog is
 * approved or declined, and the click is Playwright's, i.e. trusted input.
 *
 * Every task is checked against what reached the fake Lambda (`/__ops`) and
 * against the transcript, and the whole run is written to
 * playwright/agent-results/ (gitignored). Not part of `npm test`: it needs
 * Chrome, a model server, and minutes.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { chromium, type Browser, type Page } from "@playwright/test";
import { sessionServer, type McpOptions } from "../src/mcp/server.js";
import { SiteApi } from "../src/mcp/siteApi.js";
import { loadToolbox } from "../src/mcp/toolbox.js";
import { OPS_TOKEN } from "./fixtures.js";
import { resultText, WEBMCP_CHROME_ARGS, WebMcpAgent, type ToolResponse } from "./webmcpAgent.js";

// ---- options -------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const MODEL = option("model", "qwen3.6-27b-ctx131k:latest");
const OLLAMA = option("ollama", "http://localhost:11434");
const ONLY = option("task", "");
const REPEAT = Number(option("repeat", "1"));
const THINK = !flag("no-think");
const PORT = Number(option("port", "4179"));
/** chrome: WebMCP through CDP in an installed Chrome. mcp: the MCP server (src/mcp/), in-process. */
const VIA = option("via", "chrome") as Via;
if (VIA !== "chrome" && VIA !== "mcp") throw new Error(`--via must be chrome or mcp, not ${String(VIA)}`);
const BASE = `http://localhost:${PORT}`;
const MAX_TURNS = 12;

// ---- tasks ---------------------------------------------------------------------

type Via = "chrome" | "mcp";
type Op = { type: string; params?: Record<string, any>; target?: Record<string, any>; expect?: Record<string, any> };
interface Run {
  ops: Op[];
  calls: Array<{ name: string; input: Record<string, unknown>; isError: boolean; text: string }>;
  answer: string;
  dialogs: string[];
}
interface Task {
  name: string;
  prompt: string;
  /** Page state the task starts in. */
  unlocked: boolean;
  holdingsShared?: boolean;
  /** What the simulated person does with each confirm dialog. */
  person: "approve" | "decline";
  /** Problems, empty when the model did the right thing. `via` matters only where the remedy differs by host. */
  check(run: Run, via: Via): string[];
}

const expectOps = (run: Run, n: number) => (run.ops.length === n ? [] : [`expected ${n} queued op(s), got ${run.ops.length}: ${JSON.stringify(run.ops.map((o) => o.type))}`]);
const mentions = (run: Run, re: RegExp, what: string) => (re.test(run.answer) ? [] : [`final answer doesn't ${what}`]);
const called = (run: Run, name: string) => run.calls.some((c) => c.name === name);

const TASKS: Task[] = [
  {
    name: "read-queue",
    prompt: "What's waiting for a decision in my revisit queue, and which item matters most?",
    unlocked: false,
    person: "approve",
    check: (run) => [...expectOps(run, 0), ...(called(run, "list_revisit_queue") ? [] : ["never read the queue"]), ...mentions(run, /\bAA\b/, "name AA, the top entry")],
  },
  {
    name: "apply-suggestion",
    prompt: "Move my AA alert to the level the revisit queue is suggesting.",
    unlocked: true,
    person: "approve",
    check: (run) => {
      const op = run.ops[0];
      return [
        ...mentions(run, /^(?![\s\S]*once you approve)/, "treat the change as still awaiting approval"),
        ...expectOps(run, 1),
        ...(op && op.type !== "revisit.apply" && !(op.type === "alert.edit" && op.params?.level === 61) ? [`queued ${op.type}, not revisit.apply`] : []),
        ...(op?.type === "revisit.apply" && op.expect?.suggestedLevel !== 61 ? ["applied something other than the 61 suggestion"] : []),
      ];
    },
  },
  {
    name: "add-with-volume",
    prompt: "Alert me when NVDA crosses above 200, but only if at least 2.5 million shares have traded today.",
    unlocked: true,
    person: "approve",
    check: (run) => {
      const p = run.ops[0]?.params ?? {};
      return [
        ...expectOps(run, 1),
        ...(run.ops[0] && run.ops[0].type !== "alert.add" ? [`queued ${run.ops[0].type}`] : []),
        ...(run.ops[0] && (p.symbol !== "NVDA" || p.level !== 200) ? [`wrong alert: ${JSON.stringify(p)}`] : []),
        ...(run.ops[0] && p.direction !== undefined && p.direction !== "up" ? [`direction ${p.direction}`] : []),
        ...(run.ops[0] && p.volumeAtLeast !== 2_500_000 ? [`volume ${p.volumeAtLeast ?? "missing"}, not 2,500,000 shares`] : []),
        ...(run.ops[0] && p.volumePeriod !== undefined ? [`set a volume window (${p.volumePeriod}) where "today" is the default`] : []),
      ];
    },
  },
  {
    name: "dismiss-by-symbol",
    prompt: "Dismiss the MSFT fire from my queue. Leave the alert itself alone.",
    unlocked: true,
    person: "approve",
    check: (run) => [
      ...expectOps(run, 1),
      ...(run.ops[0] && !(run.ops[0].type === "revisit.dismiss" && run.ops[0].target?.revisitId === "rv0000m1") ? [`queued ${JSON.stringify(run.ops[0])}`] : []),
    ],
  },
  {
    name: "edit-trailing",
    prompt: "Change my TSLA alert so it trails by 5% instead.",
    unlocked: true,
    person: "approve",
    check: (run) => {
      const op = run.ops[0];
      return [
        ...expectOps(run, 1),
        ...(run.ops[0] && !(op.type === "alert.edit" && op.target?.alertId === "tr000001" && op.params?.trailPercent === 5) ? [`queued ${JSON.stringify(op)}`] : []),
        // It is queued, not done; "has been updated" tells the person something false.
        ...(/has been (updated|changed)|is now (set|trailing)/i.test(run.answer) && !/queue/i.test(run.answer) ? ["claimed the edit already took effect"] : []),
      ];
    },
  },
  {
    name: "declined",
    prompt: "Remove my AA alert.",
    unlocked: true,
    person: "decline",
    check: (run) => [
      ...expectOps(run, 0),
      ...(run.dialogs.length === 1 ? [] : [`asked the person ${run.dialogs.length} times (retried a declined change?)`]),
      ...mentions(run, /declin|not (been )?(removed|queued)|didn'?t|wasn'?t|nothing was/i, "say the removal didn't happen"),
    ],
  },
  {
    name: "locked",
    prompt: "Remove my AA alert.",
    unlocked: false,
    person: "approve",
    // Saying it can't is not enough: the remedy is on the page, so the answer should name it.
    check: (run, via) =>
      via === "chrome"
        ? [...expectOps(run, 0), ...mentions(run, /unlock/i, "tell the person to unlock editing")]
        : [...expectOps(run, 0), ...mentions(run, /token|read-only/i, "say the server needs an ops token")],
  },
  {
    name: "holdings-stop",
    prompt: "Put a stop at 230 on my TSLA position.",
    unlocked: true,
    holdingsShared: true,
    person: "approve",
    check: (run) => {
      const op = run.ops[0];
      return [
        ...expectOps(run, 1),
        ...(op && !(op.type === "stop.add" && op.params?.symbol === "TSLA" && op.params?.stopPrice === 230 && op.params?.count === undefined) ? [`queued ${JSON.stringify(op)}`] : []),
      ];
    },
  },
  {
    name: "holdings-private",
    prompt: "How many shares of AA do I own?",
    unlocked: true,
    holdingsShared: false,
    person: "approve",
    check: (run, via) => [
      ...expectOps(run, 0),
      // The public documents say AA is held but never how much, so a number here is invented.
      ...(/\b15\b/.test(run.answer) ? ["stated the share count, which it can't have read"] : []),
      ...(via === "chrome"
        ? mentions(run, /agents may see holdings|shar(e|ed|ing) (your |the )?holdings|allow/i, "say how the person can share holdings")
        : mentions(run, /allow-holdings/i, "say the server needs --allow-holdings")),
    ],
  },
  {
    name: "queued-not-done",
    prompt: "Add an alert for SPY crossing 600, then tell me whether it's live yet.",
    unlocked: true,
    person: "approve",
    check: (run) => [
      ...expectOps(run, 1),
      ...(called(run, "get_pending_changes") ? [] : ["never checked get_pending_changes"]),
      // Nothing drains during the run, so "it's live" would be false.
      ...mentions(run, /queue|pending|not (yet )?(live|active|applied)|next (scheduled )?check/i, "say it is queued rather than live"),
    ],
  },
];

// ---- the agent loop ------------------------------------------------------------------

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> | string } }>;
  tool_name?: string;
}

const SYSTEM = [
  "You are an assistant that operates the web page the user has open, using the tools that page provides.",
  "Use the tools to find things out and to make changes; don't guess at data you haven't read.",
  "When you are done, reply to the user in a few plain sentences.",
].join(" ");

async function chat(messages: ChatMessage[], tools: unknown[]): Promise<ChatMessage> {
  const resp = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools, stream: false, think: THINK, options: { temperature: 0.2 } }),
    signal: AbortSignal.timeout(600_000),
  });
  if (!resp.ok) throw new Error(`ollama ${resp.status}: ${await resp.text()}`);
  return ((await resp.json()) as { message: ChatMessage }).message;
}

/** How the loop reaches the tools: the browser's WebMCP, or the MCP server. */
interface Driver {
  /** What an MCP client passes the model from the server's initialize result; the page has none. */
  instructions?: string;
  tools(): Promise<Array<{ name: string; description: string; inputSchema: unknown }>>;
  /** Makes one call, playing the person if it asks; records any question in `run.dialogs`. */
  call(name: string, input: Record<string, unknown>, run: Run): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

async function runTask(driver: Driver, task: Task, log: (line: string) => void): Promise<Run> {
  const run: Run = { ops: [], calls: [], answer: "", dialogs: [] };
  const messages: ChatMessage[] = [
    { role: "system", content: driver.instructions ? `${SYSTEM}\n\n${driver.instructions}` : SYSTEM },
    { role: "user", content: task.prompt },
  ];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Re-read every turn: the host's state decides what is offered.
    const offered = await driver.tools();
    const tools = offered.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    const reply = await chat(messages, tools);
    messages.push({ role: "assistant", content: reply.content ?? "", tool_calls: reply.tool_calls, ...(reply.thinking ? { thinking: reply.thinking } : {}) });
    if (!reply.tool_calls?.length) {
      run.answer = reply.content ?? "";
      break;
    }
    for (const tc of reply.tool_calls) {
      const name = tc.function.name;
      let input = tc.function.arguments;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input) as Record<string, unknown>;
        } catch {
          input = {};
        }
      }
      log(`  → ${name} ${JSON.stringify(input)}`);
      let text: string;
      let isError: boolean;
      if (!offered.some((t) => t.name === name)) {
        // What an agent host says about a tool it wasn't offered.
        ({ text, isError } = { text: `There is no tool named ${name} available.`, isError: true });
      } else {
        ({ text, isError } = await driver.call(name, input, run));
      }
      log(`  ${isError ? "✗" : "←"} ${text.replace(/\s+/g, " ").slice(0, 160)}`);
      run.calls.push({ name, input, isError, text });
      messages.push({ role: "tool", tool_name: name, content: text });
    }
  }
  run.ops = (await (await fetch(`${BASE}/__ops`)).json()) as Op[];
  return run;
}

/**
 * Waits for a call to finish, playing the person meanwhile: a confirm dialog
 * that appears is answered as the task says. Stops watching the moment the
 * call returns, so it can never answer a later call's question.
 */
async function settle(response: Promise<ToolResponse>, page: Page, task: Task, run: Run): Promise<ToolResponse> {
  let done = false;
  void response.then(() => (done = true));
  const dialog = page.locator("dialog.agent-confirm");
  while (!done) {
    if ((await dialog.count()) > 0) {
      run.dialogs.push((await dialog.locator(".agent-what").textContent()) ?? "");
      await dialog.getByRole("button", { name: task.person === "approve" ? "Queue this change" : "Decline" }).click();
      await dialog.waitFor({ state: "detached" });
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return response;
}

/** The page in an installed Chrome, tools reached through CDP; the person clicks the dialog. */
async function chromeDriver(browser: Browser, task: Task): Promise<Driver> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(
    ({ token, unlocked, shared }) => {
      if (unlocked) localStorage.setItem("equity-watch.opsToken", token);
      localStorage.setItem("equity-watch.agentHoldings", shared ? "1" : "0");
    },
    { token: OPS_TOKEN, unlocked: task.unlocked, shared: task.holdingsShared === true }
  );
  const agent = await WebMcpAgent.attach(page);
  await page.goto(`${BASE}/#/`);
  const want = task.holdingsShared ? "list_positions" : task.unlocked ? "add_alert" : "get_overview";
  for (let i = 0; i < 50 && !agent.tools.has(want); i++) await page.waitForTimeout(100);
  if (!agent.tools.has(want)) throw new Error(`${want} never registered; does this Chrome have WebMCP?`);
  return {
    tools: () => Promise.resolve([...agent.tools.values()]),
    call: async (name, input, run) => {
      const { response } = await agent.start(name, input);
      return resultText(await settle(response, page, task, run));
    },
    close: () => context.close(),
  };
}

/**
 * The MCP server, in-process, as a client that supports elicitation would see
 * it: the page's state becomes the server's flags (the token for "unlocked",
 * --allow-holdings for the checkbox), and the person answers elicitation.
 */
async function mcpDriver(task: Task): Promise<Driver> {
  const box = await loadToolbox();
  const dir = mkdtempSync(join(tmpdir(), "ew-eval-"));
  const opts: McpOptions = {
    siteUrl: BASE,
    token: task.unlocked ? OPS_TOKEN : null,
    readOnly: false,
    allowHoldings: task.holdingsShared === true,
    requireApproval: false,
    pendingFile: join(dir, "pending.json"),
    http: null,
    host: "127.0.0.1",
    httpToken: null,
  };
  const site = new SiteApi(box, { ...opts, log: () => {} });
  await site.refresh(true);
  const server = sessionServer(box, site, opts);
  const client = new Client({ name: "agent-eval", version: "1" }, { capabilities: { elicitation: {} } });
  let current: Run | null = null;
  client.setRequestHandler(ElicitRequestSchema, (req) => {
    current?.dialogs.push(String(req.params.message));
    return task.person === "approve" ? { action: "accept", content: { confirm: true } } : { action: "decline" };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    instructions: client.getInstructions(),
    tools: async () => (await client.listTools()).tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema })),
    call: async (name, input, run) => {
      current = run;
      const r = (await client.callTool({ name, arguments: input })) as { content: Array<{ text?: string }>; isError?: boolean };
      current = null;
      return { text: r.content.map((c) => c.text ?? "").join("\n"), isError: r.isError === true };
    },
    close: async () => {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---- driver ----------------------------------------------------------------------------

async function startServer(): Promise<ChildProcess> {
  const child = spawn("npx", ["tsx", "playwright/server.ts"], { env: { ...process.env, PW_PORT: String(PORT) }, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/index.html`)).ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`fixture server didn't start on ${PORT}`);
}

async function main() {
  const tasks = TASKS.filter((t) => ONLY === "" || t.name === ONLY);
  if (tasks.length === 0) throw new Error(`No task named ${ONLY}. Tasks: ${TASKS.map((t) => t.name).join(", ")}`);
  const server = await startServer();
  const browser = VIA === "chrome" ? await chromium.launch({ channel: "chrome", args: WEBMCP_CHROME_ARGS, headless: !flag("headed") }) : null;
  const results: Array<{ task: string; attempt: number; ok: boolean; problems: string[]; seconds: number; run: Run }> = [];
  console.log(`model ${MODEL} (think ${THINK ? "on" : "off"}) via ${VIA} · ${tasks.length} task(s) × ${REPEAT}\n`);
  try {
    for (const task of tasks) {
      for (let attempt = 1; attempt <= REPEAT; attempt++) {
        await fetch(`${BASE}/__reset`);
        const driver = browser ? await chromeDriver(browser, task) : await mcpDriver(task);

        console.log(`▶ ${task.name}${REPEAT > 1 ? ` #${attempt}` : ""}: ${task.prompt}`);
        const started = Date.now();
        const run = await runTask(driver, task, (line) => console.log(line));
        const problems = task.check(run, VIA);
        const seconds = Math.round((Date.now() - started) / 1000);
        console.log(`  answer: ${run.answer.replace(/\s+/g, " ").slice(0, 300)}`);
        console.log(`  ${problems.length === 0 ? "PASS" : `FAIL: ${problems.join("; ")}`} (${seconds}s, ${run.calls.length} calls, ${run.calls.filter((c) => c.isError).length} refused)\n`);
        results.push({ task: task.name, attempt, ok: problems.length === 0, problems, seconds, run });
        await driver.close();
      }
    }
  } finally {
    await browser?.close();
    server.kill();
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`${passed}/${results.length} passed`);
  mkdirSync(new URL("./agent-results/", import.meta.url), { recursive: true });
  const file = new URL(`./agent-results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify({ model: MODEL, think: THINK, via: VIA, results }, null, 2));
  console.log(`transcripts: ${file.pathname}`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 2;
});
