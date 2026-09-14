/**
 * Proposing a fresh level for an alert whose level price has already run past.
 *
 * This is the "possibly at a new, higher level if the stock has pushed past
 * it" half of the revisit queue. It only ever *proposes* - applying a
 * suggestion is an explicit act (`alert revisit apply`), so nothing moves on
 * its own.
 *
 * Deliberately reuses analysis.ts's notion of the recent high (the highest high
 * over `recentHighLookbackDays`) rather than inventing a second one, so the
 * level a revisit proposes is the same level analyzeAlert would later judge
 * it against.
 */

import type { AnalysisParams } from "../analysis.js";
import type { PriceBar } from "../models.js";

export interface RelevelSuggestion {
  /** Null when no new level is warranted - see `basis` for why. */
  suggestedLevel: number | null;
  basis: string;
  lastClose: number | null;
  /** How far price now sits past the old level, in percent. Negative means it fell back below. */
  pctMovePastLevel: number | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function suggestLevel(
  barsInput: PriceBar[],
  levelAtTrigger: number | null,
  params: AnalysisParams
): RelevelSuggestion {
  const bars = [...barsInput].sort((a, b) => a.date.getTime() - b.date.getTime());
  if (bars.length === 0) {
    return { suggestedLevel: null, basis: "no bars available", lastClose: null, pctMovePastLevel: null };
  }

  const lastClose = bars[bars.length - 1].close;
  const pctMovePastLevel = levelAtTrigger === null ? null : ((lastClose - levelAtTrigger) / levelAtTrigger) * 100;

  if (levelAtTrigger === null) {
    return { suggestedLevel: null, basis: "no level to replace (volume-only alert)", lastClose, pctMovePastLevel };
  }

  // Price fell back below the level it crossed. The original level is still a
  // live breakout target, so re-levelling would throw away a good level.
  if (lastClose <= levelAtTrigger) {
    return {
      suggestedLevel: null,
      basis: `price back at/below ${levelAtTrigger} — original level still valid`,
      lastClose,
      pctMovePastLevel,
    };
  }

  const window = bars.slice(Math.max(0, bars.length - params.recentHighLookbackDays));
  const recentHigh = Math.max(...window.map((b) => b.high));

  // Price is under the lookback high: that high is the next level above
  // price, so it becomes the new level.
  if (lastClose < recentHigh) {
    return {
      suggestedLevel: round2(recentHigh),
      basis: `${params.recentHighLookbackDays}d high`,
      lastClose,
      pctMovePastLevel,
    };
  }

  // New-high territory - there is no higher recent high left to use, so set
  // the level a tolerance-width above the high instead. recentHighTolerance is
  // beta-scaled per symbol upstream (src/tuning.ts), so a volatile name gets a
  // proportionally wider gap rather than a level it would cross on noise.
  return {
    suggestedLevel: round2(recentHigh * (1 + params.recentHighTolerance)),
    basis:
      `${params.recentHighLookbackDays}d high +${(params.recentHighTolerance * 100).toFixed(1)}% ` +
      `(new-high territory, price is above the recent high)`,
    lastClose,
    pctMovePastLevel,
  };
}
