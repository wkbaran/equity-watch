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

# Exit code 3 means the Schwab login expired (7-day refresh token; only a
# browser sign-in renews it). Nothing here can fix that, and every later step
# needing a quote hits the same wall - so skip them and still publish, because
# the dashboard reporting it is the only way anyone finds out. Without this the
# page simply stops changing, which reads as a quiet market.
EXIT_LOGIN_EXPIRED=3
login_expired=0

run_step() {
  local name="$1"; shift
  local code=0
  "$@" || code=$?
  if [ "$code" -eq "$EXIT_LOGIN_EXPIRED" ]; then
    login_expired=1
    return 0
  fi
  return "$code"
}

# Dashboard changes first, so the check evaluates them. A failure doesn't stop the check.
run_step "ops pull" node dist/cli.js ops pull || echo "ops pull failed; continuing with the check."
if [ "$login_expired" -eq 0 ]; then
  # Cover any position that has no alert, whatever added it. Free when all are covered.
  run_step "holdings cover" node dist/cli.js holdings cover || echo "holdings cover failed; continuing with the check."
fi
if [ "$login_expired" -eq 0 ]; then
  run_step "alert check" node dist/cli.js alert check
fi

if [ "$login_expired" -eq 1 ]; then
  echo "*** Schwab login expired. No alerts were checked and queued changes stay queued."
  echo "*** Fix it on this machine with: node dist/cli.js schwab-login"
  echo "Publishing anyway so the dashboard reports it."
fi

node dist/cli.js dashboard --site site --publish --skip-unchanged --quiet

# Still a failed check, even though the bad news got published.
[ "$login_expired" -eq 0 ] || exit "$EXIT_LOGIN_EXPIRED"
