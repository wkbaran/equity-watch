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
node dist/cli.js alert check
node dist/cli.js dashboard --site site --publish --skip-unchanged --quiet
