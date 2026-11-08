#!/bin/sh
# Hidden overlay snapshots (never shows a window): ./snapshot.sh <outDir> [scenario:keys ...]
# Each spec is scenario or scenario:keys (keys = comma list of events fired in the page, e.g. rewind, pause, late). Scenarios are defined in fixtures.cjs.
# Layout: WINGMAN_OVERLAY_LAYOUT=full (default is focus). Default set: full, empty, listening, waiting, consent, overflow, quiet(pause), full+rewind. Run from anywhere.
# v2 window: specs named v2-* (or "v2all" for the whole v2 set) come from fixtures-v2.cjs and run through snap2.cjs. Keys there: light, dark, s, m, l.
#   WINGMAN_OVERLAY_LANG=en|he picks the window language. Add --check to also run the clipping / contrast / min-font / dir checks (JSON line per spec, exit 1 on any issue).
#   ./snapshot.sh /tmp/out v2-answer v2-long:light,l v2-recap        or        ./snapshot.sh /tmp/out --check v2all
HERE="$(cd "$(dirname "$0")" && pwd)"; OUT="${1:-/tmp/wingman-overlay-snaps}"; shift
mkdir -p "$OUT"
CHECK=""; V2=""; OLD=""
for spec in "$@"; do
  case "$spec" in
    --check) CHECK="--check" ;;
    v2all) V2="$V2 $(node -e 'console.log(require(process.argv[1]).ALL.join(" "))' "$HERE/fixtures-v2.cjs")" ;;
    v2-*) V2="$V2 $spec" ;;
    *) OLD="$OLD $spec" ;;
  esac
done
RC=0
if [ -n "$V2" ]; then
  # shellcheck disable=SC2086
  "$HERE/../node_modules/.bin/electron" "$HERE/snap2.cjs" "$OUT" $CHECK $V2 2>/dev/null || RC=$?
fi
if [ -n "$OLD" ] || [ -z "$V2" ]; then
  # shellcheck disable=SC2086
  set -- $OLD
  [ $# -eq 0 ] && set -- full empty listening waiting consent overflow quiet:pause full:rewind
  for spec in "$@"; do
    sc="${spec%%:*}"; keys=""; case "$spec" in *:*) keys="${spec#*:}";; esac
    name="$sc${keys:+-$keys}"; dir="$(mktemp -d)"
    node "$HERE/fixtures.cjs" "$sc" "$dir" || exit 1
    WINGMAN_CALLS_DIR="$dir" WINGMAN_OVERLAY_SNAPSHOT="$OUT/$name.png" WINGMAN_OVERLAY_SNAPSHOT_KEYS="$keys" \
      "$HERE/../node_modules/.bin/electron" "$HERE/main.cjs" >/dev/null 2>&1
    rm -rf "$dir"; echo "$OUT/$name.png"
  done
fi
exit $RC
