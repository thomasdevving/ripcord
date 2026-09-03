#!/bin/sh
set -eu
if [ "$(id -u)" = 0 ]; then
  # Only the configured data mount needs ownership; never recurse through /app.
  data_dir="$(realpath -m "${RIPCORD_DATA_DIR:-/data}")"
  case "$data_dir" in /data|/data/*) ;; *) echo "RIPCORD_DATA_DIR must be under /data in this image" >&2; exit 1;; esac
  mkdir -p "$data_dir"
  chown -R node:node "$data_dir"
  exec gosu node "$@"
fi
exec "$@"
