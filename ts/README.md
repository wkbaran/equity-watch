# tv-alerts (TypeScript port)

Node/TypeScript port of the root `tv_alerts` Python tool. Same behavior,
same CLI shape, same output columns and verdicts — see the root
`README.md` for what the tool does and how to read the report, and
`SETUP.md` for registering a Schwab developer app and doing the one-time
OAuth login (the flow is identical, just run through this CLI instead).

## Setup

```bash
npm install
npm run build
```

## Run

```bash
npm run cli -- schwab-login          # one-time OAuth login (dev, via tsx)
npm run cli -- analyze --csv ../path/to/alerts.csv --out breakout_report.csv

# or, after `npm run build`:
node dist/cli.js analyze --csv ../path/to/alerts.csv --out breakout_report.csv
```

Same flags as the Python CLI: `--symbol`, `--baseline-days`,
`--volume-ratio-threshold`, `--volume-trend-days`,
`--recent-high-lookback-days`, `--recent-high-tolerance`, `--hold-days`,
`--no-cache`, `--cache-dir`, `--app-key`/`--app-secret`/`--token-path` (or
the `SCHWAB_APP_KEY`/`SCHWAB_APP_SECRET` env vars).

## Tests

```bash
npm test
```

`tests/parse.test.ts` and `tests/analysis.test.ts` mirror the Python
`tests/test_parse.py` / `tests/test_analysis.py` scenario-for-scenario,
including the same CSV fixture (byte-for-byte, mangled unicode and all).
Verified numerically identical to the Python implementation on the same
synthetic OHLCV inputs (same verdicts, ratios, and notes text).
