/**
 * Confirm whether a price-level crossing was a real move through the level,
 * backed by volume, versus noise.
 *
 * A single price-cross alert only tells you price touched a level intraday.
 * It says nothing about:
 *   - whether the level sits at a recent extreme (a swing high for an upward
 *     crossing, a swing low for a downward one) rather than being an arbitrary
 *     number in the middle of the range,
 *   - whether price *closed* past it (a wick through and back is not a move),
 *   - whether volume confirmed the move, and
 *   - whether closes stayed past the level on subsequent days.
 *
 * `analyzeAlert` checks all four using daily OHLCV bars around the alert, in
 * the direction the alert crossed (`Alert.direction`, absent = up). The
 * verdict names and BreakoutVerdict field names are upside-flavoured for
 * historical reasons and kept because they are persisted; for a downward
 * crossing `nearRecentHigh` means near the recent low and `heldAboveLevel`
 * means held below.
 */

import type { Alert, BreakoutVerdict, PriceBar } from "./models.js";

export interface AnalysisParams {
  /** How many prior trading days to average for the "normal" volume baseline. */
  baselineDays: number;
  /** Breakout-day volume must be at least this multiple of the baseline average to count as confirmed. */
  volumeRatioThreshold: number;
  /** Window (in trading days, including the breakout day) used to check that volume was trending up into the breakout, not just a lone spike. */
  volumeTrendDays: number;
  /** How far back to look for the swing high (or, for a downward crossing, swing low) that makes `level` meaningful rather than arbitrary. */
  recentHighLookbackDays: number;
  /** `level` counts as "near the recent high" if within this fraction below the highest high (mirrored for a downward crossing: within this fraction above the lowest low). */
  recentHighTolerance: number;
  /** Number of subsequent trading days the close must stay past `level`, in the crossing direction, to call the move "held". */
  holdDays: number;
  /** Minimum bars of prior history required before we'll trust the baseline/recent-high calculations at all. */
  minBaselineBars: number;
}

export const DEFAULT_ANALYSIS_PARAMS: AnalysisParams = {
  baselineDays: 20,
  volumeRatioThreshold: 1.5,
  volumeTrendDays: 3,
  recentHighLookbackDays: 60,
  recentHighTolerance: 0.02,
  holdDays: 2,
  minBaselineBars: 10,
};

function findAlertBarIndex(bars: PriceBar[], alert: Alert): number | null {
  const alertDateStr = dateOnly(alert.time);
  for (let i = 0; i < bars.length; i++) {
    if (dateOnly(bars[i].date) >= alertDateStr) {
      return i;
    }
  }
  return null;
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function noDataVerdict(alert: Alert, reason: string): BreakoutVerdict {
  return {
    alert,
    closeOnAlertDay: null,
    pctAboveLevel: null,
    volumeOnAlertDay: null,
    avgVolumeBaseline: null,
    volumeRatio: null,
    volumeTrendRatio: null,
    nearRecentHigh: null,
    heldAboveLevel: null,
    daysHeld: 0,
    verdict: "INSUFFICIENT_DATA",
    notes: reason,
  };
}

export function analyzeAlert(
  alert: Alert,
  barsInput: PriceBar[],
  params: AnalysisParams = DEFAULT_ANALYSIS_PARAMS
): BreakoutVerdict {
  const bars = [...barsInput].sort((a, b) => a.date.getTime() - b.date.getTime());

  if (alert.alertType !== "price_cross" || alert.level === null) {
    return {
      alert,
      closeOnAlertDay: null,
      pctAboveLevel: null,
      volumeOnAlertDay: null,
      avgVolumeBaseline: null,
      volumeRatio: null,
      volumeTrendRatio: null,
      nearRecentHigh: null,
      heldAboveLevel: null,
      daysHeld: 0,
      verdict: "SKIPPED",
      notes: `Not a numeric price-level alert (${alert.alertType}).`,
    };
  }
  const level = alert.level;
  const down = alert.direction === "down";
  const past = down ? "below" : "above";
  const back = down ? "above" : "below";
  /** Whether a close is past the level in the crossing direction. */
  const closedPast = (close: number) => (down ? close < level : close > level);

  const idx = findAlertBarIndex(bars, alert);
  if (idx === null) {
    return noDataVerdict(alert, "No bar found on or after the alert date.");
  }

  const breakoutBar = bars[idx];
  const baseline = bars.slice(Math.max(0, idx - params.baselineDays), idx);
  if (baseline.length < params.minBaselineBars) {
    return noDataVerdict(
      alert,
      `Only ${baseline.length} prior trading day(s) of history available (need ${params.minBaselineBars}).`
    );
  }

  const avgVolumeBaseline = mean(baseline.map((b) => b.volume));
  const volumeRatio = avgVolumeBaseline > 0 ? breakoutBar.volume / avgVolumeBaseline : null;

  const trendDays = params.volumeTrendDays;
  const recentWindow = bars.slice(Math.max(0, idx - trendDays + 1), idx + 1);
  const priorWindow = bars.slice(Math.max(0, idx - 2 * trendDays + 1), Math.max(0, idx - trendDays + 1));
  let volumeTrendRatio: number | null = null;
  if (priorWindow.length > 0) {
    const priorAvg = mean(priorWindow.map((b) => b.volume));
    const recentAvg = mean(recentWindow.map((b) => b.volume));
    if (priorAvg > 0) {
      volumeTrendRatio = recentAvg / priorAvg;
    }
  }

  // The recent extreme on the side the crossing moved toward: the swing high
  // for an upward crossing, the swing low for a downward one.
  const extremeWindow = bars.slice(Math.max(0, idx - params.recentHighLookbackDays), idx);
  let nearRecentHigh = false;
  if (extremeWindow.length > 0) {
    if (down) {
      const recentLow = Math.min(...extremeWindow.map((b) => b.low));
      nearRecentHigh = level <= recentLow * (1 + params.recentHighTolerance);
    } else {
      const recentHigh = Math.max(...extremeWindow.map((b) => b.high));
      nearRecentHigh = level >= recentHigh * (1 - params.recentHighTolerance);
    }
  }

  const closeOnAlertDay = breakoutBar.close;
  const pctAboveLevel = ((closeOnAlertDay - level) / level) * 100;

  const following = bars.slice(idx + 1, idx + 1 + params.holdDays);
  let daysHeld = 0;
  for (const bar of following) {
    if (closedPast(bar.close)) {
      daysHeld += 1;
    } else {
      break;
    }
  }
  let heldAboveLevel: boolean | null;
  if (following.length < params.holdDays) {
    heldAboveLevel = null; // not enough time has passed yet to know
  } else {
    heldAboveLevel = daysHeld === params.holdDays;
  }

  const closedPastLevel = closedPast(closeOnAlertDay);
  const volumeConfirmed = volumeRatio !== null && volumeRatio >= params.volumeRatioThreshold;
  const volumeGrowing = volumeTrendRatio === null || volumeTrendRatio >= 1.0;

  const extreme = down ? "recent low" : "recent high";
  const notesParts: string[] = [
    `close ${closedPastLevel ? past : `at/${back}`} level (${pctAboveLevel >= 0 ? "+" : ""}${pctAboveLevel.toFixed(1)}%)`,
    volumeRatio !== null ? `volume ${volumeRatio.toFixed(2)}x ${params.baselineDays}d avg` : "volume ratio n/a",
  ];
  if (volumeTrendRatio !== null) {
    notesParts.push(`${trendDays}d volume trend ${volumeTrendRatio.toFixed(2)}x`);
  }
  notesParts.push(nearRecentHigh ? `near/${past} ${extreme}` : `well ${back} ${extreme} (arbitrary level)`);
  if (heldAboveLevel === true) {
    notesParts.push(`held ${past} level for ${daysHeld}/${params.holdDays}d`);
  } else if (heldAboveLevel === false) {
    notesParts.push(`failed to hold - closed back ${back} within ${params.holdDays}d`);
  } else {
    notesParts.push("not enough time elapsed yet to confirm it held");
  }

  let verdict: string;
  if (!closedPastLevel) {
    verdict = "NO_CLOSE_CONFIRM";
  } else if (volumeConfirmed && nearRecentHigh && volumeGrowing && heldAboveLevel !== false) {
    verdict = "CONFIRMED_BREAKOUT";
  } else if (volumeConfirmed && nearRecentHigh) {
    verdict = "WATCH";
  } else if (volumeConfirmed || nearRecentHigh) {
    verdict = "WATCH_WEAK";
  } else {
    verdict = "NO";
  }

  return {
    alert,
    closeOnAlertDay,
    pctAboveLevel,
    volumeOnAlertDay: breakoutBar.volume,
    avgVolumeBaseline,
    volumeRatio,
    volumeTrendRatio,
    nearRecentHigh,
    heldAboveLevel,
    daysHeld,
    verdict,
    notes: notesParts.join("; "),
  };
}
