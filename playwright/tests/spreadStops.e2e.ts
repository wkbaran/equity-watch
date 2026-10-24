import { expect, test, type Page } from "@playwright/test";
import { OPS_TOKEN, SPREAD_BOOK_URL } from "../fixtures.js";
import { unlockWith } from "../unlock.js";

// Spread stops from spread-book (src/spreads/): read-only rows on the overview,
// and a fire announced like a trigger. Fixture: NVDA put spread fired at its
// 182.5 level (price 180 now), MSFT call spread under its 431.2 level (420).

let errors: string[] = [];
function watch(p: Page) {
  p.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  p.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
}
test.beforeEach(({ page }) => {
  errors = [];
  watch(page);
});
test.afterEach(() => expect(errors).toEqual([]));

const rows = (page: Page) => page.locator("#spreads .trigger-row");

test("the overview lists spread stops, the one at its stop first", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#spreads-section")).toBeVisible();
  await expect(page.locator("#spreads-count")).toHaveText("2");
  await expect(rows(page)).toHaveCount(2);
  const lines = (i: number) => rows(page).nth(i).locator(".spread-line");
  await expect(lines(0)).toHaveText(["NVDA 175/180 put, expires 2026-11-27: (spread $1.86, short Δ 0.42)", /^Stop below 182.5, Now 180\. Fired at 181\.9, /]);
  await expect(rows(page).nth(0).locator(".tag.at-stop")).toHaveText("at stop");
  await expect(rows(page).nth(0).locator(".when")).toHaveText("past");
  await expect(lines(1)).toHaveText(["MSFT 440/445 call, expires 2026-11-20: (spread $1.71, short Δ 0.38)", "Stop above 431.2, Now 420"]);
  await expect(rows(page).nth(1).locator(".tag.at-stop")).toHaveCount(0);
  await expect(rows(page).nth(1)).not.toContainText("watching");
  await expect(rows(page).nth(1).locator(".when")).toHaveText("2.7%");
  await expect(page.locator("#spreads-note")).toContainText("check the spread's own price");
  await expect(page.locator("#spreads-note")).not.toHaveClass(/warn/);
});

test("each row links to spread-book; the OptionStrat link appears only once the page is unlocked", async ({ page }) => {
  await page.goto("/");
  const book = rows(page).nth(0).getByRole("link", { name: "spread-book" });
  await expect(book).toHaveAttribute("href", `${SPREAD_BOOK_URL}/?spread=${encodeURIComponent("NVDA Nov 27th 175/180 Bull Put Spread|2026-11-27|175/180")}`);
  await expect(book).toHaveAttribute("target", "spread-book");
  await expect(page.locator("#spreads").getByRole("link", { name: "OptionStrat" })).toHaveCount(0);

  await unlockWith(page, OPS_TOKEN);
  const os = rows(page).nth(0).getByRole("link", { name: "OptionStrat" });
  await expect(os).toHaveAttribute("href", "https://optionstrat.com/FixtureNvda1");
  await expect(os).toHaveAttribute("target", "optionstrat");
  // MSFT's spread has no saved trade on file.
  await expect(rows(page).nth(1).getByRole("link", { name: "OptionStrat" })).toHaveCount(0);
  await expect(rows(page).nth(1).getByRole("link", { name: "spread-book" })).toHaveCount(1);
});

test("a new spread fire is announced; on a first visit, nothing is", async ({ page }) => {
  await page.goto("/");
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator("#toasts .toast", { hasText: "crossed below its stop level" })).toHaveCount(0);

  await page.context().addInitScript(() => localStorage.setItem("equity-watch.seenSpreadFires", "[]"));
  await page.reload();
  const toast = page.locator("#toasts .toast", { hasText: "175/180 put: stock 181.9 crossed below its stop level 182.5" });
  await expect(toast).toBeVisible();
  await expect(toast).not.toContainText("NVDA NVDA");
});

test("the published document carries no contract count or credit", async ({ page }) => {
  const resp = await page.request.get("/dashboard.json");
  const text = await resp.text();
  expect(text).toContain("spreadStops");
  expect(text).not.toMatch(/"contracts"|"credit"|optionstrat\.com/);
});
