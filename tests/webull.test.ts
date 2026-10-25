import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeBalance,
  normalizeOrderPage,
  normalizePosition,
  WebullAuthError,
  WebullClient,
  webullSignature,
} from "../src/providers/webull.js";

/**
 * Response bodies are shaped like the examples embedded in Webull's API
 * reference (account-balance.md, account-position.md, order-history.md), with
 * made-up ids. Every number arrives as a string.
 */

describe("webullSignature", () => {
  it("reproduces the worked example in Webull's signature docs", () => {
    // authentication/signature.md: "If your output matches kvlS6opdZDhEBo5jq40nHYXaLvM=, your implementation is correct."
    const signature = webullSignature({
      path: "/trade/place_order",
      query: { a1: "webull", a2: "123", a3: "xxx", q1: "yyy" },
      body: '{"k1":123,"k2":"this is the api request body","k3":true,"k4":{"foo":[1,2]}}',
      appKey: "776da210ab4a452795d74e726ebd74b6",
      appSecret: "0f50a2e853334a9aae1a783bee120c1f",
      host: "api.webull.com",
      timestamp: "2022-01-04T03:55:31Z",
      nonce: "48ef5afed43d4d91ae514aaeafbc29ba",
    });
    expect(signature).toBe("kvlS6opdZDhEBo5jq40nHYXaLvM=");
  });

  it("leaves the body hash out when there is no body", () => {
    const base = {
      path: "/trading/accounts/list",
      query: {},
      appKey: "k",
      appSecret: "s",
      host: "api.webull.com",
      timestamp: "2026-10-25T14:00:00Z",
      nonce: "n",
    };
    expect(webullSignature({ ...base, body: null })).toBe(webullSignature({ ...base, body: "" }));
    expect(webullSignature({ ...base, body: null })).not.toBe(webullSignature({ ...base, body: "{}" }));
  });
});

describe("normalizers", () => {
  it("parses a balance, preferring the USD currency row", () => {
    const b = normalizeBalance({
      total_cash_balance: "-120.50",
      total_market_value: "15000.00",
      total_net_liquidation_value: "14879.50",
      account_currency_assets: [{ currency: "USD", cash_balance: "-120.50", settled_cash: "-300.00", unsettled_cash: "179.50", buying_power: "9000" }],
    });
    expect(b).toEqual({ cash: -120.5, settledCash: -300, unsettledCash: 179.5, buyingPower: 9000, marketValue: 15000, netLiquidation: 14879.5 });
  });

  it("falls back to the total cash balance with no currency rows", () => {
    expect(normalizeBalance({ total_cash_balance: "42", total_market_value: "0", total_net_liquidation_value: "42" }).cash).toBe(42);
  });

  it("parses a position", () => {
    expect(normalizePosition({ symbol: "aaa", instrument_type: "EQUITY", quantity: "12.5", cost_price: "10.0", last_price: "11.12" })).toEqual({
      symbol: "AAA",
      instrumentType: "EQUITY",
      quantity: 12.5,
      costPrice: 10,
      lastPrice: 11.12,
    });
  });

  it("flattens combo groups and reads both time forms", () => {
    const page = normalizeOrderPage({
      data: [
        {
          combo_type: "NORMAL",
          orders: [
            {
              order_id: "O1",
              client_order_id: "C1",
              symbol: "AAA",
              instrument_type: "EQUITY",
              side: "BUY",
              status: "FILLED",
              order_type: "LIMIT",
              total_quantity: "5",
              filled_quantity: "5",
              filled_price: "20.25",
              filled_time: "1761400000000",
            },
          ],
        },
        {
          combo_type: "OTO",
          orders: [
            { order_id: "O2", symbol: "BBB", instrument_type: "EQUITY", side: "BUY", status: "CANCELLED", order_type: "LIMIT", filled_quantity: "0", filled_price: "0" },
            { order_id: "O3", symbol: "BBB", instrument_type: "EQUITY", side: "SELL", status: "SUBMITTED", order_type: "STOP_LOSS", stop_price: "9.5", filled_time_at: "2026-10-20T15:00:00.000Z" },
          ],
        },
      ],
      pagination_key: "next-1",
    });
    expect(page.next).toBe("next-1");
    expect(page.orders.map((o) => o.orderId)).toEqual(["O1", "O2", "O3"]);
    expect(page.orders[0]).toMatchObject({ filledQuantity: 5, filledPrice: 20.25, filledAt: new Date(1761400000000).toISOString() });
    // A zero filled price is "nothing filled", not a price of zero.
    expect(page.orders[1].filledPrice).toBeNull();
    expect(page.orders[2]).toMatchObject({ stopPrice: 9.5, filledAt: "2026-10-20T15:00:00.000Z" });
  });
});

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fakeFetch(responses: ((call: Call) => { status?: number; body: unknown })[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    };
    calls.push(call);
    const next = responses.shift();
    if (next === undefined) {
      throw new Error(`unexpected call ${call.method} ${call.url.pathname}`);
    }
    const { status = 200, body } = next(call);
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { fetch: impl as typeof fetch, calls };
}

function tokenFile(status: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "webull-")), "webull_token.json");
  writeFileSync(path, JSON.stringify({ token: "tok-1", expiresAt: 0, status }));
  return path;
}

describe("WebullClient", () => {
  const now = () => new Date("2026-10-25T14:00:00.123Z");

  it("signs requests, sends the token, and pages through order history", async () => {
    const { fetch, calls } = fakeFetch([
      () => ({ body: { data: [{ orders: [{ order_id: "O1", symbol: "AAA", side: "BUY", filled_quantity: "1", filled_price: "1" }] }], pagination_key: "p2" } }),
      () => ({ body: { data: [{ orders: [{ order_id: "O2", symbol: "AAA", side: "SELL", filled_quantity: "1", filled_price: "2" }] }] } }),
    ]);
    const client = new WebullClient({ appKey: "key", appSecret: "secret", spacingMs: 0, tokenPath: tokenFile("NORMAL"), fetch, now });
    const orders = await client.orderHistory("ACC1", "2018-05-21T00:00:00.000Z", "2026-10-25T00:00:00.000Z");

    expect(orders.map((o) => o.orderId)).toEqual(["O1", "O2"]);
    expect(calls[0].url.host).toBe("api.webull.com");
    expect(calls[0].url.searchParams.get("account_id")).toBe("ACC1");
    expect(calls[0].url.searchParams.get("pagination_key")).toBeNull();
    expect(calls[1].url.searchParams.get("pagination_key")).toBe("p2");
    const h = calls[0].headers;
    expect(h["x-access-token"]).toBe("tok-1");
    expect(h["x-version"]).toBe("v3");
    // Whole seconds: Webull's format has no milliseconds.
    expect(h["x-timestamp"]).toBe("2026-10-25T14:00:00Z");
    expect(h["x-signature"]).toBe(
      webullSignature({
        path: "/trading/orders/historical-orders/list",
        query: { account_id: "ACC1", start_time: "2018-05-21T00:00:00.000Z", end_time: "2026-10-25T00:00:00.000Z" },
        body: null,
        appKey: "key",
        appSecret: "secret",
        host: "api.webull.com",
        timestamp: h["x-timestamp"],
        nonce: h["x-signature-nonce"],
      })
    );
  });

  it("uses the sandbox host and sends no token without a token path", async () => {
    const { fetch, calls } = fakeFetch([() => ({ body: [{ account_id: "A", account_type: "CASH", account_class: "ROTH_IRA", account_label: "Roth IRA" }] })]);
    const client = new WebullClient({ appKey: "key", appSecret: "secret", spacingMs: 0, environment: "sandbox", fetch, now });
    expect(await client.accounts()).toEqual([{ accountId: "A", accountType: "CASH", accountClass: "ROTH_IRA", label: "Roth IRA" }]);
    expect(calls[0].url.host).toBe("api.sandbox.webull.com");
    expect(calls[0].headers["x-access-token"]).toBeUndefined();
  });

  it("refuses to call with a token that isn't NORMAL", async () => {
    const { fetch, calls } = fakeFetch([]);
    const client = new WebullClient({ appKey: "key", appSecret: "secret", spacingMs: 0, tokenPath: tokenFile("INVALID"), fetch, now });
    await expect(client.accounts()).rejects.toBeInstanceOf(WebullAuthError);
    expect(calls).toHaveLength(0);
  });

  it("marks the token INVALID when Webull answers 401", async () => {
    const path = tokenFile("NORMAL");
    const { fetch } = fakeFetch([() => ({ status: 401, body: { message: "token invalid" } })]);
    const client = new WebullClient({ appKey: "key", appSecret: "secret", spacingMs: 0, tokenPath: path, fetch, now });
    await expect(client.positions("A")).rejects.toBeInstanceOf(WebullAuthError);
    expect(JSON.parse(readFileSync(path, "utf-8")).status).toBe("INVALID");
  });

  it("retries a 429 after a wait, then gives up after a few", async () => {
    const waits: number[] = [];
    const sleep = (ms: number) => (waits.push(ms), Promise.resolve());
    const tooMany = () => ({ status: 429, body: { error_code: "TOO_MANY_REQUESTS" } });
    const { fetch, calls } = fakeFetch([tooMany, tooMany, () => ({ body: [] })]);
    const client = new WebullClient({ appKey: "key", appSecret: "secret", spacingMs: 0, sleep, tokenPath: tokenFile("NORMAL"), fetch, now });
    expect(await client.positions("A")).toEqual([]);
    expect(waits).toEqual([2500, 5000]);
    // A fresh nonce each time.
    expect(new Set(calls.map((c) => c.headers["x-signature-nonce"])).size).toBe(3);

    const always = fakeFetch(Array.from({ length: 5 }, () => tooMany));
    const stubborn = new WebullClient({ appKey: "key", appSecret: "secret", spacingMs: 0, sleep, tokenPath: tokenFile("NORMAL"), fetch: always.fetch, now });
    await expect(stubborn.positions("A")).rejects.toMatchObject({ status: 429 });
    expect(always.calls).toHaveLength(5);
  });

  it("logs in: creates a token, waits for verification, saves it", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "webull-")), "webull_token.json");
    const { fetch, calls } = fakeFetch([
      () => ({ body: { token: "new-tok", expires_at: 1900000000000, status: "PENDING" } }),
      () => ({ body: { token: "new-tok", expires_at: 1900000000000, status: "PENDING" } }),
      () => ({ body: { token: "new-tok", expires_at: 1900000000000, status: "NORMAL" } }),
    ]);
    const client = new WebullClient({ appKey: "key", appSecret: "secret", spacingMs: 0, tokenPath: path, fetch, now });
    let told = 0;
    const token = await client.login(() => told++, () => Promise.resolve());

    expect(token.status).toBe("NORMAL");
    expect(told).toBe(1);
    expect(calls.map((c) => c.url.pathname)).toEqual(["/auth/tokens/create", "/auth/tokens/check", "/auth/tokens/check"]);
    expect(calls[1].body).toBe('{"token":"new-tok"}');
    expect(calls[1].headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ token: "new-tok", expiresAt: 1900000000000, status: "NORMAL" });
    const { statSync } = await import("node:fs");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("revives a stored token without asking for a code when Webull says it is still good", async () => {
    const path = tokenFile("NORMAL");
    const { fetch, calls } = fakeFetch([() => ({ body: { token: "tok-1", expires_at: 1900000000000, status: "NORMAL" } })]);
    const client = new WebullClient({ appKey: "key", appSecret: "secret", spacingMs: 0, tokenPath: path, fetch, now });
    let told = 0;
    await client.login(() => told++);
    expect(told).toBe(0);
    expect(calls[0].body).toBe('{"token":"tok-1"}');
  });
});
