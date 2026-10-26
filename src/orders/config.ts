/**
 * The order path's settings, all from .env (never the committed config: they
 * say how much the person trades), and the watcher's own small state.
 *
 *   WEBULL_ORDERS=on          the kill switch; anything else refuses every order op
 *   ORDERS_TOTP_SECRET=...    base32, from `equity-watch orders totp-setup`
 *   ORDERS_MAX_VALUE=2000     the largest buy, in dollars (estimated cost)
 *   ORDERS_MAX_PER_DAY=10     orders sent per New York trading date, all kinds
 *   ORDERS_ACCOUNTS=margin    labels that may trade (default: every mapped one)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { base32Decode } from "./totp.js";

export interface OrdersConfig {
  enabled: boolean;
  totpSecret: string | null;
  maxValue: number;
  maxPerDay: number;
  /** null: every account WEBULL_ACCOUNTS maps. */
  accounts: Set<string> | null;
}

export const DEFAULT_MAX_VALUE = 2000;
export const DEFAULT_MAX_PER_DAY = 10;

function positiveNumber(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const n = Number(raw.replace(/[$,]/g, ""));
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a number above 0, not "${raw}".`);
  }
  return n;
}

export function ordersConfig(env: NodeJS.ProcessEnv = process.env): OrdersConfig {
  const secret = env.ORDERS_TOTP_SECRET?.trim() || null;
  if (secret !== null && base32Decode(secret).length < 10) {
    throw new Error("ORDERS_TOTP_SECRET is too short: make one with `equity-watch orders totp-setup`.");
  }
  const accounts = env.ORDERS_ACCOUNTS?.trim();
  return {
    enabled: env.WEBULL_ORDERS?.trim().toLowerCase() === "on",
    totpSecret: secret,
    maxValue: positiveNumber(env.ORDERS_MAX_VALUE, "ORDERS_MAX_VALUE", DEFAULT_MAX_VALUE),
    maxPerDay: Math.floor(positiveNumber(env.ORDERS_MAX_PER_DAY, "ORDERS_MAX_PER_DAY", DEFAULT_MAX_PER_DAY)),
    accounts: accounts ? new Set(accounts.split(",").map((a) => a.trim()).filter(Boolean)) : null,
  };
}

/** What the watcher remembers between orders: spent authenticator steps, and today's count. */
export interface OrdersState {
  usedTotpSteps: number[];
  day: string;
  sentToday: number;
}

export const DEFAULT_ORDERS_STATE_FILE = "orders-state.json";

export function loadOrdersState(path: string): OrdersState {
  if (!existsSync(path)) {
    return { usedTotpSteps: [], day: "", sentToday: 0 };
  }
  return JSON.parse(readFileSync(path, "utf-8")) as OrdersState;
}

export function saveOrdersState(path: string, state: OrdersState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, path);
}
