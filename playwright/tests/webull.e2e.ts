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

async function serveVault(page: Page, extra: Partial<VaultContents>, patch: (c: VaultContents) => VaultContents = (c) => c) {
  await page.route("**/vault.json", async (route) => {
    const original = (await (await route.fetch()).json()) as VaultDocument;
    const contents = patch({ ...openVault(original, OPS_TOKEN), ...extra });
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

test("a kept position's Webull stops show as orders, flagged short and expiring", async ({ page }) => {
  const placedAt = new Date(Date.now() - 55 * 86_400_000).toISOString();
  await serveVault(page, {
    webull: WEBULL,
    holdingSources: [
      { account: "margin", symbol: "AA", source: "webull" },
      { account: "roth", symbol: "AA", source: "webull" },
    ],
    stops: [
      {
        id: "wb-00000001",
        symbol: "AA",
        count: 3,
        stopPrice: 39,
        webull: { account: "margin", orderId: "ORDER-0001", clientOrderId: "ewORDER0001", orderType: "STOP_LOSS", timeInForce: "GTC", limitPrice: null, placedAt },
      },
    ],
  });
  await page.goto("/#/holdings");
  await unlockWith(page, OPS_TOKEN);
  const row = positionRow(page, "AA");
  await expect(row.locator(".tag.stop-short")).toHaveText("stop short");
  await expect(row.locator(".tag.stop-short")).toHaveAttribute("title", "Webull stops cover 3 of the 15 whole shares held there.");
  await expect(row.locator(".tag.stop-expires")).toHaveText("stop expires");

  await row.locator("td").nth(2).click();
  await expect(detail(page).locator(".stops .tag.webull")).toHaveText("39.00 on 3 · Webull margin");
  // Every share is kept, so the record-keeping Add stop form is gone.
  await expect(detail(page).locator("form.stop-add")).toHaveCount(0);
});

test.describe("orders", () => {
  const ON = { enabled: true, maxValue: 2000, maxPerDay: 10, accounts: null };
  const AA_KEPT = [
    { account: "margin", symbol: "AA", source: "webull" as const },
    { account: "roth", symbol: "AA", source: "webull" as const },
  ];
  const STOP = {
    id: "wb-00000001",
    symbol: "AA",
    count: 5,
    stopPrice: 39,
    webull: { account: "margin", orderId: "ORDER-0001", clientOrderId: "ewclient0001", orderType: "STOP_LOSS", timeInForce: "GTC", limitPrice: null, placedAt: "2026-10-20T15:00:00.000Z" },
  };

  async function openAA(page: Page) {
    await page.goto("/#/holdings");
    await unlockWith(page, OPS_TOKEN);
    await positionRow(page, "AA").locator("td").nth(2).click();
    await expect(detail(page)).toBeVisible();
  }

  test("offers nothing while orders are off", async ({ page }) => {
    await serveVault(page, { webull: WEBULL, holdingSources: AA_KEPT, stops: [STOP] });
    await openAA(page);
    await expect(detail(page).locator("form.stop-place")).toHaveCount(0);
    await expect(detail(page).getByRole("button", { name: "Buy at Webull" })).toHaveCount(0);
    await expect(page.locator("#webull-panel").getByRole("button", { name: "Sell BIL to cover" })).toHaveCount(0);
  });

  test("places and moves a stop, with the code, and shows the watcher's result", async ({ page }) => {
    // The fixture's AA row carries its own stop at 38; make it the stop served here.
    await serveVault(page, { webull: WEBULL, holdingSources: AA_KEPT, stops: [STOP], orders: ON }, (c) => ({
      ...c,
      holdings: c.holdings.map((r) => (r.symbol === "AA" ? { ...r, stops: [STOP.stopPrice] } : r)),
    }));
    await openAA(page);
    const place = detail(page).locator("form.stop-place");
    // Only margin takes orders here (the fixture's Webull state has no Roth), so there is no account to pick.
    await expect(place.getByLabel("Account")).toHaveCount(0);
    await expect(place.getByLabel("Shares")).toHaveValue("5");
    await place.getByLabel("Stop price").fill("38.5");
    // No code: refused on the page, nothing queued.
    await place.getByRole("button", { name: "Place stop at Webull" }).click();
    await expect(page.locator("#toasts .toast.bad")).toContainText("6-digit code");
    expect(await queuedOps(page)).toEqual([]);
    await place.getByLabel("Code").fill("123456");
    await place.getByRole("button", { name: "Place stop at Webull" }).click();
    await expect.poll(async () => (await queuedOps(page)).length).toBe(1);

    const move = detail(page).locator("form.stop-move");
    // 39 is 1.6 ATR under the 47 high close, flagged tight, so the form offers the 2 ATR trail.
    await expect(move.getByLabel(/stop/)).toHaveValue("37.00");
    await move.getByLabel(/stop/).fill("40");
    await move.getByLabel("Code").fill("654321");
    await move.getByRole("button", { name: "Move" }).click();
    await expect.poll(async () => (await queuedOps(page)).length).toBe(2);

    const [placed, moved] = await queuedOps(page);
    expect(placed).toMatchObject({ type: "stop.place", target: { account: "margin", symbol: "AA" }, params: { quantity: 5, stopPrice: 38.5, code: "123456" } });
    expect(moved).toMatchObject({ type: "stop.replace", target: { account: "margin", symbol: "AA", clientOrderId: "ewclient0001" }, expect: { stopPrice: 39, quantity: 5 }, params: { stopPrice: 40, code: "654321" } });

    // The watcher's sealed result for the first one.
    await page.route("**/orders.json", (route) =>
      route.fulfill({ json: sealVault({ results: [{ id: placed.id, type: "stop.place", symbol: "AA", account: "margin", ok: true, message: "Placed a stop order for AA.", detail: "placed: sell 5 AA stop_loss stop 38.50 GTC CORE", at: new Date().toISOString() }] } as never, OPS_TOKEN) })
    );
    await expect(page.locator("#toasts .toast.ok").last()).toContainText("sell 5 AA stop_loss stop 38.50", { timeout: 15_000 });
  });

  test("Sell BIL to cover, on a margin account using margin", async ({ page }) => {
    await serveVault(page, { webull: WEBULL, orders: ON });
    await page.goto("/#/holdings");
    await unlockWith(page, OPS_TOKEN);
    const panel = page.locator("#webull-panel");
    await panel.locator(".cover .code-input").fill("111222");
    await panel.getByRole("button", { name: "Sell BIL to cover" }).click();
    await expect.poll(async () => (await queuedOps(page)).length).toBe(1);
    expect((await queuedOps(page))[0]).toMatchObject({ type: "cash.cover", target: { account: "margin" }, params: { code: "111222" } });
  });

  test("the ticket buys with an attached stop, funded from BIL when cash is short", async ({ page }) => {
    await serveVault(page, { webull: WEBULL, holdingSources: AA_KEPT, stops: [STOP], orders: ON });
    await openAA(page);
    await detail(page).getByRole("button", { name: "Buy at Webull" }).click();
    const ticket = page.locator("dialog.ticket");
    await expect(ticket).toBeVisible();
    await ticket.getByLabel("Shares").fill("3");
    await ticket.getByLabel("Limit price").fill("45");
    // 135 against 82.25 cash and 448.77 with BIL: Fund from BIL ticks itself.
    await expect(ticket.locator("p.note").first()).toContainText("tick Fund from BIL");
    await expect(ticket.getByLabel(/Fund from BIL/)).toBeChecked();
    await ticket.getByLabel(/set a GTC stop/).check();
    await ticket.locator('input[placeholder="stop"]').fill("41");
    await ticket.getByLabel("Authenticator code").fill("222333");
    await ticket.getByRole("button", { name: "Send buy" }).click();
    await expect(ticket).toBeHidden();
    await expect.poll(async () => (await queuedOps(page)).length).toBe(1);
    expect((await queuedOps(page))[0]).toMatchObject({
      type: "order.buy",
      target: { account: "margin", symbol: "AA" },
      params: { quantity: 3, limitPrice: 45, timeInForce: "DAY", session: "CORE", fundFromBil: true, stopPrice: 41, code: "222333" },
    });
  });

  test("cancels an open order from the panel", async ({ page }) => {
    const withOrders = {
      ...WEBULL,
      accounts: [{ ...WEBULL.accounts[0], openOrders: [{ symbol: "OPENCO", orderId: "O9", clientOrderId: "ewz9", side: "BUY" as const, orderType: "LIMIT", quantity: 6, limitPrice: 30, stopPrice: null, trailingType: null, trailingStep: null, timeInForce: "DAY", comboType: "NORMAL", placedAt: null }] }],
    };
    await serveVault(page, { webull: withOrders, orders: ON });
    await page.goto("/#/holdings");
    await unlockWith(page, OPS_TOKEN);
    const orders = page.locator("#webull-panel .open-orders");
    await orders.locator(".code-input").fill("333444");
    await orders.getByRole("button", { name: "Cancel" }).click();
    await expect.poll(async () => (await queuedOps(page)).length).toBe(1);
    expect((await queuedOps(page))[0]).toMatchObject({ type: "order.cancel", target: { account: "margin", symbol: "OPENCO", clientOrderId: "ewz9" }, params: { code: "333444" } });
  });

  test("Move to BIL, beside spare cash", async ({ page }) => {
    const spare = { ...WEBULL, accounts: [{ ...WEBULL.accounts[0], cash: { ...WEBULL.accounts[0].cash!, cash: 1249.4, total: 10399.4 }, cashStatus: "ok" as const }] };
    await serveVault(page, { webull: spare, orders: ON });
    await page.goto("/#/holdings");
    await unlockWith(page, OPS_TOKEN);
    const cash = page.locator("#webull-panel .webull-cash");
    await expect(cash.getByRole("button", { name: "Sell BIL to cover" })).toHaveCount(0);
    await cash.locator(".code-input").fill("444555");
    await cash.getByRole("button", { name: "Move to BIL" }).click();
    await expect.poll(async () => (await queuedOps(page)).length).toBe(1);
    expect((await queuedOps(page))[0]).toMatchObject({ type: "cash.park", target: { account: "margin" }, params: { code: "444555" } });
  });

  test("no Move to BIL when the cash doesn't buy a share", async ({ page }) => {
    const little = { ...WEBULL, accounts: [{ ...WEBULL.accounts[0], cash: { ...WEBULL.accounts[0].cash!, cash: 50, total: 9200 }, cashStatus: "ok" as const }] };
    await serveVault(page, { webull: little, orders: ON });
    await page.goto("/#/holdings");
    await unlockWith(page, OPS_TOKEN);
    await expect(page.locator("#webull-panel .webull-cash")).toBeVisible();
    await expect(page.getByRole("button", { name: "Move to BIL" })).toHaveCount(0);
  });

  test("a position in two accounts can move or cancel each account's stop, and says whose each is", async ({ page }) => {
    const roth = { ...WEBULL.accounts[0], label: "roth", accountType: "CASH", cash: null, cashStatus: "ok" as const, unmatched: [], links: [], flags: [] };
    const ROTH_STOP = { ...STOP, id: "wb-00000002", count: 3, stopPrice: 40, webull: { ...STOP.webull, account: "roth", orderId: "ORDER-0002", clientOrderId: "ewclient0002" } };
    await serveVault(page, {
      webull: { ...WEBULL, accounts: [WEBULL.accounts[0], roth] },
      holdingSources: AA_KEPT,
      stops: [STOP, ROTH_STOP],
      orders: ON,
    });
    await openAA(page);
    await expect(detail(page).locator(".stops .tag.webull")).toHaveText(["39.00 on 5 · Webull margin", "40.00 on 3 · Webull roth"]);
    const rothForm = detail(page).locator("form.stop-move", { has: page.getByLabel("roth stop 40.00 on 3") });
    await rothForm.getByLabel("Code").fill("777888");
    await rothForm.getByRole("button", { name: "Cancel order" }).click();
    await expect.poll(async () => (await queuedOps(page)).length).toBe(1);
    expect((await queuedOps(page))[0]).toMatchObject({ type: "stop.cancel", target: { account: "roth", symbol: "AA", clientOrderId: "ewclient0002" }, expect: { stopPrice: 40 } });
  });

  test("Buy at Webull from the Add a lot form, applying the stop to the whole position", async ({ page }) => {
    await serveVault(page, { webull: WEBULL, holdingSources: AA_KEPT, stops: [STOP], orders: ON });
    await page.goto("/#/holdings");
    await unlockWith(page, OPS_TOKEN);
    const form = page.locator("#lot-add form");
    await form.getByLabel("Symbol").fill("aa");
    await form.getByLabel("Shares", { exact: true }).fill("4");
    await form.getByLabel("Basis / share").fill("45");
    await form.getByLabel("Account").fill("margin");
    await form.getByLabel("Stop price").fill("41");
    await form.getByRole("button", { name: "Buy at Webull" }).click();
    const ticket = page.locator("dialog.ticket");
    await expect(ticket.getByRole("heading")).toHaveText("Buy AA at Webull");
    await expect(ticket.getByLabel("Shares")).toHaveValue("4");
    await expect(ticket.getByLabel("Limit price")).toHaveValue("45.00");
    await expect(ticket.getByLabel(/set a GTC stop/)).toBeChecked();
    await expect(ticket.locator('input[placeholder="stop"]')).toHaveValue("41");
    await ticket.getByLabel("Apply it to the whole position (moves the 39.00 stop on 5 to cover every whole share)").check();
    await ticket.getByLabel("Authenticator code").fill("121212");
    await ticket.getByRole("button", { name: "Send buy" }).click();
    await expect(ticket).toBeHidden();
    await expect.poll(async () => (await queuedOps(page)).length).toBe(1);
    expect((await queuedOps(page))[0]).toMatchObject({
      type: "order.buy",
      target: { account: "margin", symbol: "AA" },
      params: { quantity: 4, limitPrice: 45, stopPrice: 41, stopWhole: true, code: "121212" },
    });
  });

  test("no whole-position option without exactly one stop to move", async ({ page }) => {
    await serveVault(page, { webull: WEBULL, holdingSources: AA_KEPT, stops: [], orders: ON });
    await openAA(page);
    await detail(page).getByRole("button", { name: "Buy at Webull" }).click();
    const ticket = page.locator("dialog.ticket");
    await expect(ticket.getByLabel(/set a GTC stop/)).toBeVisible();
    await expect(ticket.getByLabel(/whole position/)).toBeHidden();
  });

  test("leaves a stop mirrored onto a position out of the panel's open orders", async ({ page }) => {
    const order = { side: "SELL" as const, trailingType: null, trailingStep: null, timeInForce: "GTC", comboType: "NORMAL", placedAt: null, limitPrice: null };
    const withOrders = {
      ...WEBULL,
      accounts: [
        {
          ...WEBULL.accounts[0],
          openOrders: [
            { ...order, symbol: "AA", orderId: "ORDER-0001", clientOrderId: "ewclient0001", orderType: "STOP_LOSS", quantity: 5, stopPrice: 39 },
            { ...order, symbol: "OPENCO", orderId: "O9", clientOrderId: "ewz9", orderType: "STOP_LOSS", quantity: 6, stopPrice: 25 },
          ],
        },
      ],
    };
    await serveVault(page, { webull: withOrders, holdingSources: AA_KEPT, stops: [STOP], orders: ON });
    await openAA(page);
    const orders = page.locator("#webull-panel .open-orders");
    await expect(orders).toContainText("OPENCO");
    await expect(orders).not.toContainText("AA ");
    await expect(detail(page).locator("form.stop-move")).toBeVisible();
  });

  // The fake watcher answers every quote.read with the server's FIXTURE_QUOTE:
  // last 40, bid 39.98, ask 40.02, in the regular session.
  test("the ticket fetches a quote and sets a marketable limit from it, and shows the chart", async ({ page }) => {
    await serveVault(page, { webull: WEBULL, holdingSources: AA_KEPT, stops: [STOP], orders: ON });
    await openAA(page);
    await detail(page).getByRole("button", { name: "Buy at Webull" }).click();
    const ticket = page.locator("dialog.ticket");
    await expect(ticket.locator(".quote-text")).toContainText(/Last 40\.00 at .* · bid 39\.98 \/ ask 40\.02/, { timeout: 10_000 });
    await expect(ticket.getByLabel("Limit price")).toHaveValue("40.20");
    await expect(ticket.getByText("0.5% over the last trade")).toBeVisible();
    await expect(ticket.locator(".quote-warn")).toBeHidden();
    // A quote is not a queued change.
    expect(await queuedOps(page)).toEqual([]);

    await ticket.getByRole("button", { name: "Chart" }).click();
    await expect(ticket.locator("iframe.ticket-chart")).toBeVisible();
    await expect(ticket.locator("iframe.ticket-chart")).toHaveAttribute("src", /tradingview\.com\/embed-widget\/advanced-chart\/#.*AA/);
    await ticket.getByRole("button", { name: "Chart" }).click();
    await expect(ticket.locator("iframe.ticket-chart")).toBeHidden();
  });

  test("a sell's limit goes under the last trade, and a typed limit is never overwritten", async ({ page }) => {
    await serveVault(page, { webull: WEBULL, holdingSources: AA_KEPT, stops: [], orders: ON });
    await openAA(page);
    await detail(page).getByRole("button", { name: "Sell at Webull" }).click();
    const ticket = page.locator("dialog.ticket");
    await expect(ticket.getByLabel("Limit price")).toHaveValue("39.80", { timeout: 10_000 });
    await ticket.getByLabel("Limit price").fill("41");
    await ticket.getByRole("button", { name: "Get price" }).click();
    await expect(ticket.locator(".quote-text")).toContainText("Last 40.00");
    await expect(ticket.getByLabel("Limit price")).toHaveValue("41");
  });

  test("the Add a lot form shows the chart and price for the symbol typed, and its basis stays the ticket's limit", async ({ page }) => {
    await serveVault(page, { webull: WEBULL, holdingSources: AA_KEPT, stops: [STOP], orders: ON });
    await page.goto("/#/holdings");
    await unlockWith(page, OPS_TOKEN);
    const form = page.locator("#lot-add form");
    await form.getByLabel("Symbol").fill("newco");
    await form.getByLabel("Shares", { exact: true }).click();
    await expect(form.locator(".quote-text")).toContainText("Last 40.00", { timeout: 10_000 });
    await form.getByRole("button", { name: "Chart" }).click();
    await expect(page.locator("#chart-panel")).toBeVisible();
    await expect(page.locator("#chart-title")).toHaveText("NEWCO");
    await page.keyboard.press("Escape");

    await form.getByLabel("Basis / share").fill("45");
    await form.getByLabel("Account").fill("margin");
    await form.getByRole("button", { name: "Buy at Webull" }).click();
    const ticket = page.locator("dialog.ticket");
    await expect(ticket.locator(".quote-text")).toContainText("Last 40.00", { timeout: 10_000 });
    await expect(ticket.getByLabel("Limit price")).toHaveValue("45.00");
    expect(await queuedOps(page)).toEqual([]);
  });
});

test("with orders off, the Add a lot form offers the chart but no price", async ({ page }) => {
  await page.goto("/#/holdings");
  await unlockWith(page, OPS_TOKEN);
  const form = page.locator("#lot-add form");
  await expect(form.getByRole("button", { name: "Chart" })).toBeVisible();
  await expect(form.getByRole("button", { name: "Get price" })).toHaveCount(0);
});

test("a cash-parking position shows its lots and story, but no Stop or Alert band", async ({ page }) => {
  await serveVault(page, { webull: WEBULL }, (c) => ({ ...c, holdings: c.holdings.map((r) => (r.symbol === "TSLA" ? { ...r, ignored: true } : r)) }));
  await page.goto("/#/holdings");
  await unlockWith(page, OPS_TOKEN);
  await positionRow(page, "TSLA").locator("td").nth(2).click();
  await expect(detail(page).locator("table.lots")).toBeVisible();
  await expect(detail(page).locator(".stops")).toHaveCount(0);
  await expect(detail(page).locator(".alert-col")).toHaveCount(0);
});
