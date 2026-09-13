import { describe, expect, it } from "vitest";
import { mergeImportPlans, parseWebullHoldings, reconcileQuantity } from "../src/holdings/import.js";

/**
 * Anonymized fixtures, not the real exports.
 *
 * They are synthetic tickers and scaled figures, but every structural quirk
 * found in the real 2026-09-11 Webull files is reproduced exactly, because
 * those quirks are the whole reason this importer exists:
 *
 *   QTYA / QTYB  - `Quantity` disagrees with both derived share counts
 *   ROUND        - Market Value / Last Price lands off-integer from rounding
 *   OPTX $5...   - an option row with a truncated contract symbol
 *   CASHX        - the same symbol held in both accounts
 *
 * The real exports stay out of git (see .gitignore); this keeps the suite
 * runnable anywhere without shipping brokerage positions.
 */
const ROTH = "tests/fixtures/webull_roth_sample.csv";
const MARGIN = "tests/fixtures/webull_margin_sample.csv";

describe("reconcileQuantity", () => {
  it("trusts the stated quantity when everything agrees", () => {
    const r = reconcileQuantity(1, 235.62, 235.62, 240.26, 240.26);
    expect(r.count).toBe(1);
    expect(r.disagreement).toBeNull();
  });

  it("overrides a wrong quantity when both independent figures agree", () => {
    // The shape of the real failure: the file says 3 shares, but
    // 340.55/68.11 and 367.55/73.51 independently both say 5.
    const r = reconcileQuantity(3, 340.55, 68.11, 367.55, 73.51);
    expect(r.count).toBe(5);
    expect(r.disagreement).toContain("file says 3 shares");
    expect(r.disagreement).toContain("say 5");
  });

  it("tolerates rounding noise rather than flagging it", () => {
    // 341 real shares, but Last Price is rounded to the cent so market value
    // divides to 340.80.
    expect(reconcileQuantity(341, 5902.71, 17.32, 4421.29, 12.97).disagreement).toBeNull();
    expect(reconcileQuantity(12, 357.96, 30, 367.06, 30.59).disagreement).toBeNull();
  });

  it("refuses to override on one bad cell without corroboration", () => {
    // Cost columns imply 10 shares but market value says 3: not enough
    // agreement to silently rewrite the position.
    const r = reconcileQuantity(3, 300, 100, 1000, 100);
    expect(r.count).toBe(3);
    expect(r.disagreement).toBeNull();
  });

  it("falls back to the stated quantity when cost data is unusable", () => {
    expect(reconcileQuantity(7, 100, 10, 0, 0).count).toBe(7);
  });
});

describe("parseWebullHoldings", () => {
  const roth = parseWebullHoldings(ROTH, "roth");
  const margin = parseWebullHoldings(MARGIN, "margin");

  it("reads every row and accounts for each one", () => {
    expect(roth.rowsRead).toBe(8);
    expect(margin.rowsRead).toBe(12);
    expect(roth.lots.length + roth.skipped.length).toBe(roth.rowsRead);
    expect(margin.lots.length + margin.skipped.length).toBe(margin.rowsRead);
  });

  it("skips the option position, which this system does not model", () => {
    const skip = margin.skipped.find((s) => s.symbol.startsWith("OPTX"))!;
    expect(skip.reason).toContain("Option");
    expect(margin.lots.find((l) => l.symbol.startsWith("OPTX"))).toBeUndefined();
  });

  it("corrects a position whose stated quantity is wrong, in either direction", () => {
    // Understated in one account, overstated in the other.
    expect(roth.lots.find((l) => l.symbol === "QTYA")!.count).toBe(5);
    expect(margin.lots.find((l) => l.symbol === "QTYB")!.count).toBe(6);
    expect(roth.warnings.some((w) => w.symbol === "QTYA")).toBe(true);
    expect(margin.warnings.some((w) => w.symbol === "QTYB")).toBe(true);
  });

  it("leaves a rounding-noise position untouched and unflagged", () => {
    expect(margin.lots.find((l) => l.symbol === "ROUND")!.count).toBe(341);
    expect(margin.warnings.some((w) => w.symbol === "ROUND")).toBe(false);
  });

  it("uses Avg Cost as the per-share basis", () => {
    expect(margin.lots.find((l) => l.symbol === "ROUND")!.basisPerShare).toBe(12.97);
    expect(roth.lots.find((l) => l.symbol === "MIDA")!.basisPerShare).toBe(22.24);
  });

  it("labels every lot with its account", () => {
    expect(roth.lots.every((l) => l.account === "roth")).toBe(true);
    expect(margin.lots.every((l) => l.account === "margin")).toBe(true);
  });

  it("carries the company name through for display", () => {
    expect(roth.lots.find((l) => l.symbol === "MIDA")!.name).toBe("Midcap Alpha Corp");
  });
});

describe("mergeImportPlans", () => {
  const merged = mergeImportPlans([parseWebullHoldings(ROTH, "roth"), parseWebullHoldings(MARGIN, "margin")]);

  it("flags a symbol held in more than one account", () => {
    const warning = merged.warnings.find((w) => w.symbol === "CASHX")!;
    expect(warning.message).toContain("held in 2 accounts");
    expect(warning.message).toContain("roth 45@91.48");
    expect(warning.message).toContain("margin 86@91.51");
  });

  it("keeps both accounts' lots rather than collapsing them", () => {
    expect(merged.lots.filter((l) => l.symbol === "CASHX")).toHaveLength(2);
  });

  it("carries every source row through to exactly one outcome", () => {
    expect(merged.rowsRead).toBe(20);
    expect(merged.lots.length).toBe(19);
    expect(merged.skipped.length).toBe(1);
  });
});
