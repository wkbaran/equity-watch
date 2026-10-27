# Webull Trading Plan

Driving trading in the two Webull accounts (margin and Roth), which hold most
of the stock positions in `holdings.json`, from equity-watch through Webull's
OpenAPI. Reading positions, fills, balances and orders comes first, then stops,
then buys and sells. Alerts track what you may want to buy, so the end state is
buying from the alert that fired, with the Webull app as the fallback.

Status: **all six phases built** (2026-10-25). Phases 1-3 have run against the
real accounts; **no order has been sent yet** (phases 4-6), and none will be until
`WEBULL_ORDERS=on`. As built, the order path differs from the plan below in four
ways: every order op (stops and Sell BIL to cover included) went through the order
watcher and the authenticator from the start, rather than phase 4 sending under
the ops token alone; the code is per order, with no 15-minute unlock window;
agents get no order tools at all; and the page offers plain GTC stops, not
trailing ones (Webull allows trailing stops only as DAY orders). The original
status line follows.

Phases 1 and 2 built (2026-10-25), not yet run against Webull:
that needs an approved API application (App Key and Secret). The signature
reproduces Webull's worked example, and the rest is tested against response shapes
from Webull's reference. What is assumed until the first real run is listed under
[Assumptions to check](#assumptions-to-check). How to use it is in
[HOLDINGS.md](HOLDINGS.md#syncing-from-webull).

## Why

`holdings import` reads Webull's holdings export, which Webull does not support
(see [HOLDINGS.md](HOLDINGS.md#importing-from-webull)): its `Quantity` column is
wrong, it has no purchase dates, and it is manual. Sales are entered by hand on the
dashboard, and stops are record-keeping only, typed in separately from the real
orders at the broker, so the two can disagree without anyone noticing.

## Scope

- **Stocks and ETFs only.** Options at Webull (an occasional long LEAP) are skipped
  by the sync and not modelled. Spreads are held elsewhere (Robinhood, moving to
  tastytrade) and belong to spread-book.
- **Two accounts**, margin and Roth. Whether the API reaches the Roth account is
  not documented. The account list is the first call to make once there is a key.

## What the API offers

From Webull's docs and its Python SDK (`webull-inc/webull-openapi-python-sdk`),
checked 2026-10-25:

- **Accounts:** account list, balances and positions.
- **Orders:** place, preview, replace and cancel (`/trading/orders/place` and
  friends), open orders, order history (defaults to the last 7 days; page through
  a date range for more) and order detail by `client_order_id`. History and the
  open-order list may lag, and the docs say to use order detail for current status.
- **Stop orders for stocks:** `order_type` `STOP_LOSS` (`stop_price`),
  `STOP_LOSS_LIMIT` (`stop_price`, `limit_price`) and `TRAILING_STOP_LOSS`
  (`trailing_type` `AMOUNT`/`PERCENTAGE`, `trailing_stop_step`), with
  `time_in_force` `DAY` or `GTC`. Replace changes `stop_price` and `quantity` in
  place.
- **Trade events:** a gRPC subscription to order and position events. Not needed
  for the scheduled sync. The order watcher (see Trading) could use it to learn
  of fills within seconds instead of polling order detail.
- **Auth:** an App Key and Secret sign each request. A token is created by API call
  and activated by entering an SMS code in the Webull app within 5 minutes. It then
  lasts until 15 days pass with no call. A scheduled job keeps it alive, so the SMS
  step comes back only after two idle weeks. Sandbox tokens need no SMS.
- **No read-only scope.** The key that reads positions can also trade. Trading is
  the goal anyway, so this costs nothing extra, but it means order authorization
  has to come from equity-watch itself (see Security).
- **No official Node SDK.** Request signing is written here, in
  `src/providers/webull.ts`, beside `schwab.ts`.

To verify when there is a key, since the docs do not say:

- whether a Roth IRA account is listed and readable;
- how long a GTC order lasts before Webull expires it;
- whether stops placed in the Webull app carry a `client_order_id`, which replace
  and cancel need;
- the fill fields in order history (price, quantity, time) and how far back they
  go;
- which balance fields each account type returns: cash, settled versus unsettled
  cash, and how the Roth (a cash account) differs from margin;
- how fractional shares appear in positions, and that a stop for a fractional
  quantity is refused.

## The model: a holding is an account and a symbol

Webull reports one position per account and symbol, so that pair is the unit the
sync owns. Today a holding is implicit, just the lots sharing `symbol` and
`account`. A small new record makes it explicit:

```ts
interface Holding {
  account: string;          // the existing lot label: "margin", "roth"
  symbol: string;
  source: "webull" | "manual";
  linkedAt?: string;        // the Webull read the lots were taken from or checked against
  booked?: Record<string, number>;  // shares of each Webull order already written
  ignored?: boolean;        // an unmatched position the person chose to leave out
}
```

As built, `holdings.json` also keeps the last read as `webull` (cash per account,
the unmatched and linkable positions with what Adopt would write, and the flags),
which the page shows and the Adopt and Link ops act on. `ops pull` never reads
Webull itself.

- **Account mapping** in config: each label (`margin`, `roth`) maps to a Webull
  account id. Only mapped accounts are synced. The ids live in local config, never
  in the repo.
- **A `webull` holding belongs to the sync.** Its lots and sales are written by
  the sync. The page hides lot editing for it, and `ops apply` rejects `lot.*` and
  `position.remove` ops aimed at it, so a hand edit and the next sync never fight.
- **A `manual` holding is left alone.** If Webull holds the same symbol in that
  account and disagrees, the page shows a difference badge. Nothing is rewritten.
- `computeBasis` keeps blending across accounts, as it does now.

## Syncing a webull holding

Each run compares Webull's quantity `Q` and average cost `C` with the local lots'
total `q` and blended basis `c`:

| Webull vs local | What the sync does |
|---|---|
| `Q > q` | A buy. A new lot with the price and date of the matching fills. With no fills found it is flagged, not applied (as built: the `(Q·C − q·c)/(Q − q)` estimate this row first proposed was dropped, because Webull's history can lag, and the fill usually turns up on a later run). |
| `Q < q` | A sale, through the same code as the dashboard's Sell (oldest lot first), at the fills' price and date. A fill from a stop order sets `stopHit`. A shrink with no matching fill is flagged, not applied. |
| position gone | A full exit: the same as selling the last share, which removes its stops. |
| `Q ≠ q`, no fills | Likely a split or other corporate action. Flagged, never booked as a trade. |
| `Q = q`, `C ≠ c` | Flagged only, at first. Webull's average cost and the local lot-based basis may legitimately differ after partial sales. Look at real data before deciding whether to tolerate it. |

Fills are matched by order id, which is recorded on the lot or sale, so a fill is
never booked twice even if the order history window overlaps runs. As built, each
holding keeps the shares booked per order (`booked`), so a partly filled order
books its new shares later, and an order that shows up late is still booked.

## Positions not in the record

A Webull position with no holding goes on an **Unmatched** list on the Holdings
page:

- **Adopt** creates a `webull` holding, with lots built from its fills (real
  purchase dates), or one lot at Webull's average cost when the fills don't reach
  back far enough.
- **Ignore** remembers the choice, so it doesn't come back each run.

A `manual` holding that Webull also holds is offered **Link**. When the totals
agree, it keeps the existing lots, with their dates and story history, and
switches to `webull`. When they don't, it shows the difference first. This is how
today's CSV-imported lots move over.

New positions never become `webull` holdings without an Adopt.

## Stop orders

For a `webull` holding, the stops are the real open sell-stop orders at Webull,
not separate records.

**Monitoring** (read only):

- Each run reads open orders and mirrors the stock sell stops into the holding's
  stops, including ones placed in the Webull app. Each mirrored stop keeps its
  order id, type (stop, stop-limit or trailing), quantity and time in force.
- The existing pills then judge real orders: `no stop`, `stop tight`,
  `stop loose`, `past trail`. Two more join them:
  - `stop short`: the stops cover fewer shares than are held, as after a buy.
  - `stop expires`: a GTC order close to Webull's expiry.
- A stop that fills shows up as a sale with `stopHit` set, with no ticking a box.
- A stop that disappears without a fill (cancelled or expired) turns the holding
  into `no stop`, and gets a notification.

**Managing** (sends orders):

- The page's add, edit and remove stop controls, on a `webull` holding, queue new
  ops: `stop.place`, `stop.replace`, `stop.cancel`. `ops pull` applies them at the
  next scheduled check, as with every other edit. There is still no "apply now".
- A one-click **Set to suggested** queues a replace (or a place) at the 2 ATR trail
  the page already suggests.
- Guards before any order is sent:
  - sell side only, stock only, and only on a `webull` holding;
  - **whole shares only**: Webull takes stops for whole shares, so the quantity is
    an integer, at most the whole shares held in that account, less shares other
    open sell orders already cover. A fractional remainder (0.4 of a share) can
    never have a stop. `stop short` judges coverage against the whole shares held,
    so it doesn't fire for the fraction alone, and the page says the fraction is
    uncovered;
  - a sell stop below the last price (otherwise it would trigger at once);
  - an `expect` check like the alert ops': the op names the order and stop price
    the page showed, and it is refused if the order has changed since;
  - `time_in_force` `GTC`, regular session only.
- Orders equity-watch places get a `client_order_id` with an `ew-` prefix, so it
  can tell its own orders from the app's. It manages either kind, as far as
  replace and cancel allow.
- Every order sent and every response is written to `ops.log.jsonl`. The op id is
  the idempotency key, so a redelivered op never places a second order.
- A config switch, `webull.orders`, off by default. With it off, the stop ops are
  refused and the sync is read only.

A `manual` holding keeps today's record-keeping stops, unchanged.

Stops are never offered or placed on cash equivalents (below).

## Cash, BIL and never using margin

Each account's cash is parked in BIL (a 1–3 month T-bill ETF) and moved back out
to buy. So the number that matters is **cash + BIL**, not cash alone, and the
rule in both accounts is: never borrow.

**Tracking:**

- Each run reads each mapped account's balances (cash, settled cash where
  Webull reports it, and total value) and keeps the latest per account in
  `holdings.json`, with when it was read.
- A new config list, `cashEquivalents: ["BIL"]`, names the symbols counted as
  cash. It is separate from `ignoreSymbols`, which means "no alerts" and already
  holds BIL. The two usually agree, but they mean different things.
- The Holdings page shows each account's cash, its BIL value and their sum,
  above that account's positions. Like everything else from `holdings.json`, the
  figures travel only inside the vault.
- BIL is synced like any other holding, lots and sales included, so moving cash
  in and out of it leaves a record. It gets no stops, no starting alert and no
  stop pills.

**Margin account:** cash can go negative there, for example when a buy settles
before the BIL sale that pays for it. Negative cash is borrowing, and Webull
charges interest on it. Each run judges:

| State | Warning |
|---|---|
| cash + BIL under the low-water mark | **Low on cash**: dry powder is running out. |
| cash below zero, BIL covers it | **Using margin**: sell about N shares of BIL to cover (N from BIL's last price, rounded up), with a **Sell BIL to cover** button. |
| cash + BIL below zero | **On margin**: borrowing that BIL can't cover. The loudest of the three. |

The low-water mark is configurable, as a dollar amount per account
(`webull.lowCash`). "Using margin" and "On margin" are the reason to check every
run, not daily, and they notify once on entering the state, like the other
crossing alerts, then show as state on the page until cleared.

**Sell BIL to cover** queues a `cash.cover` op for the margin account. It is the
first order besides stops that equity-watch sends, ahead of general trading (see
Trading), and it does exactly one thing:

- **The share count is worked out when the op is applied, not on the page.**
  `ops pull` rereads the account's cash, BIL position and open orders, and sells
  `ceil(−cash / price)` whole shares of BIL, capped at the whole BIL shares held.
  The page's N is a preview. If cash is no longer negative (a sale or deposit
  already covered it), the op is refused as already covered.
- **One at a time.** If an open sell order for BIL already exists in that account,
  the op is refused, so two clicks or a redelivered op can't sell twice. The op id
  is the idempotency key, as for stops.
- **Limit order, regular session, `DAY`.** A limit at the bid (since 2026-10-26;
  it was a few cents under the last price) rather than a market order. BIL trades in a narrow band, so it fills, and a bad
  print can't sell it cheap. Outside the regular session the button is disabled,
  and an op that arrives after the close is refused rather than sent for the next
  day.
- **Margin account and `cashEquivalents` only.** The op names no symbol and no
  quantity, so it can't be turned into another sale. When BIL doesn't cover the
  whole shortfall ("On margin"), it sells all the whole BIL shares held and says
  how much is still borrowed.
- **Behind `webull.orders`,** like stop management.

The proceeds settle T+1, so the debit clears the next business day, not the moment
the sale fills.

**Roth account:** there is no margin, so a buy needs cash first, and BIL has to
be sold before buying anything else. The page shows the Roth's available cash
next to its BIL, so it's clear how much BIL to sell for a planned buy. The
low-water warning applies here too. Once buys go through equity-watch, a
funded buy sells the BIL first by itself (see Trading). Until then, and for buys
still placed in the Webull app, two things the sync can see after the fact but not
prevent:

- A buy rejected for want of cash shows up as a rejected order in history. It
  gets a notification, since it means BIL wasn't sold first.
- Trades settle T+1. Buying with BIL proceeds that haven't settled is allowed in
  a cash account, but selling those new shares before the proceeds settle is a
  good-faith violation. If Webull reports settled and unsettled cash separately,
  the page shows both.

Not planned: equity-watch ratcheting stops by itself. The page suggests and you
click. Revisit once the managed stops have run for a while.

## Trading through equity-watch

The end state: an alert fires on something you want to own, and you buy it from
that alert. Sells, stops and moving cash in and out of BIL go through the same
page, and the Webull app is only the fallback.

**Order ops**, on top of the stop ops and `cash.cover`:

- `order.buy` and `order.sell`: account, symbol, whole shares, limit price,
  `DAY` or `GTC`, regular or extended session. Limit orders only. Market orders
  are left out deliberately: they can fill far from the price you saw on a gap or
  a thin quote, and Webull doesn't take them outside regular hours anyway.
- `order.replace` and `order.cancel` for any open order the sync mirrors,
  including ones placed in the app.
- The Holdings page gains an **Open orders** list per account: every working
  order, not just stops, with modify and cancel.

**Buying from an alert.** A fired alert, a revisit-queue entry and a Holdings
row each get a **Buy** button. It opens an order ticket filled in with the
symbol, the last price as the limit, and the account. The ticket shows:

- size, typed as shares or dollars, converted to whole shares;
- the cost, and the account's cash + BIL left after it;
- a suggested starting stop at 2 ATR under the price, with a tick box to attach
  it to the buy. Webull takes a buy with an attached stop-loss as one combo order
  (the SDK's samples show one; verify for US stocks). An attached stop leaves no
  gap between the fill and the stop. Without combo support, the watcher places
  the stop as soon as the buy fills.

**Preview.** The browser never talks to Webull, so it can't call Webull's
preview endpoint. The machine previews each order just before placing it, and an
order whose preview fails (cost, buying power, a halted symbol) is refused with
Webull's reason shown on the page.

**Funding, and never borrowing:**

- A buy that would leave **cash + BIL** below zero in either account is refused
  outright.
- **Margin account:** a buy costing more than the cash on hand is refused unless
  **Fund from BIL** is ticked. With it ticked, the op sells enough whole BIL
  shares to cover the shortfall (the `cash.cover` arithmetic) and places the buy
  with it. Both settle T+1, so the sale pays for the buy on the same day and
  nothing is ever borrowed at settlement.
- **Roth:** a cash account, so the BIL sale has to fill first. The op sells BIL,
  waits for the fill, and only then places the buy. If the sale doesn't fill
  within a few minutes, the op stops, cancels the BIL order and reports, instead
  of buying anyway. Buying with unsettled proceeds is normal in a cash account;
  selling the new shares before those proceeds settle is a good-faith violation,
  so a sell or stop on shares bought that way within T+1 shows a warning.

**Latency.** The 15-minute mailbox suits edits and stops, not buys: an alert
that fired at 10:02 shouldn't buy at 10:15. Orders get their own path:

- A separate SQS FIFO queue for order ops only, long-polled by an **order
  watcher** that runs as a second service in the equity-watch container. It
  applies an order within seconds, as spread-book's ticket watcher does.
- Edits (alerts, lots, revisits) stay on the scheduled `ops pull`. The header of
  `src/ops/pull.ts` records why an always-on watcher was rejected for those, and
  that still holds: the reason to change course is that orders are
  time-sensitive, and edits aren't.
- The watcher writes each order's result (accepted, filled, refused with the
  reason) to a small sealed status document, which the page polls while a ticket
  is open. Fills still reach `holdings.json` through the sync, not the watcher.

**Limits**, in local config, checked by the machine before anything is sent:

- the largest order, in dollars;
- the most orders a day;
- which mapped accounts may trade;
- a kill switch: `webull.orders` off refuses every order op, stops and
  `cash.cover` included.

## Phases

1. **Provider and read-only sync, dry run.** `src/providers/webull.ts` (signing,
   token, accounts, balances, positions, order history), the `Holding` record
   and account mapping, and `holdings sync --dry-run` printing what it would
   change. Built against fixtures. **Done 2026-10-25**, except open orders,
   which moved to phase 3, where they're first used.
2. **Applied sync.** `holdings sync` writes lots and sales, the Unmatched list with
   Adopt, Ignore and Link (new ops), and the lot-edit lock on `webull` holdings.
   It runs in the scheduled script after `ops pull` and before `holdings cover`, so
   a new buy gets its starting alert in the same run.
   Account balances, `cashEquivalents`, cash + BIL on the page, and the low-cash
   and margin warnings come with it. **Done 2026-10-25**, with `holding.unlink`
   added. The four new op types need the stack redeployed (the Lambda's
   `TARGET_KEY`). The warnings show on the page and in the run log; equity-watch
   has no push channel.
3. **Stop monitoring.** Mirrored stop orders, the two new pills, and stop-fill
   sales. **Done 2026-10-25.** Webull's docs give GTC orders "typically 60 days",
   so `stop expires` warns from day 53.
4. **Stop management and Sell BIL to cover.** `stop.place`, `stop.replace`,
   `stop.cancel` and `cash.cover`, Set to suggested, and the `webull.orders` switch.
   First live use: one small position, watched in the Webull app.
5. **Order path.** The order queue and watcher, order authorization (see
   Security), the order limits, the sealed status document, and the Open orders
   list with `order.sell`, `order.replace` and `order.cancel`. Stop and
   `cash.cover` ops move onto this path.
6. **Buying.** `order.buy`, the order ticket from alerts, revisits and Holdings
   rows, Fund from BIL in both accounts, and attached stops.

## Assumptions to check

Built before there was an API key, so these came from Webull's reference and SDK,
not from a real response. The first real `holdings sync --dry-run` (2026-10-25,
against a stale local holdings.json) confirmed 1, 2, 3, 5, 6, 7, 8 and 10, marked
below; the rest are still open.

1. **The signature.** *Confirmed:* Webull accepts both HMAC-SHA1 over MD5 (the
   docs) and HMAC-SHA256 (the SDK). The live App Key starts with `us.`; a key
   copied without it gets the same "Invalid credentials" as a made-up one, and so
   does every other credential problem, so that message alone says little.
2. **Response shapes.** *Confirmed.* The account list and positions are top-level arrays; the
   balance is an object with `account_currency_assets`; order history is
   `{ data: [{ orders: [...] }], pagination_key }`, one group per order or combo.
3. **`cost_price` is the average cost per share.** *Confirmed:* positions built
   from several buys average exactly to it.
4. **Stocks are `EQUITY`** in positions and orders. The history example says
   `STOCK`; both are accepted.
5. **`filled_price` is the average over everything filled so far, and
   `filled_time` the last fill.** Lots are dated by the last fill. *Confirmed* for
   prices and dates; partial fills not yet seen.
6. **A negative `cash_balance` in the margin account is a margin debit.** The
   margin warnings rest on it. The Roth is a CASH account, and is assumed to be
   listed and readable like the margin one, with `settled_cash` and
   `unsettled_cash`. *Confirmed* against the app for both accounts; the app's
   cash goes negative while margin is used. The API's negative value itself is
   still to be seen on a day the margin account is in debit.
7. **Order history from 2018-05-21 to now in one range, paged by
   `pagination_key`, returns every order**, and an order's later state replaces its
   earlier one under the same `order_id`. Lag is assumed to be under the three days
   each run re-reads. *Confirmed* for the full read; lag not yet measured. The
   production limit of 2 calls per 2 s drew 429s when kept to exactly, so calls go
   out 1.25 s apart with retries.
8. **The token.** `/auth/tokens/create` with the stored token returns it as
   `NORMAL` while it is still good, so `webull-login` doesn't text a code when none
   is needed. `expires_at` is in milliseconds. Production calls need
   `x-access-token`; the sandbox doesn't. *Confirmed* for creation, the SMS step
   (a push notification in the app, easy to miss) and `x-access-token`; reviving
   a stored token not yet seen.
9. **Splits, spin-offs and dividend reinvestment don't appear as orders.** They
   show up as a share change no fill explains, which is flagged, not applied.
10. **Fractional shares come as decimal strings** in `quantity` and
    `filled_quantity`. *Confirmed* (a fractional position).

Added with the order path, still to check on the first real orders:

11. **Place, replace and cancel take the documented bodies** (`new_orders`,
    `modify_orders`, `client_order_id`), and a repeated `client_order_id` is
    refused. Order Detail finds an order by the client id it was placed with.
12. **A buy with a stop as `MASTER` + `STOP_LOSS` legs** under a
    `client_combo_order_id` is accepted for a stock (the docs' example), with the
    stop leg GTC while the buy is DAY.
13. **Orders placed in the Webull app carry no `client_order_id`.** If so, they
    can't be changed or cancelled from equity-watch (the page says so); if they do
    carry one, they can.
14. **Preview's `estimated_cost` is the order's total cost**, which the
    `ORDERS_MAX_VALUE` and cash checks use.

## Security

- The App Key, Secret and token live with the other credentials on the machine
  that runs the checks. They are never in the repo, the site or the vault. The
  token goes in the same kind of state file the Schwab login uses.
- The browser never talks to Webull. It queues ops through the Lambda and SQS,
  and only the machine sends orders.
- **The ops token alone can't trade.** Today it is the one secret behind every
  edit, and it is kept in `localStorage`. Orders need more: each order op carries
  a TOTP code from an authenticator app, verified by the machine, never by the
  Lambda, against a secret that exists only there. A code could unlock orders for
  a short window (say 15 minutes) rather than one per order. A leaked ops token
  then still queues edits, but no order. In phase 4, before the order path exists,
  stop ops and `cash.cover` go out under the ops token alone, within their guards.
- The limits above cap what even a valid code can do, and every order request and
  response goes to `ops.log.jsonl`. Every fill sends a notification, so an order
  you didn't place is noticed at once.
- Webull account ids and order ids, like everything in `holdings.json`, never leave
  the machine except inside the vault.
