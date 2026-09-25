# The dashboard

Reference for the terminal `dashboard` command and the browser site built from the
same document. Editing, the queue behind it, and the security model are in
[ARCHITECTURE.md](ARCHITECTURE.md).

The three CSV writers this project also has (`breakout_report_*`,
`alert_triggers_*`, `holdings_alerts_*`) are event logs: each covers one subsystem
and is only written when something fired. A periodic dashboard needs the opposite —
one document, emitted on a schedule, that's just as meaningful on a quiet day as on
a busy one.

```bash
node dist/cli.js dashboard                        # terminal view + reports/dashboard_<timestamp>.json
node dist/cli.js dashboard --quiet --out out.json
node dist/cli.js dashboard --approaching --within-pct 3 --limit 40
```

Six sections, in the order they print:

1. **Summary** — live alerts, symbols covered, open vs. actionable queue entries,
   triggers in the last `--window-days` (default 7), positions held, and how many
   alerts had no quote this run.
2. **Revisit queue** — what needs a decision, priority-ranked, each row carrying its
   proposed level and the signal breakdown behind its score. Every open entry,
   unless `--limit` caps it: the site only publishes every 15 minutes or so, so a
   capped queue made anyone clearing it in one sitting stop and wait for the rest.
3. **Stories** — tickers that have fired more than once, threaded into a narrative
   (below).
4. **Approaching** — *off by default*; pass `--approaching`. Live alerts within
   `--within-pct` (default 5%) of firing, sorted by distance, capped at `--limit`
   (default 25) with the true total reported. The arrow carries the side, so a downside alert
   reads unambiguously (`WFC 90.48 ↓ 90.40` needs price to *fall*); a negative
   distance means the price condition is already met and the alert is only still
   live because a volume gate hasn't caught up.

   It defaults off *in the terminal* because on a 500-alert book roughly a hundred
   names sit within a few percent of firing at any moment — that's a readout of
   market noise, not a list of things to do. The revisit queue says what actually
   *happened*, which is the part worth a glance. The browser build always includes
   it and folds it away instead, which is the same bargain in a medium that can
   collapse a section.

   That is safe for `--skip-unchanged` only because `approaching` and
   `approachingTotal` are both in `VOLATILE_KEYS`: list *membership* moves with the
   quote, so without them a quote-less build and a real one would fingerprint
   differently and every run would publish.
5. **Quiet** — names watched a long time that have never fired and have barely
   moved: alert slots you could spend elsewhere.
6. **Holdings** — each position against blended basis with current value.

JSON rather than CSV because it's a nested document with per-row signal breakdowns
meant to be fed to something, not opened in a spreadsheet. One Schwab quote request
covers every live alert and position; if that request fails, the document still
renders without live prices rather than failing the run.

## Browser dashboard (`web/`, `src/web/`)

The same document, rendered as a static site you can leave open in a tab:

```bash
node dist/cli.js dashboard --site site          # writes site/ (index.html, app.js, sw.js, dashboard.json)
cd site && python3 -m http.server 8000          # preview at http://localhost:8000
node dist/cli.js dashboard --publish --skip-unchanged --quiet   # sync to S3 (implies --site site)
```

The page itself is fixed; only `dashboard.json` changes between runs, and the page
re-fetches it every minute. It adds a `recentTriggers` list to the document (every
firing in the window, newest first, any status) because the revisit queue is
priority-sorted and capped, so it can't tell you what's *new*. Open entries older
than the window are included too, so every queue row has details to open.

**Views.** The left rail (a top bar on a phone) switches between **Overview**, **Revisit queue** (`#/queue`),
**Stories** (`#/stories`), **Alerts** (`#/alerts`), and — once editing is unlocked —
**Holdings** (`#/holdings`). All are routes in the same page, so polling and
notifications keep running on any of them. Each view's count sits beside it in
the rail, so the rail doubles as the day's scoreboard.

**The queue strip** runs across the top of every view: each open revisit as one
cell (symbol, direction and level, a dot when held, `↩` when reversed), in the
queue view's order, each linking to its decision. It sticks while you scroll, so
any decision is one tap away. "N to decide" is `summary.openRevisits`, the same
number as the rail and the overview tile.

- **Overview** — the summary tiles, recent triggers, holdings (when published),
  approaching, and quiet watches. Recent triggers shows the last two trading days
  (by Eastern date, weekdays only, so Monday includes Friday) and folds the rest
  behind **Show N more**; the section count is still every fire.
- **Approaching** — live alerts closest to firing, collapsed behind a fold on the
  Overview. The arrow carries the side, so a downside alert reads unambiguously
  (`MSFT 420.00 ↓ 400.00` needs price to *fall*), and a negative distance means the
  price condition is already met and only a volume gate is holding it. Folded for
  the same reason it is off by default in the terminal: on a 500-alert book roughly
  a hundred names sit within a few percent of firing at any moment, which is a
  readout of market noise rather than a list of things to do.
- **Revisit queue** — open triggers by priority, and the one view built to be acted
  on. Each row has *Details*, *Chart*, and, once editing is unlocked, the whole
  decision: **Suggest level** (a `revisit.relevel` op, which fetches that symbol's
  bars and proposes a level and a priority for that one entry), **Apply → 61** once
  there is a suggestion (a `revisit.apply` op, which re-levels the alert and closes
  the entry), and **Dismiss** (a `revisit.dismiss` op, which closes the entry and
  leaves the alert alone).

  Under the level it says what the suggestion was read off — "Basis: 60d high" —
  because the number alone isn't something you can disagree with. When a fire can't
  have a suggestion it says why instead: a moving average's level *is* the average,
  and a downward fire would invert the alert (`relevel` only ever proposes levels
  above price).

  Only one of the three is offered at a time: while a change to an entry is queued
  the row shows its pending tag and no buttons, because a second decision would be
  made against a state that is about to change.
- **Stories** — each multi-trigger thread as a narrative.
- **Alerts** — every live alert, from its own `alerts.json`, fetched only while that
  view is open so the every-minute poll of `dashboard.json` stays small. Each row
  shows the condition in words, its level, the current price and distance, how often
  it has fired, and when. You can search, filter by kind, and sort (symbol, closest
  to level, most triggered, recently fired, newest). A trailing trigger or moving
  average shows as "moving". An A–Z rail appears under the symbol sort. Click a row
  for its details and recent triggers. The header row stays pinned under the queue
  strip as you scroll; the search box and the add form above it scroll away.

  ![The Alerts table with one row per kind: a static alert with an edit pending tag, a price-AND-volume alert, a standalone volume alert, a moving-average alert and a trailing alert, the last two showing a moving level](images/alerts-table.png)

  One row per kind, above: the static alert carries an **edit pending** tag, the
  moving-average and trailing rows show their level as **moving**, and the volume
  alert has no level or direction to show at all.
- **Holdings** — positions, lots, and stops, decrypted from `vault.json` in the
  browser. Only present once editing is unlocked. Each stop has *Edit* and
  *Remove*.

  A row carries an **alert pill** for every live alert on the symbol —
  `alert ↑ 55`, or `alert ↑ 55 · 1.5x` when it also has a volume condition. It
  is abbreviated on purpose: which way it fires, the level, and the volume, with
  the full sentence as the pill's tooltip. A `~` marks a level that moves on its
  own (a trailing trigger, a moving average), since that is the value as of the
  last check rather than a number anyone typed. Above and below alerts coexist on
  a symbol, so a row can carry more than one pill.

  Expanding a position puts the two decisions it asks for side by side: the
  **stop form on the left, the alert's edit form on the right**. A position with
  no live alert shows **Cover with an alert** (a `holdings.cover` op) in the
  alert column instead. Several positions can be expanded at once, and each keeps
  its own form — what you type in one survives opening another and the
  every-minute poll.

  Rows also carry what `holdings check` would say about them — `+10% over basis`,
  `stagnant` — worked out **in the browser** from the decrypted rows rather than
  published. Both conditions are basis-derived, so publishing them would mean
  sealing them; computing them client-side makes the privacy rule structural. The
  third condition `holdings check` reports, a 3% appreciation band being crossed, is
  deliberately absent: it depends on state in `holdings.json` that never leaves the
  machine, so the browser can't know whether a band has already been reported.
- **Trigger details** (`#/trigger/<id>`) open from any recent trigger, queue row,
  toast, or notification, in a drawer over the current view. They show when it
  fired, its status, the alert's condition at that moment, price vs. level, the
  volume it saw against what was required, the breakout verdict and priority
  breakdown, any suggested level, and a link to the alert.

**Editing.** With the ops stack deployed, everything the CLI does to a *single*
alert, queue entry, lot or stop can be done from the page: add, edit and remove
alerts of all four kinds; suggest a level for a queue entry, apply it, or dismiss
the entry; add, edit and remove lots and stops; remove a position; and cover an
uncovered position. Each change is queued and applied by the next scheduled
`ops pull` — see
[ARCHITECTURE.md](ARCHITECTURE.md#queueing-a-change-lambda--sqs--ops-pull).

The **New alert** form takes a kind: a price level, a trailing distance from a
high/low, or a moving average, with a volume condition optionally AND-ed onto any
of them. It shows only the fields that kind needs, and for a moving average only
the one of *Direction* / *Approached* that the trigger uses — a cross watches a
direction, a touch watches which side price came from. A moving average's edit form
is prefilled from the published alert, so opening it to read the spec and saving is
"Nothing changed." rather than a silent rewrite.

What stays CLI-only is the batch and file work: `alert seed`, `holdings import`,
`alert migrate-directions`, and `profile fetch`. Those are one-time, read files that
live on the machine, or touch every row at once.

**Notifications.** When a trigger id appears that this browser hasn't seen, the page
shows an in-page toast and, if you've clicked *Enable notifications*, an OS
notification when the tab is in the background or the window is unfocused. The tab
title also gains a `(n)` count.

- Works while the tab is **open anywhere** (background tab, other window,
  minimized). Background tabs are throttled to about one poll a minute, which is the
  poll rate anyway.
- Does **not** work once the tab is closed. That needs Web Push (a service-worker
  subscription plus the publisher sending VAPID-signed pushes); `sw.js` is the piece
  that would receive them, but nothing sends them yet.
- Needs HTTPS (or localhost). On iOS, only a home-screen web app can notify.
- The first visit on a browser marks everything already listed as seen, so it
  doesn't open with a week of backlog.

**Holdings and login are both off by default**, and they go together: with
holdings off, share counts, basis, market value, and stops are removed from the
published JSON (why and how:
[ARCHITECTURE.md](ARCHITECTURE.md#holdings-are-encrypted-in-the-browser-not-hidden-by-the-page)).
To turn both back on:

1. Redeploy the stack with `EnableBasicAuth=true BasicAuthUser=… BasicAuthPassword=…`.
2. Add `"web": { "holdings": true }` to `analysis.config.json`.

**Company names.** Rows and drawers show the company name and sector next to the
ticker, from the FMP profile cache (`profiles` on the document). Until 2026-09-21
only the `exchange` on those cached profiles was ever read, so every ticker on the
page was a bare symbol. A symbol with no cached profile still renders as the ticker
alone — run `profile fetch --all-known` to fill the gaps. None of it is
position-derived, so it publishes on the public page like any other alert field.

**Theme.** Dark by default; the Light/Dark button remembers a preference per
browser. Every colour on the page is mixed from three: background, text and
accent (`--p-ground`, `--p-ink`, `--p-signal`), and light mode swaps the first two.
The swatch button in the lower left (`web/palette.js`) picks from presets or any
three colours, remembered per browser; the default is `data-palette` on `<html>`
in `web/index.html`. The accent is spent only on what wants attention: the queue
count and strip, a fresh trigger, a pending change, a warning.

**Publishing.** Deploying the S3/CloudFront stack and copying its outputs into `.env`
is in the [README](../README.md#deploying-the-dashboard-optional).

`--skip-unchanged` publishes only when something happened (a trigger, a status
change, a new suggestion, a holdings change, a new op result) or when the published
prices are older than `--max-stale-minutes` (default 30). It decides *before*
fetching quotes, so a quiet run costs no API calls. Last-publish state lives in
`.cache/web_publish.json`.

`scripts/check-and-publish.ps1` (Windows Task Scheduler) and
`scripts/check-and-publish.sh` (cron/WSL) pair this with the check;
[`SCHEDULING.md`](SCHEDULING.md) has the setup and the reasoning. For cron under WSL:

```
*/2 * * * 1-5 /path/to/repo/scripts/check-and-publish.sh >> /path/to/repo/logs/cron.log 2>&1
```

## Narrative

Every queue row carries a `headline` — a plain-English sentence rather than a row of
numbers, because the target display is a small always-on dashboard (a hacked
Kindle), where "TGT crossed above 110 and closed above it on volume" is readable at
a glance and `verdict=CONFIRMED_BREAKOUT vol=2.4x` is not:

```
 75.3  CTVA crossed above 86 and closed above it on volume, now 6.2% above it
         fired 86 @ 88.4. Suggest moving 86 to 93.
 61.7  TGT crossed above 110 and closed above it on volume, in pre-market, now 3.0% above it
 54.4  Holding MKS crossed above 42, then fell back below it the same day
  5.1  LUMN crossed above 3.5 intraday but closed back below
```

Headlines never say "support" or "resistance". Those words mean a level the market
has tested repeatedly, and an alert level is only a number you picked. A reversal (a
crossing back within the window) is stated on the fire it undoes, with its timing.
With 3 or more crossings, it's summarized as a count instead ("crossing it 4 times
in all, ending above it").

`stories` threads one ticker's repeated triggers together with the re-levels between
them, which is the shape a flat list of events hides — the chase that made you
re-arm the same name five times is the whole reason the queue exists:

```
CTVA has fired 3 times since Aug 20, walking its level from 82.1 up to 86,
with 1 still open.
  Aug 20: CTVA crossed above 82.1 and closed above it on volume, now 1.1% above it.
  Aug 21: you raised the level 82.1 to 84.2.
  Aug 26: CTVA crossed above 84.2 and closed above it on volume, now 1.5% above it.
  Aug 27: you raised the level 84.2 to 86.
  Sep 1:  CTVA crossed above 86 and closed above it on volume, now 6.2% above it.
```

These are **template-based, not model-generated** (`src/narrative.ts`), and
deliberately so: the lines describe money decisions, render unattended on a device
with no way to check them, and every claim is read straight off a recorded verdict.
That makes them reproducible, free, instant, and incapable of inventing a fact. The
phrasing is also load-bearing. "Closed above it on volume" is only used where the
verdict supports it. Nothing claims a level "held", because no verdict records that.
A `NO_CLOSE_CONFIRM` says "crossed above 3.5 intraday but closed back below" instead.

Written for e-ink: short lines, no colour, no emoji, no box-drawing, nothing that
needs a monospace grid. A renderer can ignore the terminal view entirely and read
`headline` / `action` / `stories[].summary` straight out of the JSON.

## Watch history

Every alert records `watchingSince` and `priceAtWatchStart` when it's created, which
lets the narrative answer a question the trigger itself can't — *was this worth
watching at all*:

```
 75.3  CTVA crossed above 86 and closed above it on volume, now 6.2% above it
         fired 86 @ 88.4. Suggest moving 86 to 93.
         Up 22% since you started watching it, June 2026 or earlier.

QUIET (1 watched a long time, never fired)
  EMB: watching at least since 04/17/26 (148d), never fired, down only 1.8% since.
```

A name qualifies as *quiet* only when it has been watched **45+ days**, has never
fired, **and** has moved less than **5%**. Something that has moved but not crossed
its level is a working alert, not a dead one, so it stays out of the list.

Seeded alerts are backdated: TradingView's exports carry no creation date, so `alert
seed` uses the oldest trigger on record as a lower bound and marks it approximate —
the narrative then says "June 2026 **or earlier**" rather than asserting a start date
it doesn't have. The price at that date is recovered from the daily bars the seed
already fetches for re-levelling; when the date predates that window the price is
left null and the line states the date without claiming a percentage.
