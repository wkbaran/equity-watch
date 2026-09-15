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
  const threshold = positive("--volume-at-least", raw.volumeAtLeast);
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
  if (raw.level !== undefined) {
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
const EDIT_KEYS = ["level", "direction", "trailPercent", "trailAmount", "volumeAtLeast", "volumeRatio", "volumePeriod", "clearVolume", "ma", "touch", "from"] as const;

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
