import { expect, test, type Page } from "@playwright/test";
import type { WebullState } from "../../src/holdings/models.js";
import { openVault, sealVault, type VaultContents, type VaultDocument } from "../../src/web/vault.js";
import { OPS_TOKEN } from "../fixtures.js";
import { unlockWith } from "../unlock.js";

/**
 * The Webull panel and kept lots (docs/WEBULL_SYNC_PLAN.md). The fixture vault
 * has no Webull state, so these tests open it, add some, and serve it resealed.
 * Invented figures, like every fixture.
 */
const WEBULL: WebullState = {
  readAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  accounts: [
    {
      label: "margin",
      accountType: "MARGIN",
      cash: { cash: -450, settledCash: -450, unsettledCash: 0, cashEquivalents: 9150, cashEquivalentPrice: 91.5, total: 8700 },
      cashStatus: "usingMargin",
      lowCash: 2000,
      unmatched: [
        {
          symbol: "NEWCO",
          count: 12,
          basis: 18.25,
          lastPrice: 19,
          adopt: [{ count: 12, basisPerShare: 18.25, purchaseDate: "2026-10-01", orderId: "ORDER-0009" }],
          fallback: null,
          ignored: false,
          booked: {},
        },
      ],
      links: [{ symbol: "TSLA", count: 2, basis: 260, webullCount: 2, differences: [], booked: {} }],
      flags: [{ symbol: "OLDCO", message: "Webull holds 20 shares and the record 10, with no fills to explain it. Not applied." }],
      skipped: [],
    },
  ],
};

async function serveVault(page: Page, extra: Partial<VaultContents>) {
  await page.route("**/vault.json", async (route) => {
    const original = (await (await route.fetch()).json()) as VaultDocument;
    const contents = { ...openVault(original, OPS_TOKEN), ...extra };
    await route.fulfill({ json: sealVault(contents, OPS_TOKEN) });
  });
}

async function queuedOps(page: Page): Promise<Array<Record<string, unknown>>> {
  return (await page.request.get("/__ops")).json();
}

const positionRow = (page: Page, symbol: string) => page.locator("#holdings > tbody > tr", { has: page.locator(`a.sym:text-is("${symbol}")`) });
const detail = (page: Page) => page.locator("#holdings tr.detail-row");

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

test("the panel shows cash and the margin warning, and queues Adopt, Ignore and Link", async ({ page }) => {
  await serveVault(page, { webull: WEBULL });
  await page.goto("/#/holdings");
  await expect(page.locator("#webull-panel")).toBeHidden();
  await unlockWith(page, OPS_TOKEN);

  const panel = page.locator("#webull-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("margin · Webull margin account");
  await expect(panel.locator(".tag.using-margin")).toHaveText("using margin");
  // -450 at 91.50 a share: 4.9, so 5 whole shares.
  await expect(panel).toContainText("Sell about 5 shares of BIL to cover.");
  await expect(panel).toContainText("OLDCO");
  await expect(panel).not.toContainText("null");

  await panel.locator("li", { hasText: "NEWCO" }).getByRole("button", { name: "Adopt" }).click();
  await panel.locator("li", { hasText: "TSLA" }).getByRole("button", { name: "Link" }).click();
  await panel.locator("li", { hasText: "NEWCO" }).getByRole("button", { name: "Ignore" }).click();

  const ops = await queuedOps(page);
  expect(ops.map((o) => o.type)).toEqual(["holding.adopt", "holding.link", "holding.ignore"]);
  expect(ops[0]).toMatchObject({ target: { account: "margin", symbol: "NEWCO" }, expect: { count: 12 } });
  expect(ops[1]).toMatchObject({ target: { account: "margin", symbol: "TSLA" }, expect: { count: 2 } });
  expect(ops[2]).toMatchObject({ params: { ignore: true } });
});

test("a lot the sync keeps can't be edited or sold by hand, and can be unlinked", async ({ page }) => {
  await serveVault(page, { webull: WEBULL, holdingSources: [{ account: "margin", symbol: "AA", source: "webull" }] });
  await page.goto("/#/holdings");
  await unlockWith(page, OPS_TOKEN);
  await positionRow(page, "AA").locator("td").nth(2).click();
  await expect(detail(page)).toBeVisible();

  const lots = detail(page).locator("table.lots > tbody > tr:not(.lot-edit)");
  const margin = lots.filter({ hasText: "margin" });
  const roth = lots.filter({ hasText: "roth" });
  await expect(margin.locator(".tag.webull")).toHaveText("Webull");
  await expect(margin.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(roth.getByRole("button", { name: "Edit" })).toHaveCount(1);

  // A sale names its account, so it can't reach the kept lot.
  await detail(page).getByRole("button", { name: "Sell from position" }).click();
  const options = await detail(page).locator(".sell-band select option").allTextContents();
  expect(options).not.toContain("Oldest lots first");
  expect(options).toContain("Oldest in roth first");

  // A second click within a few seconds confirms; the button relabels itself in between.
  await detail(page).getByRole("button", { name: "Unlink margin from Webull" }).click();
  await detail(page).getByRole("button", { name: "Click again to confirm" }).click();
  await expect.poll(async () => (await queuedOps(page)).length).toBe(1);
  const ops = await queuedOps(page);
  expect(ops[0]).toMatchObject({ type: "holding.unlink", target: { account: "margin", symbol: "AA" } });
});
