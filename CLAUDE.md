# Notes for agents working in this project

Common mistakes and surprises. Add to this whenever something in the
project catches you off guard.

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

Two more things that look wrong and aren't:

- **No CloudFront invalidation.** The congress project's publisher invalidates
  `/*` on every publish. This one can publish every few minutes, and
  invalidations past 1,000 paths/month are billed, so it uploads everything with
  `Cache-Control: no-cache` instead. Don't port the invalidation back.
- **`web/` sits outside `src/`** and is resolved as `../../web/` from the module,
  which is correct from both `src/web/site.ts` (tsx) and `dist/web/site.js`.
  `tsc` does not copy non-TS files, which is why the assets aren't under `src/`.

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
- **`expect.condition` is the conflict guard**: `describeAlertCondition` as the
  page showed it. If you change that function's wording, every edit queued before
  the deploy is rejected once. That's acceptable, but know it will happen.
- **Validation lives in `src/ops/validate.ts`** and the CLI uses it too. Don't
  add a check to `cmdAlertAdd`/`cmdAlertEdit` only, or the page will accept what
  the CLI refuses.
- **The Lambda's handler is inline in `cloudformation.yaml`** and checks shape and
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
  `period=5` works. `schwabIntradayPeriod` snaps to the valid values. The
  pre-existing volume-period code in `engine.ts` (`volumeSatisfied`) does
  **not** snap: it computes `daysBack = ceil(window / 1 day) + 1`, so a volume
  window given in hours or minutes that spans more than 4 days (e.g.
  `--volume-period 120h`) requests 6-9 and fails on every check. Not fixed as of
  this note.

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

`symbol`, `interval`, `colorTheme` (not `theme` — both parse, but only
`colorTheme` was confirmed live alongside a working `studies` entry),
`autosize`, `hide_side_toolbar`, and `allow_symbol_change` all work reliably
in that hash JSON (verified with Playwright against the live page,
screenshotting the actual rendered iframe, not just checking the `src` we
built). **`studies_overrides` does not.** Every config that included it
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

Verifying this kind of thing needs an actual browser: `node --check` and
`curl` can confirm markup exists and endpoints return 200, but they can't
tell you a `hidden` attribute isn't visually hidden, that a config key
silently no-ops, or what an indicator's real id and defaults are. Use
Playwright (`playwright/server.ts` builds a fixture server from the real
document builders; `npm run test:ui` runs the suite) — it's already wired up
and can screenshot into cross-origin iframe content, and capture the
WebSocket frames such a page sends, neither of which our own page's JS can
ever read.
