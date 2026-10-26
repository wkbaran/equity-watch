/**
 * Webull OpenAPI client for the Trading API: accounts, balances, positions,
 * order history and open orders, and placing, changing and cancelling stock
 * orders. Only src/orders/ sends orders, behind its kill switch, authenticator
 * code and limits (docs/WEBULL_SYNC_PLAN.md).
 *
 * Like schwab.ts, this talks to the REST API with `fetch` rather than through
 * a client library. Webull's only official SDK is Python. Paths and fields
 * follow the reference at https://developer.webull.com/apis/docs/ (its .md
 * pages embed the OpenAPI definition) and the Python SDK, checked 2026-10-25.
 *
 * Two credentials, both from Webull:
 *   - **App Key and App Secret** sign every request (`webullSignature`). The
 *     secret never goes over the wire.
 *   - **An access token**, required when the account has 2FA on. It is created
 *     by API call and activated by entering an SMS code in the Webull app within
 *     5 minutes (`webull-login`). It then lasts until 15 days pass with no call,
 *     so the scheduled runs keep it alive. There is no refresh: a dead token
 *     means logging in again.
 *
 * Webull returns every number as a string. The normalizers below parse them
 * once, here, so nothing downstream sees `"11.12"`.
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RateLimiter } from "./rateLimiter.js";

export const WEBULL_HOSTS = {
  production: "api.webull.com",
  sandbox: "api.sandbox.webull.com",
} as const;

export type WebullEnvironment = keyof typeof WEBULL_HOSTS;

/** Earliest start Webull's order history accepts: the day its brokerage opened. */
export const WEBULL_HISTORY_START = "2018-05-21T00:00:00.000Z";

const SIGNATURE_ALGORITHM = "HMAC-SHA1";
const SIGNATURE_VERSION = "1.0";
const API_VERSION = "v3";

/** How long `webull-login` waits for the code to be entered in the app: Webull's own 5-minute window. */
const TOKEN_VERIFY_WINDOW_MS = 5 * 60 * 1000;
const TOKEN_POLL_INTERVAL_MS = 5000;

/**
 * Percent-encoding as Python's `urllib.parse.quote(s, safe="")`, which is what
 * Webull's reference implementation signs with: everything but letters, digits
 * and `-._~`. `encodeURIComponent` alone leaves `!'()*` bare, which would sign
 * a different string the moment one of them appeared in a value.
 */
function strictEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface SignatureInput {
  path: string;
  query: Record<string, string>;
  /** The exact body string sent, or null for none. */
  body: string | null;
  appKey: string;
  appSecret: string;
  host: string;
  timestamp: string;
  nonce: string;
}

/**
 * Webull's request signature (authentication/signature.md):
 *
 *   str1 = query params and signing headers, sorted by name, as k=v joined by &
 *   str2 = upper(md5(body)), only when there is a body
 *   sign = base64(hmac_sha1(secret + "&", quote(path + "&" + str1 [+ "&" + str2])))
 *
 * Values are signed raw; only the assembled string is encoded. The docs' worked
 * example is a test (tests/webull.test.ts), since a wrong signature only ever
 * shows up as a 401.
 */
export function webullSignature(input: SignatureInput): string {
  const params: Record<string, string> = {
    ...input.query,
    "x-app-key": input.appKey,
    "x-signature-algorithm": SIGNATURE_ALGORITHM,
    "x-signature-version": SIGNATURE_VERSION,
    "x-signature-nonce": input.nonce,
    "x-timestamp": input.timestamp,
    host: input.host,
  };
  const str1 = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  let str3 = `${input.path}&${str1}`;
  if (input.body) {
    str3 += `&${createHash("md5").update(input.body, "utf8").digest("hex").toUpperCase()}`;
  }
  return createHmac("sha1", `${input.appSecret}&`).update(strictEncode(str3), "utf8").digest("base64");
}

/** `YYYY-MM-DDThh:mm:ssZ`: Webull rejects milliseconds in `x-timestamp`. */
function signingTimestamp(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export class WebullError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** The token is missing, unverified or dead: only `webull-login` fixes it. */
export class WebullAuthError extends Error {}

export type WebullTokenStatus = "PENDING" | "NORMAL" | "INVALID" | "EXPIRED";

export interface WebullToken {
  token: string;
  /** Unix ms. */
  expiresAt: number;
  status: WebullTokenStatus;
}

export function loadWebullToken(path: string): WebullToken | null {
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf-8")) as WebullToken;
}

function saveWebullToken(path: string, token: WebullToken): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // A bearer credential for accounts that can trade: user-readable only, from
  // the moment it exists (the mode applies on create, the chmod to an older file).
  writeFileSync(path, JSON.stringify(token, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export interface WebullClientOptions {
  appKey: string;
  appSecret: string;
  environment?: WebullEnvironment;
  /** Where the access token is kept. Omitted, no token is sent (2FA off, or the sandbox). */
  tokenPath?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Least time between two calls, ms. Tests pass 0. */
  spacingMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * At most one call per 1.25 s. Production allows 2 calls per 2 s on balances,
 * positions and history (rate-limits.md). Two-per-two-seconds as this machine
 * measures it still drew 429s (2026-10-25, the first real history read):
 * requests don't arrive spaced the way they left, and Webull counts on arrival.
 * One call per 1.25 s keeps any three of them more than 2 s apart even with a
 * quarter second of jitter.
 */
const DEFAULT_SPACING_MS = 1250;
/** Retries of a 429, each waiting a little longer, before the sync gives up for this run. */
const RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BACKOFF_MS = 2500;

// --- normalized shapes ------------------------------------------------------

export interface WebullAccount {
  accountId: string;
  /** MARGIN or CASH. A Roth IRA is CASH. */
  accountType: string;
  /** e.g. INDIVIDUAL_MARGIN, ROTH_IRA. */
  accountClass: string;
  /** e.g. "Individual Margin", "Roth IRA". */
  label: string;
}

export interface WebullBalance {
  /** Can go negative in a margin account: that is borrowing. */
  cash: number;
  settledCash: number | null;
  unsettledCash: number | null;
  buyingPower: number | null;
  marketValue: number;
  netLiquidation: number;
}

export interface WebullPosition {
  symbol: string;
  /** EQUITY, OPTION, ... Only EQUITY is synced. */
  instrumentType: string;
  quantity: number;
  /** Average cost per share. */
  costPrice: number;
  lastPrice: number;
}

export interface WebullOrder {
  orderId: string;
  clientOrderId: string | null;
  symbol: string;
  instrumentType: string;
  side: "BUY" | "SELL" | "SHORT";
  status: string;
  orderType: string;
  timeInForce: string | null;
  totalQuantity: number;
  filledQuantity: number;
  /** Average price of what filled; null when nothing has. */
  filledPrice: number | null;
  limitPrice: number | null;
  stopPrice: number | null;
  /** AMOUNT or PERCENTAGE, for a trailing stop. */
  trailingType: string | null;
  trailingStep: number | null;
  /** NORMAL for a simple order; MASTER, STOP_LOSS, OTO... for a leg of a combo. */
  comboType: string | null;
  placedAt: string | null;
  /** When the last part filled (ISO, UTC); null when nothing has. */
  filledAt: string | null;
}

/** Statuses of an order that can still fill. */
export const WORKING_STATUSES = new Set(["PENDING", "SUBMITTED", "PARTIAL_FILLED"]);

/** One order as Place Order takes it (a `new_orders` entry). Prices and quantities are strings, as Webull wants. */
export interface NewOrder {
  client_order_id: string;
  combo_type: "NORMAL" | "MASTER" | "STOP_LOSS";
  symbol: string;
  instrument_type: "EQUITY";
  market: "US";
  side: "BUY" | "SELL";
  order_type: "LIMIT" | "STOP_LOSS" | "STOP_LOSS_LIMIT";
  quantity: string;
  time_in_force: "DAY" | "GTC";
  support_trading_session: "CORE" | "ALL";
  entrust_type: "QTY";
  limit_price?: string;
  stop_price?: string;
}

/** A change to an open order (a `modify_orders` entry): only what changes, plus the id. */
export interface OrderChange {
  client_order_id: string;
  quantity?: string;
  limit_price?: string;
  stop_price?: string;
  time_in_force?: "DAY" | "GTC";
}

export interface OrderPlaced {
  orderId: string | null;
  clientOrderId: string | null;
  comboOrderId: string | null;
}

export interface OrderPreview {
  estimatedCost: number;
  estimatedFee: number;
}

/** A string field, or "" when it is missing or not a string or number. */
function str(raw: unknown): string {
  return typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "";
}

function num(raw: unknown): number {
  const parsed = typeof raw === "number" ? raw : parseFloat(str(raw));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function optNum(raw: unknown): number | null {
  const n = num(raw);
  return Number.isFinite(n) ? n : null;
}

function optStr(raw: unknown): string | null {
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/** Epoch-ms string or ISO string to ISO; the docs give both, and either may be missing. */
function isoTime(atIso: unknown, atMs: unknown): string | null {
  const iso = optStr(atIso);
  if (iso !== null && !Number.isNaN(Date.parse(iso))) {
    return new Date(iso).toISOString();
  }
  const ms = optNum(atMs);
  return ms !== null && ms > 0 ? new Date(ms).toISOString() : null;
}

type Raw = Record<string, unknown>;

export function normalizeAccount(raw: Raw): WebullAccount {
  return {
    accountId: str(raw.account_id),
    accountType: str(raw.account_type),
    accountClass: str(raw.account_class),
    label: str(raw.account_label),
  };
}

export function normalizeBalance(raw: Raw): WebullBalance {
  const assets = Array.isArray(raw.account_currency_assets) ? (raw.account_currency_assets as Raw[]) : [];
  const usd = assets.find((a) => a.currency === "USD") ?? assets[0] ?? {};
  const cash = optNum(usd.cash_balance) ?? num(raw.total_cash_balance);
  return {
    cash,
    settledCash: optNum(usd.settled_cash),
    unsettledCash: optNum(usd.unsettled_cash),
    buyingPower: optNum(usd.buying_power),
    marketValue: num(raw.total_market_value),
    netLiquidation: num(raw.total_net_liquidation_value),
  };
}

export function normalizePosition(raw: Raw): WebullPosition {
  return {
    symbol: str(raw.symbol).toUpperCase(),
    instrumentType: str(raw.instrument_type),
    quantity: num(raw.quantity),
    costPrice: num(raw.cost_price),
    lastPrice: num(raw.last_price),
  };
}

function normalizeOrder(raw: Raw): WebullOrder {
  const filledQuantity = num(raw.filled_quantity);
  return {
    orderId: str(raw.order_id),
    clientOrderId: optStr(raw.client_order_id),
    symbol: str(raw.symbol).toUpperCase(),
    instrumentType: str(raw.instrument_type),
    side: str(raw.side) as WebullOrder["side"],
    status: str(raw.status),
    orderType: str(raw.order_type),
    timeInForce: optStr(raw.time_in_force),
    totalQuantity: num(raw.total_quantity),
    filledQuantity: Number.isFinite(filledQuantity) ? filledQuantity : 0,
    filledPrice: optNum(raw.filled_price) || null,
    limitPrice: optNum(raw.limit_price),
    stopPrice: optNum(raw.stop_price),
    trailingType: optStr(raw.trailing_type),
    trailingStep: optNum(raw.trailing_stop_step),
    comboType: optStr(raw.combo_type),
    placedAt: isoTime(raw.place_time_at, raw.place_time),
    filledAt: isoTime(raw.filled_time_at, raw.filled_time),
  };
}

/**
 * Order history pages hold groups (`data[]`), each with its orders (`orders[]`):
 * one for a simple order, several for a combo. Flattened, since a combo's legs
 * fill as separate trades.
 */
export function normalizeOrderPage(raw: Raw): { orders: WebullOrder[]; next: string | null } {
  const groups = Array.isArray(raw.data) ? (raw.data as Raw[]) : [];
  const orders = groups.flatMap((g) => (Array.isArray(g.orders) ? (g.orders as Raw[]) : [g])).map(normalizeOrder);
  return { orders, next: optStr(raw.pagination_key) };
}

// --- client -----------------------------------------------------------------

export class WebullClient {
  private readonly appKey: string;
  private readonly appSecret: string;
  readonly host: string;
  private readonly tokenPath: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  // Shared across endpoints, though Webull counts each on its own: simpler, and
  // the sync makes only a handful of calls besides paging through history.
  private readonly limiter: RateLimiter;

  constructor(options: WebullClientOptions) {
    this.appKey = options.appKey;
    this.appSecret = options.appSecret;
    this.host = WEBULL_HOSTS[options.environment ?? "production"];
    this.tokenPath = options.tokenPath;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.limiter = new RateLimiter(1, options.spacingMs ?? DEFAULT_SPACING_MS);
  }

  /**
   * One call, retried on 429 Too Many Requests after a growing wait, which is
   * what Webull asks for ("implement proper retry logic"; repeated 429s can get
   * the IP blocked for a while). Each attempt is signed afresh: the nonce must
   * not repeat.
   */
  private async request(method: "GET" | "POST", path: string, query: Record<string, string>, body: unknown, token: string | null): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(method, path, query, body, token);
      } catch (err) {
        if (!(err instanceof WebullError) || err.status !== 429 || attempt >= RATE_LIMIT_RETRIES) {
          throw err;
        }
        await this.sleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
      }
    }
  }

  private async attempt(method: "GET" | "POST", path: string, query: Record<string, string>, body: unknown, token: string | null): Promise<unknown> {
    await this.limiter.acquire();
    const bodyString = body === undefined ? null : JSON.stringify(body);
    const timestamp = signingTimestamp(this.now());
    const nonce = randomUUID().replace(/-/g, "");
    const signature = webullSignature({ path, query, body: bodyString, appKey: this.appKey, appSecret: this.appSecret, host: this.host, timestamp, nonce });
    const headers: Record<string, string> = {
      "x-app-key": this.appKey,
      "x-timestamp": timestamp,
      "x-signature": signature,
      "x-signature-algorithm": SIGNATURE_ALGORITHM,
      "x-signature-version": SIGNATURE_VERSION,
      "x-signature-nonce": nonce,
      "x-version": API_VERSION,
    };
    if (token !== null) {
      headers["x-access-token"] = token;
    }
    if (bodyString !== null) {
      headers["Content-Type"] = "application/json";
    }
    const qs = Object.entries(query)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const url = `https://${this.host}${path}${qs ? `?${qs}` : ""}`;
    const response = await this.fetchImpl(url, { method, headers, ...(bodyString !== null ? { body: bodyString } : {}) });
    const text = await response.text();
    if (!response.ok) {
      throw new WebullError(`Webull ${method} ${path} failed (${response.status}): ${text.slice(0, 500)}`, response.status);
    }
    return text.length > 0 ? JSON.parse(text) : null;
  }

  /** The stored token for a trading call, or a WebullAuthError saying to log in. */
  private activeToken(): string | null {
    if (this.tokenPath === undefined) {
      return null;
    }
    const stored = loadWebullToken(this.tokenPath);
    if (stored === null) {
      throw new WebullAuthError(`No Webull token at ${this.tokenPath}. Run \`equity-watch webull-login\` first.`);
    }
    if (stored.status !== "NORMAL") {
      throw new WebullAuthError(`The Webull token is ${stored.status}. Run \`equity-watch webull-login\` again.`);
    }
    return stored.token;
  }

  private async get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    return this.call("GET", path, query, undefined);
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    return this.call("POST", path, {}, body);
  }

  private async call(method: "GET" | "POST", path: string, query: Record<string, string>, body: unknown): Promise<unknown> {
    try {
      return await this.request(method, path, query, body, this.activeToken());
    } catch (err) {
      // Webull answers a dead token with 401. Record it, so the next run says
      // "log in" up front rather than failing the same way again.
      if (err instanceof WebullError && err.status === 401 && this.tokenPath !== undefined) {
        const stored = loadWebullToken(this.tokenPath);
        if (stored !== null) {
          saveWebullToken(this.tokenPath, { ...stored, status: "INVALID" });
        }
        throw new WebullAuthError(`Webull refused the token (401). Run \`equity-watch webull-login\` again. ${err.message}`);
      }
      throw err;
    }
  }

  /**
   * Create a token (or revive the stored one) and wait for its SMS code to be
   * entered in the Webull app. `onPending` is told once, so the caller can say
   * what to do. Resolves with the NORMAL token, already saved.
   */
  async login(onPending: (token: WebullToken) => void, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<WebullToken> {
    if (this.tokenPath === undefined) {
      throw new WebullAuthError("No token path configured.");
    }
    const previous = loadWebullToken(this.tokenPath);
    // Sending the stored token back revives it when it is still good, instead
    // of asking for another SMS (what the SDK does at startup).
    const created = parseToken(await this.request("POST", "/auth/tokens/create", {}, previous ? { token: previous.token } : {}, null));
    saveWebullToken(this.tokenPath, created);
    if (created.status === "NORMAL") {
      return created;
    }
    onPending(created);
    const deadline = this.now().getTime() + TOKEN_VERIFY_WINDOW_MS;
    while (this.now().getTime() < deadline) {
      await sleep(TOKEN_POLL_INTERVAL_MS);
      const checked = parseToken(await this.request("POST", "/auth/tokens/check", {}, { token: created.token }, null));
      saveWebullToken(this.tokenPath, checked);
      if (checked.status === "NORMAL") {
        return checked;
      }
      if (checked.status === "INVALID" || checked.status === "EXPIRED") {
        throw new WebullAuthError(`The Webull token became ${checked.status} before it was verified. Run webull-login again.`);
      }
    }
    throw new WebullAuthError("The code wasn't entered in the Webull app within 5 minutes. Run webull-login again.");
  }

  async accounts(): Promise<WebullAccount[]> {
    const raw = await this.get("/trading/accounts/list");
    return (Array.isArray(raw) ? (raw as Raw[]) : []).map(normalizeAccount);
  }

  async balance(accountId: string): Promise<WebullBalance> {
    return normalizeBalance((await this.get("/trading/assets/balances/get", { account_id: accountId })) as Raw);
  }

  async positions(accountId: string): Promise<WebullPosition[]> {
    const raw = await this.get("/trading/assets/positions/list", { account_id: accountId });
    return (Array.isArray(raw) ? (raw as Raw[]) : []).map(normalizePosition);
  }

  /** Every order from `startIso` to `endIso` (both `...T00:00:00.000Z` form), across all pages. */
  async orderHistory(accountId: string, startIso: string, endIso: string): Promise<WebullOrder[]> {
    const orders: WebullOrder[] = [];
    let key: string | null = null;
    // A page cap, so a server that keeps returning a key can't loop forever.
    for (let page = 0; page < 1000; page++) {
      const query: Record<string, string> = { account_id: accountId, start_time: startIso, end_time: endIso };
      if (key !== null) {
        query.pagination_key = key;
      }
      const result = normalizeOrderPage((await this.get("/trading/orders/historical-orders/list", query)) as Raw);
      orders.push(...result.orders);
      if (result.next === null || result.next === key) {
        return orders;
      }
      key = result.next;
    }
    throw new WebullError("Webull order history did not stop paging after 1000 pages.", 0);
  }

  /** The account's working orders (any instrument), across all pages. */
  async openOrders(accountId: string): Promise<WebullOrder[]> {
    const orders: WebullOrder[] = [];
    let key: string | null = null;
    for (let page = 0; page < 100; page++) {
      const query: Record<string, string> = { account_id: accountId };
      if (key !== null) {
        query.pagination_key = key;
      }
      const result = normalizeOrderPage((await this.get("/trading/orders/open-orders/list", query)) as Raw);
      orders.push(...result.orders);
      if (result.next === null || result.next === key) {
        return orders;
      }
      key = result.next;
    }
    throw new WebullError("Webull open orders did not stop paging after 100 pages.", 0);
  }

  /** One order (or a combo's legs) by the client id it was placed with; the current status, unlike history. */
  async orderDetail(accountId: string, clientOrderId: string): Promise<WebullOrder[]> {
    const raw = (await this.get("/trading/orders/get", { account_id: accountId, client_order_id: clientOrderId })) as Raw;
    const legs = Array.isArray(raw?.orders) ? (raw.orders as Raw[]) : [raw];
    return legs.map(normalizeOrder);
  }

  /** What an order would cost, without placing it. Simple orders only (Webull: no combos). */
  async previewOrder(accountId: string, order: NewOrder): Promise<OrderPreview> {
    const raw = (await this.post("/trading/orders/preview", { account_id: accountId, new_orders: [order] })) as Raw;
    return { estimatedCost: num(raw?.estimated_cost), estimatedFee: num(raw?.estimated_transaction_fee) };
  }

  /**
   * Places one order, or a combo (a MASTER buy with its STOP_LOSS leg) under
   * `clientComboOrderId`. Each `client_order_id` must be new for the account:
   * Webull refuses a repeat, which is what makes a redelivered op harmless.
   */
  async placeOrders(accountId: string, orders: NewOrder[], clientComboOrderId?: string): Promise<OrderPlaced> {
    const body = { account_id: accountId, ...(clientComboOrderId !== undefined ? { client_combo_order_id: clientComboOrderId } : {}), new_orders: orders };
    return placedOf(await this.post("/trading/orders/place", body));
  }

  async replaceOrder(accountId: string, change: OrderChange): Promise<OrderPlaced> {
    return placedOf(await this.post("/trading/orders/replace", { account_id: accountId, modify_orders: [change] }));
  }

  async cancelOrder(accountId: string, clientOrderId: string): Promise<OrderPlaced> {
    return placedOf(await this.post("/trading/orders/cancel", { account_id: accountId, client_order_id: clientOrderId }));
  }
}

function placedOf(raw: unknown): OrderPlaced {
  const r = (raw ?? {}) as Raw;
  return { orderId: optStr(r.order_id), clientOrderId: optStr(r.client_order_id), comboOrderId: optStr(r.combo_order_id) };
}

function parseToken(raw: unknown): WebullToken {
  const r = (raw ?? {}) as Raw;
  const token = optStr(r.token);
  const status = optStr(r.status);
  if (token === null || status === null) {
    throw new WebullAuthError(`Unexpected token response from Webull: ${JSON.stringify(raw).slice(0, 200)}`);
  }
  return { token, expiresAt: num(r.expires_at ?? r.expires), status: status as WebullTokenStatus };
}
