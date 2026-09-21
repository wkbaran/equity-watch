# Breakout confirmation, tuning, and profiles

Reference for `analyze`, `analysis.config.json`, and the FMP profile cache.

## Breakout confirmation (`analyze`)

This started as a way to confirm TradingView alerts, and `analyze` still does that
job: it separates **confirmed breakouts past resistance on rising volume** from
noise, for either a TradingView CSV export or this engine's own triggers.

## Why confirm breakouts

A price-crossing alert only tells you the price touched a number at some point
intraday. It doesn't tell you whether:

- that number was a real resistance level (a recent swing high) or an arbitrary
  threshold,
- the price actually *closed* above it, rather than wicking through and falling back,
- volume picked up to confirm real buying interest, and
- the breakout held over the following days instead of failing.

This pulls daily OHLCV bars around each alert (from Schwab's market data API) and
checks all four before calling something a confirmed breakout.

## The pipeline

1. **Parse** (`src/parse.ts`) — reads the CSV and classifies each row's
   `Description` into a price-level crossing (`TICKER Crossing 123.45`, plus the
   directional `Crossing Up`/`Crossing Down` variants and the compound
   `... Crossing 277.50 AND Volume Crossing 3 M ...` form), a trendline crossing, a
   volume-spike alert, a moving-average strategy alert, or a drawing/pattern alert
   (`Exiting rectangle`). Only price-level crossings carry a numeric level, so only
   those get run through the breakout check; the rest show up in the report as
   `SKIPPED` so nothing silently disappears.

2. **Fetch** (`src/providers/schwab.ts`) — one price-history request per symbol
   (cached to disk under `.cache/bars/` so repeat runs while you're tuning thresholds
   don't re-hit the API).

3. **Confirm** (`src/analysis.ts`) — for each price-crossing alert:
   - **Closed above the level?** Wicking through and closing back below doesn't count
     (`NO_CLOSE_CONFIRM`).
   - **Near a real resistance?** The level must be at/above the highest high of the
     prior `--recent-high-lookback-days` (default 60), within
     `--recent-high-tolerance` (default 2%). Otherwise it's a crossing in the middle
     of nowhere, not a resistance breakout.
   - **Volume confirmed?** Breakout-day volume must be at least
     `--volume-ratio-threshold` (default 1.5x) the average of the prior
     `--baseline-days` (default 20).
   - **Volume actually growing?** The `--volume-trend-days` (default 3) average
     volume into the breakout must not be declining vs. the `volume-trend-days`
     before that — catches a single freak-volume day that isn't part of a real
     accumulation trend.
   - **Held?** Price must close above the level for the next `--hold-days`
     (default 2) trading days. If that many days haven't happened yet, this is left
     as "pending" rather than counted against it.

4. **Report** — one row per alert, sorted so the strongest setups sort to the top,
   written to a timestamped CSV under `reports/` (e.g.
   `reports/breakout_report_2026-08-03_14-30-05.csv`, override with `--out`):

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

   Read the `notes` column for the human-readable reasoning behind each verdict.

5. **History** (`src/history.ts`) — each run also upserts a per-ticker JSON file
   under `history/` (e.g. `history/AMZN.json`) with every alert seen for that symbol
   and its latest verdict. Re-running `analyze` over an overlapping export refreshes
   an alert's entry in-place (useful since a later run may have more trading days
   available to judge whether a breakout held) instead of duplicating it — so this
   accumulates a durable history across runs rather than the one-shot report getting
   overwritten each time.

## Running it against your own triggers

`analyze` isn't limited to a TradingView CSV. `--from-alerts [path]` (default
`revisits.json`) runs the identical pipeline against this engine's own trigger
events:

```bash
node dist/cli.js analyze --from-alerts
node dist/cli.js analyze --csv TradingView_Alerts_Log.csv
```

Exactly one of `--csv`/`--from-alerts` is required. It reads the **revisit queue**,
not the alert list: under the no-disarm model a live alert has no single "it fired"
moment to analyze, while each queue entry is exactly one trigger event with the
level and price it fired at. Records are keyed by queue-entry id rather than alert
id, so an alert that fires repeatedly over its life produces a distinct `history/`
record per trigger instead of collapsing them all onto one.

This pulls in *every* entry on record, including resolved ones — there's no notion
yet of "already analyzed" or a time window for how soon after a trigger a breakout
can be confirmed, so re-running reprocesses the same entries (harmless, since
`history/` upserts). Volume-only entries are skipped (no price level to confirm a
breakout against); for trailing entries, the observed trigger price is used as the
level (`src/alerts/bridge.ts`).

An older `alert import` command was removed: it read a third CSV schema, did no
re-levelling against bars, no price+volume combination, and no ticker-collision
guard, and pointing it at either current export silently produced zero alerts.
`alert seed` is the only CSV bootstrap.

## Useful flags

```bash
node dist/cli.js analyze \
  --csv TradingView_Alerts_Log.csv \
  --out reports/custom_name.csv \
  --symbol AMZN --symbol MU \      # limit to specific tickers (repeatable)
  --volume-ratio-threshold 2.0 \   # demand a stronger volume spike
  --hold-days 3                    # demand a longer hold before confirming
```

The six threshold flags are `--baseline-days`, `--volume-trend-days`,
`--recent-high-lookback-days`, `--recent-high-tolerance`,
`--volume-ratio-threshold`, and `--hold-days`. Any of these, if passed, override
both `analysis.config.json` and beta-scaling for that entire run.

## Per-ticker tuning (`src/tuning.ts`)

Those six thresholds are otherwise resolved per-symbol from an optional
`analysis.config.json` (path overridable with `--config`; no file at all is fine —
everything falls back to the built-in defaults). **This file must stay in the repo
root**: it is the default `--config` path, it is committed, and the scheduled task
passes no `--config` flag.

```json
{
  "default": { "volumeRatioThreshold": 1.5, "recentHighTolerance": 0.02 },
  "scaleToleranceByBeta": true,
  "ignoreSymbols": ["BIL"],
  "overrides": {
    "TSLA": { "volumeRatioThreshold": 2.5 },
    "KO": { "recentHighTolerance": 0.01 }
  },
  "web": { "holdings": false }
}
```

- `default` — any subset of the six params; missing fields keep the built-in
  defaults.
- `overrides.<SYMBOL>` — manual per-ticker values that always win, for when you want
  precise control over a specific name.
- `ignoreSymbols` — symbols excluded from alerting entirely. For holdings that
  aren't really positions: a short-duration T-Bill ETF where capital parks between
  opportunities has no meaningful level to cross. They still appear in the
  dashboard's holdings list (a third of an account shouldn't vanish from the picture,
  marked `(not alerted)`) but generate no alerts, never enter the revisit queue, and
  are never flagged as a quiet watch. Honoured by `alert check`, `holdings check`,
  `holdings cover`, and `dashboard`.
- `scaleToleranceByBeta` (default `true`) — for any symbol *without* a manual
  `recentHighTolerance` override, multiplies the default tolerance by that symbol's
  beta (fetched live from Schwab's
  `/marketdata/v1/instruments?projection=fundamental` — a real, vendor-computed
  number, not something this tool calculates itself), cached to
  `.cache/beta/<symbol>.json`. A beta-1.5 stock gets 50% more "near the recent high"
  slack than the default; a beta-0.5 stock gets half as much. Deliberately scoped to
  just this one parameter — beta is a price-volatility metric, and scaling the
  volume/hold-period thresholds by it wasn't a defensible default, so those stay
  manual-only via `overrides`.
- `web.holdings` (default `false`) — publish the holdings table to the site. Turn it
  on only together with basic auth; see [DASHBOARD.md](DASHBOARD.md).

## Sector/profile cache (`src/profiles/`)

For sector analysis, custom heatmaps, and — the part that matters day to day — the
**exchange prefix on every chart link**. `chart/?symbol=PPL` opens whatever
TradingView ranks first, which is Pakistan Petroleum, not PPL Corp.

Schwab's API has no sector, industry, or company-description data at all (checked
directly — neither its quotes nor instruments endpoints carry it), so this comes from
[Financial Modeling Prep](https://site.financialmodelingprep.com/) instead — a
free-tier third-party source. It won out over the alternatives: Alpha Vantage has the
same data shape but only 25 requests/day free, vs. FMP's 250/day; SEC EDGAR is free
with no key and no real limit, but only exposes an SIC code (an older, coarser
classification than the GICS sectors most heatmaps use) and no description text. See
[`SETUP.md`](SETUP.md) for signing up and setting `FMP_API_KEY`.

```bash
node dist/cli.js profile fetch --all-known --csv TradingView_Alerts_Log.csv
node dist/cli.js profile list [--sector Technology]
node dist/cli.js profile show --symbol AAPL
```

`--all-known` pulls the ticker union from `history/`, `holdings.json`, and
`alerts.json` (plus any `--csv` paths given) — everything tracked so far, without
assuming a fixed directory is ever scanned automatically (it isn't; CSVs are always
opt-in via `--csv`). Cached to `.cache/profiles/<symbol>.json`, one file per symbol,
no expiry (this data barely changes) — `--refresh` forces a re-fetch. The 250/day
free-tier cap is tracked in `.cache/profiles/_budget.json` **across** invocations, so
`profile fetch` is resumable: hit the cap partway through populating ~200 tickers, and
re-running the next day only fetches what's still missing.

**A symbol new to the stores caches its profile as its op is applied**, so a name added
from the dashboard gets the right chart link without anyone remembering to run `profile
fetch`. It spends the same daily budget, never blocks or fails an op, and is skipped
entirely when no FMP key is configured.
