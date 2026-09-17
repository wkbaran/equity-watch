import { expect, test } from "@playwright/test";

// The panel's iframe points at a real, cross-origin TradingView endpoint, so
// these tests check what we control - visibility, focus, and the exact src
// we build - not that TradingView renders the moving averages inside it.

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("a symbol link opens the shared chart panel, not a new tab", async ({ page }) => {
  await page.goto("/#/alerts");
  await expect(page.locator("#chart-panel")).toBeHidden();
  await expect(page.locator("#chart-backdrop")).toBeHidden();

  const symLink = page.locator("#alerts-table a.sym").first();
  const symbol = await symLink.textContent();
  await symLink.click();

  await expect(page.locator("#chart-panel")).toBeVisible();
  await expect(page.locator("#chart-backdrop")).toBeVisible();
  await expect(page.locator("#chart-title")).toHaveText(symbol ?? "");
  await expect(page.locator("body")).toHaveClass(/chart-open/);

  const src = await page.locator("#chart-frame").getAttribute("src");
  expect(src).toBeTruthy();
  const url = new URL(src!);
  expect(url.host).toBe("s.tradingview.com");
  expect(url.pathname).toBe("/embed-widget/advanced-chart/");

  const settings = JSON.parse(decodeURIComponent(url.hash.slice(1)));
  // Moving Average Ribbon (SMA 20/50/100/200 by default - see web/app.js for
  // why this and not studies_overrides). No studies_overrides key at all:
  // verified unreliable on the live page, so never sent.
  expect(settings.studies).toEqual(["STD;MA%Ribbon"]);
  expect(settings.studies_overrides).toBeUndefined();
  expect(settings.colorTheme).toBe("dark");
});

test("closing hides the panel and stops the iframe", async ({ page }) => {
  await page.goto("/#/alerts");
  await page.locator("#alerts-table a.sym").first().click();
  await expect(page.locator("#chart-panel")).toBeVisible();

  await page.locator("#chart-close").click();
  await expect(page.locator("#chart-panel")).toBeHidden();
  await expect(page.locator("#chart-backdrop")).toBeHidden();
  await expect(page.locator("body")).not.toHaveClass(/chart-open/);
  await expect(page.locator("#chart-frame")).toHaveAttribute("src", "about:blank");
});

test("the backdrop and Escape also close it", async ({ page }) => {
  await page.goto("/#/alerts");

  await page.locator("#alerts-table a.sym").first().click();
  await expect(page.locator("#chart-panel")).toBeVisible();
  await page.locator("#chart-backdrop").click({ position: { x: 5, y: 5 } });
  await expect(page.locator("#chart-panel")).toBeHidden();

  await page.locator("#alerts-table a.sym").first().click();
  await expect(page.locator("#chart-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#chart-panel")).toBeHidden();
});

test("a chart opened from inside the alert drawer layers on top of it", async ({ page }) => {
  // The alert drawer stands in for both: it and the trigger drawer share one
  // #drawer element, so either exercises the same layering.
  await page.goto("/#/alerts");
  await page.locator("#alerts-table tr.clickable").first().click();
  await expect(page.locator("#drawer")).toBeVisible();

  await page.locator("#drawer a.sym").first().click();
  await expect(page.locator("#chart-panel")).toBeVisible();
  // The drawer is still open underneath; only the chart panel closes on Escape.
  await expect(page.locator("#drawer")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#chart-panel")).toBeHidden();
  await expect(page.locator("#drawer")).toBeVisible();
});

test("toggling the site theme reloads an open chart with the matching theme", async ({ page }) => {
  await page.goto("/#/alerts");
  await page.locator("#alerts-table a.sym").first().click();
  await expect(page.locator("#chart-panel")).toBeVisible();

  // The chart backdrop correctly blocks pointer clicks on the page underneath
  // (standard modal behavior - confirmed by a real mouse .click() here timing
  // out on the occluded button), so the only way to reach theme-btn while the
  // chart is open is keyboard activation, which isn't hit-tested the same way.
  await page.locator("#theme-btn").focus();
  await page.keyboard.press("Enter");
  const src = await page.locator("#chart-frame").getAttribute("src");
  const settings = JSON.parse(decodeURIComponent(new URL(src!).hash.slice(1)));
  expect(settings.colorTheme).toBe("light");
});
