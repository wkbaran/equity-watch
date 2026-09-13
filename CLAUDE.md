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
`lastKnownSide`, trailing alerts reset `extremePrice`, and volume conditions
use `mutedUntil` because a crossed volume threshold stays crossed and would
otherwise fire on every poll.

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

## `holdings cover` anchors to price, not basis — on purpose

`coverLevel` is 10% above the *current price*, and basis does not enter the
calculation. This looks like an oversight and isn't: anchoring to basis fires
instantly on a position that has already run (basis+10% is in the past) and is
unreachable on one that has fallen (a 69% loser would have to nearly triple).
Price+10% also beats basis+10% whenever price is above basis, so the basis
branch only ever applied to losers, where it was worst. Don't reintroduce it.

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
