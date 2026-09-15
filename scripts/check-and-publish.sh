#!/usr/bin/env bash
# Poll alerts, then publish the browser dashboard if anything changed.
# Meant for cron, e.g. every 2 minutes on weekdays:
#   */2 * * * 1-5 /path/to/repo/scripts/check-and-publish.sh >> /path/to/repo/logs/cron.log 2>&1
#
# `alert check` exits quickly outside market hours without fetching quotes, and
# `dashboard --skip-unchanged` fingerprints before fetching quotes, so a quiet
# run costs no API calls.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== $(date -Is) ==="
# Dashboard changes first, so the check evaluates them. A failure doesn't stop the check.
node dist/cli.js ops pull || echo "ops pull failed; continuing with the check."
node dist/cli.js alert check
node dist/cli.js dashboard --site site --publish --skip-unchanged --quiet
