# tradingview-alert-analysis

Turns a raw TradingView "Alerts Log" CSV export into a short list of alerts
worth actually looking at again, specifically: **confirmed breakouts past
resistance on rising volume**.

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
npm install
npm run build
node dist/cli.js analyze --csv TradingView_Alerts_Log.csv
```

## What it does

1. **Parse** (`src/parse.ts`) — reads the CSV and classifies each row's
   `Description` into a price-level crossing (`TICKER Crossing 123.45`), a
   trendline crossing, a volume-spike alert, or a moving-average strategy
   alert. Only price-level crossings carry a numeric level, so only those
   get run through the breakout check; the rest show up in the report as
   `SKIPPED` so nothing silently disappears.

2. **Fetch** (`src/providers/schwab.ts`) — one price-history request per
   symbol (cached to disk under `.cache/bars/` so repeat runs while you're
   tuning thresholds don't re-hit the API).

3. **Confirm** (`src/analysis.ts`) — for each price-crossing alert:
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
   the top, written to a timestamped CSV under `reports/` (e.g.
   `reports/breakout_report_2026-08-03_14-30-05.csv`, override with
   `--out`):

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

5. **History** (`src/history.ts`) — each run also upserts a per-ticker JSON
   file under `history/` (e.g. `history/AMZN.json`) with every alert seen
   for that symbol and its latest verdict, keyed by alert ID. Re-running
   `analyze` over an overlapping CSV export refreshes an alert's entry
   in-place (useful since a later run may have more trading days available
   to judge whether a breakout held) instead of duplicating it — so this
   accumulates a durable history across runs rather than the one-shot
   report getting overwritten each time.

## Useful flags

```bash
node dist/cli.js analyze \
  --csv TradingView_Alerts_Log.csv \
  --out reports/custom_name.csv \
  --symbol AMZN --symbol MU \      # limit to specific tickers (repeatable)
  --volume-ratio-threshold 2.0 \   # demand a stronger volume spike
  --hold-days 3                    # demand a longer hold before confirming
```

Same flags for everything under the hood: `--baseline-days`,
`--volume-trend-days`, `--recent-high-lookback-days`,
`--recent-high-tolerance`, `--no-cache`, `--cache-dir`, `--history-dir`,
`--app-key`/`--app-secret`/`--token-path` (or the
`SCHWAB_APP_KEY`/`SCHWAB_APP_SECRET` in a `.env` file or as env vars — see
SETUP.md). Any of these, if passed, override everything else below for
that entire run.

While iterating, `npm run cli -- analyze ...` (via `tsx`) skips the build
step.

## Per-ticker tuning (`src/tuning.ts`)

The six thresholds above are otherwise resolved per-symbol from an
optional `analysis.config.json` (path overridable with `--config`; no
file at all is fine — everything just falls back to the built-in
defaults, identical to not having this feature):

```json
{
  "default": { "volumeRatioThreshold": 1.5, "recentHighTolerance": 0.02 },
  "scaleToleranceByBeta": true,
  "overrides": {
    "TSLA": { "volumeRatioThreshold": 2.5 },
    "KO": { "recentHighTolerance": 0.01 }
  }
}
```

- `default` — any subset of the six params; missing fields keep the
  built-in defaults.
- `overrides.<SYMBOL>` — manual per-ticker values that always win, for
  when you want precise control over a specific name.
- `scaleToleranceByBeta` (default `true`) — for any symbol *without* a
  manual `recentHighTolerance` override, multiplies the default tolerance
  by that symbol's beta (fetched live from Schwab's
  `/marketdata/v1/instruments?projection=fundamental` — a real,
  vendor-computed number, not something this tool calculates itself),
  cached to `.cache/beta/<symbol>.json`. A beta-1.5 stock gets 50% more
  "near the recent high" slack than the default; a beta-0.5 stock gets
  half as much. Deliberately scoped to just this one parameter — beta is
  a price-volatility metric, and scaling the volume/hold-period
  thresholds by it wasn't a defensible default, so those stay
  manual-only via `overrides`.

## Alerts

A separate, lighter-weight `alert` command manages your own price alerts
directly (no TradingView CSV involved) — useful since TradingView has no
API to read back your pending alerts, but this tool's own `alerts.json`
(gitignored, one flat file) does. Three kinds:

- **Static** — fire once when price crosses a fixed level:
  `node dist/cli.js alert add --symbol AAPL --level 150`
- **Trailing** — track a running low/high since armed and fire on a
  bounce/pullback of a given percent or dollar amount from that extreme
  (like a trailing-stop-buy, as a notification instead of a trade):
  `node dist/cli.js alert add --symbol AAPL --near 150 --trail-percent 3`
  (or `--trail-amount 2.50`)
- **Volume** — fire when volume reaches a threshold, either standalone or
  ANDed onto a static/trailing alert above (so both conditions must hold):
  `node dist/cli.js alert add --symbol AAPL --volume-at-least 5000000`
  (standalone), or `--level 150 --volume-at-least 5000000` (AND'd). By
  default this checks cumulative volume so far in the current session;
  add `--volume-period 30m` (also `s`/`h`/`d`) to instead sum volume over
  a trailing window, recomputed fresh every check regardless of your poll
  cadence. Sub-minute periods round up to a minute — Schwab's REST history
  doesn't go any finer without the separate streaming API.

For static/trailing, whether it's an "above" or "below" alert is
*inferred* by comparing `--level`/`--near` to the live price at the moment
you add it — not something you choose. Adding a new alert that's closer to
the live price than an existing armed one on the same symbol+side replaces
it (regardless of kind); adding one that's farther is rejected. Above and
below coexist independently, so you can watch both sides of a symbol at
once. Standalone volume alerts sit outside this rule entirely (no natural
"side" to dedup on) and just coexist freely.

For a static alert combined with a volume condition, a price crossing that
happens before volume catches up isn't lost — it stays "pending" (checked
again every poll) until either volume qualifies or price fully reverts to
where it started, whichever comes first.

When an alert fires, its `triggerSnapshot` field captures every attribute
(level/near/trail settings, extremePrice, etc.) exactly as they were at
that moment, independent of the live record — so a future edit/rearm of
the same alert can't retroactively change what it looked like when it
actually triggered.

```bash
node dist/cli.js alert list [--all]     # armed only by default
node dist/cli.js alert remove <id>
node dist/cli.js alert check            # one pass against live Schwab quotes;
                                         # point your own cron/Task Scheduler
                                         # at this every ~15 min
```

`alerts.json` is always the source of truth for alert state, but `alert
check` also writes a `reports/alert_triggers_<timestamp>.csv` — same
`reports/` directory `analyze` uses, distinguished by filename prefix
(`alert_triggers_...` vs. `breakout_report_...`) so it's clear at a glance
which command produced which file. Since checks run far more often than
`analyze` (every 5-15 min vs. once or twice a day) and most find nothing,
this file is only written when something actually triggered — no empty
files piling up from routine checks.

### Confirming breakouts for this engine's own triggered alerts

`analyze` isn't limited to a TradingView CSV — `--from-alerts [path]`
(default `alerts.json`) runs the identical breakout-confirmation pipeline
against every alert marked `triggered` in this engine's own store instead:

```bash
node dist/cli.js analyze --from-alerts
```

Exactly one of `--csv`/`--from-alerts` is required. This pulls in *every*
triggered alert on record, not just ones from the most recent `alert
check` — there's no notion yet of "already analyzed" or a time window for
how soon after a trigger a breakout can be confirmed, so re-running this
will reprocess the same triggers again (harmless — `history/` upserts by
alert id, so it just refreshes rather than duplicating). Volume-only
alerts are skipped (no price level to confirm a breakout against); for
trailing alerts, the observed `triggerPrice` is used as the level, since
trailing alerts don't have a single fixed target the way static alerts do
(`src/alerts/bridge.ts`).

To bootstrap from an existing TradingView setup instead of re-entering
everything by hand, `alert import` reuses the same CSV parser as `analyze`
and converts every numeric `Crossing <level>` row into a static alert
(`--as-trailing` + `--trail-percent`/`--trail-amount` converts them into
trailing alerts instead):

```bash
node dist/cli.js alert import --csv TradingView_Alerts_Log.csv
```

Every candidate row goes through the same side-inference and uniqueness
rules as `alert add` — a CSV with the same symbol logged at several
historical levels naturally collapses down to just the closest armed
alert per symbol+side, with everything farther cancelled along the way.

`alert check` polls Schwab's `/marketdata/v1/quotes` endpoint (already
covered by the Market Data Production access from SETUP.md — no streaming
API needed) and prints triggered alerts with a TradingView chart link to
pull up. Notifications go through a pluggable `Notifier`
(`src/alerts/notify.ts`) — only a console notifier exists today.

## Tests

```bash
npm test
```

Analysis logic (`tests/analysis.test.ts`) is tested against fabricated
OHLCV sequences (clean breakout, failed breakout/fakeout, no-volume
crossing, mid-range crossing, etc.) so it doesn't require network access
or real credentials. The parser (`tests/parse.test.ts`) is tested against
real rows pulled from a TradingView export, including the mis-encoded
unit separator TradingView emits in its volume alerts (`"Volume Crossing
4.5\xc3\xa2\xc2\x80\xc2\xafM on ..."`) and comma-formatted price levels
(`"MKL Crossing 2,003.72"`).
