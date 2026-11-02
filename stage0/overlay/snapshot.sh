#!/bin/sh
# Hidden overlay snapshots (never shows a window): ./snapshot.sh <outDir> [scenario:keys ...]
# Default set: full, empty, consent, overflow, quiet(pause), full+rewind. Run from anywhere.
HERE="$(cd "$(dirname "$0")" && pwd)"; OUT="${1:-/tmp/wingman-overlay-snaps}"; shift
mkdir -p "$OUT"
[ $# -eq 0 ] && set -- full empty consent overflow quiet:pause full:rewind
for spec in "$@"; do
  sc="${spec%%:*}"; keys=""; case "$spec" in *:*) keys="${spec#*:}";; esac
  name="$sc${keys:+-$keys}"; dir="$(mktemp -d)"
  node "$HERE/fixtures.cjs" "$sc" "$dir" || exit 1
  WINGMAN_CALLS_DIR="$dir" WINGMAN_OVERLAY_SNAPSHOT="$OUT/$name.png" WINGMAN_OVERLAY_SNAPSHOT_KEYS="$keys" \
    "$HERE/../node_modules/.bin/electron" "$HERE/main.cjs" >/dev/null 2>&1
  rm -rf "$dir"; echo "$OUT/$name.png"
done
