"""Market data provider interface.

Only a Schwab implementation ships here (Schwab is the one official,
documented API among the user's brokerage accounts — Robinhood and Webull
only have unofficial reverse-engineered client libraries, which is a poor
fit for anything you want to rely on for historical OHLCV data). The
`PriceDataProvider` protocol exists so another provider can be dropped in
later without touching `analysis.py` or `cli.py`.
"""

from __future__ import annotations

from datetime import date
from typing import Protocol

from tv_alerts.models import PriceBar


class PriceDataProvider(Protocol):
    def get_daily_bars(
        self, symbol: str, start: date, end: date
    ) -> list[PriceBar]:
        """Return daily OHLCV bars for `symbol` between `start` and `end` inclusive."""
        ...
