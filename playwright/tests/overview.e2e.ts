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

const OLD_AA_FIRE = "crossed above 43"; // rv0000a1, five days old, always behind "Show more"

/** Unfolds the overview's older fires, when there are any to unfold. */
async function showAllTriggers(page: Page) {
  const toggle = page.locator("#triggers button.show-more");
  await expect(page.locator("#triggers .trigger-row").first()).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
}

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

  // Two days ago is behind "Show more" on some weekdays and not on others.
  await showAllTriggers(page);
  await expect(triggerRow(page, MSFT_FIRE)).toBeVisible();
  await expect(heldTag(triggerRow(page, MSFT_FIRE))).toHaveCount(0);
});

/**
 * The overview shows the last two trading days and folds the rest behind a
 * button. AA's first fire is five days old, which is past that cutoff on every
 * day of the week; its second is one day old, which never is.
 */
test("older fires wait behind Show more, and Show fewer folds them back", async ({ page }) => {
  await page.goto("/#/");
  const old = triggerRow(page, OLD_AA_FIRE);
  await expect(triggerRow(page, AA_FIRE)).toBeVisible();
  await expect(old).toHaveCount(0);

  const toggle = page.locator("#triggers button.show-more");
  await expect(toggle).toHaveText(/^Show \d+ more$/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(old).toBeVisible();
  await expect(toggle).toHaveText("Show fewer");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  await toggle.click();
  await expect(old).toHaveCount(0);
  // The section's count is every fire, not only the ones showing.
  await expect(page.locator("#triggers-count")).toHaveText("3");
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
// Stories tell your buys and sales, so they are for the unlocked page only.
test("a locked drawer still says held, but tells no story and carries no numbers", async ({ page }) => {
  await page.goto("/#/trigger/rv0000a2");
  await expect(page.locator("#drawer-body .drawer-title a.tag.held")).toHaveText("held");
  await expect(story(page)).toHaveCount(0);
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

test("a locked page has no Stories view, and #/stories lands on the overview", async ({ page }) => {
  await page.goto("/#/stories");
  await expect(page.locator("#view-overview")).toBeVisible();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator("#view-stories")).toBeHidden();
  await expect(page.locator("#nav-stories")).toBeHidden();
  // Not merely hidden: the stories are only in the vault.
  const doc = (await (await page.request.get("/dashboard.json")).json()) as { stories: unknown[] };
  expect(doc.stories).toEqual([]);
});

test("an unlocked page keeps Stories, including a direct #/stories load", async ({ page }) => {
  await storeToken(page);
  await page.goto("/#/stories");
  await expect(page.locator("#view-stories")).toBeVisible();
  await expect(page.locator("#nav-stories")).toBeVisible();
  await expect(page.locator("#stories .story").first()).toBeVisible();

  // Locking takes it away without a reload.
  await page.locator("#ops-btn").click();
  await expect(page.locator("#nav-stories")).toBeHidden();
  await expect(page.locator("#view-overview")).toBeVisible();
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

// The revisit queue's own version of the same line: what changed since the
// fire was queued may be published, what the position is worth may not.
test.describe("the revisit queue", () => {
  const queueRow = (page: Page, headline: string) => page.locator("#queue .queue-row", { hasText: headline });

  test("a held row shows the position only once unlocked, and never from the document", async ({ page }) => {
    await page.goto("/#/queue");
    const aa = queueRow(page, AA_FIRE);
    await expect(heldTag(aa)).toHaveText("held");
    await expect(aa.locator(".position-note")).toHaveCount(0);
    // The public document must not carry the numbers in the first place.
    const doc = await (await page.request.get("/dashboard.json")).text();
    expect(doc).not.toContain("position-note");
    for (const key of ["shares", "basis", "marketValue"]) expect(doc).not.toContain(`"${key}"`);

    await storeToken(page);
    await page.reload();
    // AA is 15 shares blended across two lots at 40 and 44, with a stop at 38.
    await expect(queueRow(page, AA_FIRE).locator(".position-note")).toContainText("Holding 15 @ 41.33");
    await expect(queueRow(page, AA_FIRE).locator(".position-note")).toContainText("stop 38.00");
    // MSFT isn't held, so it gets neither the tag nor the line.
    await expect(queueRow(page, MSFT_FIRE).locator(".position-note")).toHaveCount(0);
  });

  test("prints what changed since the fire was queued", async ({ page }) => {
    await page.route("**/dashboard.json", async (route) => {
      const response = await route.fetch();
      const doc = await response.json();
      const row = doc.revisitQueue.find((r: any) => r.headline.includes(MSFT_FIRE));
      row.updates = ["Level moved 400 → 390 since this fired.", "Crossed the level 2 more times since."];
      row.sinceTrigger = "Price 420, +6% since it fired.";
      // What the builder really produces alongside a level move: "Level 400
      // still stands" is exactly the claim the move disproves.
      row.action = null;
      await route.fulfill({ response, json: doc });
    });
    await page.goto("/#/queue");
    const msft = queueRow(page, MSFT_FIRE);
    await expect(msft.locator(".update-note")).toHaveCount(2);
    await expect(msft.locator(".update-note").first()).toHaveText("Level moved 400 → 390 since this fired.");
    await expect(msft).toContainText("Price 420, +6% since it fired.");
    await expect(msft).not.toContainText("still stands");
  });

  test("an untouched row carries no update lines", async ({ page }) => {
    await page.goto("/#/queue");
    await expect(page.locator("#queue .update-note")).toHaveCount(0);
  });
});

/**
 * `buildDashboard` has always computed the Approaching list and the terminal
 * view has always printed it, but the page had no renderer at all — so the one
 * place a person actually reads this document silently dropped it.
 */
test.describe("the approaching list", () => {
  const section = (page: Page) => page.locator("#approaching-section");

  test("is on the overview, collapsed, and says how many are in range", async ({ page }) => {
    await page.goto("/#/");
    await expect(section(page)).toBeVisible();
    // Collapsed: a hundred names within a few percent of firing is market
    // noise, not a to-do list.
    await expect(section(page).locator("details")).not.toHaveAttribute("open", "");
    await expect(page.locator("#approaching-summary")).toContainText("within range of firing");
  });

  test("carries the side in the arrow, so a downside alert reads unambiguously", async ({ page }) => {
    await page.goto("/#/");
    await section(page).locator("summary").click();
    // MSFT's alert is below-side at 400 with price 420: it needs price to fall.
    const msft = page.locator(".approach-row", { hasText: "MSFT" });
    await expect(msft).toContainText("↓");
    await expect(msft).toContainText("+vol");
  });

  test("a row links to its alert", async ({ page }) => {
    await page.goto("/#/");
    await section(page).locator("summary").click();
    await page.locator(".approach-row", { hasText: "MSFT" }).locator("a.plain").click();
    await expect(page.locator("#drawer-body")).toContainText("price crosses");
  });
});

/**
 * The FMP profile cache has held company names and sectors all along, and only
 * `exchange` was ever read — which is why every ticker on the page was a bare
 * symbol with nothing to say what it is.
 */
test.describe("company names and sectors", () => {
  test("name the company in an alert drawer", async ({ page }) => {
    await page.goto("/#/alert/st000002");
    await expect(page.locator("#drawer-body .drawer-company")).toHaveText("Microsoft Corporation · Technology · Software — Infrastructure");
  });

  // A symbol with no cached profile is the common case until `profile fetch`
  // runs, and must still render as a bare ticker rather than an empty line.
  test("leave a symbol with no cached profile alone", async ({ page }) => {
    await page.goto(`/#/alert/${STATIC.id}`);
    await expect(page.locator("#drawer-body .drawer-title")).toContainText("AA");
    await expect(page.locator("#drawer-body .drawer-company")).toHaveCount(0);
  });

  test("show what is known when a profile has a name but no sector", async ({ page }) => {
    await page.goto("/#/alert/ma000001");
    await expect(page.locator("#drawer-body .drawer-company")).toHaveText("SPDR S&P 500 ETF Trust");
  });
});

/**
 * The two `holdings check` conditions the browser can derive. They are
 * computed here rather than published because both are basis-derived, and
 * nothing basis-derived may travel in a public document.
 */
test.describe("holdings conditions", () => {
  const row = (page: Page, symbol: string) => page.locator("#holdings > tbody > tr", { has: page.locator(`a.sym:text-is("${symbol}")`) });

  test("tag a position that has cleared its cost by the threshold", async ({ page }) => {
    await storeToken(page);
    await page.goto("/#/holdings");
    // AA: blended basis ~41.33 against 46.34, so comfortably past +10%.
    await expect(row(page, "AA").locator(".tag.above-basis")).toHaveText("+10% over basis");
    await expect(row(page, "TSLA").locator(".tag.above-basis")).toHaveCount(0);
  });

  test("say nothing about them in the published document", async ({ page }) => {
    const doc = await (await page.request.get("/dashboard.json")).json();
    expect(JSON.stringify(doc)).not.toContain("above-basis");
    expect(JSON.stringify(doc)).not.toContain("stagnant");
  });
});
