from __future__ import annotations

import argparse
import csv
import os
import sys
from collections import defaultdict
from datetime import date, timedelta

from tv_alerts.analysis import AnalysisParams, analyze_alert
from tv_alerts.models import BreakoutVerdict
from tv_alerts.parse import parse_alerts
from tv_alerts.providers.cache import CachingProvider
from tv_alerts.providers.schwab import SchwabAuth, SchwabProvider

_VERDICT_ORDER = {
    "CONFIRMED_BREAKOUT": 0,
    "WATCH": 1,
    "WATCH_WEAK": 2,
    "NO_CLOSE_CONFIRM": 3,
    "NO": 4,
    "INSUFFICIENT_DATA": 5,
    "SKIPPED": 6,
    "PROVIDER_ERROR": 7,
}

_OUTPUT_FIELDS = [
    "verdict",
    "symbol",
    "exchange",
    "alert_time",
    "level",
    "close_on_alert_day",
    "pct_above_level",
    "volume_on_alert_day",
    "avg_volume_baseline",
    "volume_ratio",
    "volume_trend_ratio",
    "near_recent_high",
    "held_above_level",
    "days_held",
    "notes",
    "alert_id",
]


def _trading_to_calendar_days(trading_days: int) -> int:
    """Rough padding so a calendar-day date range covers `trading_days` of
    actual market data even with weekends/holidays in between."""
    return int(trading_days * 1.6) + 10


def _calendar_range_for_symbol(alerts, params: AnalysisParams) -> tuple[date, date]:
    alert_dates = [a.time.date() for a in alerts]
    lookback_days = max(params.baseline_days, params.recent_high_lookback_days)
    start = min(alert_dates) - timedelta(days=_trading_to_calendar_days(lookback_days))
    end = max(alert_dates) + timedelta(days=_trading_to_calendar_days(params.hold_days))
    end = min(end, date.today())
    return start, end


def _build_schwab_provider(args) -> SchwabProvider:
    app_key = args.app_key or os.environ.get("SCHWAB_APP_KEY")
    app_secret = args.app_secret or os.environ.get("SCHWAB_APP_SECRET")
    if not app_key or not app_secret:
        sys.exit(
            "Missing Schwab credentials. Set SCHWAB_APP_KEY / SCHWAB_APP_SECRET "
            "env vars or pass --app-key/--app-secret. See SETUP.md."
        )
    auth = SchwabAuth(app_key, app_secret, token_path=args.token_path)
    provider = SchwabProvider(auth)
    if args.no_cache:
        return provider
    return CachingProvider(provider, cache_dir=args.cache_dir)


def cmd_schwab_login(args) -> None:
    app_key = args.app_key or os.environ.get("SCHWAB_APP_KEY")
    app_secret = args.app_secret or os.environ.get("SCHWAB_APP_SECRET")
    if not app_key or not app_secret:
        sys.exit(
            "Missing Schwab credentials. Set SCHWAB_APP_KEY / SCHWAB_APP_SECRET "
            "env vars or pass --app-key/--app-secret."
        )
    auth = SchwabAuth(app_key, app_secret, token_path=args.token_path)
    auth.authorize_interactive()
    print(f"Saved Schwab tokens to {args.token_path}")


def cmd_analyze(args) -> None:
    alerts = parse_alerts(args.csv)
    if args.symbol:
        wanted = {s.upper() for s in args.symbol}
        alerts = [a for a in alerts if a.symbol.upper() in wanted]
    if not alerts:
        sys.exit("No alerts matched (check --csv path / --symbol filters).")

    params = AnalysisParams(
        baseline_days=args.baseline_days,
        volume_ratio_threshold=args.volume_ratio_threshold,
        volume_trend_days=args.volume_trend_days,
        recent_high_lookback_days=args.recent_high_lookback_days,
        recent_high_tolerance=args.recent_high_tolerance,
        hold_days=args.hold_days,
    )

    provider = _build_schwab_provider(args)

    by_symbol = defaultdict(list)
    for alert in alerts:
        by_symbol[alert.symbol].append(alert)

    verdicts: list[BreakoutVerdict] = []
    for symbol, symbol_alerts in sorted(by_symbol.items()):
        price_cross_alerts = [a for a in symbol_alerts if a.level is not None]
        non_price_alerts = [a for a in symbol_alerts if a.level is None]
        for alert in non_price_alerts:
            verdicts.append(analyze_alert(alert, [], params))

        if not price_cross_alerts:
            continue

        start, end = _calendar_range_for_symbol(price_cross_alerts, params)
        try:
            bars = provider.get_daily_bars(symbol, start, end)
        except Exception as exc:  # noqa: BLE001 - surface per-symbol, keep going
            print(f"  ! {symbol}: failed to fetch price history ({exc})", file=sys.stderr)
            for alert in price_cross_alerts:
                verdicts.append(_provider_error_verdict(alert, exc))
            continue

        for alert in price_cross_alerts:
            verdicts.append(analyze_alert(alert, bars, params))

    verdicts.sort(
        key=lambda v: (
            _VERDICT_ORDER.get(v.verdict, 99),
            -(v.volume_ratio or 0),
            v.alert.time,
        )
    )

    with open(args.out, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=_OUTPUT_FIELDS)
        writer.writeheader()
        for v in verdicts:
            writer.writerow(
                {
                    "verdict": v.verdict,
                    "symbol": v.alert.symbol,
                    "exchange": v.alert.exchange,
                    "alert_time": v.alert.time.isoformat(),
                    "level": v.alert.level,
                    "close_on_alert_day": v.close_on_alert_day,
                    "pct_above_level": _fmt(v.pct_above_level),
                    "volume_on_alert_day": v.volume_on_alert_day,
                    "avg_volume_baseline": _fmt(v.avg_volume_baseline),
                    "volume_ratio": _fmt(v.volume_ratio),
                    "volume_trend_ratio": _fmt(v.volume_trend_ratio),
                    "near_recent_high": v.near_recent_high,
                    "held_above_level": v.held_above_level,
                    "days_held": v.days_held,
                    "notes": v.notes,
                    "alert_id": v.alert.alert_id,
                }
            )

    counts = defaultdict(int)
    for v in verdicts:
        counts[v.verdict] += 1
    print(f"Wrote {len(verdicts)} rows to {args.out}")
    for verdict_name in sorted(counts, key=lambda k: _VERDICT_ORDER.get(k, 99)):
        print(f"  {verdict_name}: {counts[verdict_name]}")

    top = [v for v in verdicts if v.verdict == "CONFIRMED_BREAKOUT"][:10]
    if top:
        print("\nTop confirmed breakouts:")
        for v in top:
            print(
                f"  {v.alert.symbol:<6} {v.alert.time.date()}  level={v.alert.level}  "
                f"{v.notes}"
            )


def _provider_error_verdict(alert, exc) -> BreakoutVerdict:
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
        verdict="PROVIDER_ERROR",
        notes=str(exc),
    )


def _fmt(value: float | None) -> str:
    return "" if value is None else f"{value:.4f}"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tv_alerts")
    subparsers = parser.add_subparsers(dest="command", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--app-key", help="Schwab App Key (or SCHWAB_APP_KEY env var)")
    common.add_argument("--app-secret", help="Schwab App Secret (or SCHWAB_APP_SECRET env var)")
    common.add_argument(
        "--token-path",
        default=os.path.expanduser("~/.tv_alerts/schwab_tokens.json"),
        help="Where to cache Schwab OAuth tokens",
    )

    login = subparsers.add_parser(
        "schwab-login", parents=[common], help="One-time interactive Schwab OAuth login"
    )
    login.set_defaults(func=cmd_schwab_login)

    analyze_parser = subparsers.add_parser(
        "analyze", parents=[common], help="Analyze an alert CSV for confirmed breakouts"
    )
    analyze_parser.add_argument("--csv", required=True, help="Path to the TradingView alerts CSV export")
    analyze_parser.add_argument("--out", default="breakout_report.csv", help="Output CSV path")
    analyze_parser.add_argument(
        "--symbol", action="append", help="Only analyze this symbol (repeatable)"
    )
    analyze_parser.add_argument("--no-cache", action="store_true", help="Disable the on-disk bar cache")
    analyze_parser.add_argument(
        "--cache-dir", default=".cache/bars", help="Directory for the on-disk bar cache"
    )
    analyze_parser.add_argument("--baseline-days", type=int, default=20)
    analyze_parser.add_argument("--volume-ratio-threshold", type=float, default=1.5)
    analyze_parser.add_argument("--volume-trend-days", type=int, default=3)
    analyze_parser.add_argument("--recent-high-lookback-days", type=int, default=60)
    analyze_parser.add_argument("--recent-high-tolerance", type=float, default=0.02)
    analyze_parser.add_argument("--hold-days", type=int, default=2)
    analyze_parser.set_defaults(func=cmd_analyze)

    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
