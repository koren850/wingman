#!/bin/bash
# Starts the Wingman app from the renamed runtime (.app built by make-app.sh), so macOS shows "Wingman", not "Electron".
# Menu bar only by default (`pnpm tray`); `pnpm dashboard` passes --open-window to open the main window too.
# It runs tray/main.cjs directly, so the launcher inside the .app (which adds --open-window itself) is not used here.
cd "$(dirname "$0")/.." || exit 1
BIN=.app/Wingman.app/Contents/MacOS/Wingman
if [ ! -x "$BIN" ]; then
  echo "Wingman: the app is not built yet, building it now..." >&2
  ./scripts/make-app.sh >&2 || { echo "Wingman: could not build the app (see above). Fix: run ./install.sh in the repo root, or: pnpm install" >&2; exit 1; }
fi
[ -x "$BIN" ] || { echo "Wingman: $BIN is still missing after the build. Fix: run ./install.sh in the repo root." >&2; exit 1; }
exec "$BIN" tray/main.cjs "$@"
