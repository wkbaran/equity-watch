import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVISIT_WEIGHTS,
  daysBetween,
  explainPriority,
  moveScore,
  scoreRevisit,
  stalenessScore,
  verdictScore,
  volumeScore,
} from "../src/alerts/revisit.js";
import { suggestLevel } from "../src/alerts/relevel.js";
import { DEFAULT_ANALYSIS_PARAMS } from "../src/analysis.js";
import type { PriceBar } from "../src/models.js";

function bars(closes: number[], highs?: number[]): PriceBar[] {
  return closes.map((close, i) => ({
    date: new Date(2026, 0, i + 1),
    open: close,
    high: highs?.[i] ?? close,
    low: close,
    close,
    volume: 1_000_000,
  }));
}

describe("revisit scoring", () => {
  it("ranks verdicts in the same order analyze reports them", () => {
    expect(verdictScore("CONFIRMED_BREAKOUT")).toBeGreaterThan(verdictScore("WATCH"));
    expect(verdictScore("WATCH")).toBeGreaterThan(verdictScore("WATCH_WEAK"));
    expect(verdictScore("WATCH_WEAK")).toBeGreaterThan(verdictScore("NO"));
    expect(verdictScore("SKIPPED")).toBe(0);
    expect(verdictScore(null)).toBe(0);
    expect(verdictScore("NOT_A_REAL_VERDICT")).toBe(0);
  });

  it("saturates rather than letting one runaway signal dominate", () => {
    expect(moveScore(10)).toBe(1);
    expect(moveScore(500)).toBe(1); // a 500% move is not 50x more urgent than 10%
    expect(moveScore(0)).toBe(0);
    expect(moveScore(null)).toBe(0);
    expect(stalenessScore(999)).toBe(1);
  });

  it("treats a move back below the level as no urgency, not negative urgency", () => {
    expect(moveScore(-7)).toBe(0);
  });

  it("scores a downward fire's move by how far price fell past the level", () => {
    expect(moveScore(-10, "down")).toBe(1);
    expect(moveScore(-5, "down")).toBe(0.5);
    expect(moveScore(4, "down")).toBe(0); // back above: no urgency
    expect(moveScore(10, null)).toBe(1); // no direction reads as upward

    const { signals } = scoreRevisit({ pctMovePastLevel: -5, daysOpen: 0, heldPosition: false, direction: "down" });
    expect(signals.pctMovePastLevel).toBe(-5); // stored raw
    expect(signals.moveDirection).toBe("down");
    expect(signals.moveScore).toBe(0.5);
    expect(explainPriority(signals)).toContain("-5.0% past level");

    const back = scoreRevisit({ pctMovePastLevel: 3, daysOpen: 0, heldPosition: false, direction: "down" });
    expect(explainPriority(back.signals)).toContain("+3.0% back above level");
  });

  it("scores a lone volume spike below the same spike on a rising trend", () => {
    const lone = volumeScore(2.0, 0.8);
    const trending = volumeScore(2.0, 1.5);
    expect(trending).toBeGreaterThan(lone);
    expect(volumeScore(null, null)).toBe(0);
  });

  it("credits volume even when the alert never had a volume condition", () => {
    // The signal is evidence about the move, not about how the alert was defined.
    const { signals } = scoreRevisit({ daysOpen: 0, heldPosition: false, volumeRatio: 2.5, volumeTrendRatio: 1.6 });
    expect(signals.volumeScore).toBe(1);
  });

  it("puts a confirmed breakout on a held position above a stale unconfirmed one", () => {
    const strong = scoreRevisit({
      verdict: "CONFIRMED_BREAKOUT",
      pctMovePastLevel: 6,
      daysOpen: 1,
      heldPosition: true,
      volumeRatio: 2.2,
      volumeTrendRatio: 1.4,
    });
    const stale = scoreRevisit({
      verdict: "NO",
      pctMovePastLevel: 1,
      daysOpen: 60,
      heldPosition: false,
      volumeRatio: 1.0,
      volumeTrendRatio: 0.9,
    });
    expect(strong.priority).toBeGreaterThan(stale.priority);
  });

  it("keeps staleness alone from outranking a real signal", () => {
    // Staleness is a tiebreaker; a queue entry should never float to the top
    // purely by sitting there.
    const ancient = scoreRevisit({ verdict: null, daysOpen: 9999, heldPosition: false });
    const fresh = scoreRevisit({ verdict: "CONFIRMED_BREAKOUT", daysOpen: 0, heldPosition: false });
    expect(fresh.priority).toBeGreaterThan(ancient.priority);
  });

  it("bounds priority to 0-100", () => {
    const max = scoreRevisit({
      verdict: "CONFIRMED_BREAKOUT",
      pctMovePastLevel: 999,
      daysOpen: 999,
      heldPosition: true,
      volumeRatio: 99,
      volumeTrendRatio: 99,
    });
    const min = scoreRevisit({ daysOpen: 0, heldPosition: false });
    expect(max.priority).toBe(100);
    expect(min.priority).toBe(0);
  });

  it("weights sum to 1 so priority reads as a percentage", () => {
    const sum = Object.values(DEFAULT_REVISIT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("renders a negative move without a contradictory plus sign", () => {
    const { signals } = scoreRevisit({ pctMovePastLevel: -5.3, daysOpen: 1, heldPosition: false });
    const text = explainPriority(signals);
    expect(text).not.toContain("+-");
    expect(text).toContain("-5.3% back below level");
  });

  it("counts whole days open and never goes negative", () => {
    expect(daysBetween("2026-01-01T00:00:00.000Z", new Date("2026-01-08T00:00:00.000Z"))).toBe(7);
    expect(daysBetween("2026-01-10T00:00:00.000Z", new Date("2026-01-01T00:00:00.000Z"))).toBe(0);
  });
});

describe("suggestLevel", () => {
  const params = { ...DEFAULT_ANALYSIS_PARAMS, recentHighLookbackDays: 60, recentHighTolerance: 0.02 };

  it("leaves the level alone when price fell back below it", () => {
    // The original level is still a live breakout target - re-levelling here
    // would throw away a good level.
    const result = suggestLevel(bars([100, 105, 98]), 100, params);
    expect(result.suggestedLevel).toBeNull();
    expect(result.basis).toMatch(/still valid/);
    expect(result.pctMovePastLevel).toBeCloseTo(-2, 5);
  });

  it("proposes the lookback high when it sits above price", () => {
    const result = suggestLevel(bars([100, 108, 105], [100, 112, 106]), 100, params);
    expect(result.suggestedLevel).toBe(112);
    expect(result.basis).toBe("60d high");
    expect(result.pctMovePastLevel).toBeCloseTo(5, 5);
  });

  it("adds a tolerance gap in new-high territory where no higher recent high is left", () => {
    const result = suggestLevel(bars([100, 105, 110], [100, 105, 110]), 100, params);
    expect(result.suggestedLevel).toBe(112.2); // 110 * 1.02
    expect(result.basis).toMatch(/new-high territory/);
    expect(result.basis).not.toMatch(/resistance|support/);
  });

  it("scales the new-high gap with the beta-adjusted tolerance", () => {
    // recentHighTolerance is beta-scaled per symbol upstream, so a volatile
    // name gets a proportionally wider gap rather than one it crosses on noise.
    const volatile = suggestLevel(bars([100, 110]), 100, { ...params, recentHighTolerance: 0.06 });
    expect(volatile.suggestedLevel).toBe(116.6); // 110 * 1.06
  });

  it("only looks upward, so callers must not apply it to a downside alert", () => {
    // Documents why `alert seed` and `revisit relevel` skip downward alerts:
    // handed a downside level price has risen above, this proposes the 60d
    // HIGH, which would invert a "Crossing Down 91.00" into a breakout target.
    const result = suggestLevel(bars([91, 100, 110], [91, 105, 118]), 91, params);
    expect(result.suggestedLevel).toBe(118);
    expect(result.suggestedLevel).toBeGreaterThan(91);
  });

  it("returns nothing useful for a volume-only entry", () => {
    const result = suggestLevel(bars([100, 110]), null, params);
    expect(result.suggestedLevel).toBeNull();
    expect(result.pctMovePastLevel).toBeNull();
  });

  it("handles an empty bar set without throwing", () => {
    const result = suggestLevel([], 100, params);
    expect(result.suggestedLevel).toBeNull();
    expect(result.lastClose).toBeNull();
  });

  it("only considers highs inside the lookback window", () => {
    // An old spike outside the window must not become the proposed level.
    const closes = [500, ...Array(60).fill(100), 105];
    const highs = [900, ...Array(60).fill(100), 106];
    const result = suggestLevel(bars(closes, highs), 100, params);
    expect(result.suggestedLevel).not.toBe(900);
  });
});
