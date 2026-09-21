#!/bin/sh
# Prepare /data, then run the command as the unprivileged `node` user.
set -eu

# The CLI's default --config is analysis.config.json in the working directory.
# Seed it once from the copy baked into the image; after that /data owns it, so
# edits to it survive rebuilds.
if [ ! -f /data/analysis.config.json ]; then
  install -m 0644 -o node -g node /app/analysis.config.default.json /data/analysis.config.json
fi

# `docker cp` and bind mounts both bring in files the node user can't write.
# Only walk the tree when something is actually wrong, since .cache can be large.
if [ -n "$(find /data ! -user node -print -quit)" ]; then
  chown -R node:node /data
fi

exec setpriv --reuid=node --regid=node --init-groups "$@"
