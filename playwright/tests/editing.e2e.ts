import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_REVISITS, MOVING_AVERAGE, OPS_TOKEN, STATIC, STATIC_WITH_VOLUME, TRAILING, VOLUME_ONLY } from "../fixtures.js";

// poll() runs on visibilitychange while the page is visible; it's the only
// hook into the page's IIFE, and saves waiting a minute for the interval.
const poll = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

async function queuedOps(page: Page): Promise<Array<Record<string, any>>> {
  return (await page.request.get("/__ops")).json();
}

async function unlock(page: Page, token = OPS_TOKEN) {
  page.once("dialog", (dialog) => dialog.accept(token));
  await page.locator("#ops-btn").click();
}

async function openAlerts(page: Page) {
  await page.goto("/#/alerts");
  await expect(page.locator("#alerts-table tbody tr").first()).toBeVisible();
}

const storeToken = (page: Page) => page.addInitScript((token) => localStorage.setItem("equity-watch.opsToken", token), OPS_TOKEN);

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  await page.request.get("/__reset");
  errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // The wrong-token test provokes a 401 (and a 404 for the vault) on purpose; the browser logs them as failed loads.
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of 40[14]/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test.describe("locked", () => {
  test("offers Unlock editing and nothing else", async ({ page }) => {
    await openAlerts(page);
    await expect(page.locator("#ops-btn")).toHaveText("Unlock editing");
    await expect(page.locator("#alert-add")).toBeHidden();
    await page.goto(`/#/alert/${STATIC.id}`);
    await expect(page.locator("#drawer-body .kv-list")).toBeVisible();
    await expect(page.locator("#drawer-body form")).toHaveCount(0);
  });

  test("with site.ops off, shows no controls even with a stored token", async ({ page }) => {
    await page.route("**/dashboard.json", async (route) => {
      const response = await route.fetch();
      const doc = await response.json();
      doc.site.ops = false;
      await route.fulfill({ response, json: doc });
    });
    await storeToken(page);
    await openAlerts(page);
    await expect(page.locator("#ops-btn")).toBeHidden();
    await expect(page.locator("#alert-add")).toBeHidden();
  });

  test("a token the endpoint rejects locks again and keeps what was typed", async ({ page }) => {
    // Without a vault to open, a wrong token is only discovered when the POST gets a 401.
    // (holdings.e2e.ts covers the vault catching it first.)
    await page.route("**/vault.json", (route) => route.fulfill({ status: 404, body: "" }));
    await openAlerts(page);
    await unlock(page, "wrong-token");
    await page.locator("#alert-add").getByLabel("Symbol").fill("gmed");
    await page.locator("#alert-add").getByLabel("Level").fill("80.5");
    await page.locator("#alert-add button[type=submit]").click();
    await expect(page.locator("#toasts")).toContainText("token was rejected");
    await expect(page.locator("#ops-btn")).toHaveText("Unlock editing");
    await expect(page.locator("#alert-add")).toBeHidden();
    await unlock(page);
    await expect(page.locator("#alert-add").getByLabel("Symbol")).toHaveValue("gmed");
    expect(await queuedOps(page)).toEqual([]);
  });
});

test.describe("add", () => {
  test("validates on the page, then queues the op", async ({ page }) => {
    await storeToken(page);
    await openAlerts(page);
    const form = page.locator("#alert-add form");
    const symbol = form.getByLabel("Symbol");
    const level = form.getByLabel("Level");
    const volumeKind = form.getByRole("combobox", { name: /^Volume/ });
    const amount = form.getByLabel("Volume at least");
    const submit = form.locator("button[type=submit]");

    await submit.click();
    await expect(form.locator(".form-error")).toHaveText("Enter a symbol.");
    await symbol.fill("gmed");
    await level.fill("0");
    await submit.click();
    await expect(form.locator(".form-error")).toHaveText("Enter a level above 0.");
    await level.fill("80.5");
    // Volume is optional, and off by default: a new alert is a price alert
    // unless one is chosen here.
    await expect(volumeKind).toHaveValue("none");
    await expect(amount).toBeDisabled();
    await volumeKind.selectOption("ratio");
    await amount.fill("0");
    await submit.click();
    await expect(form.locator(".form-error")).toHaveText("Enter a multiple above 0, e.g. 1.5.");
    expect(await queuedOps(page)).toEqual([]);

    await amount.fill("1.5");
    await form.getByLabel("Fires on").selectOption("down");
    await submit.click();

    await expect(page.locator("#ops-pending .pending-row")).toHaveCount(1);
    await expect(page.locator("#toasts")).toContainText("Queued: add GMED crosses down 80.5 with volume ≥ 1.5x normal today");
    await expect(symbol).toHaveValue("");
    await expect(level).toHaveValue("");
    // The volume controls reset with the rest, back to no condition.
    await expect(volumeKind).toHaveValue("none");
    await expect(amount).toHaveValue("");
    const [op] = await queuedOps(page);
    expect(op).toMatchObject({ type: "alert.add", params: { symbol: "GMED", level: 80.5, direction: "down", volumeRatio: 1.5 } });
    expect(op.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // The New alert form takes an absolute share count, not only a ratio, with
  // the same K/M/B shorthand and the same window as the Edit form.
  test("queues a volume condition by share count, with a window", async ({ page }) => {
    await storeToken(page);
    await openAlerts(page);
    const form = page.locator("#alert-add form");
    await form.getByLabel("Symbol").fill("gmed");
    await form.getByLabel("Level").fill("80.5");
    await form.getByRole("combobox", { name: /^Volume/ }).selectOption("shares");
    await form.getByLabel("Volume at least").fill("2.5M");
    await form.getByLabel("Over").selectOption("30m");
    await form.locator("button[type=submit]").click();

    await expect(page.locator("#toasts")).toContainText("Queued: add GMED crosses up 80.5 with volume ≥ 2.5M shares over 30m");
    const [op] = await queuedOps(page);
    expect(op.params).toEqual({ symbol: "GMED", level: 80.5, direction: "up", volumeAtLeast: 2_500_000, volumePeriod: "30m" });
  });

  // The window used to be a free-text spec whose only documentation was a
  // placeholder, so what it accepted was guesswork.
  test("offers the windows as a list, defaulting to today", async ({ page }) => {
    await storeToken(page);
    await openAlerts(page);
    const over = page.locator("#alert-add form").getByLabel("Over");
    await expect(over).toHaveValue("");
    expect(await over.locator("option").allInnerTexts()).toEqual([
      "Today",
      "Last 15 minutes",
      "Last 30 minutes",
      "Last hour",
      "Last 2 hours",
      "Last 4 hours",
      "Last day",
      "Last 2 days",
      "Last 5 days",
      "Last 10 days",
    ]);
    // Nothing above 4 days in sub-day units: those fetch ceil(days)+1 days of
    // minute bars, and Schwab rejects a 6-9 day request.
    for (const value of await over.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))) {
      const match = /^(\d+)([smhd])$/.exec(value);
      if (match && match[2] !== "d") expect(Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2] as "s" | "m" | "h"]).toBeLessThanOrEqual(4 * 86400);
    }
  });

  test("rejects a share count the same way the Edit form does", async ({ page }) => {
    await storeToken(page);
    await openAlerts(page);
    const form = page.locator("#alert-add form");
    await form.getByLabel("Symbol").fill("gmed");
    await form.getByLabel("Level").fill("80.5");
    await form.getByRole("combobox", { name: /^Volume/ }).selectOption("shares");
    await form.getByLabel("Volume at least").fill("2.5x");
    await form.locator("button[type=submit]").click();
    await expect(form.locator(".form-error")).toHaveText("Enter a share count above 0, e.g. 2.5M.");

    expect(await queuedOps(page)).toEqual([]);
  });
});

test.describe("edit", () => {
  test("a static alert sends only what changed, guarded by the condition shown", async ({ page }) => {
    await storeToken(page);
    await page.goto(`/#/alert/${STATIC.id}`);
    const form = page.locator("#drawer-body form");
    const level = form.getByLabel("Level");
    await expect(level).toHaveValue(String(STATIC.level));
    await expect(form.getByLabel("Fires on")).toHaveValue(STATIC.direction);

    await form.locator("button[type=submit]").click();
    await expect(form.locator(".form-error")).toHaveText("Nothing changed.");

    await level.fill("56");
    await form.locator("button[type=submit]").click();
    await expect(page.locator("#drawer-body")).toContainText("edit AA level 55 → 56");
    const [op] = await queuedOps(page);
    expect(op).toMatchObject({
      type: "alert.edit",
      target: { alertId: STATIC.id },
      expect: { condition: "price crosses above 55" },
      params: { level: 56 },
    });
    expect(Object.keys(op.params)).toEqual(["level"]);

    await openAlerts(page);
    await expect(page.locator("#alerts-table tr", { hasText: "AA" }).locator(".tag.pending")).toHaveText("edit pending");
  });

  test("a trailing alert edits its trail", async ({ page }) => {
    await storeToken(page);
    await page.goto(`/#/alert/${TRAILING.id}`);
    const form = page.locator("#drawer-body form");
    await form.getByLabel("Trail by").selectOption("amount");
    await form.getByLabel("Distance").fill("7.5");
    await form.locator("button[type=submit]").click();
    await expect(page.locator("#drawer-body")).toContainText("edit TSLA trail $7.5");
    const [op] = await queuedOps(page);
    expect(op).toMatchObject({
      target: { alertId: TRAILING.id },
      expect: { condition: "trailing 3% off the low (started near 250)" },
      params: { trailAmount: 7.5 },
    });
  });

  // The revisit queue's details panel edits the alert behind the fire, and the
  // same op closes the entry: acting on the trigger is what the queue asks for.
  test("an open trigger's panel edits the alert it fired from and closes the entry", async ({ page }) => {
    await storeToken(page);
    await page.goto("/#/trigger/rv0000a2");
    const form = page.locator("#drawer-body form");
    await expect(form.locator(".form-title")).toHaveText("Edit this alert");
    await expect(form.locator(".note")).toContainText("drops this entry from the revisit queue");
    // The alert's own settings, read from alerts.json rather than the trigger row.
    await expect(form.getByLabel("Level")).toHaveValue(String(STATIC.level));

    await form.getByLabel("Level").fill("61");
    await form.locator("button[type=submit]").click();
    await expect(page.locator("#toasts")).toContainText("edit AA level 55 → 61");
    await expect(page.locator("#toasts")).not.toContainText("queue entry");

    const [op] = await queuedOps(page);
    expect(op).toMatchObject({
      type: "alert.edit",
      target: { alertId: STATIC.id },
      expect: { condition: "price crosses above 55" },
      params: { level: 61 },
    });
    // The entry closes because the alert was edited at all, so the op names no
    // entry - and can't be refused for naming one already closed.
    expect(op.target).not.toHaveProperty("revisitId");

    // The entry stays in the queue until the next check applies the op, so the
    // row has to say the edit is on its way rather than look untouched.
    await page.goto("/#/queue");
    await expect(page.locator("#queue .queue-row", { hasText: "crossed above 55" }).locator(".tag.pending")).toHaveText("edit pending");
  });

  // A closed entry has nothing left to decide, so the panel is read-only.
  test("a trigger that is already resolved offers no edit", async ({ page }) => {
    const resolved = FIXTURE_REVISITS.find((e) => e.status !== "open")!;
    await storeToken(page);
    await page.goto(`/#/trigger/${resolved.id}`);
    await expect(page.locator("#drawer-body .kv-list")).toBeVisible();
    await expect(page.locator("#drawer-body form")).toHaveCount(0);
  });

  test("a locked page shows the trigger panel without the edit form", async ({ page }) => {
    await page.goto("/#/trigger/rv0000a2");
    await expect(page.locator("#drawer-body .kv-list")).toBeVisible();
    await expect(page.locator("#drawer-body form")).toHaveCount(0);
  });

});

/**
 * ADD_KEYS and EDIT_KEYS have always accepted `near`, `trailPercent`, `ma`,
 * `touch` and `from`, and so have the Lambda and the worker. Only these two
 * forms didn't send them, so trailing and moving-average alerts could not be
 * made or changed from the page at all.
 */
test.describe("trailing and moving-average alerts from the page", () => {
  const addForm = (page: Page) => page.locator("#alert-add form");

  test("the kind selector shows only the fields that kind needs", async ({ page }) => {
    await storeToken(page);
    await openAlerts(page);
    const kind = addForm(page).getByLabel("Kind");
    await expect(addForm(page).getByLabel("Level")).toBeVisible();
    await expect(addForm(page).getByLabel("Near")).toBeHidden();

    await kind.selectOption("trailing");
    await expect(addForm(page).getByLabel("Level")).toBeHidden();
    await expect(addForm(page).getByLabel("Near")).toBeVisible();
    await expect(addForm(page).getByLabel("Distance")).toBeVisible();

    await kind.selectOption("ma");
    await expect(addForm(page).getByLabel("Near")).toBeHidden();
    await expect(addForm(page).getByLabel("Period")).toBeVisible();
    // A cross watches a direction; a touch watches the side it came from.
    await expect(addForm(page).getByLabel("Direction")).toBeVisible();
    await expect(addForm(page).getByLabel("Approached")).toBeHidden();
    await addForm(page).getByLabel("Fires when price").selectOption("touch");
    await expect(addForm(page).getByLabel("Direction")).toBeHidden();
    await expect(addForm(page).getByLabel("Approached")).toBeVisible();
  });

  test("adds a trailing alert", async ({ page }) => {
    await storeToken(page);
    await openAlerts(page);
    await addForm(page).getByLabel("Symbol").fill("tsla");
    await addForm(page).getByLabel("Kind").selectOption("trailing");
    await addForm(page).getByLabel("Near").fill("250");
    await addForm(page).getByLabel("Distance").fill("3");
    await addForm(page).locator("button[type=submit]").click();

    const [op] = await queuedOps(page);
    expect(op).toMatchObject({ type: "alert.add", params: { symbol: "TSLA", near: 250, trailPercent: 3 } });
    await expect(page.locator("#ops-pending")).toContainText("add TSLA trailing 3% from 250");
  });

  test("adds a trailing alert in dollars, and can AND a volume condition onto it", async ({ page }) => {
    await storeToken(page);
    await openAlerts(page);
    await addForm(page).getByLabel("Symbol").fill("tsla");
    await addForm(page).getByLabel("Kind").selectOption("trailing");
    await addForm(page).getByLabel("Near").fill("250");
    await addForm(page).getByLabel("Trail by").selectOption("amount");
    await addForm(page).getByLabel("Distance").fill("8");
    await addForm(page).getByLabel("Volume", { exact: true }).selectOption("ratio");
    await addForm(page).getByLabel("Volume at least").fill("1.5");
    await addForm(page).locator("button[type=submit]").click();

    const [op] = await queuedOps(page);
    expect(op).toMatchObject({ type: "alert.add", params: { symbol: "TSLA", near: 250, trailAmount: 8, volumeRatio: 1.5 } });
  });

  test("adds a moving-average cross, sending the spec the worker parses", async ({ page }) => {
    await storeToken(page);
    await openAlerts(page);
    await addForm(page).getByLabel("Symbol").fill("spy");
    await addForm(page).getByLabel("Kind").selectOption("ma");
    await addForm(page).getByLabel("Average").selectOption("ema");
    await addForm(page).getByLabel("Period").fill("9");
    await addForm(page).getByLabel("Bars").selectOption("5m");
    await addForm(page).getByLabel("Direction").selectOption("down");
    await addForm(page).locator("button[type=submit]").click();

    const [op] = await queuedOps(page);
    expect(op).toMatchObject({ type: "alert.add", params: { symbol: "SPY", ma: "ema9@5m", direction: "down" } });
    expect(op.params).not.toHaveProperty("touch");
  });

  test("adds a moving-average touch, which carries a band and a side instead", async ({ page }) => {
    await storeToken(page);
    await openAlerts(page);
    await addForm(page).getByLabel("Symbol").fill("spy");
    await addForm(page).getByLabel("Kind").selectOption("ma");
    await addForm(page).getByLabel("Fires when price").selectOption("touch");
    await addForm(page).getByLabel("Approached").selectOption("above");
    await addForm(page).locator("button[type=submit]").click();

    const [op] = await queuedOps(page);
    expect(op).toMatchObject({ type: "alert.add", params: { symbol: "SPY", ma: "sma200@1D", touch: true, from: "above" } });
    expect(op.params).not.toHaveProperty("direction");
  });

  test("rejects a bad period before anything is queued", async ({ page }) => {
    await storeToken(page);
    await openAlerts(page);
    await addForm(page).getByLabel("Symbol").fill("spy");
    await addForm(page).getByLabel("Kind").selectOption("ma");
    await addForm(page).getByLabel("Period").fill("2.5");
    await addForm(page).locator("button[type=submit]").click();
    await expect(addForm(page).locator(".form-error")).toHaveText("Enter a whole period above 0, e.g. 200.");
    expect(await queuedOps(page)).toEqual([]);
  });

  // The edit form prefills from AlertRow.ma. Without that, opening it to read
  // the spec and saving would rewrite it to whatever the controls defaulted to.
  test("a moving-average alert's edit form is prefilled, and an untouched save changes nothing", async ({ page }) => {
    await storeToken(page);
    await page.goto(`/#/alert/${MOVING_AVERAGE.id}`);
    const form = page.locator("#drawer-body form");
    await expect(form.getByLabel("Average")).toHaveValue("sma");
    await expect(form.getByLabel("Period")).toHaveValue("200");
    await expect(form.getByLabel("Bars")).toHaveValue("1D");
    await expect(form.getByLabel("Fires when price")).toHaveValue("cross");

    await form.locator("button[type=submit]").click();
    await expect(form.locator(".form-error")).toHaveText("Nothing changed.");
    expect(await queuedOps(page)).toEqual([]);
  });

  test("edits a moving average's period, sending only that", async ({ page }) => {
    await storeToken(page);
    await page.goto(`/#/alert/${MOVING_AVERAGE.id}`);
    const form = page.locator("#drawer-body form");
    await form.getByLabel("Period").fill("50");
    await form.locator("button[type=submit]").click();

    const [op] = await queuedOps(page);
    expect(op).toMatchObject({ type: "alert.edit", target: { alertId: MOVING_AVERAGE.id }, params: { ma: "sma50@1D" } });
    expect(op.params).not.toHaveProperty("touch");
    expect(op.params).not.toHaveProperty("from");
    await expect(page.locator("#ops-pending")).toContainText("sma200@1D → sma50@1D");
  });

  test("turning a cross into a touch sends the band and the side together", async ({ page }) => {
    await storeToken(page);
    await page.goto(`/#/alert/${MOVING_AVERAGE.id}`);
    const form = page.locator("#drawer-body form");
    await form.getByLabel("Fires when price").selectOption("touch");
    await expect(form.getByLabel("Touch band %")).toBeVisible();
    await form.getByLabel("Approached").selectOption("below");
    await form.locator("button[type=submit]").click();

    const [op] = await queuedOps(page);
    expect(op.params).toMatchObject({ touch: MOVING_AVERAGE.marginPct, from: "below" });
  });

  test("a moving average has no volume controls, because it can't carry one", async ({ page }) => {
    await storeToken(page);
    await page.goto(`/#/alert/${MOVING_AVERAGE.id}`);
    await expect(page.locator("#drawer-body form").getByLabel("Volume", { exact: true })).toHaveCount(0);
  });
});

// Nothing on a static site knows the checker's schedule, so `ops pull` measures
// its own cadence and the publisher ships it. Without this the page said
// "pending" forever, whether the drain was nine minutes off or overnight.
test.describe("when a pending change lands", () => {
  const queueOne = async (page: Page) => {
    await openAlerts(page);
    const add = page.locator("#alert-add form");
    await add.getByLabel("Symbol").fill("GMED");
    await add.getByLabel("Level").fill("80.5");
    await add.locator("button[type=submit]").click();
    await expect(page.locator("#ops-pending .pending-row")).toHaveCount(1);
  };

  // The scheduler's own next-run time, which already accounts for the daily
  // window: at 18:10 it is tomorrow's 01:55, not 18:25.
  test("shows the scheduled next-check time when the publisher supplied one", async ({ page }) => {
    await storeToken(page);
    await page.request.get("/__cadence?minutesAgo=6&interval=15&nextInMin=9");
    await queueOne(page);
    await expect(page.locator("#ops-pending .note")).toHaveText(/^Applies at the next check, .+ \(in 9 min\)\.$/);
  });

  test("shows a next check hours away rather than counting minutes", async ({ page }) => {
    await storeToken(page);
    // 18:10, window over: the next run is tomorrow morning.
    await page.request.get("/__cadence?minutesAgo=6&interval=15&nextInMin=358");
    await queueOne(page);
    await expect(page.locator("#ops-pending .note")).toContainText("(in 5 hr 58 min)");
  });

  // A quiet run publishes nothing, so this field goes stale while the task is
  // running fine. Stepping it along the cadence is what stops that becoming a
  // false alarm.
  test("steps a passed next-check along the cadence while quiet runs skip publishing", async ({ page }) => {
    await storeToken(page);
    // 2026-09-18: published 11:25 saying 11:40, looked at 12:07 -> 12:10.
    await page.request.get("/__cadence?minutesAgo=42&interval=15&nextInMin=-27&maxStale=30");
    await queueOne(page);
    await expect(page.locator("#ops-pending .note")).toHaveText(/^Applies at the next check, .+ \(in 3 min\)\.$/);
    await expect(page.locator("#ops-pending .note.warn")).toHaveCount(0);
  });

  test("counts down to the next drain", async ({ page }) => {
    await storeToken(page);
    await page.request.get("/__cadence?minutesAgo=6&interval=15");
    await queueOne(page);
    await expect(page.locator("#ops-pending .note")).toHaveText(/^Applies at the next check, .+ \(in 9 min\)\.$/);
    await expect(page.locator("#ops-pending .note.warn")).toHaveCount(0);
  });

  test("says due now while a drain is merely late", async ({ page }) => {
    await storeToken(page);
    await page.request.get("/__cadence?minutesAgo=17&interval=15");
    await queueOne(page);
    await expect(page.locator("#ops-pending .note")).toHaveText("Applies at the next check, due now.");
    await expect(page.locator("#ops-pending .note.warn")).toHaveCount(0);
  });

  // The situation that prompted this: the scheduled task's daily window had
  // ended, and nine ops sat in the queue with the page saying only "pending".
  test("warns once no drain has happened for well past the cadence", async ({ page }) => {
    await storeToken(page);
    await page.request.get("/__cadence?minutesAgo=106&interval=15");
    await queueOne(page);
    const note = page.locator("#ops-pending .note.warn");
    await expect(note).toContainText("No check since");
    await expect(note).toContainText("they run about every 15 min");
    await expect(note).toContainText("may be outside its daily window or stopped");
  });

  test("falls back to the watermark alone when the cadence isn't known yet", async ({ page }) => {
    await storeToken(page);
    await page.request.get("/__cadence?minutesAgo=6&interval=none");
    await queueOne(page);
    await expect(page.locator("#ops-pending .note")).toHaveText("Applied by the next scheduled check. Last check 6 min ago.");
  });

  // The queue's details panel is where a revisit edit is made, so it answers
  // the same question without a trip to the pending list.
  test("the drawer's pending note carries it too", async ({ page }) => {
    await storeToken(page);
    await page.request.get("/__cadence?minutesAgo=6&interval=15");
    await page.goto("/#/trigger/rv0000a2");
    const form = page.locator("#drawer-body form");
    await form.getByLabel("Level").fill("61");
    await form.locator("button[type=submit]").click();
    await expect(page.locator("#drawer-body .tag.pending")).toHaveCount(1);
    await expect(page.locator("#drawer-body .note", { hasText: "Applies at" })).toHaveText(/^Applies at the next check, .+ \(in 9 min\)\.$/);
  });
});

// The header answers "when does this refresh?" whether or not anything is
// queued. It only appeared on a pending change at first, so a drained queue
// left the page showing nothing but "Updated 14 min ago".
test.describe("the header's next check", () => {
  const updated = (page: Page) => page.locator("#updated");

  test("names the scheduled time with nothing pending at all", async ({ page }) => {
    await page.request.get("/__cadence?minutesAgo=6&interval=15&nextInMin=9");
    await page.goto("/#/");
    await expect(updated(page)).toContainText("next check");
    await expect(updated(page)).not.toHaveClass(/stale/);
    expect(await page.evaluate(() => localStorage.getItem("equity-watch.pendingOps"))).toBeNull();
  });

  test("falls back to the measured cadence", async ({ page }) => {
    await page.request.get("/__cadence?minutesAgo=6&interval=15");
    await page.goto("/#/");
    await expect(updated(page)).toContainText("next check");
    await expect(updated(page)).not.toHaveClass(/stale/);
  });

  // What prompted the skip-window allowance: 42 minutes with no publish is a
  // healthy task that had nothing new, not a stopped one.
  test("does not call a quiet stretch inside the publisher's skip window stopped", async ({ page }) => {
    await page.request.get("/__cadence?minutesAgo=42&interval=15&nextInMin=-27&maxStale=30");
    await page.goto("/#/");
    await expect(updated(page)).toContainText("next check");
    await expect(updated(page)).not.toContainText("no check since");
    await expect(updated(page)).not.toHaveClass(/stale/);
  });

  test("still calls it stopped past the skip window", async ({ page }) => {
    await page.request.get("/__cadence?minutesAgo=65&interval=15&nextInMin=-50&maxStale=30");
    await page.goto("/#/");
    await expect(updated(page)).toContainText("no check since");
    await expect(updated(page)).toHaveClass(/stale/);
  });

  test("marks the header when no check has run for well past the cadence", async ({ page }) => {
    await page.request.get("/__cadence?minutesAgo=106&interval=15");
    await page.goto("/#/");
    await expect(updated(page)).toContainText("no check since");
    await expect(updated(page)).toHaveClass(/stale/);
  });

  test("says only the age when nothing published a schedule", async ({ page }) => {
    await page.request.get("/__cadence?minutesAgo=6&interval=none");
    await page.goto("/#/");
    // The fixture builds its document per request, so the age is always "just now".
    await expect(updated(page)).toHaveText("Updated just now");
  });
});

test.describe("results", () => {
  test("pending ops survive a reload and resolve from opResults", async ({ page }) => {
    await storeToken(page);
    await openAlerts(page);
    const add = page.locator("#alert-add form");
    await add.getByLabel("Symbol").fill("GMED");
    await add.getByLabel("Level").fill("80.5");
    await add.locator("button[type=submit]").click();
    await expect(page.locator("#ops-pending .pending-row")).toHaveCount(1);

    await page.goto(`/#/alert/${STATIC.id}`);
    const edit = page.locator("#drawer-body form");
    await edit.getByLabel("Level").fill("56");
    await edit.locator("button[type=submit]").click();
    await expect(page.locator("#drawer-body .tag.pending")).toHaveCount(1);

    await page.goto("/#/alerts");
    await page.reload();
    await expect(page.locator("#ops-btn")).toHaveText("Lock editing");
    await expect(page.locator("#ops-pending .pending-row")).toHaveCount(2);

    await page.request.get("/__release");
    await poll(page);
    await expect(page.locator("#ops-pending")).toBeHidden();
    await expect(page.locator("#toasts .toast.ok")).toContainText("Added static alert added001");
    await expect(page.locator("#toasts .toast.bad")).toContainText("edit AA level 55 → 56 rejected: Not edited: the alert changed");
    await expect(page.locator("#alerts-table .tag.pending")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("equity-watch.pendingOps"))).toBe("[]");
  });

  // A burst bigger than the published result list: the watermark is what clears these.
  test("a pending op whose result was never published retires at the watermark", async ({ page }) => {
    await storeToken(page);
    await openAlerts(page);
    const add = page.locator("#alert-add form");
    await add.getByLabel("Symbol").fill("GMED");
    await add.getByLabel("Level").fill("80.5");
    await add.locator("button[type=submit]").click();
    await expect(page.locator("#ops-pending .pending-row")).toHaveCount(1);

    await page.request.get("/__release?results=none");
    await poll(page);
    await expect(page.locator("#ops-pending")).toBeHidden();
    await expect(page.locator("#toasts")).toContainText("applied. Its result is no longer published.");
    expect(await page.evaluate(() => localStorage.getItem("equity-watch.pendingOps"))).toBe("[]");
  });

  test("Forget drops a pending op without a result", async ({ page }) => {
    await storeToken(page);
    await openAlerts(page);
    const add = page.locator("#alert-add form");
    await add.getByLabel("Symbol").fill("GMED");
    await add.getByLabel("Level").fill("80.5");
    await add.locator("button[type=submit]").click();
    await page.locator("#ops-pending button", { hasText: "Forget" }).click();
    await expect(page.locator("#ops-pending")).toBeHidden();
  });

  test("Lock forgets the token", async ({ page }) => {
    await storeToken(page);
    await openAlerts(page);
    // The init script re-seeds the token on every navigation, so check storage without reloading.
    await page.locator("#ops-btn").click();
    await expect(page.locator("#ops-btn")).toHaveText("Unlock editing");
    await expect(page.locator("#alert-add")).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("equity-watch.opsToken"))).toBeNull();
  });
});

test.describe("phone width", () => {
  test.use({ viewport: { width: 400, height: 860 }, isMobile: true, hasTouch: true });

  test("the forms fit without horizontal page scroll", async ({ page }) => {
    await storeToken(page);
    await openAlerts(page);
    await expect(page.locator("#alert-add form")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.goto(`/#/alert/${STATIC.id}`);
    await expect(page.locator("#drawer-body form")).toBeVisible();
    // The drawer slides in from the right; measure where it comes to rest.
    await page.locator("#drawer").evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    const box = await page.locator("#drawer-body form").boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(400);
  });
});

// The queue row's Dismiss takes that one fire off the queue. It lives on the
// row, not the trigger panel, so what it removes is the thing it sits on.
test.describe("dismissing from the revisit queue", () => {
  const aaRow = (page: Page) => page.locator("#queue .queue-row", { hasText: "crossed above 55" });

  test("is not offered while locked", async ({ page }) => {
    await page.goto("/#/queue");
    await expect(aaRow(page)).toBeVisible();
    await expect(aaRow(page).getByRole("button", { name: "Dismiss" })).toHaveCount(0);
  });

  test("takes a second click, queues a dismiss of that entry, and marks the row pending", async ({ page }) => {
    await storeToken(page);
    await page.goto("/#/queue");
    const button = aaRow(page).getByRole("button", { name: "Dismiss" });
    await expect(button).toHaveAttribute("title", /alert is not changed/);
    await button.click();
    expect(await queuedOps(page)).toEqual([]);
    await aaRow(page).getByRole("button", { name: "Click again to confirm" }).click();

    await expect(aaRow(page).locator(".tag.pending")).toHaveText("dismiss pending");
    await expect(aaRow(page).getByRole("button", { name: "Dismiss" })).toHaveCount(0);
    const [op] = await queuedOps(page);
    expect(op).toMatchObject({ type: "revisit.dismiss", target: { revisitId: "rv0000a2", alertId: STATIC.id }, params: {} });

    // The alert itself isn't being edited, so it must not say so.
    await openAlerts(page);
    await expect(page.locator("#alerts-table .tag.pending")).toHaveCount(0);
    await expect(page.locator("#alerts-table")).toContainText("price crosses above 55");
    await expect(page.locator("#ops-pending")).toContainText(/AA: dismiss the .+ fire at 55 from the queue/);
  });

  test("resolves from the published result", async ({ page }) => {
    await storeToken(page);
    await page.goto("/#/queue");
    await aaRow(page).getByRole("button", { name: "Dismiss" }).click();
    await aaRow(page).getByRole("button", { name: "Click again to confirm" }).click();
    await expect(aaRow(page).locator(".tag.pending")).toHaveText("dismiss pending");
    await page.request.get("/__release");
    await poll(page);
    await expect(page.locator("#toasts")).toContainText("Dismissed revisit rv0000a2");
    await expect(aaRow(page).locator(".tag.pending")).toHaveCount(0);
  });
});

/**
 * Suggest → Apply, the pair that replaced a copy-a-CLI-command button.
 *
 * Until these ops existed the page could not re-level an alert at all, so the
 * queue - the whole point of which is to collect this decision - could only
 * hand you the command to run yourself.
 */
test.describe("suggesting and applying a level from the revisit queue", () => {
  // rv0000a2: open, suggested 61, on STATIC (currently at 55).
  const aaRow = (page: Page) => page.locator("#queue .queue-row", { hasText: "crossed above 55" });
  // rv0000m1: open, but a downward fire, so it carries no suggestion.
  const msftRow = (page: Page) => page.locator("#queue .queue-row", { hasText: "MSFT" });

  test("offers neither while locked, and no longer offers a command to copy", async ({ page }) => {
    await page.goto("/#/queue");
    await expect(aaRow(page)).toBeVisible();
    await expect(aaRow(page).getByRole("button")).toHaveCount(0);
    await expect(page.locator("#queue")).not.toContainText("Copy");
    await expect(page.locator("#queue")).not.toContainText("dist/cli.js");
  });

  // "61" is a number; "61, off the 60d high" is a decision. The level itself
  // is already on the row twice (the action line and the Apply button), so the
  // basis line must not make it a third.
  test("says what the suggestion was read off, without repeating the number", async ({ page }) => {
    await page.goto("/#/queue");
    await expect(aaRow(page)).toContainText("Basis: the trigger price plus its recent range.");
    expect((await aaRow(page).textContent())!.match(/\b61\b/g)).toHaveLength(1);
  });

  test("says why there is no suggestion when a fire cannot have one", async ({ page }) => {
    await page.goto("/#/queue");
    // rv0000m1 has no basis recorded at all, so there is nothing to explain.
    await expect(msftRow(page)).not.toContainText("Basis:");
  });

  test("queues a re-level of just that entry, and marks the row pending", async ({ page }) => {
    await storeToken(page);
    await page.goto("/#/queue");
    const button = aaRow(page).getByRole("button", { name: "Re-suggest" });
    await expect(button).toHaveAttribute("title", /Nothing is changed/);
    await button.click();

    const [op] = await queuedOps(page);
    expect(op).toMatchObject({ type: "revisit.relevel", target: { revisitId: "rv0000a2" }, params: {} });
    await expect(aaRow(page).locator(".tag.pending")).toHaveText("suggestion pending");
    // While one change to this entry is waiting, no second one is offered.
    await expect(aaRow(page).getByRole("button")).toHaveCount(0);

    // A re-level proposes; it does not change the alert, so the alert must not
    // read as pending the way an edit does.
    await openAlerts(page);
    await expect(page.locator("#alerts-table .tag.pending")).toHaveCount(0);
  });

  test("an entry with no suggestion offers Suggest but no Apply, and says why not", async ({ page }) => {
    await storeToken(page);
    await page.goto("/#/queue");
    await expect(msftRow(page).getByRole("button", { name: "Suggest level" })).toBeVisible();
    await expect(msftRow(page).getByRole("button", { name: /^Apply/ })).toHaveCount(0);
  });

  // expect carries the suggestion as well as the condition: the condition
  // alone would catch the alert moving but not the suggestion moving.
  test("applies the suggested level, guarded on both the suggestion and the condition", async ({ page }) => {
    await storeToken(page);
    await page.goto("/#/queue");
    const button = aaRow(page).getByRole("button", { name: "Apply → 61" });
    await expect(button).toHaveAttribute("title", /keeps watching at the new level/);
    await button.click();
    expect(await queuedOps(page)).toEqual([]);
    await aaRow(page).getByRole("button", { name: "Click again to confirm" }).click();

    const [op] = await queuedOps(page);
    expect(op).toMatchObject({
      type: "revisit.apply",
      target: { revisitId: "rv0000a2", alertId: STATIC.id },
      expect: { suggestedLevel: 61, condition: "price crosses above 55" },
      params: {},
    });
    await expect(page.locator("#ops-pending")).toContainText("AA: move the alert from 55 to 61");

    // Re-levelling IS a change to the alert, unlike a dismiss or a re-level.
    await openAlerts(page);
    await expect(page.locator("#alerts-table .tag.pending")).toHaveText("apply pending");
  });

  test("resolves from the published result", async ({ page }) => {
    await storeToken(page);
    await page.goto("/#/queue");
    await aaRow(page).getByRole("button", { name: "Apply → 61" }).click();
    await aaRow(page).getByRole("button", { name: "Click again to confirm" }).click();
    await page.request.get("/__release");
    await poll(page);
    await expect(aaRow(page).locator(".tag.pending")).toHaveCount(0);
  });

  // Dismiss belongs on the queue row, where what it removes is the row you are
  // looking at. The drawer gets the two that change the alert's future.
  test("the trigger drawer offers Suggest and Apply but not Dismiss", async ({ page }) => {
    await storeToken(page);
    await page.goto("/#/trigger/rv0000a2");
    const actions = page.locator("#drawer-body .actions").first();
    await expect(actions.getByRole("button", { name: "Re-suggest" })).toBeVisible();
    await expect(actions.getByRole("button", { name: "Apply → 61" })).toBeVisible();
    await expect(actions.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
  });

  // A closed trigger's decision was already made.
  test("a closed trigger offers neither", async ({ page }) => {
    await storeToken(page);
    await page.goto("/#/trigger/rv0000a1");
    const actions = page.locator("#drawer-body .actions").first();
    await expect(actions.getByRole("button", { name: /Suggest|Apply/ })).toHaveCount(0);
  });
});

// The alert panel's Remove replaced a "Copy remove" button that copied the CLI command.
test.describe("removing an alert from its panel", () => {
  const actions = (page: Page) => page.locator("#drawer-body .actions");

  test("offers nothing to copy, and no Remove while locked", async ({ page }) => {
    await page.goto(`/#/alert/${STATIC.id}`);
    await expect(actions(page).getByRole("link", { name: "Chart" })).toBeVisible();
    await expect(actions(page).getByRole("button")).toHaveCount(0);
  });

  test("takes a second click, queues a guarded remove, and marks the alert pending", async ({ page }) => {
    await storeToken(page);
    await page.goto(`/#/alert/${STATIC.id}`);
    await actions(page).getByRole("button", { name: "Remove" }).click();
    expect(await queuedOps(page)).toEqual([]);
    await actions(page).getByRole("button", { name: "Click again to confirm" }).click();

    await expect(actions(page).getByRole("button", { name: "Remove" })).toHaveCount(0);
    const [op] = await queuedOps(page);
    expect(op).toMatchObject({ type: "alert.remove", target: { alertId: STATIC.id }, expect: { condition: "price crosses above 55" }, params: {} });

    await openAlerts(page);
    await expect(page.locator("#alerts-table .tag.pending")).toHaveText("remove pending");
  });
});

// One form for price and volume whatever the alert is now: volume can be added
// to a price alert, and a level to a volume alert.
test.describe("price and volume in one edit form", () => {
  test("a price alert gains a volume condition", async ({ page }) => {
    await storeToken(page);
    await page.goto(`/#/alert/${STATIC.id}`);
    const form = page.locator("#drawer-body form");
    await expect(form.getByRole("combobox", { name: /^Volume/ })).toHaveValue("none");
    await form.getByRole("combobox", { name: /^Volume/ }).selectOption("ratio");
    await form.getByLabel("Volume at least").fill("1.5");
    await form.getByLabel("Over").selectOption("2h");
    await form.locator("button[type=submit]").click();
    await expect(page.locator("#drawer-body")).toContainText("edit AA volume ≥ 1.5x normal over 2h");
    const [op] = await queuedOps(page);
    expect(op.params).toEqual({ volumeRatio: 1.5, volumePeriod: "2h" });
  });

  test("a volume alert shows its volume and gains a level, stating its direction", async ({ page }) => {
    await storeToken(page);
    await page.goto(`/#/alert/${VOLUME_ONLY.id}`);
    const form = page.locator("#drawer-body form");
    await expect(form.getByLabel("Level")).toHaveValue("");
    await expect(form.getByRole("combobox", { name: /^Volume/ })).toHaveValue("shares");
    await expect(form.getByLabel("Volume at least")).toHaveValue("5M");
    await expect(form.getByLabel("Over")).toHaveValue("30m");

    await form.locator("button[type=submit]").click();
    await expect(form.locator(".form-error")).toHaveText("Nothing changed.");

    await form.getByLabel("Level").fill("200");
    await form.locator("button[type=submit]").click();
    await expect(page.locator("#drawer-body")).toContainText("edit NVDA add level 200, crosses up");
    const [op] = await queuedOps(page);
    expect(op).toMatchObject({ type: "alert.edit", target: { alertId: VOLUME_ONLY.id }, params: { level: 200, direction: "up" } });
    expect(Object.keys(op.params).sort()).toEqual(["direction", "level"]);
  });

  // The whole point of the shorthand: seven digits are unreadable and easy to
  // mistype by a factor of ten.
  test("a share threshold is typed and shown as K/M", async ({ page }) => {
    await storeToken(page);
    await page.goto(`/#/alert/${VOLUME_ONLY.id}`);
    const form = page.locator("#drawer-body form");
    await form.getByLabel("Volume at least").fill("2.5M");
    await form.locator("button[type=submit]").click();
    await expect(page.locator("#drawer-body")).toContainText("edit NVDA volume ≥ 2.5M shares over 30m");
    const [op] = await queuedOps(page);
    expect(op.params).toEqual({ volumeAtLeast: 2_500_000, volumePeriod: "30m" });
  });

  // A window set from the CLI need not be one the list offers. Opening the
  // form must not quietly re-level it to Today.
  test("keeps a window the list doesn't offer, rather than snapping it", async ({ page }) => {
    await storeToken(page);
    await page.route("**/alerts.json", async (route) => {
      const response = await route.fetch();
      const doc = await response.json();
      const row = doc.alerts.find((a: any) => a.id === VOLUME_ONLY.id);
      row.volume = { threshold: 5_000_000, mode: "period", periodValue: 45, periodUnit: "s" };
      await route.fulfill({ response, json: doc });
    });
    await page.goto(`/#/alert/${VOLUME_ONLY.id}`);
    const form = page.locator("#drawer-body form");
    await expect(form.getByLabel("Over")).toHaveValue("45s");
    await expect(form.getByLabel("Over").locator("option[value='45s']")).toHaveText("Last 45s");
    // Submitting it untouched is still "nothing changed", not a window edit.
    await form.locator("button[type=submit]").click();
    await expect(form.locator(".form-error")).toHaveText("Nothing changed.");
    expect(await queuedOps(page)).toEqual([]);
  });

  test("a ratio takes no suffix, and each mode says what it wants", async ({ page }) => {
    await storeToken(page);
    await page.goto(`/#/alert/${VOLUME_ONLY.id}`);
    const form = page.locator("#drawer-body form");
    await form.getByLabel("Volume at least").fill("2.5x");
    await form.locator("button[type=submit]").click();
    await expect(form.locator(".form-error")).toHaveText("Enter a share count above 0, e.g. 2.5M.");

    await form.getByRole("combobox", { name: /^Volume/ }).selectOption("ratio");
    await form.getByLabel("Volume at least").fill("1.5M");
    await form.locator("button[type=submit]").click();
    await expect(form.locator(".form-error")).toHaveText("Enter a multiple above 0, e.g. 1.5.");
    expect(await queuedOps(page)).toEqual([]);
  });

  test("emptying a price alert's level leaves a volume alert, and emptying both is refused", async ({ page }) => {
    await storeToken(page);
    await page.goto(`/#/alert/${STATIC_WITH_VOLUME.id}`);
    const form = page.locator("#drawer-body form");
    await form.getByLabel("Level").fill("");
    await form.getByRole("combobox", { name: /^Volume/ }).selectOption("none");
    await form.locator("button[type=submit]").click();
    await expect(form.locator(".form-error")).toHaveText("Set a level, a volume condition, or both.");
    expect(await queuedOps(page)).toEqual([]);

    await form.getByRole("combobox", { name: /^Volume/ }).selectOption("ratio");
    await form.locator("button[type=submit]").click();
    await expect(page.locator("#drawer-body")).toContainText("edit MSFT drop level 400");
    const [op] = await queuedOps(page);
    expect(op.params).toEqual({ clearLevel: true });
  });
});

// An A-Z rail down the left of the alerts table. The fixture symbols are AA,
// MSFT, NVDA, SPY and TSLA, so A/M/N/S/T are live and everything else is dead.
test.describe("the alphabet rail", () => {
  const rail = (page: Page) => page.locator("#alerts-index");

  test("offers every letter, with the ones nothing starts with disabled", async ({ page }) => {
    await openAlerts(page);
    await expect(rail(page)).toBeVisible();
    // "#" for the digit and $^ prefixes a symbol may start with, then A-Z.
    await expect(rail(page).locator("button")).toHaveCount(27);
    await expect(rail(page).getByRole("button", { name: "A", exact: true })).toBeEnabled();
    await expect(rail(page).getByRole("button", { name: "M", exact: true })).toBeEnabled();
    await expect(rail(page).getByRole("button", { name: "B", exact: true })).toBeDisabled();
    await expect(rail(page).getByRole("button", { name: "#", exact: true })).toBeDisabled();
  });

  test("a letter scrolls its first symbol into view and marks it", async ({ page }) => {
    await openAlerts(page);
    await rail(page).getByRole("button", { name: "M", exact: true }).click();
    const marked = page.locator("#alerts-table tbody tr.jumped");
    await expect(marked).toHaveCount(1);
    await expect(marked).toContainText("MSFT");
    await expect(marked).toBeInViewport();
  });

  test("a search that narrows the table leaves the rail's shape, disabling what went", async ({ page }) => {
    await openAlerts(page);
    await page.locator("#alerts-search").fill("MSFT");
    await expect(rail(page).locator("button")).toHaveCount(27);
    await expect(rail(page).getByRole("button", { name: "M", exact: true })).toBeEnabled();
    await expect(rail(page).getByRole("button", { name: "A", exact: true })).toBeDisabled();
  });

  test("hides under a sort that isn't alphabetical, because a letter would land anywhere", async ({ page }) => {
    await openAlerts(page);
    await page.locator("#alerts-sort").selectOption("closest");
    await expect(rail(page)).toBeHidden();
    await page.locator("#alerts-sort").selectOption("symbol");
    await expect(rail(page)).toBeVisible();
  });

  test("groups into ranges when the window is too short for 27 tabs", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 360 });
    await openAlerts(page);
    const buttons = rail(page).locator("button");
    const count = await buttons.count();
    expect(count).toBeGreaterThanOrEqual(4);
    expect(count).toBeLessThan(27);
    // Ranges are consecutive and cover the whole alphabet, first to last.
    const labels = await buttons.allInnerTexts();
    expect(labels[0].startsWith("#")).toBe(true);
    expect(labels[labels.length - 1].endsWith("Z")).toBe(true);
    // A range still jumps: A–? covers AA.
    await buttons.first().click();
    await expect(page.locator("#alerts-table tbody tr.jumped")).toContainText("AA");
  });
});
