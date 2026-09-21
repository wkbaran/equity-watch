#!/bin/bash
# The container's scheduler: run scripts/check-and-publish.sh every
# CHECK_INTERVAL_MINUTES (default 15, matching the Windows task) until stopped.
#
# There is no market-hours window here. `alert check` exits without fetching a
# quote outside a session and `dashboard --skip-unchanged` fingerprints before it
# fetches, so an overnight run costs nothing, and `ops pull` should drain queued
# dashboard edits whether or not the market is open (see docs/SCHEDULING.md).
set -u

interval=$(( ${CHECK_INTERVAL_MINUTES:-15} * 60 ))
HEARTBEAT=/tmp/last-run

stopping=0
sleeper=""
on_stop() {
  stopping=1
  [ -n "$sleeper" ] && kill "$sleeper" 2>/dev/null
  return 0
}
trap on_stop TERM INT

ping() {
  [ -n "${HEALTHCHECK_URL:-}" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "${HEALTHCHECK_URL%/}$1" || echo "healthcheck ping failed"
}

while [ "$stopping" -eq 0 ]; do
  started=$(date +%s)
  code=0
  /app/scripts/check-and-publish.sh || code=$?
  touch "$HEARTBEAT"

  # Same convention as check-and-publish.ps1: <url> on success, <url>/fail otherwise.
  # Exit 3 (Schwab login expired) counts as a failure, which is the point.
  if [ "$code" -eq 0 ]; then
    ping ""
  else
    echo "run exited $code"
    ping "/fail"
  fi

  # Sleep in the background and wait on it, so SIGTERM cuts the sleep short
  # instead of `docker stop` waiting out the interval.
  wait_for=$(( interval - ($(date +%s) - started) ))
  [ "$wait_for" -ge 1 ] || wait_for=1
  if [ "$stopping" -eq 0 ]; then
    sleep "$wait_for" &
    sleeper=$!
    wait "$sleeper" 2>/dev/null || true
    sleeper=""
  fi
done
echo "stopped"
