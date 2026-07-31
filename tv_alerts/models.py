from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum


class AlertType(str, Enum):
    PRICE_CROSS = "price_cross"
    TRENDLINE_CROSS = "trendline_cross"
    VOLUME_CROSS = "volume_cross"
    MA_STRATEGY = "ma_strategy"
    OTHER = "other"


@dataclass(frozen=True)
class Alert:
    alert_id: str
    exchange: str
    symbol: str
    timeframe: str | None
    description: str
    time: datetime
    alert_type: AlertType
    level: float | None
    raw_ticker: str

    @property
    def full_symbol(self) -> str:
        return f"{self.exchange}:{self.symbol}" if self.exchange else self.symbol


@dataclass
class PriceBar:
    date: datetime
    open: float
    high: float
    low: float
    close: float
    volume: int


@dataclass
class BreakoutVerdict:
    alert: Alert
    close_on_alert_day: float | None
    pct_above_level: float | None
    volume_on_alert_day: int | None
    avg_volume_baseline: float | None
    volume_ratio: float | None
    volume_trend_ratio: float | None
    near_recent_high: bool | None
    held_above_level: bool | None
    days_held: int
    verdict: str
    notes: str
