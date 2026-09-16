import { describe, expect, it } from "vitest";
import { COVER_ABOVE_PRICE, coverLevel } from "../src/holdings/cover.js";
import { ignoredSymbols, isIgnored } from "../src/tuning.js";

describe("coverLevel", () => {
  it("is 10% above price when the position is up", () => {
    expect(coverLevel(100, 108).level).toBe(118.8);
    expect(coverLevel(12.97, 17.3).level).toBe(19.03);
  });

  it("is 10% above basis when price is below it", () => {
    // The higher of the two references, so an underwater position is asked to
    // clear its cost before it says anything.
    expect(coverLevel(100, 95).level).toBe(110);
    expect(coverLevel(22.24, 21.12).level).toBe(24.46);
  });

  it("asks a deep loser for a full recovery, which can be far away", () => {
    // Down 69%: basis+10% is more than triple the price. Accepted deliberately;
    // it only applies to a position with no alert, i.e. normally a fresh buy.
    const r = coverLevel(4.45, 1.38);
    expect(r.level).toBe(4.9);
    expect(r.pctFromBasis).toBeCloseTo(-69, 0);
  });

  it("takes whichever reference is higher", () => {
    expect(coverLevel(50, 100).level).toBe(110);
    expect(coverLevel(1000, 100).level).toBe(1100);
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

  it("stays above the live price on a fresh buy, where price and basis are equal", () => {
    expect(coverLevel(50, 50).level).toBe(55);
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
