import { expect, test, type Page } from "@playwright/test";
import { OPS_TOKEN } from "../fixtures.js";

// The Alerts and Holdings header rows stay in view under the queue strip once
// their table scrolls under it, and what is above the table scrolls away. The
// row on screen is a sticky copy (.table-head) laid exactly over the real one,
// because the tables' overflow-x wrapper is the scroller a sticky cell in the
// table itself would stick to, and it never scrolls vertically.

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

const box = (page: Page, selector: string) => page.evaluate((s) => document.querySelector(s)!.getBoundingClientRect().toJSON() as DOMRect, selector);

/** Scrolls the page so the table's top is `past` px under the strip. */
async function scrollPast(page: Page, table: string, past: number) {
  await page.evaluate(
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
    },
    { table, past }
  );
}

for (const [view, table, copy] of [
  ["alerts", "#alerts-table", "#alerts-head"],
  ["holdings", "#holdings", "#holdings-head"],
] as const) {
  test(`the ${view} header row stays under the strip, and not past its table`, async ({ page }) => {
    await page.goto(`/#/${view}`);
    await expect(page.locator(`${table} > tbody > tr`).first()).toBeVisible();

    // Not scrolled: the copy lies exactly over the real header row, cell for cell.
    await expect(page.locator(copy)).toBeVisible();
    const real = await page.evaluate((t) => [...document.querySelectorAll(`${t} > thead th`)].map((c) => c.getBoundingClientRect().toJSON()), table);
    const shown = await page.evaluate((t) => [...document.querySelectorAll(`${t} th`)].map((c) => c.getBoundingClientRect().toJSON()), copy);
    expect(shown.length).toBe(real.length);
    shown.forEach((c, i) => {
      expect(Math.abs(c.left - real[i].left)).toBeLessThan(1);
      expect(Math.abs(c.top - real[i].top)).toBeLessThan(1);
      expect(Math.abs(c.width - real[i].width)).toBeLessThan(1);
    });

    // Scrolled into the rows: the toolbar above has gone, the header has not.
    await scrollPast(page, table, 40);
    const tape = await box(page, "#tape-wrap");
    expect((await box(page, table)).top).toBeLessThan(tape.bottom);
    expect(Math.abs((await box(page, copy)).top - tape.bottom)).toBeLessThan(1);

    // Scrolled beyond the table: the header leaves with it rather than float over what follows.
    await scrollPast(page, table, 5000);
    const head = await box(page, copy);
    expect(head.bottom).toBeLessThanOrEqual((await box(page, table)).bottom + 0.5);
    expect(head.bottom).toBeLessThan((await box(page, "#tape-wrap")).bottom);
  });
}

test("on a phone the pinned header follows the table sideways", async ({ page }) => {
  await page.goto("/#/alerts");
  await expect(page.locator("#alerts-table > tbody > tr").first()).toBeVisible();
  await page.evaluate(() => (document.querySelector("#alerts-table")!.parentElement!.scrollLeft = 150));
  await expect
    .poll(() =>
      page.evaluate(() => {
        const real = document.querySelectorAll("#alerts-table > thead th")[3].getBoundingClientRect().left;
        const copy = document.querySelectorAll("#alerts-head th")[3].getBoundingClientRect().left;
        return Math.round(real - copy);
      })
    )
    .toBe(0);
});
