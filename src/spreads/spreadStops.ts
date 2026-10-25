/**
 * Stop alerts for option spreads, set by spread-book (a separate project on the
 * same host) through the shared directory.
 *
 * spread-book writes `/shared/spread-alerts.json`: the *complete* set of stop
 * alerts it wants, one per open credit spread, as a stock price (the price at
 * which the spread's loss would reach its stop today). `spreads sync` reconciles
 * this store against that file every run: new keys are added, moved levels are
 * re-levelled in place, and keys that are gone (the spread was closed) are
 * cancelled. spread-book never sees a close, only a spread's absence from its
 * next export, so absence has to be the signal, and two guards keep a broken
 * export from reading as "everything closed":
 *
 * - `complete: false` (spread-book had no exit plans) changes nothing.
 * - Keys in `unpriced` (open, but no stock level today) keep their last level.
 *
 * Kept apart from alerts.json on purpose. Every rule of the main book would
 * misfire on these: one alert per symbol and side (a spread stop must neither
 * replace nor be blocked by your own alert on the name), "acting on a symbol
 * closes its revisits" (a re-level twice a day is not your decision), holdings
 * cover, and the dashboard's edit ops (an edit would be undone by the next
 * sync). Here none of them can reach them. The crossing itself is judged by
 * the same code as a static alert (see spreadCheck.ts).
 *
 * A spread stop fires once per level: a re-cross of a level that already fired
 * is not news. The next sync's new level re-arms it, so a spread still past its
 * stop is reported again after each spread-book run (twice a trading day).
 *
 * Two books: the real one (`spread-alerts.json`) and spread-book's paper trades
 * (`paper-spread-alerts.json`, `book: "paper"`, every key prefixed `paper:`).
 * Each file reconciles only its own book's stops, so neither can cancel the
 * other's, and a paper stop says so wherever it is shown.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AlertSide, CrossDirection } from "../alerts/models.js";
import type { Session } from "../marketHours.js";

export const SPREAD_FILE_SCHEMA = "spread-book/alerts@1";
export const SPREAD_STORE_SCHEMA = "equity-watch/spread-stops@1";
/** Cancelled stops are kept this long, so a fire on the page still has its row. */
export const CANCELLED_KEEP_DAYS = 30;

/** The real book, or spread-book's paper trades. */
export type SpreadBook = "real" | "paper";
export const PAPER_KEY_PREFIX = "paper:";

export interface SpreadLeg {
  strike: number;
  type: "P" | "C";
}

/** What spread-book says about one spread. Prices are per share of the spread. */
export interface SpreadInfo {
  name: string;
  kind: "put" | "call";
  expiration: string;
  short: SpreadLeg;
  long: SpreadLeg;
  /** The spread's price at which its loss reaches the stop. */
  stopDebit: number;
  /** The short leg's delta at the stop level, by spread-book's model. */
  shortDeltaAtLevel: number | null;
  /**
   * The saved trade on OptionStrat. It shows the position, quantity included,
   * so it is a size fact: it travels only in the sealed vault (vaultContents),
   * never in dashboard.json. Null when spread-book had none.
   */
  optionStratUrl: string | null;
}

export interface SpreadAlertWanted {
  key: string;
  symbol: string;
  role: "stop";
  direction: CrossDirection;
  level: number;
  spread: SpreadInfo;
}

export interface SpreadAlertsFile {
  /** Which book the file is the complete set for. "real" when the file doesn't say (files from before paper trades). */
  book: SpreadBook;
  generatedAt: string;
  spotsAsOf: string | null;
  source: string;
  alerts: SpreadAlertWanted[];
  unpriced: string[];
}

export interface SpreadFire {
  id: string;
  at: string;
  price: number;
  level: number;
  session: Session | null;
}

export interface SpreadStop {
  key: string;
  symbol: string;
  direction: CrossDirection;
  level: number;
  /** The spread-book snapshot the level came from. */
  levelAsOf: string;
  spread: SpreadInfo;
  status: "live" | "cancelled";
  /** "paper" for a paper trade's stop; absent for the real book (stores from before paper trades). */
  book?: "paper";
  createdAt: string;
  cancelledAt: string | null;
  /** The side of the level price is on, as the static engine tracks it. */
  lastKnownSide: AlertSide;
  lastEvaluatedAt?: string;
  fires: SpreadFire[];
}

export interface SpreadStopsStore {
  schema: string;
  /** generatedAt of the last spread-book file synced, for "levels as of". */
  syncedFrom: string | null;
  /** The same for the paper book's file. */
  paperSyncedFrom: string | null;
  stops: SpreadStop[];
}

export const emptyStore = (): SpreadStopsStore => ({ schema: SPREAD_STORE_SCHEMA, syncedFrom: null, paperSyncedFrom: null, stops: [] });

export const bookOf = (s: Pick<SpreadStop, "book">): SpreadBook => (s.book === "paper" ? "paper" : "real");
/** When the given book's levels were last synced. */
export const syncedFromOf = (store: SpreadStopsStore, book: SpreadBook): string | null => (book === "paper" ? store.paperSyncedFrom : store.syncedFrom);

// ---- the store ----------------------------------------------------------------

export function loadSpreadStops(path: string): SpreadStopsStore {
  if (!existsSync(path)) return emptyStore();
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<SpreadStopsStore>;
  return { schema: SPREAD_STORE_SCHEMA, syncedFrom: raw.syncedFrom ?? null, paperSyncedFrom: raw.paperSyncedFrom ?? null, stops: raw.stops ?? [] };
}

export function saveSpreadStops(path: string, store: SpreadStopsStore): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(store, null, 2));
  renameSync(temp, path);
}

// ---- spread-book's file -------------------------------------------------------

export type SpreadFileRead = { ok: true; file: SpreadAlertsFile } | { ok: false; reason: string };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** Only OptionStrat's own short links: anything else is dropped, not followed. */
const OPTIONSTRAT_URL = /^https:\/\/optionstrat\.com\/[A-Za-z0-9_-]+$/;
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function legOf(v: unknown): SpreadLeg | null {
  const l = v as Partial<SpreadLeg> | null;
  return l && isNum(l.strike) && (l.type === "P" || l.type === "C") ? { strike: l.strike, type: l.type } : null;
}

/** One entry of the file, or null when it isn't one this version understands. */
function wantedOf(v: unknown): SpreadAlertWanted | null {
  const a = v as Record<string, unknown> | null;
  if (!a || !isStr(a.key) || !isStr(a.symbol) || a.role !== "stop" || !isNum(a.level) || !(a.level > 0)) return null;
  if (a.direction !== "up" && a.direction !== "down") return null;
  const s = a.spread as Record<string, unknown> | null;
  if (!s || !isStr(s.name) || (s.kind !== "put" && s.kind !== "call") || !isStr(s.expiration) || !isNum(s.stopDebit)) return null;
  const short = legOf(s.short), long = legOf(s.long);
  if (!short || !long) return null;
  return {
    key: a.key,
    symbol: a.symbol.toUpperCase(),
    role: "stop",
    direction: a.direction,
    level: a.level,
    spread: {
      name: s.name, kind: s.kind, expiration: s.expiration, short, long, stopDebit: s.stopDebit,
      shortDeltaAtLevel: isNum(s.shortDeltaAtLevel) ? s.shortDeltaAtLevel : null,
      optionStratUrl: typeof s.optionStratUrl === "string" && OPTIONSTRAT_URL.test(s.optionStratUrl) ? s.optionStratUrl : null,
    },
  };
}

/**
 * Reads and checks spread-book's file. Anything that isn't a complete file of
 * the expected schema comes back as a reason, and the caller changes nothing:
 * a missing or half-written file must never cancel stops. An entry this version
 * can't read is a reason too, rather than skipped, because a skipped entry
 * would be cancelled as if its spread had closed.
 */
export function parseSpreadFile(text: string): SpreadFileRead {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    return { ok: false, reason: `not JSON (${(err as Error).message})` };
  }
  if (doc.schema !== SPREAD_FILE_SCHEMA) return { ok: false, reason: `schema ${String(doc.schema)}, expected ${SPREAD_FILE_SCHEMA}` };
  if (doc.complete !== true) return { ok: false, reason: "spread-book marked it incomplete (no exit plans in that snapshot)" };
  if (!isStr(doc.generatedAt) || !Array.isArray(doc.alerts) || !Array.isArray(doc.unpriced)) return { ok: false, reason: "missing generatedAt, alerts or unpriced" };
  if (doc.book !== undefined && doc.book !== "real" && doc.book !== "paper") return { ok: false, reason: `book ${JSON.stringify(doc.book)}, expected real or paper` };
  const book: SpreadBook = doc.book === "paper" ? "paper" : "real";
  // A paper key is always prefixed and a real one never is, so the two books can't share a stop.
  const inBook = (key: string) => key.startsWith(PAPER_KEY_PREFIX) === (book === "paper");
  const alerts: SpreadAlertWanted[] = [];
  for (const [i, v] of doc.alerts.entries()) {
    const w = wantedOf(v);
    if (w === null) return { ok: false, reason: `alert ${i} is not one this version understands` };
    if (!inBook(w.key)) return { ok: false, reason: `alert ${i}'s key doesn't belong to the ${book} book` };
    alerts.push(w);
  }
  return {
    ok: true,
    file: {
      book,
      generatedAt: doc.generatedAt,
      spotsAsOf: isStr(doc.spotsAsOf) ? doc.spotsAsOf : null,
      source: isStr(doc.source) ? doc.source : "",
      alerts,
      unpriced: doc.unpriced.filter(isStr),
    },
  };
}

export function readSpreadFile(path: string): SpreadFileRead {
  if (!existsSync(path)) return { ok: false, reason: `no file at ${path}` };
  return parseSpreadFile(readFileSync(path, "utf-8"));
}

// ---- the sync -----------------------------------------------------------------

/** The side price starts on: away from the strike, so a price already past the stop fires at the first check. */
export const safeSide = (direction: CrossDirection): AlertSide => (direction === "down" ? "above" : "below");

export interface SyncResult {
  store: SpreadStopsStore;
  added: SpreadStop[];
  relevelled: { stop: SpreadStop; from: number }[];
  cancelled: SpreadStop[];
  /** Live stops left as they were because spread-book had no level for them today. */
  kept: SpreadStop[];
}

/**
 * Reconciles the store with spread-book's file, for the file's book only: the
 * other book's stops are left exactly as they are. Pure: returns a new store.
 * An older file than the one last synced is refused by the caller, not here.
 */
export function syncSpreadStops(store: SpreadStopsStore, file: SpreadAlertsFile, now: Date): SyncResult {
  const nowIso = now.toISOString();
  const byKey = new Map(store.stops.map((s) => [s.key, { ...s, fires: [...s.fires] }]));
  const result: SyncResult = { store: emptyStore(), added: [], relevelled: [], cancelled: [], kept: [] };
  const wanted = new Set(file.alerts.map((a) => a.key));
  const unpriced = new Set(file.unpriced);

  for (const w of file.alerts) {
    const had = byKey.get(w.key);
    if (had === undefined || had.status === "cancelled") {
      const stop: SpreadStop = {
        key: w.key, symbol: w.symbol, direction: w.direction, level: w.level, levelAsOf: file.generatedAt, spread: w.spread,
        status: "live", ...(file.book === "paper" ? { book: "paper" as const } : {}), createdAt: had?.createdAt ?? nowIso, cancelledAt: null, lastKnownSide: safeSide(w.direction),
        fires: had?.fires ?? [],
      };
      byKey.set(w.key, stop);
      result.added.push(stop);
      continue;
    }
    had.spread = w.spread;
    had.levelAsOf = file.generatedAt;
    if (had.level !== w.level || had.direction !== w.direction) {
      result.relevelled.push({ stop: had, from: had.level });
      had.level = w.level;
      had.direction = w.direction;
      // A new level is watched afresh: if price is already past it, the next check fires.
      had.lastKnownSide = safeSide(w.direction);
    }
  }

  for (const s of byKey.values()) {
    if (s.status !== "live" || wanted.has(s.key) || bookOf(s) !== file.book) continue;
    if (unpriced.has(s.key)) {
      result.kept.push(s);
      continue;
    }
    s.status = "cancelled";
    s.cancelledAt = nowIso;
    result.cancelled.push(s);
  }

  const keepAfter = now.getTime() - CANCELLED_KEEP_DAYS * 86_400_000;
  result.store = {
    schema: SPREAD_STORE_SCHEMA,
    syncedFrom: file.book === "real" ? file.generatedAt : store.syncedFrom,
    paperSyncedFrom: file.book === "paper" ? file.generatedAt : store.paperSyncedFrom,
    stops: [...byKey.values()].filter((s) => s.status === "live" || Date.parse(s.cancelledAt ?? nowIso) >= keepAfter),
  };
  return result;
}

/** A fire, recorded on the stop. */
export function newFire(price: number, level: number, at: string, session: Session | null): SpreadFire {
  return { id: randomUUID().slice(0, 8), at, price, level, session };
}

/** The fire at the stop's current level, if it has fired there. */
export const fireAtLevel = (s: SpreadStop): SpreadFire | null => [...s.fires].reverse().find((f) => f.level === s.level) ?? null;

/** The key spread-book's report selects a spread by (?spread=): the stop's key without its episode or paper prefix. */
export const reportKey = (s: Pick<SpreadStop, "key">): string => s.key.replace(/#\d+$/, "").replace(/^paper:/, "");

/** "CRM 260/270 call", the way the page and the log name a spread. */
export const spreadLabel = (s: SpreadStop): string => {
  const [lo, hi] = [s.spread.short.strike, s.spread.long.strike].sort((a, b) => a - b);
  return `${s.symbol} ${lo}/${hi} ${s.spread.kind}`;
};

/** What a fire means, in one line. Says "check", never "close": the stock price is a stand-in for the spread's. */
export function describeSpreadFire(s: SpreadStop, f: SpreadFire): string {
  const way = s.direction === "down" ? "below" : "above";
  return `${bookOf(s) === "paper" ? "Paper " : ""}${spreadLabel(s)}: stock ${f.price} crossed ${way} its stop level ${f.level} (spread about $${s.spread.stopDebit.toFixed(2)}). Check the spread's price.`;
}
