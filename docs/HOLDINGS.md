# Holdings

Reference for `src/holdings/`. See the [README](../README.md) for where this fits.

A separate, related subsystem that tracks actual positions — share count, cost
basis, and stops — entered manually and stored in `holdings.json` (gitignored, same
treatment as `alerts.json`). There is no Schwab Accounts API involved; that is a
different, unregistered product from the Market Data access this tool uses.

```bash
node dist/cli.js holdings import --csv roth=webull_roth.csv --csv margin=webull_margin.csv [--dry-run]
node dist/cli.js holdings add-lot --symbol AAPL --count 100 --basis 150 [--date 2026-01-15]
node dist/cli.js holdings list [--symbol AAPL]
node dist/cli.js holdings stop add --symbol AAPL --price 140 [--count 50]
node dist/cli.js holdings stop list
node dist/cli.js holdings stop remove <id>
node dist/cli.js holdings cover [--dry-run]
node dist/cli.js holdings check
```

Multiple purchase lots per symbol blend into one weighted-average basis for
alerting (individual lots are still kept for history and for "days since last
purchase"). Lots carry an optional `account` label, and `computeBasis` deliberately
still blends across accounts — "am I up 10% on BIL" is a question about the
position, not about where it is custodied.

A stop's `--count` defaults to `null`, meaning "whatever I currently hold" —
resolved dynamically each time rather than frozen at creation, so it still reads as
"all of it" after a later purchase. **Stops are record-keeping and context only**;
there is no live "price crossed the stop" alert yet, though it would reuse the
existing static-alert engine if added.

## Covering positions that have no alert

`holdings cover` creates a starting alert for every held position that doesn't
already have a live one, at **10% above the current price or the blended basis,
whichever is higher**:

```
  DEEPL  basis   4.45 · price   1.38 (-69.0% vs basis) → alert   4.90
  FLATA  basis 379.14 · price 365.25 ( -3.7% vs basis) → alert 417.05
  BIGWIN basis  12.97 · price  17.30 (+33.4% vs basis) → alert  19.03
```

Taking the higher of the two matters in both directions. **Above basis**, price is
the higher reference, so this behaves exactly as a price-only rule would and
nothing fires instantly. **Under water**, it anchors to basis, which is the thing
worth hearing about — clearing cost, not a 10% bounce off a low.

The cost is real on a deep loser: at 69% down, basis+10% is more than triple the
price, so the alert is effectively silent. That only applies to a position with *no
alert at all*, which in practice means a fresh buy where the two references are
close. Watch for it if an old, beaten-down position ever loses its alert.

Not volatility-scaled: a flat 10% is the whole rule. The level also always lands
clear of the live price, which matters because an alert *at* the live price has no
side to fire on and is rejected.

This runs in the scheduled script (after `ops pull`, before `alert check`), so a lot
added from the dashboard, a CSV import, or the CLI is covered the same way within
one cycle. It exits before fetching a single quote when every held symbol already
has an alert, so a quiet run costs nothing. Run it **after** `alert seed`, or every
position will look uncovered. Symbols in `ignoreSymbols` are skipped.

## Importing from Webull

`holdings import` reads Webull's holdings export, one `--csv account=path` per
account (`--replace` clears existing lots first instead of adding to them). Like
`alert seed`, it is hard-coded to that shape rather than being a general importer —
Webull does not officially support this export, and the 2026-09-11 files proved it:

- **`Quantity` is not trustworthy.** Two positions in the real export stated 3 and 9
  shares, while `Market Value / Last Price` *and* `Total Cost / Avg Cost`
  independently both said 5 and 6. The import derives the count from the cost columns
  (the pair that defines the basis every holdings alert is computed against), uses
  market value as a cross-check, and only overrides when both agree — one bad cell
  can't silently rewrite a position. Every override is reported.
- **Rounding is not an error.** A 341-share position computes to 340.80 from a
  cent-rounded Last Price; that is tolerated rather than flagged.
- **Options are skipped.** The export truncates the contract symbol (`DPRO $5...`),
  so it couldn't be reconstructed even if options were modelled.
- **The same symbol can appear in two accounts.** A cash-parking ETF held in both is
  the real case; each becomes its own lot tagged with its account, and the import
  warns that basis and alerts blend across them.
- **There is no purchase date.** `--purchase-date` backdates the lots; otherwise it
  defaults to today and the "stagnant" alert stays silent for 30 days. The import
  says so rather than leaving you to discover it.

## Basis-relative alerts

`holdings check` evaluates three conditions per position, each firing once on the
crossing (same semantics as static/trailing alerts — quiet until the state changes)
rather than repeating every check:

- **10% above basis** — consider adding more.
- **Stagnant** — 30+ days since the last purchase with under 2% profit. A fresh lot
  resets this immediately, since the day-count is always recomputed from the lots
  rather than tracked separately.
- **Every 3% of appreciation** — a suggestion to raise your stop. This one ratchets:
  it only fires on newly-reached territory, so a pullback into a band you've already
  been notified about doesn't re-fire.

Like `alert check`, this writes `reports/holdings_alerts_<timestamp>.csv` only when
something fires — a third distinct prefix alongside `breakout_report_*` and
`alert_triggers_*`. None of these three conditions need 5–15-minute resolution the
way trailing and volume alerts do, so a coarser cadence (daily) is reasonable, which
is why **it is not part of the scheduled run**.
