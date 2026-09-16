import { expect, test, type Page } from "@playwright/test";
import { MOVING_AVERAGE, OPS_TOKEN, STATIC, TRAILING } from "../fixtures.js";

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

  test("a moving-average alert points to the CLI", async ({ page }) => {
    await storeToken(page);
    await page.goto(`/#/alert/${MOVING_AVERAGE.id}`);
    await expect(page.locator("#drawer-body")).toContainText("can't be edited from the page yet");
    await expect(page.locator("#drawer-body form")).toHaveCount(0);
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
