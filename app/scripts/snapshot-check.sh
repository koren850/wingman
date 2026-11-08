#!/bin/sh
# One command for the UI snapshot checks: the answer window (overlay) and the main window (dashboard), in English and Hebrew.
#   scripts/snapshot-check.sh [outDir]        (outDir default: a new temporary folder; the PNG files and one JSON line per spec stay there)
# Hidden and quiet: every window is created with show:false (the overlay also with focusable:false), nothing is put in the Dock, no call is started, no
# network, no key. The script fails when a window reports focus. It fails (exit 1) on any clipping, contrast, minimum font size or text direction problem
# that overlay/snapshot.sh --check and dashboard/snapshot.sh --check find, and on a missing result file.
# Overlay: every v2 spec ("v2all" in overlay/fixtures-v2.cjs) once per language. Dashboard: its fixed gate matrix (both languages, light and dark, narrow).
# About 2 to 3 minutes. The package.json entry is "snapshots": "sh scripts/snapshot-check.sh" (pnpm snapshots).
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
OUT="${1:-$(mktemp -d "${TMPDIR:-/tmp}/wingman-snapshots.XXXXXX")}"
mkdir -p "$OUT" || exit 2
RC=0
specs=0
for lang in en he; do
  dir="$OUT/overlay-$lang"
  log="$OUT/overlay-$lang.jsonl"
  # shellcheck disable=SC2086
  WINGMAN_OVERLAY_LANG="$lang" sh "$APP/overlay/snapshot.sh" "$dir" --check v2all >"$log" 2>"$OUT/overlay-$lang.err" || {
    echo "snapshot-check: overlay $lang: the checks found problems (see $log)"
    grep -v '"issues":\[\]' "$log" | cut -c1-300 | head -10
    RC=1
  }
  n=$(grep -c '"spec"' "$log" 2>/dev/null || echo 0)
  if [ "$n" -lt 10 ]; then
    echo "snapshot-check: overlay $lang: only $n result lines (expected about 44); see $OUT/overlay-$lang.err"
    RC=1
  fi
  if grep -q '"focused":true' "$log"; then
    echo "snapshot-check: overlay $lang: a window had focus"
    RC=1
  fi
  specs=$((specs + n))
  echo "snapshot-check: overlay $lang: $n specs checked"
done
if sh "$APP/dashboard/snapshot.sh" --check "$OUT/dashboard" >"$OUT/dashboard.txt" 2>&1; then
  echo "snapshot-check: dashboard: $(tail -1 "$OUT/dashboard.txt")"
else
  echo "snapshot-check: dashboard: the checks found problems"
  tail -15 "$OUT/dashboard.txt"
  RC=1
fi
if [ "$RC" -eq 0 ]; then echo "snapshot-check: ok ($specs overlay specs, dashboard matrix), files in $OUT"; else echo "snapshot-check: FAILED, files in $OUT"; fi
exit "$RC"
