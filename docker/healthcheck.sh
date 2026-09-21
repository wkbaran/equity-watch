#!/bin/sh
# Healthy while the loop is still completing runs. This means "the scheduler is
# alive", not "the Schwab login is valid": an expired login makes every run exit
# 3, but the loop carries on and publishes the warning, and reports it through
# HEALTHCHECK_URL/fail rather than by marking the container unhealthy.
set -eu
interval="${CHECK_INTERVAL_MINUTES:-15}"
# Three missed intervals plus slack for a slow run.
[ -n "$(find /tmp/last-run -mmin "-$((interval * 3 + 5))" 2>/dev/null)" ]
