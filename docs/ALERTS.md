# Alerts and the revisit queue

The reference for `alerts.json` and `revisits.json`. For the loop these sit in, see
the [README](../README.md#how-it-works).

`alerts.json` (gitignored, one flat file) is the source of truth. This exists
partly because TradingView has no API to read your pending alerts back out, and a
flat local file does.

## The four kinds

**Static** — fire when price crosses a fixed level in the watched direction.
Upward crossings are the default:

```bash
node dist/cli.js alert add GMED 80.5                       # shorthand for --symbol GMED --level 80.5
node dist/cli.js alert add --symbol AAPL --level 150 --direction down
node dist/cli.js alert add --symbol AAPL --level 150 --direction either
```

**Trailing** — track a running low/high since the alert was created, and fire on a
bounce or pullback of a given percent or dollar amount from that extreme. Like a
trailing-stop-buy, as a notification instead of a trade:

```bash
node dist/cli.js alert add --symbol AAPL --near 150 --trail-percent 3
node dist/cli.js alert add --symbol AAPL --near 150 --trail-amount 2.50
```

**Volume** — fire when volume reaches a threshold, as either an absolute share
count or a multiple of typical volume. Standalone, or AND-ed onto a static or
trailing alert so both conditions must hold:

```bash
node dist/cli.js alert add --symbol AAPL --volume-at-least 2.5M           # standalone
node dist/cli.js alert add --symbol AAPL --level 150 --volume-ratio 1.5   # AND'd
node dist/cli.js alert add --symbol AAPL --volume-ratio 1.5 --volume-period 30m
```

By default this measures cumulative volume so far in the current session.
`--volume-period Nunit` (`s`/`m`/`h`/`d`) sums a trailing window instead,
recomputed fresh every check regardless of your poll cadence. Sub-minute periods
round up to a minute — Schwab's REST history goes no finer without the separate
streaming API. **A window in `s`/`m`/`h` longer than 10 days is refused**: those
are measured from 1-minute bars and only ten trailing days of those exist. Give it
in days (`14d`), which reads from daily bars over a date range and has no such
ceiling.

**Moving average** — see [its own section](#moving-average-alerts).

## Absolute thresholds vs. ratios

An absolute threshold is what TradingView exports and what you type directly, but
it rots silently. The imported `Volume Crossing 55 K on MTD, 1W` was 22x too low by
the time it arrived and fired on **82 of 82 sessions** — it had stopped meaning
anything and nothing said so.

`--volume-ratio 1.5` means "1.5x typical volume for this window", recomputed each
check against a trailing baseline, so it can't drift out of range as liquidity
changes. "Typical" is computed differently per window, because the naive version is
wrong in a different way each time:

| window | baseline |
|---|---|
| `today` | average **full-day** volume over the last 20 sessions |
| `7d` (any day count) | average of rolling **7-calendar-day sums**, *not* `avgDaily × 7` — a 7-day window holds ~5 trading days, so multiplying overstates by ~40% |
| `1h` / `30m` | average volume in **that same clock window** across recent sessions |

The intraday case matters more than it sounds. On MSFT the hour into the close
carries ~2.2M shares against ~0.9M in the early afternoon — a flat hourly average
would make every close look like a 1.7x spike and every lunch hour look dead.

One consequence of `today`: your own figure is partial, so the ratio climbs through
the session. `--volume-ratio 1.5` there reads as *"today is already a 1.5x-volume
day"* — a strong signal, but one that rarely trips before midday.

Baselines cache to `.cache/volume-baseline/<symbol>_<window>.json`, keyed to the
market date so they refresh once per trading day. A baseline that **can't** be
computed (no history, or a sub-day window evaluated outside market hours) leaves
the condition **unsatisfied** rather than treating any volume as qualifying.

Share counts accept `K`/`M`/`B` shorthand (`2.5M`) everywhere — CLI and browser
form alike. Ratios never do: "1.5M x normal volume" is meaningless, and the two
modes reject bad input with their own messages.

## Sides, directions, and the one-per-symbol rule

For static and trailing alerts, whether it's an "above" or "below" alert is
*inferred* by comparing `--level`/`--near` to the live price at the moment you add
it. You don't choose it, and **for a static alert the side is not the direction**:
a level below the price with the default `--direction up` fires only when price
drops under it and then comes back up through it.

Only one live alert watches a given symbol+side, so adding another replaces it
(regardless of kind). How that conflict is settled depends on who is adding:

- **`alert add` and the dashboard's add always replace** — you typed the level you
  want, so `alert add EIPI 25` cancels the alert at 28 rather than making you remove
  it first. Both the CLI and the page name the condition being cancelled, since it
  may be the *nearer* of the two.
- **`alert seed` and `holdings cover` keep whichever is closer to the live price**,
  rejecting a farther candidate, so a bulk re-level of hundreds of rows can't talk
  an existing alert outwards.

Above and below coexist independently, so you can watch both sides of a symbol at
once. Standalone volume alerts sit outside this rule entirely — there is no natural
"side" to dedup on — and just coexist freely.

For a static alert combined with a volume condition, a price crossing that happens
before volume catches up isn't lost: it stays "pending" (re-checked every poll)
until either volume qualifies or price fully reverts to where it started, whichever
comes first.

When an alert fires, its `triggerSnapshot` captures every attribute (level, trail
settings, `extremePrice`, and so on) exactly as they were at that moment,
independent of the live record — so a later edit can't retroactively change what
the alert looked like when it actually triggered. It holds the *most recent*
trigger; the full history lives in the revisit queue.

## Editing and removing

```bash
node dist/cli.js alert list [--all]          # live only by default
node dist/cli.js alert edit MELI 1960        # shorthand for --level 1960
node dist/cli.js alert edit <id> --direction either --volume-ratio 2
node dist/cli.js alert edit <id> --clear-volume
node dist/cli.js alert remove <id>
```

`alert edit` keeps the alert's id, watch start, and trigger history. Only a moved
`--level` needs a live quote (to re-seed the side and the crossing baseline). It
converts kinds in place: giving a volume alert a level makes it static with the
volume as its AND condition, and `--clear-level` turns a static-with-volume alert
back into a volume-only one. Changing between static, trailing, and moving average
is not an edit — remove it and add a new one.

**Every edit closes that alert's open revisit entries**, wherever it is made,
marking them `applied` and recording the level move.

## Moving-average alerts

Fire when price **crosses** a simple or exponential moving average, or **touches**
it within a small margin, on 1/2/5/15-minute, daily, or weekly bars:

```bash
node dist/cli.js alert add --symbol AAPL --ma sma200@1W                   # any cross of the 200-week SMA
node dist/cli.js alert add --symbol AAPL --ma sma20@1D --direction up     # only upward crosses of the 20-day
node dist/cli.js alert add --symbol AAPL --ma ema9@5m --touch             # within 0.25% of the 9-bar EMA on 5-minute bars
node dist/cli.js alert add --symbol AAPL --ma sma9@1D --touch 0.5 --from above
```

`--ma` takes `sma|ema`, a period (1–200), `@`, and a timeframe
(`1m 2m 5m 15m 1D 1W`).

- **The level moves with the average.** Nothing to re-level: `revisit relevel`
  proposes no new level for these, and `apply` doesn't apply to them. The queue row
  says so in place of a level ("No new level — moving-average alert: its level moves
  with the average"), rather than leaving you wondering why there's no Apply.
- **Completed bars only.** The average in force at any moment is taken over bars
  that had already closed, so a daily or weekly average holds still all day and an
  intraday one steps once per bar. That's what a chart shows for any bar but the one
  still forming.
- **Independent of poll timing.** Each check replays the 1-minute bars since the
  last check, plus the live quote — not just the price at poll time. A cross that
  reversed between polls still fires, and a 9-bar average on 1-minute bars works
  under a 2-minute poll.
- **Cross vs. touch.** A cross is judged on closes, so a wick through and back is a
  touch, not a cross. A touch uses each bar's full high–low range.
- **Re-firing.** At most once per MA bar (TradingView's "once per bar"). A touch
  also has to move away by twice the margin before it can fire again.
- **First check seeds.** A new alert records which side price is on at its first
  check and can fire from the next one, so adding one never fires immediately.
- **Not enough history means no level.** A 200-week SMA on a three-year-old listing
  is skipped with a warning rather than averaged over what exists.
- **EMAs get 4× their period of history** to converge (up to ~15 years of daily bars
  for a 200-week EMA, in one request). Intraday EMAs are limited to Schwab's 10
  trading days of minute bars, so long ones may differ slightly from a chart with
  more history.
- **Regular-session minute bars.** In pre/post market only the live quote moves the
  path.

Cost: one 1-minute-bar request per symbol per check (shared by all that symbol's
averages), plus one daily-history request per symbol per day, cached in
`.cache/ma-daily/`. With many symbols on a short poll, the 120 requests/minute
throttle will stretch a check out rather than fail.

Each trigger lands in the revisit queue like any other, with the average's value as
`levelAtTrigger`. An intraday average on a choppy name can fire often; that's worth
watching before adding many.

## Market hours

`alert check` asks Schwab for the day's equity hours before spending a single quote
request, and exits without polling when the market is closed:

```
Skipped: market closed (no further session today). No quotes fetched.
```

Hours come from `/marketdata/v1/markets` rather than a hardcoded 09:30–16:00,
because the real calendar has holidays and half days — the day after Thanksgiving
2026 closes at 13:00 with a post-market ending 17:00, and a constant would poll a
closed market for three hours and miss the shortened post-market entirely. They
cache permanently to `.cache/hours/<date>.json` (a published day's hours never
change), so a 15-minute poller doesn't spend a request per check just to ask
whether the market is open.

Pre- and post-market are polled by default. A trigger records **which session it
fired in**, because a pre-market break on thin volume and a wide spread is not the
same event as the identical break at midday — the dashboard says `in pre-market` on
those rows rather than flattening them together.

- `--regular-only` — poll only 09:30–16:00.
- `--ignore-hours` — poll regardless, for testing.

A market-hours lookup failure logs and falls through to checking anyway, rather
than taking the poller down over a calendar request.

Note that **`ops pull` has no market-hours gate.** A queued edit lands at the next
scheduled run whether or not the market is open. What the schedule *does* mean is
that edits made after the daily window closes sit until the next morning.

## Alerts never disarm

Unlike TradingView, a triggered alert here does not stop watching. There is no
"armed" state to get back to and nothing to remember to re-arm — the only non-live
state is `cancelled`, which only ever happens because you removed the alert or a
closer one superseded it.

Every trigger appends an entry to the revisit queue (`revisits.json`): "this level
got taken out, decide what to do".

Re-firing is still self-limiting, so a live alert doesn't spam you:

- **Static** — after firing, every crossing of the same level over the next
  `holdDays` trading days (default 2, counting the fire's own day as day 0) is
  folded onto that fire as a follow-up instead of queuing a new entry. The first
  crossing back is the **reversal** ("crossed above 50, fell back below it the same
  day"), and the dashboard shows it on the original trigger. After the window, a
  crossing in the watched direction fires again, and a crossing the other way
  records nothing — "it is below the alert now" is explicitly not news. Weekends are
  skipped, but holidays aren't known, so a holiday stretches the window by a day.
- **Trailing** — `extremePrice` resets to the trigger price, so it starts trailing
  afresh from there.
- **Volume** — a volume threshold, once crossed, stays crossed, so these set a
  `mutedUntil` for the rest of the day (or the rest of the period window) rather
  than firing on every poll.
- **Moving average** — at most once per MA bar, as above.

Stores written before directions existed are upgraded once with
`node dist/cli.js alert migrate-directions`. It backs both files up to
`.cache/backups/` first, sets every static alert to `up`, and folds old
back-and-forth queue entries onto the fire they followed. Safe to re-run.

## The revisit queue

```bash
node dist/cli.js alert revisit list [--status open|applied|dismissed|all] [--limit N]
node dist/cli.js alert revisit relevel      # fetch bars, propose levels, score the queue
node dist/cli.js alert revisit apply <id>   # move the alert to the proposed level
node dist/cli.js alert revisit dismiss <id> # close the entry, leave the alert alone
```

`relevel` is the pass that makes the queue useful, and it is **not** part of the
scheduled run — until you ask for it, an entry has no suggested level and no
priority score. Asking can be this command, over the whole queue, or the
**Suggest level** button on a single row of the browser dashboard, which queues a
`revisit.relevel` op for that one entry. Both run the same `relevelEntry`, so they
propose the same level for the same bars.

For each open entry it pulls daily bars and:

- **proposes a new level** if price has pushed past the old one — the highest high
  over `recentHighLookbackDays` if there's resistance overhead, or that high plus
  one `recentHighTolerance` width if the stock is in new-high territory with nothing
  above it. If price fell back *below* the level, no suggestion is made: the
  original level is still a perfectly good target and re-levelling would throw it
  away.
- **scores the entry 0–100** by blending five signals, each saturating so no single
  one can run away with the ranking:

  | signal | weight | |
  |---|---|---|
  | breakout verdict | 30% | `CONFIRMED_BREAKOUT` > `WATCH` > `WATCH_WEAK` > `NO`, straight from `analyze` |
  | rising volume | 25% | breakout-day ratio blended with the volume trend into it — applied whether or not the alert itself had a volume condition |
  | move past level | 20% | how far price ran past the level; 10% earns full marks |
  | held position | 15% | anything in `holdings.json`, since a trigger on something you own is a live decision |
  | staleness | 10% | days sitting unactioned; a tiebreaker, never a reason to act on its own |

  The per-signal breakdown is stored on the entry and shown in the listing, so the
  ranking explains itself rather than asserting a number.

Suggestions are only ever *proposed*. **Nothing re-levels itself** — `apply` is the
only thing that moves an alert, and it re-seeds the crossing baseline against the
new level so the alert doesn't immediately fire just because the level moved.
`--level` takes a number of your own instead of the suggestion, which is what the
dashboard's Apply sends when you edit the level before taking it.

Applying is refused on an entry that is already closed, on a later crossing folded
onto an earlier fire (apply that fire instead), and on anything but a static alert —
a trailing alert's level and a moving average's are recomputed on every check, so
there is nothing to re-point.

Entries carry the alert's **condition and observed volume as recorded at trigger
time**, so they stay true after the alert is edited or removed. Entries written
before 2026-09-13 lack them and the information is gone; the dashboard falls back
to the alert's *current* settings and says so rather than presenting them as what
the alert was when it fired.

## Seeding from a TradingView export

`alert seed` is a one-time migration of the two TradingView CSV exports into this
engine's store. It is deliberately not a general importer — see `CLAUDE.md` for the
three mutually incompatible TradingView CSV schemas.

```bash
node dist/cli.js alert seed \
  --list tradingview-alerts.csv \
  --log tradingview-alert-log.csv \
  --dry-run                          # print the plan without writing anything
```

Collapse rules, applied per ticker:

- Two alerts of the same type collapse to one — the highest level for an upside
  alert, the lowest for a downside one.
- A price alert and a volume alert combine into a single price-AND-volume alert,
  which the engine supports natively.
- A volume alert with no price alert on that ticker stays standalone.

Every surviving level is then checked against real bars. A level price has already
run past is replaced with the current resistance (the same logic `revisit relevel`
uses); a level still ahead of price is kept as-is. Levels wildly out of line with
the real price are dropped as ticker collisions — `PPL` is configured at both
`37.14` and `231.55` because a foreign listing shares the symbol, and the
implausible ones are discarded rather than the whole ticker.

`alert check` also writes `reports/alert_triggers_<timestamp>.csv` — the same
`reports/` directory `analyze` uses, distinguished by filename prefix. Since checks
run far more often than `analyze` and most find nothing, this file is written **only
when something actually triggered**, so routine checks don't pile up empty files.
