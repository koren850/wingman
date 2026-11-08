#!/bin/sh
# Hidden window snapshots of the main window (never shows a window, no call, no network): ./snapshot.sh <outDir> [name:lang:theme:view:fakeCall:focus ...]
# lang = en | he, theme = light | dark, view = home | settings | inbox, fakeCall = live | waiting | ended | - (none), focus = plan | edit | - (none).
# Each run writes <outDir>/<name>.png and <name>.json (the clipping check from clipcheck.js). Invented fixture data only (snapshot-fixtures.cjs).
# Optional 7th to 9th fields: open1:open2 = <callId>:<tab> opens a saved call (golden fixture calls 01SNAPGOLDEN{EN,HE}{A,B}000..., A has no summary, B has one), knows = golden | golden-paused | golden-offline | empty (the live notes).
# Default set: Home and the Meeting context editor in English and Hebrew, light and dark, and a live call with What Wingman knows.
HERE="$(cd "$(dirname "$0")" && pwd)"
# --check [outDir]: the fixed gate matrix (idle, keys sheet, live, golden live, ended, waiting, error; English and Hebrew; light and dark; and 900 px wide),
# then snapcheck.cjs reads every result and exits 1 on any clipping, wrapped pill, duplicate waiting row, extra primary button or stray Sample badge.
if [ "$1" = "--check" ]; then
  OUT="${2:-$(mktemp -d)}"; mkdir -p "$OUT"; GOLD="-:-:-:-:golden"
  WINGMAN_DASHBOARD_FAKE_KEYS=file WINGMAN_SNAP_DOCTOR=ready sh "$0" "$OUT" \
    idle-en-light:en:light:home:-:- idle-en-dark:en:dark:home:-:- idle-he-light:he:light:home:-:- idle-he-dark:he:dark:home:-:- \
    keys-en-light:en:light:home:-:keys keys-he-dark:he:dark:home:-:keys \
    live-en-dark:en:dark:home:live:- live-he-light:he:light:home:live:- live-en-light:en:light:home:live:- live-he-dark:he:dark:home:live:- \
    golden-en-dark:en:dark:home:live:-:-:-:golden golden-he-light:he:light:home:live:-:-:-:golden \
    ended-en-light:en:light:home:ended:- ended-he-dark:he:dark:home:ended:- waiting-en-light:en:light:home:waiting:- waiting-he-light:he:light:home:waiting:- \
    settings-en-light:en:light:settings:-:- settings-he-dark:he:dark:settings:-:- \
    edit-en-light:en:light:home:-:edit edit-he-dark:he:dark:home:-:edit \
    settings-keys-en-light:en:light:settings:-:tab-keys settings-engine-he-dark:he:dark:settings:-:tab-engine settings-privacy-en-dark:en:dark:settings:-:tab-privacy \
    settings-adv-en-light:en:light:settings:-:tab-advanced settings-adv-he-light:he:light:settings:-:tab-advanced \
    revstart-en-light:en:light:home:-:review revstart-he-dark:he:dark:home:-:review revstart-en-dark:en:dark:home:-:review revstart-he-light:he:light:home:-:review \
    revconf-en-light:en:light:home:-:review:-:-:conflict revconf-he-dark:he:dark:home:-:review:-:-:conflict \
    review-en-light:en:light:home:-:-:01SNAPGOLDENENB00000000000:details review-he-dark:he:dark:home:-:-:01SNAPGOLDENHEB00000000000:details \
    review-en-dark:en:dark:home:-:-:01SNAPGOLDENENB00000000000:details review-he-light:he:light:home:-:-:01SNAPGOLDENHEB00000000000:details \
    trust-en-light:en:light:home:-:-:01SNAPGOLDENENB00000000000:rate:saw trust-he-dark:he:dark:home:-:-:01SNAPGOLDENHEB00000000000:rate:saw \
    trust-en-dark:en:dark:home:-:-:01SNAPGOLDENENB00000000000:rate:saw trust-he-light:he:light:home:-:-:01SNAPGOLDENHEB00000000000:rate:saw \
    settings-privacy-en-light:en:light:settings:-:tab-privacy settings-privacy-he-dark:he:dark:settings:-:tab-privacy >/dev/null || exit 1
  WINGMAN_DASHBOARD_FAKE_KEYS=file WINGMAN_SNAP_DOCTOR=notready sh "$0" "$OUT" error-en-light:en:light:home:-:- error-he-dark:he:dark:home:-:- >/dev/null || exit 1
  # first run: no keys saved. Start is off with the reason and a Fix it button; the practice call sits next to it.
  WINGMAN_SNAP_NOCALLS=1 WINGMAN_DASHBOARD_FAKE_KEYS=missing WINGMAN_SNAP_DOCTOR=ready sh "$0" "$OUT" nokeys-en-light:en:light:home:-:- nokeys-he-dark:he:dark:home:-:- >/dev/null || exit 1
  WINGMAN_DASHBOARD_SIZE=900x900 WINGMAN_DASHBOARD_FAKE_KEYS=file WINGMAN_SNAP_DOCTOR=ready sh "$0" "$OUT" narrow-idle-en-light:en:light:home:-:- narrow-live-en-dark:en:dark:home:live:- narrow-live-he-light:he:light:home:live:- narrow-ended-en-dark:en:dark:home:ended:- >/dev/null || exit 1
  node "$HERE/snapcheck.cjs" "$OUT"; exit $?
fi
OUT="${1:-/tmp/wingman-dashboard-snaps}"; shift
mkdir -p "$OUT"
[ $# -eq 0 ] && set -- home-en-dark:en:dark:home:-:- home-en-light:en:light:home:-:- home-he-dark:he:dark:home:-:- home-he-light:he:light:home:-:- \
  edit-en-dark:en:dark:home:-:edit edit-en-light:en:light:home:-:edit edit-he-dark:he:dark:home:-:edit edit-he-light:he:light:home:-:edit \
  live-en-dark:en:dark:home:live:- live-he-dark:he:dark:home:live:- live-he-light:he:light:home:live:- settings-he-dark:he:dark:settings:-:-
for spec in "$@"; do
  IFS=: read -r name lang theme view fake focus open1 open2 knows <<EOF2
$spec
EOF2
  data="$(mktemp -d)"; node "$HERE/snapshot-fixtures.cjs" "$data" "$lang" >/dev/null || exit 1
  fakeEnv=""; [ "$fake" != "-" ] && fakeEnv="$fake"
  WINGMAN_DATA_DIR="$data" WINGMAN_USER_SETTINGS="$data/settings.yaml" WINGMAN_DASHBOARD_SNAPSHOT="$OUT/$name.png" WINGMAN_DASHBOARD_LANG="$lang" \
    WINGMAN_DASHBOARD_THEME="$theme" WINGMAN_DASHBOARD_VIEW="$view" WINGMAN_DASHBOARD_FAKE_CALL="$fakeEnv" WINGMAN_DASHBOARD_FAKE_DOCTOR="${WINGMAN_SNAP_DOCTOR:-ready}" WINGMAN_DASHBOARD_KNOWS="$([ -n "$knows" ] && [ "$knows" != "-" ] && [ "$knows" != saw ] && echo "$knows")" WINGMAN_DASHBOARD_OPEN="$([ -n "$open1" ] && [ "$open1" != "-" ] && echo "$open1:$open2$([ "$knows" = saw ] && echo ":saw")")" \
    WINGMAN_DASHBOARD_FOCUS="$([ "$focus" != "-" ] && echo "$focus")" WINGMAN_DASHBOARD_EVAL="${WINGMAN_SNAP_EVAL:-$HERE/clipcheck.js}" WINGMAN_DASHBOARD_SIZE="${WINGMAN_DASHBOARD_SIZE:-1100x900}" \
    "$HERE/../node_modules/.bin/electron" "$HERE/../tray/main.cjs" >/dev/null 2>&1
  rm -rf "$data"; echo "$OUT/$name.png"
done
