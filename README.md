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
node dist/cli.js schwab-login                          # one-time OAuth; re-run when
                                                        # the refresh token expires
node dist/cli.js analyze --csv TradingView_Alerts_Log.csv
```

Schwab's refresh token has a **7-day lifetime**, so `schwab-login` is not
strictly one-time — any command that hits the API will fail with
`Refresh token is invalid, expired or revoked` once it lapses, and re-running
`schwab-login` is the fix.

Every command and subcommand supports `--help`, and running a command group
on its own (`alert`, `alert revisit`, `holdings`, `holdings stop`, `profile`)
prints its subcommands:

```bash
node dist/cli.js --help
node dist/cli.js alert revisit --help
```

### Command map

| command | what it does |
|---|---|
| `schwab-login` | One-time (per 7 days) interactive Schwab OAuth login |
| `analyze` | Breakout-confirm a TradingView CSV (`--csv`) or the revisit queue (`--from-alerts`) |
| `dashboard` | The periodic JSON document — queue, approaching alerts, holdings |
| `alert add` / `list` / `remove` / `check` | Manage and poll your own alerts |
| `alert seed` | One-time migration of the two TradingView CSV exports |
| `alert revisit list` / `relevel` / `apply` / `dismiss` | Work the revisit queue |
| `holdings add-lot` / `list` / `check` | Track positions and basis-relative alerts |
| `holdings stop add` / `list` / `remove` | Record stops |
| `profile fetch` / `list` / `show` | Sector/industry cache from Financial Modeling Prep |

## What it does

1. **Parse** (`src/parse.ts`) — reads the CSV and classifies each row's
   `Description` into a price-level crossing (`TICKER Crossing 123.45`, plus
   the directional `Crossing Up`/`Crossing Down` variants and the compound
   `... Crossing 277.50 AND Volume Crossing 3 M ...` form), a trendline
   crossing, a volume-spike alert, a moving-average strategy alert, or a
   drawing/pattern alert (`Exiting rectangle`). Only price-level crossings
   carry a numeric level, so only those get run through the breakout check;
   the rest show up in the report as `SKIPPED` so nothing silently
   disappears.

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
  "ignoreSymbols": ["BIL"],
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
- `ignoreSymbols` — symbols excluded from alerting entirely. For holdings
  that aren't really positions: a short-duration T-Bill ETF where capital
  parks between opportunities has no meaningful level to cross. They still
  appear in the dashboard's holdings list (a third of an account shouldn't
  vanish from the picture, marked `(not alerted)`) but generate no alerts,
  never enter the revisit queue, and are never flagged as a quiet watch.
  Honoured by `alert check`, `holdings check`, `holdings cover`, and
  `dashboard`.
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
- **Trailing** — track a running low/high since the alert was created and fire on a
  bounce/pullback of a given percent or dollar amount from that extreme
  (like a trailing-stop-buy, as a notification instead of a trade):
  `node dist/cli.js alert add --symbol AAPL --near 150 --trail-percent 3`
  (or `--trail-amount 2.50`)
- **Volume** — fire when volume reaches a threshold, as either an absolute
  share count (`--volume-at-least`) or a **multiple of typical volume**
  (`--volume-ratio 1.5`); standalone or
  ANDed onto a static/trailing alert above (so both conditions must hold):
  `node dist/cli.js alert add --symbol AAPL --volume-at-least 5000000`
  (standalone), or `--level 150 --volume-at-least 5000000` (AND'd). By
  default this checks cumulative volume so far in the current session;
  add `--volume-period 30m` (also `s`/`h`/`d`) to instead sum volume over
  a trailing window, recomputed fresh every check regardless of your poll
  cadence. Sub-minute periods round up to a minute — Schwab's REST history
  doesn't go any finer without the separate streaming API.

#### Absolute thresholds vs. ratios

An absolute threshold is what TradingView exports and what you type directly,
but it rots silently. The imported `Volume Crossing 55 K on MTD, 1W` was 22x
too low by the time it arrived and fired on **82 of 82 sessions** — it had
stopped meaning anything and nothing said so.

`--volume-ratio 1.5` instead means "1.5x typical volume for this window",
recomputed each check against a trailing baseline, so it can't drift out of
range as liquidity changes. "Typical" is computed differently per window,
because the naive version is wrong in a different way each time:

| window | baseline |
|---|---|
| `today` | average **full-day** volume over the last 20 sessions |
| `7d` (any day count) | average of rolling **7-calendar-day sums**, *not* `avgDaily x 7` — a 7-day window holds ~5 trading days, so multiplying overstates by ~40% |
| `1h` / `30m` | average volume in **that same clock window** across recent sessions |

The intraday case matters more than it sounds. On MSFT the hour into the close
carries ~2.2M shares against ~0.9M in the early afternoon — a flat hourly
average would make every close look like a 1.7x spike and every lunch hour look
dead.

One consequence to know about `today`: your own figure is partial, so the ratio
climbs through the session. `--volume-ratio 1.5` there reads as *"today is
already a 1.5x-volume day"* — a strong signal, but one that rarely trips before
midday.

Baselines cache to `.cache/volume-baseline/<symbol>_<window>.json`, keyed to
the market date so they refresh once per trading day. Without that, checks
every 15 minutes would mean a bar fetch per volume alert per poll. A baseline
that can't be computed (no history, or a sub-day window evaluated outside
market hours) leaves the condition **unsatisfied** rather than treating any
volume as qualifying.

For static/trailing, whether it's an "above" or "below" alert is
*inferred* by comparing `--level`/`--near` to the live price at the moment
you add it — not something you choose. Adding a new alert that's closer to
the live price than an existing live one on the same symbol+side replaces
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
that moment, independent of the live record — so a later edit or re-level of
the same alert can't retroactively change what it looked like when it
actually triggered. It holds the *most recent* trigger; the full history of
every trigger lives in the revisit queue.

```bash
node dist/cli.js alert list [--all]     # live only by default
node dist/cli.js alert remove <id>
node dist/cli.js alert check            # one pass against live Schwab quotes;
                                         # point your own cron/Task Scheduler
                                         # at this every ~15 min
```

### Moving-average alerts

Fire when price **crosses** a simple or exponential moving average, or
**touches** it within a small margin, on 1/2/5/15-minute, daily, or weekly bars:

```bash
node dist/cli.js alert add --symbol AAPL --ma sma200@1W                    # any cross of the 200-week SMA
node dist/cli.js alert add --symbol AAPL --ma sma20@1D --direction up      # only upward crosses of the 20-day
node dist/cli.js alert add --symbol AAPL --ma ema9@5m --touch              # within 0.25% of the 9-bar EMA on 5-minute bars
node dist/cli.js alert add --symbol AAPL --ma sma9@1D --touch 0.5 --from above   # pullback to the 9-day from above
```

`--ma` takes `sma|ema`, a period (1-200), `@`, and a timeframe (`1m 2m 5m 15m 1D 1W`).

- **The level moves with the average.** Nothing to re-level: `revisit relevel`
  proposes no new level for these, and `apply` doesn't apply to them.
- **Completed bars only.** The average in force at any moment is taken over bars
  that had already closed, so a daily or weekly average holds still all day and
  an intraday one steps once per bar. That's what a chart shows for any bar but
  the one still forming.
- **Independent of poll timing.** Each check replays the 1-minute bars since the
  last check, plus the live quote, not just the price at poll time. A cross that
  reversed between polls still fires, and a 9-bar average on 1-minute bars works
  under a 2-minute poll.
- **Cross vs. touch.** A cross is judged on closes, so a wick through and back is
  a touch, not a cross. A touch uses each bar's full high-low range.
- **Re-firing.** At most once per MA bar (TradingView's "once per bar"). A touch
  also has to move away by twice the margin before it can fire again.
- **First check seeds.** A new alert records which side price is on at its first
  check and can fire from the next one, so adding one never fires immediately.
- **Not enough history means no level.** A 200-week SMA on a three-year-old
  listing is skipped with a warning rather than averaged over what exists.
- **EMAs get 4× their period of history** to converge (up to ~15 years of daily
  bars for a 200-week EMA, in one request). Intraday EMAs are limited to Schwab's
  10 trading days of minute bars, so long ones may still differ slightly from a
  chart with more history.
- **Regular-session minute bars.** In pre/post market only the live quote
  moves the path.

Cost: one 1-minute-bar request per symbol per check (shared by all that symbol's
averages), plus one daily-history request per symbol per day, cached in
`.cache/ma-daily/`. With many symbols on a short poll, the 120 requests/minute
throttle will stretch a check out rather than fail.

Each trigger lands in the revisit queue like any other, with the average's value
as `levelAtTrigger`. An intraday average on a choppy name can fire often; that's
worth watching before adding many.

### Market hours

`alert check` asks Schwab for the day's equity hours before spending a single
quote request, and exits without polling when the market is closed:

```
Skipped: market closed (no further session today). No quotes fetched.
```

Hours come from `/marketdata/v1/markets` rather than a hardcoded 09:30-16:00,
because the real calendar has holidays and half days - the day after
Thanksgiving 2026 closes at 13:00 with a post-market ending 17:00, and a
constant would poll a closed market for three hours and miss the shortened
post-market entirely. They cache permanently to `.cache/hours/<date>.json`
(a published day's hours never change), so a 15-minute poller doesn't spend a
request per check just to ask whether the market is open.

Pre- and post-market are polled by default. A trigger records **which session
it fired in**, because a pre-market break on thin volume and a wide spread is
not the same event as the identical break at midday - the dashboard says
`in pre-market` on those rows rather than flattening them together.

- `--regular-only` - poll only 09:30-16:00.
- `--ignore-hours` - poll regardless, for testing.

A market-hours lookup failure logs and falls through to checking anyway,
rather than taking the poller down over a calendar request.

### Alerts never disarm

Unlike TradingView, a triggered alert here does not stop watching. There is
no "armed" state to get back to and nothing to remember to re-arm — the only
non-live state is `cancelled`, which only ever happens because you removed
the alert or a closer one superseded it.

Instead, every trigger appends an entry to the **revisit queue**
(`revisits.json`), a durable to-do list meaning "this level got taken out,
the level is probably stale now, decide what to do". The alert itself stays
live at its original level the whole time, so nothing stops being watched
while an entry sits in the queue.

Re-firing is still self-limiting, so a live alert doesn't spam you:

- **static** — after firing, `lastKnownSide` advances, so it goes quiet until
  price genuinely re-crosses the level.
- **trailing** — `extremePrice` resets to the trigger price, so it starts
  trailing afresh from there.
- **volume** — a volume threshold, once crossed, stays crossed, so these set
  a `mutedUntil` for the rest of the day (or the rest of the period window)
  rather than firing on every poll.

### The revisit queue

```bash
node dist/cli.js alert revisit list [--status open|applied|dismissed|all] [--limit N]
node dist/cli.js alert revisit relevel      # fetch bars, propose levels, score the queue
node dist/cli.js alert revisit apply <id>   # move the alert to the proposed level
node dist/cli.js alert revisit dismiss <id> # close the entry, leave the alert alone
```

`relevel` is the pass that makes the queue useful. For each open entry it
pulls daily bars and:

- **proposes a new level** if price has pushed past the old one — the highest
  high over `recentHighLookbackDays` if there's resistance overhead, or that
  high plus one `recentHighTolerance` width if the stock is in new-high
  territory with nothing above it. If price fell back *below* the level, no
  suggestion is made: the original level is still a perfectly good target and
  re-levelling would throw it away.
- **scores the entry 0–100** by blending five signals, each saturating so no
  single one can run away with the ranking:

  | signal | weight | |
  |---|---|---|
  | breakout verdict | 30% | `CONFIRMED_BREAKOUT` > `WATCH` > `WATCH_WEAK` > `NO`, straight from `analyze` |
  | rising volume | 25% | breakout-day ratio blended with the volume trend into it — applied whether or not the alert itself had a volume condition |
  | move past level | 20% | how far price ran past the level; 10% earns full marks |
  | held position | 15% | anything in `holdings.json`, since a trigger on something you own is a live decision |
  | staleness | 10% | days sitting unactioned; a tiebreaker, never a reason to act on its own |

  The per-signal breakdown is stored on the entry and shown in the listing,
  so the ranking explains itself rather than asserting a number.

Suggestions are only ever *proposed*. Nothing re-levels itself — `apply` is
the only thing that moves an alert, and it re-seeds the crossing baseline
against the new level so the alert doesn't immediately fire just because the
level moved.

### Seeding from a TradingView export

`alert seed` is a one-time migration of the two TradingView CSV exports into
this engine's store. It is deliberately not a general importer — see
`CLAUDE.md` for the three mutually incompatible TradingView CSV schemas.

```bash
node dist/cli.js alert seed \
  --list tradingview-alerts.csv \
  --log tradingview-alert-log.csv \
  --dry-run                          # print the plan without writing anything
```

Collapse rules, applied per ticker:

- Two alerts of the same type collapse to one — the highest level for an
  upside alert, the lowest for a downside one.
- A price alert and a volume alert combine into a single price-AND-volume
  alert, which the engine supports natively.
- A volume alert with no price alert on that ticker stays standalone.

Every surviving level is then checked against real bars. A level price has
already run past is replaced with the current resistance (same logic
`revisit relevel` uses); a level still ahead of price is kept as-is. Levels
wildly out of line with the real price are dropped as ticker collisions —
`PPL` is configured at both `37.14` and `231.55` because a foreign listing
shares the symbol, and the implausible ones are discarded rather than the
whole ticker.

`alerts.json` is always the source of truth for alert state, but `alert
check` also writes a `reports/alert_triggers_<timestamp>.csv` — same
`reports/` directory `analyze` uses, distinguished by filename prefix
(`alert_triggers_...` vs. `breakout_report_...`) so it's clear at a glance
which command produced which file. Since checks run far more often than
`analyze` (every 5-15 min vs. once or twice a day) and most find nothing,
this file is only written when something actually triggered — no empty
files piling up from routine checks.

### Confirming breakouts for this engine's own triggers

`analyze` isn't limited to a TradingView CSV — `--from-alerts [path]`
(default `revisits.json`) runs the identical breakout-confirmation pipeline
against this engine's own trigger events instead:

```bash
node dist/cli.js analyze --from-alerts
```

Exactly one of `--csv`/`--from-alerts` is required. It reads the **revisit
queue**, not the alert list: under the no-disarm model a live alert has no
single "it fired" moment to analyze, while each queue entry is exactly one
trigger event with the level and price it fired at. Records are keyed by
queue-entry id rather than alert id, so an alert that fires repeatedly over
its life produces a distinct `history/` record per trigger instead of
collapsing them all onto one.

This pulls in *every* entry on record, including resolved ones — there's no
notion yet of "already analyzed" or a time window for how soon after a
trigger a breakout can be confirmed, so re-running reprocesses the same
entries (harmless — `history/` upserts, so it refreshes rather than
duplicating). Volume-only entries are skipped (no price level to confirm a
breakout against); for trailing entries, the observed trigger price is used
as the level (`src/alerts/bridge.ts`).

`alert seed` is the only CSV bootstrap. An older `alert import` command was
removed: it read a third CSV schema, did no re-levelling against bars, no
price+volume combination, and no ticker-collision guard, and pointing it at
either current export silently produced zero alerts.

`alert check` polls Schwab's `/marketdata/v1/quotes` endpoint (already
covered by the Market Data Production access from SETUP.md — no streaming
API needed) and prints triggered alerts with a TradingView chart link to
pull up. Notifications go through a pluggable `Notifier`
(`src/alerts/notify.ts`) — only a console notifier exists today.

## Holdings (`src/holdings/`)

A separate, related subsystem that tracks actual positions — share count,
cost basis, and stops — entered manually (no Schwab Accounts API
involved; that's a different, unregistered product from the Market Data
access this tool already uses) and stored in `holdings.json` (gitignored,
same treatment as `alerts.json`):

```bash
node dist/cli.js holdings import --csv roth=webull_roth.csv --csv margin=webull_margin.csv [--dry-run]
node dist/cli.js holdings add-lot --symbol AAPL --count 100 --basis 150 [--date 2026-01-15]
node dist/cli.js holdings list [--symbol AAPL]
node dist/cli.js holdings stop add --symbol AAPL --price 140 [--count 50]
node dist/cli.js holdings stop list
node dist/cli.js holdings stop remove <id>
node dist/cli.js holdings check
```

### Covering positions that have no alert

```bash
node dist/cli.js holdings cover [--dry-run]
```

Creates a starting alert for every held position that doesn't already have a
live one, at **10% above the current price**:

```
  DEEPL  basis   4.45 · price   1.38 (-69.0% vs basis) → alert   1.52
  FLATA  basis 379.14 · price 365.25 ( -3.7% vs basis) → alert 401.78
  BIGWIN basis  12.97 · price  17.30 (+33.4% vs basis) → alert  19.03
```

Basis deliberately does **not** set this level. It was the obvious anchor at
first, but every case argues against it: for a position up 33%, basis+10% is
already in the past and would fire instantly; for one down 69%, basis+10% asks
the position to nearly triple before saying anything; and in between, price+10%
is above basis+10% anyway. One reference, one number — *tell me when this moves
10% up from here*. Basis still decides whether a position is interesting
elsewhere, via the above-basis and stagnant alerts.

Not volatility-scaled: a flat 10% is the whole rule. The level also always
lands clear of the live price, which matters because an alert *at* the live
price has no side to fire on and is rejected.

Run this **after** `alert seed`, or every position will look uncovered.
Symbols in `ignoreSymbols` are skipped.

### Importing from Webull

`holdings import` reads Webull's holdings export, one `--csv account=path` per
account. Like `alert seed` it is hard-coded to that shape rather than being a
general importer — Webull does not officially support this export, and the
2026-09-11 files proved it:

- **`Quantity` is not trustworthy.** Two positions in the real export stated 3
  and 9 shares, while `Market Value / Last Price` *and* `Total Cost / Avg Cost`
  independently both said 5 and 6. The import derives the count from the cost columns (the pair
  that defines the basis every holdings alert is computed against), uses market
  value as a cross-check, and only overrides when both agree — one bad cell
  can't silently rewrite a position. Every override is reported.
- **Rounding is not an error.** A 341-share position computes to 340.80 from a
  cent-rounded Last Price; that is tolerated rather than flagged.
- **Options are skipped.** The export truncates the contract symbol
  (`DPRO $5...`), so it couldn't be reconstructed even if options were modelled.
- **The same symbol can appear in two accounts.** A cash-parking ETF held in
  both is the real case; each
  becomes its own lot tagged with its account, and the import warns that basis
  and alerts blend across them.
- **There is no purchase date.** `--purchase-date` backdates the lots;
  otherwise it defaults to today and the "stagnant" alert stays silent for 30
  days. The import says so rather than leaving you to discover it.

Lots carry an optional `account` label. `computeBasis` deliberately still
blends across accounts — "am I up 10% on BIL" is a question about the position,
not about where it is custodied.

Multiple purchase lots per symbol blend into one weighted-average basis
for alerting purposes (individual lots are still kept for history and for
"days since last purchase"). A stop's `--count` defaults to `null`,
meaning "whatever I currently hold" — resolved dynamically each time
rather than frozen at creation, so it still reads as "all of it" after a
later purchase. Stops are record-keeping/context only right now — no live
"price crossed the stop" alert yet, though that would reuse the existing
static-alert engine if added later.

`holdings check` evaluates three conditions per position, each firing
once on the crossing (same semantics as static/trailing alerts — quiet
until the state changes) rather than repeating every check:

- **10% above basis** — consider adding more.
- **Stagnant** — 30+ days since the last purchase with under 2% profit.
  A fresh lot resets this immediately, since the day-count is always
  recomputed from the lots rather than tracked separately.
- **Every 3% of appreciation** — a suggestion to raise your stop. This one
  ratchets: it only fires on newly-reached territory, so a pullback into
  a band you've already been notified about doesn't re-fire.

Like `alert check`, this writes `reports/holdings_alerts_<timestamp>.csv`
(only when something fires) — a third distinct prefix alongside
`breakout_report_*` and `alert_triggers_*` in the same `reports/`
directory. None of these three conditions need 5-15-minute resolution the
way trailing/volume alerts do, so a coarser cron cadence (e.g. daily) is
reasonable here even if you run `alert check` much more often.

## Dashboard (`src/dashboard.ts`)

The three CSV writers above (`breakout_report_*`, `alert_triggers_*`,
`holdings_alerts_*`) are event logs: each covers one subsystem and is only
written when something fired. A periodic dashboard needs the opposite — one
document, emitted on a schedule, that's just as meaningful on a quiet day as
on a busy one.

```bash
node dist/cli.js dashboard                      # renders to the terminal and writes JSON
node dist/cli.js dashboard --quiet --out out.json
```

Writes `reports/dashboard_<timestamp>.json` (override with `--out`) and
prints the same content as a terminal view. Four sections:

1. **Revisit queue** — what needs a decision, priority-ranked, each row
   carrying its proposed level and the signal breakdown behind its score.
2. **Approaching** — *off by default*; pass `--approaching`. Live alerts
   within `--within-pct` (default 5%) of firing, sorted by distance, capped at
   `--limit` with the true total reported. The arrow carries the side, so a
   downside alert reads unambiguously (`WFC 90.48 ↓ 90.40` needs price to
   *fall*); a negative distance means the price condition is already met and
   the alert is only still live because a volume gate hasn't caught up.

   It defaults off because on a 500-alert book roughly a hundred names sit
   within a few percent of firing at any moment — that's a readout of market
   noise, not a list of things to do. The revisit queue says what actually
   happened, which is the part worth a glance.
3. **Summary** — live alerts, symbols covered, open vs. actionable queue
   entries, triggers in the last `--window-days` (default 7), positions held,
   and how many alerts had no quote this run.
4. **Stories** — tickers that have fired more than once, threaded into a
   narrative (below).
5. **Quiet** — names watched a long time that have never fired and have
   barely moved: alert slots you could spend elsewhere.
6. **Holdings** — each position against blended basis with current value.

### Browser dashboard (`web/`, `src/web/`)

The same document, rendered as a static site you can leave open in a tab:

```bash
node dist/cli.js dashboard --site site          # writes site/ (index.html, app.js, sw.js, dashboard.json)
cd site && python3 -m http.server 8000          # preview at http://localhost:8000
node dist/cli.js dashboard --publish --skip-unchanged --quiet   # sync to S3
```

The page is fixed; only `dashboard.json` changes between runs, and the page
re-fetches it every minute. It adds a `recentTriggers` list to the document
(every firing in the window, newest first, any status) because the revisit
queue is priority-sorted and capped, so it can't tell you what's *new*.

**Notifications.** When a trigger id appears that this browser hasn't seen, the
page shows an in-page toast and, if you've clicked *Enable notifications*, an
OS notification when the tab is in the background or the window is unfocused.
The tab title also gains a `(n)` count. What this can and can't do:

- Works while the tab is **open anywhere** (background tab, other window,
  minimized). Background tabs are throttled to about one poll a minute, which
  is the poll rate anyway.
- Does **not** work once the tab is closed. That needs Web Push (a service
  worker subscription plus the publisher sending VAPID-signed pushes); `sw.js`
  is the piece that would receive them, but nothing sends them yet.
- Needs HTTPS (or localhost). On iOS, only a home-screen web app can notify.
- The first visit on a browser marks everything already listed as seen, so it
  doesn't open with a week of backlog.

Revisit rows carry **copy-command buttons** (`alert revisit apply <id>`,
`dismiss <id>`). The site is static and can't write to your stores; this is the
zero-infrastructure bridge until it can.

**Views.** The header switches between **Overview** and **Alerts** (`#/alerts`).
Both are routes in the same page, so polling and notifications keep running on
either one.

- **Alerts** lists every live, checked alert from its own `alerts.json`, fetched
  only while that view is open, so the every-minute poll of `dashboard.json`
  stays small. Each row shows the condition in words, its level, the current
  price and distance from the level, how often it has fired, and when. You can
  search, filter by kind, and sort (symbol, closest to level, most triggered,
  recently fired, newest). A trailing trigger or moving average shows as
  "moving". Click a row for its details and recent triggers.
- **Trigger details** (`#/trigger/<id>`) open from any recent trigger, queue
  row, toast, or notification. They show:
  - when it fired, its status, and the alert's condition at that moment
  - price vs. level
  - for volume conditions, the volume it saw against what was required
  - the breakout verdict, volume signals, and priority breakdown
  - any suggested level, and a link to the alert

  The condition and observed volume are **recorded at trigger time**, so they
  stay true after the alert is edited or removed. Triggers recorded before that
  existed fall back to the alert's current settings, labelled as such, or say
  "not recorded" when the alert is gone. Older volume triggers have no
  observed-volume figure at all.

Recent triggers now also include open entries older than the window, so every
revisit-queue row has details to open.

**Holdings and login are both off by default**, and they go together. The site is
public, so `dashboard.json` is readable by anyone with the URL. With holdings off,
the holdings rows (share counts, basis, market value, stops) are removed from the
published JSON, not just hidden in the page. Headlines can still say a name is
held ("Holding MKS broke support"), which reveals nothing about size or value.
To turn both back on:

1. Redeploy the stack with `EnableBasicAuth=true BasicAuthUser=… BasicAuthPassword=…`.
2. Add `"web": { "holdings": true }` to `analysis.config.json`.

**Theme.** Dark by default, using the uniquetrades-congress palette (Catppuccin).
The header toggle remembers a light preference per browser.

**Publishing.** `cloudformation.yaml` creates a private S3 bucket, a
CloudFront distribution served at **https://watch.billbaran.us** (certificate and
DNS record in the public `billbaran.us` Route 53 zone), and a publish-only IAM
user. The first deploy waits on DNS validation of the certificate, which usually
takes a few minutes. Deploy it in `us-east-1`,
then copy the outputs into `.env` (`S3_BUCKET`, `AWS_REGION`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`):

```bash
aws cloudformation deploy --region us-east-1 --stack-name tv-alerts-dashboard \
  --template-file cloudformation.yaml --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides BucketName=tv-alerts-yourname
aws cloudformation describe-stacks --region us-east-1 --stack-name tv-alerts-dashboard --query 'Stacks[0].Outputs'
```

`--skip-unchanged` publishes only when something happened (a trigger, a status
change, a new suggestion, a holdings change) or when the published prices are
older than `--max-stale-minutes` (default 30). It decides *before* fetching
quotes, so a quiet run costs no API calls. Last-publish state lives in
`.cache/web_publish.json`. `scripts/check-and-publish.sh` pairs it with
`alert check` for cron:

```
*/2 * * * 1-5 /path/to/repo/scripts/check-and-publish.sh >> /path/to/repo/logs/cron.log 2>&1
```

### Narrative

Every queue row carries a `headline` — a plain-English sentence rather than a
row of numbers, because the target display is a small always-on dashboard
(a hacked Kindle), where "TGT broke resistance with volume" is readable at a
glance and `verdict=CONFIRMED_BREAKOUT vol=2.4x` is not:

```
 75.3  CTVA broke resistance with volume, now 6.2% above it
         fired 86 @ 88.4. Suggest moving 86 to 93.
 61.7  TGT broke resistance with volume, now 3.0% above it, in pre-market
 54.4  Holding MKS broke support, now 5.3% below it
  5.1  LUMN tagged its level intraday but closed back below
```

`stories` threads one ticker's repeated triggers together with the re-levels
between them, which is the shape a flat list of events hides — the chase that
made you re-arm the same name five times is the whole reason the queue exists:

```
CTVA has fired 3 times since Aug 20, walking its level from 82.1 up to 86,
with 1 still open.
  Aug 20: CTVA broke resistance with volume, now 1.1% above it.
  Aug 21: you raised the level 82.1 to 84.2.
  Aug 26: CTVA broke resistance with volume, now 1.5% above it.
  Aug 27: you raised the level 84.2 to 86.
  Sep 1:  CTVA broke resistance with volume, now 6.2% above it.
```

### Watch history

Every alert records `watchingSince` and `priceAtWatchStart` when it's created,
which lets the narrative answer a question the trigger itself can't — *was
this worth watching at all*:

```
 75.3  CTVA broke resistance with volume, now 6.2% above it
         fired 86 @ 88.4. Suggest moving 86 to 93.
         Up 22% since you started watching it, June 2026 or earlier.

QUIET (1 watched a long time, never fired)
  EMB: watching at least since 04/17/26 (148d), never fired, down only 1.8% since.
```

A name qualifies as *quiet* only when it has been watched 45+ days, has never
fired, **and** has moved less than 5%. Something that has moved but not crossed
its level is a working alert, not a dead one, so it stays out of the list.

Seeded alerts are backdated: TradingView's exports carry no creation date, so
`alert seed` uses the oldest trigger on record as a lower bound and marks it
approximate — the narrative then says "June 2026 **or earlier**" rather than
asserting a start date it doesn't have. The price at that date is recovered
from the daily bars the seed already fetches for re-levelling; when the date
predates that window the price is left null and the line states the date
without claiming a percentage.

These are **template-based, not model-generated** (`src/narrative.ts`), and
deliberately so: the lines describe money decisions, render unattended on a
device with no way to check them, and every claim is read straight off a
recorded verdict. That makes them reproducible, free, instant, and incapable
of inventing a fact. The phrasing is also load-bearing — "broke resistance"
is only used where the verdict supports it, and a `NO_CLOSE_CONFIRM` says
"tagged its level intraday but closed back below" instead.

Written for e-ink: short lines, no colour, no emoji, no box-drawing, nothing
that needs a monospace grid. A renderer can ignore the terminal view entirely
and read `headline` / `action` / `stories[].summary` straight out of the JSON.

JSON rather than CSV because it's a nested document with per-row signal
breakdowns meant to be fed to something, not opened in a spreadsheet. One
Schwab quote request covers every live alert and position; if that request
fails, the document still renders without live prices rather than failing
the run.

## Sector/profile cache (`src/profiles/`)

For sector analysis and custom heatmaps. Schwab's API has no sector,
industry, or company-description data at all (checked directly — neither
its quotes nor instruments endpoints carry it), so this comes from
[Financial Modeling Prep](https://site.financialmodelingprep.com/) instead
— a free-tier third-party source, not "official" the way Schwab is. It won
out over the alternatives: Alpha Vantage has the same data shape (sector,
industry, description in one call) but only 25 requests/day free, vs. FMP's
250/day; SEC EDGAR is free with no key and no real limit, but only exposes
an SIC code (an older, coarser classification than the GICS sectors most
heatmaps use) and no description text at all. See `SETUP.md` for signing up
and setting `FMP_API_KEY`.

```bash
node dist/cli.js profile fetch --all-known --csv TradingView_Alerts_Log.csv
node dist/cli.js profile list [--sector Technology]
node dist/cli.js profile show --symbol AAPL
```

`--all-known` pulls the ticker union from `history/`, `holdings.json`, and
`alerts.json` (plus any `--csv` paths given) — everything tracked so far,
without assuming a fixed directory like `alerts_in/` is ever scanned
automatically (it isn't; CSVs are always opt-in via `--csv`). Cached to
`.cache/profiles/<symbol>.json`, one file per symbol, no expiry (this data
barely changes) — `--refresh` forces a re-fetch. The 250/day free-tier cap
is tracked in `.cache/profiles/_budget.json` **across** invocations (a
single CLI run can't track a daily quota alone), so `profile fetch` is
resumable — hit the cap partway through populating ~200 tickers, and
re-running the next day only fetches what's still missing.

## Tests

```bash
npm test        # typechecks src/ and tests/, then runs vitest
npm run typecheck
```

`tsconfig.json` only compiles `src/`, so tests are typechecked separately via
`tsconfig.test.json` — without it, a field added to a model leaves stale test
fixtures that vitest happily transpiles and never complains about.

Real financial data stays out of git (`holdings.json`, `alerts.json`,
`revisits.json`, `webull_*.csv`). The holdings-import suite runs against
anonymized fixtures in `tests/fixtures/` that reproduce every structural quirk
of the real exports — a wrong `Quantity` in both directions, rounding noise, a
truncated option symbol, one symbol held in two accounts — so the suite runs
anywhere without shipping brokerage positions.

Analysis logic (`tests/analysis.test.ts`) is tested against fabricated
OHLCV sequences (clean breakout, failed breakout/fakeout, no-volume
crossing, mid-range crossing, etc.) so it doesn't require network access
or real credentials. The parser (`tests/parse.test.ts`) is tested against
real rows pulled from a TradingView export, including the mis-encoded
unit separator TradingView emits in its volume alerts (`"Volume Crossing
4.5\xc3\xa2\xc2\x80\xc2\xafM on ..."`) and comma-formatted price levels
(`"MKL Crossing 2,003.72"`).
