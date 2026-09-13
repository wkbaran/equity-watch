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
- **Split date/time** (`Alert Date` + `Alert Time`) in local exchange time,
  versus a single ISO-8601 UTC `Time` column in the older export.
- **No exchange prefix** on `Symbol` (`AAPL`, not `BATS:AAPL`), though the
  `SYMBOL, TIMEFRAME` form (`"CDRE, 1D"`) still appears. `splitTicker`'s
  regex already tolerates both.
- `tradingview-alerts.csv` is a **different kind of thing entirely**: it is
  the list of *configured, still-pending* alerts (alert state), not a log
  of alerts that fired (alert events). Every model in this project assumes
  events. `Last Triggered` is blank for alerts that have never fired, and
  is formatted `Mon 27 Jul '26 07:30:12` — not ISO.

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

## Ticker symbols in these exports are not all US listings

`PPL` appears at both `37.14` and `231.55`, and the `231.55` one fired at
03:31 and on a Sunday at 22:51 — it is a foreign listing sharing the
ticker. `ENS` likewise appears at `19.78` and `200.91`. Anything that
groups by bare symbol (the alert engine's symbol+side uniqueness rule, the
profile cache) will silently merge two different instruments. `LKFT` also
has `GLPG Crossing 35.19` as its description — a post-rename row where the
`Symbol` and `Description` disagree.
