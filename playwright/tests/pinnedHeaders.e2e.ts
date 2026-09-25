import { expect, test, type Page } from "@playwright/test";
import { OPS_TOKEN } from "../fixtures.js";

// The Alerts and Holdings header rows stay in view under the queue strip once
// their table scrolls under it, and what is above the table scrolls away. They
// can't be `position: sticky`: the tables' overflow-x wrapper is the scroller a
// sticky cell would stick to, and it never scrolls vertically.

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  await page.request.get("/__reset");
  errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await page.addInitScript((token) => localStorage.setItem("equity-watch.opsToken", token), OPS_TOKEN);
  // Short enough that the fixture tables scroll; the phone width is the case
  // where the table also scrolls sideways.
  await page.setViewportSize({ width: 390, height: 400 });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

/** Scrolls the page so the table's top is `past` px under the strip, and reports where things landed. */
async function scrollPast(page: Page, table: string, past: number) {
  return page.evaluate(
    async ({ table, past }) => {
      // The fixtures are a few rows long; room below lets the page scroll far enough.
      document.querySelector("main")!.style.paddingBottom = "2000px";
      const el = document.querySelector(table)!;
      // Twice: on a phone the strip only sticks once the rail above it has
      // scrolled away, so where it ends up isn't known until then.
      for (let i = 0; i < 2; i++) {
        const strip = document.getElementById("tape-wrap")!.getBoundingClientRect().bottom;
        window.scrollBy(0, el.getBoundingClientRect().top - strip + past);
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return {
        strip: document.getElementById("tape-wrap")!.getBoundingClientRect().bottom,
        head: el.querySelector(":scope > thead")!.getBoundingClientRect(),
        table: el.getBoundingClientRect(),
      };
    },
    { table, past }
  );
}

for (const [view, table] of [
  ["alerts", "#alerts-table"],
  ["holdings", "#holdings"],
] as const) {
  test(`the ${view} header row stays under the strip, and not past its table`, async ({ page }) => {
    await page.goto(`/#/${view}`);
    await expect(page.locator(`${table} > tbody > tr`).first()).toBeVisible();

    // Not scrolled: the header sits where the table puts it.
    const before = await page.evaluate((t) => document.querySelector(`${t} > thead`)!.getBoundingClientRect().top - document.querySelector(t)!.getBoundingClientRect().top, table);
    expect(before).toBe(0);

    // Scrolled into the rows: the toolbar above has gone, the header has not.
    const mid = await scrollPast(page, table, 40);
    expect(mid.table.top).toBeLessThan(mid.strip);
    expect(Math.abs(mid.head.top - mid.strip)).toBeLessThan(1);

    // Scrolled beyond the table: the header leaves with it rather than float over what follows.
    const past = await scrollPast(page, table, 5000);
    expect(past.head.bottom).toBeLessThanOrEqual(past.table.bottom + 0.5);
    expect(past.head.bottom).toBeLessThan(past.strip);

    // And back to the top, it is back in place.
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.locator(`${table} > thead`)).not.toHaveClass(/pinned/);
  });
}
