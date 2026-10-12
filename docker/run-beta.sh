#!/bin/bash
# The betas job, as supercronic starts it (docker/crontab): write Schwab's beta for
# each symbol in /shared/underlyings.txt to /shared/betas.json, where another
# container reads it. docs/BETA.md has the file format and the guarantees.
#
# Deliberately not run-check.sh's twin. It does NOT touch /tmp/last-run (the
# container healthcheck reads that as "the 15-minute check is alive") and does NOT
# ping HEALTHCHECK_URL (that is the check's dead-man's switch). An expired login
# already reaches the dashboard and the /fail ping through the check, so this
# job only has to leave the old file alone and say why in the log.
set -u

# Lower than the check's setting, for this process only. The 15-minute check is
# another process with its own rate limiter, so the two cannot see each other's
# calls; this keeps both under Schwab's 120 a minute when they overlap.
export SCHWAB_MAX_REQUESTS_PER_MINUTE=30

cd "${EQUITY_WATCH_STATE_DIR:-/data}"

code=0
equity-watch beta --symbols-file /shared/underlyings.txt --out /shared/betas.json || code=$?

case "$code" in
  0) ;;
  3) echo "beta: login expired, keeping the old betas" ;;
  *) echo "beta: run exited $code, keeping the old betas" ;;
esac
# supercronic logs a non-zero exit, and runs again at the next scheduled time;
# there is no retry here. The reader decides when the file is too old to use.
exit "$code"
