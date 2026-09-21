/**
 * Turns loosely typed alert fields into engine inputs: CLI flag strings, or an
 * op's JSON params queued from the browser dashboard. Returns an error rather
 * than exiting, so `alert add`/`alert edit` and the ops worker (src/ops/apply.ts)
 * reject the same input with the same words.
 *
 * Messages name CLI flags ("--level") because the CLI is where they were
 * written. The page shows them as-is; they still say which field is wrong.
 */

import type { AddAlertInput, AlertEdit } from "../alerts/engine.js";
import { DEFAULT_TOUCH_MARGIN_PCT } from "../alerts/maEngine.js";
import {
  DEFAULT_ALERT_DIRECTION,
  type AlertDirection,
  type MaApproach,
  type VolumeCondition,
  type VolumePeriodUnit,
} from "../alerts/models.js";
import { parseMaSpec, type MaSpec } from "../indicators/movingAverage.js";
import { parseVolume } from "../volume.js";

type Scalar = string | number;

export interface RawAddFields {
  symbol?: string;
  level?: Scalar;
  near?: Scalar;
  trailPercent?: Scalar;
  trailAmount?: Scalar;
  volumeAtLeast?: Scalar;
  volumeRatio?: Scalar;
  volumePeriod?: string;
  ma?: string;
  /** `--touch` with no value is `true`: the default margin. */
  touch?: Scalar | boolean;
  direction?: string;
  from?: string;
}

export interface RawEditFields {
  level?: Scalar;
  /** Drop a static alert's level, leaving its volume condition as a volume alert. */
  clearLevel?: boolean;
  direction?: string;
  trailPercent?: Scalar;
  trailAmount?: Scalar;
  volumeAtLeast?: Scalar;
  volumeRatio?: Scalar;
  volumePeriod?: string;
  clearVolume?: boolean;
  ma?: string;
  touch?: Scalar;
  from?: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

class Invalid extends Error {}

function fail(message: string): never {
  throw new Invalid(message);
}

function attempt<T>(fn: () => T): Parsed<T> {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    if (err instanceof Invalid) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}

/** Positive finite number, or a rejection naming the flag. */
function positive(flag: string, raw: Scalar): number {
  const n = typeof raw === "number" ? raw : raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    fail(`Invalid ${flag} "${raw}" — expected a positive number.`);
  }
  return n;
}

/**
 * A share count, accepting the "2.5M"/"250K" shorthand the dashboard's form and
 * the CLI flag both take. Whole shares: `parseVolume` rounds, because a
 * fraction of a share is not tradeable and `requiredVolume` rounds anyway.
 */
function volumeShares(flag: string, raw: Scalar): number {
  const shares = parseVolume(raw);
  if (shares === null) {
    fail(`Invalid ${flag} "${raw}" — expected a positive share count, optionally with K, M, or B (e.g. 2.5M).`);
  }
  return shares;
}

/** Parses "30m" / "2h" / "1d" / "45s" into a VolumeCondition's period fields. */
export function parseVolumePeriod(raw: string): Parsed<{ periodValue: number; periodUnit: VolumePeriodUnit }> {
  return attempt(() => volumePeriod(raw));
}

function volumePeriod(raw: string): { periodValue: number; periodUnit: VolumePeriodUnit } {
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(String(raw).trim());
  if (!match) {
    fail(`Invalid --volume-period "${raw}" — expected a number followed by s, m, h, or d (e.g. "30m").`);
  }
  return { periodValue: parseFloat(match[1]), periodUnit: match[2] as VolumePeriodUnit };
}

/** The optional VolumeCondition shared by static, trailing, and volume alerts. */
function volumeCondition(raw: { volumeAtLeast?: Scalar; volumeRatio?: Scalar; volumePeriod?: string }): VolumeCondition | undefined {
  if (raw.volumeAtLeast !== undefined && raw.volumeRatio !== undefined) {
    fail("Specify --volume-at-least (absolute shares) or --volume-ratio (multiple of normal), not both.");
  }
  if (raw.volumeRatio !== undefined) {
    const ratio = Number(raw.volumeRatio);
    if (!Number.isFinite(ratio) || ratio <= 0) {
      fail(`Invalid --volume-ratio "${raw.volumeRatio}" — expected a positive multiple, e.g. 1.5.`);
    }
    return raw.volumePeriod === undefined ? { ratio, mode: "today" } : { ratio, mode: "period", ...volumePeriod(raw.volumePeriod) };
  }
  if (raw.volumeAtLeast === undefined) {
    if (raw.volumePeriod !== undefined) {
      fail("--volume-period requires --volume-at-least or --volume-ratio.");
    }
    return undefined;
  }
  const threshold = volumeShares("--volume-at-least", raw.volumeAtLeast);
  return raw.volumePeriod === undefined ? { threshold, mode: "today" } : { threshold, mode: "period", ...volumePeriod(raw.volumePeriod) };
}

function maSpec(raw: string): MaSpec {
  try {
    return parseMaSpec(raw);
  } catch (err) {
    fail((err as Error).message);
  }
}

function touchMargin(raw: Scalar): number {
  const margin = Number(raw);
  if (!Number.isFinite(margin) || margin <= 0 || margin > 10) {
    fail(`Invalid --touch margin "${raw}" — expected a percent between 0 and 10, e.g. 0.25.`);
  }
  return margin;
}

function staticDirection(raw: string): AlertDirection {
  if (raw !== "up" && raw !== "down" && raw !== "either") {
    fail(`Invalid --direction "${raw}" — expected up, down, or either.`);
  }
  return raw;
}

// Permissive on purpose: an unknown symbol is rejected later as "No quote
// available". This only keeps junk (spaces, markup) out of the store.
const SYMBOL_RE = /^[A-Z0-9$^][A-Z0-9.\/$^_-]{0,15}$/;

export function parseAddInput(raw: RawAddFields): Parsed<AddAlertInput> {
  return attempt(() => addInput(raw));
}

function addInput(raw: RawAddFields): AddAlertInput {
  const symbol = typeof raw.symbol === "string" ? raw.symbol.trim().toUpperCase() : "";
  if (symbol === "") {
    fail("Specify the symbol: 'alert add GMED 80.5', or --symbol GMED with other options.");
  }
  if (!SYMBOL_RE.test(symbol)) {
    fail(`Invalid symbol "${raw.symbol}".`);
  }
  if (raw.ma !== undefined) {
    return maInput(symbol, raw);
  }

  const hasLevel = raw.level !== undefined;
  const hasNear = raw.near !== undefined;
  if (hasLevel && hasNear) {
    fail("Specify at most one of --level (static alert) or --near (trailing alert).");
  }
  // --direction means "which crossings fire" for both a static level and a
  // moving-average cross, but a static level also accepts "either". Trailing
  // and volume alerts have their direction built in.
  if (raw.direction !== undefined && !hasLevel) {
    fail("--direction applies to --level (up|down|either) or --ma crosses (up|down).");
  }
  // Parse the volume fields first: they decide whether a bare add is a
  // standalone volume alert, and they own their own validation messages.
  const volume = volumeCondition(raw);
  if (!hasLevel && !hasNear && volume === undefined) {
    fail("Specify --level, --near, or --volume-at-least/--volume-ratio (a standalone volume alert).");
  }

  if (hasLevel) {
    if (raw.trailPercent !== undefined || raw.trailAmount !== undefined) {
      fail("--trail-percent/--trail-amount only apply to trailing alerts (--near).");
    }
    const direction = raw.direction === undefined ? DEFAULT_ALERT_DIRECTION : staticDirection(raw.direction);
    return { kind: "static", symbol, level: positive("--level", raw.level!), direction, volume };
  }
  if (hasNear) {
    const hasPercent = raw.trailPercent !== undefined;
    if (hasPercent === (raw.trailAmount !== undefined)) {
      fail("Specify exactly one of --trail-percent or --trail-amount for a trailing alert.");
    }
    return {
      kind: "trailing",
      symbol,
      near: positive("--near", raw.near!),
      trailType: hasPercent ? "percent" : "amount",
      trailValue: hasPercent ? positive("--trail-percent", raw.trailPercent!) : positive("--trail-amount", raw.trailAmount!),
      volume,
    };
  }
  if (raw.trailPercent !== undefined || raw.trailAmount !== undefined) {
    fail("--trail-percent/--trail-amount require --near.");
  }
  return { kind: "volume", symbol, volume: volume! };
}

function maInput(symbol: string, raw: RawAddFields): AddAlertInput {
  const conflicting = [raw.level, raw.near, raw.trailPercent, raw.trailAmount, raw.volumeAtLeast, raw.volumeRatio, raw.volumePeriod];
  if (conflicting.some((v) => v !== undefined)) {
    fail("--ma can't be combined with --level, --near, --trail-*, or --volume-* (no volume condition on moving averages yet).");
  }
  const spec = maSpec(raw.ma!);

  const isTouch = raw.touch !== undefined && raw.touch !== false;
  const marginPct = isTouch && raw.touch !== true ? touchMargin(raw.touch as Scalar) : DEFAULT_TOUCH_MARGIN_PCT;

  let from: MaApproach = "either";
  if (raw.direction !== undefined) {
    if (isTouch) {
      fail("--direction applies to crosses. For a touch, use --from above|below.");
    }
    if (raw.direction !== "up" && raw.direction !== "down") {
      fail(`Invalid --direction "${raw.direction}" — expected up or down.`);
    }
    from = raw.direction === "up" ? "below" : "above";
  }
  if (raw.from !== undefined) {
    if (!isTouch) {
      fail("--from applies to touches (--touch). For a cross, use --direction up|down.");
    }
    if (raw.from !== "above" && raw.from !== "below") {
      fail(`Invalid --from "${raw.from}" — expected above or below.`);
    }
    from = raw.from;
  }
  return { kind: "ma", symbol, ...spec, trigger: isTouch ? "touch" : "cross", from, marginPct };
}

/** An empty edit is valid here; `editAlert` rejects it as "Nothing to change." */
export function parseAlertEdit(raw: RawEditFields): Parsed<AlertEdit> {
  return attempt(() => alertEdit(raw));
}

function alertEdit(raw: RawEditFields): AlertEdit {
  const edit: AlertEdit = {};
  if (raw.clearLevel === true) {
    if (raw.level !== undefined) {
      fail("--clear-level can't be combined with --level.");
    }
    edit.level = null;
  } else if (raw.level !== undefined) {
    edit.level = positive("--level", raw.level);
  }
  if (raw.direction !== undefined) {
    edit.direction = staticDirection(raw.direction);
  }
  if (raw.trailPercent !== undefined && raw.trailAmount !== undefined) {
    fail("Specify --trail-percent or --trail-amount, not both.");
  }
  if (raw.trailPercent !== undefined) {
    edit.trail = { type: "percent", value: positive("--trail-percent", raw.trailPercent) };
  }
  if (raw.trailAmount !== undefined) {
    edit.trail = { type: "amount", value: positive("--trail-amount", raw.trailAmount) };
  }
  const volume = volumeCondition(raw);
  if (raw.clearVolume === true) {
    if (volume !== undefined) {
      fail("--clear-volume can't be combined with --volume-at-least/--volume-ratio.");
    }
    edit.volume = null;
  } else if (volume !== undefined) {
    edit.volume = volume;
  }
  if (raw.ma !== undefined) {
    edit.ma = maSpec(raw.ma);
  }
  if (raw.touch !== undefined) {
    edit.marginPct = touchMargin(raw.touch);
  }
  if (raw.from !== undefined) {
    if (raw.from !== "above" && raw.from !== "below" && raw.from !== "either") {
      fail(`Invalid --from "${raw.from}" — expected above, below, or either.`);
    }
    edit.from = raw.from;
  }
  return edit;
}

const ADD_KEYS = ["symbol", "level", "near", "trailPercent", "trailAmount", "volumeAtLeast", "volumeRatio", "volumePeriod", "ma", "touch", "direction", "from"] as const;
const EDIT_KEYS = ["level", "clearLevel", "direction", "trailPercent", "trailAmount", "volumeAtLeast", "volumeRatio", "volumePeriod", "clearVolume", "ma", "touch", "from"] as const;

/**
 * Narrows untrusted JSON params (from the queue) to known scalar fields. An
 * unknown key is rejected rather than ignored: a field the worker silently
 * dropped would apply a different change than the one that was clicked.
 */
function scalarFields(params: unknown, keys: readonly string[]): Record<string, string | number | boolean> {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    fail("params must be an object.");
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!keys.includes(key)) {
      fail(`Unknown field "${key}".`);
    }
    if (value === null || value === undefined || value === "") {
      continue;
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      fail(`Field "${key}" must be a string, number, or boolean.`);
    }
    out[key] = value;
  }
  return out;
}

export function addFieldsFromJson(params: unknown): Parsed<RawAddFields> {
  return attempt(() => scalarFields(params, ADD_KEYS) as RawAddFields);
}

export function editFieldsFromJson(params: unknown): Parsed<RawEditFields> {
  return attempt(() => scalarFields(params, EDIT_KEYS) as RawEditFields);
}

/** A string property of an untrusted value, or null. */
export function stringField(value: unknown, key: string): string | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const v = (value as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

// ---- holdings --------------------------------------------------------------
//
// Holdings op results are published in dashboard.json, which is public, and a
// rejection's message becomes that result. So these messages name the field
// but never echo a value: no share counts, basis, or prices, even wrong ones.

export interface LotInput {
  symbol: string;
  count: number;
  basisPerShare: number;
  purchaseDate?: string;
  account?: string;
  /** Set together to replace whatever stop(s) the symbol already has with one new stop. */
  stopPrice?: number;
  stopCount?: number;
}

export interface StopInput {
  symbol: string;
  stopPrice: number;
  /** null: whatever is currently held. */
  count: number | null;
}

const LOT_KEYS = ["symbol", "count", "basisPerShare", "purchaseDate", "account", "stopPrice", "stopCount"];
const LOT_EDIT_KEYS = ["count", "basisPerShare", "purchaseDate", "account"];
const STOP_KEYS = ["symbol", "stopPrice", "count"];

/** Like scalarFields, but keeps empty and null values: in an edit they mean "clear". */
function objectFields(params: unknown, keys: string[]): Record<string, unknown> {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    fail("params must be an object.");
  }
  for (const key of Object.keys(params)) {
    if (!keys.includes(key)) {
      fail(`Unknown field "${key}".`);
    }
  }
  return params as Record<string, unknown>;
}

const present = (v: unknown) => v !== undefined && v !== null && v !== "";

function positiveValue(label: string, raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    fail(`${label} must be a positive number.`);
  }
  return n;
}

function symbolValue(raw: unknown): string {
  const symbol = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (symbol === "") {
    fail("Specify the symbol.");
  }
  if (!SYMBOL_RE.test(symbol)) {
    fail("Invalid symbol.");
  }
  return symbol;
}

/** A calendar date as typed, not a market date, so a UTC round-trip is the right check here. */
function dateValue(raw: unknown): string {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    fail("Purchase date must be YYYY-MM-DD.");
  }
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    fail("Purchase date must be a real date.");
  }
  return raw;
}

function accountValue(raw: unknown): string | null {
  if (!present(raw)) {
    return null;
  }
  if (typeof raw !== "string" || raw.trim().length > 40) {
    fail("Account must be text of at most 40 characters.");
  }
  return raw.trim() || null;
}

export function parseLotInput(params: unknown): Parsed<LotInput> {
  return attempt(() => {
    const f = objectFields(params, LOT_KEYS);
    const account = accountValue(f.account);
    const stopPrice = present(f.stopPrice) ? positiveValue("Stop price", f.stopPrice) : undefined;
    const stopCount = present(f.stopCount) ? positiveValue("Shares covered", f.stopCount) : undefined;
    if (stopCount !== undefined && stopPrice === undefined) {
      fail("A stop needs a price.");
    }
    return {
      symbol: symbolValue(f.symbol),
      count: positiveValue("Shares", f.count),
      basisPerShare: positiveValue("Basis per share", f.basisPerShare),
      ...(present(f.purchaseDate) ? { purchaseDate: dateValue(f.purchaseDate) } : {}),
      ...(account !== null ? { account } : {}),
      ...(stopPrice !== undefined ? { stopPrice } : {}),
      ...(stopCount !== undefined ? { stopCount } : {}),
    };
  });
}

export function parseLotEdit(params: unknown): Parsed<{ count?: number; basisPerShare?: number; purchaseDate?: string; account?: string | null }> {
  return attempt(() => {
    const f = objectFields(params, LOT_EDIT_KEYS);
    const edit: { count?: number; basisPerShare?: number; purchaseDate?: string; account?: string | null } = {};
    if ("count" in f) edit.count = positiveValue("Shares", f.count);
    if ("basisPerShare" in f) edit.basisPerShare = positiveValue("Basis per share", f.basisPerShare);
    if ("purchaseDate" in f) edit.purchaseDate = dateValue(f.purchaseDate);
    if ("account" in f) edit.account = accountValue(f.account);
    if (Object.keys(edit).length === 0) {
      fail("Nothing to change.");
    }
    return edit;
  });
}

export function parseStopInput(params: unknown): Parsed<StopInput> {
  return attempt(() => {
    const f = objectFields(params, STOP_KEYS);
    return {
      symbol: symbolValue(f.symbol),
      stopPrice: positiveValue("Stop price", f.stopPrice),
      count: present(f.count) ? positiveValue("Shares covered", f.count) : null,
    };
  });
}
