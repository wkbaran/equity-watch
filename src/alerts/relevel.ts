/**
 * Proposing a fresh level for an alert whose level price has already run past.
 *
 * This is the "possibly at a new, higher level if the stock has pushed past
 * it" half of the revisit queue. It only ever *proposes* - applying a
 * suggestion is an explicit act (`alert revisit apply`, or the dashboard's
 * queued `revisit.apply`), so nothing moves on its own.
 *
 * Deliberately reuses analysis.ts's notion of the recent high (the highest high
 * over `recentHighLookbackDays`) rather than inventing a second one, so the
 * level a revisit proposes is the same level analyzeAlert would later judge
 * it against.
 */

import { analyzeAlert, type AnalysisParams } from "../analysis.js";
import type { PriceBar } from "../models.js";
import { round } from "../round.js";
import { revisitsToBreakoutAlerts } from "./bridge.js";
import { entryDirection } from "./reversion.js";
import {
  DEFAULT_REVISIT_WEIGHTS,
  daysBetween,
  scoreRevisit,
  type RevisitEntry,
  type RevisitSignals,
} from "./revisit.js";

export interface RelevelSuggestion {
  /** Null when no new level is warranted - see `basis` for why. */
  suggestedLevel: number | null;
  basis: string;
  lastClose: number | null;
  /** How far price now sits past the old level, in percent. Negative means it fell back below. */
  pctMovePastLevel: number | null;
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
      suggestedLevel: round(recentHigh),
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
    suggestedLevel: round(recentHigh * (1 + params.recentHighTolerance)),
    basis:
      `${params.recentHighLookbackDays}d high +${(params.recentHighTolerance * 100).toFixed(1)}% ` +
      `(new-high territory, price is above the recent high)`,
    lastClose,
    pctMovePastLevel,
  };
}

/** The fields a relevel pass owns on an entry. Nothing else on the entry is touched. */
export interface RelevelPatch {
  suggestedLevel: number | null;
  suggestionBasis: string;
  suggestedAt: string;
  priority: number;
  signals: RevisitSignals;
}

/**
 * Re-levels and re-scores **one** open queue entry.
 *
 * This is the unit of work `alert revisit relevel` repeats over the whole
 * queue, and the unit the dashboard's `revisit.relevel` op queues for a single
 * row. It lives here rather than inline in either caller so the level and the
 * priority the page proposes are, by construction, the ones the CLI proposes -
 * two implementations of this would diverge on exactly the cases below and
 * nothing would catch it.
 *
 * Bars are passed in rather than fetched: the CLI groups a whole symbol's
 * entries onto one `getDailyBars` call, and the op handler fetches for one.
 * An empty array is legitimate (a volume-only entry bridges to nothing, so
 * there is no date range to fetch against) and yields no verdict.
 */
export function relevelEntry(
  entry: RevisitEntry,
  bars: PriceBar[],
  params: AnalysisParams,
  heldSymbols: Set<string>,
  now: Date
): RelevelPatch {
  const levelled = suggestLevel(bars, entry.levelAtTrigger, params);
  const direction = entryDirection(entry);

  // Two kinds get no suggestion, for opposite reasons, and both say which.
  // A moving-average alert's level *is* the average, so there is nothing to
  // re-level it to. And suggestLevel only ever proposes levels overhead (the
  // lookback high), so for a downward fire it would invert the alert - the
  // same reason `alert seed` skips downside candidates. The move past the
  // level still scores in both cases, relative to the fire's direction.
  const suggestion =
    entry.kind === "ma"
      ? { ...levelled, suggestedLevel: null, basis: "moving-average alert: its level moves with the average" }
      : direction === "down"
        ? { ...levelled, suggestedLevel: null, basis: "downward fire: re-levelling only proposes levels above price" }
        : levelled;

  // Reuse the full breakout pipeline for the verdict and volume signals
  // rather than recomputing a second, subtly different version here.
  const bridged = revisitsToBreakoutAlerts([entry])[0];
  const verdict = bridged !== undefined && bars.length > 0 ? analyzeAlert(bridged, bars, params) : null;

  const { priority, signals } = scoreRevisit(
    {
      verdict: verdict?.verdict ?? null,
      pctMovePastLevel: suggestion.pctMovePastLevel,
      daysOpen: daysBetween(entry.triggeredAt, now),
      heldPosition: heldSymbols.has(entry.symbol.toUpperCase()),
      volumeRatio: verdict?.volumeRatio ?? null,
      volumeTrendRatio: verdict?.volumeTrendRatio ?? null,
      direction,
    },
    DEFAULT_REVISIT_WEIGHTS
  );

  return {
    suggestedLevel: suggestion.suggestedLevel,
    suggestionBasis: suggestion.basis,
    suggestedAt: now.toISOString(),
    priority,
    signals,
  };
}

/** Writes a patch onto an entry in place. The one place these five fields are assigned. */
export function applyRelevelPatch(entry: RevisitEntry, patch: RelevelPatch): void {
  entry.suggestedLevel = patch.suggestedLevel;
  entry.suggestionBasis = patch.suggestionBasis;
  entry.suggestedAt = patch.suggestedAt;
  entry.priority = patch.priority;
  entry.signals = patch.signals;
}
