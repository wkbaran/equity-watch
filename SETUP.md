# Setup

## 1. Install dependencies

```bash
pip install -r requirements-dev.txt   # includes pytest
# or just: pip install -r requirements.txt
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

Export them so the CLI can find them:

```bash
export SCHWAB_APP_KEY=...
export SCHWAB_APP_SECRET=...
```

## 3. First-time login

Schwab access tokens last 30 minutes and refresh tokens last 7 days, so
you'll need to redo this interactive login about once a week:

```bash
python -m tv_alerts.cli schwab-login
```

This opens (or prints) a Schwab login URL, and after you approve access it
asks you to paste back the URL you were redirected to. Tokens are cached
to `~/.tv_alerts/schwab_tokens.json` (override with `--token-path`) and
refreshed automatically after that until they expire.

## 4. Run the analysis

```bash
python -m tv_alerts.cli analyze --csv path/to/TradingView_Alerts_Log.csv --out breakout_report.csv
```

See the README for what the output means and which flags to tune.
