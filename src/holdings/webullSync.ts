/**
 * What `holdings sync` changes, worked out from a read of each mapped Webull
 * account against holdings.json (docs/WEBULL_SYNC_PLAN.md).
 *
 * `planWebullSync` is pure: the CLI fetches, this decides. `applySyncPlan`
 * then writes the plan into a store in memory, and the CLI saves it once.
 *
 * The unit is a holding, one account's position in one symbol, because that is
 * what Webull reports. Each one ends up in exactly one of:
 *
 *   - **unmatched**: Webull holds it and the record has no lots for it in that
 *     account. Adopting (an op from the page) builds lots from the fills, or
 *     one lot at Webull's average cost when the fills don't explain the whole
 *     position. Nothing is written until then.
 *   - **link**: a manual holding Webull also holds. Linking (an op) keeps the
 *     existing lots, and their dates and story, when the shares agree.
 *   - **sync**: a webull holding. Its unbooked fills become buys and sales, but
 *     only when they account exactly for the change in shares; anything else is
 *     flagged and nothing is applied.
 *   - **notAtWebull**: the record has lots in a mapped account that Webull
 *     doesn't hold. A webull holding's closing sales are applied like any other.
 */

import { marketDate } from "../marketHours.js";
import type { WebullBalance, WebullOrder, WebullPosition } from "../providers/webull.js";
import { sellFromStore } from "./engine.js";
import {
  holdingKey,
  type CashStatus,
  type CashSummary,
  type Holding,
  type HoldingsStore,
  type Lot,
  type PlannedLot,
  type WebullAccountState,
  type WebullState,
} from "./models.js";

export type { PlannedLot } from "./models.js";

/** Shares are compared to this: Webull allows fractional shares, and its strings round. */
const SHARE_EPSILON = 1e-6;
/** A basis this close to Webull's average cost agrees with it. */
const BASIS_TOLERANCE = 0.001;
/**
 * Webull reports average cost rounded to the cent: a $2.41 stock whose fills
 * average 2.4132 shows as 2.41, 0.13% off, which the relative tolerance alone
 * flags (a real position, on the first production dry run, 2026-10-25). Within half a cent
 * is that rounding, not a difference.
 */
const BASIS_ROUNDING = 0.005;

const STOP_ORDER_TYPES = new Set(["STOP_LOSS", "STOP_LOSS_LIMIT", "TRAILING_STOP_LOSS"]);

export interface WebullAccountSnapshot {
  /** The lots' account label this Webull account maps to. */
  label: string;
  accountId: string;
  accountType: string;
  balance: WebullBalance | null;
  positions: WebullPosition[];
  /** Order history over the fetched window, any status. */
  orders: WebullOrder[];
  /** Start of the order-history window, ISO. Fills before it are unseen. */
  historyFrom: string;
}

/** One order's filled part, as a trade. */
export interface Fill {
  orderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  /** ISO instant of the last fill. */
  at: string;
  /** Its trading date in New York, which is what a lot's purchase date means. */
  date: string;
  /** Sold by a stop, as far as the order type says. */
  stop: boolean;
  /** The order is still working, so more of it may fill later. */
  working: boolean;
}

export type SyncChange =
  | { type: "buy"; lot: PlannedLot & { orderId: string } }
  | { type: "sell"; count: number; price: number; soldOn: string; orderId: string; stopHit: boolean };

interface Side {
  count: number;
  basis: number;
}

export type HoldingPlan =
  | {
      kind: "unmatched";
      account: string;
      symbol: string;
      webull: Side;
      lastPrice: number;
      adopt: PlannedLot[];
      /** Why the lots are one lot at the average cost rather than built from fills. */
      fallback: string | null;
      ignored: boolean;
      /** Every order's filled shares at this read: what Adopt books. */
      booked: Record<string, number>;
    }
  | { kind: "link"; account: string; symbol: string; local: Side; webull: Side; differences: string[]; booked: Record<string, number> }
  | { kind: "sync"; account: string; symbol: string; local: Side; webull: Side; changes: SyncChange[]; flags: string[] }
  | { kind: "notAtWebull"; account: string; symbol: string; local: Side; source: Holding["source"]; changes: SyncChange[]; flags: string[] };

export interface AccountPlan {
  label: string;
  accountId: string;
  accountType: string;
  cash: CashSummary | null;
  cashStatus: CashStatus;
  lowCash: number | null;
  holdings: HoldingPlan[];
  /** Positions the sync doesn't model (options and other non-equity). */
  skipped: { symbol: string; reason: string }[];
}

export interface SyncPlan {
  accounts: AccountPlan[];
  /** Symbols Webull holds that also have lots with no account label, which can't be matched to an account. */
  unlabelled: { symbol: string; count: number }[];
}

/** The filled part of each equity buy and sell, oldest first. Shorts are left out: no lot models them. */
export function fillsOf(orders: WebullOrder[]): Fill[] {
  const fills: Fill[] = [];
  for (const o of orders) {
    if (o.instrumentType !== "EQUITY" && o.instrumentType !== "STOCK") {
      continue;
    }
    if ((o.side !== "BUY" && o.side !== "SELL") || o.filledQuantity <= 0 || o.filledPrice === null) {
      continue;
    }
    const at = o.filledAt ?? o.placedAt;
    if (at === null) {
      continue;
    }
    fills.push({
      orderId: o.orderId,
      symbol: o.symbol,
      side: o.side,
      quantity: o.filledQuantity,
      price: o.filledPrice,
      at,
      date: marketDate(new Date(at)),
      stop: STOP_ORDER_TYPES.has(o.orderType),
      working: o.status === "PARTIAL_FILLED" || o.status === "SUBMITTED" || o.status === "PENDING",
    });
  }
  return fills.sort((a, b) => a.at.localeCompare(b.at) || a.orderId.localeCompare(b.orderId));
}

/**
 * A webull holding's fills not yet in its lots and sales: after it was linked,
 * less what each order already booked. A partly filled order comes back with
 * only its new shares.
 */
export function unbookedFills(fills: Fill[], holding: Pick<Holding, "linkedAt" | "booked">): Fill[] {
  const booked = holding.booked ?? {};
  const out: Fill[] = [];
  for (const f of fills) {
    if (holding.linkedAt !== undefined && f.at <= holding.linkedAt && booked[f.orderId] === undefined) {
      continue;
    }
    const left = f.quantity - (booked[f.orderId] ?? 0);
    if (left > SHARE_EPSILON) {
      out.push({ ...f, quantity: round6(left) });
    }
  }
  return out;
}

/** Each order's filled shares, for booking everything a read has seen when a holding is adopted or linked. */
function bookedAtRead(fills: Fill[]): Record<string, number> {
  return Object.fromEntries(fills.map((f) => [f.orderId, f.quantity]));
}

function side(lots: Pick<Lot, "count" | "basisPerShare">[]): Side {
  const count = lots.reduce((sum, l) => sum + l.count, 0);
  const cost = lots.reduce((sum, l) => sum + l.count * l.basisPerShare, 0);
  return { count, basis: count > 0 ? cost / count : 0 };
}

function sameShares(a: number, b: number): boolean {
  return Math.abs(a - b) < SHARE_EPSILON;
}

function sameBasis(a: number, b: number): boolean {
  const diff = Math.abs(a - b);
  return diff <= BASIS_ROUNDING + 1e-9 || (b !== 0 && diff / b <= BASIS_TOLERANCE);
}

/**
 * The lots a run of fills leaves, taking sales from the oldest lot first (the
 * brokers' default, and what the dashboard's Sell does by default). Null when a
 * sale would take more than the fills bought, which means the position started
 * before the window.
 */
export function replayFills(fills: Fill[]): PlannedLot[] | null {
  const lots: PlannedLot[] = [];
  for (const f of fills) {
    if (f.side === "BUY") {
      lots.push({ count: f.quantity, basisPerShare: f.price, purchaseDate: f.date, orderId: f.orderId });
      continue;
    }
    let left = f.quantity;
    while (left > SHARE_EPSILON) {
      const oldest = lots[0];
      if (oldest === undefined) {
        return null;
      }
      const take = Math.min(left, oldest.count);
      oldest.count = round6(oldest.count - take);
      left -= take;
      if (oldest.count < SHARE_EPSILON) {
        lots.shift();
      }
    }
  }
  return lots;
}

/** Lots for adopting a position: from its fills when they explain all of it, else one lot at the average cost. */
export function adoptionLots(position: WebullPosition, fills: Fill[], historyFrom: string, today: string): { lots: PlannedLot[]; fallback: string | null } {
  const replayed = replayFills(fills);
  if (replayed !== null && sameShares(side(replayed).count, position.quantity)) {
    return { lots: replayed, fallback: null };
  }
  const explained = replayed === null ? "don't add up (a sale before the first buy seen)" : `explain ${round6(side(replayed).count)} of ${position.quantity} shares`;
  return {
    lots: [{ count: position.quantity, basisPerShare: position.costPrice, purchaseDate: today, orderId: null }],
    fallback: `fills since ${historyFrom.slice(0, 10)} ${explained}; one lot at Webull's average cost, dated today`,
  };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function changesFrom(fills: Fill[]): SyncChange[] {
  return fills.map((f): SyncChange =>
    f.side === "BUY"
      ? { type: "buy", lot: { count: f.quantity, basisPerShare: f.price, purchaseDate: f.date, orderId: f.orderId } }
      : { type: "sell", count: f.quantity, price: f.price, soldOn: f.date, orderId: f.orderId, stopHit: f.stop }
  );
}

/**
 * A webull holding's unbooked fills as changes, when they account exactly for
 * the move from `local` to `webullCount` and never sell more than is held along
 * the way. Otherwise no changes and a flag saying why: a guess at a trade is
 * worse than none, and history that lags catches up on a later run.
 */
export function syncChanges(local: Side, webullCount: number, fills: Fill[]): { changes: SyncChange[]; flags: string[] } {
  const flags: string[] = [];
  const working = fills.filter((f) => f.working);
  if (working.length > 0) {
    flags.push(`${working.length} order(s) still working (${working.map((f) => f.orderId).join(", ")}): their filled part so far is counted`);
  }
  let running = local.count;
  let oversold = false;
  for (const f of fills) {
    running += f.side === "BUY" ? f.quantity : -f.quantity;
    oversold ||= running < -SHARE_EPSILON;
  }
  if (sameShares(running, webullCount) && !oversold) {
    return { changes: changesFrom(fills), flags };
  }
  if (fills.length === 0) {
    flags.push(
      `Webull holds ${webullCount} shares and the record ${round6(local.count)}, with no fills to explain it: a split or another corporate action, or history that hasn't caught up. Not applied.`
    );
  } else if (oversold) {
    flags.push(`the fills sell more shares than the record holds at some point. Not applied.`);
  } else {
    flags.push(`the record's ${round6(local.count)} shares plus the new fills make ${round6(running)}, but Webull holds ${webullCount}. Not applied.`);
  }
  return { changes: [], flags };
}

function cashSummary(snapshot: WebullAccountSnapshot, cashEquivalents: Set<string>): CashSummary | null {
  if (snapshot.balance === null || !Number.isFinite(snapshot.balance.cash)) {
    return null;
  }
  const held = snapshot.positions.filter((p) => cashEquivalents.has(p.symbol) && p.quantity > 0);
  const equivalents = held.reduce((sum, p) => sum + p.quantity * p.lastPrice, 0);
  return {
    cash: snapshot.balance.cash,
    settledCash: snapshot.balance.settledCash,
    unsettledCash: snapshot.balance.unsettledCash,
    cashEquivalents: equivalents,
    cashEquivalentPrice: held[0]?.lastPrice ?? null,
    total: snapshot.balance.cash + equivalents,
  };
}

/** The never-borrow rule's verdict. Unknown cash (no balance read) is "ok": there is nothing to warn about yet. */
export function cashStatusOf(cash: CashSummary | null, lowCash: number | null): CashStatus {
  if (cash === null) {
    return "ok";
  }
  if (cash.total < 0) {
    return "onMargin";
  }
  if (cash.cash < 0) {
    return "usingMargin";
  }
  if (lowCash !== null && cash.total < lowCash) {
    return "low";
  }
  return "ok";
}

/** Whole shares of the cash equivalent to sell to bring cash back to zero, or null when cash isn't negative or there is no price. */
export function sharesToCover(cash: CashSummary): number | null {
  if (cash.cash >= 0 || cash.cashEquivalentPrice === null || !(cash.cashEquivalentPrice > 0)) {
    return null;
  }
  return Math.ceil(-cash.cash / cash.cashEquivalentPrice);
}

export interface PlanOptions {
  cashEquivalents: Set<string>;
  /** Today's date for lots that have no fill to date them, YYYY-MM-DD. */
  today: string;
  /** Low-water mark for cash + BIL, by account label (WEBULL_LOW_CASH). */
  lowCash?: Map<string, number>;
}

export function planWebullSync(store: HoldingsStore, snapshots: WebullAccountSnapshot[], options: PlanOptions): SyncPlan {
  const records = new Map((store.holdings ?? []).map((h) => [holdingKey(h.account, h.symbol), h]));
  const accounts: AccountPlan[] = [];
  const webullSymbols = new Set<string>();

  for (const snap of snapshots) {
    const fills = fillsOf(snap.orders);
    const fillsFor = (symbol: string) => fills.filter((f) => f.symbol === symbol);
    const accountLots = store.lots.filter((l) => l.account === snap.label);
    const plans: HoldingPlan[] = [];
    const skipped: AccountPlan["skipped"] = [];
    const seen = new Set<string>();

    for (const position of snap.positions) {
      if (position.instrumentType !== "EQUITY" && position.instrumentType !== "STOCK") {
        skipped.push({ symbol: position.symbol, reason: `${position.instrumentType || "unknown"} position: the sync models shares only` });
        continue;
      }
      if (!(position.quantity > 0)) {
        skipped.push({ symbol: position.symbol, reason: `quantity ${position.quantity}: shorts aren't modelled` });
        continue;
      }
      const symbol = position.symbol;
      seen.add(symbol);
      webullSymbols.add(symbol);
      const webull = { count: position.quantity, basis: position.costPrice };
      const lots = accountLots.filter((l) => l.symbol.toUpperCase() === symbol);
      const record = records.get(holdingKey(snap.label, symbol));

      if (lots.length === 0 && record?.source !== "webull") {
        const { lots: adopt, fallback } = adoptionLots(position, fillsFor(symbol), snap.historyFrom, options.today);
        plans.push({
          kind: "unmatched",
          account: snap.label,
          symbol,
          webull,
          lastPrice: position.lastPrice,
          adopt,
          fallback,
          ignored: record?.ignored === true,
          booked: bookedAtRead(fillsFor(symbol)),
        });
        continue;
      }
      const local = side(lots);
      if (record?.source === "webull") {
        const { changes, flags } = syncChanges(local, position.quantity, unbookedFills(fillsFor(symbol), record));
        if (changes.length === 0 && flags.length === 0 && !sameBasis(local.basis, webull.basis)) {
          flags.push(`basis ${local.basis.toFixed(4)} vs Webull's average cost ${webull.basis.toFixed(4)}: flagged only`);
        }
        plans.push({ kind: "sync", account: snap.label, symbol, local, webull, changes, flags });
        continue;
      }
      const differences: string[] = [];
      if (!sameShares(local.count, webull.count)) {
        differences.push(`shares: record ${round6(local.count)}, Webull ${webull.count}`);
      }
      if (!sameBasis(local.basis, webull.basis)) {
        differences.push(`basis: record ${local.basis.toFixed(4)}, Webull ${webull.basis.toFixed(4)}`);
      }
      plans.push({ kind: "link", account: snap.label, symbol, local, webull, differences, booked: bookedAtRead(fillsFor(symbol)) });
    }

    // Lots in this account that Webull doesn't hold.
    const missing = new Map<string, Lot[]>();
    for (const lot of accountLots) {
      const symbol = lot.symbol.toUpperCase();
      if (!seen.has(symbol)) {
        missing.set(symbol, [...(missing.get(symbol) ?? []), lot]);
      }
    }
    for (const [symbol, lots] of missing) {
      const record = records.get(holdingKey(snap.label, symbol));
      const local = side(lots);
      if (record?.source === "webull") {
        const { changes, flags } = syncChanges(local, 0, unbookedFills(fillsFor(symbol), record));
        plans.push({ kind: "notAtWebull", account: snap.label, symbol, local, source: "webull", changes, flags });
      } else {
        plans.push({ kind: "notAtWebull", account: snap.label, symbol, local, source: "manual", changes: [], flags: [] });
      }
    }

    plans.sort((a, b) => a.symbol.localeCompare(b.symbol));
    const cash = cashSummary(snap, options.cashEquivalents);
    const lowCash = options.lowCash?.get(snap.label) ?? null;
    accounts.push({
      label: snap.label,
      accountId: snap.accountId,
      accountType: snap.accountType,
      cash,
      cashStatus: cashStatusOf(cash, lowCash),
      lowCash,
      holdings: plans,
      skipped,
    });
  }

  const unlabelled = new Map<string, number>();
  for (const lot of store.lots) {
    const symbol = lot.symbol.toUpperCase();
    if (lot.account === undefined && webullSymbols.has(symbol)) {
      unlabelled.set(symbol, (unlabelled.get(symbol) ?? 0) + lot.count);
    }
  }
  return { accounts, unlabelled: [...unlabelled].map(([symbol, count]) => ({ symbol, count })).sort((a, b) => a.symbol.localeCompare(b.symbol)) };
}

// --- applying ---------------------------------------------------------------

/** What applying wrote, for the run log. Shares and money: terminal only. */
export interface AppliedChange {
  account: string;
  symbol: string;
  change: SyncChange;
}

/** An account whose cash status got worse (or changed to another warning) this run. */
export interface CashStatusChange {
  label: string;
  from: CashStatus | null;
  to: CashStatus;
  cash: CashSummary | null;
}

export interface ApplyResult {
  applied: AppliedChange[];
  /** Changes the store refused (a sale of more than it holds), which become flags in the state. */
  refused: { account: string; symbol: string; message: string }[];
  cashChanges: CashStatusChange[];
}

/** The state the page and the ops read: what this read found, shares and money included. */
export function webullStateOf(plan: SyncPlan, readAt: string, refused: ApplyResult["refused"] = []): WebullState {
  return {
    readAt,
    accounts: plan.accounts.map((a): WebullAccountState => ({
      label: a.label,
      accountType: a.accountType,
      cash: a.cash,
      cashStatus: a.cashStatus,
      lowCash: a.lowCash,
      unmatched: a.holdings.flatMap((h) =>
        h.kind === "unmatched"
          ? [{ symbol: h.symbol, count: h.webull.count, basis: h.webull.basis, lastPrice: h.lastPrice, adopt: h.adopt, fallback: h.fallback, ignored: h.ignored, booked: h.booked }]
          : []
      ),
      links: a.holdings.flatMap((h) =>
        h.kind === "link"
          ? [{ symbol: h.symbol, count: h.local.count, basis: h.local.basis, webullCount: h.webull.count, differences: h.differences, booked: h.booked }]
          : []
      ),
      flags: [
        ...a.holdings.flatMap((h) => (h.kind === "sync" || h.kind === "notAtWebull" ? h.flags.map((message) => ({ symbol: h.symbol, message })) : [])),
        ...refused.filter((r) => r.account === a.label).map((r) => ({ symbol: r.symbol, message: r.message })),
      ],
      skipped: a.skipped,
    })),
  };
}

function nextLotId(store: HoldingsStore, orderId: string): string {
  // Stable, so a crash and rerun can't add the same lot under a second id; the
  // booked map already stops that, this keeps the id readable in the store.
  const base = `wb-${orderId.slice(-8)}`;
  let id = base;
  for (let n = 2; store.lots.some((l) => l.id === id); n++) {
    id = `${base}-${n}`;
  }
  return id;
}

function holdingRecord(store: HoldingsStore, account: string, symbol: string): Holding | undefined {
  return (store.holdings ?? []).find((h) => holdingKey(h.account, h.symbol) === holdingKey(account, symbol));
}

/**
 * Writes a plan into `store` in place: each webull holding's buys as lots and
 * sales through the same code the dashboard's Sell uses, every order booked on
 * its holding, and the read itself as `store.webull`. Unmatched and link
 * holdings change nothing here; they wait for an op.
 *
 * A holding's changes are applied on a copy first, so one that the store
 * refuses part-way leaves that holding exactly as it was.
 */
export function applySyncPlan(store: HoldingsStore, plan: SyncPlan, now: Date): ApplyResult {
  const applied: AppliedChange[] = [];
  const refused: ApplyResult["refused"] = [];

  for (const account of plan.accounts) {
    for (const h of account.holdings) {
      if ((h.kind !== "sync" && h.kind !== "notAtWebull") || h.changes.length === 0) {
        continue;
      }
      const trial = structuredClone(store);
      const record = holdingRecord(trial, account.label, h.symbol);
      if (record === undefined) {
        continue;
      }
      const booked = { ...(record.booked ?? {}) };
      let failed: string | null = null;
      for (const change of h.changes) {
        if (change.type === "buy") {
          trial.lots.push({
            id: nextLotId(trial, change.lot.orderId),
            symbol: h.symbol,
            count: change.lot.count,
            basisPerShare: change.lot.basisPerShare,
            purchaseDate: change.lot.purchaseDate,
            createdAt: now.toISOString(),
            account: account.label,
            orderId: change.lot.orderId,
          });
          booked[change.lot.orderId] = round6((booked[change.lot.orderId] ?? 0) + change.lot.count);
          continue;
        }
        const sold = sellFromStore(
          trial,
          { symbol: h.symbol, count: change.count, price: change.price, soldOn: change.soldOn, account: account.label, orderId: change.orderId, ...(change.stopHit ? { stopHit: { atr: null } } : {}) },
          now
        );
        if (!sold.ok) {
          failed = `the record refused the sale of order ${change.orderId} (${sold.reason}). Nothing applied for ${h.symbol}.`;
          break;
        }
        booked[change.orderId] = round6((booked[change.orderId] ?? 0) + change.count);
      }
      if (failed !== null) {
        refused.push({ account: account.label, symbol: h.symbol, message: failed });
        continue;
      }
      // The trial's record is the same object the trial store holds.
      holdingRecord(trial, account.label, h.symbol)!.booked = booked;
      Object.assign(store, trial);
      applied.push(...h.changes.map((change) => ({ account: account.label, symbol: h.symbol, change })));
    }
  }

  const previous = new Map((store.webull?.accounts ?? []).map((a) => [a.label, a.cashStatus]));
  const cashChanges: CashStatusChange[] = [];
  for (const a of plan.accounts) {
    const from = previous.get(a.label) ?? null;
    if (a.cashStatus !== "ok" && a.cashStatus !== from) {
      cashChanges.push({ label: a.label, from, to: a.cashStatus, cash: a.cash });
    }
  }
  store.webull = webullStateOf(plan, now.toISOString(), refused);
  return { applied, refused, cashChanges };
}

/**
 * WEBULL_ACCOUNTS, `label=accountId` pairs separated by commas, e.g.
 * `margin=ABC123,roth=DEF456`. The labels are the ones lots already carry.
 * Kept in .env rather than analysis.config.json, which is committed: account
 * ids don't belong in a public repo.
 */
export function parseAccountMap(raw: string | undefined): { label: string; accountId: string }[] {
  return parsePairs(raw, "WEBULL_ACCOUNTS", "margin=ABC123").map(([label, accountId]) => ({ label, accountId }));
}

/**
 * WEBULL_LOW_CASH, `label=dollars` pairs, e.g. `margin=5000,roth=2000`: warn
 * when an account's cash + BIL falls under it. In .env with the account ids,
 * since a threshold says something about the account's size.
 */
export function parseLowCash(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const [label, value] of parsePairs(raw, "WEBULL_LOW_CASH", "margin=5000")) {
    const dollars = Number(value.replace(/[$,]/g, ""));
    if (!Number.isFinite(dollars) || dollars < 0) {
      throw new Error(`Bad WEBULL_LOW_CASH amount "${value}" for ${label}: expected dollars, e.g. margin=5000`);
    }
    out.set(label, dollars);
  }
  return out;
}

function parsePairs(raw: string | undefined, name: string, example: string): [string, string][] {
  if (raw === undefined || raw.trim() === "") {
    return [];
  }
  const out: [string, string][] = [];
  for (const pair of raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0)) {
    const eq = pair.indexOf("=");
    const key = eq > 0 ? pair.slice(0, eq).trim() : "";
    const value = eq > 0 ? pair.slice(eq + 1).trim() : "";
    if (key === "" || value === "") {
      throw new Error(`Bad ${name} entry "${pair}": expected label=value, e.g. ${example}`);
    }
    if (out.some(([k, v]) => k === key || (name === "WEBULL_ACCOUNTS" && v === value))) {
      throw new Error(`${name} names "${key}" or its value twice`);
    }
    out.push([key, value]);
  }
  return out;
}

// --- rendering --------------------------------------------------------------

function money(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shares(n: number): string {
  return String(round6(n));
}

export function describeChange(c: SyncChange): string {
  return c.type === "buy"
    ? `buy  ${shares(c.lot.count)} @ ${c.lot.basisPerShare} on ${c.lot.purchaseDate} (order ${c.lot.orderId})`
    : `sell ${shares(c.count)} @ ${c.price} on ${c.soldOn} (order ${c.orderId})${c.stopHit ? ", by a stop" : ""}`;
}

/** One line per warning, for the run log. Money, so terminal only. */
export function describeCashStatus(label: string, status: CashStatus, cash: CashSummary | null, cashName: string): string {
  const total = cash === null ? "" : ` (cash ${money(cash.cash)}, cash + ${cashName} ${money(cash.total)})`;
  switch (status) {
    case "onMargin":
      return `${label}: ON MARGIN, borrowing that ${cashName} can't cover${total}.`;
    case "usingMargin": {
      const n = cash === null ? null : sharesToCover(cash);
      return `${label}: using margin${total}. Sell${n === null ? "" : ` about ${n} shares of`} ${cashName} to cover.`;
    }
    case "low":
      return `${label}: low on cash${total}.`;
    case "ok":
      return `${label}: cash ok${total}.`;
  }
}

/** The plan as terminal lines. Shares and money, so it is for the local terminal only. */
export function renderSyncPlan(plan: SyncPlan, cashEquivalentNames: string[]): string[] {
  const out: string[] = [];
  const cashName = cashEquivalentNames.length > 0 ? cashEquivalentNames.join("+") : "cash equivalents";
  for (const account of plan.accounts) {
    out.push(`${account.label} (Webull ${account.accountType.toLowerCase()} account)`);
    if (account.cash !== null) {
      const c = account.cash;
      const settled = c.settledCash !== null ? `, settled ${money(c.settledCash)}` : "";
      const unsettled = c.unsettledCash !== null && c.unsettledCash !== 0 ? `, unsettled ${money(c.unsettledCash)}` : "";
      out.push(`  Cash ${money(c.cash)}${settled}${unsettled} · ${cashName} ${money(c.cashEquivalents)} · cash + ${cashName} ${money(c.total)}`);
      if (account.cashStatus !== "ok") {
        out.push(`  ! ${describeCashStatus(account.label, account.cashStatus, c, cashName)}`);
      }
    }
    const byKind = (kind: HoldingPlan["kind"]) => account.holdings.filter((h) => h.kind === kind);

    const unmatched = byKind("unmatched") as Extract<HoldingPlan, { kind: "unmatched" }>[];
    if (unmatched.length > 0) {
      out.push("  Unmatched (Webull holds, the record doesn't): Adopt would add");
      for (const h of unmatched) {
        out.push(`    ${h.symbol.padEnd(6)} ${shares(h.webull.count)} @ avg ${h.webull.basis} → ${h.adopt.length} lot(s)${h.ignored ? " (ignored)" : ""}`);
        for (const lot of h.adopt) {
          out.push(`      ${shares(lot.count)} @ ${lot.basisPerShare} on ${lot.purchaseDate}${lot.orderId ? ` (order ${lot.orderId})` : ""}`);
        }
        if (h.fallback !== null) {
          out.push(`      ~ ${h.fallback}`);
        }
      }
    }

    const links = byKind("link") as Extract<HoldingPlan, { kind: "link" }>[];
    if (links.length > 0) {
      out.push("  Manual holdings Webull also holds: Link");
      for (const h of links) {
        out.push(
          `    ${h.symbol.padEnd(6)} ${h.differences.length === 0 ? `agrees (${shares(h.local.count)} @ ${h.local.basis.toFixed(4)}): would keep its lots` : h.differences.join("; ")}`
        );
      }
    }

    const synced = byKind("sync") as Extract<HoldingPlan, { kind: "sync" }>[];
    if (synced.length > 0) {
      out.push("  Webull holdings");
      for (const h of synced) {
        if (h.changes.length === 0 && h.flags.length === 0) {
          out.push(`    ${h.symbol.padEnd(6)} in sync (${shares(h.local.count)} shares)`);
          continue;
        }
        out.push(`    ${h.symbol.padEnd(6)} ${shares(h.local.count)} → ${shares(h.webull.count)} shares`);
        h.changes.forEach((c) => out.push(`      ${describeChange(c)}`));
        h.flags.forEach((f) => out.push(`      ! ${f}`));
      }
    }

    const missing = byKind("notAtWebull") as Extract<HoldingPlan, { kind: "notAtWebull" }>[];
    if (missing.length > 0) {
      out.push("  In the record, not at Webull");
      for (const h of missing) {
        if (h.source === "manual") {
          out.push(`    ${h.symbol.padEnd(6)} ${shares(h.local.count)} shares (manual): left alone`);
          continue;
        }
        out.push(`    ${h.symbol.padEnd(6)} ${shares(h.local.count)} → 0 shares`);
        h.changes.forEach((c) => out.push(`      ${describeChange(c)}`));
        h.flags.forEach((f) => out.push(`      ! ${f}`));
      }
    }

    if (account.skipped.length > 0) {
      out.push("  Not synced");
      account.skipped.forEach((s) => out.push(`    - ${s.symbol}: ${s.reason}`));
    }
    out.push("");
  }
  if (plan.unlabelled.length > 0) {
    out.push("Lots with no account label (can't be matched to a Webull account; give them one):");
    plan.unlabelled.forEach((u) => out.push(`  ${u.symbol.padEnd(6)} ${shares(u.count)} shares`));
  }
  return out;
}
