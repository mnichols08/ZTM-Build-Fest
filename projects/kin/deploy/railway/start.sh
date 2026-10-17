#!/bin/bash
# Runs Kin and Caddy together; if either stops, the container stops so
# Railway restarts it.
set -euo pipefail
: "${KIN_ORIGIN:?Set the KIN_ORIGIN variable to the public https:// address, for example https://kin.yourdomain.com}"
export PORT="${PORT:-8080}"

# Railway mounts volumes owned by root; Kin runs as the node user.
mkdir -p "$KIN_DATA_DIR"
chown node:node "$KIN_DATA_DIR"
as_node() { setpriv --reuid=node --regid=node --init-groups -- "$@"; }

as_node node /app/server/server.mjs &
kin=$!
as_node caddy run --config /app/Caddyfile --adapter caddyfile &
caddy=$!

stop() { kill -TERM "$kin" "$caddy" 2>/dev/null || true; }
trap stop TERM INT
status=0
wait -n "$kin" "$caddy" || status=$?
stop
wait || true
exit "$status"
