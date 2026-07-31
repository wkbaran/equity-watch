"""Confirm whether a TradingView "Crossing" alert was a real resistance
breakout backed by rising volume, versus noise.

A single price-cross alert only tells you TradingView saw the price touch
a level intraday. It says nothing about:
  - whether the level was actually a meaningful resistance (a recent swing
    high) rather than an arbitrary number,
  - whether price *closed* above it (a wick through and back is not a
    breakout),
  - whether volume confirmed the move, and
  - whether the breakout held on subsequent days rather than failing.

`analyze_alert` checks all four using daily OHLCV bars around the alert.
"""

from __future__ import annotations

from dataclasses import dataclass

from tv_alerts.models import Alert, AlertType, BreakoutVerdict, PriceBar


@dataclass
class AnalysisParams:
    # How many prior trading days to average for the "normal" volume baseline.
    baseline_days: int = 20
    # Breakout-day volume must be at least this multiple of the baseline
    # average to count as confirmed.
    volume_ratio_threshold: float = 1.5
    # Window (in trading days, including the breakout day) used to check
    # that volume was trending up into the breakout, not just a lone spike.
    volume_trend_days: int = 3
    # How far back to look for the swing high that makes `level` a
    # meaningful resistance rather than an arbitrary crossing.
    recent_high_lookback_days: int = 60
    # `level` counts as "near/above the recent high" if it's within this
    # fraction below the highest high seen in the lookback window.
    recent_high_tolerance: float = 0.02
    # Number of subsequent trading days the close must stay above `level`
    # to call the breakout "held".
    hold_days: int = 2
    # Minimum bars of prior history required before we'll trust the
    # baseline/recent-high calculations at all.
    min_baseline_bars: int = 10


def _find_alert_bar_index(bars: list[PriceBar], alert: Alert) -> int | None:
    alert_date = alert.time.date()
    for i, bar in enumerate(bars):
        if bar.date.date() >= alert_date:
            return i
    return None


def analyze_alert(
    alert: Alert, bars: list[PriceBar], params: AnalysisParams | None = None
) -> BreakoutVerdict:
    params = params or AnalysisParams()
    bars = sorted(bars, key=lambda b: b.date)

    if alert.alert_type != AlertType.PRICE_CROSS or alert.level is None:
        return BreakoutVerdict(
            alert=alert,
            close_on_alert_day=None,
            pct_above_level=None,
            volume_on_alert_day=None,
            avg_volume_baseline=None,
            volume_ratio=None,
            volume_trend_ratio=None,
            near_recent_high=None,
            held_above_level=None,
            days_held=0,
            verdict="SKIPPED",
            notes=f"Not a numeric price-level alert ({alert.alert_type.value}).",
        )

    idx = _find_alert_bar_index(bars, alert)
    if idx is None:
        return _no_data_verdict(alert, "No bar found on or after the alert date.")

    breakout_bar = bars[idx]
    baseline = bars[max(0, idx - params.baseline_days) : idx]
    if len(baseline) < params.min_baseline_bars:
        return _no_data_verdict(
            alert,
            f"Only {len(baseline)} prior trading day(s) of history available "
            f"(need {params.min_baseline_bars}).",
        )

    avg_volume_baseline = sum(b.volume for b in baseline) / len(baseline)
    volume_ratio = (
        breakout_bar.volume / avg_volume_baseline if avg_volume_baseline > 0 else None
    )

    trend_days = params.volume_trend_days
    recent_window = bars[max(0, idx - trend_days + 1) : idx + 1]
    prior_window = bars[max(0, idx - 2 * trend_days + 1) : max(0, idx - trend_days + 1)]
    volume_trend_ratio = None
    if prior_window:
        prior_avg = sum(b.volume for b in prior_window) / len(prior_window)
        recent_avg = sum(b.volume for b in recent_window) / len(recent_window)
        if prior_avg > 0:
            volume_trend_ratio = recent_avg / prior_avg

    high_window = bars[max(0, idx - params.recent_high_lookback_days) : idx]
    recent_high = max((b.high for b in high_window), default=None)
    near_recent_high = (
        recent_high is not None
        and alert.level >= recent_high * (1 - params.recent_high_tolerance)
    )

    close_on_alert_day = breakout_bar.close
    pct_above_level = (close_on_alert_day - alert.level) / alert.level * 100

    following = bars[idx + 1 : idx + 1 + params.hold_days]
    days_held = 0
    for bar in following:
        if bar.close > alert.level:
            days_held += 1
        else:
            break
    held_above_level: bool | None
    if len(following) < params.hold_days:
        held_above_level = None  # not enough time has passed yet to know
    else:
        held_above_level = days_held == params.hold_days

    closed_above = close_on_alert_day > alert.level
    volume_confirmed = volume_ratio is not None and volume_ratio >= params.volume_ratio_threshold
    volume_growing = volume_trend_ratio is None or volume_trend_ratio >= 1.0

    notes_parts = [
        f"close {'above' if closed_above else 'at/below'} level "
        f"({pct_above_level:+.1f}%)",
        f"volume {volume_ratio:.2f}x {params.baseline_days}d avg" if volume_ratio else "volume ratio n/a",
    ]
    if volume_trend_ratio is not None:
        notes_parts.append(f"{trend_days}d volume trend {volume_trend_ratio:.2f}x")
    notes_parts.append(
        "near/above recent high" if near_recent_high else "well below recent high (weak resistance)"
    )
    if held_above_level is True:
        notes_parts.append(f"held above level for {days_held}/{params.hold_days}d")
    elif held_above_level is False:
        notes_parts.append(f"failed to hold - closed back below within {params.hold_days}d")
    else:
        notes_parts.append("not enough time elapsed yet to confirm it held")

    if not closed_above:
        verdict = "NO_CLOSE_CONFIRM"
    elif volume_confirmed and near_recent_high and volume_growing and held_above_level is not False:
        verdict = "CONFIRMED_BREAKOUT"
    elif volume_confirmed and near_recent_high:
        verdict = "WATCH"
    elif volume_confirmed or near_recent_high:
        verdict = "WATCH_WEAK"
    else:
        verdict = "NO"

    return BreakoutVerdict(
        alert=alert,
        close_on_alert_day=close_on_alert_day,
        pct_above_level=pct_above_level,
        volume_on_alert_day=breakout_bar.volume,
        avg_volume_baseline=avg_volume_baseline,
        volume_ratio=volume_ratio,
        volume_trend_ratio=volume_trend_ratio,
        near_recent_high=near_recent_high,
        held_above_level=held_above_level,
        days_held=days_held,
        verdict=verdict,
        notes="; ".join(notes_parts),
    )


def _no_data_verdict(alert: Alert, reason: str) -> BreakoutVerdict:
    return BreakoutVerdict(
        alert=alert,
        close_on_alert_day=None,
        pct_above_level=None,
        volume_on_alert_day=None,
        avg_volume_baseline=None,
        volume_ratio=None,
        volume_trend_ratio=None,
        near_recent_high=None,
        held_above_level=None,
        days_held=0,
        verdict="INSUFFICIENT_DATA",
        notes=reason,
    )
