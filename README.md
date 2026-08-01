# tradingview-alert-analysis

Turns a raw TradingView "Alerts Log" CSV export into a short list of alerts
worth actually looking at again, specifically: **confirmed breakouts past
resistance on rising volume**.

This is the Python implementation. A functionally identical TypeScript/Node
port lives in `ts/` (see `ts/README.md`).

## Why

A TradingView price-crossing alert only tells you the price touched a
number at some point intraday. It doesn't tell you whether:

- that number was a real resistance level (a recent swing high) or an
  arbitrary threshold,
- the price actually *closed* above it, rather than wicking through and
  falling back,
- volume picked up to confirm real buying interest, and
- the breakout held over the following days instead of failing.

This tool pulls daily OHLCV bars around each alert (from Schwab's market
data API — see `SETUP.md`) and checks all four before calling something a
confirmed breakout.

## Quick start

See `SETUP.md` for registering a Schwab developer app and the one-time
OAuth login. Then:

```bash
python -m tv_alerts.cli analyze --csv TradingView_Alerts_Log.csv --out breakout_report.csv
```

## What it does

1. **Parse** (`tv_alerts/parse.py`) — reads the CSV and classifies each
   row's `Description` into a price-level crossing (`TICKER Crossing
   123.45`), a trendline crossing, a volume-spike alert, or a moving-average
   strategy alert. Only price-level crossings carry a numeric level, so
   only those get run through the breakout check; the rest show up in the
   report as `SKIPPED` so nothing silently disappears.

2. **Fetch** (`tv_alerts/providers/schwab.py`) — one price-history request
   per symbol (cached to disk under `.cache/bars/` so repeat runs while
   you're tuning thresholds don't re-hit the API).

3. **Confirm** (`tv_alerts/analysis.py`) — for each price-crossing alert:
   - **Closed above the level?** Wicking through and closing back below
     doesn't count (`NO_CLOSE_CONFIRM`).
   - **Near a real resistance?** The level must be at/above the highest
     high of the prior `--recent-high-lookback-days` (default 60), within
     `--recent-high-tolerance` (default 2%). Otherwise it's a crossing in
     the middle of nowhere, not a resistance breakout.
   - **Volume confirmed?** Breakout-day volume must be at least
     `--volume-ratio-threshold` (default 1.5x) the average of the prior
     `--baseline-days` (default 20).
   - **Volume actually growing?** The `--volume-trend-days` (default 3)
     average volume into the breakout must not be declining vs. the
     `volume-trend-days` before that — catches a single freak-volume day
     that isn't part of a real accumulation trend.
   - **Held?** Price must close above the level for the next
     `--hold-days` (default 2) trading days. If that many days haven't
     happened yet, this is left as "pending" rather than counted against
     it.

4. **Report** — one row per alert, sorted so the strongest setups sort to
   the top:

   | verdict | meaning |
   |---|---|
   | `CONFIRMED_BREAKOUT` | close above level, near real resistance, volume confirmed and not declining, held (or too soon to tell) |
   | `WATCH` | volume confirmed and near resistance, but failed to hold |
   | `WATCH_WEAK` | only one of volume/resistance confirmed |
   | `NO` | closed above the level but neither volume nor resistance checks out |
   | `NO_CLOSE_CONFIRM` | never actually closed above the level |
   | `INSUFFICIENT_DATA` | not enough prior trading history to compute a baseline |
   | `SKIPPED` | not a numeric price-level alert (trendline/volume/MA-strategy) |
   | `PROVIDER_ERROR` | the Schwab request for that symbol failed |

   Read the `notes` column for the human-readable reasoning behind each
   verdict.

## Useful flags

```bash
python -m tv_alerts.cli analyze \
  --csv TradingView_Alerts_Log.csv \
  --out breakout_report.csv \
  --symbol AMZN --symbol MU \      # limit to specific tickers (repeatable)
  --volume-ratio-threshold 2.0 \   # demand a stronger volume spike
  --hold-days 3                    # demand a longer hold before confirming
```

## Tests

```bash
python -m pytest tests/
```

Analysis logic is tested against fabricated OHLCV sequences (clean
breakout, failed breakout/fakeout, no-volume crossing, mid-range crossing,
etc.) so it doesn't require network access or real credentials. The
parser is tested against real rows pulled from a TradingView export,
including the mis-encoded unit separator TradingView emits in its volume
alerts (`"Volume Crossing 4.5\xc3\xa2\xc2\x80\xc2\xafM on ..."`) and
comma-formatted price levels (`"MKL Crossing 2,003.72"`).
