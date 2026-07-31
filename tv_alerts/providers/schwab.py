"""Schwab market-data provider.

Schwab's individual developer API uses a standard OAuth2 authorization-code
flow with a short-lived (30 min) access token and a longer-lived (7 day)
refresh token. See SETUP.md for how to register an app and get an App Key
/ App Secret.

This talks directly to the REST API with `requests` rather than pulling in
a third-party Schwab client, so the OAuth/token handling here is fully
visible and auditable. Endpoints and parameter names follow Schwab's
published `marketdata` API (a continuation of the old TD Ameritrade API
shape); double-check against https://developer.schwab.com if Schwab has
changed anything since.
"""

from __future__ import annotations

import json
import os
import stat
import time
import webbrowser
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests

from tv_alerts.models import PriceBar

AUTHORIZE_URL = "https://api.schwabapi.com/v1/oauth/authorize"
TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token"
PRICE_HISTORY_URL = "https://api.schwabapi.com/marketdata/v1/pricehistory"

# Refresh a bit before the access token actually expires to avoid racing a
# request against expiry.
_ACCESS_TOKEN_SAFETY_MARGIN_SECONDS = 60


class SchwabAuthError(RuntimeError):
    pass


@dataclass
class _TokenState:
    access_token: str
    refresh_token: str
    access_token_expires_at: float  # unix epoch seconds

    @classmethod
    def from_token_response(cls, payload: dict, obtained_at: float) -> "_TokenState":
        return cls(
            access_token=payload["access_token"],
            refresh_token=payload["refresh_token"],
            access_token_expires_at=obtained_at + payload["expires_in"],
        )

    def to_json(self) -> dict:
        return {
            "access_token": self.access_token,
            "refresh_token": self.refresh_token,
            "access_token_expires_at": self.access_token_expires_at,
        }

    @classmethod
    def from_json(cls, payload: dict) -> "_TokenState":
        return cls(
            access_token=payload["access_token"],
            refresh_token=payload["refresh_token"],
            access_token_expires_at=payload["access_token_expires_at"],
        )


class SchwabAuth:
    """Handles the OAuth2 dance and on-disk token caching for Schwab's API."""

    def __init__(
        self,
        app_key: str,
        app_secret: str,
        token_path: str | Path,
        callback_url: str = "https://127.0.0.1",
    ):
        self.app_key = app_key
        self.app_secret = app_secret
        self.token_path = Path(token_path)
        self.callback_url = callback_url
        self._state: _TokenState | None = self._load_token_state()

    def _load_token_state(self) -> _TokenState | None:
        if not self.token_path.exists():
            return None
        return _TokenState.from_json(json.loads(self.token_path.read_text()))

    def _save_token_state(self) -> None:
        assert self._state is not None
        self.token_path.write_text(json.dumps(self._state.to_json(), indent=2))
        # Token file contains bearer credentials; keep it user-readable only.
        os.chmod(self.token_path, stat.S_IRUSR | stat.S_IWUSR)

    def authorize_interactive(self) -> None:
        """Run the one-time browser login flow and persist the resulting tokens.

        Only needs to be run once per refresh-token lifetime (Schwab refresh
        tokens are valid for 7 days; re-run this whenever get_access_token()
        starts raising SchwabAuthError because the refresh token expired).
        """
        auth_url = (
            f"{AUTHORIZE_URL}?client_id={self.app_key}"
            f"&redirect_uri={self.callback_url}"
        )
        print("Opening Schwab login in your browser. If it doesn't open, visit:")
        print(auth_url)
        webbrowser.open(auth_url)
        redirected_url = input(
            "\nAfter approving access, paste the full URL you were redirected to: "
        ).strip()

        query = parse_qs(urlparse(redirected_url).query)
        if "code" not in query:
            raise SchwabAuthError(
                "Could not find an authorization `code` in the pasted URL."
            )
        code = query["code"][0]

        obtained_at = time.time()
        response = requests.post(
            TOKEN_URL,
            auth=(self.app_key, self.app_secret),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": self.callback_url,
            },
            timeout=30,
        )
        if response.status_code != 200:
            raise SchwabAuthError(
                f"Token exchange failed ({response.status_code}): {response.text}"
            )

        self._state = _TokenState.from_token_response(response.json(), obtained_at)
        self._save_token_state()

    def _refresh(self) -> None:
        if self._state is None:
            raise SchwabAuthError(
                "No cached Schwab tokens found. Run authorize_interactive() first "
                "(e.g. `python -m tv_alerts.cli schwab-login`)."
            )

        obtained_at = time.time()
        response = requests.post(
            TOKEN_URL,
            auth=(self.app_key, self.app_secret),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "grant_type": "refresh_token",
                "refresh_token": self._state.refresh_token,
            },
            timeout=30,
        )
        if response.status_code != 200:
            raise SchwabAuthError(
                f"Token refresh failed ({response.status_code}): {response.text}. "
                "The refresh token may have expired (7 day lifetime) - re-run "
                "authorize_interactive()."
            )

        self._state = _TokenState.from_token_response(response.json(), obtained_at)
        self._save_token_state()

    def get_access_token(self) -> str:
        if self._state is None:
            raise SchwabAuthError(
                "No cached Schwab tokens found. Run authorize_interactive() first "
                "(e.g. `python -m tv_alerts.cli schwab-login`)."
            )
        if time.time() >= self._state.access_token_expires_at - _ACCESS_TOKEN_SAFETY_MARGIN_SECONDS:
            self._refresh()
        return self._state.access_token


class SchwabProvider:
    """`PriceDataProvider` backed by Schwab's `/marketdata/v1/pricehistory`."""

    def __init__(self, auth: SchwabAuth, session: requests.Session | None = None):
        self.auth = auth
        self.session = session or requests.Session()

    def get_daily_bars(self, symbol: str, start: date, end: date) -> list[PriceBar]:
        start_ms = int(
            datetime(start.year, start.month, start.day, tzinfo=timezone.utc).timestamp()
            * 1000
        )
        end_ms = int(
            datetime(end.year, end.month, end.day, tzinfo=timezone.utc).timestamp()
            * 1000
        )

        response = self.session.get(
            PRICE_HISTORY_URL,
            headers={"Authorization": f"Bearer {self.auth.get_access_token()}"},
            params={
                "symbol": symbol,
                "periodType": "year",
                "frequencyType": "daily",
                "frequency": 1,
                "startDate": start_ms,
                "endDate": end_ms,
                "needExtendedHoursData": "false",
            },
            timeout=30,
        )
        if response.status_code != 200:
            raise RuntimeError(
                f"Schwab price history request for {symbol} failed "
                f"({response.status_code}): {response.text}"
            )

        payload = response.json()
        bars = []
        for candle in payload.get("candles", []):
            bars.append(
                PriceBar(
                    date=datetime.fromtimestamp(candle["datetime"] / 1000, tz=timezone.utc),
                    open=candle["open"],
                    high=candle["high"],
                    low=candle["low"],
                    close=candle["close"],
                    volume=int(candle["volume"]),
                )
            )
        return bars
