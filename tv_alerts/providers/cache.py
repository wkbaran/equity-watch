"""A dumb on-disk cache in front of any `PriceDataProvider`.

Re-running the analysis while you're tuning thresholds shouldn't mean
re-fetching bars for every symbol every time, so results are cached to a
JSON file per (symbol, start, end) request.
"""

from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, timezone
from pathlib import Path

from tv_alerts.models import PriceBar


class CachingProvider:
    def __init__(self, inner, cache_dir: str | Path):
        self.inner = inner
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _cache_file(self, symbol: str, start: date, end: date) -> Path:
        key = f"{symbol}_{start.isoformat()}_{end.isoformat()}"
        digest = hashlib.sha1(key.encode()).hexdigest()[:16]
        return self.cache_dir / f"{symbol.replace('/', '_')}_{digest}.json"

    def get_daily_bars(self, symbol: str, start: date, end: date) -> list[PriceBar]:
        cache_file = self._cache_file(symbol, start, end)
        if cache_file.exists():
            raw = json.loads(cache_file.read_text())
            return [
                PriceBar(
                    date=datetime.fromisoformat(b["date"]),
                    open=b["open"],
                    high=b["high"],
                    low=b["low"],
                    close=b["close"],
                    volume=b["volume"],
                )
                for b in raw
            ]

        bars = self.inner.get_daily_bars(symbol, start, end)
        cache_file.write_text(
            json.dumps(
                [
                    {
                        "date": b.date.astimezone(timezone.utc).isoformat(),
                        "open": b.open,
                        "high": b.high,
                        "low": b.low,
                        "close": b.close,
                        "volume": b.volume,
                    }
                    for b in bars
                ],
                indent=2,
            )
        )
        return bars
