import { describe, expect, it } from "vitest";
import { COVER_ABOVE_PRICE, coverLevel } from "../src/holdings/cover.js";
import { ignoredSymbols, isIgnored } from "../src/tuning.js";

describe("coverLevel", () => {
  it("is 10% above the current price, whatever the basis", () => {
    // Basis no longer affects the level at all - only whether the position is
    // interesting elsewhere.
    expect(coverLevel(100, 95).level).toBe(104.5);
    expect(coverLevel(100, 108).level).toBe(118.8);
    expect(coverLevel(12.97, 17.3).level).toBe(19.03);
  });

  it("gives a beaten-down position a reachable level instead of demanding a recovery", () => {
    // Down 69%: anchoring to basis would ask for a near-triple before saying
    // anything. Anchoring to price asks for a 10% bounce.
    const r = coverLevel(4.45, 1.38);
    expect(r.level).toBe(1.52);
    expect(r.pctFromBasis).toBeCloseTo(-69, 0);
  });

  it("gives the same answer either side of basis", () => {
    // The rule has no branches, so nothing changes as price crosses basis.
    expect(coverLevel(100, 100).level).toBe(coverLevel(50, 100).level);
    expect(coverLevel(1000, 100).level).toBe(coverLevel(1, 100).level);
  });

  it("never places a level at or below the live price", () => {
    // An alert at exactly the live price has no side to fire on and addAlert
    // rejects it outright.
    for (const [basis, price] of [[100, 110], [100, 200], [50, 55], [10, 10], [0.5, 0.5], [4.45, 1.38]]) {
      expect(coverLevel(basis, price).level).toBeGreaterThan(price);
    }
  });

  it("reports distance from basis without letting it move the level", () => {
    expect(coverLevel(10, 20).pctFromBasis).toBeCloseTo(100, 5);
    expect(coverLevel(20, 10).pctFromBasis).toBeCloseTo(-50, 5);
    expect(coverLevel(0, 10).pctFromBasis).toBe(0); // no basis to compare against
  });

  it("uses one flat percentage, with no volatility scaling", () => {
    expect(coverLevel(8.4, 11).level).toBe(12.1);
    expect(COVER_ABOVE_PRICE).toBe(0.1);
  });
});

describe("ignoreSymbols config", () => {
  it("matches case-insensitively and ignores blank entries", () => {
    const set = ignoredSymbols({ ignoreSymbols: ["BIL", " sgov ", ""] });
    expect(isIgnored("bil", set)).toBe(true);
    expect(isIgnored("SGOV", set)).toBe(true);
    expect(isIgnored("AAPL", set)).toBe(false);
    expect(set.size).toBe(2);
  });

  it("is empty when the config is absent or says nothing", () => {
    expect(ignoredSymbols(null).size).toBe(0);
    expect(ignoredSymbols({}).size).toBe(0);
  });
});
