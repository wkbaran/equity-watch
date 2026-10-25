# Spread stops

Stop alerts for option credit spreads, set by spread-book, a separate project that
reads the spreads from OptionStrat exports and runs on the same Docker host. spread-book
works out, twice a trading day, the stock price at which each spread's loss would reach
its stop (25% of max loss) today, and equity-watch watches those prices every 15 minutes
in between.

## How they get here

spread-book writes `/shared/spread-alerts.json` (the directory shared for the betas job)
after each of its runs: the complete set of stops it wants, one per open put or call
spread. `spreads sync`, early in every scheduled run, reconciles `spread-stops.json`
against it:

| In the file | What happens |
|---|---|
| a new key | a stop is added, watching from the safe side of its level |
| a known key at a new level | the level moves in place, and is judged afresh |
| `unpriced` | left as it is: the spread is open but spread-book had no stock price for it today |
| a live key that is absent | cancelled: the spread was closed |

Nothing changes when the file is missing, unreadable, from an older snapshot than the
last one synced, marked `complete: false`, or holds an entry this version can't read. A
broken export must never read as every spread closing. The key is the spread's name,
expiration and strikes plus an episode number, so a spread closed and reopened is a new
stop.

`spreads check`, after `alert check`, judges each live stop the way a static alert is
judged (minute-bar closes since the last check, the regular-session quote, extended-hours
bars only). A put spread's stop fires on a fall through its level, a call spread's on a
rise. **It fires once per level**: chop around the level is the same event. The next
sync's new level re-arms it, so a spread that stays past its stop is reported again after
each spread-book run.

## Paper trades

spread-book also keeps a paper book: spreads opened at live quotes and never placed. It
writes their stops to `/shared/paper-spread-alerts.json` (`SPREAD_PAPER_ALERTS_FILE`), the
same format with `book: "paper"` and every key prefixed `paper:`. `spreads sync` reads it
after the real file, and **each file reconciles only its own book**: the real file can't
cancel a paper stop, nor the paper file a real one. A key in the wrong book refuses the
file. No paper file is the usual case and is skipped quietly.

A paper stop is judged like any other, and says so everywhere: a dashed *paper* tag on its
row, "Paper" at the start of its toast and log line, and its spread-book link opens the
paper book (`paper/?spread=`). Unlike the real book, spread-book knows when a paper trade
closes (its ledger records it), so an empty paper file is a real "everything closed".

## Where they show

- The overview's **Spread stops** section: fired stops first, then the rest by distance
  to their level. Each row reads "CRM 260/270 call, expires 2026-11-20: (spread $3.39,
  short Δ 0.44)" over "Stop above 252.91, Now 248.51", with an *at stop* tag once it has
  fired, and two links, each in a tab of its own that later clicks reuse:
  - **spread-book**: the report, opened on that spread (`?spread=`). Shown when
    `SPREAD_BOOK_URL` is set in `.env` (the report's address; it stays out of the repo).
  - **OptionStrat**: the saved trade, which shows the quantity. Its link travels only in
    the encrypted vault, so the pill appears once the page is unlocked.
- A new fire is a toast and, with the tab in the background, a system notification, like
  a trigger. Same limit: only while a tab is open.
- `spreads list`, and the run log (`! SPREAD STOP ...`).

What they are not: a stock price is a stand-in for the spread's own price, which can
reach the stop with no move in the stock (an IV spike, time decay near expiration). A
fire says "check the spread's price", never "close it".

## What is kept apart, and why

Spread stops are not in `alerts.json` and never touch the revisit queue. The main book's
rules would misfire on them: one alert per symbol and side, "acting on a symbol closes
its revisits", `holdings cover`, and the dashboard's edit ops (spread-book would undo an
edit at the next sync). They are read-only on the page.

The published `dashboard.json` names each spread and carries per-share prices, never the
contract count, the credit or the OptionStrat link: size and value stay private
(CLAUDE.md). The link goes in `vault.json` as `spreadLinks`, keyed by stop.

## Commands

| | |
|---|---|
| `spreads sync [--file <path>] [--paper-file <path>]` | reconcile with spread-book's files (default `/shared/spread-alerts.json`, or `SPREAD_ALERTS_FILE`, and `/shared/paper-spread-alerts.json`, or `SPREAD_PAPER_ALERTS_FILE`). Fetches nothing |
| `spreads check` | judge live stops against quotes; skips outside market sessions like `alert check` |
| `spreads list` | the live stops and whether each has fired at its level |

All take `--spread-stops-file` (default `spread-stops.json`, gitignored).
