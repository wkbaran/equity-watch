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

A single position can also be covered from the browser dashboard — **Cover with an
alert** on a position that has none, which queues a `holdings.cover` op for that one
symbol. It runs the same selection rule, so it refuses a symbol that has since
gained a live alert (naming what it has) and one on the ignore list. Useful when you
don't want to wait for the next scheduled pass, or right after removing an alert.

Going the other way, an alert's details panel has **Add lot** (unlocked page only). It
opens Holdings in the same reused tab the `held` tag uses, at
`#/holdings/<symbol>/add-lot`, with the Add a lot form's symbol filled in, and its
account too when every existing lot of that symbol is in one account.

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

The browser dashboard shows the first two as *state* on each holdings row
(`+10% over basis`, `stagnant`) without running this command at all: they are pure
functions of the position, so the page works them out from the decrypted rows. The
third is an event — it depends on which bands have already been reported, which is
recorded in `holdings.json` and never leaves the machine — so only this command can
tell you about it.

Each row also shows two volatility figures and flags its stop:

- **Beta** is Schwab's 5-year figure, from the same `.cache/beta/` the analysis uses
  (`dashboard` fetches it once for a newly held symbol). It is information only. Beta
  measures how much of a stock's movement tracks the market, not how much it moves,
  so it says little about where a stop belongs. A negative beta moves against the
  market; it doesn't move less.
- **ATR** is the 14-day average true range: the stock's typical daily swing,
  including overnight gaps, shown as a percent of the price (hover for dollars).
  It uses Wilder's smoothing, like charting tools do, over completed daily bars
  only. The first `dashboard` run of each trading day fetches one daily-bar
  request per held symbol; later runs that day read `.cache/bars/`.
- **`no stop`**: the position has none. Not shown for an ignored (cash-parking)
  position. Its title suggests one by the same trail as below (2 ATR under the high
  close since purchase, or under today's price when that is higher), or says the
  trail would already have exited when that stop would sit at or above the market.
- **`stop tight`** / **`stop loose`**: the nearest stop is off the **2 ATR** target
  (`STOP_ATR_MULTIPLE`) by more than **0.1 ATR** (`STOP_ATR_BAND`). Under 1.9 ATR it
  sits inside the stock's ordinary noise; over 2.1 ATR a reversal gives back more
  than it needs to. Between the two, no pill. The distance is measured the way a
  trailing (chandelier) stop is set: from the **highest close since the earliest
  lot's purchase date**, or today's price when that is higher. Measuring from the
  price alone would call a well-set stop tight after an ordinary pullback and
  suggest lowering it, which a trailing stop never does. Not from basis either:
  that is the initial stop, and on a winner it would hand back the gains. The
  title says which reference it used, how many ATRs of room the stop has, and
  where 2 ATR would put it. With no ATR or no quote, neither pill is judged; a
  price at or under the stop is always `stop tight`.
- **`past trail`**: the price is already 2 ATR or more under its high close since
  purchase, so a 2 ATR trailing stop would have exited and the stop it implies sits
  at or above the market, where no sell stop can go. Shown instead of `stop
  loose`, because the question is whether to stay in, not where to move the stop.

## In the browser

With editing unlocked, `#/holdings` shows the same positions, lots and stops, and
can change them: add and edit lots, sell shares, add, edit and remove stops, and
cover a position that has no alert. Everything here is queued and applied by the
next scheduled `ops pull`, exactly like an alert edit.

### Selling

**Sell from position** (beside *Add to position*) or a lot's own **Sell** opens a
*Sell* band under the lots. It asks for:

- **Shares to sell.** Prefilled with everything in scope, so a full exit is
  one click. Any amount works, including part of a lot.
- **Price.** Left empty, the sale is recorded at the price the page shows for
  the position. The note under the band says how old that price is, because a
  quiet run can leave it half an hour stale. With no price on the page you have
  to type one.
- **Sold on.** Today unless you change it. A backdated sale is placed on its
  date in the story.
- **A stop triggered this sale** (unticked by default). Tick it when the broker
  sold you out at a stop, so the stop strategy can be judged later (below).
- **Take from** (only when there is more than one lot). *Oldest lots first* is
  the brokers' default (FIFO). The other choices are oldest first within one
  account (offered when the lots span accounts) or one specific lot. A sale
  happens in one account, so pick the account when you are selling part of a
  position held in two.

While the band is open, the lots table shows the result before you queue anything.
The table lists the newest purchase first, so an oldest-first sale fills from the bottom up.
A *Selling* column says what each lot gives up ("all 10", "2 of 5"), a bar under
each lot's share count fills by the fraction taken, and lots the sale doesn't
reach are dimmed. Under the fields is the realized result against those lots'
basis, and what is left ("Leaves 3 shares", or "Closes the AA position and
removes its stop").

Whole lots are removed, and a partly sold lot keeps its id, date and basis with
the shares that remain. Selling the last share closes the position, the same as
removing its last lot did. The sale (shares, price, date, and which lots at what
basis) is kept in `holdings.json` under `sales`, for later analysis. Like
everything in that file, it never leaves the machine except inside the vault,
where the symbol's story tells it: shares, price, and the result against what
they cost. The page doesn't list past sales.

**Stop-triggered sales.** A ticked sale carries `stopHit` in `holdings.json`:

```json
"stopHit": { "atr": 3.1, "stops": [{ "stopPrice": 46, "count": null, "createdAt": "..." }] }
```

`stops` is every stop the symbol had when it sold, copied by the worker because
selling the last share deletes them. `atr` is the ATR(14) the page showed when
the sale was queued (`null` if it had none). Together with the sale's price and
lots that is enough to compute the stop's distance in ATRs, the slippage past
the stop, and the result against basis. A sale without `stopHit` is *not marked*,
not known to be a discretionary exit; sales before 2026-10-08 can't be told.

**Remove without a sale** in the same band deletes the chosen lot, or the whole
position, with nothing recorded. Use it for a lot entered by mistake.

An expanded position ends with its **Story** band: the alerts on that symbol
woven together with your buys and sales, once it has one.

None of it is in the published document. The site has no login by default, so
`dashboard.json` carries no share count, basis, market value or stop; the page reads
them from `vault.json`, which is AES-256-GCM sealed under the ops token and
decrypted in the browser after unlocking. The one holdings fact allowed to travel in
the clear is *that* a symbol is held, which is what the `held` tag rides on. The
full model is in [ARCHITECTURE.md](ARCHITECTURE.md#holdings-are-encrypted-in-the-browser-not-hidden-by-the-page).
