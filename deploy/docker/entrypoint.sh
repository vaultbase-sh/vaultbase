#!/bin/sh
# Runs the server as the unprivileged `vaultbase` user. Started as root (the
# default, and what volume mounts owned by root need), it first makes the data
# folder writable for that user, then drops to it. Started as another user
# (e.g. a Kubernetes securityContext), it runs the command as is.
set -e
data="${VAULTBASE_DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$data"
  # Only when needed: a large data folder already owned by vaultbase is left alone.
  if [ "$(stat -c %u "$data")" != "10001" ]; then chown -R vaultbase:vaultbase "$data"; fi
  exec setpriv --reuid=10001 --regid=10001 --init-groups -- "$@"
fi
exec "$@"
