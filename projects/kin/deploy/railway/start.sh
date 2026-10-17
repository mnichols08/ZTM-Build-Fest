#!/bin/bash
# Runs Kin and Caddy together; if either stops, the container stops so
# Railway restarts it.
#
# Before Kin starts it also protects the data:
#   1. Refuses to start unless $KIN_DATA_DIR is a mounted volume, so a missing
#      volume can't silently wipe every household on the next deploy.
#   2. Takes an integrity-checked backup of the existing database into
#      $KIN_DATA_DIR/backups and keeps the newest $KIN_BACKUPS_KEEP (default 10).
#   3. If KIN_RESTORE_FROM names a backup, restores it once (README: "Roll back
#      or move data").
set -euo pipefail
: "${KIN_ORIGIN:?Set the KIN_ORIGIN variable to the public https:// address, for example https://kin.yourdomain.com}"
export PORT="${PORT:-8080}"
data="${KIN_DATA_DIR:?KIN_DATA_DIR must be set}"
backups="$data/backups"
database="$data/kin.sqlite"
keep="${KIN_BACKUPS_KEEP:-10}"
log() { printf '{"event":"%s","message":"%s"}\n' "$1" "$2"; }

is_mounted() {
  if command -v mountpoint >/dev/null; then mountpoint -q "$1"
  else grep -qs " $1 " /proc/self/mountinfo; fi
}
if ! is_mounted "$data"; then
  if [ "${KIN_ALLOW_EPHEMERAL_DATA:-}" = "true" ]; then
    log data_ephemeral "$data is not a volume. Every redeploy erases all households (KIN_ALLOW_EPHEMERAL_DATA=true)."
  else
    log startup_failed "$data is not a mounted volume, so every redeploy would erase all households. Attach a Railway volume at $data, or set KIN_ALLOW_EPHEMERAL_DATA=true to accept that."
    exit 1
  fi
fi

# Railway mounts volumes owned by root; Kin runs as the node user.
mkdir -p "$data" "$backups"
chown node:node "$data" "$backups"
as_node() { setpriv --reuid=node --regid=node --init-groups -- "$@"; }
admin() { as_node node /app/server/admin.mjs "$@"; }

if [ -f "$database" ]; then
  stamp="$(date -u +%Y%m%dT%H%M%S%3NZ)"
  if admin backup "$backups/kin-$stamp.sqlite" >/dev/null; then
    log backup_created "$backups/kin-$stamp.sqlite"
  else
    log backup_failed "Couldn't back up $database before starting; starting anyway."
  fi
else
  log database_new "No database in $data yet; Kin starts with no households."
fi

if [ -n "${KIN_RESTORE_FROM:-}" ]; then
  marker="$backups/.restored-$(basename "$KIN_RESTORE_FROM")"
  if [ -e "$marker" ]; then
    log restore_skipped "$KIN_RESTORE_FROM was already restored. Remove KIN_RESTORE_FROM."
  else
    admin restore "$KIN_RESTORE_FROM" --acknowledge-deletion-history
    as_node touch "$marker"
    log restore_finished "Restored $KIN_RESTORE_FROM. Remove KIN_RESTORE_FROM so it isn't applied again."
  fi
fi

# Keep the newest $keep startup backups, never the one named by KIN_RESTORE_FROM.
for old in $(ls -1t "$backups"/kin-*.sqlite 2>/dev/null | tail -n "+$((keep + 1))" || true); do
  [ "$old" = "${KIN_RESTORE_FROM:-}" ] || rm -f -- "$old"
done

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
