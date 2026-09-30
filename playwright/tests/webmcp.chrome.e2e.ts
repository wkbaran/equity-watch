import { expect, test, type Page } from "@playwright/test";
import { OPS_TOKEN } from "../fixtures.js";
import { hasWebMcp, resultText, WebMcpAgent } from "../webmcpAgent.js";

/**
 * The WebMCP tools driven through Chrome's own implementation, the way an
 * agent reaches them: every call here goes through CDP's WebMCP.invokeTool,
 * never through a function handle the page gave us. Runs only in the
 * `chrome-webmcp` project (an installed Chrome with WebMCP switched on); see
 * playwright/webmcpAgent.ts for the protocol shapes this relies on.
 *
 * tests/webmcp.e2e.ts covers the same page with a stub modelContext on stable
 * Chromium. This file is what says the browser agrees with it.
 */

const READS = ["get_alert", "get_overview", "get_pending_changes", "list_alerts", "list_revisit_queue"];
const WRITES = ["add_alert", "apply_revisit", "dismiss_revisit", "edit_alert", "relevel_revisit", "remove_alert"];

const storeToken = (page: Page) => page.addInitScript((token) => localStorage.setItem("equity-watch.opsToken", token), OPS_TOKEN);
const queuedOps = async (page: Page): Promise<Array<Record<string, any>>> => (await page.request.get("/__ops")).json();
const dialog = (page: Page) => page.locator("dialog.agent-confirm");
const approve = (page: Page) => dialog(page).getByRole("button", { name: "Queue this change" });

let agent: WebMcpAgent;
let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  await page.request.get("/__reset");
  errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  agent = await WebMcpAgent.attach(page);
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

async function open(page: Page, { unlocked }: { unlocked: boolean }) {
  if (unlocked) await storeToken(page);
  await page.goto("/#/");
  test.skip(!(await hasWebMcp(page)), "This Chrome has no WebMCP (needs 152+ with WebMCPTesting).");
  await expect.poll(() => agent.names()).toEqual(expect.arrayContaining(unlocked ? [...READS, ...WRITES] : READS));
}

test("the browser sees the tools the page's state allows, with their read-only hint", async ({ page }) => {
  await open(page, { unlocked: false });
  expect(agent.names()).toEqual(READS);
  for (const name of READS) expect(agent.tools.get(name)?.annotations?.readOnly, name).toBe(true);

  page.once("dialog", (d) => d.accept(OPS_TOKEN));
  await page.locator("#ops-btn").click();
  await expect.poll(() => agent.names()).toEqual([...READS, ...WRITES].sort());
  for (const name of WRITES) expect(agent.tools.get(name)?.annotations?.readOnly, name).toBe(false);

  await page.locator("#ops-btn").click(); // Lock editing: the browser hears about the removals
  await expect.poll(() => agent.names()).toEqual(READS);
});

test("every read answers through the browser with JSON", async ({ page }) => {
  await open(page, { unlocked: false });
  const inputs: Record<string, Record<string, unknown>> = { get_alert: { symbol: "AA" }, list_alerts: { sort: "closest", limit: 3 } };
  for (const name of READS) {
    const r = resultText(await agent.call(name, inputs[name] ?? {}));
    expect(r.isError, `${name}: ${r.text}`).toBe(false);
    expect(() => JSON.parse(r.text), name).not.toThrow();
  }
});

test("input the browser lets through is refused by the tool, with a reason", async ({ page }) => {
  // Chrome 152 does not check input against inputSchema: all of these reach execute().
  await open(page, { unlocked: true });
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["list_alerts", { limit: "abc" }, /Limit must be an integer/],
    ["list_alerts", { bogus: 1 }, /Unknown field: bogus/],
    ["remove_alert", {}, /AlertId is required/],
    ["add_alert", { symbol: "NVDA", level: 200, direction: "sideways" }, /Direction must be one of up, down, either/],
  ];
  for (const [name, input, message] of cases) {
    const r = resultText(await agent.call(name, input));
    expect(r.isError, name).toBe(true);
    expect(r.text).toMatch(message);
  }
  await expect(dialog(page)).toHaveCount(0);
  expect(await queuedOps(page)).toEqual([]);
});

test("a write waits on the person, then queues through the page", async ({ page }) => {
  await open(page, { unlocked: true });
  const { response } = await agent.start("add_alert", { symbol: "NVDA", level: "200", direction: "up" });
  await expect(dialog(page)).toContainText("add NVDA alert: level 200, direction up");
  expect(await queuedOps(page)).toEqual([]);
  await approve(page).click();

  const r = resultText(await response);
  expect(r.isError).toBe(false);
  expect(JSON.parse(r.text)).toMatchObject({ queued: true });
  const [op] = await queuedOps(page);
  // "200" came in as a string, as models often send it, and went out as a number.
  expect(op).toMatchObject({ type: "alert.add", params: { symbol: "NVDA", level: 200, direction: "up" } });
});

test("a declined write says so and queues nothing", async ({ page }) => {
  await open(page, { unlocked: true });
  const { response } = await agent.start("dismiss_revisit", { revisitId: "rv0000a2" });
  await dialog(page).getByRole("button", { name: "Decline" }).click();
  const r = resultText(await response);
  expect(r.isError).toBe(true);
  expect(r.text).toMatch(/declined/);
  expect(await queuedOps(page)).toEqual([]);
});

test("a cancel the page never hears about can't turn into a duplicate", async ({ page }) => {
  await open(page, { unlocked: true });
  const input = { symbol: "NVDA", level: 200 };
  const first = await agent.start("add_alert", input);
  await expect(dialog(page)).toBeVisible();
  await agent.cancel(first.invocationId);
  // Chrome answers the agent at once, and passes the page nothing: execute()
  // gets no AbortSignal in Chrome 152. So the question stays up, and a person
  // who approves it queues the change after all...
  expect((await first.response).status).toBe("Canceled");
  await expect(dialog(page)).toBeVisible();

  // ...and the agent's natural retry, while it is still up, gets no second question.
  const whileAsking = resultText(await agent.call("add_alert", input));
  expect(whileAsking.isError).toBe(true);
  expect(whileAsking.text).toMatch(/already waiting on the person/);
  await expect(dialog(page)).toHaveCount(1);

  await approve(page).click({ timeout: 5000 });
  await expect(page.locator("#ops-pending")).toContainText("add NVDA alert");

  // Nor once it is queued: a second identical change is refused, not queued twice.
  const afterwards = resultText(await agent.call("add_alert", input));
  expect(afterwards.isError).toBe(true);
  expect(afterwards.text).toMatch(/already queued.*get_pending_changes/s);
  await expect(dialog(page)).toHaveCount(0);
  expect(await queuedOps(page)).toHaveLength(1);
});

test("a question nobody answers expires, and the agent is told so", async ({ page }) => {
  await open(page, { unlocked: true });
  await page.evaluate(() => ((window as any).equityWatchWebMcp.confirmTimeoutMs = 300));
  const r = resultText(await agent.call("dismiss_revisit", { revisitId: "rv0000a2" }));
  expect(r.isError).toBe(true);
  expect(r.text).toMatch(/didn't answer/);
  await expect(dialog(page)).toHaveCount(0);
  expect(await queuedOps(page)).toEqual([]);
});

test("holdings tools reach the browser only once the box is ticked", async ({ page }) => {
  await open(page, { unlocked: true });
  expect(agent.names()).not.toContain("list_positions");
  await page.locator("#agent-holdings").check();
  await expect.poll(() => agent.names()).toContain("list_positions");
  const r = resultText(await agent.call("get_position", { symbol: "AA" }));
  expect(JSON.parse(r.text).lots).toHaveLength(2);
  await page.locator("#agent-holdings").uncheck();
  await expect.poll(() => agent.names()).not.toContain("list_positions");
});
