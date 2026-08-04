import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ANALYSIS_PARAMS } from "../src/analysis.js";
import { loadTuningConfig, needsBeta, resolveParams, resolveParamsForSymbol, type TuningConfig } from "../src/tuning.js";

async function failingGetBeta(): Promise<number | null> {
  throw new Error("getBeta should not have been called");
}

describe("resolveParams", () => {
  it("returns the built-in defaults when the config is empty and beta is null", () => {
    const result = resolveParams("AAPL", {}, null);
    expect(result).toEqual(DEFAULT_ANALYSIS_PARAMS);
  });

  it("merges config.default over the built-in defaults", () => {
    const config: TuningConfig = { default: { volumeRatioThreshold: 2.0 } };
    const result = resolveParams("AAPL", config, null);
    expect(result.volumeRatioThreshold).toBe(2.0);
    expect(result.baselineDays).toBe(DEFAULT_ANALYSIS_PARAMS.baselineDays);
  });

  it("scales recentHighTolerance by beta when enabled and no override exists", () => {
    const config: TuningConfig = { default: { recentHighTolerance: 0.02 } };
    const result = resolveParams("TSLA", config, 2.0);
    expect(result.recentHighTolerance).toBeCloseTo(0.04);
  });

  it("does not scale by beta when scaleToleranceByBeta is false", () => {
    const config: TuningConfig = { default: { recentHighTolerance: 0.02 }, scaleToleranceByBeta: false };
    const result = resolveParams("TSLA", config, 2.0);
    expect(result.recentHighTolerance).toBe(0.02);
  });

  it("lets a per-symbol override win over both beta-scaling and the config default", () => {
    const config: TuningConfig = {
      default: { recentHighTolerance: 0.02, volumeRatioThreshold: 1.5 },
      overrides: { TSLA: { recentHighTolerance: 0.1, volumeRatioThreshold: 3.0 } },
    };
    const result = resolveParams("TSLA", config, 2.0); // would otherwise scale to 0.04
    expect(result.recentHighTolerance).toBe(0.1);
    expect(result.volumeRatioThreshold).toBe(3.0);
  });

  it("leaves an unrelated symbol untouched by another symbol's override", () => {
    const config: TuningConfig = { overrides: { TSLA: { volumeRatioThreshold: 3.0 } } };
    const result = resolveParams("AAPL", config, null);
    expect(result.volumeRatioThreshold).toBe(DEFAULT_ANALYSIS_PARAMS.volumeRatioThreshold);
  });
});

describe("needsBeta", () => {
  it("is false when there's no config file at all", () => {
    expect(needsBeta("AAPL", {}, false)).toBe(false);
  });

  it("is false when scaleToleranceByBeta is explicitly disabled", () => {
    expect(needsBeta("AAPL", { scaleToleranceByBeta: false }, true)).toBe(false);
  });

  it("is true by default when a config file exists and no override applies", () => {
    expect(needsBeta("AAPL", {}, true)).toBe(true);
  });

  it("is false when the symbol has an explicit recentHighTolerance override", () => {
    const config: TuningConfig = { overrides: { AAPL: { recentHighTolerance: 0.05 } } };
    expect(needsBeta("AAPL", config, true)).toBe(false);
  });

  it("is true for a symbol whose override doesn't touch recentHighTolerance", () => {
    const config: TuningConfig = { overrides: { AAPL: { volumeRatioThreshold: 3.0 } } };
    expect(needsBeta("AAPL", config, true)).toBe(true);
  });
});

describe("resolveParamsForSymbol", () => {
  it("never calls getBeta when there's no config file", async () => {
    const result = await resolveParamsForSymbol("AAPL", {}, false, failingGetBeta);
    expect(result).toEqual(DEFAULT_ANALYSIS_PARAMS);
  });

  it("calls getBeta and applies scaling when needed", async () => {
    const config: TuningConfig = { default: { recentHighTolerance: 0.02 } };
    const result = await resolveParamsForSymbol("TSLA", config, true, async () => 1.5);
    expect(result.recentHighTolerance).toBeCloseTo(0.03);
  });

  it("skips the getBeta call entirely when an override already covers recentHighTolerance", async () => {
    const config: TuningConfig = { overrides: { AAPL: { recentHighTolerance: 0.05 } } };
    const result = await resolveParamsForSymbol("AAPL", config, true, failingGetBeta);
    expect(result.recentHighTolerance).toBe(0.05);
  });
});

describe("loadTuningConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tv-alerts-tuning-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the file doesn't exist", () => {
    expect(loadTuningConfig(join(dir, "missing.json"))).toBeNull();
  });

  it("parses an existing config file", () => {
    const file = join(dir, "analysis.config.json");
    writeFileSync(file, JSON.stringify({ default: { volumeRatioThreshold: 2.5 } }));
    expect(loadTuningConfig(file)).toEqual({ default: { volumeRatioThreshold: 2.5 } });
  });
});
