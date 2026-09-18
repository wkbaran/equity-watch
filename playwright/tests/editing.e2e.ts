import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_REVISITS, MOVING_AVERAGE, OPS_TOKEN, STATIC, TRAILING } from "../fixtures.js";

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
    await page.locator("#alert-add input[type=text]").fill("gmed");
    await page.locator("#alert-add input[type=number]").first().fill("80.5");
    await page.locator("#alert-add button[type=submit]").click();
    await expect(page.locator("#toasts")).toContainText("token was rejected");
    await expect(page.locator("#ops-btn")).toHaveText("Unlock editing");
    await expect(page.locator("#alert-add")).toBeHidden();
    await unlock(page);
    await expect(page.locator("#alert-add input[type=text]")).toHaveValue("gmed");
    expect(await queuedOps(page)).toEqual([]);
  });
});

test.describe("add", () => {
  test("validates on the page, then queues the op", async ({ page }) => {
    await storeToken(page);
    await openAlerts(page);
    const form = page.locator("#alert-add form");
    const symbol = form.locator("input[type=text]");
    const level = form.locator("input[type=number]").nth(0);
    const ratio = form.locator("input[type=number]").nth(1);
    const submit = form.locator("button[type=submit]");

    await submit.click();
    await expect(form.locator(".form-error")).toHaveText("Enter a symbol.");
    await symbol.fill("gmed");
    await level.fill("0");
    await submit.click();
    await expect(form.locator(".form-error")).toHaveText("Enter a level above 0.");
    await level.fill("80.5");
    // 0, not a negative: min="0" makes the browser block a negative before the page's own check runs.
    await ratio.fill("0");
    await submit.click();
    await expect(form.locator(".form-error")).toHaveText("Volume ratio must be above 0, or empty.");
    expect(await queuedOps(page)).toEqual([]);

    await ratio.fill("1.5");
    await form.locator("select").selectOption("down");
    await submit.click();

    await expect(page.locator("#ops-pending .pending-row")).toHaveCount(1);
    await expect(page.locator("#toasts")).toContainText("Queued: add GMED crosses down 80.5 with volume ≥ 1.5x normal today");
    await expect(symbol).toHaveValue("");
    await expect(level).toHaveValue("");
    const [op] = await queuedOps(page);
    expect(op).toMatchObject({ type: "alert.add", params: { symbol: "GMED", level: 80.5, direction: "down", volumeRatio: 1.5 } });
    expect(op.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

test.describe("edit", () => {
  test("a static alert sends only what changed, guarded by the condition shown", async ({ page }) => {
    await storeToken(page);
    await page.goto(`/#/alert/${STATIC.id}`);
    const form = page.locator("#drawer-body form");
    const level = form.locator("input[type=number]");
    await expect(level).toHaveValue(String(STATIC.level));
    await expect(form.locator("select")).toHaveValue(STATIC.direction);

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
    await form.locator("select").selectOption("amount");
    await form.locator("input[type=number]").fill("7.5");
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
    await expect(form.locator("input[type=number]")).toHaveValue(String(STATIC.level));

    await form.locator("input[type=number]").fill("61");
    await form.locator("button[type=submit]").click();
    await expect(page.locator("#toasts")).toContainText("edit AA level 55 → 61 and close its queue entry");

    const [op] = await queuedOps(page);
    expect(op).toMatchObject({
      type: "alert.edit",
      target: { alertId: STATIC.id, revisitId: "rv0000a2" },
      expect: { condition: "price crosses above 55" },
      params: { level: 61 },
    });

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

  test("a moving-average alert points to the CLI", async ({ page }) => {
    await storeToken(page);
    await page.goto(`/#/alert/${MOVING_AVERAGE.id}`);
    await expect(page.locator("#drawer-body")).toContainText("can't be edited from the page yet");
    await expect(page.locator("#drawer-body form")).toHaveCount(0);
  });
});

// Nothing on a static site knows the checker's schedule, so `ops pull` measures
// its own cadence and the publisher ships it. Without this the page said
// "pending" forever, whether the drain was nine minutes off or overnight.
test.describe("when a pending change lands", () => {
  const queueOne = async (page: Page) => {
    await openAlerts(page);
    const add = page.locator("#alert-add form");
    await add.locator("input[type=text]").fill("GMED");
    await add.locator("input[type=number]").first().fill("80.5");
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
    await form.locator("input[type=number]").fill("61");
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
    await add.locator("input[type=text]").fill("GMED");
    await add.locator("input[type=number]").first().fill("80.5");
    await add.locator("button[type=submit]").click();
    await expect(page.locator("#ops-pending .pending-row")).toHaveCount(1);

    await page.goto(`/#/alert/${STATIC.id}`);
    const edit = page.locator("#drawer-body form");
    await edit.locator("input[type=number]").fill("56");
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
    await add.locator("input[type=text]").fill("GMED");
    await add.locator("input[type=number]").first().fill("80.5");
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
    await add.locator("input[type=text]").fill("GMED");
    await add.locator("input[type=number]").first().fill("80.5");
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
