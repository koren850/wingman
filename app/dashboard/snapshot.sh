#!/bin/sh
# Hidden window snapshots of the main window (never shows a window, no call, no network): ./snapshot.sh <outDir> [name:lang:theme:view:fakeCall:focus ...]
# lang = en | he, theme = light | dark, view = home | settings | inbox, fakeCall = live | waiting | ended | - (none), focus = plan | edit | - (none).
# Each run writes <outDir>/<name>.png and <name>.json (the clipping check from clipcheck.js). Invented fixture data only (snapshot-fixtures.cjs).
# Default set: Home and the Meeting context editor in English and Hebrew, light and dark, and a live call with What Wingman knows.
HERE="$(cd "$(dirname "$0")" && pwd)"; OUT="${1:-/tmp/wingman-dashboard-snaps}"; shift
mkdir -p "$OUT"
[ $# -eq 0 ] && set -- home-en-dark:en:dark:home:-:- home-en-light:en:light:home:-:- home-he-dark:he:dark:home:-:- home-he-light:he:light:home:-:- \
  edit-en-dark:en:dark:home:-:edit edit-en-light:en:light:home:-:edit edit-he-dark:he:dark:home:-:edit edit-he-light:he:light:home:-:edit \
  live-en-dark:en:dark:home:live:- live-he-dark:he:dark:home:live:- live-he-light:he:light:home:live:- settings-he-dark:he:dark:settings:-:-
for spec in "$@"; do
  IFS=: read -r name lang theme view fake focus <<EOF2
$spec
EOF2
  data="$(mktemp -d)"; node "$HERE/snapshot-fixtures.cjs" "$data" >/dev/null || exit 1
  fakeEnv=""; [ "$fake" != "-" ] && fakeEnv="$fake"
  WINGMAN_DATA_DIR="$data" WINGMAN_USER_SETTINGS="$data/settings.yaml" WINGMAN_DASHBOARD_SNAPSHOT="$OUT/$name.png" WINGMAN_DASHBOARD_LANG="$lang" \
    WINGMAN_DASHBOARD_THEME="$theme" WINGMAN_DASHBOARD_VIEW="$view" WINGMAN_DASHBOARD_FAKE_CALL="$fakeEnv" WINGMAN_DASHBOARD_FAKE_DOCTOR=ready \
    WINGMAN_DASHBOARD_FOCUS="$([ "$focus" != "-" ] && echo "$focus")" WINGMAN_DASHBOARD_EVAL="${WINGMAN_SNAP_EVAL:-$HERE/clipcheck.js}" WINGMAN_DASHBOARD_SIZE="${WINGMAN_DASHBOARD_SIZE:-1100x900}" \
    "$HERE/../node_modules/.bin/electron" "$HERE/../tray/main.cjs" >/dev/null 2>&1
  rm -rf "$data"; echo "$OUT/$name.png"
done
