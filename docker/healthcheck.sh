#!/bin/sh
# Healthy while scheduled runs are still completing. This means "the scheduler is
# alive", not "the Schwab login is valid": an expired login makes every run exit
# 3, but supercronic carries on and the run publishes the warning, and reports it
# through HEALTHCHECK_URL/fail rather than by marking the container unhealthy.
# (run-check.sh touches the heartbeat whatever the exit code.)
set -eu
# Three missed 15-minute runs (docker/crontab) plus slack for a slow one.
[ -n "$(find /tmp/last-run -mmin -50 2>/dev/null)" ]
