#!/bin/sh
# Retakes every picture in docs/ux from the current build. Hidden windows only (no focus, no call, no network, invented data).
#   sh dashboard/docshots.sh [outDir]      default outDir: ../docs/ux (relative to app/). Run from anywhere; needs node_modules (electron).
# The Home pictures use the fake call and the "docs" fixtures (dashboard/snapshot-fixtures.cjs, dashboard/livefixture.cjs); the answer window pictures
# use overlay/fixtures-v2.cjs. The social preview line is the first bold line of README.md.
HERE="$(cd "$(dirname "$0")" && pwd)"; APP="$HERE/.."; ROOT="$APP/.."
OUT="${1:-$ROOT/docs/ux}"; TMP="$(mktemp -d)"; ELECTRON="$APP/node_modules/.bin/electron"
mkdir -p "$OUT"
# one window snapshot: shot <ENV=value ...> -- <spec>. The variables apply to this snapshot only.
shot() {
  vars=""; while [ "$1" != "--" ]; do vars="$vars $1"; shift; done; shift
  # shellcheck disable=SC2086
  env WINGMAN_SNAP_DOCTOR=ready $vars sh "$HERE/snapshot.sh" "$TMP" "$@" >/dev/null || { echo "snapshot failed: $*" >&2; exit 1; }
}

# Answer window (overlay): English pictures, content-sized windows, then the Hebrew one
WINGMAN_OVERLAY_LANG=en sh "$APP/overlay/snapshot.sh" "$TMP/ow" v2-live:fit v2-fit-answer v2-more:fit >/dev/null
WINGMAN_OVERLAY_LANG=he sh "$APP/overlay/snapshot.sh" "$TMP/ow-he" v2-live:fit >/dev/null
WINGMAN_OVERLAY_LANG=he sh "$APP/overlay/snapshot.sh" "$TMP/fy" foryou >/dev/null
cp "$TMP/ow/v2-live-fit.png" "$OUT/answer-window-live.png"
cp "$TMP/ow/v2-fit-answer.png" "$OUT/answer-window-hero.png"
cp "$TMP/ow/v2-more-fit.png" "$OUT/answer-window-more.png"
cp "$TMP/ow-he/v2-live-fit.png" "$OUT/answer-window-he.png"
"$ELECTRON" "$HERE/docshots.cjs" crop "$TMP/fy/foryou.png" "$OUT/for-you-card.png" 0 0 760 464 >/dev/null 2>&1 || exit 1

# Home during a live call (light), no Sample badge, English tip
shot WINGMAN_DASHBOARD_FAKE_KEYS=file WINGMAN_DASHBOARD_SIZE=1100x900 -- home-window:en:light:home:live:-:-:-:docs
cp "$TMP/home-window.png" "$OUT/home-window.png"
# the same call with "What Wingman knows" open (Show pressed), as its own picture
cat > "$TMP/open-knows.js" <<'JS'
(async () => {
  const b = document.getElementById("knows-live-show");
  if (b) b.click();
  await new Promise((r) => setTimeout(r, 600));
  return { ok: !!b };
})()
JS
shot WINGMAN_DASHBOARD_FAKE_KEYS=file WINGMAN_DASHBOARD_SIZE=1100x1180 WINGMAN_SNAP_EVAL="$TMP/open-knows.js" -- home-live:en:light:home:live:-:-:-:docs
cp "$TMP/home-live.png" "$OUT/home-live.png"

# Calls page and a finished call (practice call: it carries the Practice badge, never "Real call")
shot WINGMAN_DASHBOARD_FAKE_KEYS=file WINGMAN_DASHBOARD_SIZE=1400x700 WINGMAN_SNAP_DOCS=1 -- calls-page:en:dark:inbox:-:-
cp "$TMP/calls-page.png" "$OUT/calls-page.png"
shot WINGMAN_DASHBOARD_FAKE_KEYS=file WINGMAN_DASHBOARD_SIZE=1400x920 WINGMAN_SNAP_DOCS=practice -- call-detail-followup:en:dark:home:-:-:01SNAPDOCSP000000000000000:followup
cp "$TMP/call-detail-followup.png" "$OUT/call-detail-followup.png"

# First run: setup guide with the practice step open, then the starter answers open. The page script opens the step and reports the card's box.
for step in try pack; do
  cat > "$TMP/open-$step.js" <<JS
(async () => {
  const b = document.getElementById("su-toggle-$step");
  if (b && b.getAttribute("aria-expanded") !== "true") b.click();
  await new Promise((r) => setTimeout(r, 700));
  const c = document.querySelector("section.card-big.setup");
  // show the card alone, at the top: the cards above it (Start, meetings) are hidden for this picture
  for (let e = c.previousElementSibling; e; e = e.previousElementSibling) e.style.display = "none";
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 300));
  const r = c.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.min(Math.round(r.height), innerHeight - Math.round(r.top)) };
})()
JS
done
shot WINGMAN_SNAP_NOCALLS=1 WINGMAN_DASHBOARD_FAKE_KEYS=file WINGMAN_DASHBOARD_SIZE=1100x2400 WINGMAN_SNAP_EVAL="$TMP/open-try.js" -- setup-step:en:dark:home:-:-
shot WINGMAN_SNAP_NOCALLS=1 WINGMAN_DASHBOARD_FAKE_KEYS=file WINGMAN_DASHBOARD_SIZE=1100x2400 WINGMAN_SNAP_EVAL="$TMP/open-pack.js" -- setup-starter-packs:en:dark:home:-:-
for n in setup-step setup-starter-packs; do
  box="$(node -e 'const r=require(process.argv[1]);console.log([r.x,r.y,r.w,r.h].join(" "))' "$TMP/$n.png.json")"
  # shellcheck disable=SC2086
  "$ELECTRON" "$HERE/docshots.cjs" crop "$TMP/$n.png" "$OUT/$n.png" $box >/dev/null 2>&1 || exit 1
done

# First-run window (two keys, sound permissions, ready): the window alone, English, light
for n in keys allow-mac allow-win ready; do
  shot WINGMAN_SNAP_NOCALLS=1 WINGMAN_DASHBOARD_FAKE_KEYS=missing WINGMAN_DASHBOARD_SIZE=1100x1000 -- "first-run-$n:en:light:home:-:setup-$n"
  cp "$TMP/first-run-$n.png" "$OUT/first-run-$n.png"
done

# Social preview: the live window beside the logo and the first line of the README
TAG="$(sed -n 's/^<p align="center"><b>\(.*\)<\/b>\(<br>.*\)\{0,1\}<\/p>$/\1/p;s/^<p align="center"><b>\(.*\)<\/b><br>.*/\1/p' "$ROOT/README.md" | head -1)"
[ -n "$TAG" ] || { echo "README tagline not found" >&2; exit 1; }
"$ELECTRON" "$HERE/docshots.cjs" social "$OUT/social-preview.png" "$TMP/ow/v2-live-fit.png" "$ROOT/brand/png/lockup-dark.png" "$TAG" >/dev/null 2>&1 || exit 1
rm -rf "$TMP"; echo "pictures written to $OUT"
