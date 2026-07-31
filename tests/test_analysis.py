from datetime import datetime, timedelta, timezone

import pytest

from tv_alerts.analysis import AnalysisParams, analyze_alert
from tv_alerts.models import Alert, AlertType, PriceBar

PARAMS = AnalysisParams(
    baseline_days=20,
    volume_ratio_threshold=1.5,
    volume_trend_days=3,
    recent_high_lookback_days=60,
    recent_high_tolerance=0.02,
    hold_days=2,
    min_baseline_bars=10,
)

START = datetime(2026, 1, 1, tzinfo=timezone.utc)


def make_alert(level: float, day_offset: int, alert_type=AlertType.PRICE_CROSS) -> Alert:
    return Alert(
        alert_id="1",
        exchange="BATS",
        symbol="TEST",
        timeframe=None,
        description=f"TEST Crossing {level}",
        time=START + timedelta(days=day_offset),
        alert_type=alert_type,
        level=level,
        raw_ticker="BATS:TEST",
    )


def make_bars(closes: list[float], volumes: list[int], highs: list[float] | None = None) -> list[PriceBar]:
    highs = highs or [c * 1.005 for c in closes]
    bars = []
    for i, (close, volume, high) in enumerate(zip(closes, volumes, highs)):
        bars.append(
            PriceBar(
                date=START + timedelta(days=i),
                open=close,
                high=max(high, close),
                low=close * 0.99,
                close=close,
                volume=volume,
            )
        )
    return bars


def test_confirmed_breakout_with_growing_volume():
    # 30 quiet days capped under 100, then a breakout day closing at 105 on
    # 3x average volume, held above the level for the next two days.
    quiet_closes = [95 + (i % 5) * 0.5 for i in range(30)]  # oscillates 95-97, capped by 100 resistance
    quiet_volumes = [100_000 + (i % 3) * 5_000 for i in range(30)]
    closes = quiet_closes + [105, 106, 107]
    volumes = quiet_volumes + [320_000, 250_000, 200_000]
    highs = [99.5] * 30 + [105, 106, 107]  # recent high just under the 100 level
    bars = make_bars(closes, volumes, highs)

    alert = make_alert(level=100.0, day_offset=30)
    result = analyze_alert(alert, bars, PARAMS)

    assert result.verdict == "CONFIRMED_BREAKOUT"
    assert result.near_recent_high is True
    assert result.held_above_level is True
    assert result.volume_ratio > PARAMS.volume_ratio_threshold


def test_failed_breakout_does_not_hold():
    quiet_closes = [95] * 30
    quiet_volumes = [100_000] * 30
    closes = quiet_closes + [105, 98, 97]  # closes back below the 100 level next day
    volumes = quiet_volumes + [320_000, 150_000, 140_000]
    highs = [99.5] * 30 + [105, 99, 97]
    bars = make_bars(closes, volumes, highs)

    alert = make_alert(level=100.0, day_offset=30)
    result = analyze_alert(alert, bars, PARAMS)

    assert result.held_above_level is False
    assert result.verdict in {"WATCH", "WATCH_WEAK", "NO"}
    assert result.verdict != "CONFIRMED_BREAKOUT"


def test_breakout_without_volume_confirmation_is_not_confirmed():
    quiet_closes = [95] * 30
    quiet_volumes = [100_000] * 30
    closes = quiet_closes + [105, 106, 107]
    volumes = quiet_volumes + [105_000, 100_000, 100_000]  # no volume pickup at all
    highs = [99.5] * 30 + [105, 106, 107]
    bars = make_bars(closes, volumes, highs)

    alert = make_alert(level=100.0, day_offset=30)
    result = analyze_alert(alert, bars, PARAMS)

    assert result.volume_ratio < PARAMS.volume_ratio_threshold
    assert result.verdict != "CONFIRMED_BREAKOUT"


def test_crossing_mid_range_level_is_not_near_recent_high():
    # Level is well below where price has recently traded - this is not a
    # resistance breakout even if the day's close and volume look fine.
    closes = [120] * 30 + [105, 106, 107]
    volumes = [100_000] * 30 + [320_000, 250_000, 200_000]
    highs = [122] * 30 + [105, 106, 107]
    bars = make_bars(closes, volumes, highs)

    alert = make_alert(level=100.0, day_offset=30)
    result = analyze_alert(alert, bars, PARAMS)

    assert result.near_recent_high is False
    assert result.verdict != "CONFIRMED_BREAKOUT"


def test_no_close_confirmation_when_close_is_below_level():
    closes = [95] * 30 + [99, 98, 97]  # never actually closes above the 100 level
    volumes = [100_000] * 33
    bars = make_bars(closes, volumes)

    alert = make_alert(level=100.0, day_offset=30)
    result = analyze_alert(alert, bars, PARAMS)

    assert result.verdict == "NO_CLOSE_CONFIRM"


def test_insufficient_history_is_flagged():
    closes = [95, 96, 105]
    volumes = [100_000, 100_000, 300_000]
    bars = make_bars(closes, volumes)

    alert = make_alert(level=100.0, day_offset=2)
    result = analyze_alert(alert, bars, PARAMS)

    assert result.verdict == "INSUFFICIENT_DATA"


def test_non_price_alert_types_are_skipped():
    alert = make_alert(level=None, day_offset=0, alert_type=AlertType.TRENDLINE_CROSS)
    result = analyze_alert(alert, [], PARAMS)
    assert result.verdict == "SKIPPED"


def test_pending_hold_when_not_enough_days_have_passed():
    quiet_closes = [95] * 30
    quiet_volumes = [100_000] * 30
    closes = quiet_closes + [105]  # only the breakout day itself, no follow-through yet
    volumes = quiet_volumes + [320_000]
    highs = [99.5] * 30 + [105]
    bars = make_bars(closes, volumes, highs)

    alert = make_alert(level=100.0, day_offset=30)
    result = analyze_alert(alert, bars, PARAMS)

    assert result.held_above_level is None
    assert result.verdict == "CONFIRMED_BREAKOUT"
