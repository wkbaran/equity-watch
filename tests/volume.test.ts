import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { formatVolume, parseVolume, volumeInputValue } from "../src/volume.js";

describe("parseVolume", () => {
  it("takes the K/M/B shorthand, in either case, with or without a space", () => {
    expect(parseVolume("2.5M")).toBe(2_500_000);
    expect(parseVolume("2.5m")).toBe(2_500_000);
    // TradingView writes "Volume Crossing 3 M", so a person typing it copies that.
    expect(parseVolume("3 M")).toBe(3_000_000);
    expect(parseVolume("250K")).toBe(250_000);
    expect(parseVolume("250k")).toBe(250_000);
    expect(parseVolume("1.5B")).toBe(1_500_000_000);
    expect(parseVolume(" 4M ")).toBe(4_000_000);
    expect(parseVolume(".5M")).toBe(500_000);
  });

  it("still takes a plain count, with or without separators", () => {
    expect(parseVolume("1500000")).toBe(1_500_000);
    expect(parseVolume("1,500,000")).toBe(1_500_000);
    expect(parseVolume(2_500_000)).toBe(2_500_000);
  });

  it("rounds to whole shares", () => {
    expect(parseVolume("1.0000005M")).toBe(1_000_001);
    expect(parseVolume(999.4)).toBe(999);
  });

  it("rejects anything that isn't a positive count", () => {
    for (const raw of ["", "  ", "0", "-3M", "M", "3x", "1.5.2", "2.5MM", "abc", "1e6", "NaN"]) {
      expect(parseVolume(raw), raw).toBeNull();
    }
    expect(parseVolume(0)).toBeNull();
    expect(parseVolume(Number.NaN)).toBeNull();
  });
});

describe("formatVolume", () => {
  it("picks the largest unit that fits", () => {
    expect(formatVolume(850)).toBe("850");
    expect(formatVolume(1_000)).toBe("1K");
    expect(formatVolume(250_000)).toBe("250K");
    expect(formatVolume(2_500_000)).toBe("2.5M");
    expect(formatVolume(1_000_000_000)).toBe("1B");
  });

  it("keeps at most two decimals, with no trailing zeros", () => {
    expect(formatVolume(1_234_567)).toBe("1.23M");
    expect(formatVolume(12_345)).toBe("12.35K");
    expect(formatVolume(3_000_000)).toBe("3M");
  });

  it("steps up rather than letting rounding overflow the unit", () => {
    // 999,999 is 999.999K, which would otherwise print as "1000K".
    expect(formatVolume(999_999)).toBe("1M");
    expect(formatVolume(999_999_999)).toBe("1B");
  });
});

describe("volumeInputValue", () => {
  it("uses a suffix only when it is exact, so a prefilled form round-trips", () => {
    expect(volumeInputValue(2_500_000)).toBe("2.5M");
    expect(volumeInputValue(5_000_000)).toBe("5M");
    expect(volumeInputValue(250_000)).toBe("250K");
    expect(volumeInputValue(1_050)).toBe("1.05K");
    // "1.23M" would save as 1,230,000 - a silent edit nobody asked for.
    expect(volumeInputValue(1_234_567)).toBe("1234567");
    expect(volumeInputValue(999_999)).toBe("999999");
    expect(volumeInputValue(12_345)).toBe("12345");
  });

  it("round-trips every value through parseVolume", () => {
    const counts = [1, 850, 999, 1_000, 1_050, 1_234, 12_345, 250_000, 999_999, 1_000_000, 1_234_567, 2_500_000, 1_234_567_890];
    for (const n of counts) {
      expect(parseVolume(volumeInputValue(n)), String(n)).toBe(n);
    }
  });
});

/**
 * web/app.js carries its own copy of these three functions: the page is served
 * as plain files with no bundler, so it cannot import src/volume.ts. It has to
 * accept and render exactly what the worker does - a page that shows "2.5M" for
 * a threshold the CLI prints differently, or accepts input the worker rejects,
 * is worse than no shorthand at all. So evaluate the copy and compare.
 */
describe("web/app.js carries a faithful copy", () => {
  const appJs = readFileSync(new URL("../web/app.js", import.meta.url), "utf-8");
  const start = appJs.indexOf("  const VOLUME_UNITS = [");
  const end = appJs.indexOf("  const shares = (n) =>");
  expect(start, "the volume block moved in web/app.js").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const copy = new Function(`${appJs.slice(start, end)}\nreturn { parseVolume, formatVolume, volumeInputValue };`)() as {
    parseVolume: (raw: string | number) => number | null;
    formatVolume: (n: number) => string;
    volumeInputValue: (n: number) => string;
  };

  const counts = [1, 850, 999, 1_000, 1_050, 1_234, 12_345, 250_000, 999_999, 1_000_000, 1_234_567, 2_500_000, 3_000_000, 1e9, 1_234_567_890];
  const inputs = ["2.5M", "2.5m", "3 M", "250K", "250k", "1.5B", ".5M", "1500000", "1,500,000", " 4M ", "", "0", "-3M", "M", "3x", "2.5MM", "1e6"];

  it("agrees on every rendering", () => {
    for (const n of counts) {
      expect(copy.formatVolume(n), `formatVolume(${n})`).toBe(formatVolume(n));
      expect(copy.volumeInputValue(n), `volumeInputValue(${n})`).toBe(volumeInputValue(n));
    }
  });

  it("agrees on every input, accepted or rejected", () => {
    for (const raw of inputs) {
      expect(copy.parseVolume(raw), `parseVolume(${JSON.stringify(raw)})`).toBe(parseVolume(raw));
    }
  });
});
