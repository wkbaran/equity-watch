/**
 * Share counts in and out: "2.5M" typed into a form or a flag, "2.5M" shown
 * wherever a volume is displayed.
 *
 * Volumes stay **numbers** in every store and on the wire. The suffix is a
 * presentation and input convenience only, applied at the two edges, because
 * the engine compares and divides these (`observed >= required`, the observed
 * ratio on a trigger) and a stored "2.5M" would have to be re-parsed at every
 * one of those sites. `RevisitEntry.condition` is the one place a formatted
 * volume is persisted, and that is a recorded sentence, not a number.
 *
 * `web/app.js` carries a byte-for-byte copy of these three functions - the page
 * is served as plain files with no bundler, so it cannot import this. The page
 * must reject and render exactly what the worker does, so `tests/volume.test.ts`
 * evaluates the copy out of `app.js` and checks both agree on a table of cases.
 * If you change anything here, change it there.
 */

/** Ascending, because parsing and formatting both walk it from the big end. */
const VOLUME_UNITS: ReadonlyArray<{ suffix: string; factor: number }> = [
  { suffix: "K", factor: 1e3 },
  { suffix: "M", factor: 1e6 },
  { suffix: "B", factor: 1e9 },
];

// A number with optional thousands separators, then an optional unit. The space
// before the suffix is optional because TradingView writes "Volume Crossing 3 M"
// and a person typing it copies that (src/parse.ts reads the same shape).
const VOLUME_RE = /^([\d,]*\.?\d+)\s*([KMB]?)$/i;

/**
 * Shares from "2.5M", "250k", "3 M", "1,500,000" or "1500000".
 *
 * Returns a whole number of shares, or null for anything that isn't a positive
 * count - callers word their own rejection. Rounded because a fraction of a
 * share is not a thing anyone can trade, and `requiredVolume` rounds anyway.
 */
export function parseVolume(raw: string | number): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
  }
  const match = VOLUME_RE.exec(raw.trim());
  if (!match) {
    return null;
  }
  const value = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  const unit = VOLUME_UNITS.find((u) => u.suffix === match[2].toUpperCase());
  return Math.round(value * (unit?.factor ?? 1));
}

/**
 * A volume for reading: "2.5M", "250K", "850".
 *
 * Lossy on purpose - 1,234,567 reads as "1.23M", which is what someone
 * scanning a page wants. Never use it to fill an input the user can save;
 * that is what `volumeInputValue` is for.
 */
export function formatVolume(n: number): string {
  if (!Number.isFinite(n)) {
    return String(n);
  }
  const { value, suffix } = scale(n);
  return `${value}${suffix}`;
}

/**
 * A volume for an input the user may save unchanged: exact, so a form that
 * prefills it and is submitted untouched sends back the number it started with.
 *
 * Only uses a suffix when it costs nothing - the same suffix `formatVolume`
 * would pick, and exact at two decimals - so 2,500,000 prefills as "2.5M" but
 * 1,234,567 prefills as "1234567" rather than silently becoming 1,230,000 the
 * moment the user hits save.
 */
export function volumeInputValue(n: number): string {
  if (!Number.isFinite(n)) {
    return "";
  }
  const { value, suffix, factor } = scale(n);
  return suffix !== "" && value * factor === n ? `${value}${suffix}` : String(trim(n, 0));
}

/** Decimals kept by both renderings; shared so `volumeInputValue` can tell when a suffix is exact. */
const VOLUME_DECIMALS = 2;

/**
 * Splits a share count into the largest unit that fits, and the value in it.
 * `factor` is 1 with an empty suffix below a thousand, so callers can multiply
 * back unconditionally.
 */
function scale(n: number): { value: number; suffix: string; factor: number } {
  const magnitude = Math.abs(n);
  let index = -1;
  for (let i = VOLUME_UNITS.length - 1; i >= 0; i--) {
    if (magnitude >= VOLUME_UNITS[i].factor) {
      index = i;
      break;
    }
  }
  if (index === -1) {
    return { value: trim(n, 0), suffix: "", factor: 1 };
  }
  let { suffix, factor } = VOLUME_UNITS[index];
  let value = trim(n / factor, VOLUME_DECIMALS);
  // Rounding can overflow the unit: 999,999 is 999.999K, which prints as
  // "1000K" at two decimals. Step up rather than say that.
  if (Math.abs(value) >= 1000 && index + 1 < VOLUME_UNITS.length) {
    ({ suffix, factor } = VOLUME_UNITS[index + 1]);
    value = trim(n / factor, VOLUME_DECIMALS);
  }
  return { value, suffix, factor };
}

/** Rounds to `places` and drops trailing zeros, so 3.00 reads "3" not "3.00". */
function trim(n: number, places: number): number {
  return Number(n.toFixed(places));
}
