/**
 * Confirm whether a TradingView "Crossing" alert was a real resistance
 * breakout backed by rising volume, versus noise.
 *
 * A single price-cross alert only tells you TradingView saw the price touch
 * a level intraday. It says nothing about:
 *   - whether the level was actually a meaningful resistance (a recent swing
 *     high) rather than an arbitrary number,
 *   - whether price *closed* above it (a wick through and back is not a
 *     breakout),
 *   - whether volume confirmed the move, and
 *   - whether the breakout held on subsequent days rather than failing.
 *
 * `analyzeAlert` checks all four using daily OHLCV bars around the alert.
 */

import type { Alert, BreakoutVerdict, PriceBar } from "./models.js";

export interface AnalysisParams {
  /** How many prior trading days to average for the "normal" volume baseline. */
  baselineDays: number;
  /** Breakout-day volume must be at least this multiple of the baseline average to count as confirmed. */
  volumeRatioThreshold: number;
  /** Window (in trading days, including the breakout day) used to check that volume was trending up into the breakout, not just a lone spike. */
  volumeTrendDays: number;
  /** How far back to look for the swing high that makes `level` a meaningful resistance rather than an arbitrary crossing. */
  recentHighLookbackDays: number;
  /** `level` counts as "near/above the recent high" if it's within this fraction below the highest high seen in the lookback window. */
  recentHighTolerance: number;
  /** Number of subsequent trading days the close must stay above `level` to call the breakout "held". */
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

  const highWindow = bars.slice(Math.max(0, idx - params.recentHighLookbackDays), idx);
  const recentHigh = highWindow.length > 0 ? Math.max(...highWindow.map((b) => b.high)) : null;
  const nearRecentHigh = recentHigh !== null && level >= recentHigh * (1 - params.recentHighTolerance);

  const closeOnAlertDay = breakoutBar.close;
  const pctAboveLevel = ((closeOnAlertDay - level) / level) * 100;

  const following = bars.slice(idx + 1, idx + 1 + params.holdDays);
  let daysHeld = 0;
  for (const bar of following) {
    if (bar.close > level) {
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

  const closedAbove = closeOnAlertDay > level;
  const volumeConfirmed = volumeRatio !== null && volumeRatio >= params.volumeRatioThreshold;
  const volumeGrowing = volumeTrendRatio === null || volumeTrendRatio >= 1.0;

  const notesParts: string[] = [
    `close ${closedAbove ? "above" : "at/below"} level (${pctAboveLevel >= 0 ? "+" : ""}${pctAboveLevel.toFixed(1)}%)`,
    volumeRatio !== null ? `volume ${volumeRatio.toFixed(2)}x ${params.baselineDays}d avg` : "volume ratio n/a",
  ];
  if (volumeTrendRatio !== null) {
    notesParts.push(`${trendDays}d volume trend ${volumeTrendRatio.toFixed(2)}x`);
  }
  notesParts.push(nearRecentHigh ? "near/above recent high" : "well below recent high (weak resistance)");
  if (heldAboveLevel === true) {
    notesParts.push(`held above level for ${daysHeld}/${params.holdDays}d`);
  } else if (heldAboveLevel === false) {
    notesParts.push(`failed to hold - closed back below within ${params.holdDays}d`);
  } else {
    notesParts.push("not enough time elapsed yet to confirm it held");
  }

  let verdict: string;
  if (!closedAbove) {
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
