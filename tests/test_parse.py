from pathlib import Path

from tv_alerts.models import AlertType
from tv_alerts.parse import parse_alerts

FIXTURE = Path(__file__).parent / "fixtures" / "sample_alerts.csv"


def test_parses_all_rows():
    alerts = parse_alerts(FIXTURE)
    assert len(alerts) == 6


def test_plain_price_cross():
    alerts = parse_alerts(FIXTURE)
    goog = next(a for a in alerts if a.symbol == "GOOG")
    assert goog.exchange == "BATS"
    assert goog.timeframe is None
    assert goog.alert_type == AlertType.PRICE_CROSS
    assert goog.level == 350.28


def test_price_cross_with_comma_thousands_separator():
    alerts = parse_alerts(FIXTURE)
    mkl = next(a for a in alerts if a.symbol == "MKL")
    assert mkl.alert_type == AlertType.PRICE_CROSS
    assert mkl.level == 2003.72


def test_volume_cross_with_mangled_unit_separator():
    alerts = parse_alerts(FIXTURE)
    achc = next(a for a in alerts if a.symbol == "ACHC")
    assert achc.timeframe == "1D"
    assert achc.alert_type == AlertType.VOLUME_CROSS
    assert achc.level == 4_500_000

    abnb = next(a for a in alerts if a.symbol == "ABNB")
    assert abnb.alert_type == AlertType.VOLUME_CROSS
    assert abnb.level == 4_500_000


def test_trendline_cross_has_no_level():
    alerts = parse_alerts(FIXTURE)
    sui = next(a for a in alerts if a.symbol == "SUI")
    assert sui.alert_type == AlertType.TRENDLINE_CROSS
    assert sui.level is None


def test_ma_strategy_alert_is_not_misparsed_as_price_cross():
    alerts = parse_alerts(FIXTURE)
    cdre = next(a for a in alerts if a.symbol == "CDRE")
    assert cdre.alert_type == AlertType.MA_STRATEGY
    assert cdre.level is None
