/**
 * Ops that decide who keeps a holding (docs/WEBULL_SYNC_PLAN.md), queued from
 * the unlocked Holdings page:
 *
 *   - `holding.adopt`: a Webull position with no lots here becomes a webull
 *     holding, with the lots the last sync proposed.
 *   - `holding.link`: a manual holding whose shares agree with Webull becomes a
 *     webull holding and keeps its lots.
 *   - `holding.unlink`: a webull holding goes back to manual. Its lots stay.
 *   - `holding.ignore`: an unmatched Webull position stops being offered for
 *     adoption (`params.ignore` false offers it again).
 *
 * They act on what the last `holdings sync` recorded in `store.webull`, never on
 * a fresh read: ops pull doesn't talk to Webull. `expect.count` is the Webull
 * share count the page showed, so an op queued before a trade changed the
 * position is refused rather than applied to a different position.
 *
 * Messages are published (opResults), so they name the symbol only: never the
 * account (which account holds what is a fact about the person's money, like a
 * size), a share count or a price. The page's own summary of what it sent says
 * which account.
 */

import { holdingKey, type Holding, type HoldingsStore, type WebullAccountState } from "../holdings/models.js";
import { loadHoldingsStore, saveHoldingsStore } from "../holdings/store.js";
import type { Op, Outcome } from "./apply.js";
import { stringField } from "./validate.js";

const SHARE_EPSILON = 1e-6;
/** A ticker as Webull and Schwab write one: BRK.B, BF-B. */
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.-]{0,14}$/;
/** An account label as lots carry one (validate.ts caps those at 40). */
const ACCOUNT_RE = /^[\w .-]{1,40}$/;

const ok = (symbol: string, message: string): Outcome => ({ symbol, alertId: null, ok: true, message });
const reject = (symbol: string | null, message: string): Outcome => ({ symbol, alertId: null, ok: false, message });

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

/** The holding's record, if it has one. */
export function holdingOf(store: HoldingsStore, account: string | undefined, symbol: string): Holding | undefined {
  if (account === undefined) {
    return undefined;
  }
  const key = holdingKey(account, symbol);
  return (store.holdings ?? []).find((h) => holdingKey(h.account, h.symbol) === key);
}

/** The sync keeps this account's shares of this symbol, so hand edits are refused. */
export function isWebullHolding(store: HoldingsStore, account: string | undefined, symbol: string): boolean {
  return holdingOf(store, account, symbol)?.source === "webull";
}

function upsertHolding(store: HoldingsStore, holding: Holding): void {
  const key = holdingKey(holding.account, holding.symbol);
  store.holdings = [...(store.holdings ?? []).filter((h) => holdingKey(h.account, h.symbol) !== key), holding];
}

function removeHolding(store: HoldingsStore, account: string, symbol: string): void {
  const key = holdingKey(account, symbol);
  store.holdings = (store.holdings ?? []).filter((h) => holdingKey(h.account, h.symbol) !== key);
}

function lotId(store: HoldingsStore, orderId: string | null, n: number): string {
  const base = orderId !== null ? `wb-${orderId.slice(-8)}` : `wb-avg-${n}`;
  let id = base;
  for (let k = 2; store.lots.some((l) => l.id === id); k++) {
    id = `${base}-${k}`;
  }
  return id;
}

export function applyWebullHoldingOp(op: Op, holdingsFile: string, now: Date): Outcome {
  const symbol = stringField(op.target, "symbol")?.trim().toUpperCase() || null;
  const account = stringField(op.target, "account")?.trim() || null;
  if (symbol === null || account === null) {
    return reject(symbol, `${op.type} needs target.symbol and target.account.`);
  }
  if (!SYMBOL_RE.test(symbol) || !ACCOUNT_RE.test(account)) {
    return reject(null, `${op.type} needs a ticker symbol and an account label.`);
  }
  const store = loadHoldingsStore(holdingsFile);
  const state: WebullAccountState | undefined = store.webull?.accounts.find((a) => a.label === account);
  const lotsHere = store.lots.filter((l) => l.account === account && l.symbol.toUpperCase() === symbol);
  const shown = field(op.expect, "count");

  switch (op.type) {
    case "holding.adopt": {
      const entry = state?.unmatched.find((u) => u.symbol === symbol);
      if (store.webull === undefined || entry === undefined) {
        return reject(symbol, `Not adopted: the last Webull sync found no unmatched ${symbol} in that account.`);
      }
      if (lotsHere.length > 0) {
        return reject(symbol, `Not adopted: ${symbol} now has lots in that account. Link it instead.`);
      }
      if (typeof shown !== "number" || Math.abs(shown - entry.count) > SHARE_EPSILON) {
        return reject(symbol, `Not adopted: the ${symbol} position at Webull changed since the page loaded.`);
      }
      entry.adopt.forEach((planned, n) => {
        store.lots.push({
          id: lotId(store, planned.orderId, n + 1),
          symbol,
          count: planned.count,
          basisPerShare: planned.basisPerShare,
          purchaseDate: planned.purchaseDate,
          createdAt: now.toISOString(),
          account,
          ...(planned.orderId !== null ? { orderId: planned.orderId } : {}),
        });
      });
      upsertHolding(store, { account, symbol, source: "webull", linkedAt: store.webull.readAt, booked: { ...entry.booked } });
      // It is a holding now, not a proposal: the next sync recomputes the rest.
      state!.unmatched = state!.unmatched.filter((u) => u.symbol !== symbol);
      saveHoldingsStore(holdingsFile, store);
      return ok(symbol, `Adopted ${symbol} in that account from Webull${entry.fallback !== null ? " at its average cost" : ""}.`);
    }

    case "holding.link": {
      const entry = state?.links.find((l) => l.symbol === symbol);
      if (store.webull === undefined || entry === undefined) {
        return reject(symbol, `Not linked: the last Webull sync didn't find ${symbol} in both the record and that account.`);
      }
      if (isWebullHolding(store, account, symbol)) {
        return reject(symbol, `${symbol} in that account is already kept by the Webull sync.`);
      }
      const local = lotsHere.reduce((sum, l) => sum + l.count, 0);
      if (Math.abs(local - entry.webullCount) > SHARE_EPSILON) {
        return reject(symbol, `Not linked: the record's ${symbol} shares in that account don't match Webull's. Fix the lots first, or adopt after removing them.`);
      }
      if (typeof shown !== "number" || Math.abs(shown - entry.webullCount) > SHARE_EPSILON) {
        return reject(symbol, `Not linked: the ${symbol} position at Webull changed since the page loaded.`);
      }
      upsertHolding(store, { account, symbol, source: "webull", linkedAt: store.webull.readAt, booked: { ...entry.booked } });
      state!.links = state!.links.filter((l) => l.symbol !== symbol);
      saveHoldingsStore(holdingsFile, store);
      return ok(symbol, `Linked ${symbol} in that account to Webull; it keeps its lots.`);
    }

    case "holding.unlink": {
      if (!isWebullHolding(store, account, symbol)) {
        return reject(symbol, `${symbol} in that account isn't kept by the Webull sync.`);
      }
      removeHolding(store, account, symbol);
      saveHoldingsStore(holdingsFile, store);
      return ok(symbol, `${symbol} in that account is manual again; the Webull sync leaves it alone.`);
    }

    case "holding.ignore": {
      const ignore = field(op.params, "ignore") !== false;
      if (isWebullHolding(store, account, symbol)) {
        return reject(symbol, `${symbol} in that account is kept by the Webull sync; unlink it first.`);
      }
      // Only what the last sync offered (or an ignored offer, to un-ignore), so
      // a queued op can't leave records for holdings that don't exist.
      if (state?.unmatched.some((u) => u.symbol === symbol) !== true) {
        return reject(symbol, `Not changed: the last Webull sync offered no ${symbol} in that account.`);
      }
      if (ignore) {
        upsertHolding(store, { account, symbol, source: "manual", ignored: true });
      } else {
        removeHolding(store, account, symbol);
      }
      const entry = state?.unmatched.find((u) => u.symbol === symbol);
      if (entry !== undefined) {
        entry.ignored = ignore;
      }
      saveHoldingsStore(holdingsFile, store);
      return ok(symbol, ignore ? `Ignoring ${symbol} in that account: it won't be offered for adoption.` : `${symbol} in that account is offered for adoption again.`);
    }

    default:
      return reject(symbol, `${op.type} is not a Webull holding op.`);
  }
}
