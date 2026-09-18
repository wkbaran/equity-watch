import { expect, test, type Page } from "@playwright/test";
import { OPS_TOKEN, STATIC } from "../fixtures.js";

// The `held` tag and the two drawer additions it belongs with: the tag is a
// link into Holdings, the drawer grows a Position row and a Story, and the
// line between them is the one CLAUDE.md draws - size and value are private,
// being held is not.

// A named target means the tag opens a second tab, which is its own Page and
// so does NOT inherit page.addInitScript. Seed on the context instead.
const storeToken = (page: Page) =>
  page.context().addInitScript((token) => localStorage.setItem("equity-watch.opsToken", token), OPS_TOKEN);

// Headline fragments, since the fixture's three fires are what identify the rows.
const AA_FIRE = "crossed above 55"; // rv0000a2, on a held symbol, two fires so it has a story
const MSFT_FIRE = "crossed below 400"; // rv0000m1, not held, one fire so it has none

const triggerRow = (page: Page, headline: string) => page.locator("#triggers .trigger-row", { hasText: headline });
const heldTag = (scope: ReturnType<typeof triggerRow>) => scope.locator("a.tag.held");
/** The value of one row of the drawer's definition list, by its label. */
const kv = (page: Page, label: string) => page.locator(`#drawer-body dl.kv-list dt:text-is("${label}") + dd`);
const story = (page: Page) => page.locator("#drawer-body .story");

let errors: string[] = [];

function watch(p: Page) {
  p.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  p.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
}

test.beforeEach(async ({ page, context }) => {
  await page.request.get("/__reset");
  errors = [];
  watch(page);
  // The held tag opens a tab of its own; its errors count too.
  context.on("page", watch);
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("a recent trigger on a position carries a link to it, and one on anything else carries nothing", async ({ page }) => {
  await page.goto("/#/");
  const tag = heldTag(triggerRow(page, AA_FIRE));
  await expect(tag).toHaveText("held");
  await expect(tag).toHaveAttribute("href", "#/holdings/AA");
  await expect(tag).toHaveAttribute("target", "equity-watch-holdings");
  await expect(tag).toHaveAttribute("title", "Show AA in Holdings");

  await expect(triggerRow(page, MSFT_FIRE)).toBeVisible();
  await expect(heldTag(triggerRow(page, MSFT_FIRE))).toHaveCount(0);
});

test("clicking the held tag opens Holdings in its own tab rather than the trigger drawer", async ({ page }) => {
  await storeToken(page);
  await page.goto("/#/");
  await expect(page.locator("#drawer")).toBeHidden();

  const [holdingsTab] = await Promise.all([page.waitForEvent("popup"), heldTag(triggerRow(page, AA_FIRE)).click()]);

  // stopPropagation, so the row underneath never opened its details.
  await expect(page.locator("#drawer")).toBeHidden();
  expect(page.url()).toMatch(/#\/$/);

  await holdingsTab.waitForLoadState();
  expect(holdingsTab.url()).toMatch(/#\/holdings\/AA$/);
  const focused = holdingsTab.locator("#holdings tr.focused");
  await expect(focused).toHaveCount(1);
  await expect(focused).toContainText("AA");
});

test("#/holdings/<symbol> highlights that one position, and says so when there is none", async ({ page }) => {
  await storeToken(page);
  await page.goto("/#/holdings/AA");
  await expect(page.locator("#holdings > tbody > tr")).toHaveCount(2);
  const focused = page.locator("#holdings tr.focused");
  await expect(focused).toHaveCount(1);
  await expect(focused).toContainText("AA");
  await expect(page.locator("#holdings-status")).not.toContainText("isn't a position here");

  // A tag can outlive the position it points at, so an unknown symbol is said out loud.
  await page.goto("/#/holdings/ZZZZ");
  await expect(page.locator("#holdings-status")).toContainText("ZZZZ isn't a position here.");
  await expect(page.locator("#holdings tr.focused")).toHaveCount(0);
});

// The queue's actions used to be two clipboard buttons for CLI commands. The
// dismiss ones are gone: a trigger is resolved by editing its alert from the
// details panel (editing.e2e.ts), which closes the entry with it.
test("nothing offers to copy a dismiss command", async ({ page }) => {
  await storeToken(page);
  await page.goto("/#/queue");
  await expect(page.locator("#queue .queue-row").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy dismiss" })).toHaveCount(0);
  await page.goto("/#/trigger/rv0000a2");
  await expect(page.locator("#drawer-body .kv-list")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy dismiss" })).toHaveCount(0);
});

test("a trigger drawer shows the position behind the tag and the symbol's story", async ({ page }) => {
  await storeToken(page);
  await page.goto("/#/trigger/rv0000a2");
  await expect(page.locator("#drawer-body .drawer-title")).toContainText(AA_FIRE);

  const position = kv(page, "Position");
  await expect(position).toContainText("15 shares · basis 41.33 · +12.1% vs basis · value 695.10");
  await expect(position).toContainText("Stop 38.00");
  await expect(position.getByRole("link", { name: "Holdings" })).toHaveAttribute("href", "#/holdings/AA");
  await expect(position.getByRole("link", { name: "Holdings" })).toHaveAttribute("target", "equity-watch-holdings");

  await expect(page.locator("#drawer-body h3.drawer-sub", { hasText: "Story" })).toBeVisible();
  await expect(story(page).locator(".headline")).toContainText("AA has fired 2 times");
  expect(await story(page).locator("ol > li").count()).toBeGreaterThan(1);
});

test("a trigger on a symbol that is neither held nor a thread shows neither block", async ({ page }) => {
  await storeToken(page);
  await page.goto("/#/trigger/rv0000m1");
  await expect(page.locator("#drawer-body .drawer-title")).toContainText(MSFT_FIRE);
  await expect(page.locator("#drawer-body .drawer-title a.tag.held")).toHaveCount(0);
  await expect(kv(page, "Position")).toHaveCount(0);
  await expect(story(page)).toHaveCount(0);
});

// The rule this is here to hold: size and value are private, being held is not.
test("a locked drawer still says held and still tells the story, but carries no numbers", async ({ page }) => {
  await page.goto("/#/trigger/rv0000a2");
  await expect(page.locator("#drawer-body .drawer-title a.tag.held")).toHaveText("held");
  await expect(story(page).locator(".headline")).toContainText("AA has fired 2 times");
  await expect(kv(page, "Position")).toHaveCount(0);

  const text = await page.locator("#drawer-body").innerText();
  for (const secret of ["15 shares", "41.33", "695.10", "Stop 38"]) {
    expect(text).not.toContain(secret);
  }

  // The alert drawer draws its tag from AlertRow.heldPosition, not from the
  // vault, so it says the same thing locked as the trigger drawer does.
  await page.goto(`/#/alert/${STATIC.id}`);
  await expect(page.locator("#drawer-body .drawer-title a.tag.held")).toHaveText("held");
  await expect(kv(page, "Position")).toHaveCount(0);
  expect(await page.locator("#drawer-body").innerText()).not.toContain("15 shares");
});

test("the alert drawer carries the same held tag, position and story", async ({ page }) => {
  await storeToken(page);
  await page.goto(`/#/alert/${STATIC.id}`);
  await expect(page.locator("#drawer-body .drawer-title a.tag.held")).toHaveText("held");
  await expect(kv(page, "Position")).toContainText("15 shares · basis 41.33");
  await expect(story(page).locator(".headline")).toContainText("AA has fired 2 times");
});

// ZS, 2026-09-18: a trigger closed by an earlier edit offers no edit form, and
// "applied" alone said neither what changed nor where to edit instead.
test("a closed trigger says what it was changed to and links to the alert", async ({ page }) => {
  await storeToken(page);
  await page.goto("/#/trigger/rv0000a1");
  await expect(kv(page, "Status")).toHaveText(/^Changed to 55 on .+ at .+ \(was 43\)$/);
  await expect(page.locator("#drawer-body form")).toHaveCount(0);
  const link = page.locator("#drawer-body .note").getByRole("link", { name: "edit it here" });
  await expect(link).toHaveAttribute("href", `#/alert/${STATIC.id}`);
  await link.click();
  await expect(page.locator("#drawer-body form button[type=submit]", { hasText: "Queue edit" })).toBeVisible();
});

test("an open trigger's status says so and keeps its edit form", async ({ page }) => {
  await storeToken(page);
  await page.goto("/#/trigger/rv0000a2");
  await expect(kv(page, "Status")).toHaveText("Open");
  await expect(page.locator("#drawer-body form button[type=submit]", { hasText: "Queue edit" })).toBeVisible();
});

// Any edit closes the alert's open fires, so the alert's own panel says so
// before you save, not just the trigger panel.
test("the alert's edit form says saving takes its open fire off the queue", async ({ page }) => {
  await storeToken(page);
  await page.goto(`/#/alert/${STATIC.id}`);
  await expect(page.locator("#drawer-body .note", { hasText: "revisit queue" })).toHaveText("Saving an edit also takes this alert's open fire off the revisit queue.");
});
