# Setup

## 1. Install dependencies

```bash
npm install
npm run build
```

## 2. Register a Schwab developer app

Market data comes from the Schwab API, not Robinhood or Webull — Schwab is
the only one of your three brokerages with an official, documented API;
Robinhood and Webull only have unofficial/reverse-engineered client
libraries, which isn't something worth building a real workflow on top of.

1. Go to https://developer.schwab.com, sign in, and create an app.
2. Request access to the **Market Data Production** API product.
3. Set the callback/redirect URL to `https://127.0.0.1` (the default this
   tool expects — override with `--token-path`/callback if you use
   something else).
4. Once approved, note the **App Key** and **App Secret**.

Copy `.env.example` to `.env` and fill them in:

```bash
cp .env.example .env
# then edit .env:
#   SCHWAB_APP_KEY=...
#   SCHWAB_APP_SECRET=...
```

`.env` is gitignored and loaded automatically by the CLI, so this persists
across shells (handy on WSL) without re-exporting on every new terminal.
It also has an optional `SCHWAB_MAX_REQUESTS_PER_MINUTE` (default `120`,
Schwab's documented cap) if you want to throttle harder or share quota
with something else calling the API in parallel.

If you'd rather not use a file, exported env vars work the same way and
take precedence over `.env`:

```bash
export SCHWAB_APP_KEY=...
export SCHWAB_APP_SECRET=...
```

## 3. First-time login

Schwab access tokens last 30 minutes and refresh tokens last 7 days, so
you'll need to redo this interactive login about once a week:

```bash
node dist/cli.js schwab-login
```

This opens (or prints) a Schwab login URL, and after you approve access it
asks you to paste back the URL you were redirected to. Tokens are cached
to `~/.tv_alerts/schwab_tokens.json` (override with `--token-path`) and
refreshed automatically after that until they expire.

## 4. Run the analysis

```bash
node dist/cli.js analyze --csv path/to/TradingView_Alerts_Log.csv
```

Each run writes a timestamped report to `reports/` and updates a per-ticker
history under `history/` (see README). See the README for what the output
means and which flags to tune.

## 5. (Optional) Company sector/profile cache

For sector analysis and custom heatmaps, `profile fetch` caches each
ticker's sector, industry, and a short description — data Schwab's API
doesn't provide at all (checked directly against both its quotes and
instruments endpoints). This comes from
[Financial Modeling Prep](https://site.financialmodelingprep.com/) instead,
a free-tier third-party source (not "official" the way Schwab is — pick a
provider you're comfortable with; see README for why this one was chosen
over the alternatives).

1. Sign up at https://site.financialmodelingprep.com/ (free, no payment
   info required) and copy your API key.
2. Add it to `.env`:

```bash
# then edit .env:
#   FMP_API_KEY=...
```

```bash
node dist/cli.js profile fetch --all-known --csv path/to/TradingView_Alerts_Log.csv
```

The free tier caps out at 250 requests/day, tracked across runs in
`.cache/profiles/_budget.json` — `profile fetch` is resumable, so re-running
after hitting the cap only fetches what's still missing.

## Note on TradingView automation

The alerts CSV export and TradingView's "pending" (not-yet-triggered)
alerts have no official API on any plan tier, and scripting the web UI to
scrape them is explicitly against TradingView's Terms of Use (real
account-ban risk). TradingView *does* support real-time alert webhooks
(Essential plan+), which would be the sanctioned alternative to manual CSV
export, but that requires a public HTTPS endpoint and is out of scope here.
So for now: exporting the alerts CSV, and re-arming/editing alerts after
one triggers, both stay manual steps.
