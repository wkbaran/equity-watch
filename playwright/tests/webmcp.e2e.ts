import { expect, test, type Page } from "@playwright/test";
import { OPS_TOKEN } from "../fixtures.js";
import { unlockWith } from "../unlock.js";

/**
 * Stable Chromium has no WebMCP, so each test installs a stand-in for the
 * browser's half: a modelContext that records what the page registers and
 * drops a tool when its signal aborts (how the current spec unregisters). The
 * page's half, web/webmcp.js, is the real one. `callTool` runs a registered
 * tool's execute() the way an agent would.
 */

const poll = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
const storeToken = (page: Page) => page.addInitScript((token) => localStorage.setItem("equity-watch.opsToken", token), OPS_TOKEN);

function installModelContext(page: Page, host: "document" | "navigator" = "document") {
  return page.addInitScript((where) => {
    const tools = new Map<string, unknown>();
    (window as any).__mcp = tools;
    const target: any = where === "document" ? document : navigator;
    target.modelContext = {
      registerTool(descriptor: { name: string }, options?: { signal?: AbortSignal }) {
        // A second registration of a live name is an InvalidStateError in the spec.
        if (tools.has(descriptor.name)) throw new Error(`InvalidStateError: ${descriptor.name} is already registered`);
        tools.set(descriptor.name, descriptor);
        options?.signal?.addEventListener("abort", () => tools.delete(descriptor.name));
      },
    };
  }, host);
}

const toolNames = (page: Page) => page.evaluate(() => [...((window as any).__mcp as Map<string, unknown>).keys()].sort());

type ToolResult = { content: { text: string }[]; isError?: boolean };
/** Starts a tool call and returns its promise, so a spec can act on the confirm dialog before awaiting it. */
const callTool = (page: Page, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
  page.evaluate(([n, a]) => ((window as any).__mcp as Map<string, any>).get(n as string).execute(a, {}), [name, args] as const);
const json = (r: ToolResult) => JSON.parse(r.content[0].text);

async function queuedOps(page: Page): Promise<Array<Record<string, any>>> {
  return (await page.request.get("/__ops")).json();
}

const dialog = (page: Page) => page.locator("dialog.agent-confirm");
const approve = (page: Page) => dialog(page).getByRole("button", { name: "Queue this change" });
const decline = (page: Page) => dialog(page).getByRole("button", { name: "Decline" });

async function openUnlocked(page: Page) {
  await storeToken(page);
  await page.goto("/#/");
  await expect(page.locator("#ops-btn")).toHaveText("Lock editing");
  await expect.poll(() => toolNames(page)).toContain("add_alert");
}

const READS = ["get_alert", "get_chart_url", "get_overview", "get_pending_changes", "list_alerts", "list_revisit_queue"];
const WRITES = ["add_alert", "apply_revisit", "dismiss_revisit", "edit_alert", "relevel_revisit", "remove_alert"];
const HOLDINGS = ["add_lot", "add_stop", "cover_position", "edit_lot", "edit_stop", "get_position", "get_stories", "list_positions", "remove_lot", "remove_position", "remove_stop"];

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  await page.request.get("/__reset");
  await installModelContext(page);
  errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test.describe("what is registered", () => {
  test("a locked page offers reads and nothing that could change anything", async ({ page }) => {
    await page.goto("/#/");
    await expect(page.locator("#tiles .tile").first()).toBeVisible();
    expect(await toolNames(page)).toEqual(READS);
    await expect(page.locator("#agent-holdings-label")).toBeHidden();
  });

  test("unlocking adds the alert writes and locking withdraws them", async ({ page }) => {
    await page.goto("/#/");
    await unlockWith(page, OPS_TOKEN);
    await expect.poll(() => toolNames(page)).toEqual([...READS, ...WRITES].sort());

    await page.locator("#ops-btn").click(); // Lock editing
    await expect.poll(() => toolNames(page)).toEqual(READS);
  });

  test("holdings tools need the vault open and the switch on, and the choice is remembered", async ({ page }) => {
    await openUnlocked(page);
    // Unlocked, but nothing shares holdings with an agent until the person says so.
    await expect(page.locator("#agent-holdings-label")).toBeVisible();
    await expect(page.locator("#agent-holdings")).not.toBeChecked();
    expect(await toolNames(page)).toEqual([...READS, ...WRITES].sort());

    await page.locator("#agent-holdings").check();
    await expect.poll(() => toolNames(page)).toEqual([...READS, ...WRITES, ...HOLDINGS].sort());

    await page.reload();
    await expect(page.locator("#agent-holdings")).toBeChecked();
    await expect.poll(() => toolNames(page)).toContain("list_positions");

    await page.locator("#agent-holdings").uncheck();
    await expect.poll(() => toolNames(page)).toEqual([...READS, ...WRITES].sort());
  });

  test("also registers where only navigator.modelContext exists", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await installModelContext(page, "navigator");
    await page.goto("/#/");
    await expect(page.locator("#tiles .tile").first()).toBeVisible();
    expect(await toolNames(page)).toEqual(READS);
    await context.close();
  });

  test("a browser without WebMCP gets the same page and no toggle", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript((token) => localStorage.setItem("equity-watch.opsToken", token), OPS_TOKEN);
    await page.goto("/#/");
    await expect(page.locator("#ops-btn")).toHaveText("Lock editing");
    await expect(page.locator("#agent-holdings-label")).toBeHidden();
    await context.close();
  });
});

test.describe("reads", () => {
  test("report the page's own data", async ({ page }) => {
    await page.goto("/#/");
    await expect(page.locator("#tiles .tile").first()).toBeVisible();

    const overview = json(await callTool(page, "get_overview"));
    expect(overview.summary.liveAlerts).toBeGreaterThan(0);
    expect(overview.editingUnlocked).toBe(false);

    const queue = json(await callTool(page, "list_revisit_queue"));
    const row = queue.find((r: any) => r.id === "rv0000a2");
    expect(row).toMatchObject({ symbol: "AA", suggestedLevel: 61, heldPosition: true, alertCondition: "price crosses above 55" });
    // A queue row names the held tag but never a size: those stay in the vault.
    expect(JSON.stringify(queue)).not.toMatch(/"shares"|"basis"|"marketValue"/);

    const alerts = json(await callTool(page, "list_alerts", { symbol: "aa" }));
    expect(alerts.matched).toBe(1);
    expect(alerts.alerts[0]).toMatchObject({ id: "st000001", kind: "static", level: 55 });

    const one = json(await callTool(page, "get_alert", { symbol: "AA" }));
    expect(one[0].id).toBe("st000001");
    expect(one[0].recentFires.length).toBeGreaterThan(0);
  });

  test("get_chart_url uses the page's own exchange prefixes, and asks for dark mode", async ({ page }) => {
    await page.goto("/#/");
    expect(json(await callTool(page, "get_chart_url", { symbol: "MSFT" })).url).toBe("https://www.tradingview.com/chart/?symbol=NASDAQ%3AMSFT&theme=dark");
    expect(json(await callTool(page, "get_chart_url", { symbol: "AA" })).exchange).toBeNull();
  });

  test("a read called before the first dashboard.json arrives waits for it", async ({ page }) => {
    // Tools register as soon as the script runs. Over a real network the first
    // fetch can still be in flight (it was, on the live site), so hold it back here.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/dashboard.json", async (route) => {
      await held;
      await route.continue();
    });
    await page.goto("/#/");
    await expect.poll(() => toolNames(page)).toContain("get_overview");
    const call = callTool(page, "get_overview");
    setTimeout(release, 500);
    const result = await call;
    expect(result.isError).toBeFalsy();
    expect(json(result).summary.liveAlerts).toBeGreaterThan(0);
  });

  test("holdings reads come out of the vault", async ({ page }) => {
    await openUnlocked(page);
    await page.locator("#agent-holdings").check();
    await expect.poll(() => toolNames(page)).toContain("list_positions");

    const positions = json(await callTool(page, "list_positions"));
    expect(positions.find((p: any) => p.symbol === "AA")).toMatchObject({ shares: 15, stops: [38] });

    const aa = json(await callTool(page, "get_position", { symbol: "AA" }));
    expect(aa.lots.map((l: any) => l.id).sort()).toEqual(["lot00001", "lot00002"]);
    expect(aa.stops[0]).toMatchObject({ id: "stop0001", stopPrice: 38 });

    const stories = json(await callTool(page, "get_stories"));
    expect(stories.some((s: any) => s.symbol === "AA")).toBe(true);
  });

  test("a tool an agent kept a reference to stops working when the page locks", async ({ page }) => {
    await openUnlocked(page);
    await page.evaluate(() => ((window as any).kept = ((window as any).__mcp as Map<string, any>).get("remove_alert")));
    await page.locator("#ops-btn").click(); // Lock editing
    await expect.poll(() => toolNames(page)).toEqual(READS);
    // Unregistered, but an agent holding the function can still call it: the tool checks for itself.
    const result: ToolResult = await page.evaluate(() => (window as any).kept.execute({ alertId: "st000001" }, {}));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/locked/);
    await expect(dialog(page)).toHaveCount(0);
    expect(await queuedOps(page)).toEqual([]);
  });
});

test.describe("writes", () => {
  test("wait for the person, then queue exactly what was asked", async ({ page }) => {
    await openUnlocked(page);
    const call = callTool(page, "add_alert", { symbol: "nvda", level: 200, direction: "up" });

    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText("add NVDA alert: level 200, direction up");
    expect(await queuedOps(page)).toEqual([]); // nothing is sent while the question is open

    await approve(page).click();
    const result = json(await call);
    expect(result).toMatchObject({ queued: true, change: "add NVDA alert: level 200, direction up" });
    await expect(dialog(page)).toHaveCount(0);

    const ops = await queuedOps(page);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ id: result.opId, type: "alert.add", params: { symbol: "NVDA", level: 200, direction: "up" } });
    // The page's own pending list picked it up, the same as a click would.
    await expect(page.locator("#ops-pending")).toContainText("add NVDA alert");
  });

  test("declining queues nothing", async ({ page }) => {
    await openUnlocked(page);
    const call = callTool(page, "add_alert", { symbol: "NVDA", level: 200 });
    await decline(page).click();
    const result = await call;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/declined/);
    expect(await queuedOps(page)).toEqual([]);
  });

  test("Escape declines too", async ({ page }) => {
    await openUnlocked(page);
    const call = callTool(page, "add_alert", { symbol: "NVDA", level: 200 });
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    expect((await call).isError).toBe(true);
    expect(await queuedOps(page)).toEqual([]);
  });

  test("a scripted click can't approve its own request", async ({ page }) => {
    await openUnlocked(page);
    const call = callTool(page, "add_alert", { symbol: "NVDA", level: 200 });
    await expect(dialog(page)).toBeVisible();
    await page.evaluate(() => (document.querySelector("dialog.agent-confirm button.primary") as HTMLElement).click());
    await expect(dialog(page)).toContainText("needs a real click");
    expect(await queuedOps(page)).toEqual([]);

    await approve(page).click(); // Playwright's click is trusted input, like a person's
    expect(json(await call).queued).toBe(true);
  });

  test("an unanswered question expires", async ({ page }) => {
    await openUnlocked(page);
    await page.evaluate(() => ((window as any).equityWatchWebMcp.confirmTimeoutMs = 300));
    await expect(dialog(page)).toHaveCount(0);
    const result = await callTool(page, "add_alert", { symbol: "NVDA", level: 200 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/didn't answer/);
    await expect(dialog(page)).toHaveCount(0);
    expect(await queuedOps(page)).toEqual([]);
  });

  test("with asking switched off, a change is queued with no dialog, and the agent is told so", async ({ page }) => {
    await openUnlocked(page);
    const box = page.locator("#agent-auto-approve");
    await expect(box).not.toBeChecked();
    await box.check();

    const result = json(await callTool(page, "add_alert", { symbol: "NVDA", level: 200 }));
    expect(result).toMatchObject({ queued: true, applied: false });
    expect(result.status).toMatch(/without asking/);
    await expect(dialog(page)).toHaveCount(0);
    expect(await queuedOps(page)).toHaveLength(1);

    // Every other guard still holds: the same change again is refused.
    const again = await callTool(page, "add_alert", { symbol: "NVDA", level: 200 });
    expect(again.content[0].text).toMatch(/already queued/);

    // Remembered per browser, and offered only while editing is unlocked.
    await page.reload();
    await expect(box).toBeChecked();
    await page.locator("#ops-btn").click(); // Lock editing
    await expect(page.locator("#agent-auto-approve-label")).toBeHidden();
    await expect.poll(() => toolNames(page)).not.toContain("add_alert");
  });

  test("a scripted click can't switch asking off", async ({ page }) => {
    await openUnlocked(page);
    await page.evaluate(() => document.getElementById("agent-auto-approve")!.click());
    await expect(page.locator("#agent-auto-approve")).not.toBeChecked();
    const call = callTool(page, "add_alert", { symbol: "NVDA", level: 200 });
    await expect(dialog(page)).toBeVisible();
    await approve(page).click();
    expect(json(await call).queued).toBe(true);
  });

  test("the same change can't be queued twice while the first is pending", async ({ page }) => {
    await openUnlocked(page);
    const call = callTool(page, "add_alert", { symbol: "NVDA", level: 200 });
    await approve(page).click();
    await call;
    const again = await callTool(page, "add_alert", { symbol: "NVDA", level: 200 });
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toMatch(/already queued/);
    await expect(dialog(page)).toHaveCount(0);
    expect(await queuedOps(page)).toHaveLength(1);
  });

  test("locking while the question is open withdraws the permission", async ({ page }) => {
    await openUnlocked(page);
    const call = callTool(page, "add_alert", { symbol: "NVDA", level: 200 });
    await expect(dialog(page)).toBeVisible();
    await page.evaluate(() => document.getElementById("ops-btn")!.click()); // Lock editing
    await approve(page).click();
    const result = await call;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/locked/);
    expect(await queuedOps(page)).toEqual([]);
  });

  test("questions are asked one at a time", async ({ page }) => {
    await openUnlocked(page);
    const first = callTool(page, "add_alert", { symbol: "NVDA", level: 200 });
    const second = callTool(page, "add_alert", { symbol: "SPY", level: 600 });
    await expect(dialog(page)).toHaveCount(1);
    await expect(dialog(page)).toContainText("NVDA");
    await approve(page).click();
    await first;
    await expect(dialog(page)).toContainText("SPY");
    await decline(page).click();
    expect((await second).isError).toBe(true);
    expect((await queuedOps(page)).map((o) => o.params.symbol)).toEqual(["NVDA"]);
  });

  test("an edit carries the condition it read, by id", async ({ page }) => {
    await openUnlocked(page);
    const call = callTool(page, "edit_alert", { alertId: "st000001", level: 60, volumeAtLeast: "2.5M" });
    await expect(dialog(page)).toContainText("level 60, volumeAtLeast 2.5M");
    await approve(page).click();
    expect(json(await call).queued).toBe(true);
    const [op] = await queuedOps(page);
    expect(op).toMatchObject({
      type: "alert.edit",
      target: { alertId: "st000001" },
      expect: { condition: "price crosses above 55" },
      // "2.5M" is the page's own shorthand; the worker only ever sees the number.
      params: { level: 60, volumeAtLeast: 2_500_000 },
    });
  });

  test("apply_revisit guards on the suggestion as well as the condition", async ({ page }) => {
    await openUnlocked(page);
    const call = callTool(page, "apply_revisit", { revisitId: "rv0000a2" });
    await approve(page).click();
    expect(json(await call).queued).toBe(true);
    const [op] = await queuedOps(page);
    expect(op).toMatchObject({
      type: "revisit.apply",
      target: { revisitId: "rv0000a2", alertId: "st000001" },
      expect: { suggestedLevel: 61, condition: "price crosses above 55" },
    });
    // While one change is waiting on the entry, a second isn't offered.
    const again = await callTool(page, "dismiss_revisit", { revisitId: "rv0000a2" });
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toMatch(/already queued/);
  });

  test("remove and dismiss are by id, and refuse what isn't there", async ({ page }) => {
    await openUnlocked(page);
    const gone = await callTool(page, "remove_alert", { alertId: "nope0000" });
    expect(gone.isError).toBe(true);

    const call = callTool(page, "dismiss_revisit", { revisitId: "rv0000a2" });
    await approve(page).click();
    await call;
    const [op] = await queuedOps(page);
    expect(op).toMatchObject({ type: "revisit.dismiss", target: { revisitId: "rv0000a2", alertId: "st000001" } });
  });

  test("bad input is refused before anyone is asked", async ({ page }) => {
    await openUnlocked(page);
    for (const args of [{ symbol: "NVDA", level: 200, stopLoss: 1 }, { symbol: "NVDA" }, { symbol: "NVDA", volumeAtLeast: "lots" }]) {
      const result = await callTool(page, "add_alert", args);
      expect(result.isError).toBe(true);
    }
    await expect(dialog(page)).toHaveCount(0);
    expect(await queuedOps(page)).toEqual([]);
  });

  test("a rejected request says why", async ({ page }) => {
    await openUnlocked(page);
    // The fake Lambda 400s a type it doesn't know; force that by making it refuse this one.
    await page.route("**/api/ops", (route) => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Unknown op type" }) }));
    const call = callTool(page, "add_alert", { symbol: "NVDA", level: 200 });
    await approve(page).click();
    const result = await call;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown op type/);
    // The browser logs the 400 it was handed on purpose as a failed load.
    errors = errors.filter((e) => !/status of 400/.test(e));
  });

  test("the outcome comes back through get_pending_changes", async ({ page }) => {
    await openUnlocked(page);
    const call = callTool(page, "add_alert", { symbol: "NVDA", level: 200 });
    await approve(page).click();
    const { opId } = json(await call);

    const waiting = json(await callTool(page, "get_pending_changes"));
    expect(waiting.waiting.map((w: any) => w.opId)).toEqual([opId]);

    await page.request.get("/__release");
    await poll(page);
    await expect.poll(async () => json(await callTool(page, "get_pending_changes")).recentOutcomes.map((o: any) => o.opId)).toContain(opId);
    const done = json(await callTool(page, "get_pending_changes"));
    expect(done.waiting).toEqual([]);
    expect(done.recentOutcomes.find((o: any) => o.opId === opId)).toMatchObject({ ok: true, type: "alert.add" });
  });
});

test.describe("holdings writes", () => {
  test("carry the guards the page's own controls carry", async ({ page }) => {
    await openUnlocked(page);
    await page.locator("#agent-holdings").check();
    await expect.poll(() => toolNames(page)).toContain("remove_stop");

    const lot = callTool(page, "edit_lot", { lotId: "lot00001", count: 12, account: "" });
    await expect(dialog(page)).toContainText("edit AA lot (10 @ 40): count 12, account");
    await approve(page).click();
    await lot;

    const stop = callTool(page, "remove_stop", { stopId: "stop0001" });
    await approve(page).click();
    await stop;

    const position = callTool(page, "remove_position", { symbol: "AA" });
    await approve(page).click();
    await position;

    const buy = callTool(page, "add_lot", { symbol: "SPY", count: 3, basisPerShare: 570, stopPrice: 540 });
    await approve(page).click();
    await buy;

    const [editLot, removeStop, removePosition, addLot] = await queuedOps(page);
    expect(editLot).toMatchObject({
      type: "lot.edit",
      target: { lotId: "lot00001" },
      expect: { count: 10, basisPerShare: 40, purchaseDate: "2026-09-01", account: "roth" },
      params: { count: 12, account: "" }, // an empty account is how a label is cleared
    });
    expect(removeStop).toMatchObject({ type: "stop.remove", target: { stopId: "stop0001" }, expect: { stopPrice: 38 } });
    expect(removePosition).toMatchObject({ type: "position.remove", target: { symbol: "AA" }, expect: { lotIds: ["lot00001", "lot00002"] } });
    expect(addLot).toMatchObject({ type: "lot.add", params: { symbol: "SPY", count: 3, basisPerShare: 570, stopPrice: 540 } });
  });

  test("turning the switch off while a question is open withdraws the permission", async ({ page }) => {
    await openUnlocked(page);
    await page.locator("#agent-holdings").check();
    await expect.poll(() => toolNames(page)).toContain("remove_stop");
    const call = callTool(page, "remove_stop", { stopId: "stop0001" });
    await expect(dialog(page)).toBeVisible();
    await page.evaluate(() => document.getElementById("agent-holdings")!.click());
    await approve(page).click();
    const result = await call;
    expect(result.isError).toBe(true);
    expect(await queuedOps(page)).toEqual([]);
  });

  test("the published documents still carry no holdings", async ({ page }) => {
    await openUnlocked(page);
    await page.locator("#agent-holdings").check();
    const doc = await (await page.request.get("/dashboard.json")).json();
    expect(doc.holdings).toEqual([]);
    expect(doc.stories).toEqual([]);
    expect(JSON.stringify(doc)).not.toMatch(/"shares"|"basisPerShare"|"stopPrice"|"marketValue"/);
  });
});
