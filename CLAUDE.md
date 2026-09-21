# Notes for agents working in this project

Common mistakes and surprises. Add to this whenever something in the
project catches you off guard.

## Where things live, and what must stay in the root

Tidied 2026-09-21: `SETUP.md`, `SCHEDULING.md` and `USER_CHANGE_EVENTS_PLAN.md`
moved to `docs/`, and `cloudformation.yaml` to `infra/`. If you move anything
else, note that `tests/lambdaContract.test.ts` reads the template by path and
`README.md`'s deploy command names it by path too.

Three things in the root are **not** clutter and must not be moved:

- **`analysis.config.json`** is the default `--config` path in `src/cli.ts`,
  it is committed, and `docs/SCHEDULING.md` tells you a fresh clone already
  has it. Moving it breaks the scheduled task and every existing install.
- **The gitignored state files** — `alerts.json`, `revisits.json`,
  `holdings.json`, `ops.log.jsonl`, `webull_*.csv`, `tradingview-*.csv` — are
  the CLI's default paths. The scheduled task runs with the repo as its
  working directory and passes no `--*-file` flags.
- **`web/` stays outside `src/`** for the reason in the dashboard section:
  `tsc` doesn't copy non-TS files, and `../../web/` resolves correctly from
  both `src/web/site.ts` (tsx) and `dist/web/site.js`.

## There are THREE different TradingView CSV schemas, and they are not interchangeable

`src/parse.ts` (`parseAlerts`) understands exactly one of them. The other
two produce **zero `Alert` records with no error** — `parseAlerts` reads
`row["Ticker"]` and `row["Time"]`, and when those column names are absent
every row hits a bare `continue`. Downstream this surfaces as a cheerful
"No numeric price-level alerts found to import" or an empty report, not as
a failure. Do not assume a file is empty or unsupported because a command
reported nothing.

| File | Columns | `parseAlerts` |
|---|---|---|
| `tests/fixtures/sample_alerts.csv` | `Alert ID, Ticker, Name, Description, Time, Webhook status` | works |
| `tradingview-alert-log.csv` | `Symbol, Alert Date, Alert Time, Description` | **0 rows** |
| `tradingview-alerts.csv` | `Symbol, Description, Status, Last Triggered` | **0 rows** |

Differences that matter beyond the column names:

- **No `Alert ID`** in the newer exports. `history.ts` upserts by alert id,
  so anything importing these needs a synthesized stable key (symbol +
  level + timestamp) or it will duplicate across runs.
- **Split date/time** (`Alert Date` + `Alert Time`) in **Mountain time**
  (`America/Denver`, the TradingView account's display zone), versus a single
  ISO-8601 UTC `Time` column in the older export. This note used to say "local
  exchange time", and `seed.ts` used to parse these as UTC. Both were wrong. See
  "Three time zones" below for the evidence.
- **No exchange prefix** on `Symbol` (`AAPL`, not `BATS:AAPL`), though the
  `SYMBOL, TIMEFRAME` form (`"CDRE, 1D"`) still appears. `splitTicker`'s
  regex already tolerates both.
- `tradingview-alerts.csv` is a **different kind of thing entirely**: it is
  the list of *configured, still-pending* alerts (alert state), not a log
  of alerts that fired (alert events). Every model in this project assumes
  events. `Last Triggered` is blank for alerts that have never fired, and
  is formatted `Mon 27 Jul '26 07:30:12` — not ISO.

## Three time zones, never interchangeable

`src/timezone.ts` explains the rule. In short:

- **Market logic uses `America/New_York` explicitly:** trading dates, session
  checks, intraday bar buckets, time-of-day volume baselines, the end of a
  "today" window. Never UTC dates (`toISOString().slice(0, 10)`) and never the
  machine's zone. UTC midnight falls during after-hours trading (19:00 or 20:00
  Eastern), and a UTC clock time shifts by an hour at every DST change.
- **TradingView exports are in `America/Denver`** (`TRADINGVIEW_EXPORT_TIME_ZONE`
  in `seed.ts`). Verified 2026-09-13: half the alert log sits in the 07:00 hour,
  59 rows at exactly 7:30 (the 9:30 Eastern open), and Schwab minute bars show
  the logged crossings at 13:30 UTC, with no bars at all at 07:30 UTC.
- **The machine's zone** (Mountain with DST, both in WSL and on Windows) is only
  for what a person reads locally: terminal output, report file names, "today"
  as a default input.

Daily bars are stamped at the **start** of the trading day (Eastern midnight),
so compare them to an intraday instant by trading date, not by timestamp.
`closeOnOrAfter` compared timestamps and returned the next day's close for any
intraday time.

## The CLI must actually run on Windows, where a silent no-op looks like success

`src/cli.ts` only runs its program when `isEntryPoint(import.meta.url)` is
true. It used to compare `import.meta.url === \`file://${process.argv[1]}\``,
which **never matches under Windows Node**: argv[1] is `C:\...\cli.js`, and
the URL is `file:///C:/.../cli.js`. Every command, `--help` included, exited 0
having printed and done nothing. A scheduled task would have reported success
every 15 minutes while checking no alerts. The same comparison also failed
when the CLI ran through a symlinked directory. `src/entrypoint.ts` compares
real paths. Don't simplify it back to a string compare.

When verifying anything on Windows, check for **output**, not just exit code 0.

## Nothing rebuilds `dist/` for you, and a stale one publishes a partial document

`check-and-publish.ps1` builds only when `dist\cli.js` is **missing** (its header
says to run `npm run build` yourself after new code), and the scheduled task runs
`dist\`, not `src\`. So a source change that `npm test` proves correct — tests run
through vitest/tsx off `src/` — still publishes the *old* document until someone
compiles.

The failure mode is quiet and looks like data loss rather than a stale build. When
`accounts` was added to `HoldingRow` (2026-09-19), the page rendered every position's
account as `—`, exactly as it would if the labels had never been set; all 42 lots had
them. The page can't tell a field the publisher never wrote from one that is genuinely
empty, and it shouldn't — its fallback for documents published before a field existed
is the same code path.

After changing anything under `src/` that the page reads: `npm run build`, then let
the next check publish (a new stable field changes the fingerprint, so
`--skip-unchanged` does not suppress it). When a field arrives empty, check
`dist/` for it before suspecting the data.

## `classifyDescription` handles shapes the old regexes dropped

It originally missed four rows out of 671, all now handled — but the reasons
are worth knowing before you touch those regexes:

- `ACI Crossing Up 14.10` / `CHEF Crossing Down 91.00` — the directional
  variants. These carry a stated direction, which is strictly better than the
  side-inference-from-live-price `addAlert` otherwise does, so the
  `direction` field should be preferred wherever it is set.
- `UNP Crossing 277.50 AND Volume Crossing 3 M on UNP, 1D` — a compound
  price-AND-volume alert. `VOLUME_CROSS_RE` is `^Volume`-anchored so it
  misses, and the plain price regex is end-anchored while this ends with the
  chart's `on UNP, 1D` suffix. **The compound check must stay ordered before
  the plain price check.** It classifies as `price_cross` (not a new type) so
  the breakout pipeline still judges it, with the volume half exposed
  separately as `andVolume`.
- `AGNC, 1D Exiting rectangle` — a drawing/pattern alert, now its own
  `pattern` type rather than falling through to `other`.

## Volumes are numbers everywhere; "2.5M" is only an edge

`src/volume.ts` is the one algorithm, used on input (`parseVolume`) and output
(`formatVolume`). Nothing in a store, an op's params, or a document holds a
suffixed string: the engine compares and divides these numbers (`observed >=
required`, the observed ratio on a trigger), so a stored `"2.5M"` would have to
be re-parsed at each of those sites. The only persisted formatted volume is
`RevisitEntry.condition`, which is a recorded sentence, not a number.

Three things that bite:

- **`formatVolume` is lossy and `volumeInputValue` is not.** Display rounds to
  two decimals (1,234,567 reads "1.23M"). A form field must be prefilled with
  `volumeInputValue`, which only uses a suffix when it is exact and falls back
  to the plain integer — otherwise opening an alert's edit form and saving it
  untouched would silently rewrite 1,234,567 as 1,230,000. The round-trip is
  asserted in `tests/volume.test.ts`.
- **`web/app.js` carries a hand-copy of all three functions.** The page is
  served as plain files with no bundler, so it cannot import `src/volume.ts`,
  and it must accept and render exactly what the worker does. `tests/volume.test.ts`
  evaluates the block out of `app.js` and diffs both against a table of cases —
  the same trick the vault key prefix uses. Change one, change the other.
  It replaced `Intl` compact notation, which was locale-dependent ("2.5 k" in
  some locales) and so could never match the worker's rendering anyway.
- **The suffix is for share counts only, never a ratio.** "1.5M x normal
  volume" is meaningless, so the edit form parses by mode and the two modes have
  their own rejection messages. The amount field is a **text** input for the
  same reason: an `<input type="number">` reports `""` for "2.5M", which would
  swallow the shorthand silently.

`describeVolumeCondition` now says "volume >= 2.5M shares today" where it used
to say "volume >= 2500000 today". That function is `expect.condition`, the
queued-edit conflict guard, so every edit queued before that deploy was rejected
once — expected, per the ops section below.

`src/parse.ts` has its own K/M/B handling for TradingView descriptions, and
deliberately keeps it: those units are captured mid-regex as part of much larger
description patterns (`VOLUME_CROSS_RE`, `COMPOUND_PRICE_VOLUME_RE`) that
classify 671 rows, not parsed from a standalone field. `src/alerts/report.ts`
also stays numeric — it writes a CSV for a spreadsheet, not a sentence.

## Alerts never disarm — `status` is only `live` or `cancelled`

There is no "armed" or "triggered" status any more. A trigger appends to the
revisit queue (`revisits.json`) and the alert keeps watching. Two things
follow that are easy to get wrong:

- **Don't filter on `status === "triggered"`** to find things that fired —
  that state doesn't exist. Read the revisit queue instead.
- **`loadAlerts` normalizes old stores** (`normalizeAlert` in
  `src/alerts/models.ts`): legacy `"armed"` and `"triggered"` both become
  `"live"`. Without that, every previously-triggered alert would silently
  drop out of `checkAlerts`.

Re-fire suppression differs per kind and is *not* uniform: static alerts use
`lastKnownSide` plus direction and follow-up folding (next section), trailing alerts reset `extremePrice`, and volume conditions
use `mutedUntil` because a crossed volume threshold stays crossed and would
otherwise fire on every poll.

## The one-alert-per-symbol+side rule is settled differently per caller

`addAlert` takes an `onConflict` option (2026-09-16), and the two callers that
pass `"replace"` are not an oversight:

- **`alert seed` and `holdings cover` use the default `"keep-closest"`**: a
  candidate farther from the live price than the live alert already on that
  side is rejected. A bulk re-level of hundreds of TradingView rows must not
  talk an existing, nearer alert outwards. (`holdings cover` only ever touches
  symbols with no live alert, so it never reaches the rule.)
- **`alert add` and the dashboard's queued `alert.add` pass `"replace"`**: a
  typed level is a stated intention, not a suggestion. `alert add EIPI 25`
  cancels the alert at 28 rather than making the user run `alert remove` first.

Don't collapse these back into one policy, and don't move the choice into
`parseAddInput` — the parser is shared by the CLI and the page precisely so
both *validate* identically; the conflict policy is the caller's, not the
input's. The CLI and ops messages both name the replaced alert's condition
(`describeAlertCondition`), because under `"replace"` the thing being cancelled
may be the nearer of the two and the user should see what they gave up.

## Static alerts watch one direction, and crossings back fold onto the fire

Until 2026-09-14 a static alert fired on *any* change of `lastKnownSide`, so
it fired both ways. `side` was never a direction: it only records where price
was at creation, for the one-alert-per-symbol+side rule. In real data, levels
chopped across every 15-30 minutes, and each crossing became its own queue entry.
The narrative called the crossing back "slipped below support".

- **`StaticAlert.direction`** is `up` (default), `down`, or `either`. The
  user set every existing alert to `up`. Don't infer a direction from `side`.
- **Crossings inside the reversion window fold onto the fire** as
  `RevisitEntry.followUps`. The window is `holdDays` trading days, and the
  fire's own day is day 0. Both directions fold, with no volume check. The
  first follow-up against the fire is the reversal (`reversalOf` in
  `src/alerts/reversion.ts`). That is the signal the user wants.
- **Outside the window**, a crossing against `direction` records nothing. "It
  is below the alert now" is explicitly not news.
- **Don't say "support" or "resistance".** To the user those mean a level the
  market has tested repeatedly, not an alert they typed. Say "crossed above 50".
- **Legacy entries**: `alert migrate-directions` marked old follow-up entries
  with `followUpOf` (skip them everywhere). It also dismissed open
  counter-direction entries outside any window. Don't count `followUpOf`
  entries as triggers.
- The trading-day count skips weekends but knows no holidays, so a holiday
  stretches the window by a day. MA and trailing alerts don't fold follow-ups.
- `analyzeAlert` is direction-aware. Before this, a downward trigger was judged
  as an upside breakout, so a real close below the level got `NO_CLOSE_CONFIRM`.

## Schwab's `/markets` response keys the product two different ways

`GET /marketdata/v1/markets?markets=equity&date=...` returns
`{"equity": {"EQ": {...}}}` on a trading day but `{"equity": {"equity": {...}}}`
on a closed one, and `sessionHours` is absent entirely when closed. Reading
either literal key breaks on half the days of the year, so `parseMarketHours`
takes whatever single product object is present.

Do **not** hardcode 09:30-16:00 in place of this call. Half days are real:
2026-11-27 has `regularMarket` ending 13:00 and `postMarket` ending 17:00.

Session boundaries are shared, not gapped — `preMarket.end` equals
`regularMarket.start`. `sessionAt` therefore checks regular first so a
boundary instant resolves to the more significant session.

## Narrative text is template-based on purpose

`src/narrative.ts` generates the dashboard's English. Do not replace it with
a model call: the output describes money decisions, renders unattended on a
device with no way to verify it, and every claim is read straight off a
recorded verdict. The phrasing is load-bearing — "broke resistance" is only
emitted where the verdict supports it, and `NO_CLOSE_CONFIRM` must never be
described as a breakout.

## The browser dashboard's publish fingerprint must ignore anything price-derived

`dashboard --publish --skip-unchanged` fingerprints a build made with **no
quotes** and compares it to the last publish, so a quiet cron run spends zero
API calls. That only works if the fingerprint of a quote-less build equals the
fingerprint of the real one. `VOLATILE_KEYS` in `src/web/site.ts` lists every
field that moves with price or the clock. If you add a price-dependent field to
the `Dashboard` document, add its key there or every run will publish (the
`dashboardFingerprint` test in `tests/dashboard.test.ts` will catch it only if
its fixture exercises the field).

**Holdings are removed from the published JSON, not hidden by the page.** The
site has no login by default (`EnableBasicAuth=false`), so `dashboard.json` is
public. With `web.holdings` off, `siteDocument` (`src/web/site.ts`) empties the
holdings rows before writing *and* before fingerprinting.

**The unlocked page gets holdings from `vault.json`, encrypted.** With
`OPS_QUEUE_URL` and a 32+ character `OPS_TOKEN` in `.env`, `dashboard` publishes
positions, lots, and stops AES-256-GCM sealed under a key derived from the ops
token (`src/web/vault.ts`). The page decrypts them in the browser after unlocking
(`openVault` in `web/app.js`). Two things break silently if you touch them:

- **The key prefix must match byte for byte** in `vault.ts` (`KEY_CONTEXT`) and
  `app.js` (`VAULT_KEY_CONTEXT`). A NUL character once slipped into one of them.
  Node's own round-trip still passed; only the WebCrypto test in
  `tests/holdingsOps.test.ts`, which reads the prefix out of `app.js`, caught it.
- **Fingerprint the plaintext, never the sealed document.** Every seal uses a fresh
  IV, so the ciphertext changes every run. `siteFingerprint` takes
  `vaultContents`; hashing `vault.json` would publish on every check.

The line the user drew (2026-09-12): **size and value are private, being held
is not.** "Holding MKS broke support", held-first story ordering, and "held
position" in priority breakdowns are fine to publish. Share counts, basis,
market value, and stops are not. If you add a field carrying any of those
outside `holdings`, strip it in `siteDocument` too. The `siteDocument` tests in
`tests/dashboard.test.ts` check the JSON for `shares`/`basis`/`marketValue` keys.

That rule is why the details drawer's **Position** row is assembled in the
browser (`positionValue` in `web/app.js`) out of `holdingRows()`, and not read
off the trigger or alert row. The obvious implementation - hang shares, basis,
and value on `TriggerRow` in `dashboard.ts` so the drawer can just print them -
publishes every held position's size in `dashboard.json` on a site with no
login. A `heldPosition` boolean is the *only* holdings fact that may travel in
a published document, and both `TriggerRow` and `AlertRow` carry one so the
tag reads the same locked as unlocked; everything with a number in it comes
from the decrypted vault (or from the document only when `web.holdings` is
on), so the Position row is simply absent on the public page. The **Story**
section in the same drawer is client-side for a duller reason:
`Dashboard.stories` already carries every story, keyed by symbol, so there is
nothing to add server-side.

The `held` tag is a link, not a label: `#/holdings/<symbol>` with
`target="equity-watch-holdings"`, so every click lands in one reused tab rather
than navigating the overview away or piling up tabs (same trick as the chart
link's `CHART_TARGET`). It calls `stopPropagation` but **not** `preventDefault`
- the browser's own window targeting is what reuses the tab, and preventing the
default would turn it back into an in-place navigation. `parseRoute` therefore
returns a `focus` for base views, and only a base route may change it: a drawer
route has `base: null` and must not clear the highlight it is sitting on.

Two more things that look wrong and aren't:

- **No CloudFront invalidation.** The congress project's publisher invalidates
  `/*` on every publish. This one can publish every few minutes, and
  invalidations past 1,000 paths/month are billed, so it uploads everything with
  `Cache-Control: no-cache` instead. Don't port the invalidation back.
- **`web/` sits outside `src/`** and is resolved as `../../web/` from the module,
  which is correct from both `src/web/site.ts` (tsx) and `dist/web/site.js`.
  `tsc` does not copy non-TS files, which is why the assets aren't under `src/`.

## The Alerts page's A-Z rail is sized from the window, and hides when it would lie

`renderAlphaRail` in `web/app.js`. Three decisions that look like bugs:

- **It is hidden under every sort but `symbol`.** Under "closest to level" or
  "most triggered" the rows are in no alphabetical order, so a tab marked M
  would scroll to an arbitrary row. Hiding it is the honest option.
- **Whether there is a rail at all is decided by the whole alert list; which
  tabs are *enabled* is decided by the filtered rows.** Basing both on the
  filter makes the rail vanish as soon as a search narrows to one initial,
  shifting the table sideways under the cursor and taking the navigation away
  exactly when it is in use. A letter nothing matches is rendered disabled, so
  the rail keeps its shape while you type.
- **It draws twice.** There is no way to know how tall a tab is without
  rendering one, so the first pass lays out all 27 and the second regroups to
  whatever `railCapacity` measures. Below 27 the letters go into consecutive
  ranges ("C–E"), sized by letters spanned rather than by alerts held — the
  rail is a map of the alphabet, and someone looking for MSFT wants the tab
  covering M wherever it happens to fall. It regroups on `resize`, debounced.

Symbols can start with a digit, `$` or `^` (`SYMBOL_RE` allows it), so `#` is a
real bucket, not a placeholder.

## Dashboard edits are queued, and the op log is what makes them safe to retry

The page adds and edits alerts by POSTing to `/api/ops` (a Lambda behind the
same CloudFront distribution). That puts an op on an SQS FIFO queue, and
`ops pull` applies it at the start of the next scheduled check (`src/ops/`).
Things that look simplifiable and aren't:

- **Don't rely on SQS deduplication.** It lasts five minutes, and an add isn't
  idempotent. `applyOp` checks `ops.log.jsonl` for the op id first, and a
  message is deleted only after its result is logged. Remove either and a crash
  mid-apply adds the alert twice.
- **A rejection is a result, an exception is not.** Bad input, a stale page, or
  the engine saying no gets logged and deleted. A thrown error (Schwab login
  expired) propagates, and `pullOps` stops with that op and everything after it
  still queued, because a later edit may target an alert an earlier add creates.
- **Edits target by id only.** `findAlert` also accepts a ticker. Don't pass an
  op's target through it, or an edit can land on a different alert on that symbol.
- **Every edit closes the alert's open revisit entries**, wherever it is made:
  `alert edit`, the alert's panel, or a trigger's panel (the user's rule,
  2026-09-18; before that only the trigger panel closed its one entry).
  `closeRevisitsForEdit` marks them `applied`, not `dismissed`, with
  `appliedFrom`/`appliedTo` from `levelMove` when the level moved, as
  `alert revisit apply` records. One edit can therefore stamp the same move on
  several entries; `tickerStory` tells it once. A trigger panel's edit still
  sends `target.revisitId`, and that entry is checked **before** the edit (it
  must exist, belong to that alert, and still be open), so a stale panel is one
  rejection rather than an alert moved on a fire already dealt with. That is why
  `ApplyContext` carries a `revisitsFile`; both `ops pull` and `ops apply` pass
  `--revisits-file` through, defaulting to `revisits.json`.
- **Nothing can push to the machine, so there is no "apply now" button.** The
  page is static on S3/CloudFront and the Lambda can only write to SQS; the
  drain happens when the Windows task next runs `ops pull`. A button would need
  either an always-on local watcher long-polling SQS (explicitly not the design
  — see the header of `src/ops/pull.ts`) or an inbound path to the machine.
  What the page does instead is *say when*, from two sources in order.
  - **`opsNextCheckAt` is the scheduler's own answer**, not an inference:
    `check-and-publish.ps1` reads `(Get-ScheduledTaskInfo).NextRunTime` and
    passes it as `dashboard --next-check`. It already accounts for both the
    repetition and the daily window, so at 18:10 it is tomorrow's 01:55 rather
    than 18:25. **Don't derive this from market hours instead.** The task
    window only happens to bracket extended hours (01:55 MT = 03:55 ET, 18:10
    MT = 20:10 ET); that is how the task is configured, not something the code
    knows, and `ops pull` has no hours gate at all — a queued edit lands at the
    next check whether or not the market is open.
  - **The page only trusts it while it is still in the future.** A quiet run
    publishes nothing (`--skip-unchanged`), so it goes stale by up to
    `--max-stale-minutes` with the task running perfectly; treating a past
    value as "the check didn't run" would cry wolf. Past that it falls back to
    the cadence `ops pull` measured for itself (`drainIntervalMinutes`,
    `src/ops/schedule.ts`, published as `opsIntervalMinutes`), which counts
    down and then warns. The `.sh`/cron path passes no `--next-check` and lives
    on that fallback entirely.
  - **The cadence is a median, never a mean or the last gap.** The scheduled
    task has a daily window (01:55–18:10 as of 2026-09-16, `PT15M` repeating
    for `PT16H20M`), so one gap per night is ~8 hours. A mean would read that
    as the cadence and promise "applies in ~1 hr" all the next day.
  - **Past the cadence the page warns instead of counting down.** This is the
    case that prompted it (2026-09-16): nine ops sat queued all evening because
    the window had closed, and the page said only "pending". `OPS_OVERDUE_FACTOR`
    in `web/app.js` is the grace before a late run is called stopped.
  - **The header carries it too, not just a pending change.** `renderUpdated`
    appends "next check 1:55 AM" beside the document's age. The first cut put
    it only on pending rows, which meant a drained queue left the page showing
    nothing but "Updated 14 min ago" — and the age alone can't answer "when
    does this refresh?", since a quiet run publishes nothing and an hour-old
    document is normal. `nextCheckText`/`checkIsOverdue` are the one place the
    two sources and the staleness rule live; the pending note calls them too.
  - **A quiet stretch is not a stopped task.** With `--skip-unchanged` a
    healthy document can be up to `--max-stale-minutes` old, so the overdue
    allowance is that skip window (`opsMaxStaleMinutes`) plus
    `OPS_OVERDUE_FACTOR` intervals. The first version used only the intervals
    (30 min at a 30-min skip window) and said "no check since 11:25" while
    every run was succeeding (2026-09-18). A passed `opsNextCheckAt` is
    stepped forward on the cadence (`projectedNextCheck`), which is only safe
    because `shouldPublish` always publishes the run whose next check is
    further off than the skip window, i.e. the one that closes the daily
    window. `shouldPublish` also allows a minute of slack: runs publish a few
    seconds in, so a strict `>= 30` saw 29.97 and waited another interval.
  - `opsIntervalMinutes` and `opsNextCheckAt` are in `VOLATILE_KEYS` alongside
    `opsProcessedThrough`: all three advance with the clock every run, so
    fingerprinting any of them would publish every run.
- **Dismiss is on the queue row, never the trigger panel.** The "Copy dismiss"
  buttons went on 2026-09-16; a queued `revisit.dismiss` op replaced them on
  2026-09-18. The user asked for it on the revisit queue specifically, so it
  reads as removing that one row: the alert is untouched and its next fire comes
  back as a new entry. Two pending tags, kept apart on purpose: `pendingTag`
  ("edit pending") counts only `alert.*` ops, because a pending dismiss names
  the alert too but doesn't change it; `dismissPending` matches by
  `revisitId`. `rerenderOps` re-renders the queue so either tag appears without
  waiting for a poll. A new op type also needs the Lambda's `TARGET_KEY` in
  `infra/cloudformation.yaml` and a stack deploy, or the page gets "Unknown op type".
- **The alert panel's Remove is a queued `alert.remove`**, not a copied CLI
  command (2026-09-18). It carries `expect.condition` like an edit and deletes
  by id only (never `findAlert`), so a stale panel can't delete what an alert
  has since become. Its pending tag reads "remove pending".
- **The edit form is price + volume for static and volume alerts alike**
  (2026-09-18). An empty level means volume-only. `editAlert` converts in place,
  keeping id and history: a level on a volume alert makes it static with the
  volume as its AND condition; `level: null` (`clearLevel`, `--clear-level`)
  makes a static alert with volume a volume alert. The volume alert's panel
  therefore sends `direction` with any new level, since it has none to keep.
  `AlertRow.volume` carries the condition so the form can prefill it; the
  condition text can't be parsed back. Moving averages have no volume
  condition and still aren't editable from the page.
- **The New alert form shares those three controls** (`buildVolumeFields` in
  `web/app.js`), so a new alert can carry an absolute share count and a window,
  not only a ratio. Keep them shared rather than writing a second copy: the two
  forms have to offer the same choices and reject the same input with the same
  words, and it is the page's parse of "2.5M" that decides what number reaches
  the worker. Volume stays optional there — the kind select defaults to "none",
  which is what makes a new alert a plain price alert.
  Note for tests: the add form now has three text inputs, so
  `#alert-add input[type=text]` is ambiguous. Select its fields by label.
- **The volume window is a `<select>`, and what it leaves out is deliberate.**
  It was a free-text `Nunit` spec whose only documentation was a placeholder.
  Option values are still the spec the worker parses, so `""` means today and
  nothing downstream changed. Two rules for editing that list:
  - **No sub-day window past 4 days.** A `s`/`m`/`h` window fetches
    `min(10, max(2, ceil(days) + 1))` days of 1-minute bars, and Schwab's
    `periodType=day` only takes 1-5 or 10 — so a window over 4 days and up to
    8 asks for 6-9 and fails on *every* check (`120h` is the example in the
    moving-average section). Past 8 days it clamps back to 10 and succeeds,
    which makes the broken band easy to miss. Day-unit windows are not
    affected at all: `getDailyBars` sends a date range, not a period count,
    which is why 10 days is offered as `10d` and never as `240h`.
  - **A window the list doesn't offer is preserved, not snapped.** An alert set
    from the CLI can hold `45s`; the select grows an extra option for it, so
    opening an alert's form to read it and saving doesn't quietly re-window it.
    The CLI itself still accepts any `Nunit`, including the ones that fail.
- **Both drawers fetch `alerts.json`.** The trigger drawer needs the alert's
  *current* level and direction for the edit form, and `TriggerRow` carries
  neither (it records what fired, not what is set now). `RevisitRow.alertId`
  exists for the same feature: the queue row needs it to show the pending tag.
- **`expect.condition` is the conflict guard**: `describeAlertCondition` as the
  page showed it. If you change that function's wording, every edit queued before
  the deploy is rejected once. That's acceptable, but know it will happen.
- **Validation lives in `src/ops/validate.ts`** and the CLI uses it too. Don't
  add a check to `cmdAlertAdd`/`cmdAlertEdit` only, or the page will accept what
  the CLI refuses.
- **The Lambda's handler is inline in `infra/cloudformation.yaml`** and checks shape and
  token only. It can't import from `src/`. All semantic checks happen in the worker.
- **`opResults` is not in `VOLATILE_KEYS`** on purpose: a new result must publish,
  or the page never learns its edit landed.
- **Holdings op results are public, so they carry no numbers.** `opResults` goes
  into `dashboard.json`. The holdings handlers (`src/ops/holdings.ts`) and their
  validators (`parseLotInput` etc.) name the symbol and the field, but never echo a
  share count, basis, or price, not even a rejected one. The page shows details
  from its own record of what it sent. A test asserts that no holdings message
  contains a digit.
- **`ops pull` drains until the queue is empty.** `--max` exists for manual runs;
  it has no default, and the scheduled script passes none. It used to default to
  50, which silently left the rest of a 70-change burst queued until the next run.
  Overrunning the task's ten-minute limit is safe — an interrupted drain resumes —
  but the published result list is capped separately (`recentOpResults`), so a
  burst past that cap still leaves pending rows on the page with no result.
- **Parsing an op checks only its envelope** (id and type). A bad target, expect,
  or params becomes a logged rejection. If it were dropped as malformed, the
  page would wait forever for a result.
- **The page's editing controls have browser tests:** `npm run test:ui`
  (`playwright/`). `playwright/server.ts` builds the documents from fixture
  alerts with the real builders and fakes the Lambda. Specs are `*.e2e.ts`
  because vitest's default pattern would otherwise pick up `*.spec.ts`.
  - **A stale server will serve you yesterday's `src/`.** The config sets
    `reuseExistingServer: !process.env.CI`, and the server reads `src/` once at
    boot, so a run that reuses one left over from an earlier session tests the
    old builders against the new specs. The failure looks exactly like a bug in
    the change under test — a new field arriving empty, say. Before believing
    such a failure, check the builder directly (`npx tsx` a few lines against
    the fixtures) or kill whatever is listening on 4178 and re-run. Editing
    `web/` alone is safe: those files are read per request.

## The Schwab login expires weekly, and the whole run has to cope with it

Schwab refresh tokens last **7 days** and only the interactive browser flow
(`schwab-login`) renews one — there is no unattended path. So roughly weekly the
scheduled task wakes up with no way to fetch a quote. Everything below exists
because the first failure of this kind (2026-09-19) looked like nothing at all:
`ops pull` stopped, the page kept saying "pending", and no other signal fired.

- **Exit code 3 means "the login expired", everywhere.** `SchwabAuthError`
  carries an `expired` flag and the CLI's top-level handler maps it to
  `EXIT_SCHWAB_LOGIN_EXPIRED`. A missing token file counts too: same remedy.
  Don't collapse it back to 1 — both scripts branch on it.
- **Detect the expiry from the whole response body, not a parsed field.**
  Schwab answers a dead refresh token with an envelope whose own `error` says
  `unsupported_token_type`; the real `invalid_grant` is a JSON string nested
  inside a JSON string. `isExpiredRefreshToken` regexes the raw text and
  requires a 400/401, so a 500 stays transient and doesn't send anyone to a
  browser.
- **The marker file is how two processes talk.** The command that hits the wall
  (usually `ops pull`) is not the one that reports it (`dashboard --publish`,
  a separate process). `src/providers/authState.ts` writes
  `schwab_auth_state.json` *beside* the token file — not inside it, because that
  file holds bearer credentials and is written only on a successful exchange.
  It keeps the **first** failure's timestamp; restamping every run would both
  say "expired 0 min ago" forever and publish on every run.
- **The scheduled scripts skip ahead and publish anyway.** `alert check` used to
  `Stop-Run` on any failure, which exited *before* the publish — so the one run
  that knew the login was dead was also the one that couldn't say so. Both
  `check-and-publish.ps1` and `.sh` now skip the quote-needing steps and still
  publish, then exit 3 so the healthcheck ping still reads as a failure.
  `cmdDashboard` already tolerates a dead login: it catches the quote failure
  and renders without live prices.
- **`opsAuthExpiredSince` is deliberately NOT in `VOLATILE_KEYS`.** It is the
  rare field that *must* move the fingerprint, like `opResults` — otherwise the
  page never learns. It's safe there only because it holds the first failure's
  time, so it changes twice per expiry rather than every run.
- **The page stops promising checks it can't make.** With the login expired,
  `nextCheckText` says "checks paused, login expired" instead of counting down
  to a run that will evaluate nothing, and the pending-change note says it is
  waiting on the login rather than "Applies at the next check, in 9 min". The
  banner names the command because nothing can push to the machine — there is
  no button that could work (see the header of `src/ops/pull.ts`).
- **`ops pull` checks the login BEFORE it receives anything.** Receiving is the
  first irreversible step, not applying: an SQS message handed out is invisible
  until it is deleted or released, so a drain that discovers a dead login
  mid-batch leaves the queue *looking empty* for the visibility timeout (120s
  on this queue). That is what happened on 2026-09-19 — a retry printed "No
  queued ops" with eight ops sitting right there, which is indistinguishable
  from a successful drain. `pullOps` takes a `preflight` callback, runs it
  before the first receive, and returns `blocked` without touching the queue.
  `schwabLoginBlocker` in `src/cli.ts` is that check: it calls
  `getAccessToken()`, which is free when the token is fresh and does the
  refresh the first quote would have done anyway.
  - **Only an `expired` failure blocks.** Schwab being down or the network
    being out is transient and may not even affect the ops queued, so the drain
    still tries. And with no Schwab credentials configured at all the check is
    skipped entirely — that is the case `lazyMarketData` exists for, where
    removes, dismisses and holdings ops work with no Schwab setup.
  - **The marker, not the preflight, is why this reports correctly.** Reading
    `authState` instead would miss the first run of every expiry, since nothing
    has failed yet to write it. The preflight's own refresh attempt is what
    sets the marker, which is then what `dashboard --publish` reads later in
    the same run.
  - **A blocked run records no drain watermark.** It exits before `recordDrain`,
    because no drain happened; writing one would tell the page that everything
    queued before it had been applied.
- **A drain that stops partway hands its messages straight back**
  (`OpsQueue.release` → `ChangeMessageVisibility` to 0), both the op that threw
  and the rest of its batch. Best-effort: a failed release only means the
  message waits out the timeout as before, and must never mask the error that
  stopped the drain.
- **Why only *some* ops need a quote:** `alert.add` and `alert.edit` with a level
  need a live quote to set `side`/`lastKnownSide` against the current price.
  `alert.remove`, `revisit.dismiss`, and the holdings ops never touch market
  data. The queue still stops at the first failure, though: FIFO ordering
  matters more (an edit may target an alert an earlier add creates), so nothing
  jumps ahead. Since 2026-09-19 an expired login stops the drain before it
  starts, so those quote-less ops wait too — deliberate, because during an
  expiry no checks run at all and a partial drain would publish some results
  and not others.

## A queue row says what changed since it was queued, and the split is the fingerprint

`RevisitRow` carries two of these, and which is which matters:

- **`updates`** is what a person or the engine *did* since the fire landed in
  the queue: the alert re-levelled, the alert removed or cancelled, further
  crossings folded on past the reversal. These strings are **fingerprinted**, so
  every one of them must be caused by an event, never by the clock or a quote.
  That is why only a **static** alert's level is compared: a trailing alert's
  level and a moving average's are recomputed against price on every check, so
  "the level moved" would be true every run and the page would republish every
  run. (Same reason `movingLevel` is separate from `level`.)
- **`sinceTrigger`** is "price is +6% since it fired", and is in
  `VOLATILE_KEYS` alongside `sinceWatching`. Distinct from `sinceWatching`,
  which measures from when the symbol was first watched, often months earlier.

`triggerAction` now takes the alert's current level, because both sentences it
produces are measured from `levelAtTrigger`: once the alert has been
re-levelled, "Level 50 still stands" is simply false and "Suggest moving 50 to
61" is advice about a level that no longer exists. It returns null in that case
and the `updates` line reports the move. Passing nothing keeps the old
behaviour, which is what the other callers want.

**The position line on a queue row is assembled in the browser**
(`positionNote` in `web/app.js`) out of `holdingRows()`, for exactly the reason
the details drawer's Position row is: share counts, basis, value and stops may
not travel in a published document. On the public page `holdingRows()` is null
and the line is simply absent, leaving the `held` tag — the one holdings fact a
document may carry. Don't "simplify" it by hanging the numbers on `RevisitRow`.

## Trigger details before 2026-09-13 are incomplete, and can't be backfilled

`RevisitEntry.condition` and `RevisitEntry.volume` are recorded by the engine
at trigger time and are optional on purpose. Every entry written before they
existed lacks them, and the information is gone: the engine never saved the
volume it measured, and a removed alert (like MTD's `d297c287`) takes its
condition with it. `buildDashboard` falls back to the alert's *current*
settings and marks `conditionSource: "current"`. The page must keep saying so.
Never present current settings as what the alert was when it fired.

Moving levels on alert rows (trailing triggers, MA averages) live in
`movingLevel`, not `level`, precisely so `VOLATILE_KEYS` can exclude them from
the publish fingerprint. Put a trailing trigger in `level` and every check
republishes.

## Moving-average alerts are evaluated over a price path, not a price

`src/alerts/maEngine.ts` replays the 1-minute bars since `lastEvaluatedAt`, plus
the live quote, on every check. It is tempting to "simplify" this to comparing
the live quote against the average, like a static alert. Don't. The user
explicitly asked for evaluation independent of poll timing: a cross that
reverses between polls must fire, and a 1-minute average must work under a
2-minute poll. Both break with snapshot comparison.

Things that look like bugs and aren't:

- **The level excludes the forming bar** (`levelAt` in
  `src/indicators/movingAverage.ts`). Including it makes the average chase
  the price it's compared against.
- **Crosses use closes, touches use high/low.** A wick through the average is
  a touch, not a cross.
- **Bucketing is by the exchange clock** (`America/New_York`). Schwab stamps
  daily candles at Eastern midnight, which is the previous day's evening in
  some UTC readings. Never bucket by `toISOString().slice(0, 10)`.
- **Schwab's `periodType=day` only accepts `period` 1-5 or 10.** Confirmed
  2026-09-13: `period=6` returns HTTP 400 ("When periodType=day valid val…"),
  `period=5` works. `schwabIntradayPeriod` snaps to the valid values, and
  `MAX_INTRADAY_HISTORY_DAYS` beside it is the 10-day ceiling on minute
  history. **Every** caller must snap. `volumeSatisfied` in `engine.ts` used
  to clamp instead (`min(10, ceil(window / 1 day) + 1)`), so a volume window
  given in seconds, minutes or hours spanning more than 4 days and up to 8
  (e.g. `--volume-period 120h`) asked for 6-9 and failed on every check —
  fixed 2026-09-21. Note how that hid: past 8 days the clamp landed back on
  10 and worked again, so the broken band sat in the middle, and a failing
  check is indistinguishable from a quiet one.

  Snapping keeps the request legal but cannot invent history, so a sub-day
  window longer than `MAX_INTRADAY_HISTORY_DAYS` is now refused by
  `volumePeriod` in `src/ops/validate.ts` (the CLI and the queued op both go
  through it) rather than silently measured against the ten days that exist.
  The message says to give it in days instead, because a `d` window is read
  from `getDailyBars`, which takes a date range and has no such ceiling. That
  asymmetry is why the dashboard's window list offers 10 days as `10d` and
  never as `240h`.

## A zero volume baseline must mean "cannot evaluate", never "no threshold"

`requiredVolume` returns `null` for a ratio condition with a zero or missing
baseline, and `volumeSatisfied` treats null as unsatisfied. Returning `0`
instead would mean *any* volume clears the bar, firing every volume alert on
every check. A sub-day window evaluated outside market hours legitimately has
no baseline (there are no bars in "the last hour" at 11pm), so this path is
reached in normal operation, not just on errors.

Baselines are not `avgDaily * days`. A 7-calendar-day window holds about 5
trading days, so multiplying overstates by ~40%; `rollingWindowBaseline`
measures real windows instead. Intraday baselines are matched by time of day
because volume is U-shaped — MSFT's closing hour runs ~2.4x its early
afternoon.

## Webull's holdings export has a wrong `Quantity` column

Webull does not officially support this export and the 2026-09-11 files prove
it: two positions' `Quantity` disagreed with *both* `Market Value / Last Price`
and `Total Cost / Avg Cost`, which agreed with each other. `reconcileQuantity`
therefore derives the count from the cost columns and overrides `Quantity` only
when market value corroborates - one bad cell must not silently rewrite a
position. Do not "simplify" this back to reading `Quantity`.

Rounding is not an error: a 341-share position divides to 340.80 because
`Last Price` is rounded to the cent. The tolerance exists for that.

## Tests were not typechecked until 2026-09-12

`tsconfig.json` has `"include": ["src/**/*.ts"]`, so `tsc -p tsconfig.json`
never saw `tests/`, and vitest transpiles without checking types. Several test
fixtures had silently rotted out of sync with the models. `tsconfig.test.json`
covers both, `npm run typecheck` runs it, and `npm test` runs it before vitest.
If you add a field to an Alert/RevisitEntry/Lot, `npm test` will now tell you
which fixtures need it.

## `holdings cover` takes the higher of price and basis

`coverLevel` is 10% above the *higher* of the current price and the blended
basis (the user's call, 2026-09-16; it was price-only before, and the git
history and this file both used to say basis must never come back).

Above basis, price is the higher reference, so this behaves exactly as the
price-only rule did. Under water it anchors to basis, which is what the user
wants to hear about: clearing cost, not a 10% bounce off a low. The known cost
is a deep loser — at 69% down the level is more than triple the price, so the
alert is effectively silent. It only ever applies to a position with **no live
alert**, which normally means a fresh buy where the two references are close.

`holdings cover` runs in the scheduled script (after `ops pull`, before
`alert check`), so a lot added from the dashboard, a CSV import, or the CLI is
covered the same way within one cycle. It exits before fetching a single quote
when every held symbol already has an alert, so a quiet run costs nothing.

Round *before* comparing any level against a live price. `100 * 1.1` is
`110.00000000000001`, which beats a price of `110` on a raw comparison but
rounds straight back onto it — producing an alert at exactly the live price,
which has no side to fire on and `addAlert` rejects.

## Things that exist once, and the reason each one has to

A consolidation pass on 2026-09-21 collapsed several copies. If you find
yourself about to write a second one, these are the reasons not to:

- **`src/round.ts`** is the only rounding for prices and levels. `symbolView.ts`
  used `Number(n.toFixed(2))`, which disagrees with `Math.round(n * 100) / 100`
  on binary edges — and rounding is load-bearing here (see `holdings cover`
  below: round *before* comparing a level against a live price).
- **`tradingViewUrl`** is the only chart-link builder. `engine.ts`,
  `alerts/report.ts` and `holdings/report.ts` each had a private `chartUrl`
  that skipped the exchange prefix *and* the URL encoding, so `BRK/B` came out
  broken and `PPL` opened Pakistan Petroleum. They now pass `null` for the
  exchange, which is the link they always built, only encoded. **Remaining
  gap:** those three have no profile cache to hand, so they still can't
  prefix. Fixing that means threading an `exchanges` map through `checkAlerts`
  and both report writers.
- **`heldSymbolsOf`** (`src/holdings/models.ts`) decides `heldPosition` for
  trigger rows, alert rows and `revisit relevel`. The `held` tag must read the
  same on every view and nothing else ties those three together.
- **`schwabCredentials` / `schwabAuth` / `schwabProvider`** (`cli.ts`) resolve
  the app key once. There were five copies and *three* different "missing
  credentials" messages, so the advice you got depended on which command you
  ran. Two callers deliberately do not exit: `schwabLoginBlocker` returns null
  (no Schwab configured is not a failure for removes and dismisses), and
  `getMarketHoursCached` throws (its caller catches, so `alert check` carries
  on without a session).
- **`guardedAlert`** (`src/ops/apply.ts`) is the by-id-only + `expect.condition`
  check for every op that changes an existing alert. It was copied between
  `applyEdit` and `applyRemove`; a third guarded op type would have been a
  third copy, and a fix to one silently not applied to the other.
- **`sideOf` / `otherSide`** live in `alerts/reversion.ts` rather than
  `narrative.ts`, so the CLI can use them without depending on the narrative
  module.
- **`tests/lambdaContract.test.ts`** reads `infra/cloudformation.yaml` and asserts its
  inline `TARGET_KEY` matches `OP_TYPES`. Nothing tied them before, and the
  e2e suite can't: `playwright/server.ts` fakes the Lambda and falls through to
  a generic success, so a new op type missing from the template passes every
  test and fails only after a deploy.
- **`web/app.js`'s `holdingFor`** is the single place the holdings privacy rule
  is applied on the page: `holdingRows()` is null on a public page, so every
  caller is absent there rather than each remembering to check.

Two that look like duplication and are not: the stop-price messages in the
add-lot form ("or empty for none") and in `stopsBlock` ("Enter a stop price
above 0") differ because the stop is optional in one and required in the
other; and `describeVolumeCondition` / `volumeConditionText` / `volumeText`
render a volume three ways because they are a contract string, a change
summary, and an observation respectively.

## Real financial data stays out of git

`.gitignore` covers `holdings.json`, `alerts.json`, `revisits.json`, and
`webull_*.csv`. The holdings tests run against anonymized fixtures in
`tests/fixtures/webull_*_sample.csv` that reproduce every structural quirk of
the real exports (bad quantity in both directions, rounding noise, a truncated
option symbol, one symbol in two accounts) without containing real positions.
The TradingView exports are trimmed rather than anonymized (they are watchlist
levels, not positions): `tests/fixtures/tradingview_*_sample.csv` are ~70 rows
verbatim from the real files, chosen to preserve every behaviour the seed tests
assert. The full exports and `alerts_in/` stay out of git; nothing depends on
them, and the old six-column schema is specimen'd by `tests/fixtures/sample_alerts.csv`.

## TradingView chart links need an exchange prefix

`chart/?symbol=PPL` opens whatever TradingView ranks first, and its symbol
search (checked 2026-09-13) puts Pakistan Petroleum (PSX) above PPL Corp
(NYSE). `src/tradingview.ts` prefixes the exchange from the FMP profile cache,
using uniquetrades-congress's mapping. FMP calls NYSE Arca ETFs (BIL, VFH, KRE)
`AMEX`, which is also TradingView's prefix for them, so that isn't a bug.

Profiles cached before 2026-09-13 have no `exchange` key. `profileNeedsFetch`
treats those as missing, so the next `profile fetch --all-known` refetches
them (a `null` exchange means FMP had none, and is not refetched). Until then
those links fall back to the bare symbol, and `dashboard` says how many.

## Ticker symbols in these exports are not all US listings

`PPL` appears at both `37.14` and `231.55`, and the `231.55` one fired at
03:31 and on a Sunday at 22:51 — it is a foreign listing sharing the
ticker. `ENS` likewise appears at `19.78` and `200.91`. Anything that
groups by bare symbol (the alert engine's symbol+side uniqueness rule, the
profile cache) will silently merge two different instruments. `LKFT` also
has `GLPG Crossing 35.19` as its description — a post-rename row where the
`Symbol` and `Description` disagree.

## The dashboard's TradingView chart panel: studies_overrides is a dead end, use indicators with the right defaults instead

`web/app.js`'s `openChart`/`chartEmbedUrl` load a chart in an iframe pointed
at `https://s.tradingview.com/embed-widget/advanced-chart/#<json>` — the
current URL scheme TradingView's own `embed-widget-advanced-chart.js` builds
(confirmed by reading that script directly: it JSON-stringifies its settings
into the URL hash, not query params). It's the free, unauthenticated,
cross-origin widget — no postMessage API, so the panel can only choose what
`src` to load; it never hears about symbol, timeframe, or indicator changes
made inside it.

`symbol`, `interval`, `autosize`, `hide_side_toolbar`, and
`allow_symbol_change` all work reliably in that hash JSON (verified with
Playwright against the live page, screenshotting the actual rendered iframe,
not just checking the `src` we built). **`studies_overrides` does not.** Every config that included it
rendered as if the hash were empty entirely — light theme, no indicators,
none of the other settings applied either — and on one run the *same* config
without any override-shaped key failed the same way once too. That
inconsistency means it isn't a key-naming problem to chase: this is
flakiness in an undocumented endpoint, not a spec to satisfy. Don't spend
more time on `studies_overrides` here.

The `studies` array itself (no overrides) renders reliably — the fix was
picking a study whose own defaults are already what's wanted, not fighting
to override one. `"STD;MA%Ribbon"` ("Moving Average Ribbon") plots four SMAs
and ships with exactly 20/50/100/200 as its out-of-the-box lengths, so it's
preset in `chartEmbedUrl` with nothing else needed. That id is a Pine
standard-library id, not the legacy `NAME@tv-basicstudies` family (e.g.
`MASimple@tv-basicstudies`) documented elsewhere — found by driving the
chart's own Indicators search in Playwright and reading the real id off the
`create_study` WebSocket frame it sent, not by guessing from tutorials.
If another indicator needs preloading, that's the fastest way to get its
real id and confirm its actual default inputs — searching TradingView's own
docs/tutorials for `tv-basicstudies` names turns up stale or wrong answers.

**The theme goes out under both `theme` and `colorTheme`, and must stay that
way.** `colorTheme` alone was verified rendering dark when the panel landed,
then silently stopped being honored (reported 2026-09-17: charts opened light
while `symbol`, `interval`, the ribbon, and the hidden side toolbar all still
applied — so the hash was still being read and only that one key was being
dropped). `colorTheme` is the key TradingView's *other* embed widgets take
(ticker tape, mini chart, symbol overview); `theme` is the advanced chart's
own, which is likely why `colorTheme` only ever worked here incidentally.
Both parse, so `chartEmbedUrl` sends both and lets whichever the endpoint
currently honors win. Don't collapse them back to one key to tidy up.

Note what that episode says about the whole endpoint: a key that a
screenshot proved working can stop working later with no warning and no
error, while every other key keeps applying. Treat "verified live" here as
true on the day it was checked, not as a standing guarantee — and when a
setting goes wrong, first establish whether the *whole* hash is being ignored
(the `studies_overrides` failure above: light theme **and** no indicators
**and** no other settings) or just one key, because those have opposite
fixes.

Verifying this kind of thing needs an actual browser: `node --check` and
`curl` can confirm markup exists and endpoints return 200, but they can't
tell you a `hidden` attribute isn't visually hidden, that a config key
silently no-ops, or what an indicator's real id and defaults are. Use
Playwright (`playwright/server.ts` builds a fixture server from the real
document builders; `npm run test:ui` runs the suite) — it's already wired up
and can screenshot into cross-origin iframe content, and capture the
WebSocket frames such a page sends, neither of which our own page's JS can
ever read.

One catch: a Claude Code **web/cloud** session can't do that verification at
all — the agent proxy denies `*.tradingview.com` (and the published site),
so the iframe never loads there and only the `src` we build can be checked.
The theme fix above was made from a symptom report under exactly that
limitation. Anything about what the widget actually *renders* has to be
checked from a machine with real network access.
