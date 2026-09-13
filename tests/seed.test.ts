import { describe, expect, it } from "vitest";
import {
  baseSymbol,
  buildSeedPlan,
  isImplausibleLevel,
  parseLastTriggered,
  resolveLevel,
  volumeConditionFor,
  type SeedCandidate,
} from "../src/alerts/seed.js";
import { classifyDescription } from "../src/parse.js";

/**
 * Trimmed fixtures, not the full exports. Every row is verbatim from the real
 * 2026-09-12 files; the set was chosen to preserve each behaviour asserted
 * below - ladder collapse, price+volume combination, standalone volume, the
 * compound alert, stated directions, ticker collisions, the comma-formatted
 * and 4-decimal price forms, every skip reason, and all three statuses.
 * The full exports stay out of git.
 */
const LIST = "tests/fixtures/tradingview_alerts_sample.csv";
const LOG = "tests/fixtures/tradingview_alert_log_sample.csv";

describe("classifyDescription - shapes the TradingView exports actually contain", () => {
  it("reads the direction out of a Crossing Up/Down alert instead of dropping it", () => {
    // These used to fall through to "other" because the level regex demanded
    // digits immediately after "Crossing".
    expect(classifyDescription("ACI Crossing Up 14.10")).toMatchObject({
      alertType: "price_cross",
      level: 14.1,
      direction: "up",
    });
    expect(classifyDescription("CHEF Crossing Down 91.00")).toMatchObject({
      alertType: "price_cross",
      level: 91,
      direction: "down",
    });
  });

  it("splits a compound price-AND-volume alert into both halves", () => {
    expect(classifyDescription("UNP Crossing 277.50 AND Volume Crossing 3 M on UNP, 1D")).toMatchObject({
      alertType: "price_cross",
      level: 277.5,
      andVolume: 3_000_000,
    });
  });

  it("names drawing/pattern alerts rather than lumping them into other", () => {
    expect(classifyDescription("AGNC, 1D Exiting rectangle").alertType).toBe("pattern");
  });

  it("still classifies the plain shapes it always did", () => {
    expect(classifyDescription("MKL Crossing 2,003.72")).toMatchObject({ alertType: "price_cross", level: 2003.72 });
    expect(classifyDescription("SUI, 1D Crossing trendline").alertType).toBe("trendline_cross");
    expect(classifyDescription("Volume Crossing 4.5 M on ACHC, 1D")).toMatchObject({
      alertType: "volume_cross",
      level: 4_500_000,
    });
  });
});

describe("seed helpers", () => {
  it("parses the alert-list export's own timestamp format", () => {
    expect(parseLastTriggered("Mon 27 Jul '26 07:30:12")).toBe("2026-07-27T07:30:12.000Z");
    expect(parseLastTriggered("")).toBeNull();
    expect(parseLastTriggered("2026-07-27T07:30:12Z")).toBeNull(); // ISO is the *other* export
  });

  it("strips the chart-timeframe suffix off the symbol column", () => {
    expect(baseSymbol("CDRE, 1D")).toBe("CDRE");
    expect(baseSymbol("aapl")).toBe("AAPL");
  });

  it("maps a chart timeframe onto a volume window", () => {
    expect(volumeConditionFor(1000, "1D")).toEqual({ threshold: 1000, mode: "today" });
    expect(volumeConditionFor(1000, null)).toEqual({ threshold: 1000, mode: "today" });
    expect(volumeConditionFor(1000, "1h")).toEqual({ threshold: 1000, mode: "period", periodValue: 1, periodUnit: "h" });
    // A weekly bar has no "week" unit in VolumeCondition, so it becomes 7 days.
    expect(volumeConditionFor(1000, "1W")).toEqual({ threshold: 1000, mode: "period", periodValue: 7, periodUnit: "d" });
  });

  it("flags levels that belong to a different instrument on the same ticker", () => {
    expect(isImplausibleLevel(243.5, 37)).toBe(true);
    expect(isImplausibleLevel(37.14, 37)).toBe(false);
    expect(isImplausibleLevel(100, 0)).toBe(false); // no price to judge against
  });
});

describe("resolveLevel", () => {
  function candidate(overrides: Partial<SeedCandidate> = {}): SeedCandidate {
    return {
      symbol: "PPL",
      level: 243.5,
      side: null,
      volume: null,
      collapsedFrom: 4,
      levelsSeen: [37.14, 231.55, 238.91, 243.5],
      lastFiredAt: null,
      firstSeenAt: null,
      allFired: false,
      ...overrides,
    };
  }

  it("recovers the right listing's level instead of discarding the ticker", () => {
    // "Highest wins" is correct within one instrument but picks the foreign
    // listing on a colliding ticker.
    const resolved = resolveLevel(candidate(), 37.0);
    expect(resolved.level).toBe(37.14);
    expect(resolved.discarded).toEqual([231.55, 238.91, 243.5]);
  });

  it("takes the highest of several plausible levels", () => {
    const resolved = resolveLevel(candidate({ levelsSeen: [100, 105, 110] }), 95);
    expect(resolved.level).toBe(110);
  });

  it("takes the lowest when the alert states a downside direction", () => {
    const resolved = resolveLevel(candidate({ levelsSeen: [80, 90, 95], side: "below" }), 100);
    expect(resolved.level).toBe(80);
  });

  it("gives up only when nothing is plausible", () => {
    const resolved = resolveLevel(candidate({ levelsSeen: [500, 600] }), 10);
    expect(resolved.level).toBeNull();
  });

  it("leaves a volume condition intact when every price level is implausible", () => {
    // MTD: the only level (173.50) belongs to another instrument at a real
    // price of ~1293, but its 55K/1W volume alert is still good on its own and
    // must not be discarded along with the bad level.
    const mtd = candidate({
      symbol: "MTD",
      levelsSeen: [173.5],
      volume: { threshold: 55_000, mode: "period", periodValue: 7, periodUnit: "d" },
    });
    expect(resolveLevel(mtd, 1293.52).level).toBeNull();
    expect(mtd.volume).not.toBeNull(); // the caller still has it to seed standalone
  });
});

describe("buildSeedPlan", () => {
  const plan = buildSeedPlan(LIST, LOG);

  it("reads both files and loses nothing silently", () => {
    expect(plan.rowsRead).toEqual({ list: 71, log: 64 });
    // Every row either becomes a candidate or is explicitly skipped with a reason.
    expect(plan.skipped.every((s) => s.reason.length > 0)).toBe(true);
  });

  it("collapses two alerts of the same type on one ticker into one", () => {
    const crm = plan.candidates.find((c) => c.symbol === "CRM")!;
    expect(crm.levelsSeen.length).toBeGreaterThan(1);
    expect(crm.level).toBe(271.71); // the outermost target, not a mid-ladder one
    expect(plan.candidates.filter((c) => c.symbol === "CRM")).toHaveLength(1);
  });

  it("combines a price and a volume alert on one ticker into a single AND alert", () => {
    const fitb = plan.candidates.find((c) => c.symbol === "FITB")!;
    expect(fitb.level).toBe(55.85);
    expect(fitb.volume).toEqual({ threshold: 12_750_000, mode: "today" });
    expect(plan.candidates.filter((c) => c.symbol === "FITB")).toHaveLength(1);
  });

  it("leaves a volume alert standalone when the ticker has no price alert", () => {
    const pnc = plan.candidates.find((c) => c.symbol === "PNC")!;
    expect(pnc.levelsSeen).toEqual([]);
    expect(pnc.volume).toEqual({ threshold: 2_600_000, mode: "today" });
  });

  it("folds the compound UNP alert's volume half into the collapsed alert", () => {
    const unp = plan.candidates.find((c) => c.symbol === "UNP")!;
    expect(unp.volume).toEqual({ threshold: 3_000_000, mode: "today" });
  });

  it("carries a stated direction through instead of inferring it", () => {
    expect(plan.candidates.find((c) => c.symbol === "ACI")!.side).toBe("above");
    expect(plan.candidates.find((c) => c.symbol === "CHEF")!.side).toBe("below");
  });

  it("marks the tickers whose every alert had already fired", () => {
    // These are the ones that no longer exist in TradingView at all and are
    // the whole reason the log export matters.
    const allFired = plan.candidates.filter((c) => c.allFired);
    expect(allFired.length).toBeGreaterThan(5);
    expect(allFired.find((c) => c.symbol === "AESI")).toBeDefined();
  });

  it("picks up levels from the log that are no longer configured anywhere", () => {
    // CF last fired at 141.50 per the log; the list still carries 141.11.
    const cf = plan.candidates.find((c) => c.symbol === "CF")!;
    expect(cf.levelsSeen).toContain(141.5);
  });

  it("skips only the alert kinds that have no numeric level to watch", () => {
    const types = new Set(plan.skipped.map((s) => s.reason));
    expect([...types].every((r) => /trendline|pattern|moving-average|unrecognised/.test(r))).toBe(true);
    expect(plan.skipped.some((s) => s.symbol === "AGNC")).toBe(true);
  });

  it("works without the log export", () => {
    const listOnly = buildSeedPlan(LIST, null);
    expect(listOnly.rowsRead.log).toBe(0);
    expect(listOnly.candidates.length).toBeGreaterThan(0);
  });
});
