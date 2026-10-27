import { expect, test } from "@playwright/test";
import { OPS_TOKEN } from "../fixtures.js";
import { unlockWith } from "../unlock.js";

// A stop sale puts its symbol in the revisit queue (src/alerts/stopOuts.ts).
// The published row says only that it stopped out: the sale price, with the
// time, would give the stop away. The numbers come from the vault, unlocked.

test.beforeEach(async ({ request }) => {
  await request.get("/__reset");
  await request.get("/__stopout");
});
test.afterEach(async ({ request }) => {
  await request.get("/__reset");
});

const row = (page: import("@playwright/test").Page) => page.locator("#stopouts .queue-row", { hasText: "Stopped out of MSFT" });

test("a stop-out has its own section above the queue, and none without one", async ({ page, request }) => {
  await page.goto("/#/queue");
  await expect(page.locator("#stopouts-section")).toBeVisible();
  await expect(page.locator("#stopouts-count")).toHaveText("1");
  await expect(row(page)).toBeVisible();
  await expect(page.locator("#queue .queue-row", { hasText: "Stopped out" })).toHaveCount(0);
  const above = await page.evaluate(
    () => document.getElementById("stopouts-section")!.compareDocumentPosition(document.getElementById("queue")!) & Node.DOCUMENT_POSITION_FOLLOWING
  );
  expect(above).toBeTruthy();

  await request.get("/__stopout?on=false");
  await page.reload();
  await expect(page.locator("#queue .queue-row").first()).toBeVisible();
  await expect(page.locator("#stopouts-section")).toBeHidden();
});

test("the overview's button leads to them, and is gone when there are none", async ({ page, request }) => {
  await page.goto("/");
  const button = page.locator("#stopouts-button");
  await expect(button).toHaveText("1 stop to review");
  await button.click();
  await expect(page).toHaveURL(/#\/queue$/);
  await expect(row(page)).toBeVisible();

  await request.get("/__stopout?on=false");
  await page.goto("/");
  await expect(page.locator("#tiles .tile").first()).toBeVisible();
  await expect(button).toBeHidden();
});

test("a stop-out row and the strip carry no price on the public page", async ({ page }) => {
  await page.goto("/#/queue");
  await expect(row(page).locator(".tag.reason.stopped")).toHaveText("stopped out");
  await expect(row(page)).toContainText("Update or remove its alerts");
  await expect(row(page)).not.toContainText("401");
  await expect(page.locator("#tape li", { hasText: "MSFT" }).first()).toContainText("stopped");

  const dashboard = await (await page.request.get("/dashboard.json")).text();
  expect(dashboard).not.toContain("401.25");
  expect(dashboard).not.toContain("401.5");
});

test("unlocked, the row and its drawer show the sale from the vault", async ({ page }) => {
  await page.goto("/#/queue");
  await unlockWith(page, OPS_TOKEN);
  await expect(row(page)).toContainText("Sold 4 @ 401.25 on 2026-10-27 · stop 401.50 · down 2.1% on cost");
  await row(page).locator(".headline a.plain").click();
  await expect(page.locator(`#drawer-body dl.kv-list dt:text-is("Sale") + dd`)).toContainText("Sold 4 @ 401.25");
  await expect(page.locator(`#drawer-body dl.kv-list dt:text-is("Price at trigger")`)).toHaveCount(0);
});
