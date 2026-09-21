/**
 * Capture cropped fragments of the dashboard for README.md, against the
 * Playwright fixture server (playwright/server.ts) — fixture alerts and
 * invented positions only, never the real stores.
 */
import { chromium, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

// Hardcoded rather than imported, so this script can live outside the repo.
const OPS_TOKEN = "x".repeat(32);
const STATIC = { id: "st000001" };

const BASE = "http://localhost:4178";
const OUT = "C:/Users/billb/projects/equity-watch/docs/images";

async function shot(page: Page, selector: string, name: string, padding = 12) {
  const el = page.locator(selector).first();
  await el.waitFor({ state: "visible" });
  const box = await el.boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  await page.screenshot({
    path: `${OUT}/${name}.png`,
    clip: {
      x: Math.max(0, box.x - padding),
      y: Math.max(0, box.y - padding),
      width: box.width + padding * 2,
      height: box.height + padding * 2,
    },
  });
  console.log(`${name}.png  ${Math.round(box.width)}x${Math.round(box.height)}`);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.request.get(`${BASE}/__reset`);

  // 1. The open queue row: headline, held tag, priority, actions.
  await page.goto(`${BASE}/#/queue`);
  await page.locator("#queue .queue-row").first().waitFor({ state: "visible" });
  await shot(page, "#queue .queue-row", "queue-row");

  // 2. The trigger drawer's facts for that same fire. Just the kv-list: the
  // drawer also repeats the story, which is its own fragment below.
  await page.goto(`${BASE}/#/trigger/rv0000a2`);
  await shot(page, "#drawer-body .kv-list", "trigger-details");

  // 3. The story for AA: two fires with the re-level between them.
  await page.goto(`${BASE}/#/stories`);
  await shot(page, "#stories .story", "story");

  // 4. The alert's edit form, which needs editing unlocked. The init script
  // only runs on a real load, and a hash-only goto doesn't reload - hence the
  // explicit reload before the drawer route.
  await ctx.addInitScript((t) => localStorage.setItem("equity-watch.opsToken", t), OPS_TOKEN);
  await page.reload();
  await page.goto(`${BASE}/#/alert/${STATIC.id}`);
  const editForm = page.locator("#drawer-body form");
  await editForm.waitFor({ state: "visible" });
  // The form sits below the drawer's facts, story and recent triggers.
  await editForm.scrollIntoViewIfNeeded();
  await shot(page, "#drawer-body form", "alert-edit");

  // 5. Queue that edit, then show the pending row that says when it lands.
  // #ops-pending lives inside the Alerts view, so that is where it is visible.
  await editForm.getByLabel("Level").fill("61");
  await editForm.locator("button[type=submit]").click();
  await page.goto(`${BASE}/#/alerts`);
  await page.locator("#ops-pending .pending-row").first().waitFor({ state: "visible" });
  await shot(page, "#ops-pending", "pending");

  // 6. The Alerts table: condition in words, level, price, distance, fires.
  await page.locator("#alerts-table tbody tr").first().waitFor({ state: "visible" });
  await shot(page, "#alerts-table", "alerts-table");

  // 7. The header's own line: document age plus the scheduler's next run.
  await shot(page, "#updated", "updated", 8);

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
