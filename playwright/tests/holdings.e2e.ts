import { expect, test, type Page } from "@playwright/test";
import { OPS_TOKEN } from "../fixtures.js";

const poll = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
const storeToken = (page: Page) => page.addInitScript((token) => localStorage.setItem("equity-watch.opsToken", token), OPS_TOKEN);

async function queuedOps(page: Page): Promise<Array<Record<string, any>>> {
  return (await page.request.get("/__ops")).json();
}

async function openHoldings(page: Page) {
  await page.goto("/#/holdings");
  await expect(page.locator("#holdings tbody tr").first()).toBeVisible();
}

const positionRow = (page: Page, symbol: string) => page.locator("#holdings > tbody > tr", { has: page.locator(`a.sym:text-is("${symbol}")`) });
const detail = (page: Page) => page.locator("#holdings tr.detail-row");

async function expand(page: Page, symbol: string) {
  // Click the shares cell: the symbol itself is a chart link.
  await positionRow(page, symbol).locator("td").nth(2).click();
  await expect(detail(page)).toBeVisible();
}

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

test("holdings stay private while locked", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.locator("#tiles .tile").first()).toBeVisible();
  await expect(page.locator("#nav-holdings")).toBeHidden();
  await page.goto("/#/holdings");
  await expect(page.locator("#holdings-status")).toHaveText("Holdings are private. Unlock editing to see and change them.");
  await expect(page.locator("#holdings tr")).toHaveCount(0);

  const doc = await (await page.request.get("/dashboard.json")).json();
  expect(doc.holdings).toEqual([]);
  expect(JSON.stringify(doc)).not.toMatch(/"shares"|"basisPerShare"|"stopPrice"|"marketValue"/);
  expect(await (await page.request.get("/vault.json")).text()).not.toMatch(/"symbol"|roth|lot0000/);
});

test("a token that can't open the vault is refused before anything is sent", async ({ page }) => {
  await page.goto("/#/holdings");
  page.once("dialog", (d) => d.accept("y".repeat(64)));
  await page.locator("#ops-btn").click();
  await expect(page.locator("#toasts .toast.bad")).toContainText("didn't open the holdings");
  await expect(page.locator("#ops-btn")).toHaveText("Unlock editing");
  await expect(page.locator("#nav-holdings")).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("equity-watch.opsToken"))).toBeNull();
  expect(await queuedOps(page)).toEqual([]);
});

test("unlocking shows positions, and a position expands to its lots and stops", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.locator("#nav-holdings")).toBeHidden();
  page.once("dialog", (d) => d.accept(OPS_TOKEN));
  await page.locator("#ops-btn").click();
  await expect(page.locator("#nav-holdings")).toBeVisible();
  await expect(page.locator("#nav-holdings-count")).toHaveText("(2)");
  await expect(page.locator("#tiles")).toContainText("positions held");

  await page.locator("#nav-holdings").click();
  await expect(positionRow(page, "AA").locator("td").nth(2)).toHaveText("15");
  await expect(positionRow(page, "AA")).toContainText("stop 38");
  await expand(page, "AA");
  const lots = detail(page).locator("table.lots > tbody > tr:not(.lot-edit)");
  await expect(lots).toHaveCount(2);
  await expect(lots.nth(0)).toContainText("roth");
  await expect(lots.nth(1)).toContainText("margin");
  await expect(detail(page).locator(".stop-list")).toContainText("38.00 · all shares");

  await positionRow(page, "AA").locator("td").nth(2).click();
  await expect(detail(page)).toHaveCount(0);
});

test("the account column lists every account a position sits in, and filters to one", async ({ page }) => {
  await storeToken(page);
  await openHoldings(page);
  // AA is held in two accounts, so the row names both; TSLA's lot names none.
  await expect(positionRow(page, "AA").locator("td").nth(1)).toHaveText("margin, roth");
  await expect(positionRow(page, "TSLA").locator("td").nth(1)).toHaveText("—");

  const select = page.locator("#holdings-account");
  await expect(page.locator("#holdings-toolbar")).toBeVisible();
  await expect(select.locator("option")).toHaveText(["All accounts (2)", "margin (1)", "roth (1)", "No account (1)"]);

  await select.selectOption("roth");
  await expect(positionRow(page, "AA")).toBeVisible();
  await expect(positionRow(page, "TSLA")).toHaveCount(0);
  await expect(page.locator("#holdings-count")).toHaveText("(1 of 2)");

  // The unlabeled bucket is its own choice, not a way of showing everything.
  await select.selectOption({ label: "No account (1)" });
  await expect(positionRow(page, "TSLA")).toBeVisible();
  await expect(positionRow(page, "AA")).toHaveCount(0);

  await select.selectOption("all");
  await expect(page.locator("#holdings > tbody > tr")).toHaveCount(2);
  await expect(page.locator("#holdings-count")).toHaveText("(2)");
});

test("sorting by account puts the unlabeled position last either way", async ({ page }) => {
  await storeToken(page);
  await openHoldings(page);
  const account = page.locator("#holdings thead th", { hasText: "Account" });
  const symbols = page.locator("#holdings > tbody > tr a.sym");
  await account.click();
  await expect(symbols).toHaveText(["AA", "TSLA"]);
  await account.click();
  await expect(symbols).toHaveText(["AA", "TSLA"]);
});

test("adds a lot", async ({ page }) => {
  await storeToken(page);
  await openHoldings(page);
  const form = page.locator("#lot-add form");
  await form.locator("button[type=submit]").click();
  await expect(form.locator(".form-error")).toHaveText("Enter a symbol.");

  await form.locator("input[type=text]").first().fill("msft");
  await form.locator("input[type=number]").nth(0).fill("3");
  await form.locator("input[type=number]").nth(1).fill("410.5");
  await form.locator("input[type=date]").fill("2026-09-10");
  await form.locator("input[type=text]").nth(1).fill("roth");
  await form.locator("button[type=submit]").click();

  await expect(page.locator("#holdings-pending .pending-row")).toContainText("add 3 MSFT @ 410.5");
  await expect(form.locator("input[type=text]").first()).toHaveValue("");
  const [op] = await queuedOps(page);
  expect(op).toMatchObject({ type: "lot.add", params: { symbol: "MSFT", count: 3, basisPerShare: 410.5, purchaseDate: "2026-09-10", account: "roth" } });
});

test("adding a lot with a stop for a new position just sends the stop", async ({ page }) => {
  await storeToken(page);
  await openHoldings(page);
  const form = page.locator("#lot-add form");
  await form.locator("input[type=text]").first().fill("nvda");
  await form.locator("input[type=number]").nth(0).fill("2");
  await form.locator("input[type=number]").nth(1).fill("120");
  await form.locator("input[type=number]").nth(2).fill("100");
  await form.locator("button[type=submit]").click();

  await expect(page.locator("#holdings-pending .pending-row")).toContainText("add 2 NVDA @ 120, stop 100");
  const [op] = await queuedOps(page);
  expect(op).toMatchObject({ type: "lot.add", params: { symbol: "NVDA", count: 2, basisPerShare: 120, stopPrice: 100 } });
  expect(op.params).not.toHaveProperty("stopCount");
});

test("adding a lot with a stop on an existing position says it replaces the old stop", async ({ page }) => {
  await storeToken(page);
  await openHoldings(page);
  const form = page.locator("#lot-add form");
  await form.locator("input[type=text]").first().fill("AA");
  await form.locator("input[type=number]").nth(0).fill("5");
  await form.locator("input[type=number]").nth(1).fill("42");
  await form.locator("input[type=number]").nth(2).fill("36");
  await form.locator("input[type=number]").nth(3).fill("20");
  await form.locator("button[type=submit]").click();

  await expect(page.locator("#holdings-pending .pending-row")).toContainText("replacing its stop with 36");
  const [op] = await queuedOps(page);
  expect(op).toMatchObject({ type: "lot.add", params: { symbol: "AA", count: 5, basisPerShare: 42, stopPrice: 36, stopCount: 20 } });
});

test("edits a lot, sending only what changed and the lot as shown", async ({ page }) => {
  await storeToken(page);
  await openHoldings(page);
  await expand(page, "AA");
  await detail(page).getByRole("button", { name: "Edit" }).first().click();
  const form = detail(page).locator("tr.lot-edit form").first();
  await expect(form).toBeVisible();
  await expect(form.locator("input[type=number]").nth(0)).toHaveValue("10");

  await form.locator("button[type=submit]").click();
  await expect(form.locator(".form-error")).toHaveText("Nothing changed.");

  await form.locator("input[type=number]").nth(0).fill("12");
  await form.locator("input[type=text]").fill("");
  await form.locator("button[type=submit]").click();
  await expect(page.locator("#holdings-pending")).toContainText("edit AA lot: shares 10 → 12, no account");
  await expect(positionRow(page, "AA").locator(".tag.pending")).toHaveText("change pending");
  const [op] = await queuedOps(page);
  expect(op).toMatchObject({
    type: "lot.edit",
    target: { lotId: "lot00001" },
    expect: { count: 10, basisPerShare: 40, purchaseDate: "2026-09-01", account: "roth" },
    params: { count: 12, account: "" },
  });
});

test("removals take a second click", async ({ page }) => {
  await storeToken(page);
  await openHoldings(page);
  await expand(page, "AA");

  const lotRemove = detail(page).locator("table.lots > tbody > tr:not(.lot-edit)").nth(1).getByRole("button", { name: "Remove" });
  await lotRemove.click();
  await expect(detail(page).getByRole("button", { name: "Click again to confirm" })).toHaveCount(1);
  expect(await queuedOps(page)).toEqual([]);
  await detail(page).getByRole("button", { name: "Click again to confirm" }).click();
  await expect.poll(async () => (await queuedOps(page)).length).toBe(1);

  await detail(page).locator(".stop-tag").getByRole("button", { name: "Remove" }).click();
  await detail(page).locator(".stop-tag").getByRole("button", { name: "Click again to confirm" }).click();
  await expect.poll(async () => (await queuedOps(page)).length).toBe(2);

  await detail(page).getByRole("button", { name: "Remove the AA position" }).click();
  await detail(page).getByRole("button", { name: "Click again to confirm" }).click();
  await expect.poll(async () => (await queuedOps(page)).length).toBe(3);

  const [lot, stop, position] = await queuedOps(page);
  expect(lot).toMatchObject({ type: "lot.remove", target: { lotId: "lot00002" }, expect: { count: 5, basisPerShare: 44, purchaseDate: "2026-09-08", account: "margin" } });
  expect(stop).toMatchObject({ type: "stop.remove", target: { stopId: "stop0001" }, expect: { stopPrice: 38 } });
  expect(position).toMatchObject({ type: "position.remove", target: { symbol: "AA" }, expect: { lotIds: ["lot00001", "lot00002"] } });
});

test("adds a stop", async ({ page }) => {
  await storeToken(page);
  await openHoldings(page);
  await expand(page, "TSLA");
  await expect(detail(page).locator(".stop-list")).toContainText("No stops.");
  const form = detail(page).locator(".stops form");
  await form.locator("input[type=number]").nth(0).fill("230");
  await form.locator("input[type=number]").nth(1).fill("1");
  await form.locator("button[type=submit]").click();
  await expect(page.locator("#holdings-pending")).toContainText("add TSLA stop at 230 for 1 shares");
  const [op] = await queuedOps(page);
  expect(op).toMatchObject({ type: "stop.add", params: { symbol: "TSLA", stopPrice: 230, count: 1 } });
});

test.describe("the alert on a position", () => {
  test("shows as a pill on the row, abbreviated, with the full condition as its title", async ({ page }) => {
    await storeToken(page);
    await openHoldings(page);
    const pill = positionRow(page, "AA").locator(".tag.alert");
    await expect(pill).toHaveText("alert ↑ 55");
    await expect(pill).toHaveAttribute("title", "price crosses above 55");
    // A level that moves on its own is marked, since it is the value as of the
    // last check rather than a number anybody typed.
    await expect(positionRow(page, "TSLA").locator(".tag.alert")).toContainText("~");
  });

  test("puts its edit form beside the stop form, and queues an edit from there", async ({ page }) => {
    await storeToken(page);
    await openHoldings(page);
    await expand(page, "AA");
    // Stops left, alert right, in one two-column row.
    const cols = detail(page).locator(".detail-cols");
    await expect(cols.locator("> .stops")).toBeVisible();
    await expect(cols.locator("> .alert-col")).toBeVisible();
    const stopsBox = await cols.locator("> .stops").boundingBox();
    const alertBox = await cols.locator("> .alert-col").boundingBox();
    expect(stopsBox!.x).toBeLessThan(alertBox!.x);

    const form = cols.locator("> .alert-col form");
    await expect(form.getByLabel("Level")).toHaveValue("55");
    await form.getByLabel("Level").fill("61");
    await form.locator("button[type=submit]").click();
    const [op] = await queuedOps(page);
    expect(op).toMatchObject({ type: "alert.edit", target: { alertId: "st000001" }, params: { level: 61 } });
  });

  // One shared form slot would let each rendered row steal the element out of
  // the last, wiping what was typed into it.
  test("keeps a form per expanded position rather than one shared between them", async ({ page }) => {
    await storeToken(page);
    await openHoldings(page);
    // Not expand(), which asserts a single detail row.
    await positionRow(page, "AA").locator("td").nth(2).click();
    await positionRow(page, "TSLA").locator("td").nth(2).click();
    await expect(detail(page)).toHaveCount(2);
    await expect(page.locator("#holdings .alert-col form")).toHaveCount(2);

    // Both hold their own state, and a re-render keeps what was typed.
    const aaLevel = detail(page).first().locator(".alert-col").getByLabel("Level");
    await aaLevel.fill("62");
    await poll(page);
    await expect(aaLevel).toHaveValue("62");
    // TSLA's is a trailing alert, so it is a different form, not the same one moved.
    await expect(detail(page).nth(1).locator(".alert-col")).toContainText("Trail");
  });
});

// Moving a stop used to be Remove then Add: two ops, either of which could
// land alone, leaving the position with no stop recorded or two.
test("moves a stop in one guarded op, prefilled with what is set", async ({ page }) => {
  await storeToken(page);
  await openHoldings(page);
  await expand(page, "AA");
  const form = detail(page).locator("form.stop-edit");
  await expect(form).toBeHidden();
  await detail(page).locator(".stop-tag").getByRole("button", { name: "Edit" }).click();
  await expect(form).toBeVisible();
  // Prefilled, so opening the form to read it and saving changes nothing.
  await expect(form.locator("input[type=number]").nth(0)).toHaveValue("38");

  await form.locator("input[type=number]").nth(0).fill("41");
  await form.locator("button[type=submit]").click();
  const [op] = await queuedOps(page);
  expect(op).toMatchObject({ type: "stop.edit", target: { stopId: "stop0001" }, expect: { stopPrice: 38 }, params: { stopPrice: 41 } });
  await expect(page.locator("#holdings-pending")).toContainText("move AA stop from 38 to 41");
});

test("a stop move rejects a price of zero with the same words the add form uses", async ({ page }) => {
  await storeToken(page);
  await openHoldings(page);
  await expand(page, "AA");
  await detail(page).locator(".stop-tag").getByRole("button", { name: "Edit" }).click();
  const form = detail(page).locator("form.stop-edit");
  await form.locator("input[type=number]").nth(0).fill("0");
  await form.locator("button[type=submit]").click();
  await expect(form.locator(".form-error")).toHaveText("Enter a stop price above 0.");
  expect(await queuedOps(page)).toEqual([]);
});

/**
 * The atomic unit of `holdings cover`. The scheduled pass covers everything
 * uncovered each cycle; this is the one you don't want to wait for.
 */
test.describe("covering a position from the page", () => {
  // Both fixture positions have a live alert (AA a static, TSLA a trailing),
  // so the button is correctly absent until one of them doesn't.
  test("is not offered for a position that already has an alert", async ({ page }) => {
    await storeToken(page);
    await openHoldings(page);
    await expand(page, "AA");
    await expect(detail(page).getByRole("button", { name: /Cover/ })).toHaveCount(0);
  });

  test("queues a cover for a position whose alert is gone", async ({ page }) => {
    // Drop TSLA's trailing alert from the book, which is what removing it
    // would do, and the position becomes uncovered.
    await page.route("**/alerts.json", async (route) => {
      const response = await route.fetch();
      const doc = await response.json();
      doc.alerts = doc.alerts.filter((a: { symbol: string }) => a.symbol !== "TSLA");
      await route.fulfill({ response, json: doc });
    });
    await storeToken(page);
    await openHoldings(page);
    await expand(page, "TSLA");
    const button = detail(page).getByRole("button", { name: "Cover with an alert" });
    await expect(button).toHaveAttribute("title", /higher, the live price or your basis/);
    await button.click();

    const [op] = await queuedOps(page);
    expect(op).toMatchObject({ type: "holdings.cover", target: { symbol: "TSLA" }, params: {} });
    // The level is the worker's to compute (it needs a live quote), so the
    // page's own summary must not invent one.
    await expect(page.locator("#holdings-pending")).toContainText("give TSLA a starting alert");
    await expect(page.locator("#holdings-pending")).not.toContainText("266");
    await expect(detail(page).getByRole("button", { name: "Cover with an alert" })).toHaveCount(0);
  });

  test("is not offered while locked", async ({ page }) => {
    await page.goto("/#/holdings");
    await expect(page.getByRole("button", { name: /Cover/ })).toHaveCount(0);
  });
});

test("a result resolves with the page's own description of the change", async ({ page }) => {
  await storeToken(page);
  await openHoldings(page);
  const form = page.locator("#lot-add form");
  await form.locator("input[type=text]").first().fill("MSFT");
  await form.locator("input[type=number]").nth(0).fill("3");
  await form.locator("input[type=number]").nth(1).fill("410.5");
  await form.locator("button[type=submit]").click();
  await expect(page.locator("#holdings-pending .pending-row")).toHaveCount(1);

  await page.request.get("/__release");
  await poll(page);
  await expect(page.locator("#holdings-pending")).toBeHidden();
  // The "Queued" toast from submitting may still be up, so pick the result's.
  await expect(page.locator("#toasts .toast.ok", { hasText: "Applied:" })).toContainText("Applied: add 3 MSFT @ 410.5.");
});

test("locking hides holdings again", async ({ page }) => {
  await storeToken(page);
  await openHoldings(page);
  await page.locator("#ops-btn").click();
  await expect(page.locator("#nav-holdings")).toBeHidden();
  await expect(page.locator("#holdings tr")).toHaveCount(0);
  await expect(page.locator("#lot-add")).toBeHidden();
  await expect(page.locator("#holdings-status")).toContainText("Unlock editing");
});

test.describe("phone width", () => {
  test.use({ viewport: { width: 400, height: 860 }, isMobile: true, hasTouch: true });

  test("the holdings forms fit without horizontal page scroll", async ({ page }) => {
    await storeToken(page);
    await openHoldings(page);
    await expand(page, "AA");
    await detail(page).getByRole("button", { name: "Edit" }).first().click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
});
