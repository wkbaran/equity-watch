#!/bin/bash
# One scheduled run, as supercronic starts it: scripts/check-and-publish.sh, then
# the heartbeat the container healthcheck reads and the healthchecks.io ping.
# supercronic doesn't start a run while the previous one is still going.
set -u

code=0
/app/scripts/check-and-publish.sh || code=$?
touch /tmp/last-run

# Same convention as check-and-publish.ps1: <url> on success, <url>/fail otherwise.
# Exit 3 (Schwab login expired) counts as a failure, which is the point.
if [ -n "${HEALTHCHECK_URL:-}" ]; then
  suffix=""
  [ "$code" -eq 0 ] || suffix="/fail"
  curl -fsS -m 10 --retry 3 -o /dev/null "${HEALTHCHECK_URL%/}$suffix" || echo "healthcheck ping failed"
fi

[ "$code" -eq 0 ] || echo "run exited $code"
exit "$code"
