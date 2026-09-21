import { expect, test, type Page } from "@playwright/test";
import { OPS_TOKEN, STATIC } from "../fixtures.js";

/**
 * The expired-Schwab-login banner.
 *
 * Schwab refresh tokens last 7 days and only a browser sign-in on the machine
 * renews one, so this happens about weekly. Until it is fixed nothing is
 * checked and queued changes cannot apply, and the symptom without a banner is
 * a document that quietly stops changing - indistinguishable from a quiet
 * market. These specs pin the two halves of that: the banner says it, and the
 * schedule text stops promising checks that will not happen.
 */

const banner = (page: Page) => page.locator("#auth-banner");
const updated = (page: Page) => page.locator("#updated");

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  await page.request.get("/__reset");
  errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("stays out of the way while the login is healthy", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#triggers .trigger-row").first()).toBeVisible();
  await expect(banner(page)).toBeHidden();
  await expect(updated(page)).not.toHaveClass(/stale/);
});

test("says the login expired, how long ago, and what to run", async ({ page }) => {
  await page.request.get("/__auth?expiredMinAgo=125");
  await page.goto("/");
  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toContainText("Schwab login expired");
  await expect(banner(page)).toContainText("2 hr ago");
  // The fix is a command on another machine, not a button here: nothing can
  // push to it (see the header of src/ops/pull.ts).
  await expect(banner(page)).toContainText("schwab-login");
  await expect(banner(page)).not.toContainText("button");
});

test("stops promising a next check that would check nothing", async ({ page }) => {
  // A next-run time 5 minutes out: the task really is about to run, and with a
  // healthy login the header would count down to it. It must not, because the
  // run will fetch no quotes and evaluate nothing.
  await page.request.get("/__cadence?minutesAgo=6&interval=15&nextInMin=5");
  await page.goto("/");
  await expect(updated(page)).toContainText("next check");

  await page.request.get("/__auth?expiredMinAgo=40");
  await page.reload();
  await expect(updated(page)).toContainText("checks paused, login expired");
  await expect(updated(page)).not.toContainText("next check");
  await expect(updated(page)).toHaveClass(/stale/);
});

test("tells a queued change it is waiting on the login, not on the clock", async ({ page }) => {
  await page.context().addInitScript((token) => localStorage.setItem("equity-watch.opsToken", token), OPS_TOKEN);
  // A next check 9 minutes out, which is what the note would normally count to.
  await page.request.get("/__cadence?minutesAgo=6&interval=15&nextInMin=9");
  await page.request.get("/__auth?expiredMinAgo=40");
  await page.goto(`/#/alert/${STATIC.id}`);

  const form = page.locator("#drawer-body form");
  await form.getByLabel("Level").fill("56");
  await form.locator("button[type=submit]").click();
  await expect(page.locator("#ops-pending .pending-row")).toHaveCount(1);

  const note = page.locator("#ops-pending .note");
  await expect(note).toContainText("Waiting on the Schwab login");
  await expect(note).toContainText("keep their place");
  // The lie this replaces: a time it will supposedly apply.
  await expect(note).not.toContainText("Applies at the next check");
  await expect(page.locator("#ops-pending .note.warn")).toHaveCount(1);
});
